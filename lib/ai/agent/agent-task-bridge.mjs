import { createHash } from "node:crypto";
import {
  AGENT_CONTRACT_VERSION,
  assertAgentContextReferences,
} from "./agent-contracts.mjs";

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

function boundedIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    throw Object.assign(new TypeError(`${label} is invalid`), {
      code: "AGENT_TASK_REQUEST_INVALID",
    });
  }
  return normalized;
}

function optionalIdentifier(value, label) {
  return value === null || value === undefined || value === ""
    ? null
    : boundedIdentifier(value, label);
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export class AgentTaskBridge {
  constructor({ registry, taskService }) {
    if (!registry || typeof registry.require !== "function") {
      throw new TypeError("Agent registry is required");
    }
    if (!taskService || typeof taskService.create !== "function") {
      throw new TypeError("Foundation task service is required");
    }
    this.registry = registry;
    this.taskService = taskService;
  }

  async create(input = {}) {
    const definition = this.registry.require(input.agent_name, input.agent_version || "1.0.0");
    const requestId = boundedIdentifier(input.request_id, "Agent request id");
    const idempotencyKey = boundedIdentifier(input.idempotency_key, "Agent idempotency key");
    const requestedBy = boundedIdentifier(input.requested_by || "agent-framework", "Agent requester");
    const contextRefs = assertAgentContextReferences(definition, input.context_refs);
    const contextDigest = fingerprint(JSON.stringify(contextRefs));

    return this.taskService.create({
      domain: definition.permission.task_domain,
      taskKind: "agent_run",
      executionMode: definition.permission.requires_human_approval ? "human" : "system",
      domainRefType: "agent_request",
      domainRefId: `${definition.name}:${definition.version}:${requestId}`,
      idempotencyKey: `agent:${definition.name}:${definition.version}:${idempotencyKey}`,
      state: "PENDING",
      priority: input.priority || "P2",
      ownerId: optionalIdentifier(input.owner_id, "Agent owner id"),
      storeId: optionalIdentifier(input.store_id, "Agent store id"),
      warehouseId: optionalIdentifier(input.warehouse_id, "Agent warehouse id"),
      skuId: optionalIdentifier(input.sku_id, "Agent SKU id"),
      maxAttempts: input.max_attempts || 3,
      createdBy: requestedBy,
      input: {
        contract_version: AGENT_CONTRACT_VERSION,
        agent: {
          name: definition.name,
          version: definition.version,
        },
        context_refs: contextRefs,
      },
      evidence: {
        correlation_id: optionalIdentifier(input.correlation_id, "Agent correlation id"),
        context_digest: contextDigest,
        tool_names: definition.tools.map((tool) => tool.name),
        output_schema: {
          id: definition.output_schema.id,
          version: definition.output_schema.version,
        },
        permission: {
          mode: definition.permission.mode,
          requires_human_approval: definition.permission.requires_human_approval,
        },
        execution_runtime: "not_implemented",
      },
    });
  }
}
