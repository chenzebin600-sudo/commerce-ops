import { randomUUID } from "node:crypto";
import { LIFECYCLE_CLASSIFICATIONS, LIFECYCLE_SCOPE_NAMES } from "./file-lifecycle-policy.mjs";

const CLASSIFICATIONS = new Set(LIFECYCLE_CLASSIFICATIONS);
const SCOPES = new Set(LIFECYCLE_SCOPE_NAMES);

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function json(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function scanRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    scopes: json(row.scopes_json, []),
    summary: json(row.summary_json, {}),
    scopeErrors: json(row.scope_errors_json, []),
    totalFiles: Number(row.total_files || 0),
    totalBytes: Number(row.total_bytes || 0),
    truncated: Boolean(row.truncated),
    reportFileId: row.report_file_id || null,
    errorCode: row.error_code || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scanId: row.scan_id,
    classification: row.classification,
    categories: json(row.categories_json, [row.classification]),
    scope: row.scope,
    sourceType: row.source_type || null,
    fileId: row.file_id || null,
    taskId: row.task_id || null,
    runId: row.run_id || null,
    maskedFilename: row.masked_filename,
    fileSize: Number(row.file_size || 0),
    fileCreatedAt: row.file_created_at || null,
    fileModifiedAt: row.file_modified_at || null,
    databaseStatus: row.database_status || null,
    physicalStatus: row.physical_status,
    suggestQuarantine: Boolean(row.suggest_quarantine),
    suggestCleanup: Boolean(row.suggest_cleanup),
    reasonCode: row.reason_code,
    shortHash: row.short_hash || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
  };
}

export class FileLifecycleRepository {
  constructor({ db }) {
    this.db = db.db || db;
  }

  createScan(scopes, now = new Date()) {
    const id = randomUUID();
    const timestamp = iso(now);
    this.db.prepare(`INSERT INTO file_lifecycle_scans
      (id,status,scopes_json,started_at,created_at,updated_at)
      VALUES (?,'running',?,?,?,?)`).run(id, JSON.stringify(scopes), timestamp, timestamp, timestamp);
    return this.getScan(id);
  }

  getRunningScan() {
    return scanRow(this.db.prepare("SELECT * FROM file_lifecycle_scans WHERE status='running' ORDER BY created_at DESC LIMIT 1").get());
  }

  completeScan(id, report, now = new Date()) {
    const timestamp = iso(now);
    return transaction(this.db, () => {
      const insert = this.db.prepare(`INSERT INTO file_lifecycle_items (
        id,scan_id,classification,categories_json,scope,source_type,file_id,task_id,run_id,
        masked_filename,file_size,file_created_at,file_modified_at,database_status,physical_status,
        suggest_quarantine,suggest_cleanup,reason_code,short_hash,error_code,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of report.items) {
        insert.run(
          item.id || randomUUID(), id, item.classification, JSON.stringify(item.categories || [item.classification]),
          item.scope, item.sourceType || null, item.fileId || null, item.taskId || null, item.runId || null,
          item.maskedFilename, Number(item.fileSize || 0), item.fileCreatedAt || null, item.fileModifiedAt || null,
          item.databaseStatus || null, item.physicalStatus, Number(Boolean(item.suggestQuarantine)),
          Number(Boolean(item.suggestCleanup)), item.reasonCode, item.shortHash || null, item.errorCode || null, timestamp,
        );
      }
      this.db.prepare(`UPDATE file_lifecycle_scans SET
        status='completed',summary_json=?,scope_errors_json=?,total_files=?,total_bytes=?,truncated=?,finished_at=?,updated_at=?
        WHERE id=?`).run(
        JSON.stringify(report.summary || {}), JSON.stringify(report.scopeErrors || []), Number(report.totalFiles || 0), Number(report.totalBytes || 0),
        Number(Boolean(report.truncated)), timestamp, timestamp, id,
      );
      return this.getScan(id);
    });
  }

  failScan(id, errorCode, now = new Date()) {
    const timestamp = iso(now);
    this.db.prepare(`UPDATE file_lifecycle_scans SET status='failed',error_code=?,finished_at=?,updated_at=? WHERE id=?`)
      .run(String(errorCode || "LIFECYCLE_SCAN_FAILED").slice(0, 80), timestamp, timestamp, id);
    return this.getScan(id);
  }

  attachReport(id, fileId, now = new Date()) {
    this.db.prepare("UPDATE file_lifecycle_scans SET report_file_id=?,updated_at=? WHERE id=?")
      .run(fileId, iso(now), id);
    return this.getScan(id);
  }

  getScan(id) {
    return scanRow(this.db.prepare("SELECT * FROM file_lifecycle_scans WHERE id=?").get(id));
  }

  listScans({ page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const total = Number(this.db.prepare("SELECT count(*) total FROM file_lifecycle_scans").get().total || 0);
    const scans = this.db.prepare("SELECT * FROM file_lifecycle_scans ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?")
      .all(safePageSize, (safePage - 1) * safePageSize).map(scanRow);
    return { scans, total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }

  listItems(scanId, { classification, sourceType, start, end, page = 1, pageSize = 50 } = {}) {
    const clauses = ["scan_id=?"];
    const params = [scanId];
    if (classification) {
      if (!CLASSIFICATIONS.has(classification)) throw new Error("Unsupported lifecycle classification");
      clauses.push("(classification=? OR categories_json LIKE ?)");
      params.push(classification, `%\"${classification}\"%`);
    }
    if (sourceType) {
      clauses.push("source_type=?");
      params.push(String(sourceType).slice(0, 80));
    }
    if (start) {
      clauses.push("file_modified_at>=?");
      params.push(iso(start));
    }
    if (end) {
      clauses.push("file_modified_at<=?");
      params.push(iso(end));
    }
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 50, 100));
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = Number(this.db.prepare(`SELECT count(*) total FROM file_lifecycle_items ${where}`).get(...params).total || 0);
    const items = this.db.prepare(`SELECT * FROM file_lifecycle_items ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...params, safePageSize, (safePage - 1) * safePageSize).map(itemRow);
    return { items, total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }

  allItems(scanId) {
    return this.db.prepare("SELECT * FROM file_lifecycle_items WHERE scan_id=? ORDER BY created_at,id")
      .all(scanId).map(itemRow);
  }

  latestSummary() {
    return scanRow(this.db.prepare("SELECT * FROM file_lifecycle_scans ORDER BY created_at DESC LIMIT 1").get());
  }

  protectedFileIds() {
    return new Set(this.db.prepare("SELECT file_id FROM file_lifecycle_protected_files").all().map((row) => row.file_id));
  }

  validateScopes(scopes) {
    const normalized = [...new Set(scopes.map((scope) => String(scope || "").trim()).filter(Boolean))];
    if (!normalized.length || normalized.some((scope) => !SCOPES.has(scope))) throw new Error("Unsupported lifecycle scan scope");
    return normalized;
  }
}
