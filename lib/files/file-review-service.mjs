import crypto, { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeStoredRelativePath } from "../security/file-policy.mjs";
import { LocalStorageProvider } from "../storage/local-storage-provider.mjs";
import {
  classifyAdvertisingScanItems,
  inspectManagedFileSignature,
  isFormalAdvertisingType,
} from "./advertising-file-classifier.mjs";
import { hashFileStream } from "./file-lifecycle-scanner.mjs";

const FORMAL_EXTENSIONS = Object.freeze({
  advertising_source: [".xlsx"],
  advertising_output: [".json"],
  advertising_report: [".json", ".xlsx"],
});

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeActor(value) {
  return String(value || "operator").replace(/[^a-z0-9_.@-]/gi, "_").slice(0, 100) || "operator";
}

function stableUuid(input) {
  const bytes = crypto.createHash("sha256").update(`commerce-ops-managed-file-v1\0${input}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function publicRecord(record) {
  return {
    id: record.id,
    lifecycleItemId: record.lifecycleItemId,
    managedFileId: record.managedFileId,
    rootKey: record.rootKey,
    fileSize: record.fileSize,
    status: record.status,
    quarantinedAt: record.quarantinedAt,
    quarantinedBy: record.quarantinedBy,
    quarantineReason: record.quarantineReason,
    restoredAt: record.restoredAt,
    restoredBy: record.restoredBy,
  };
}

async function reviewAudit(audit, action, item, { status = "success", errorCode = null, result = null, fileId = null } = {}) {
  await audit?.recordSafely({
    module: "file",
    action,
    actorType: "authenticated_session",
    status,
    fileId: fileId || item?.managedFileId || null,
    errorCode,
    errorSummary: status === "failed" ? "Managed file operation failed" : null,
    metadata: {
      sourceType: item?.detectedFileType || null,
      result,
    },
  });
}

export function resolveFileReviewPolicy(env = process.env) {
  const retentionDays = Number(env.FILE_QUARANTINE_RETENTION_DAYS || 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("FILE_QUARANTINE_RETENTION_DAYS must be between 1 and 3650");
  }
  const deletionSetting = String(env.FILE_DELETION_ENABLED || "false").trim().toLowerCase();
  if (!new Set(["", "false", "0", "no"]).has(deletionSetting)) {
    throw new Error("FILE_DELETION_ENABLED must remain false in this release");
  }
  return Object.freeze({ retentionDays, deletionEnabled: false });
}

export class FileReviewService {
  constructor({ repository, lifecycleRepository, roots, storageRoot, quarantineRoot, audit = null, policy = resolveFileReviewPolicy(), now = () => new Date() }) {
    this.repository = repository;
    this.lifecycleRepository = lifecycleRepository;
    this.roots = roots;
    this.rootMap = new Map(roots.map((entry) => [entry.scope, path.resolve(entry.root)]));
    this.rootStorage = new Map(roots.map((entry) => [entry.scope, new LocalStorageProvider({ rootDir: entry.root })]));
    this.storageRoot = path.resolve(storageRoot);
    this.quarantineRoot = path.resolve(quarantineRoot);
    if (!inside(this.storageRoot, this.quarantineRoot)) throw new Error("Quarantine root must stay inside STORAGE_ROOT");
    this.quarantineStorage = new LocalStorageProvider({ rootDir: this.quarantineRoot });
    this.audit = audit;
    this.policy = policy;
    this.now = now;
  }

  async ensureQuarantineRoot() {
    try {
      await this.quarantineStorage.ensureRoot();
    } catch (error) {
      throw Object.assign(new Error("Quarantine root is invalid", { cause: error }), { code: "QUARANTINE_ROOT_INVALID" });
    }
  }

  async classifyScan(scanId) {
    const scan = await this.lifecycleRepository.getScan(scanId);
    if (!scan || scan.status !== "completed") throw Object.assign(new Error("Lifecycle scan is not ready"), { code: "LIFECYCLE_SCAN_NOT_READY" });
    const result = await classifyAdvertisingScanItems({ scanItems: await this.repository.scanItems(scanId), roots: this.roots });
    for (const evidence of result.evidence) await this.repository.saveEvidence(evidence.lifecycleItemId, evidence);
    return {
      matchedCount: result.matchedCount,
      unmatchedItemCount: result.unmatchedItemCount,
      summary: result.evidence.reduce((summary, item) => {
        summary[item.detectedFileType] = (summary[item.detectedFileType] || 0) + 1;
        return summary;
      }, {}),
      evidence: result.evidence,
    };
  }

  async revalidateItem(item) {
    const storage = this.rootStorage.get(item.rootKey);
    if (!storage || !item.relativePath || !item.fileHash) throw Object.assign(new Error("File classification evidence is incomplete"), { code: "CLASSIFICATION_EVIDENCE_MISSING" });
    const extensions = FORMAL_EXTENSIONS[item.detectedFileType];
    if (!extensions) throw Object.assign(new Error("File type cannot be registered"), { code: "FILE_TYPE_NOT_REGISTERABLE" });
    const resolved = await storage.resolveExisting(normalizeStoredRelativePath(item.relativePath), { allowedExtensions: extensions });
    if (Number(resolved.stat.size) !== Number(item.fileSize)) throw Object.assign(new Error("File size changed after classification"), { code: "FILE_SIZE_CHANGED" });
    const hash = await hashFileStream(resolved.path);
    if (hash !== item.fileHash) throw Object.assign(new Error("File hash changed after classification"), { code: "FILE_HASH_CHANGED" });
    const signature = await inspectManagedFileSignature(resolved.path, path.extname(resolved.relativePath).toLowerCase());
    if (signature !== item.signatureCode || signature === "unknown") throw Object.assign(new Error("File signature changed after classification"), { code: "FILE_SIGNATURE_CHANGED" });
    return { resolved, hash, signature };
  }

  async registerItem(itemId, { actor = "operator", reason = "confirmed_formal_advertising_file" } = {}) {
    let item = await this.repository.getItem(itemId);
    if (!item) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
    if (item.reviewStatus === "registered") return this.repository.getManagedFileByItem(itemId);
    if (!isFormalAdvertisingType(item.detectedFileType)) throw Object.assign(new Error("Only verified formal advertising files can be registered"), { code: "FILE_TYPE_NOT_REGISTERABLE" });
    if (!["pending_review", "approved_for_registration"].includes(item.reviewStatus)) {
      throw Object.assign(new Error("Lifecycle item cannot be registered in its current state"), { code: "REVIEW_STATE_INVALID" });
    }
    const safe = safeActor(actor);
    if (item.reviewStatus === "pending_review") {
      item = await this.repository.setReviewStatus(itemId, "approved_for_registration", { actor: safe, reason, now: this.now() });
      await reviewAudit(this.audit, "file.review.approved", item, { result: "registration" });
    }
    try {
      await this.revalidateItem(item);
      const id = stableUuid([item.rootKey, item.relativePath, item.jobId || "", item.fileHash].join("\0"));
      const result = await this.repository.registerManagedFile(itemId, {
        id,
        rootKey: item.rootKey,
        relativePath: item.relativePath,
        sourceType: item.detectedFileType,
        jobId: item.jobId,
        mimeType: item.mimeType,
        fileSize: item.fileSize,
        fileHash: item.fileHash,
        fileCreatedAt: item.fileCreatedAt,
        metadata: {
          classificationEvidence: item.detectionReasonCode,
          duplicateContent: item.categories.includes("duplicate_content"),
          generatedBy: "reviewed_file_registration",
        },
        actor: safe,
        reason,
      }, this.now());
      await reviewAudit(this.audit, "file.metadata.registered", item, { result: result.created ? "created" : "idempotent", fileId: result.file.id });
      return result.file;
    } catch (error) {
      await reviewAudit(this.audit, "file.metadata.registration_failed", item, { status: "failed", errorCode: error?.code || "FILE_REGISTRATION_FAILED", result: "rejected" });
      throw error;
    }
  }

  async protectItem(itemId, { actor = "operator", reason = "manual_protection" } = {}) {
    const item = await this.repository.getItem(itemId);
    if (!item) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
    if (["registered", "quarantined"].includes(item.reviewStatus)) throw Object.assign(new Error("Lifecycle item cannot be protected in its current state"), { code: "REVIEW_STATE_INVALID" });
    const updated = await this.repository.setReviewStatus(itemId, "protected", { actor: safeActor(actor), reason, now: this.now() });
    await reviewAudit(this.audit, "file.protected", updated, { result: "protected" });
    return updated;
  }

  async rejectItem(itemId, { actor = "operator", reason = "manual_rejection" } = {}) {
    const item = await this.repository.getItem(itemId);
    if (!item || ["registered", "protected", "quarantined"].includes(item.reviewStatus)) {
      throw Object.assign(new Error("Lifecycle item cannot be rejected"), { code: "REVIEW_STATE_INVALID" });
    }
    const updated = await this.repository.setReviewStatus(itemId, "rejected", { actor: safeActor(actor), reason, now: this.now() });
    await reviewAudit(this.audit, "file.review.rejected", updated, { result: "rejected" });
    return updated;
  }

  async approveQuarantine(itemId, { actor = "operator", reason = "confirmed_test_cleanup_candidate" } = {}) {
    const item = await this.repository.getItem(itemId);
    if (!item) throw Object.assign(new Error("Lifecycle item was not found"), { code: "LIFECYCLE_ITEM_NOT_FOUND" });
    const eligible = item.detectedFileType === "advertising_temp" || item.categories.some((value) => ["temp_stale", "expired_candidate"].includes(value));
    const historicalUnmanagedFile = Boolean(item.fileId && !item.managedFileId);
    if (!eligible || item.reviewStatus === "protected" || historicalUnmanagedFile) {
      throw Object.assign(new Error("Lifecycle item is not eligible for quarantine"), { code: "QUARANTINE_NOT_ELIGIBLE" });
    }
    const updated = await this.repository.setReviewStatus(itemId, "approved_for_quarantine", { actor: safeActor(actor), reason, now: this.now() });
    await reviewAudit(this.audit, "file.review.approved", updated, { result: "quarantine" });
    return updated;
  }

  async quarantineItem(itemId, { actor = "operator", reason = "confirmed_test_cleanup_candidate" } = {}) {
    const item = await this.repository.getItem(itemId);
    const safe = safeActor(actor);
    let destination = null;
    let source = null;
    try {
      if (!item || item.reviewStatus !== "approved_for_quarantine") throw Object.assign(new Error("Quarantine requires explicit approval"), { code: "QUARANTINE_NOT_APPROVED" });
      const storage = this.rootStorage.get(item.rootKey);
      if (!storage || !item.relativePath || !item.fileHash) throw Object.assign(new Error("File evidence is incomplete"), { code: "CLASSIFICATION_EVIDENCE_MISSING" });
      const extension = path.extname(item.relativePath).toLowerCase() || ".tmp";
      source = await storage.resolveExisting(item.relativePath, { allowedExtensions: [extension] });
      const beforeHash = await hashFileStream(source.path);
      if (beforeHash !== item.fileHash || Number(source.stat.size) !== item.fileSize) throw Object.assign(new Error("File changed before quarantine"), { code: "FILE_INTEGRITY_CHANGED" });
      await this.ensureQuarantineRoot();
      if (!(await storage.sameFilesystemAs(this.quarantineStorage))) throw Object.assign(new Error("Quarantine requires the same filesystem"), { code: "QUARANTINE_CROSS_DEVICE" });
      const recordId = randomUUID();
      const quarantineRelativePath = normalizeStoredRelativePath(`${item.rootKey}/${item.id}/${recordId}${extension}`);
      destination = await storage.moveTo(item.relativePath, this.quarantineStorage, quarantineRelativePath, { allowedExtensions: [extension] });
      const afterHash = await hashFileStream(destination.path);
      if (afterHash !== beforeHash) {
        await this.quarantineStorage.moveTo(quarantineRelativePath, storage, item.relativePath, { allowedExtensions: [extension] });
        destination = null;
        throw Object.assign(new Error("Quarantine hash verification failed"), { code: "QUARANTINE_HASH_MISMATCH" });
      }
      let record;
      try {
        record = await this.repository.recordQuarantine(itemId, {
          id: recordId,
          rootKey: item.rootKey,
          originalRelativePath: item.relativePath,
          quarantineRelativePath,
          fileSize: item.fileSize,
          fileHash: beforeHash,
          actor: safe,
          reason,
        }, this.now());
      } catch (error) {
        await this.quarantineStorage.moveTo(quarantineRelativePath, storage, item.relativePath, { allowedExtensions: [extension] });
        destination = null;
        throw error;
      }
      await reviewAudit(this.audit, "file.quarantine", item, { result: "quarantined" });
      return publicRecord(record);
    } catch (error) {
      await reviewAudit(this.audit, "file.quarantine.failed", item, { status: "failed", errorCode: error?.code || "FILE_QUARANTINE_FAILED", result: "rejected" });
      throw error;
    }
  }

  async restoreItem(itemId, { actor = "operator" } = {}) {
    const item = await this.repository.getItem(itemId);
    const safe = safeActor(actor);
    let source = null;
    let destination = null;
    try {
      if (!item || item.reviewStatus !== "quarantined") throw Object.assign(new Error("Lifecycle item is not quarantined"), { code: "QUARANTINE_RECORD_INVALID" });
      const record = await this.repository.getActiveQuarantineByItem(itemId);
      if (!record) throw Object.assign(new Error("Quarantine record was not found"), { code: "QUARANTINE_RECORD_INVALID" });
      const storage = this.rootStorage.get(record.rootKey);
      if (!storage) throw Object.assign(new Error("Managed root is unavailable"), { code: "MANAGED_ROOT_INVALID" });
      const extension = path.extname(record.originalRelativePath).toLowerCase() || ".tmp";
      source = await this.quarantineStorage.resolveExisting(record.quarantineRelativePath, { allowedExtensions: [extension] });
      const sourceHash = await hashFileStream(source.path);
      if (sourceHash !== record.fileHash || Number(source.stat.size) !== record.fileSize) throw Object.assign(new Error("Quarantined file failed integrity validation"), { code: "QUARANTINE_HASH_MISMATCH" });
      if (!(await this.quarantineStorage.sameFilesystemAs(storage))) throw Object.assign(new Error("Restore requires the same filesystem"), { code: "QUARANTINE_CROSS_DEVICE" });
      destination = await this.quarantineStorage.moveTo(record.quarantineRelativePath, storage, record.originalRelativePath, { allowedExtensions: [extension] });
      const restoredHash = await hashFileStream(destination.path);
      if (restoredHash !== record.fileHash) {
        await storage.moveTo(record.originalRelativePath, this.quarantineStorage, record.quarantineRelativePath, { allowedExtensions: [extension] });
        destination = null;
        throw Object.assign(new Error("Restored file hash verification failed"), { code: "RESTORE_HASH_MISMATCH" });
      }
      let updated;
      try {
        updated = await this.repository.recordRestore(record.id, { actor: safe, now: this.now() });
      } catch (error) {
        await storage.moveTo(record.originalRelativePath, this.quarantineStorage, record.quarantineRelativePath, { allowedExtensions: [extension] });
        destination = null;
        throw error;
      }
      await reviewAudit(this.audit, "file.restore", item, { result: "restored" });
      return publicRecord(updated);
    } catch (error) {
      await reviewAudit(this.audit, "file.restore.failed", item, { status: "failed", errorCode: error?.code || "FILE_RESTORE_FAILED", result: "rejected" });
      throw error;
    }
  }

  async listQuarantineRecords(filters) {
    const result = await this.repository.listQuarantineRecords(filters);
    return { ...result, records: result.records.map(publicRecord) };
  }

  async rejectPermanentDeletion(itemId) {
    const item = await this.repository.getItem(itemId);
    await reviewAudit(this.audit, "file.delete.rejected", item, { status: "failed", errorCode: "FILE_DELETION_DISABLED", result: "disabled" });
    throw Object.assign(new Error("Permanent file deletion is disabled"), { code: "FILE_DELETION_DISABLED" });
  }
}

export { stableUuid as stableManagedFileUuid };
