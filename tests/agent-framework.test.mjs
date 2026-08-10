import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime, assertAgentRuntimeScope } from "../lib/ai/agent/agent-runtime.mjs";
import { defineAgent } from "../lib/ai/agent/agent-contracts.mjs";
import { AgentRegistry } from "../lib/ai/agent/agent-registry.mjs";
import { AiContextRegistry } from "../lib/ai/context/ai-context-registry.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";
import { FoundationTaskService } from "../lib/foundation/foundation-task-service.mjs";

function testDefinition(overrides = {}) {
  return {
    name: "test.store-review",
    version: "1.0.0",
    description: "Test-only definition for the shared Agent contract.",
    input_context: [
      { type: "shop", version: "1.0.0", required: true, multiple: false },
      { type: "sku", version: "1.0.0", required: false, multiple: true },
    ],
    tools: [
      {
        name: "ai-context.read",
        version: "1.0.0",
        access: "read",
        permission: "growth.read",
      },
      {
        name: "agent.task.create",
        version: "1.0.0",
        access: "lifecycle",
        permission: "agent.task.lifecycle",
      },
    ],
    output_schema: {
      id: "test.store-review-output",
      version: "1.0.0",
      schema: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
    },
    permission: {
      mode: "recommend",
      task_domain: "growth",
      scopes: ["agent.task.lifecycle", "growth.read"],
      requires_human_approval: true,
    },
    ...overrides,
  };
}

function operationDefinition(overrides = {}) {
  return testDefinition({
    tools: [{ name: "create_task", version: "1.0.0", access: "write", permission: "agent.task.create" }],
    permission: {
      mode: "execute",
      task_domain: "growth",
      scopes: ["agent.task.create"],
      requires_human_approval: true,
    },
    ...overrides,
  });
}

function createRuntime(taskService, traces = []) {
  const contextRegistry = new AiContextRegistry();
  for (const type of ["shop", "sku", "sales", "inventory", "product"]) {
    contextRegistry.register({
      type,
      version: "1.0.0",
      description: `Test ${type} Context.`,
      inputSchema: { type: "object" },
      async resolve(input) {
        return {
          contextVersion: "AI-CONTEXT-1.0.0",
          contextType: type,
          subject: { type, id: input.subjectId || `${type}-1` },
          data: {},
        };
      },
    });
  }
  const toolRegistry = new AgentToolRegistry();
  toolRegistry.register({
    name: "ai-context.read",
    version: "1.0.0",
    description: "Test-only Context reader.",
    access: "read",
    permission: "growth.read",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    execute: async () => ({ status: "ok" }),
  });
  return new AgentRuntime({
    taskService,
    contextRegistry,
    toolRegistry,
    gateway: { async complete() { throw new Error("not used"); } },
    auditService: { async recordSafely(entry) { traces.push(entry); } },
  });
}

function createTestAgent(runtime, definition = testDefinition()) {
  class TestAgent {
    constructor({ runtime: scope }) {
      this.scope = assertAgentRuntimeScope(scope);
    }

    async run() {}
  }
  return runtime.createAgent({
    definition,
    Agent: TestAgent,
  }).scope;
}

class MemoryTaskRepository {
  constructor() {
    this.tasks = new Map();
    this.domainRefs = new Map();
    this.events = [];
  }

  async findTaskByDomainRef(domain, type, id) {
    return this.domainRefs.get(`${domain}:${type}:${id}`) || null;
  }

  async insertTask(input, now) {
    const task = {
      id: `task-${this.tasks.size + 1}`,
      ...input,
      authorityMode: input.authorityMode || "foundation",
      attemptCount: input.attemptCount || 0,
      maxAttempts: input.maxAttempts || 3,
      stateVersion: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.tasks.set(task.id, task);
    this.domainRefs.set(`${task.domain}:${task.domainRefType}:${task.domainRefId}`, task);
    return task;
  }

  async addTaskEvent(input) {
    this.events.push(input);
  }
}

test("Agent definitions expose the required immutable contract", () => {
  const definition = defineAgent(testDefinition());
  assert.deepEqual(
    ["name", "description", "input_context", "tools", "output_schema", "permission"]
      .filter((key) => !Object.hasOwn(definition, key)),
    [],
  );
  assert.equal(definition.contract_version, "COMMERCE-OPS-AGENT-1.0.0");
  assert.equal(definition.permission.task_domain, "growth");
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.output_schema.schema), true);
});

