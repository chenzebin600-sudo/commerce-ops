import { randomUUID } from "node:crypto";
import { XLSX_MIME } from "../security/file-policy.mjs";
import { assertDatabaseProvider } from "../data/database-provider.mjs";
import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { createRepositorySql } from "../data/repository-sql.mjs";
import {
  EXPORT_FILE_STATUSES,
  EXPORT_FILE_TYPES,
  EXPORT_SOURCE_TYPES,
  serializeExportFile,
} from "./file-repository.mjs";

const METADATA_KEYS = Object.freeze(new Set([
  "exportedRows", "sourceRows", "generatedBy", "taskType", "sanitizedCellCount",
  "scanId", "classificationCount", "batchId", "rowCount",
]));

const VIRTUAL_SOURCE_TYPES = Object.freeze({
  system_file_lifecycle_report: "lifecycle_scanner",
  product_package_import: "product_package_import",
});

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function assertAllowed(value, allowed, name) {
  if (!allowed.has(value)) throw new Error(`${name} is invalid`);
  return value;
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

export class ProviderExportFileRepository {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }

  table() {
    return this.sql.table("export_files");
  }

  async create(input) {
    const id = input.id || randomUUID();
    const createdAt = iso(input.createdAt || new Date());
    const fileType = assertAllowed(input.fileType || "excel", EXPORT_FILE_TYPES, "file_type");
    const sourceType = assertAllowed(input.sourceType, EXPORT_SOURCE_TYPES, "source_type");
    const generatedBy = VIRTUAL_SOURCE_TYPES[sourceType];
    const storedSourceType = generatedBy ? "mabang_manual_order" : sourceType;
    const metadata = generatedBy ? { ...(input.metadata || {}), generatedBy } : input.metadata;
    const status = assertAllowed(input.status || "available", EXPORT_FILE_STATUSES, "status");
    await this.provider.execute(`INSERT INTO ${this.table()} (
      id,file_type,source_type,task_id,run_id,request_key,original_filename,storage_filename,
      relative_path,mime_type,file_size,file_hash,status,expires_at,missing_at,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id, fileType, storedSourceType, input.taskId || null, input.runId || null,
      input.requestKey || null, input.originalFilename, input.storageFilename, input.relativePath,
      input.mimeType || XLSX_MIME, Number(input.fileSize || 0), input.fileHash || null, status,
      input.expiresAt ? iso(input.expiresAt) : null, input.missingAt ? iso(input.missingAt) : null,
      JSON.stringify(safeMetadata(metadata)), createdAt, iso(input.updatedAt || createdAt),
    ]);
    return this.get(id);
  }

  async get(id) {
    const result = await this.provider.query(`SELECT * FROM ${this.table()} WHERE id=?`, [id]);
    return serializeExportFile(result.rows[0]);
  }

  async getByRequestKey(requestKey) {
    if (!requestKey) return null;
    const result = await this.provider.query(`SELECT * FROM ${this.table()} WHERE request_key=?`, [requestKey]);
    return serializeExportFile(result.rows[0]);
  }

  async list({ sourceType, scope, taskId, runId, status, createdFrom, createdTo, page = 1, pageSize = 20 } = {}) {
    const clauses = [];
    const values = [];
    if (scope === "mabang") {
      clauses.push("source_type LIKE 'mabang_%' AND metadata_json NOT LIKE ?");
      values.push('%"generatedBy":"product_package_import"%');
    }
    if (VIRTUAL_SOURCE_TYPES[sourceType]) {
      clauses.push("source_type='mabang_manual_order' AND metadata_json LIKE ?");
      values.push(`%"generatedBy":"${VIRTUAL_SOURCE_TYPES[sourceType]}"%`);
    } else if (sourceType) {
      clauses.push("source_type=?");
      values.push(String(sourceType).trim());
      if (sourceType === "mabang_manual_order") {
        clauses.push("metadata_json NOT LIKE ? AND metadata_json NOT LIKE ?");
        values.push('%"generatedBy":"lifecycle_scanner"%');
        values.push('%"generatedBy":"product_package_import"%');
      }
    }
    for (const [column, value] of [["task_id", taskId], ["run_id", runId], ["status", status]]) {
      if (value == null || String(value).trim() === "") continue;
      clauses.push(`${column}=?`);
      values.push(String(value).trim());
    }
    if (createdFrom) { clauses.push("created_at>=?"); values.push(iso(createdFrom)); }
    if (createdTo) { clauses.push("created_at<=?"); values.push(iso(createdTo)); }
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [count, rows] = await Promise.all([
      this.provider.query(`SELECT count(*) total FROM ${this.table()} ${where}`, values),
      this.provider.query(
        `SELECT * FROM ${this.table()} ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
        [...values, safePageSize, (safePage - 1) * safePageSize],
      ),
    ]);
    const total = Number(count.rows[0]?.total || 0);
    return {
      files: rows.rows.map(serializeExportFile), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  async updateStatus(id, status, { missingAt = undefined } = {}) {
    assertAllowed(status, EXPORT_FILE_STATUSES, "status");
    if (missingAt === undefined) {
      await this.provider.execute(`UPDATE ${this.table()} SET status=?,updated_at=? WHERE id=?`, [status, iso(), id]);
    } else {
      await this.provider.execute(
        `UPDATE ${this.table()} SET status=?,missing_at=?,updated_at=? WHERE id=?`,
        [status, missingAt ? iso(missingAt) : null, iso(), id],
      );
    }
    return this.get(id);
  }

  async listExpired(now = new Date()) {
    const result = await this.provider.query(
      `SELECT * FROM ${this.table()} WHERE status='available' AND expires_at IS NOT NULL AND expires_at<=?`,
      [iso(now)],
    );
    return result.rows.map(serializeExportFile);
  }

  async listAll() {
    const result = await this.provider.query(`SELECT * FROM ${this.table()} ORDER BY created_at,id`);
    return result.rows.map(serializeExportFile);
  }
}

