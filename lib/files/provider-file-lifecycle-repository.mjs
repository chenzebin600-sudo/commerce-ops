import { randomUUID } from "node:crypto";
import { assertDatabaseProvider } from "../data/database-provider.mjs";
import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { createRepositorySql } from "../data/repository-sql.mjs";
import { LIFECYCLE_CLASSIFICATIONS, LIFECYCLE_SCOPE_NAMES } from "./file-lifecycle-policy.mjs";

const CLASSIFICATIONS = new Set(LIFECYCLE_CLASSIFICATIONS);
const SCOPES = new Set(LIFECYCLE_SCOPE_NAMES);

function iso(value = new Date()) { return value instanceof Date ? value.toISOString() : String(value); }
function json(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; }
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
    maskedFilename: row.masked_filename, fileSize: Number(row.file_size || 0),
    fileCreatedAt: row.file_created_at || null, fileModifiedAt: row.file_modified_at || null,
    databaseStatus: row.database_status || null, physicalStatus: row.physical_status,
    suggestQuarantine: Boolean(row.suggest_quarantine), suggestCleanup: Boolean(row.suggest_cleanup),
    reasonCode: row.reason_code, shortHash: row.short_hash || null, errorCode: row.error_code || null,
    detectedFileType: row.detected_file_type || null, reviewStatus: row.review_status || "pending_review",
    reviewedAt: row.reviewed_at || null, reviewReason: row.review_reason || null,
    managedFileId: row.managed_file_id || null, quarantinedAt: row.quarantined_at || null,
    restoredAt: row.restored_at || null, createdAt: row.created_at,
  };
}

export class ProviderFileLifecycleRepository {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    this.databaseProvider = resolved;
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }
  table(name) { return this.sql.table(name); }
  flag(value) { return Number(Boolean(value)); }

  async createScan(scopes, now = new Date()) {
    const id = randomUUID();
    const timestamp = iso(now);
    await this.provider.execute(`INSERT INTO ${this.table("file_lifecycle_scans")}
      (id,status,scopes_json,started_at,created_at,updated_at) VALUES (?,'running',?,?,?,?)`,
    [id, JSON.stringify(scopes), timestamp, timestamp, timestamp]);
    return this.getScan(id);
  }
  async getRunningScan() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_scans")}
      WHERE status='running' ORDER BY created_at DESC LIMIT 1`);
    return scanRow(result.rows[0]);
  }
  async completeScan(id, report, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.transaction(async (tx) => {
      for (const item of report.items) {
        const itemId = item.id || randomUUID();
        await tx.execute(`INSERT INTO ${this.table("file_lifecycle_items")} (
          id,scan_id,classification,categories_json,scope,source_type,file_id,task_id,run_id,
          masked_filename,file_size,file_created_at,file_modified_at,database_status,physical_status,
          suggest_quarantine,suggest_cleanup,reason_code,short_hash,error_code,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          itemId, id, item.classification, JSON.stringify(item.categories || [item.classification]),
          item.scope, item.sourceType || null, item.fileId || null, item.taskId || null, item.runId || null,
          item.maskedFilename, Number(item.fileSize || 0), item.fileCreatedAt || null, item.fileModifiedAt || null,
          item.databaseStatus || null, item.physicalStatus, this.flag(item.suggestQuarantine), this.flag(item.suggestCleanup),
          item.reasonCode, item.shortHash || null, item.errorCode || null, timestamp,
        ]);
        await tx.execute(`UPDATE ${this.table("file_lifecycle_items")}
          SET detected_file_type=?,review_status=?,managed_file_id=? WHERE id=?`,
        [item.detectedFileType || null, item.reviewStatus || "pending_review", item.managedFileId || null, itemId]);
      }
      await tx.execute(`UPDATE ${this.table("file_lifecycle_scans")} SET
        status='completed',summary_json=?,scope_errors_json=?,total_files=?,total_bytes=?,truncated=?,finished_at=?,updated_at=?
        WHERE id=?`, [JSON.stringify(report.summary || {}), JSON.stringify(report.scopeErrors || []),
        Number(report.totalFiles || 0), Number(report.totalBytes || 0), this.flag(report.truncated), timestamp, timestamp, id]);
    });
    return this.getScan(id);
  }
  async failScan(id, errorCode, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.execute(`UPDATE ${this.table("file_lifecycle_scans")}
      SET status='failed',error_code=?,finished_at=?,updated_at=? WHERE id=?`,
    [String(errorCode || "LIFECYCLE_SCAN_FAILED").slice(0, 80), timestamp, timestamp, id]);
    return this.getScan(id);
  }
  async attachReport(id, fileId, now = new Date()) {
    await this.provider.execute(`UPDATE ${this.table("file_lifecycle_scans")} SET report_file_id=?,updated_at=? WHERE id=?`,
      [fileId, iso(now), id]);
    return this.getScan(id);
  }
  async getScan(id) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_scans")} WHERE id=?`, [id]);
    return scanRow(result.rows[0]);
  }
  async listScans({ page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const [count, rows] = await Promise.all([
      this.provider.query(`SELECT count(*) total FROM ${this.table("file_lifecycle_scans")}`),
      this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_scans")}
        ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [safePageSize, (safePage - 1) * safePageSize]),
    ]);
    const total = Number(count.rows[0]?.total || 0);
    return { scans: rows.rows.map(scanRow), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }
  async listItems(scanId, { classification, sourceType, start, end, page = 1, pageSize = 50 } = {}) {
    const clauses = ["scan_id=?"];
    const values = [scanId];
    if (classification) {
      if (!CLASSIFICATIONS.has(classification)) throw new Error("Unsupported lifecycle classification");
      clauses.push("(classification=? OR CAST(categories_json AS TEXT) LIKE ?)");
      values.push(classification, `%"${classification}"%`);
    }
    if (sourceType) { clauses.push("source_type=?"); values.push(String(sourceType).slice(0, 80)); }
    if (start) { clauses.push("file_modified_at>=?"); values.push(iso(start)); }
    if (end) { clauses.push("file_modified_at<=?"); values.push(iso(end)); }
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 50, 100));
    const where = `WHERE ${clauses.join(" AND ")}`;
    const [count, rows] = await Promise.all([
      this.provider.query(`SELECT count(*) total FROM ${this.table("file_lifecycle_items")} ${where}`, values),
      this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_items")} ${where}
        ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [...values, safePageSize, (safePage - 1) * safePageSize]),
    ]);
    const total = Number(count.rows[0]?.total || 0);
    return { items: rows.rows.map(itemRow), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }
  async allItems(scanId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_items")}
      WHERE scan_id=? ORDER BY created_at,id`, [scanId]);
    return result.rows.map(itemRow);
  }
  async latestSummary() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_scans")}
      ORDER BY created_at DESC LIMIT 1`);
    return scanRow(result.rows[0]);
  }
  async protectedFileIds() {
    const result = await this.provider.query(`SELECT file_id FROM ${this.table("file_lifecycle_protected_files")}`);
    return new Set(result.rows.map((row) => row.file_id));
  }
  validateScopes(scopes) {
    const normalized = [...new Set(scopes.map((scope) => String(scope || "").trim()).filter(Boolean))];
    if (!normalized.length || normalized.some((scope) => !SCOPES.has(scope))) throw new Error("Unsupported lifecycle scan scope");
    return normalized;
  }
}