test("Agent definitions enforce tool scopes and approval for write access", () => {
  assert.throws(
    () => defineAgent(testDefinition({
      permission: {
        mode: "recommend",
        task_domain: "growth",
        scopes: [],
        requires_human_approval: true,
      },
    })),
    { code: "AGENT_PERMISSION_SCOPE_MISSING" },
  );
  assert.throws(
    () => defineAgent(testDefinition({
      tools: [{ name: "listing.update", version: "1.0.0", access: "write", permission: "listing.write" }],
      permission: {
        mode: "execute",
        task_domain: "listing",
        scopes: ["listing.write"],
        requires_human_approval: false,
      },
    })),
    { code: "AGENT_WRITE_PERMISSION_INVALID" },
  );
});

test("Agent registry is idempotent and rejects conflicting definitions", () => {
  const registry = new AgentRegistry();
  const first = registry.register(testDefinition());
  assert.equal(registry.register(testDefinition()), first);
  assert.equal(registry.get(first.name, first.version), first);
  assert.equal(registry.list().length, 1);
  assert.throws(
    () => registry.register(testDefinition({ description: "A conflicting definition." })),
    { code: "AGENT_DEFINITION_CONFLICT" },
  );
});

test("Agent task requests reuse the Foundation envelope without storing raw context", async () => {
  const repository = new MemoryTaskRepository();
  const taskService = new FoundationTaskService({
    repository,
    now: () => new Date("2026-08-05T08:00:00.000Z"),
  });
  const agent = createTestAgent(createRuntime(taskService));

  const request = {
    request_id: "request-20260805-1",
    idempotency_key: "daily-store-review-20260805",
    requested_by: "test-suite",
    correlation_id: "correlation-1",
    priority: "P1",
    store_id: "store-1",
    context_refs: [
      { type: "shop", id: "store-1" },
      { type: "sku", id: "sku-1" },
      { type: "sku", id: "sku-2" },
    ],
  };
  const createTask = () => agent.executeTool({
    request_id: request.request_id,
    requested_by: request.requested_by,
    tool_name: "agent.task.create",
    input: request,
  });
  const task = (await createTask()).result;
  const duplicate = (await createTask()).result;

  assert.equal(duplicate.id, task.id);
  assert.equal(repository.tasks.size, 1);
  assert.equal(repository.events.length, 1);
  assert.equal(task.domain, "growth");
  assert.equal(task.taskKind, "agent_run");
  assert.equal(task.executionMode, "human");
  assert.equal(task.domainRefType, "agent_request");
  assert.equal(task.domainRefId, "test.store-review:1.0.0:request-20260805-1");
  assert.equal(task.authorityMode, "foundation");
  assert.equal(task.state, "PENDING");
  assert.equal(task.evidence.execution_runtime, "not_implemented");
  assert.match(task.evidence.context_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(task.input.context_refs, request.context_refs.map((entry) => ({
    ...entry,
    version: "1.0.0",
  })));
  assert.equal(JSON.stringify(task).includes("raw_context"), false);
  assert.equal(JSON.stringify(task).includes("prompt"), false);
});

test("Agent task requests enforce declared context cardinality", async () => {
  const repository = new MemoryTaskRepository();
  const taskService = new FoundationTaskService({
    repository,
    now: () => new Date("2026-08-05T08:30:00.000Z"),
  });
  const agent = createTestAgent(createRuntime(taskService));
  await assert.rejects(
    () => agent.executeTool({
      request_id: "missing-context",
      requested_by: "test-suite",
      tool_name: "agent.task.create",
      input: {
        request_id: "missing-context",
        idempotency_key: "missing-context",
        context_refs: [],
      },
    }),
    { code: "AGENT_CONTEXT_REFERENCE_MISSING" },
  );
});

test("Agent-produced operation tasks reuse Foundation without automatic execution", async () => {
  const repository = new MemoryTaskRepository();
  const taskService = new FoundationTaskService({
    repository,
    now: () => new Date("2026-08-05T09:00:00.000Z"),
  });
  const traces = [];
  const agent = createTestAgent(createRuntime(taskService, traces), operationDefinition());

  const request = {
    idempotency_key: "store-1-decline-20260805",
    correlation_id: "daily-report-20260805",
    business_object: {
      type: "store",
      id: "store-1",
      name: "TH Store",
    },
    reason: {
      code: "sales_decline",
      summary: "Seven-day GMV declined by 16 percent.",
    },
    evidence: [{
      type: "metric",
      label: "GMV impact",
      value: { current: 42000, previous: 50000, change: -8000 },
      source: "daily_report_context",
    }],
    suggested_action: {
      code: "review_store",
      summary: "Review traffic and assortment coverage before changing operations.",
      parameters: { review_window_days: 7 },
    },
    priority: "P1",
    requires_approval: false,
  };

  const invoke = () => agent.executeTool({
    request_id: "recommendation-20260805-1",
    requested_by: "test-suite",
    tool_name: "create_task",
    input: request,
  });
  const task = (await invoke()).result;
  const duplicate = (await invoke()).result;

  assert.equal(duplicate.id, task.id);
  assert.equal(repository.tasks.size, 1);
  assert.equal(task.taskKind, "agent_recommendation");
  assert.equal(task.domainRefType, "agent_recommendation");
  assert.equal(
    task.domainRefId,
    "test.store-review:1.0.0:recommendation-20260805-1:store:store-1",
  );
  assert.equal(task.state, "PENDING");
  assert.equal(task.executionMode, "human");
  assert.equal(task.maxAttempts, 1);
  assert.equal(task.input.contract_version, "COMMERCE-OPS-AGENT-OPERATION-TASK-1.0.0");
  assert.deepEqual(task.input.source_agent, {
    name: "test.store-review",
    version: "1.0.0",
  });
  assert.equal(task.input.business_object.name, "TH Store");
  assert.equal(task.input.reason.code, "sales_decline");
  assert.equal(task.input.suggested_action.code, "review_store");
  assert.equal(task.input.requires_approval, true);
  assert.equal(task.evidence.automatic_execution, false);
  assert.equal(task.evidence.items[0].value.change, -8000);
  assert.equal(traces.length, 2);
  assert.equal(traces[0].metadata.toolName, "create_task");
  assert.equal(traces[0].status, "success");
});

test("Agent-produced task approval cannot weaken the registered permission", async () => {
  const repository = new MemoryTaskRepository();
  const taskService = new FoundationTaskService({
    repository,
    now: () => new Date("2026-08-05T09:15:00.000Z"),
  });
  const agent = createTestAgent(createRuntime(taskService), operationDefinition());

  const task = (await agent.executeTool({
    request_id: "approval-check",
    requested_by: "test-suite",
    tool_name: "create_task",
    input: {
      idempotency_key: "approval-check",
      business_object: { type: "sku", id: "SKU-1" },
      reason: { code: "low_stock", summary: "Stock cover is below the configured threshold." },
      evidence: [{ type: "metric", label: "Days of supply", value: 4 }],
      suggested_action: { code: "review_stock", summary: "Confirm stock before taking action." },
      requires_approval: false,
    },
  })).result;

  assert.equal(task.executionMode, "human");
  assert.equal(task.input.requires_approval, true);
  assert.equal(task.evidence.automatic_execution, false);
});

test("Agent-produced tasks reject missing evidence and forged Runtime scopes", async () => {
  const repository = new MemoryTaskRepository();
  const taskService = new FoundationTaskService({
    repository,
    now: () => new Date("2026-08-05T09:30:00.000Z"),
  });
  const agent = createTestAgent(createRuntime(taskService), operationDefinition());
  const valid = {
    idempotency_key: "invalid-evidence",
    business_object: { type: "store", id: "store-1" },
    reason: { code: "sales_decline", summary: "Sales declined." },
    suggested_action: { code: "review_store", summary: "Review the store." },
  };

  await assert.rejects(
    () => agent.executeTool({
      request_id: "invalid-evidence",
      requested_by: "test-suite",
      tool_name: "create_task",
      input: { ...valid, evidence: [] },
    }),
    { code: "AGENT_OPERATION_TASK_INVALID" },
  );
  assert.throws(
    () => assertAgentRuntimeScope({}),
    { code: "AGENT_RUNTIME_SCOPE_REQUIRED" },
  );
});
