import { normalizeAgentOperationTask } from "./agent-operation-task-contracts.mjs";

export class AgentOperationTaskService {
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
    const task = normalizeAgentOperationTask(input);
    const definition = this.registry.require(
      task.source_agent.name,
      task.source_agent.version,
    );
    const requiresApproval = task.requires_approval
      || definition.permission.requires_human_approval
      || definition.permission.mode === "execute";

    return this.taskService.create({
      domain: definition.permission.task_domain,
      taskKind: "agent_recommendation",
      executionMode: requiresApproval ? "human" : "system",
      domainRefType: "agent_recommendation",
      domainRefId: [
        task.source_agent.name,
        task.source_agent.version,
        task.request_id,
        task.business_object.type,
        task.business_object.id,
      ].join(":"),
      idempotencyKey: [
        "agent-recommendation",
        task.source_agent.name,
        task.source_agent.version,
        task.idempotency_key,
      ].join(":"),
      state: "PENDING",
      priority: task.priority,
      ownerId: task.references.owner_id,
      storeId: task.references.store_id,
      warehouseId: task.references.warehouse_id,
      skuId: task.references.sku_id,
      maxAttempts: 1,
      createdBy: task.requested_by,
      input: {
        contract_version: task.contract_version,
        source_agent: task.source_agent,
        business_object: task.business_object,
        reason: task.reason,
        suggested_action: task.suggested_action,
        priority: task.priority,
        requires_approval: requiresApproval,
      },
      evidence: {
        correlation_id: task.correlation_id,
        items: task.evidence,
        source_agent_permission: {
          mode: definition.permission.mode,
          scopes: definition.permission.scopes,
          requires_human_approval: definition.permission.requires_human_approval,
        },
        automatic_execution: false,
      },
    });
  }
}
