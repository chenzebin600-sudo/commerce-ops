import { randomUUID } from "node:crypto";

const REVIEW_STATUSES = new Set([
  "pending_review",
  "approved_for_registration",
  "registered",
  "approved_for_quarantine",
  "quarantined",
  "restored",
  "rejected",
  "protected",
]);

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function json(value, fallback = {}) {
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

function bounded(value, maximum = 240) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function reviewItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    scanId: row.scan_id,
    classification: row.classification,
    categories: json(row.categories_json, [row.classification]),
    scope: row.scope,
    sourceType: row.source_type || null,
    fileId: row.file_id || null,
    maskedFilename: row.masked_filename,
    fileSize: Number(row.file_size || 0),
    fileCreatedAt: row.file_created_at || null,
    fileModifiedAt: row.file_modified_at || null,
    shortHash: row.short_hash || null,
    detectedFileType: row.detected_file_type || null,
    reviewStatus: row.review_status || "pending_review",
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by || null,
    reviewReason: row.review_reason || null,
    rootKey: row.root_key || null,
    relativePath: row.relative_path || null,
    fileHash: row.full_hash || null,
    jobId: row.job_id || null,
    mimeType: row.mime_type || null,
    signatureCode: row.signature_code || null,
    detectionReasonCode: row.detection_reason_code || null,
    managedFileId: row.managed_file_id || null,
    originalRelativePath: row.original_relative_path || null,
    quarantineRelativePath: row.quarantine_relative_path || null,
    quarantinedAt: row.quarantined_at || null,
    restoredAt: row.restored_at || null,
    deletedAt: row.deleted_at || null,
  };
}

function managedFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    lifecycleItemId: row.lifecycle_item_id,
    scanId: row.scan_id,
    rootKey: row.root_key,
    relativePath: row.relative_path,
    sourceType: row.source_type,
    jobId: row.job_id || null,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size || 0),
    fileHash: row.file_hash,
    fileCreatedAt: row.file_created_at,
    status: row.status,
    metadata: json(row.metadata_json, {}),
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function quarantineRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    lifecycleItemId: row.lifecycle_item_id,
    managedFileId: row.managed_file_id || null,
    rootKey: row.root_key,
    originalRelativePath: row.original_relative_path,
    quarantineRelativePath: row.quarantine_relative_path,
    fileSize: Number(row.file_size || 0),
    fileHash: row.file_hash,
    status: row.status,
    quarantinedAt: row.quarantined_at,
    quarantinedBy: row.quarantined_by,
    quarantineReason: row.quarantine_reason,
    restoredAt: row.restored_at || null,
    restoredBy: row.restored_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FileReviewRepository {
  constructor({ db }) {
    this.db = db.db || db;
  }

  getItem(id) {
    return reviewItem(this.db.prepare("SELECT * FROM file_lifecycle_items WHERE id=?").get(id));
  }

  scanItems(scanId) {
    return this.db.prepare("SELECT * FROM file_lifecycle_items WHERE scan_id=? ORDER BY created_at,id").all(scanId).map(reviewItem);
  }

  saveEvidence(itemId, evidence) {
    const result = this.db.prepare(`UPDATE file_lifecycle_items SET
      detected_file_type=?,root_key=?,relative_path=?,full_hash=?,job_id=?,mime_type=?,signature_code=?,detection_reason_code=?
      WHERE id=? AND scan_id=?`).run(
      evidence.detectedFileType,
      evidence.rootKey,
      evidence.relativePath,
      evidence.fileHash,
      evidence.jobId || null,
      evidence.mimeType,
      evidence.signatureCode,
      evidence.reasonCode,
      itemId,
      evidence.scanId,
    );
    if (result.changes !== 1) throw Object.assign(new Error("Lifecycle item changed during classification"), { code: "LIFECYCLE_ITEM_CHANGED" });
    return this.getItem(itemId);
  }

  setReviewStatus(itemId, status, { actor, reason, now = new Date() } = {}) {
    if (!REVIEW_STATUSES.has(status)) throw Object.assign(new Error("Review status is invalid"), { code: "REVIEW_STATUS_INVALID" });
    const result = this.db.prepare(`UPDATE file_lifecycle_items
      SET review_status=?,reviewed_at=?,reviewed_by=?,review_reason=?
      WHERE id=?`).run(status, iso(now), bounded(actor, 100) || "operator", bounded(reason), itemId);
    if (result.changes !== 1) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
    return this.getItem(itemId);
  }

  registerManagedFile(itemId, input, now = new Date()) {
    return transaction(this.db, () => {
      const item = this.getItem(itemId);
      if (!item) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
      const existing = managedFile(this.db.prepare("SELECT * FROM managed_files WHERE lifecycle_item_id=? OR (root_key=? AND relative_path=?) LIMIT 1")
        .get(itemId, input.rootKey, input.relativePath));
      if (existing) {
        if (existing.fileHash !== input.fileHash || existing.fileSize !== input.fileSize || existing.sourceType !== input.sourceType) {
          throw Object.assign(new Error("Managed file metadata conflicts with the physical file"), { code: "MANAGED_FILE_CONFLICT" });
        }
        this.db.prepare(`UPDATE file_lifecycle_items SET review_status='registered',managed_file_id=?,source_type=?,reviewed_at=?,reviewed_by=?,review_reason=? WHERE id=?`)
          .run(existing.id, existing.sourceType, iso(now), bounded(input.actor, 100) || "operator", bounded(input.reason), itemId);
        return { file: existing, created: false };
      }
      if (item.reviewStatus !== "approved_for_registration") {
        throw Object.assign(new Error("Registration requires explicit approval"), { code: "REGISTRATION_NOT_APPROVED" });
      }
      this.db.prepare(`INSERT INTO managed_files (
        id,lifecycle_item_id,scan_id,root_key,relative_path,source_type,job_id,mime_type,file_size,file_hash,
        file_created_at,status,metadata_json,registered_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'available',?,?,?)`).run(
        input.id,
        itemId,
        item.scanId,
        input.rootKey,
        input.relativePath,
        input.sourceType,
        input.jobId || null,
        input.mimeType,
        input.fileSize,
        input.fileHash,
        input.fileCreatedAt,
        JSON.stringify(input.metadata || {}),
        iso(now),
        iso(now),
      );
      this.db.prepare(`UPDATE file_lifecycle_items SET
        review_status='registered',managed_file_id=?,source_type=?,reviewed_at=?,reviewed_by=?,review_reason=?
        WHERE id=?`).run(input.id, input.sourceType, iso(now), bounded(input.actor, 100) || "operator", bounded(input.reason), itemId);
      return { file: this.getManagedFile(input.id), created: true };
    });
  }

  getManagedFile(id) {
    return managedFile(this.db.prepare("SELECT * FROM managed_files WHERE id=?").get(id));
  }

  getManagedFileByItem(itemId) {
    return managedFile(this.db.prepare("SELECT * FROM managed_files WHERE lifecycle_item_id=?").get(itemId));
  }

  listManagedFiles() {
    return this.db.prepare("SELECT * FROM managed_files ORDER BY registered_at,id").all().map(managedFile);
  }

  recordQuarantine(itemId, input, now = new Date()) {
    return transaction(this.db, () => {
      const item = this.getItem(itemId);
      if (!item || item.reviewStatus !== "approved_for_quarantine") {
        throw Object.assign(new Error("Quarantine requires explicit approval"), { code: "QUARANTINE_NOT_APPROVED" });
      }
      const id = input.id || randomUUID();
      this.db.prepare(`INSERT INTO file_quarantine_records (
        id,lifecycle_item_id,managed_file_id,root_key,original_relative_path,quarantine_relative_path,
        file_size,file_hash,status,quarantined_at,quarantined_by,quarantine_reason,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,'quarantined',?,?,?,?,?)`).run(
        id,
        itemId,
        item.managedFileId || null,
        input.rootKey,
        input.originalRelativePath,
        input.quarantineRelativePath,
        input.fileSize,
        input.fileHash,
        iso(now),
        bounded(input.actor, 100) || "operator",
        bounded(input.reason),
        iso(now),
        iso(now),
      );
      this.db.prepare(`UPDATE file_lifecycle_items SET
        review_status='quarantined',original_relative_path=?,quarantine_relative_path=?,quarantined_at=?,reviewed_at=?,reviewed_by=?,review_reason=?
        WHERE id=?`).run(
        input.originalRelativePath,
        input.quarantineRelativePath,
        iso(now),
        iso(now),
        bounded(input.actor, 100) || "operator",
        bounded(input.reason),
        itemId,
      );
      if (item.managedFileId) this.db.prepare("UPDATE managed_files SET status='quarantined',updated_at=? WHERE id=?").run(iso(now), item.managedFileId);
      return this.getQuarantineRecord(id);
    });
  }

  getQuarantineRecord(id) {
    return quarantineRecord(this.db.prepare("SELECT * FROM file_quarantine_records WHERE id=?").get(id));
  }

  getActiveQuarantineByItem(itemId) {
    return quarantineRecord(this.db.prepare("SELECT * FROM file_quarantine_records WHERE lifecycle_item_id=? AND status='quarantined' ORDER BY quarantined_at DESC LIMIT 1").get(itemId));
  }

  recordRestore(recordId, { actor, now = new Date() } = {}) {
    return transaction(this.db, () => {
      const record = this.getQuarantineRecord(recordId);
      if (!record || record.status !== "quarantined") throw Object.assign(new Error("Quarantine record is not restorable"), { code: "QUARANTINE_RECORD_INVALID" });
      this.db.prepare("UPDATE file_quarantine_records SET status='restored',restored_at=?,restored_by=?,updated_at=? WHERE id=?")
        .run(iso(now), bounded(actor, 100) || "operator", iso(now), recordId);
      this.db.prepare(`UPDATE file_lifecycle_items SET
        review_status='restored',quarantine_relative_path=NULL,restored_at=?,reviewed_at=?,reviewed_by=? WHERE id=?`)
        .run(iso(now), iso(now), bounded(actor, 100) || "operator", record.lifecycleItemId);
      if (record.managedFileId) this.db.prepare("UPDATE managed_files SET status='restored',updated_at=? WHERE id=?").run(iso(now), record.managedFileId);
      return this.getQuarantineRecord(recordId);
    });
  }

  listQuarantineRecords({ page = 1, pageSize = 50 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 50, 100));
    const total = Number(this.db.prepare("SELECT COUNT(*) total FROM file_quarantine_records").get().total || 0);
    const records = this.db.prepare("SELECT * FROM file_quarantine_records ORDER BY quarantined_at DESC,id DESC LIMIT ? OFFSET ?")
      .all(safePageSize, (safePage - 1) * safePageSize).map(quarantineRecord);
    return { records, total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }
}
