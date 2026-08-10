import { randomUUID } from "node:crypto";
import { assertDatabaseProvider } from "../data/database-provider.mjs";
import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { createRepositorySql } from "../data/repository-sql.mjs";

const REVIEW_STATUSES = new Set([
  "pending_review", "approved_for_registration", "registered", "approved_for_quarantine",
  "quarantined", "restored", "rejected", "protected",
]);
function iso(value = new Date()) { return value instanceof Date ? value.toISOString() : String(value); }
function json(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; }
}
function bounded(value, maximum = 240) { return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum); }
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
  return {
    id: row.id, lifecycleItemId: row.lifecycle_item_id, scanId: row.scan_id, rootKey: row.root_key,
    relativePath: row.relative_path, sourceType: row.source_type, jobId: row.job_id || null, mimeType: row.mime_type,
    fileSize: Number(row.file_size || 0), fileHash: row.file_hash, fileCreatedAt: row.file_created_at,
    status: row.status, metadata: json(row.metadata_json, {}), registeredAt: row.registered_at,
    updatedAt: row.updated_at, deletedAt: row.deleted_at || null,
  };
}
function quarantineRecord(row) {
  if (!row) return null;
  return {
    id: row.id, lifecycleItemId: row.lifecycle_item_id, managedFileId: row.managed_file_id || null,
    rootKey: row.root_key, originalRelativePath: row.original_relative_path,
    quarantineRelativePath: row.quarantine_relative_path, fileSize: Number(row.file_size || 0), fileHash: row.file_hash,
    status: row.status, quarantinedAt: row.quarantined_at, quarantinedBy: row.quarantined_by,
    quarantineReason: row.quarantine_reason, restoredAt: row.restored_at || null,
    restoredBy: row.restored_by || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class ProviderFileReviewRepository {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }
  table(name) { return this.sql.table(name); }
  async getItem(id, executor = this.provider) {
    const result = await executor.query(`SELECT * FROM ${this.table("file_lifecycle_items")} WHERE id=?`, [id]);
    return reviewItem(result.rows[0]);
  }
  async scanItems(scanId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("file_lifecycle_items")}
      WHERE scan_id=? ORDER BY created_at,id`, [scanId]);
    return result.rows.map(reviewItem);
  }
  async saveEvidence(itemId, evidence) {
    const result = await this.provider.execute(`UPDATE ${this.table("file_lifecycle_items")} SET
      detected_file_type=?,root_key=?,relative_path=?,full_hash=?,job_id=?,mime_type=?,signature_code=?,detection_reason_code=?
      WHERE id=? AND scan_id=?`, [evidence.detectedFileType, evidence.rootKey, evidence.relativePath, evidence.fileHash,
      evidence.jobId || null, evidence.mimeType, evidence.signatureCode, evidence.reasonCode, itemId, evidence.scanId]);
    if (Number(result.rowCount || 0) !== 1) throw Object.assign(new Error("Lifecycle item changed during classification"), { code: "LIFECYCLE_ITEM_CHANGED" });
    return this.getItem(itemId);
  }
  async setReviewStatus(itemId, status, { actor, reason, now = new Date() } = {}) {
    if (!REVIEW_STATUSES.has(status)) throw Object.assign(new Error("Review status is invalid"), { code: "REVIEW_STATUS_INVALID" });
    const result = await this.provider.execute(`UPDATE ${this.table("file_lifecycle_items")}
      SET review_status=?,reviewed_at=?,reviewed_by=?,review_reason=? WHERE id=?`,
    [status, iso(now), bounded(actor, 100) || "operator", bounded(reason), itemId]);
    if (Number(result.rowCount || 0) !== 1) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
    return this.getItem(itemId);
  }
  async registerManagedFile(itemId, input, now = new Date()) {
    return this.provider.transaction(async (tx) => {
      const item = await this.getItem(itemId, tx);
      if (!item) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
      const found = await tx.query(`SELECT * FROM ${this.table("managed_files")}
        WHERE lifecycle_item_id=? OR (root_key=? AND relative_path=?) LIMIT 1`, [itemId, input.rootKey, input.relativePath]);
      const existing = managedFile(found.rows[0]);
      if (existing) {
        if (existing.fileHash !== input.fileHash || existing.fileSize !== input.fileSize || existing.sourceType !== input.sourceType) {
          throw Object.assign(new Error("Managed file metadata conflicts with the physical file"), { code: "MANAGED_FILE_CONFLICT" });
        }
        await tx.execute(`UPDATE ${this.table("file_lifecycle_items")} SET
          review_status='registered',managed_file_id=?,source_type=?,reviewed_at=?,reviewed_by=?,review_reason=? WHERE id=?`,
        [existing.id, existing.sourceType, iso(now), bounded(input.actor, 100) || "operator", bounded(input.reason), itemId]);
        return { file: existing, created: false };
      }
      if (item.reviewStatus !== "approved_for_registration") {
        throw Object.assign(new Error("Registration requires explicit approval"), { code: "REGISTRATION_NOT_APPROVED" });
      }
      await tx.execute(`INSERT INTO ${this.table("managed_files")} (
        id,lifecycle_item_id,scan_id,root_key,relative_path,source_type,job_id,mime_type,file_size,file_hash,
        file_created_at,status,metadata_json,registered_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'available',?,?,?)`, [input.id, itemId, item.scanId, input.rootKey,
      input.relativePath, input.sourceType, input.jobId || null, input.mimeType, input.fileSize, input.fileHash,
      input.fileCreatedAt, JSON.stringify(input.metadata || {}), iso(now), iso(now)]);
      await tx.execute(`UPDATE ${this.table("file_lifecycle_items")} SET
        review_status='registered',managed_file_id=?,source_type=?,reviewed_at=?,reviewed_by=?,review_reason=? WHERE id=?`,
      [input.id, input.sourceType, iso(now), bounded(input.actor, 100) || "operator", bounded(input.reason), itemId]);
      const created = await tx.query(`SELECT * FROM ${this.table("managed_files")} WHERE id=?`, [input.id]);
      return { file: managedFile(created.rows[0]), created: true };
    });
  }
  async getManagedFile(id, executor = this.provider) {
    const result = await executor.query(`SELECT * FROM ${this.table("managed_files")} WHERE id=?`, [id]);
    return managedFile(result.rows[0]);
  }
  async getManagedFileByItem(itemId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("managed_files")} WHERE lifecycle_item_id=?`, [itemId]);
    return managedFile(result.rows[0]);
  }
  async listManagedFiles() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("managed_files")} ORDER BY registered_at,id`);
    return result.rows.map(managedFile);
  }
  async recordQuarantine(itemId, input, now = new Date()) {
    return this.provider.transaction(async (tx) => {
      const item = await this.getItem(itemId, tx);
      if (!item || item.reviewStatus !== "approved_for_quarantine") {
        throw Object.assign(new Error("Quarantine requires explicit approval"), { code: "QUARANTINE_NOT_APPROVED" });
      }
      const id = input.id || randomUUID();
      await tx.execute(`INSERT INTO ${this.table("file_quarantine_records")} (
        id,lifecycle_item_id,managed_file_id,root_key,original_relative_path,quarantine_relative_path,
        file_size,file_hash,status,quarantined_at,quarantined_by,quarantine_reason,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,'quarantined',?,?,?,?,?)`, [id, itemId, item.managedFileId || null, input.rootKey,
      input.originalRelativePath, input.quarantineRelativePath, input.fileSize, input.fileHash, iso(now),
      bounded(input.actor, 100) || "operator", bounded(input.reason), iso(now), iso(now)]);
      await tx.execute(`UPDATE ${this.table("file_lifecycle_items")} SET
        review_status='quarantined',original_relative_path=?,quarantine_relative_path=?,quarantined_at=?,
        reviewed_at=?,reviewed_by=?,review_reason=? WHERE id=?`, [input.originalRelativePath,
      input.quarantineRelativePath, iso(now), iso(now), bounded(input.actor, 100) || "operator", bounded(input.reason), itemId]);
      if (item.managedFileId) await tx.execute(`UPDATE ${this.table("managed_files")} SET status='quarantined',updated_at=? WHERE id=?`, [iso(now), item.managedFileId]);
      const created = await tx.query(`SELECT * FROM ${this.table("file_quarantine_records")} WHERE id=?`, [id]);
      return quarantineRecord(created.rows[0]);
    });
  }
  async getQuarantineRecord(id, executor = this.provider) {
    const result = await executor.query(`SELECT * FROM ${this.table("file_quarantine_records")} WHERE id=?`, [id]);
    return quarantineRecord(result.rows[0]);
  }
  async getActiveQuarantineByItem(itemId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("file_quarantine_records")}
      WHERE lifecycle_item_id=? AND status='quarantined' ORDER BY quarantined_at DESC LIMIT 1`, [itemId]);
    return quarantineRecord(result.rows[0]);
  }
  async recordRestore(recordId, { actor, now = new Date() } = {}) {
    return this.provider.transaction(async (tx) => {
      const record = await this.getQuarantineRecord(recordId, tx);
      if (!record || record.status !== "quarantined") throw Object.assign(new Error("Quarantine record is not restorable"), { code: "QUARANTINE_RECORD_INVALID" });
      await tx.execute(`UPDATE ${this.table("file_quarantine_records")}
        SET status='restored',restored_at=?,restored_by=?,updated_at=? WHERE id=?`,
      [iso(now), bounded(actor, 100) || "operator", iso(now), recordId]);
      await tx.execute(`UPDATE ${this.table("file_lifecycle_items")} SET
        review_status='restored',quarantine_relative_path=NULL,restored_at=?,reviewed_at=?,reviewed_by=? WHERE id=?`,
      [iso(now), iso(now), bounded(actor, 100) || "operator", record.lifecycleItemId]);
      if (record.managedFileId) await tx.execute(`UPDATE ${this.table("managed_files")} SET status='restored',updated_at=? WHERE id=?`, [iso(now), record.managedFileId]);
      const restored = await tx.query(`SELECT * FROM ${this.table("file_quarantine_records")} WHERE id=?`, [recordId]);
      return quarantineRecord(restored.rows[0]);
    });
  }
  async listQuarantineRecords({ page = 1, pageSize = 50 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 50, 100));
    const [count, rows] = await Promise.all([
      this.provider.query(`SELECT COUNT(*) total FROM ${this.table("file_quarantine_records")}`),
      this.provider.query(`SELECT * FROM ${this.table("file_quarantine_records")}
        ORDER BY quarantined_at DESC,id DESC LIMIT ? OFFSET ?`, [safePageSize, (safePage - 1) * safePageSize]),
    ]);
    const total = Number(count.rows[0]?.total || 0);
    return { records: rows.rows.map(quarantineRecord), total, page: safePage, pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }
}

