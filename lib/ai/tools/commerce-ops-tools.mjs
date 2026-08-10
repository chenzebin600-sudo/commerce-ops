import { assertAiContextSubjectId } from "../context/ai-context-contracts.mjs";
import { AgentToolRegistry } from "./agent-tool-registry.mjs";

const ENTITY_TYPES = Object.freeze(["shop", "product", "sku"]);

const CONTEXT_QUERY_SCHEMA = Object.freeze({
  type: "object",
  required: ["subject_type", "subject_id"],
  additionalProperties: false,
  properties: {
    subject_type: { enum: ENTITY_TYPES },
    subject_id: { type: "string", minLength: 1, maxLength: 200 },
  },
});

const CONTEXT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["contextVersion", "contextType", "subject", "data"],
});

const PRODUCT_QUERY_SCHEMA = Object.freeze({
  type: "object",
  required: ["product_id"],
  additionalProperties: false,
  properties: { product_id: { type: "string", minLength: 1, maxLength: 200 } },
});

const CREATE_TASK_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "idempotency_key",
    "business_object",
    "reason",
    "evidence",
    "suggested_action",
  ],
  additionalProperties: true,
});

function toolInputError(message) {
  return Object.assign(new TypeError(message), { code: "AGENT_TOOL_INPUT_INVALID" });
}

function contextQuery(input) {
  const subjectType = String(input.subject_type || "").trim().toLowerCase();
  if (!ENTITY_TYPES.includes(subjectType)) throw toolInputError("Tool subject_type is invalid");
  return {
    subjectType,
    subjectId: assertAiContextSubjectId(input.subject_id),
  };
}

export function createCommerceOpsToolRegistry({
  contextRegistry,
  createOperationTask,
  registry = new AgentToolRegistry(),
} = {}) {
  if (!contextRegistry || typeof contextRegistry.resolve !== "function") {
    throw new TypeError("AI Context Registry is required");
  }
  if (typeof createOperationTask !== "function") {
    throw new TypeError("Agent operation task service is required");
  }

  registry.register({
    name: "query_sales",
    version: "1.0.0",
    description: "Read bounded sales facts for a registered Shop, Product, or SKU context.",
    access: "read",
    permission: "sales-assortment.read",
    input_schema: CONTEXT_QUERY_SCHEMA,
    output_schema: CONTEXT_OUTPUT_SCHEMA,
    execute: async ({ input }) => {
      const query = contextQuery(input);
      return contextRegistry.resolve("sales", query);
    },
  });
  registry.register({
    name: "query_inventory",
    version: "1.0.0",
    description: "Read bounded inventory facts for a registered Shop, Product, or SKU context.",
    access: "read",
    permission: "inventory.read",
    input_schema: CONTEXT_QUERY_SCHEMA,
    output_schema: CONTEXT_OUTPUT_SCHEMA,
    execute: async ({ input }) => {
      const query = contextQuery(input);
      return contextRegistry.resolve("inventory", query);
    },
  });
  registry.register({
    name: "query_product",
    version: "1.0.0",
    description: "Read the registered Product Context without direct database access.",
    access: "read",
    permission: "product.read",
    input_schema: PRODUCT_QUERY_SCHEMA,
    output_schema: CONTEXT_OUTPUT_SCHEMA,
    execute: async ({ input }) => contextRegistry.resolve("product", {
      subjectId: assertAiContextSubjectId(input.product_id),
    }),
  });
  registry.register({
    name: "create_task",
    version: "1.0.0",
    description: "Create an evidence-backed Foundation operation task without executing it.",
    access: "write",
    permission: "agent.task.create",
    input_schema: CREATE_TASK_SCHEMA,
    output_schema: { type: "object", required: ["id", "state", "taskKind"] },
    execute: async ({ input, agent, requestId, requestedBy }) => createOperationTask({
      ...input,
      agent_name: agent.name,
      agent_version: agent.version,
      request_id: requestId,
      requested_by: requestedBy,
      correlation_id: input.correlation_id || requestId,
    }),
  });
  return registry;
}
