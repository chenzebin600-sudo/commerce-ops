import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "../lib/ai/agent/agent-runtime.mjs";
import { AgentRegistry } from "../lib/ai/agent/agent-registry.mjs";
import { AiContextRegistry } from "../lib/ai/context/ai-context-registry.mjs";
import { createAgentObservabilityApi } from "../lib/ai/observability/agent-observability-api.mjs";
import { defineAgentEvaluation } from "../lib/ai/observability/agent-evaluation-contracts.mjs";
import { AgentObservabilityRepository } from "../lib/ai/observability/agent-observability-repository.mjs";
import { AgentObservabilityService } from "../lib/ai/observability/agent-observability-service.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";

const DEFINITION = {
  name: "test.observed-agent",
  version: "1.4.0",
  description: "Agent Observability integration test Agent.",
  input_context: [{ type: "sales", version: "1.0.0", required: false, multiple: false }],
  tools: [{ name: "test.observe", version: "1.0.0", access: "read", permission: "test.observe" }],
  output_schema: {
    id: "test.observed-agent.output",
    version: "1.0.0",
    schema: { type: "object" },
  },
  permission: {
    mode: "recommend",
    task_domain: "growth",
    scopes: ["test.observe"],
    requires_human_approval: false,
  },
};

function taskService() {
  return {
    async create(input) { return { id: "task-1", ...input }; },
    async transition() {},
    async acquireLease() {},
    async releaseLease() { return true; },
  };
}

