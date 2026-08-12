import { AuditRepository } from "../repositories/audit-repository.mjs";

function normalizeRow(row) {
  if (!row) return null;
  return {
    ...row,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export class PostgresqlAuditRepository extends AuditRepository {
  constructor({ provider }) {
    super();
    if (!provider?.query || !provider?.execute) throw new TypeError("PostgreSQL audit provider is required");
    this.provider = provider;
    this.schema = provider.config?.schema || "app";
  }

  table() { return `"${this.schema}"."operation_audit_events"`; }

  async create(event) {
    const result = await this.provider.query(`INSERT INTO ${this.table()}
      (id,request_id,occurred_at,module,action,http_method,request_path,status,http_status,duration_ms,source_ip,
       actor_type,actor_identifier,task_id,run_id,file_id,error_stage,error_code,error_summary,metadata_json,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)
      RETURNING *`, [
      event.id, event.requestId, event.occurredAt, event.module, event.action, event.httpMethod || null,
      event.requestPath || null, event.status, event.httpStatus ?? null, event.durationMs ?? null,
      event.sourceIp || null, event.actorType || null, event.actorIdentifier || null, event.taskId || null,
      event.runId || null, event.fileId || null, event.errorStage || null, event.errorCode || null,
      event.errorSummary || null, event.metadataJson || "{}", event.createdAt,
    ]);
    return normalizeRow(result.rows[0]);
  }

  async get(id) {
    const result = await this.provider.query(`SELECT * FROM ${this.table()} WHERE id=$1`, [id]);
    return normalizeRow(result.rows[0]);
  }

  filters({ start, end, module, action, status, httpStatus, taskId, runId, fileId }) {
    const clauses = [];
    const values = [];
    const equal = (column, value) => {
      if (value === undefined || value === null || value === "") return;
      values.push(value);
      clauses.push(`${column}=$${values.length}`);
    };
    if (start) { values.push(start); clauses.push(`occurred_at>=$${values.length}`); }
    if (end) { values.push(end); clauses.push(`occurred_at<=$${values.length}`); }
    equal("module", module);
    equal("action", action);
    equal("status", status);
    equal("http_status", httpStatus);
    equal("task_id", taskId);
    equal("run_id", runId);
    equal("file_id", fileId);
    return { clauses, values };
  }

  async query(input) {
    const { clauses, values } = this.filters(input);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = await this.provider.query(`SELECT COUNT(*) AS total FROM ${this.table()} ${where}`, values);
    const pageValues = [...values, input.pageSize, (input.page - 1) * input.pageSize];
    const rows = await this.provider.query(`SELECT * FROM ${this.table()} ${where}
      ORDER BY occurred_at DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, pageValues);
    return { rows: rows.rows.map(normalizeRow), total: Number(count.rows[0]?.total || 0) };
  }

  async summary(input) {
    const { clauses, values } = this.filters(input);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [byStatus, byModule] = await Promise.all([
      this.provider.query(`SELECT status,COUNT(*) count FROM ${this.table()} ${where} GROUP BY status`, values),
      this.provider.query(`SELECT module,COUNT(*) count FROM ${this.table()} ${where} GROUP BY module ORDER BY count DESC`, values),
    ]);
    return { byStatus: byStatus.rows, byModule: byModule.rows };
  }

  async cleanupBefore(cutoff) {
    const result = await this.provider.execute(`DELETE FROM ${this.table()} WHERE occurred_at<$1`, [cutoff]);
    return Number(result.rowCount || 0);
  }
}
