import { createHash, randomUUID } from "node:crypto";
import { createAgentToolAuditTracer } from "../tools/agent-tool-audit-tracer.mjs";
import { agentEvaluationModel, defineAgentEvaluation } from "./agent-evaluation-contracts.mjs";

function safeJsonSummary(value) {
  if (value === undefined) return { digest: null, bytes: null, keys: [] };
  try {
    const encoded = JSON.stringify(value);
    return {
      digest: createHash("sha256").update(encoded).digest("hex"),
      bytes: Buffer.byteLength(encoded, "utf8"),
      keys: value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).sort().slice(0, 50)
        : [],
    };
  } catch {
    return { digest: null, bytes: null, keys: [] };
  }
}

function requestIdFromArguments(args) {
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = String(input.requestId || input.request_id || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(candidate) ? candidate : null;
}

function token(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Math.max(0, Math.round(normalized)) : 0;
}

function invocationKey(agent, requestId) {
  return `${agent.name}\u001f${agent.version}\u001f${requestId}`;
}

function joined(values) {
  return [...values].sort().join(";");
}

function instant(value, label) {
  const normalized = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw Object.assign(new TypeError(`${label} is invalid`), { code: "AGENT_OBSERVABILITY_CLOCK_INVALID" });
  }
  return normalized;
}

async function recordSafely(audit, entry) {
  try { return await audit.recordSafely(entry); } catch { return null; }
}

export class AgentObservabilityService {
  constructor({ audit, repository = null, now = () => new Date() } = {}) {
    if (!audit || typeof audit.recordSafely !== "function") {
      throw new TypeError("Operation audit service is required for Agent observability");
    }
    if (repository && (typeof repository.listRuns !== "function"
      || typeof repository.getRun !== "function" || typeof repository.summary !== "function")) {
      throw new TypeError("Agent observability repository is invalid");
    }
    this.audit = audit;
    this.repository = repository;
    this.now = now;
    this.active = new Map();
    this.toolAudit = createAgentToolAuditTracer({
      audit,
      resolveRunId: (entry) => this.active.get(invocationKey(entry.agent, entry.requestId))?.runId || null,
    });
  }

  async beginRun(agent, definition, args = []) {
    const requestId = requestIdFromArguments(args) || randomUUID();
    const run = {
      runId: randomUUID(),
      requestId,
      agent,
      startedAt: instant(this.now(), "Agent run start time"),
      contextVersions: new Set(definition.input_context.map((entry) => `${entry.type}@${entry.version}`)),
      resolvedContextVersions: new Set(),
      toolCalls: new Map(),
      toolCallCount: 0,
      failedToolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    };
    this.active.set(invocationKey(agent, requestId), run);
    await recordSafely(this.audit, {
      requestId,
      runId: run.runId,
      occurredAt: run.startedAt,
      module: "ai",
      action: "agent.run.started",
      status: "success",
      actorType: "agent_runtime",
      metadata: {
        agentName: agent.name,
        agentVersion: agent.version,
        contextVersions: joined(run.contextVersions),
        resultStatus: "running",
      },
    });
    return run;
  }

