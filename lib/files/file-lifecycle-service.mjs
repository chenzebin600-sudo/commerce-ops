import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createTemporaryFilePath,
  removeFileInsideRoot,
  sanitizeFilename,
} from "../security/file-policy.mjs";
import { normalizedSanitizationCounts } from "../security/excel-cell-policy.mjs";
import { LIFECYCLE_SCOPE_NAMES } from "./file-lifecycle-policy.mjs";

const ALLOWED_SCOPES = new Set(LIFECYCLE_SCOPE_NAMES);

function safeScopes(input) {
  const requested = input == null || input === "all" ? [...ALLOWED_SCOPES] : input;
  if (!Array.isArray(requested)) throw new Error("Lifecycle scopes must be an array");
  const scopes = [...new Set(requested.map((scope) => String(scope || "").trim()).filter(Boolean))];
  if (!scopes.length || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new Error("Unsupported lifecycle scan scope");
  }
  return scopes;
}

function auditScan(audit, action, scan, extra = {}) {
  audit?.recordSafely({
    module: "file",
    action,
    actorType: "application",
    status: extra.status || "success",
    errorCode: extra.errorCode || null,
    errorSummary: extra.errorSummary || null,
    metadata: {
      scanId: scan?.id,
      scanScopeCount: scan?.scopes?.length,
      fileCount: scan?.totalFiles,
      categoryCount: Object.keys(scan?.summary || {}).length,
      result: extra.result,
    },
  });
}

function reportRecord(item) {
  return {
    classification: item.classification,
    categories: item.categories.join(", "),
    scope: item.scope,
    source_type: item.sourceType || "",
    file_id: item.fileId || "",
    task_id: item.taskId || "",
    run_id: item.runId || "",
    filename: item.maskedFilename,
    file_size: item.fileSize,
    created_at: item.fileCreatedAt || "",
    modified_at: item.fileModifiedAt || "",
    database_status: item.databaseStatus || "",
    physical_status: item.physicalStatus,
    suggest_quarantine: item.suggestQuarantine ? "yes" : "no",
    suggest_cleanup: item.suggestCleanup ? "yes" : "no",
    reason_code: item.reasonCode,
    short_hash: item.shortHash || "",
    detected_file_type: item.detectedFileType || "",
    review_status: item.reviewStatus || "pending_review",
    managed_file_id: item.managedFileId || "",
  };
}

export class FileLifecycleService {
  constructor({ repository, scanner, audit = null, fileService = null, tempRoot = null, runWorker = null, policy = null, now = () => new Date() }) {
    this.repository = repository;
    this.scanner = scanner;
    this.audit = audit;
    this.fileService = fileService;
    this.tempRoot = tempRoot;
    this.runWorker = runWorker;
    this.policy = policy;
    this.now = now;
    this.runningPromise = null;
  }

  startScan(requestedScopes = "all") {
    const scopes = safeScopes(requestedScopes);
    if (this.runningPromise) {
      const running = this.repository.getRunningScan();
      return { scan: running, reused: true };
    }
    const existing = this.repository.getRunningScan();
    if (existing) return { scan: existing, reused: true };
    const scan = this.repository.createScan(scopes, this.now());
    auditScan(this.audit, "file.lifecycle.scan.started", scan, { result: "running" });
    this.runningPromise = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        try {
          const report = await this.scanner.scan(scopes);
          const completed = this.repository.completeScan(scan.id, report, this.now());
          auditScan(this.audit, "file.lifecycle.scan.completed", completed, { result: report.truncated ? "truncated" : "complete" });
          return completed;
        } catch (error) {
          const failed = this.repository.failScan(scan.id, error?.code || "LIFECYCLE_SCAN_FAILED", this.now());
          auditScan(this.audit, "file.lifecycle.scan.failed", failed, {
            status: "failed",
            errorCode: error?.code || "LIFECYCLE_SCAN_FAILED",
            errorSummary: "File lifecycle scan failed",
          });
          return failed;
        }
      })
      .finally(() => { this.runningPromise = null; });
    return { scan, reused: false };
  }

  async waitForIdle() {
    if (this.runningPromise) await this.runningPromise;
  }

  listReports(filters) {
    return this.repository.listScans(filters);
  }

  getReport(id, itemFilters = {}) {
    const scan = this.repository.getScan(id);
    if (!scan) return null;
    return { scan, ...this.repository.listItems(id, itemFilters) };
  }

  summary() {
    return this.repository.latestSummary();
  }

  async exportReport(scanId) {
    if (!this.fileService || !this.runWorker || !this.tempRoot) throw new Error("Lifecycle report export is unavailable");
    const scan = this.repository.getScan(scanId);
    if (!scan || scan.status !== "completed") throw new Error("Lifecycle scan report is not ready");
    if (scan.reportFileId) {
      const existing = this.fileService.getFile(scan.reportFileId);
      if (existing?.status === "available") return existing;
    }
    const requestKey = `lifecycle_report:${scan.id}`;
    const existing = this.fileService.getByRequestKey(requestKey);
    if (existing) {
      this.repository.attachReport(scan.id, existing.id, this.now());
      return existing;
    }
    const fileId = randomUUID();
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const filename = sanitizeFilename(`file-lifecycle-${stamp}.xlsx`, { fallback: "file-lifecycle-report.xlsx" });
    const relativePath = `lifecycle/${stamp.slice(0, 7)}/${fileId}.xlsx`;
    const temporary = await createTemporaryFilePath(this.tempRoot, { prefix: `lifecycle-${fileId}`, extension: ".xlsx" });
    try {
      const columns = [
        "classification", "categories", "scope", "source_type", "file_id", "task_id", "run_id", "filename",
        "file_size", "created_at", "modified_at", "database_status", "physical_status", "suggest_quarantine",
        "suggest_cleanup", "reason_code", "short_hash",
        "detected_file_type", "review_status", "managed_file_id",
      ];
      const records = this.repository.allItems(scan.id).map(reportRecord);
      const result = await this.runWorker({
        action: "write-xlsx",
        outputPath: temporary.path,
        kind: "lifecycle",
        columns,
        records,
        metadataSheetName: "Scan information",
        summary: { scanId: scan.id, exportedRows: records.length, sourceRows: records.length },
      }, 3 * 60 * 1000);
      const sanitizationCounts = normalizedSanitizationCounts(result.sanitizedCells);
      const { file } = await this.fileService.persistTemporaryExport({
        id: fileId,
        requestKey,
        temporaryPath: temporary.path,
        sourceType: "system_file_lifecycle_report",
        originalFilename: filename,
        storageFilename: path.basename(relativePath),
        relativePath,
        expiresAt: new Date(this.now().getTime() + this.policy.reportMs),
        metadata: {
          scanId: scan.id,
          exportedRows: records.length,
          classificationCount: Object.keys(scan.summary || {}).length,
          generatedBy: "lifecycle_scanner",
          sanitizedCellCount: sanitizationCounts.reduce((total, item) => total + item.count, 0),
        },
      });
      this.repository.attachReport(scan.id, file.id, this.now());
      return file;
    } catch (error) {
      await removeFileInsideRoot(this.tempRoot, temporary.path);
      throw error;
    }
  }
}
