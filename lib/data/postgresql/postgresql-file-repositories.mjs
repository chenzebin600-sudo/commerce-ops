import { randomUUID as createRandomUUID } from "node:crypto";
import { XLSX_MIME } from "../../security/file-policy.mjs";
import {
  EXPORT_FILE_STATUSES,
  EXPORT_FILE_TYPES,
  EXPORT_SOURCE_TYPES,
  serializeExportFile,
} from "../../files/file-repository.mjs";

const METADATA_KEYS = new Set([
  "exportedRows", "sourceRows", "generatedBy", "taskType", "sanitizedCellCount",
  "scanId", "classificationCount", "batchId", "rowCount",
]);

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

function exportFileRow(row) {
  if (!row) return null;
  return serializeExportFile({
    ...row,
    metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json || {}),
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    missing_at: row.missing_at instanceof Date ? row.missing_at.toISOString() : row.missing_at,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  });
}

export class PostgresqlExportFileRepository {
  constructor({ provider, randomUUID = createRandomUUID, now = () => new Date() }) {
    if (!provider?.query || !provider?.execute) throw new TypeError("PostgreSQL file provider is required");
    this.provider = provider;
    this.randomUUID = randomUUID;
    this.now = now;
    this.schema = provider.config?.schema || "app";
  }

  table() { return `"${this.schema}"."export_files"`; }

  async create(input) {
    const id = input.id || this.randomUUID();
    const createdAt = iso(input.createdAt || this.now());
    const fileType = assertAllowed(input.fileType || "excel", EXPORT_FILE_TYPES, "file_type");
    const sourceType = assertAllowed(input.sourceType, EXPORT_SOURCE_TYPES, "source_type");
    const generatedBy = VIRTUAL_SOURCE_TYPES[sourceType];
    const storedSourceType = generatedBy ? "mabang_manual_order" : sourceType;
    const metadata = safeMetadata(generatedBy ? { ...(input.metadata || {}), generatedBy } : input.metadata);
    const status = assertAllowed(input.status || "available", EXPORT_FILE_STATUSES, "status");
    const result = await this.provider.query(`INSERT INTO ${this.table()} (
      id,file_type,source_type,task_id,run_id,request_key,original_filename,storage_filename,
      relative_path,mime_type,file_size,file_hash,status,expires_at,missing_at,metadata_json,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) RETURNING *`, [
      id, fileType, storedSourceType, input.taskId || null, input.runId || null, input.requestKey || null,
      input.originalFilename, input.storageFilename, input.relativePath, input.mimeType || XLSX_MIME,
      Number(input.fileSize || 0), input.fileHash || null, status,
      input.expiresAt ? iso(input.expiresAt) : null, input.missingAt ? iso(input.missingAt) : null,
      JSON.stringify(metadata), createdAt, iso(input.updatedAt || createdAt),
    ]);
    return exportFileRow(result.rows[0]);
  }

  async get(id) {
    const result = await this.provider.query(`SELECT * FROM ${this.table()} WHERE id=$1`, [id]);
    return exportFileRow(result.rows[0]);
  }

  async getByRequestKey(requestKey) {
    if (!requestKey) return null;
    const result = await this.provider.query(`SELECT * FROM ${this.table()} WHERE request_key=$1`, [requestKey]);
    return exportFileRow(result.rows[0]);
  }

  async list({ sourceType, scope, taskId, runId, status, createdFrom, createdTo, page = 1, pageSize = 20 } = {}) {
    const clauses = [];
    const values = [];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
    if (scope === "mabang") {
      clauses.push("source_type LIKE 'mabang_%'");
      clauses.push("COALESCE(metadata_json->>'generatedBy','')<>'product_package_import'");
    }
    const generatedBy = VIRTUAL_SOURCE_TYPES[sourceType];
    if (generatedBy) {
      clauses.push("source_type='mabang_manual_order'");
      add("metadata_json->>'generatedBy'=?", generatedBy);
    } else if (sourceType) {
      add("source_type=?", String(sourceType).trim());
      if (sourceType === "mabang_manual_order") {
        clauses.push("COALESCE(metadata_json->>'generatedBy','') NOT IN ('lifecycle_scanner','product_package_import')");
      }
    }
    for (const [column, value] of [["task_id", taskId], ["run_id", runId], ["status", status]]) {
      if (value == null || String(value).trim() === "") continue;
      add(`${column}=?`, String(value).trim());
    }
    if (createdFrom) add("created_at>=?", iso(createdFrom));
    if (createdTo) add("created_at<=?", iso(createdTo));
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = await this.provider.query(`SELECT COUNT(*) total FROM ${this.table()} ${where}`, values);
    const pageValues = [...values, safePageSize, (safePage - 1) * safePageSize];
    const rows = await this.provider.query(`SELECT * FROM ${this.table()} ${where}
      ORDER BY created_at DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, pageValues);
    const total = Number(count.rows[0]?.total || 0);
    return {
      files: rows.rows.map(exportFileRow), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  async updateStatus(id, status, { missingAt = undefined } = {}) {
    assertAllowed(status, EXPORT_FILE_STATUSES, "status");
    const values = [status];
    let missing = "";
    if (missingAt !== undefined) {
      values.push(missingAt ? iso(missingAt) : null);
      missing = `,missing_at=$${values.length}`;
    }
    values.push(id);
    const result = await this.provider.query(`UPDATE ${this.table()} SET status=$1${missing},updated_at=clock_timestamp()
      WHERE id=$${values.length} RETURNING *`, values);
    return exportFileRow(result.rows[0]);
  }

  async listExpired(now = this.now()) {
    const result = await this.provider.query(`SELECT * FROM ${this.table()}
      WHERE status='available' AND expires_at IS NOT NULL AND expires_at<=$1`, [iso(now)]);
    return result.rows.map(exportFileRow);
  }

  async listAll() {
    const result = await this.provider.query(`SELECT * FROM ${this.table()} ORDER BY created_at,id`);
    return result.rows.map(exportFileRow);
  }
}
