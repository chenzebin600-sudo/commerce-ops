import { randomUUID } from "node:crypto";
import { XLSX_MIME } from "../security/file-policy.mjs";

export const EXPORT_FILE_TYPES = Object.freeze(new Set(["excel"]));
export const EXPORT_SOURCE_TYPES = Object.freeze(new Set([
  "mabang_manual_order",
  "mabang_manual_inventory",
  "mabang_scheduled_order",
  "mabang_scheduled_inventory",
]));
export const EXPORT_FILE_STATUSES = Object.freeze(new Set([
  "available",
  "missing",
  "expired",
  "deleted",
  "generation_failed",
  "integrity_failed",
]));

const METADATA_KEYS = Object.freeze(new Set([
  "exportedRows",
  "sourceRows",
  "generatedBy",
  "taskType",
  "sanitizedCellCount",
]));

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseMetadata(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeMetadata(value = {}) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "string") result[key] = item.slice(0, 80);
    else if (typeof item === "boolean") result[key] = item;
  }
  return result;
}

export function serializeExportFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    fileType: row.file_type,
    sourceType: row.source_type,
    taskId: row.task_id || null,
    runId: row.run_id || null,
    requestKey: row.request_key || null,
    originalFilename: row.original_filename,
    storageFilename: row.storage_filename,
    relativePath: row.relative_path,
    mimeType: row.mime_type || XLSX_MIME,
    fileSize: Number(row.file_size || 0),
    fileHash: row.file_hash || null,
    status: row.status,
    expiresAt: row.expires_at || null,
    missingAt: row.missing_at || null,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function assertAllowed(value, allowed, name) {
  if (!allowed.has(value)) throw new Error(`${name} is invalid`);
  return value;
}

export class ExportFileRepository {
  constructor({ db }) {
    this.db = db;
  }

  create(input) {
    const id = input.id || randomUUID();
    const createdAt = iso(input.createdAt || new Date());
    const fileType = assertAllowed(input.fileType || "excel", EXPORT_FILE_TYPES, "file_type");
    const sourceType = assertAllowed(input.sourceType, EXPORT_SOURCE_TYPES, "source_type");
    const status = assertAllowed(input.status || "available", EXPORT_FILE_STATUSES, "status");
    this.db.prepare(`INSERT INTO export_files (
      id,file_type,source_type,task_id,run_id,request_key,original_filename,storage_filename,
      relative_path,mime_type,file_size,file_hash,status,expires_at,missing_at,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      fileType,
      sourceType,
      input.taskId || null,
      input.runId || null,
      input.requestKey || null,
      input.originalFilename,
      input.storageFilename,
      input.relativePath,
      input.mimeType || XLSX_MIME,
      Number(input.fileSize || 0),
      input.fileHash || null,
      status,
      input.expiresAt ? iso(input.expiresAt) : null,
      input.missingAt ? iso(input.missingAt) : null,
      JSON.stringify(safeMetadata(input.metadata)),
      createdAt,
      iso(input.updatedAt || createdAt),
    );
    return this.get(id);
  }

  get(id) {
    return serializeExportFile(this.db.prepare("SELECT * FROM export_files WHERE id=?").get(id));
  }

  getByRequestKey(requestKey) {
    if (!requestKey) return null;
    return serializeExportFile(this.db.prepare("SELECT * FROM export_files WHERE request_key=?").get(requestKey));
  }

  list({ sourceType, taskId, runId, status, createdFrom, createdTo, page = 1, pageSize = 20 } = {}) {
    const clauses = [];
    const params = [];
    const filters = [
      ["source_type", sourceType],
      ["task_id", taskId],
      ["run_id", runId],
      ["status", status],
    ];
    for (const [column, value] of filters) {
      if (value == null || String(value).trim() === "") continue;
      clauses.push(`${column}=?`);
      params.push(String(value).trim());
    }
    if (createdFrom) {
      clauses.push("created_at>=?");
      params.push(iso(createdFrom));
    }
    if (createdTo) {
      clauses.push("created_at<=?");
      params.push(iso(createdTo));
    }
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(this.db.prepare(`SELECT count(*) total FROM export_files ${where}`).get(...params).total || 0);
    const rows = this.db.prepare(`SELECT * FROM export_files ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...params, safePageSize, (safePage - 1) * safePageSize)
      .map(serializeExportFile);
    return { files: rows, total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }

  updateStatus(id, status, { missingAt = undefined } = {}) {
    assertAllowed(status, EXPORT_FILE_STATUSES, "status");
    const nextMissingAt = missingAt === undefined ? undefined : (missingAt ? iso(missingAt) : null);
    if (nextMissingAt === undefined) {
      this.db.prepare("UPDATE export_files SET status=?,updated_at=? WHERE id=?").run(status, iso(), id);
    } else {
      this.db.prepare("UPDATE export_files SET status=?,missing_at=?,updated_at=? WHERE id=?")
        .run(status, nextMissingAt, iso(), id);
    }
    return this.get(id);
  }

  listExpired(now = new Date()) {
    return this.db.prepare("SELECT * FROM export_files WHERE status='available' AND expires_at IS NOT NULL AND expires_at<=?")
      .all(iso(now))
      .map(serializeExportFile);
  }
}

export function createExportFileRepository(db) {
  return new ExportFileRepository({ db: db.db || db });
}