  async completeRun(run, result) {
    const resultSummary = safeJsonSummary(result);
    await this.#finishRun(run, {
      action: "agent.run.completed",
      status: "success",
      resultStatus: result?.resultStatus || result?.status || "succeeded",
      resultSummary,
      error: null,
    });
  }

  async failRun(run, error) {
    await this.#finishRun(run, {
      action: "agent.run.failed",
      status: "failed",
      resultStatus: "failed",
      resultSummary: safeJsonSummary(undefined),
      error,
    });
  }

  async #finishRun(run, { action, status, resultStatus, resultSummary, error }) {
    this.active.delete(invocationKey(run.agent, run.requestId));
    const finishedAt = instant(this.now(), "Agent run finish time");
    const durationMs = Math.max(0, finishedAt.getTime() - run.startedAt.getTime());
    await recordSafely(this.audit, {
      requestId: run.requestId,
      runId: run.runId,
      occurredAt: finishedAt,
      module: "ai",
      action,
      status,
      durationMs,
      actorType: "agent_runtime",
      errorStage: error ? "agent_runtime" : null,
      errorCode: error?.code || (error ? "AGENT_RUN_FAILED" : null),
      errorSummary: error || null,
      metadata: {
        agentName: run.agent.name,
        agentVersion: run.agent.version,
        contextVersions: joined(run.contextVersions),
        resolvedContextVersions: joined(run.resolvedContextVersions),
        toolCallCount: run.toolCallCount,
        failedToolCallCount: run.failedToolCallCount,
        toolCalls: [...run.toolCalls.entries()].sort().map(([name, count]) => `${name}:${count}`).join(";"),
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.totalTokens,
        cacheHitTokens: run.cacheHitTokens,
        cacheMissTokens: run.cacheMissTokens,
        resultStatus,
        resultDigest: resultSummary.digest,
        resultBytes: resultSummary.bytes,
        resultKeys: resultSummary.keys.join(";"),
      },
    });
  }

  async recordToolInvocation(entry) {
    const run = this.active.get(invocationKey(entry.agent, entry.requestId));
    if (run) {
      const toolKey = `${entry.tool.name}@${entry.tool.version}`;
      run.toolCalls.set(toolKey, (run.toolCalls.get(toolKey) || 0) + 1);
      run.toolCallCount += 1;
      if (!entry.success) run.failedToolCallCount += 1;
      if (entry.contextVersion) run.resolvedContextVersions.add(entry.contextVersion);
      run.inputTokens += token(entry.usage?.inputTokens);
      run.outputTokens += token(entry.usage?.outputTokens);
      run.totalTokens += token(entry.usage?.totalTokens);
      run.cacheHitTokens += token(entry.usage?.cacheHitTokens);
      run.cacheMissTokens += token(entry.usage?.cacheMissTokens);
    }
    await this.toolAudit(entry);
  }

  async status() {
    return {
      ready: this.repository ? await this.repository.isReady() : true,
      storage: "operation_audit_events",
      schemaMigrationRequired: false,
      activeRuns: this.active.size,
      evaluationModel: agentEvaluationModel(),
    };
  }

  async listRuns(filters) {
    if (!this.repository) throw new TypeError("Agent observability repository is required for queries");
    return this.repository.listRuns(filters);
  }

  async getRun(runId) {
    if (!this.repository) throw new TypeError("Agent observability repository is required for queries");
    const run = await this.repository.getRun(runId);
    if (!run) return null;
    return {
      ...run,
      toolInvocations: await this.repository.listToolInvocations(runId),
      evaluations: await this.repository.listEvaluations(runId),
    };
  }

  async summary(filters) {
    if (!this.repository) throw new TypeError("Agent observability repository is required for queries");
    return this.repository.summary(filters);
  }

  async recordEvaluation(input) {
    const evaluation = defineAgentEvaluation(input);
    if (this.repository && !await this.repository.getRun(evaluation.run_id)) {
      throw Object.assign(new Error("Agent run was not found for evaluation"), {
        code: "AGENT_OBSERVABILITY_RUN_NOT_FOUND",
      });
    }
    await recordSafely(this.audit, {
      requestId: input.request_id || randomUUID(),
      runId: evaluation.run_id,
      occurredAt: evaluation.evaluated_at,
      module: "ai",
      action: "agent.evaluation.recorded",
      status: evaluation.verdict === "fail" ? "failed" : "success",
      actorType: "agent_evaluator",
      metadata: {
        evaluationMetric: evaluation.metric,
        evaluatorType: evaluation.evaluator.type,
        evaluatorName: evaluation.evaluator.name,
        evaluatorVersion: evaluation.evaluator.version,
        evaluationScore: evaluation.score,
        evaluationVerdict: evaluation.verdict,
        evidenceDigest: evaluation.evidence_digest,
        reasonCode: evaluation.reason_code,
      },
    });
    return evaluation;
  }
}
