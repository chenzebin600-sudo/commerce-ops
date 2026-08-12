import { randomUUID as createRandomUUID } from "node:crypto";
import { LIFECYCLE_CLASSIFICATIONS, LIFECYCLE_SCOPE_NAMES } from "../../files/file-lifecycle-policy.mjs";

const CLASSIFICATIONS = new Set(LIFECYCLE_CLASSIFICATIONS);
const SCOPES = new Set(LIFECYCLE_SCOPE_NAMES);

function iso(value = new Date()) { return value instanceof Date ? value.toISOString() : String(value); }
function json(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function scanRow(row) {
  if (!row) return null;
  return {
    id: row.id, status: row.status, scopes: json(row.scopes_json, []), summary: json(row.summary_json, {}),
    scopeErrors: json(row.scope_errors_json, []), totalFiles: Number(row.total_files || 0),
    totalBytes: Number(row.total_bytes || 0), truncated: Boolean(row.truncated), reportFileId: row.report_file_id || null,
    errorCode: row.error_code || null, startedAt: row.started_at, finishedAt: row.finished_at || null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function itemRow(row) {
  if (!row) return null;
  return {
    id: row.id, scanId: row.scan_id, classification: row.classification,
    categories: json(row.categories_json, [row.classification]), scope: row.scope, sourceType: row.source_type || null,
    fileId: row.file_id || null, taskId: row.task_id || null, runId: row.run_id || null,
    maskedFilename: row.masked_filename, fileSize: Number(row.file_size || 0), fileCreatedAt: row.file_created_at || null,
    fileModifiedAt: row.file_modified_at || null, databaseStatus: row.database_status || null,
    physicalStatus: row.physical_status, suggestQuarantine: Boolean(row.suggest_quarantine),
    suggestCleanup: Boolean(row.suggest_cleanup), reasonCode: row.reason_code, shortHash: row.short_hash || null,
    errorCode: row.error_code || null, detectedFileType: row.detected_file_type || null,
    reviewStatus: row.review_status || "pending_review", reviewedAt: row.reviewed_at || null,
    reviewReason: row.review_reason || null, managedFileId: row.managed_file_id || null,
    quarantinedAt: row.quarantined_at || null, restoredAt: row.restored_at || null, createdAt: row.created_at,
  };
}

export class PostgresqlFileLifecycleRepository {
  constructor({ provider, randomUUID = createRandomUUID }) {
    if (!provider?.query || !provider?.transaction) throw new TypeError("PostgreSQL lifecycle provider is required");
    this.provider = provider;
    this.randomUUID = randomUUID;
    this.schema = provider.config?.schema || "app";
  }
  table(name) { return `"${this.schema}"."${name}"`; }
  async createScan(scopes, now = new Date()) {
    const id = this.randomUUID(), timestamp = iso(now);
    const result = await this.provider.query(`INSERT INTO ${this.table("file_lifecycle_scans")}
      (id,status,scopes_json,started_at,created_at,updated_at) VALUES ($1,'running',$2::jsonb,$3,$3,$3) RETURNING *`,
    [id, JSON.stringify(scopes), timestamp]);
    return scanRow(result.rows[0]);
  }

  async getRunningScan(client = this.provider) {
    return scanRow((await client.query(`SELECT * FROM ${this.table("file_lifecycle_scans")}
      WHERE status='running' ORDER BY created_at DESC LIMIT 1`)).rows[0]);
  }

  async completeScan(id, report, now = new Date()) {
    const timestamp = iso(now);
    return this.provider.transaction(async (transaction) => {
      for (const item of report.items) {
        await transaction.execute(`INSERT INTO ${this.table("file_lifecycle_items")} (
          id,scan_id,classification,categories_json,scope,source_type,file_id,task_id,run_id,masked_filename,
          file_size,file_created_at,file_modified_at,database_status,physical_status,suggest_quarantine,suggest_cleanup,
          reason_code,short_hash,error_code,detected_file_type,review_status,managed_file_id,created_at
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`, [
          item.id || this.randomUUID(), id, item.classification, JSON.stringify(item.categories || [item.classification]),
          item.scope, item.sourceType || null, item.fileId || null, item.taskId || null, item.runId || null,
          item.maskedFilename, Number(item.fileSize || 0), item.fileCreatedAt || null, item.fileModifiedAt || null,
          item.databaseStatus || null, item.physicalStatus, Boolean(item.suggestQuarantine), Boolean(item.suggestCleanup),
          item.reasonCode, item.shortHash || null, item.errorCode || null, item.detectedFileType || null,
          item.reviewStatus || "pending_review", item.managedFileId || null, timestamp,
        ]);
      }
      const result = await transaction.query(`UPDATE ${this.table("file_lifecycle_scans")} SET status='completed',
        summary_json=$1::jsonb,scope_errors_json=$2::jsonb,total_files=$3,total_bytes=$4,truncated=$5,
        finished_at=$6,updated_at=$6 WHERE id=$7 RETURNING *`, [JSON.stringify(report.summary || {}),
        JSON.stringify(report.scopeErrors || []), Number(report.totalFiles || 0), Number(report.totalBytes || 0),
        Boolean(report.truncated), timestamp, id]);
      return scanRow(result.rows[0]);
    });
  }

  async failScan(id, errorCode, now = new Date()) {
    const result = await this.provider.query(`UPDATE ${this.table("file_lifecycle_scans")} SET status='failed',
      error_code=$1,finished_at=$2,updated_at=$2 WHERE id=$3 RETURNING *`,
    [String(errorCode || "LIFECYCLE_SCAN_FAILED").slice(0, 80), iso(now), id]);
    return scanRow(result.rows[0]);
  }
  async attachReport(id, fileId, now = new Date()) {
    const result = await this.provider.query(`UPDATE ${this.table("file_lifecycle_scans")}
      SET report_file_id=$1,updated_at=$2 WHERE id=$3 RETURNING *`, [fileId, iso(now), id]);
    return scanRow(result.rows[0]);
  }
  async getScan(id, client = this.provider) {
    return scanRow((await client.query(`SELECT * FROM ${this.table("file_lifecycle_scans")} WHERE id=$1`, [id])).rows[0]);
  }
  async listScans({ page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const count = await this.provider.query(`SELECT COUNT(*)::int AS total FROM ${this.table("file_lifecycle_scans")}`);
    const result = await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_scans")}
      ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`, [safePageSize, (safePage - 1) * safePageSize]);
    const total = Number(count.rows[0]?.total || 0);
    return { scans: result.rows.map(scanRow), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }
  async listItems(scanId, { classification, sourceType, start, end, page = 1, pageSize = 50 } = {}) {
    const clauses = ["scan_id=$1"], values = [scanId];
    const bind = (value) => { values.push(value); return `$${values.length}`; };
    if (classification) {
      if (!CLASSIFICATIONS.has(classification)) throw new Error("Unsupported lifecycle classification");
      clauses.push(`(classification=${bind(classification)} OR categories_json @> ${bind(JSON.stringify([classification]))}::jsonb)`);
    }
    if (sourceType) clauses.push(`source_type=${bind(String(sourceType).slice(0, 80))}`);
    if (start) clauses.push(`file_modified_at>=${bind(iso(start))}`);
    if (end) clauses.push(`file_modified_at<=${bind(iso(end))}`);
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 50, 100));
    const where = `WHERE ${clauses.join(" AND ")}`;
    const count = await this.provider.query(`SELECT COUNT(*)::int AS total FROM ${this.table("file_lifecycle_items")} ${where}`, values);
    const rows = await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_items")} ${where}
      ORDER BY created_at DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, safePageSize, (safePage - 1) * safePageSize]);
    const total = Number(count.rows[0]?.total || 0);
    return { items: rows.rows.map(itemRow), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }
  async allItems(scanId) {
    return (await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_items")}
      WHERE scan_id=$1 ORDER BY created_at,id`, [scanId])).rows.map(itemRow);
  }
  async latestSummary() {
    return scanRow((await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_scans")} ORDER BY created_at DESC LIMIT 1`)).rows[0]);
  }
  async protectedFileIds() {
    const rows = (await this.provider.query(`SELECT file_id FROM ${this.table("file_lifecycle_protected_files")}`)).rows;
    return new Set(rows.map((row) => row.file_id));
  }
  validateScopes(scopes) {
    const normalized = [...new Set(scopes.map((scope) => String(scope || "").trim()).filter(Boolean))];
    if (!normalized.length || normalized.some((scope) => !SCOPES.has(scope))) throw new Error("Unsupported lifecycle scan scope");
    return normalized;
  }
}
