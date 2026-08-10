import { AuditRepository } from "./repositories/audit-repository.mjs";
import { assertDatabaseProvider } from "./database-provider.mjs";
import { createPortableRepositoryExecutor } from "./portable-repository-executor.mjs";
import { createRepositorySql } from "./repository-sql.mjs";

function jsonText(value) {
  if (value === null || value === undefined || value === "") return "{}";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function timestamp(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizedRow(row) {
  if (!row) return null;
  return {
    ...row,
    occurred_at: timestamp(row.occurred_at),
    created_at: timestamp(row.created_at),
    metadata_json: jsonText(row.metadata_json),
  };
}

function normalizedCountRows(rows) {
  return rows.map((row) => ({ ...row, count: Number(row.count || 0) }));
}

export class ProviderAuditRepository extends AuditRepository {
  constructor({ provider }) {
    super();
    const resolved = assertDatabaseProvider(provider);
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }

  async isReady() {
    return this.sql.relationExists("operation_audit_events");
  }

  async create(event) {
    await this.provider.execute(`INSERT INTO ${this.sql.table("operation_audit_events")}
      (id,request_id,occurred_at,module,action,http_method,request_path,status,http_status,duration_ms,
       source_ip,actor_type,actor_identifier,task_id,run_id,file_id,error_stage,error_code,error_summary,
       metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      event.id, event.requestId, event.occurredAt, event.module, event.action, event.httpMethod,
      event.requestPath, event.status, event.httpStatus, event.durationMs, event.sourceIp,
      event.actorType, event.actorIdentifier, event.taskId, event.runId, event.fileId,
      event.errorStage, event.errorCode, event.errorSummary, event.metadataJson, event.createdAt,
    ]);
    return this.get(event.id);
  }

  async get(id) {
    const result = await this.provider.query(
      `SELECT * FROM ${this.sql.table("operation_audit_events")} WHERE id=?`,
      [id],
    );
    return normalizedRow(result.rows[0]);
  }

  async listIdentitySet() {
    const result = await this.provider.query(
      `SELECT id,module,action,status,run_id
       FROM ${this.sql.table("operation_audit_events")} ORDER BY id`,
    );
    return result.rows;
  }

  async query({ start, end, module, action, status, httpStatus, taskId, runId, fileId, page = 1, pageSize = 50 } = {}) {
    const clauses = [];
    const values = [];
    const equal = (column, value) => {
      if (value === undefined || value === null || value === "") return;
      clauses.push(`${column}=?`);
      values.push(value);
    };
    if (start) { clauses.push("occurred_at>=?"); values.push(start); }
    if (end) { clauses.push("occurred_at<=?"); values.push(end); }
    equal("module", module);
    equal("action", action);
    equal("status", status);
    equal("http_status", httpStatus);
    equal("task_id", taskId);
    equal("run_id", runId);
    equal("file_id", fileId);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const table = this.sql.table("operation_audit_events");
    const count = await this.provider.query(`SELECT COUNT(*) AS total FROM ${table} ${where}`, values);
    const rows = await this.provider.query(
      `SELECT * FROM ${table} ${where}
       ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { rows: rows.rows.map(normalizedRow), total: Number(count.rows[0]?.total || 0) };
  }

  async summary({ start, end } = {}) {
    const clauses = [];
    const values = [];
    if (start) { clauses.push("occurred_at>=?"); values.push(start); }
    if (end) { clauses.push("occurred_at<=?"); values.push(end); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const table = this.sql.table("operation_audit_events");
    const [byStatus, byModule] = await Promise.all([
      this.provider.query(
        `SELECT status,COUNT(*) count FROM ${table} ${where} GROUP BY status ORDER BY status`,
        values,
      ),
      this.provider.query(
        `SELECT module,COUNT(*) count FROM ${table} ${where} GROUP BY module ORDER BY count DESC,module`,
        values,
      ),
    ]);
    return {
      byStatus: normalizedCountRows(byStatus.rows),
      byModule: normalizedCountRows(byModule.rows),
    };
  }

  async cleanupBefore(cutoff) {
    const result = await this.provider.execute(
      `DELETE FROM ${this.sql.table("operation_audit_events")} WHERE occurred_at<?`,
      [cutoff],
    );
    return Number(result.rowCount || 0);
  }
}
