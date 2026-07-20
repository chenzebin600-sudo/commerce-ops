import fs from "node:fs/promises";
import path from "node:path";
import {
  FILE_ERROR_CODES,
  FilePolicyError,
  createTemporaryFilePath,
  removeFileInsideRoot,
  validateXlsxUpload,
} from "../security/file-policy.mjs";
import { redactAuditText } from "../security/audit-service.mjs";
import { validateParsedProductPackage } from "./product-package-validation.mjs";
import { parseProductPackageXlsx } from "./xlsx-parser.mjs";

function boundedError(error) {
  const code = String(error?.code || "PRODUCT_IMPORT_FAILED").slice(0, 80);
  return { code, summary: redactAuditText(error || "产品包导入失败。") };
}

export class ProductImportService {
  constructor({
    repository,
    fileService,
    fileStorageConfig,
    pythonExecutable,
    parserScript,
    maxRows = 20000,
  }) {
    this.repository = repository;
    this.fileService = fileService;
    this.fileStorageConfig = fileStorageConfig;
    this.pythonExecutable = pythonExecutable;
    this.parserScript = parserScript;
    const parsedMaxRows = Number.parseInt(maxRows, 10);
    this.maxRows = Number.isInteger(parsedMaxRows) && parsedMaxRows > 0 ? Math.min(parsedMaxRows, 200000) : 20000;
  }

  async uploadAndValidate({ filename, mimeType, buffer, operatorLabel, requestId }) {
    const validated = validateXlsxUpload({
      filename,
      mimeType,
      buffer,
      config: this.fileStorageConfig,
    });
    const existing = await this.repository.findBatchByFileHash(validated.fileHash);
    if (existing) {
      if (new Set(["preview_ready", "validation_failed", "apply_failed"]).has(existing.status)) {
        const batch = await this.revalidate(existing.id, { operatorLabel, requestId });
        return { batch, reused: true, revalidated: true, detail: await this.repository.getBatchDetail(existing.id) };
      }
      return { batch: existing, reused: true, revalidated: false, detail: await this.repository.getBatchDetail(existing.id) };
    }

    let batch;
    try {
      batch = await this.repository.createBatch({
        fileSha256: validated.fileHash,
        operatorLabel,
        requestId,
      });
    } catch (error) {
      const concurrent = await this.repository.findBatchByFileHash(validated.fileHash);
      if (concurrent) return { batch: concurrent, reused: true, detail: await this.repository.getBatchDetail(concurrent.id) };
      throw error;
    }
    let temporary = null;
    try {
      temporary = await createTemporaryFilePath(this.fileStorageConfig.tempRoot, {
        prefix: "product-package",
        extension: ".xlsx",
      });
      await fs.writeFile(temporary.path, buffer, { flag: "wx" });
      const month = new Date().toISOString().slice(0, 7);
      const persisted = await this.fileService.persistTemporaryExport({
        sourceType: "product_package_import",
        requestKey: `product-package:${validated.fileHash}`,
        originalFilename: validated.originalFilename,
        storageFilename: validated.storageFilename,
        temporaryPath: temporary.path,
        relativePath: path.posix.join("product-packages", month, validated.storageFilename),
        metadata: { batchId: batch.id },
      });
      temporary = null;
      await this.repository.attachFile({ batchId: batch.id, exportFileId: persisted.file.id });
      await this.repository.updateBatchStatus(batch.id, "validating");
      const verified = await this.fileService.verifyAvailableFile(persisted.file.id);
      const parsed = await parseProductPackageXlsx({
        pythonExecutable: this.pythonExecutable,
        parserScript: this.parserScript,
        filename: verified.target.path,
        maxRows: this.maxRows,
      });
      const preliminarySkus = parsed.rows.map((row) => row.rawPayload?.SKU).filter(Boolean).map((value) => String(value).trim().toUpperCase());
      const existingRowHashes = await this.repository.existingRowHashes(preliminarySkus);
      const validation = validateParsedProductPackage(parsed, { existingRowHashes });
      batch = await this.repository.replaceValidation(batch.id, validation);
      return { batch, reused: false, detail: await this.repository.getBatchDetail(batch.id) };
    } catch (error) {
      if (temporary?.path) await removeFileInsideRoot(this.fileStorageConfig.tempRoot, temporary.path);
      const safe = boundedError(error);
      await this.repository.updateBatchStatus(batch.id, "validation_failed", { errorCode: safe.code, errorSummary: safe.summary }).catch(() => {});
      throw error;
    }
  }

