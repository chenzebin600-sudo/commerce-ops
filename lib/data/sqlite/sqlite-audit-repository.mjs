import { AuditRepository } from "../repositories/audit-repository.mjs";
import { resolveSqliteProvider } from "./sqlite-provider.mjs";

export class SqliteAuditRepository extends AuditRepository {
  constructor({ provider }) {
    super();
    if (provider?.prepare && !provider?.exec) {
      this.provider = null;
      this.database = provider;
    } else {
      this.provider = resolveSqliteProvider(provider);
      this.database = this.provider.connection;
    }
  }

  create(event) {
    this.database.prepare(`INSERT INTO operation_audit_events
      (id,request_id,occurred_at,module,action,http_method,request_path,status,http_status,duration_ms,source_ip,actor_type,actor_identifier,task_id,run_id,file_id,error_stage,error_code,error_summary,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.id, event.requestId, event.occurredAt, event.module, event.action, event.httpMethod,
      event.requestPath, event.status, event.httpStatus, event.durationMs, event.sourceIp,
      event.actorType, event.actorIdentifier, event.taskId, event.runId, event.fileId,
      event.errorStage, event.errorCode, event.errorSummary, event.metadataJson, event.createdAt,
    );
    return this.get(event.id);
  }

  get(id) {
    return this.database.prepare("SELECT * FROM operation_audit_events WHERE id=?").get(id) || null;
  }

  query({ start, end, module, action, status, httpStatus, taskId, runId, fileId, page, pageSize }) {
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
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS total FROM operation_audit_events ${where}`).get(...values).total || 0);
    const rows = this.database.prepare(`SELECT * FROM operation_audit_events ${where} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize);
    return { rows, total };
  }

  summary({ start, end }) {
    const clauses = [];
    const values = [];
    if (start) { clauses.push("occurred_at>=?"); values.push(start); }
    if (end) { clauses.push("occurred_at<=?"); values.push(end); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const byStatus = this.database.prepare(`SELECT status,COUNT(*) count FROM operation_audit_events ${where} GROUP BY status`).all(...values);
    const byModule = this.database.prepare(`SELECT module,COUNT(*) count FROM operation_audit_events ${where} GROUP BY module ORDER BY count DESC`).all(...values);
    return { byStatus, byModule };
  }

  cleanupBefore(cutoff) {
    return Number(this.database.prepare("DELETE FROM operation_audit_events WHERE occurred_at<?").run(cutoff).changes || 0);
  }
}
