function json(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function reviewItem(row) {
  if (!row) return null;
  return {
    id: row.id, scanId: row.scan_id, classification: row.classification,
    categories: json(row.categories_json, [row.classification]), scope: row.scope, sourceType: row.source_type || null,
    fileId: row.file_id || null, maskedFilename: row.masked_filename, fileSize: Number(row.file_size || 0),
    fileCreatedAt: row.file_created_at || null, fileModifiedAt: row.file_modified_at || null, shortHash: row.short_hash || null,
    detectedFileType: row.detected_file_type || null, reviewStatus: row.review_status || "pending_review",
    reviewedAt: row.reviewed_at || null, reviewedBy: row.reviewed_by || null, reviewReason: row.review_reason || null,
    rootKey: row.root_key || null, relativePath: row.relative_path || null, fileHash: row.full_hash || null,
    jobId: row.job_id || null, mimeType: row.mime_type || null, signatureCode: row.signature_code || null,
    detectionReasonCode: row.detection_reason_code || null, managedFileId: row.managed_file_id || null,
    originalRelativePath: row.original_relative_path || null, quarantineRelativePath: row.quarantine_relative_path || null,
    quarantinedAt: row.quarantined_at || null, restoredAt: row.restored_at || null, deletedAt: row.deleted_at || null,
  };
}
function managedFile(row) {
  if (!row) return null;
  return { id: row.id, lifecycleItemId: row.lifecycle_item_id, scanId: row.scan_id, rootKey: row.root_key,
    relativePath: row.relative_path, sourceType: row.source_type, jobId: row.job_id || null, mimeType: row.mime_type,
    fileSize: Number(row.file_size || 0), fileHash: row.file_hash, fileCreatedAt: row.file_created_at,
    status: row.status, metadata: json(row.metadata_json, {}), registeredAt: row.registered_at,
    updatedAt: row.updated_at, deletedAt: row.deleted_at || null };
}
function quarantineRecord(row) {
  if (!row) return null;
  return { id: row.id, lifecycleItemId: row.lifecycle_item_id, managedFileId: row.managed_file_id || null,
    rootKey: row.root_key, originalRelativePath: row.original_relative_path,
    quarantineRelativePath: row.quarantine_relative_path, fileSize: Number(row.file_size || 0), fileHash: row.file_hash,
    status: row.status, quarantinedAt: row.quarantined_at, quarantinedBy: row.quarantined_by,
    quarantineReason: row.quarantine_reason, restoredAt: row.restored_at || null, restoredBy: row.restored_by || null,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export class PostgresqlFileReviewRepository {
  constructor({ provider }) {
    if (!provider?.query || !provider?.transaction) throw new TypeError("PostgreSQL file review provider is required");
    this.provider = provider;
    this.schema = provider.config?.schema || "app";
  }
  table(name) { return `"${this.schema}"."${name}"`; }
  async saveEvidence(itemId, evidence) {
    const result = await this.provider.query(`UPDATE ${this.table("file_lifecycle_items")} SET
      detected_file_type=$1,root_key=$2,relative_path=$3,full_hash=$4,job_id=$5,mime_type=$6,signature_code=$7,detection_reason_code=$8
      WHERE id=$9 AND scan_id=$10 RETURNING *`, [evidence.detectedFileType, evidence.rootKey, evidence.relativePath,
      evidence.fileHash, evidence.jobId || null, evidence.mimeType, evidence.signatureCode, evidence.reasonCode, itemId, evidence.scanId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Lifecycle item changed during classification"), { code: "LIFECYCLE_ITEM_CHANGED" });
    return reviewItem(result.rows[0]);
  }

  async getItem(id, client = this.provider) {
    return reviewItem((await client.query(`SELECT * FROM ${this.table("file_lifecycle_items")} WHERE id=$1`, [id])).rows[0]);
  }
  async scanItems(scanId) {
    return (await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_items")}
      WHERE scan_id=$1 ORDER BY created_at,id`, [scanId])).rows.map(reviewItem);
  }
  async setReviewStatus(itemId, status, { actor, reason, now = new Date() } = {}) {
    if (!REVIEW_STATUSES.has(status)) throw Object.assign(new Error("Review status is invalid"), { code: "REVIEW_STATUS_INVALID" });
    const result = await this.provider.query(`UPDATE ${this.table("file_lifecycle_items")} SET review_status=$1,
      reviewed_at=$2,reviewed_by=$3,review_reason=$4 WHERE id=$5 RETURNING *`,
    [status, iso(now), bounded(actor, 100) || "operator", bounded(reason), itemId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
    return reviewItem(result.rows[0]);
  }
  async registerManagedFile(itemId, input, now = new Date()) {
    return this.provider.transaction(async (transaction) => {
      const item = reviewItem((await transaction.query(`SELECT * FROM ${this.table("file_lifecycle_items")} WHERE id=$1 FOR UPDATE`, [itemId])).rows[0]);
      if (!item) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
      const existing = managedFile((await transaction.query(`SELECT * FROM ${this.table("managed_files")}
        WHERE lifecycle_item_id=$1 OR (root_key=$2 AND relative_path=$3) LIMIT 1`, [itemId, input.rootKey, input.relativePath])).rows[0]);
      const timestamp = iso(now), actor = bounded(input.actor, 100) || "operator", reason = bounded(input.reason);
      if (existing) {
        if (existing.fileHash !== input.fileHash || existing.fileSize !== input.fileSize || existing.sourceType !== input.sourceType) {
          throw Object.assign(new Error("Managed file metadata conflicts with the physical file"), { code: "MANAGED_FILE_CONFLICT" });
        }
        await transaction.execute(`UPDATE ${this.table("file_lifecycle_items")} SET review_status='registered',
          managed_file_id=$1,source_type=$2,reviewed_at=$3,reviewed_by=$4,review_reason=$5 WHERE id=$6`,
        [existing.id, existing.sourceType, timestamp, actor, reason, itemId]);
        return { file: existing, created: false };
      }
      if (item.reviewStatus !== "approved_for_registration") throw Object.assign(new Error("Registration requires explicit approval"), { code: "REGISTRATION_NOT_APPROVED" });
      const inserted = await transaction.query(`INSERT INTO ${this.table("managed_files")} (
        id,lifecycle_item_id,scan_id,root_key,relative_path,source_type,job_id,mime_type,file_size,file_hash,
        file_created_at,status,metadata_json,registered_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'available',$12::jsonb,$13,$13) RETURNING *`, [
        input.id, itemId, item.scanId, input.rootKey, input.relativePath, input.sourceType, input.jobId || null,
        input.mimeType, input.fileSize, input.fileHash, input.fileCreatedAt, JSON.stringify(input.metadata || {}), timestamp]);
      await transaction.execute(`UPDATE ${this.table("file_lifecycle_items")} SET review_status='registered',
        managed_file_id=$1,source_type=$2,reviewed_at=$3,reviewed_by=$4,review_reason=$5 WHERE id=$6`,
      [input.id, input.sourceType, timestamp, actor, reason, itemId]);
      return { file: managedFile(inserted.rows[0]), created: true };
    });
  }
  async getManagedFile(id, client = this.provider) {
    return managedFile((await client.query(`SELECT * FROM ${this.table("managed_files")} WHERE id=$1`, [id])).rows[0]);
  }
  async getManagedFileByItem(itemId) {
    return managedFile((await this.provider.query(`SELECT * FROM ${this.table("managed_files")} WHERE lifecycle_item_id=$1`, [itemId])).rows[0]);
  }
  async listManagedFiles() {
    return (await this.provider.query(`SELECT * FROM ${this.table("managed_files")} ORDER BY registered_at,id`)).rows.map(managedFile);
  }
  async recordQuarantine(itemId, input, now = new Date()) {
    return this.provider.transaction(async (transaction) => {
      const item = reviewItem((await transaction.query(`SELECT * FROM ${this.table("file_lifecycle_items")} WHERE id=$1 FOR UPDATE`, [itemId])).rows[0]);
      if (!item || item.reviewStatus !== "approved_for_quarantine") throw Object.assign(new Error("Quarantine requires explicit approval"), { code: "QUARANTINE_NOT_APPROVED" });
      const id = input.id || randomUUID(), timestamp = iso(now), actor = bounded(input.actor, 100) || "operator", reason = bounded(input.reason);
      const inserted = await transaction.query(`INSERT INTO ${this.table("file_quarantine_records")} (
        id,lifecycle_item_id,managed_file_id,root_key,original_relative_path,quarantine_relative_path,file_size,file_hash,
        status,quarantined_at,quarantined_by,quarantine_reason,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'quarantined',$9,$10,$11,$9,$9) RETURNING *`, [id, itemId,
        item.managedFileId || null, input.rootKey, input.originalRelativePath, input.quarantineRelativePath,
        input.fileSize, input.fileHash, timestamp, actor, reason]);
      await transaction.execute(`UPDATE ${this.table("file_lifecycle_items")} SET review_status='quarantined',
        original_relative_path=$1,quarantine_relative_path=$2,quarantined_at=$3,reviewed_at=$3,reviewed_by=$4,review_reason=$5 WHERE id=$6`,
      [input.originalRelativePath, input.quarantineRelativePath, timestamp, actor, reason, itemId]);
      if (item.managedFileId) await transaction.execute(`UPDATE ${this.table("managed_files")} SET status='quarantined',updated_at=$1 WHERE id=$2`, [timestamp, item.managedFileId]);
      return quarantineRecord(inserted.rows[0]);
    });
  }
  async getQuarantineRecord(id, client = this.provider) {
    return quarantineRecord((await client.query(`SELECT * FROM ${this.table("file_quarantine_records")} WHERE id=$1`, [id])).rows[0]);
  }
  async getActiveQuarantineByItem(itemId) {
    return quarantineRecord((await this.provider.query(`SELECT * FROM ${this.table("file_quarantine_records")}
      WHERE lifecycle_item_id=$1 AND status='quarantined' ORDER BY quarantined_at DESC LIMIT 1`, [itemId])).rows[0]);
  }
  async recordRestore(recordId, { actor, now = new Date() } = {}) {
    return this.provider.transaction(async (transaction) => {
      const record = quarantineRecord((await transaction.query(`SELECT * FROM ${this.table("file_quarantine_records")} WHERE id=$1 FOR UPDATE`, [recordId])).rows[0]);
      if (!record || record.status !== "quarantined") throw Object.assign(new Error("Quarantine record is not restorable"), { code: "QUARANTINE_RECORD_INVALID" });
      const timestamp = iso(now), safeActor = bounded(actor, 100) || "operator";
      const result = await transaction.query(`UPDATE ${this.table("file_quarantine_records")} SET status='restored',
        restored_at=$1,restored_by=$2,updated_at=$1 WHERE id=$3 RETURNING *`, [timestamp, safeActor, recordId]);
      await transaction.execute(`UPDATE ${this.table("file_lifecycle_items")} SET review_status='restored',
        quarantine_relative_path=NULL,restored_at=$1,reviewed_at=$1,reviewed_by=$2 WHERE id=$3`, [timestamp, safeActor, record.lifecycleItemId]);
      if (record.managedFileId) await transaction.execute(`UPDATE ${this.table("managed_files")} SET status='restored',updated_at=$1 WHERE id=$2`, [timestamp, record.managedFileId]);
      return quarantineRecord(result.rows[0]);
    });
  }
  async listQuarantineRecords({ page = 1, pageSize = 50 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 50, 100));
    const total = Number((await this.provider.query(`SELECT COUNT(*)::int AS total FROM ${this.table("file_quarantine_records")}`)).rows[0]?.total || 0);
    const rows = await this.provider.query(`SELECT * FROM ${this.table("file_quarantine_records")}
      ORDER BY quarantined_at DESC,id DESC LIMIT $1 OFFSET $2`, [safePageSize, (safePage - 1) * safePageSize]);
    return { records: rows.rows.map(quarantineRecord), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }
}
import { randomUUID } from "node:crypto";

const REVIEW_STATUSES = new Set(["pending_review", "approved_for_registration", "registered",
  "approved_for_quarantine", "quarantined", "restored", "rejected", "protected"]);
function iso(value = new Date()) { return value instanceof Date ? value.toISOString() : String(value); }
function bounded(value, maximum = 240) { return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum); }
