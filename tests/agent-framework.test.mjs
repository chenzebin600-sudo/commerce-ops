import assert from "node:assert/strict";
import test from "node:test";
import { AgentFramework } from "../lib/ai/agent/agent-framework.mjs";
import { defineAgent } from "../lib/ai/agent/agent-contracts.mjs";
import { AgentRegistry } from "../lib/ai/agent/agent-registry.mjs";
import { FoundationTaskService } from "../lib/foundation/foundation-task-service.mjs";

function testDefinition(overrides = {}) {
  return {
    name: "test.store-review",
    version: "1.0.0",
    description: "Test-only definition for the shared Agent contract.",
    input_context: [
      { type: "shop", required: true, multiple: false },
      { type: "sku", required: false, multiple: true },
    ],
    tools: [{
      name: "ai-context.read",
      access: "read",
      permission: "growth.read",
    }],
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
      scopes: ["growth.read"],
      requires_human_approval: true,
    },
    ...overrides,
  };
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
      tools: [{ name: "listing.update", access: "write", permission: "listing.write" }],
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
  const framework = new AgentFramework({ taskService });
  framework.register(testDefinition());

  const request = {
    agent_name: "test.store-review",
    agent_version: "1.0.0",
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
  const task = await framework.createTask(request);
  const duplicate = await framework.createTask(request);

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
  assert.deepEqual(task.input.context_refs, request.context_refs);
  assert.equal(JSON.stringify(task).includes("raw_context"), false);
  assert.equal(JSON.stringify(task).includes("prompt"), false);
});

test("Agent task requests enforce declared context cardinality", async () => {
  const framework = new AgentFramework({
    taskService: { async create(input) { return input; } },
  });
  framework.register(testDefinition());
  await assert.rejects(
    () => framework.createTask({
      agent_name: "test.store-review",
      request_id: "missing-context",
      idempotency_key: "missing-context",
      context_refs: [],
    }),
    { code: "AGENT_CONTEXT_REFERENCE_MISSING" },
  );
});
