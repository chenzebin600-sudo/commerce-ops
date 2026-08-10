import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../lib/ai/agent/agent-runtime.mjs";
import { AiContextRegistry } from "../lib/ai/context/ai-context-registry.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";

function definition({
  name = "test.foundation-reader",
  tools = [
    { name: "query_sales", version: "1.0.0", access: "read", permission: "sales-assortment.read" },
    { name: "query_inventory", version: "1.0.0", access: "read", permission: "inventory.read" },
    { name: "query_product", version: "1.0.0", access: "read", permission: "product.read" },
  ],
  mode = "read_only",
  scopes = tools.map((tool) => tool.permission),
  approval = false,
} = {}) {
  return {
    name,
    version: "1.0.0",
    description: "Test Agent for the shared Tool Registry.",
    input_context: [{ type: "shop", version: "1.0.0", required: false, multiple: false }],
    tools,
    output_schema: {
      id: `${name}.output`,
      version: "1.0.0",
      schema: { type: "object", properties: {} },
    },
    permission: {
      mode,
      task_domain: "growth",
      scopes,
      requires_human_approval: approval,
    },
  };
}

function runtime() {
  const created = [];
  const contextCalls = [];
  const traces = [];
  const taskService = {
    async create(input) {
      const task = { id: `task-${created.length + 1}`, ...input };
      created.push(task);
      return task;
    },
    async transition() { throw new Error("not used"); },
    async acquireLease() { throw new Error("not used"); },
    async releaseLease() { return true; },
  };
  const contextRegistry = new AiContextRegistry();
  for (const type of ["shop", "product", "sku", "sales", "inventory"]) {
    contextRegistry.register({
      type,
      version: "1.0.0",
      description: `Test ${type} Context.`,
      inputSchema: { type: "object" },
      async resolve(input) {
      contextCalls.push({ type, input });
      return {
        contextVersion: "AI-CONTEXT-1.0.0",
        contextType: type,
        subject: { type, id: input.subjectId },
        data: { scope: input },
      };
      },
    });
  }
  const toolRegistry = new AgentToolRegistry();
  const agentRuntime = new AgentRuntime({
    taskService,
    contextRegistry,
    toolRegistry,
    gateway: { async complete() { throw new Error("not used"); } },
    auditService: { async recordSafely(entry) { traces.push(entry); } },
  });
  class TestAgent {
    constructor({ runtime: scope }) {
      this.scope = scope;
    }

    async run() {}
  }
  const createAgent = (agentDefinition) => agentRuntime.createAgent({
    definition: agentDefinition,
    Agent: TestAgent,
  }).scope;
  return { agentRuntime, createAgent, toolRegistry, contextCalls, created, traces };
}

test("Tool Registry exposes four bounded service tools", () => {
  const { toolRegistry } = runtime();
  const serviceTools = toolRegistry.list().filter((tool) => [
    "create_task",
    "query_inventory",
    "query_product",
    "query_sales",
  ].includes(tool.name));
  assert.deepEqual(serviceTools.map((tool) => tool.name), [
    "create_task",
    "query_inventory",
    "query_product",
    "query_sales",
  ]);
  assert.equal(serviceTools.every((tool) => (
    tool.boundary.database_access === "service_only"
      && tool.boundary.external_access === "forbidden"
  )), true);
  assert.equal(Object.isFrozen(toolRegistry.get("query_sales")), true);
});

test("Agent Tool Runtime queries Context Registry without database handles", async () => {
  const { createAgent, contextCalls } = runtime();
  const scope = createAgent(definition());

  const sales = await scope.executeTool({
    request_id: "tool-run-1",
    requested_by: "test-suite",
    tool_name: "query_sales",
    input: { subject_type: "shop", subject_id: "shop-1" },
  });
  const inventory = await scope.executeTool({
    request_id: "tool-run-2",
    requested_by: "test-suite",
    tool_name: "query_inventory",
    input: { subject_type: "sku", subject_id: "sku-1" },
  });
  const product = await scope.executeTool({
    request_id: "tool-run-3",
    requested_by: "test-suite",
    tool_name: "query_product",
    input: { product_id: "product-1" },
  });

  assert.equal(sales.result.contextType, "sales");
  assert.equal(inventory.result.contextType, "inventory");
  assert.equal(product.result.contextType, "product");
  assert.deepEqual(contextCalls, [
    { type: "sales", input: { subjectType: "shop", subjectId: "shop-1" } },
    { type: "inventory", input: { subjectType: "sku", subjectId: "sku-1" } },
    { type: "product", input: { subjectId: "product-1" } },
  ]);
  assert.equal(Object.hasOwn(sales, "repository"), false);
  assert.equal(Object.hasOwn(sales, "provider"), false);
});

