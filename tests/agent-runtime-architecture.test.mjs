import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentFramework } from "../lib/ai/agent/agent-framework.mjs";
import { AgentRuntime } from "../lib/ai/agent/agent-runtime.mjs";
import { AgentRegistry } from "../lib/ai/agent/agent-registry.mjs";
import { AiContextRegistry } from "../lib/ai/context/ai-context-registry.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";
import { createAgentToolAuditTracer } from "../lib/ai/tools/agent-tool-audit-tracer.mjs";
import { DailyReportAgent } from "../lib/sales-assortment/daily-report-agent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (entry.name.endsWith(".mjs")) files.push(absolute);
  }
  return files;
}

function definition() {
  return {
    name: "test.schema-runtime",
    version: "1.0.0",
    description: "Validates Tool schemas through the mandatory Agent Runtime.",
    input_context: [{ type: "shop", version: "1.0.0", required: false, multiple: false }],
    tools: [{ name: "test.schema", version: "1.0.0", access: "read", permission: "test.schema.read" }],
    output_schema: {
      id: "test.schema-runtime-output",
      version: "1.0.0",
      schema: { type: "object" },
    },
    permission: {
      mode: "recommend",
      task_domain: "growth",
      scopes: ["test.schema.read"],
      requires_human_approval: false,
    },
  };
}

function lifecycleService() {
  return {
    async create(input) { return { id: "task-1", ...input }; },
    async transition() {},
    async acquireLease() {},
    async releaseLease() {},
  };
}