async function harness() {
  const connection = new DatabaseSync(":memory:");
  const provider = new SqliteProvider({ connection });
  await provider.executeScript(await readFile("migrations/002_operation_audit_events.sql", "utf8"));
  const repository = new AgentObservabilityRepository({ provider });
  const audit = createOperationAuditService({
    repository: {
      create(event) {
        connection.prepare(`INSERT INTO operation_audit_events
          (id,request_id,occurred_at,module,action,http_method,request_path,status,http_status,duration_ms,source_ip,actor_type,actor_identifier,task_id,run_id,file_id,error_stage,error_code,error_summary,metadata_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          event.id, event.requestId, event.occurredAt, event.module, event.action,
          event.httpMethod, event.requestPath, event.status, event.httpStatus,
          event.durationMs, event.sourceIp, event.actorType, event.actorIdentifier,
          event.taskId, event.runId, event.fileId, event.errorStage, event.errorCode,
          event.errorSummary, event.metadataJson, event.createdAt,
        );
        return connection.prepare("SELECT * FROM operation_audit_events WHERE id=?").get(event.id);
      },
      get(id) { return connection.prepare("SELECT * FROM operation_audit_events WHERE id=?").get(id); },
      query() { return { rows: [], total: 0 }; },
      summary() { return { byStatus: [], byModule: [] }; },
      cleanupBefore() { return 0; },
    },
  });
  const contextRegistry = new AiContextRegistry();
  contextRegistry.register({
    type: "sales",
    version: "1.0.0",
    description: "Observed sales Context.",
    inputSchema: { type: "object" },
    async resolve(input) {
      return {
        contextVersion: "SALES-CONTEXT-TEST-1.0.0",
        contextType: "sales",
        subject: { type: "sales", id: input.subjectId || "all" },
        data: {},
      };
    },
  });
  const toolRegistry = new AgentToolRegistry();
  toolRegistry.register({
    name: "test.observe",
    version: "1.0.0",
    description: "Return safe telemetry fields for an observed invocation.",
    access: "read",
    permission: "test.observe",
    database_access: "forbidden",
    external_access: "forbidden",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    execute: async () => ({
      resultStatus: "succeeded",
      contextVersion: "SALES-CONTEXT-TEST-1.0.0",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheHitTokens: 2, cacheMissTokens: 10 },
      privateValue: "must-not-be-persisted",
    }),
  });
  const runtime = new AgentRuntime({
    taskService: taskService(),
    registry: new AgentRegistry(),
    contextRegistry,
    toolRegistry,
    gateway: { async complete() { throw new Error("not used"); } },
    auditService: audit,
  });
  class ObservedAgent {
    constructor({ runtime: scope }) { this.scope = scope; }

    async run(input) {
      if (input.fail) throw Object.assign(new Error("intentional failure"), { code: "TEST_AGENT_FAILED" });
      await this.scope.executeTool({
        request_id: input.requestId,
        requested_by: "observability-test",
        tool_name: "test.observe",
        input: { safe: true, secret: "must-not-be-persisted" },
      });
      return { resultStatus: "succeeded", privateResult: "must-not-be-persisted" };
    }
  }
  const agent = runtime.createAgent({ definition: DEFINITION, Agent: ObservedAgent });
  return {
    agent,
    connection,
    queryService: new AgentObservabilityService({ audit, repository }),
  };
}

test("Agent Runtime records queryable runs, Tool details, Context versions, and tokens", async () => {
  const { agent, connection, queryService } = await harness();
  await agent.run({ requestId: "observed.success" });
  await assert.rejects(
    () => agent.run({ requestId: "observed.failure", fail: true }),
    { code: "TEST_AGENT_FAILED" },
  );

  const runs = await queryService.listRuns({ pageSize: 10 });
  assert.equal(runs.total, 2);
  const succeeded = runs.items.find((run) => run.requestId === "observed.success");
  const failed = runs.items.find((run) => run.requestId === "observed.failure");
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.agent.name, "test.observed-agent");
  assert.deepEqual(succeeded.contextVersions, ["sales@1.0.0"]);
  assert.deepEqual(succeeded.resolvedContextVersions, ["SALES-CONTEXT-TEST-1.0.0"]);
  assert.equal(succeeded.toolCalls.total, 1);
  assert.equal(succeeded.tokens.total, 15);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "TEST_AGENT_FAILED");

  const detail = await queryService.getRun(succeeded.runId);
  assert.equal(detail.toolInvocations.length, 1);
  assert.equal(detail.toolInvocations[0].tool.name, "test.observe");
  assert.equal(detail.toolInvocations[0].tokens.input, 12);
  assert.match(detail.result.digest, /^[a-f0-9]{64}$/);
  const persisted = JSON.stringify(connection.prepare("SELECT * FROM operation_audit_events").all());
  assert.equal(persisted.includes("must-not-be-persisted"), false);

  const summary = await queryService.summary({});
  assert.deepEqual(summary, {
    totalRuns: 2,
    runningRuns: 0,
    succeededRuns: 1,
    failedRuns: 1,
    successRate: 50,
    averageDurationMs: summary.averageDurationMs,
    toolCalls: 1,
    totalTokens: 15,
  });
  assert.equal(Number.isInteger(summary.averageDurationMs), true);
});

test("Agent Evaluation contract is bounded and evaluations attach to run detail", async () => {
  const { agent, queryService } = await harness();
  await agent.run({ requestId: "observed.evaluation" });
  const run = (await queryService.listRuns({ requestId: "observed.evaluation" })).items[0];
  const evaluation = await queryService.recordEvaluation({
    request_id: "evaluation-1",
    run_id: run.runId,
    metric: "output.relevance",
    evaluator_type: "deterministic",
    evaluator_name: "foundation.rules",
    evaluator_version: "1.0.0",
    score: 92.5,
    verdict: "pass",
    evidence_digest: "a".repeat(64),
    reason_code: "schema_and_evidence_complete",
  });
  assert.equal(evaluation.score, 92.5);
  assert.equal((await queryService.getRun(run.runId)).evaluations[0].verdict, "pass");
  assert.throws(
    () => defineAgentEvaluation({
      run_id: run.runId,
      metric: "bad",
      evaluator_type: "model",
      evaluator_name: "judge",
      evaluator_version: "1.0.0",
      score: 101,
      verdict: "pass",
    }),
    { code: "AGENT_EVALUATION_INVALID" },
  );
});

test("Agent Observability API exposes status, summary, list, and detail as read-only endpoints", async () => {
  const { agent, queryService } = await harness();
  await agent.run({ requestId: "observed.api" });
  const handler = createAgentObservabilityApi({ service: queryService });
  const invoke = async (method, path) => {
    const response = { status: 0, body: null };
    const req = { method, auditContext: { setOperation() {}, annotate() {} } };
    const res = {
      writeHead(status) { response.status = status; },
      end(body) { response.body = JSON.parse(body); },
    };
    await handler(req, res, new URL(path, "http://localhost"));
    return response;
  };
  assert.equal((await invoke("GET", "/api/ai/observability/status")).body.schemaMigrationRequired, false);
  assert.equal((await invoke("GET", "/api/ai/observability/summary")).body.summary.totalRuns, 1);
  const list = await invoke("GET", "/api/ai/observability/runs?agent=test.observed-agent");
  assert.equal(list.body.total, 1);
  const detail = await invoke("GET", `/api/ai/observability/runs/${list.body.items[0].runId}`);
  assert.equal(detail.body.run.toolInvocations.length, 1);
  assert.equal((await invoke("POST", "/api/ai/observability/runs")).status, 405);
});