test("Tool Runtime blocks undeclared and permission-mismatched tools", async () => {
  const { createAgent } = runtime();
  const reader = createAgent(definition());
  await assert.rejects(
    () => reader.executeTool({
      request_id: "forbidden-tool",
      tool_name: "create_task",
      input: {},
    }),
    { code: "AGENT_TOOL_FORBIDDEN" },
  );

  assert.throws(
    () => createAgent(definition({
      name: "test.permission-mismatch",
      tools: [{ name: "query_sales", version: "1.0.0", access: "read", permission: "product.read" }],
      scopes: ["product.read"],
    })),
    { code: "AGENT_TOOL_PERMISSION_MISMATCH" },
  );
});

test("create_task produces a pending approval task and never executes it", async () => {
  const { createAgent, created, traces } = runtime();
  const creator = createAgent(definition({
    name: "test.task-creator",
    tools: [{ name: "create_task", version: "1.0.0", access: "write", permission: "agent.task.create" }],
    mode: "execute",
    scopes: ["agent.task.create"],
    approval: true,
  }));

  const response = await creator.executeTool({
    request_id: "create-task-1",
    requested_by: "test-suite",
    tool_name: "create_task",
    input: {
      idempotency_key: "store-1-review",
      business_object: { type: "store", id: "store-1", name: "TH Store" },
      reason: { code: "sales_decline", summary: "Sales declined materially." },
      evidence: [{ type: "metric", label: "GMV change", value: -8000 }],
      suggested_action: { code: "review_store", summary: "Review the store before action." },
      priority: "P1",
      requires_approval: false,
    },
  });

  assert.equal(response.result.state, "PENDING");
  assert.equal(response.result.taskKind, "agent_recommendation");
  assert.equal(response.result.executionMode, "human");
  assert.equal(response.result.input.requires_approval, true);
  assert.equal(response.result.evidence.automatic_execution, false);
  assert.equal(response.result.input.source_agent.name, "test.task-creator");
  assert.equal(created.length, 1);
  assert.equal(traces.at(-1).status, "success");
  assert.equal(traces.at(-1).metadata.toolName, "create_task");
  assert.match(traces.at(-1).metadata.resultDigest, /^[a-f0-9]{64}$/);
});

test("Tool Registry resolves exact name and version pairs", () => {
  const registry = new AgentToolRegistry();
  const base = {
    name: "test.versioned",
    description: "Versioned Tool.",
    access: "read",
    permission: "test.read",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
  };
  registry.register({ ...base, version: "1.0.0", execute: async () => ({ version: 1 }) });
  registry.register({ ...base, version: "2.0.0", execute: async () => ({ version: 2 }) });

  assert.equal(registry.require("test.versioned", "1.0.0").definition.version, "1.0.0");
  assert.equal(registry.require("test.versioned", "2.0.0").definition.version, "2.0.0");
  assert.throws(
    () => registry.require("test.versioned", "3.0.0"),
    { code: "AGENT_TOOL_NOT_REGISTERED" },
  );
});

test("Tool Foundation modules do not import databases, files, or external clients", async () => {
  const files = [
    "lib/ai/tools/agent-tool-contracts.mjs",
    "lib/ai/tools/agent-tool-registry.mjs",
    "lib/ai/tools/agent-tool-runtime.mjs",
    "lib/ai/tools/agent-tool-audit-tracer.mjs",
    "lib/ai/tools/commerce-ops-tools.mjs",
    "lib/ai/tools/daily-report-tools.mjs",
    "lib/ai/tools/json-schema-validation.mjs",
  ];
  for (const file of files) {
    const source = await fs.readFile(path.resolve(file), "utf8");
    assert.doesNotMatch(
      source,
      /node:fs|database-provider|sqlite|postgres|\bfetch\s*\(|node:https?|axios|requests\b/i,
      file,
    );
  }
});