  async revalidate(batchId, { operatorLabel, requestId } = {}) {
    const batch = await this.repository.getBatch(batchId);
    if (!batch) throw Object.assign(new Error("导入批次不存在。"), { code: "PRODUCT_IMPORT_NOT_FOUND", status: 404 });
    if (!new Set(["preview_ready", "validation_failed", "apply_failed"]).has(batch.status)) {
      throw Object.assign(new Error("当前批次不能重新校验。"), { code: "PRODUCT_IMPORT_STATE_INVALID", status: 409 });
    }
    const source = await this.repository.getBatchFile(batchId);
    if (!source) throw Object.assign(new Error("产品包源文件记录不存在。"), { code: "PRODUCT_IMPORT_SOURCE_FILE_MISSING", status: 409 });
    try {
      await this.repository.updateBatchStatus(batchId, "validating");
      const verified = await this.fileService.verifyAvailableFile(source.exportFileId);
      const parsed = await parseProductPackageXlsx({
        pythonExecutable: this.pythonExecutable,
        parserScript: this.parserScript,
        filename: verified.target.path,
        maxRows: this.maxRows,
      });
      const sourceSkus = parsed.rows
        .map((row) => row.rawPayload?.SKU)
        .filter(Boolean)
        .map((value) => String(value).trim().toUpperCase());
      const existingRowHashes = await this.repository.existingRowHashes(sourceSkus);
      const validation = validateParsedProductPackage(parsed, { existingRowHashes });
      return this.repository.replaceValidation(batchId, validation);
    } catch (error) {
      const safe = boundedError(error);
      await this.repository.updateBatchStatus(batchId, "validation_failed", {
        errorCode: safe.code,
        errorSummary: safe.summary,
      }).catch(() => {});
      throw error;
    }
  }

  async apply(batchId, { operatorLabel, requestId, acknowledgeWarnings = false, acknowledgeUnknownFields = false } = {}) {
    const batch = await this.repository.getBatch(batchId);
    if (!batch) throw Object.assign(new Error("导入批次不存在。"), { code: "PRODUCT_IMPORT_NOT_FOUND", status: 404 });
    if (batch.blockerCount > 0) {
      throw Object.assign(new Error("导入批次存在阻断问题，不能正式入库。"), {
        code: "PRODUCT_IMPORT_BLOCKED",
        status: 409,
      });
    }
    if (batch.reminderCount > 0 && !acknowledgeWarnings) {
      throw Object.assign(new Error("请先确认提醒项，再执行正式入库。"), { code: "PRODUCT_IMPORT_WARNINGS_NOT_ACKNOWLEDGED", status: 409 });
    }
    if (batch.unknownFields.length > 0 && !acknowledgeUnknownFields) {
      throw Object.assign(new Error("请先确认未知字段，再执行正式入库。"), { code: "PRODUCT_IMPORT_UNKNOWN_FIELDS_NOT_ACKNOWLEDGED", status: 409 });
    }
    try {
      return await this.repository.applyBatch(batchId, { operatorLabel, requestId });
    } catch (error) {
      if (!new Set(["PRODUCT_IMPORT_BLOCKED", "PRODUCT_IMPORT_STATE_INVALID", "PRODUCT_IMPORT_NOT_FOUND"]).has(error?.code)) {
        const safe = boundedError(error);
        await this.repository.updateBatchStatus(batchId, "apply_failed", { errorCode: safe.code, errorSummary: safe.summary }).catch(() => {});
      }
      throw error;
    }
  }

  list(options) {
    return this.repository.listBatches(options);
  }

  detail(id) {
    return this.repository.getBatchDetail(id);
  }

  rows(id, options) {
    return this.repository.listRows(id, options);
  }

  issues(id, options) {
    return this.repository.listIssues(id, options);
  }
}

export async function readProductPackageUpload(req, { maxBytes }) {
  const contentLength = Number(req.headers?.["content-length"] || 0);
  if (contentLength > maxBytes) throw new FilePolicyError(FILE_ERROR_CODES.FILE_TOO_LARGE);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new FilePolicyError(FILE_ERROR_CODES.FILE_TOO_LARGE);
    chunks.push(chunk);
  }
  const rawFilename = String(req.headers?.["x-file-name"] || "");
  let filename;
  try { filename = decodeURIComponent(rawFilename); } catch { filename = rawFilename; }
  return {
    filename: filename || "product-package.xlsx",
    mimeType: String(req.headers?.["content-type"] || "application/octet-stream").split(";", 1)[0],
    buffer: Buffer.concat(chunks),
  };
}
