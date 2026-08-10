import { assertDatabaseProvider } from "../../data/database-provider.mjs";
import { createPortableRepositoryExecutor } from "../../data/portable-repository-executor.mjs";
import { createRepositorySql } from "../../data/repository-sql.mjs";

const RUN_ACTIONS = Object.freeze([
  "agent.run.started",
  "agent.run.completed",
  "agent.run.failed",
]);

function positiveInteger(value, fallback, maximum) {
  const normalized = Number.parseInt(value, 10);
  if (!Number.isFinite(normalized) || normalized < 1) return fallback;
  return Math.min(normalized, maximum);
}

function parseJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function splitList(value) {
  return String(value || "").split(";").map((item) => item.trim()).filter(Boolean);
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function runRow(row) {
  if (!row) return null;
  const start = parseJson(row.started_metadata_json);
  const final = parseJson(row.final_metadata_json);
  const metadata = { ...start, ...final };
  return {
    runId: row.run_id,
    requestId: row.request_id,
    agent: {
      name: metadata.agentName || null,
      version: metadata.agentVersion || null,
    },
    contextVersions: splitList(metadata.contextVersions),
    resolvedContextVersions: splitList(metadata.resolvedContextVersions),
    status: row.final_action
      ? row.final_status === "success" ? "succeeded" : "failed"
      : "running",
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    durationMs: number(row.duration_ms),
    toolCalls: {
      total: number(metadata.toolCallCount) || 0,
      failed: number(metadata.failedToolCallCount) || 0,
      byTool: splitList(metadata.toolCalls),
    },
    tokens: {
      input: number(metadata.inputTokens),
      output: number(metadata.outputTokens),
      total: number(metadata.totalTokens),
      cacheHit: number(metadata.cacheHitTokens),
      cacheMiss: number(metadata.cacheMissTokens),
    },
    result: {
      status: metadata.resultStatus || null,
      digest: metadata.resultDigest || null,
      bytes: number(metadata.resultBytes),
      keys: splitList(metadata.resultKeys),
    },
    errorCode: row.error_code || null,
  };
}

function toolRow(row) {
  const metadata = parseJson(row.metadata_json);
  return {
    id: row.id,
    runId: row.run_id || null,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
    agent: { name: metadata.agentName || null, version: metadata.agentVersion || null },
    tool: { name: metadata.toolName || null, version: metadata.toolVersion || null },
    access: metadata.access || null,
    permission: metadata.permission || null,
    status: row.status === "success" ? "succeeded" : "failed",
    durationMs: number(row.duration_ms),
    input: {
      digest: metadata.inputDigest || null,
      bytes: number(metadata.inputBytes),
      keys: splitList(metadata.inputKeys),
    },
    output: {
      digest: metadata.outputDigest || null,
      bytes: number(metadata.outputBytes),
      keys: splitList(metadata.outputKeys),
    },
    tokens: {
      input: number(metadata.inputTokens),
      output: number(metadata.outputTokens),
      total: number(metadata.totalTokens),
      cacheHit: number(metadata.cacheHitTokens),
      cacheMiss: number(metadata.cacheMissTokens),
    },
    resultStatus: metadata.resultStatus || null,
    errorCode: row.error_code || null,
  };
}

function evaluationRow(row) {
  const metadata = parseJson(row.metadata_json);
  return {
    id: row.id,
    runId: row.run_id,
    occurredAt: row.occurred_at,
    metric: metadata.evaluationMetric || null,
    evaluator: {
      type: metadata.evaluatorType || null,
      name: metadata.evaluatorName || null,
      version: metadata.evaluatorVersion || null,
    },
    score: number(metadata.evaluationScore),
    verdict: metadata.evaluationVerdict || null,
    evidenceDigest: metadata.evidenceDigest || null,
    reasonCode: metadata.reasonCode || null,
  };
}

function lifecycleCte(sql, filters = {}) {
  const clauses = ["module='ai'", `action IN (${RUN_ACTIONS.map(() => "?").join(",")})`, "run_id IS NOT NULL"];
  const parameters = [...RUN_ACTIONS];
  if (filters.start) { clauses.push("occurred_at>=?"); parameters.push(filters.start); }
  if (filters.end) { clauses.push("occurred_at<=?"); parameters.push(filters.end); }
  return {
    parameters,
    sql: `WITH lifecycle AS (
      SELECT
        run_id,
        MIN(request_id) AS request_id,
        MIN(CASE WHEN action='agent.run.started' THEN occurred_at END) AS started_at,
        MAX(CASE WHEN action IN ('agent.run.completed','agent.run.failed') THEN occurred_at END) AS finished_at,
        MAX(CASE WHEN action IN ('agent.run.completed','agent.run.failed') THEN action END) AS final_action,
        MAX(CASE WHEN action IN ('agent.run.completed','agent.run.failed') THEN status END) AS final_status,
        MAX(CASE WHEN action IN ('agent.run.completed','agent.run.failed') THEN duration_ms END) AS duration_ms,
        MAX(CASE WHEN action='agent.run.started' THEN ${sql.isPostgresql ? "metadata_json::text" : "metadata_json"} END) AS started_metadata_json,
        MAX(CASE WHEN action IN ('agent.run.completed','agent.run.failed') THEN ${sql.isPostgresql ? "metadata_json::text" : "metadata_json"} END) AS final_metadata_json,
        MAX(CASE WHEN action IN ('agent.run.completed','agent.run.failed') THEN error_code END) AS error_code
      FROM ${sql.table("operation_audit_events")}
      WHERE ${clauses.join(" AND ")}
      GROUP BY run_id
    )`,
  };
}

function runFilters(sql, filters, parameters) {
  const clauses = [];
  if (filters.agent) {
    clauses.push(`${sql.jsonText("COALESCE(final_metadata_json,started_metadata_json)", "agentName")}=?`);
    parameters.push(filters.agent);
  }
  if (filters.version) {
    clauses.push(`${sql.jsonText("COALESCE(final_metadata_json,started_metadata_json)", "agentVersion")}=?`);
    parameters.push(filters.version);
  }
  if (filters.requestId) { clauses.push("request_id=?"); parameters.push(filters.requestId); }
  if (filters.status === "running") clauses.push("final_action IS NULL");
  if (filters.status === "succeeded") clauses.push("final_status='success'");
  if (filters.status === "failed") clauses.push("final_status='failed'");
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export class AgentObservabilityRepository {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }

  async isReady() {
    return this.sql.relationExists("operation_audit_events");
  }

  async listRuns(filters = {}) {
    const page = positiveInteger(filters.page, 1, 100_000);
    const pageSize = positiveInteger(filters.pageSize, 25, 100);
    const cte = lifecycleCte(this.sql, filters);
    const parameters = [...cte.parameters];
    const where = runFilters(this.sql, filters, parameters);
    const count = await this.provider.query(`${cte.sql} SELECT COUNT(*) AS total FROM lifecycle ${where}`, parameters);
    const result = await this.provider.query(
      `${cte.sql}
       SELECT * FROM lifecycle ${where}
       ORDER BY started_at DESC,run_id DESC
       LIMIT ? OFFSET ?`,
      [...parameters, pageSize, (page - 1) * pageSize],
    );
    return {
      items: result.rows.map(runRow),
      total: Number(count.rows[0]?.total || 0),
      page,
      pageSize,
    };
  }

  async getRun(runId) {
    const cte = lifecycleCte(this.sql);
    const result = await this.provider.query(
      `${cte.sql} SELECT * FROM lifecycle WHERE run_id=?`,
      [...cte.parameters, runId],
    );
    return runRow(result.rows[0]);
  }

  async listToolInvocations(runId) {
    const result = await this.provider.query(
      `SELECT * FROM ${this.sql.table("operation_audit_events")}
       WHERE module='ai' AND action='agent.tool.invoke' AND run_id=?
       ORDER BY occurred_at,id`,
      [runId],
    );
    return result.rows.map(toolRow);
  }

  async listEvaluations(runId) {
    const result = await this.provider.query(
      `SELECT * FROM ${this.sql.table("operation_audit_events")}
       WHERE module='ai' AND action='agent.evaluation.recorded' AND run_id=?
       ORDER BY occurred_at,id`,
      [runId],
    );
    return result.rows.map(evaluationRow);
  }

  async summary(filters = {}) {
    const cte = lifecycleCte(this.sql, filters);
    const parameters = [...cte.parameters];
    const where = runFilters(this.sql, filters, parameters);
    const result = await this.provider.query(
      `${cte.sql}
       SELECT
         COUNT(*) AS total_runs,
         SUM(CASE WHEN final_action IS NULL THEN 1 ELSE 0 END) AS running_runs,
         SUM(CASE WHEN final_status='success' THEN 1 ELSE 0 END) AS succeeded_runs,
         SUM(CASE WHEN final_status='failed' THEN 1 ELSE 0 END) AS failed_runs,
         AVG(CASE WHEN final_action IS NOT NULL THEN duration_ms END) AS average_duration_ms,
         SUM(${this.sql.jsonNumber("final_metadata_json", "toolCallCount")}) AS tool_calls,
         SUM(${this.sql.jsonNumber("final_metadata_json", "totalTokens")}) AS total_tokens
       FROM lifecycle ${where}`,
      parameters,
    );
    const row = result.rows[0] || {};
    return {
      totalRuns: Number(row.total_runs || 0),
      runningRuns: Number(row.running_runs || 0),
      succeededRuns: Number(row.succeeded_runs || 0),
      failedRuns: Number(row.failed_runs || 0),
      successRate: Number(row.total_runs || 0)
        ? Math.round((Number(row.succeeded_runs || 0) / Number(row.total_runs)) * 10_000) / 100
        : null,
      averageDurationMs: row.average_duration_ms === null
        ? null
        : Math.round(Number(row.average_duration_ms)),
      toolCalls: Number(row.tool_calls || 0),
      totalTokens: Number(row.total_tokens || 0),
    };
  }
}