function contextRegistry() {
  const registry = new AiContextRegistry();
  for (const type of ["shop", "sales", "inventory", "product"]) {
    registry.register({
      type,
      version: "1.0.0",
      description: `Architecture test ${type} Context.`,
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
  return registry;
}

function runtimeDependencies(toolRegistry = new AgentToolRegistry(), records = []) {
  return {
    taskService: lifecycleService(),
    registry: new AgentRegistry(),
    contextRegistry: contextRegistry(),
    toolRegistry,
    gateway: { async complete() { throw new Error("not used"); } },
    auditService: { async recordSafely(entry) { records.push(entry); } },
  };
}

test("Agent Framework refuses to run without a Tool Registry", () => {
  assert.throws(
    () => new AgentFramework({ taskService: lifecycleService() }),
    { code: "AGENT_TOOL_REGISTRY_REQUIRED" },
  );
});

test("production Agent construction is centralized in AgentRuntime", async () => {
  const files = await sourceFiles(path.join(ROOT, "lib"));
  const directFrameworkConstruction = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes("new AgentFramework")) {
      directFrameworkConstruction.push(path.relative(ROOT, file).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(directFrameworkConstruction, ["lib/ai/agent/agent-runtime.mjs"]);

  const scheduler = await readFile(path.join(ROOT, "scheduler.mjs"), "utf8");
  assert.match(scheduler, /new AgentRuntime\s*\(/);
  assert.match(scheduler, /agentRuntime\.createAgent\s*\(/);
  assert.doesNotMatch(scheduler, /new AgentFramework\s*\(/);
  assert.doesNotMatch(scheduler, /toolRegistryFactory|registerDailyReportTools/);
  assert.match(scheduler, /contextRegistry:\s*aiContextService\.registry/);
  assert.match(scheduler, /toolRegistry:\s*new AgentToolRegistry/);
  assert.match(scheduler, /gateway:\s*aiGateway/);
  assert.match(scheduler, /auditService:\s*audit/);

  const directBusinessConstruction = [];
  for (const file of [...files, path.join(ROOT, "scheduler.mjs")]) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/new\s+([A-Z][A-Za-z0-9]*Agent)\s*\(/g)) {
      if (match[1] !== "AgentRuntime") {
        directBusinessConstruction.push(`${path.relative(ROOT, file)}:${match[1]}`);
      }
    }
  }
  assert.deepEqual(directBusinessConstruction, []);
});

test("Daily Report production path never sends the raw dashboard through Tool Runtime", async () => {
  const scheduler = await readFile(path.join(ROOT, "scheduler.mjs"), "utf8");
  const agent = await readFile(
    path.join(ROOT, "lib", "sales-assortment", "daily-report-agent.mjs"),
    "utf8",
  );
  const registration = await readFile(
    path.join(ROOT, "lib", "ai", "context", "daily-report-context-registration.mjs"),
    "utf8",
  );

  assert.match(scheduler, /dailyReportContextService\.prepareInput\(\{ dashboard, generatedAt \}\)/);
  assert.match(scheduler, /dailyReportAgent\.run\(\{\s*contextInput,/);
  assert.doesNotMatch(agent, /input:\s*\{\s*dashboard/);
  assert.match(registration, /required:\s*\["evidence_pack", "generated_at"\]/);
  assert.doesNotMatch(registration, /required:\s*\["dashboard"/);
});

test("business Agents cannot import repositories, services, providers, network, or file access", async () => {
  const files = (await sourceFiles(path.join(ROOT, "lib")))
    .filter((file) => /(?:^|[-_])agent\.mjs$/i.test(path.basename(file)))
    .filter((file) => !file.includes(`${path.sep}lib${path.sep}ai${path.sep}agent${path.sep}`));
  assert.ok(files.length > 0, "At least one production business Agent must be audited");

  const violations = [];
  const forbiddenImport = /(?:repository|provider|(?:^|[-_/])service(?:[-_/]|\.|$)|data[-_/]?access|database|(?:^|[-_/])db(?:[-_/]|\.|$)|node:(?:fs|http|https|net)|undici)/i;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      if (forbiddenImport.test(match[1])) {
        violations.push(`${path.relative(ROOT, file)} imports ${match[1]}`);
      }
    }
    if (/\bfetch\s*\(/.test(source)) violations.push(`${path.relative(ROOT, file)} calls fetch`);
    if (/this\.(?:repository|provider|service|database|db|httpClient|fileSystem)\b/.test(source)) {
      violations.push(`${path.relative(ROOT, file)} stores a forbidden dependency`);
    }
    if (!source.includes("assertAgentRuntimeScope")) {
      violations.push(`${path.relative(ROOT, file)} does not require a Runtime scope`);
    }
  }
  assert.deepEqual(violations, []);
});

test("Daily Report Agent rejects direct dependency injection outside AgentRuntime", () => {
  assert.throws(
    () => new DailyReportAgent({ runtime: {}, configured: true }),
    { code: "AGENT_RUNTIME_SCOPE_REQUIRED" },
  );
});

test("AgentRuntime fails closed without mandatory registries, Gateway, or Audit", () => {
  const base = runtimeDependencies();
  for (const key of ["contextRegistry", "toolRegistry", "gateway", "auditService"]) {
    const input = { ...base };
    delete input[key];
    assert.throws(() => new AgentRuntime(input), TypeError);
  }
});

test("AgentRuntime rejects infrastructure dependencies in Agent options", () => {
  class TestAgent {
    constructor({ runtime }) { this.runtime = runtime; }
    async run() {}
  }
  const tools = new AgentToolRegistry();
  tools.register({
    name: "test.schema",
    version: "1.0.0",
    description: "Schema test Tool.",
    access: "read",
    permission: "test.schema.read",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    execute: async () => ({}),
  });
  const runtime = new AgentRuntime(runtimeDependencies(tools));
  assert.throws(
    () => runtime.createAgent({
      definition: definition(),
      Agent: TestAgent,
      options: { salesService: { query() {} } },
    }),
    { code: "AGENT_RUNTIME_DEPENDENCY_FORBIDDEN" },
  );

  const agent = runtime.createAgent({ definition: definition(), Agent: TestAgent });
  assert.deepEqual(Object.keys(agent.runtime).sort(), [
    "definition",
    "executeTool",
    "now",
    "resolveContext",
  ]);
  assert.equal(Object.hasOwn(agent.runtime, "taskService"), false);
  assert.equal(Object.hasOwn(agent.runtime, "gateway"), false);
  assert.equal(Object.hasOwn(agent.runtime, "repository"), false);
});

test("AgentRuntime preflights exact Context and Tool versions", () => {
  class TestAgent {
    constructor({ runtime }) { this.runtime = runtime; }
    async run() {}
  }
  const tools = new AgentToolRegistry();
  tools.register({
    name: "test.schema",
    version: "1.0.0",
    description: "Schema test Tool.",
    access: "read",
    permission: "test.schema.read",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    execute: async () => ({}),
  });
  const missingToolRuntime = new AgentRuntime(runtimeDependencies(tools));
  assert.throws(
    () => missingToolRuntime.createAgent({
      definition: {
        ...definition(),
        tools: [{ name: "test.schema", version: "2.0.0", access: "read", permission: "test.schema.read" }],
      },
      Agent: TestAgent,
    }),
    { code: "AGENT_TOOL_NOT_REGISTERED" },
  );

  const contextTools = new AgentToolRegistry();
  contextTools.register({
    name: "test.schema",
    version: "1.0.0",
    description: "Schema test Tool.",
    access: "read",
    permission: "test.schema.read",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    execute: async () => ({}),
  });
  const missingContextRuntime = new AgentRuntime(runtimeDependencies(contextTools));
  assert.throws(
    () => missingContextRuntime.createAgent({
      definition: {
        ...definition(),
        input_context: [{ type: "shop", version: "2.0.0", required: false, multiple: false }],
      },
      Agent: TestAgent,
    }),
    { code: "AI_CONTEXT_NOT_REGISTERED" },
  );
});

test("Tool Runtime validates JSON Schema for both input and output and traces failures", async () => {
  const traces = [];
  let executions = 0;
  class SchemaAgent {
    constructor({ runtime }) {
      this.runtime = runtime;
    }

    run(input) {
      return this.runtime.executeTool({
        request_id: input.requestId,
        requested_by: "architecture-test",
        tool_name: "test.schema",
        input: input.toolInput,
      });
    }
  }
  const runtime = new AgentRuntime({
    ...runtimeDependencies((() => {
      const registry = new AgentToolRegistry();
      registry.register({
        name: "test.schema",
        version: "1.0.0",
        description: "A Tool with bounded input and output contracts.",
        access: "read",
        permission: "test.schema.read",
        database_access: "forbidden",
        external_access: "forbidden",
        input_schema: {
          type: "object",
          required: ["quantity"],
          additionalProperties: false,
          properties: { quantity: { type: "integer", minimum: 1, maximum: 10 } },
        },
        output_schema: {
          type: "object",
          required: ["ok"],
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
        },
        execute: async ({ input }) => {
          executions += 1;
          return input.quantity === 9 ? { ok: "yes" } : { ok: true };
        },
      });
      return registry;
    })(), traces),
  });
  const agent = runtime.createAgent({
    definition: definition(),
    Agent: SchemaAgent,
  });

  await assert.rejects(
    () => agent.run({ requestId: "invalid-input", toolInput: { quantity: 11 } }),
    { code: "AGENT_TOOL_INPUT_SCHEMA_INVALID" },
  );
  assert.equal(executions, 0);
  await assert.rejects(
    () => agent.run({ requestId: "invalid-output", toolInput: { quantity: 9 } }),
    { code: "AGENT_TOOL_OUTPUT_SCHEMA_INVALID" },
  );
  assert.equal(executions, 1);
  const result = await agent.run({ requestId: "valid-tool", toolInput: { quantity: 2 } });
  assert.deepEqual(result.result, { ok: true });
  const toolTraces = traces.filter((entry) => entry.action === "agent.tool.invoke");
  assert.deepEqual(toolTraces.map((entry) => entry.status), ["failed", "failed", "success"]);
  assert.deepEqual(toolTraces.map((entry) => entry.errorCode), [
    "AGENT_TOOL_INPUT_SCHEMA_INVALID",
    "AGENT_TOOL_OUTPUT_SCHEMA_INVALID",
    null,
  ]);
  assert.match(toolTraces.at(-1).metadata.resultDigest, /^[a-f0-9]{64}$/);
  assert.match(toolTraces.at(-1).metadata.inputDigest, /^[a-f0-9]{64}$/);
  assert.match(toolTraces.at(-1).metadata.outputDigest, /^[a-f0-9]{64}$/);
});

test("Tool audit traces exclude raw Tool input and output", async () => {
  const records = [];
  const trace = createAgentToolAuditTracer({
    audit: { async recordSafely(entry) { records.push(entry); } },
  });
  await trace({
    requestId: "trace-1",
    agent: { name: "sales.daily-report", version: "2.1.0" },
    tool: { name: "query_sales", version: "1.0.0", access: "read", permission: "sales.read" },
    success: true,
    durationMs: 12,
    resultDigest: "a".repeat(64),
    resultStatus: "succeeded",
    rawInput: { secret: "must-not-leak" },
    rawOutput: { customer: "must-not-leak" },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].action, "agent.tool.invoke");
  assert.equal(records[0].metadata.toolName, "query_sales");
  assert.equal(JSON.stringify(records).includes("must-not-leak"), false);
});
