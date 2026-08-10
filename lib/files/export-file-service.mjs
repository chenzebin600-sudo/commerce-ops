import path from "node:path";
import {
  FILE_ERROR_CODES,
  FilePolicyError,
  XLSX_MIME,
  hashFileBuffer,
  validateDownloadMetadata,
  validateFileId,
} from "../security/file-policy.mjs";
import { LocalStorageProvider } from "../storage/local-storage-provider.mjs";
import { createExportFileRepository } from "./file-repository.mjs";

async function auditFile(audit, action, file, extra = {}) {
  await audit?.recordSafely({
    module: "file",
    action,
    actorType: extra.actorType || "application",
    status: extra.status || "success",
    taskId: file?.taskId || null,
    runId: file?.runId || null,
    fileId: file?.id || null,
    errorCode: extra.errorCode || null,
    errorSummary: extra.errorSummary || null,
    metadata: {
      sourceType: file?.sourceType || extra.sourceType,
      fileSize: file?.fileSize,
      result: extra.result,
    },
  });
}

function unavailableError(file) {
  if (file?.status === "missing") return new FilePolicyError(FILE_ERROR_CODES.FILE_MISSING);
  if (file?.status === "integrity_failed") return new FilePolicyError(FILE_ERROR_CODES.FILE_INTEGRITY_FAILED);
  return new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_AVAILABLE);
}

export function toPublicExportFile(file) {
  if (!file) return null;
  return {
    id: file.id,
    fileType: file.fileType,
    sourceType: file.sourceType,
    taskId: file.taskId,
    runId: file.runId,
    originalFilename: file.originalFilename,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    status: file.status,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    expiresAt: file.expiresAt,
    missingAt: file.missingAt,
    metadata: file.metadata,
  };
}

export class ExportFileService {
  constructor({ db, exportRoot, tempRoot, audit = null, repository = null, exportStorage = null, tempStorage = null }) {
    this.repository = repository || createExportFileRepository(db);
    this.exportRoot = exportRoot;
    this.tempRoot = tempRoot;
    this.exportStorage = exportStorage || new LocalStorageProvider({ rootDir: exportRoot });
    this.tempStorage = tempStorage || new LocalStorageProvider({ rootDir: tempRoot });
    this.audit = audit;
  }

  temporaryKey(filePath) {
    const relative = path.relative(this.tempRoot, path.resolve(filePath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
    }
    return relative.replaceAll("\\", "/");
  }

  async getFile(id) {
    return this.repository.get(validateFileId(id));
  }

  async getByRequestKey(requestKey) {
    return this.repository.getByRequestKey(requestKey);
  }

  async persistTemporaryExport(input) {
    const existing = input.requestKey ? await this.repository.getByRequestKey(input.requestKey) : null;
    if (existing) {
      if (input.temporaryPath) await this.tempStorage.remove(this.temporaryKey(input.temporaryPath));
      return { file: existing, reused: true };
    }

    let movedFile = null;
    const pending = {
      id: input.id,
      sourceType: input.sourceType,
      taskId: input.taskId || null,
      runId: input.runId || null,
    };
    try {
      movedFile = await this.tempStorage.moveTo(
        this.temporaryKey(input.temporaryPath),
        this.exportStorage,
        input.relativePath,
        { allowedExtensions: [".xlsx"] },
      );
      const content = await this.exportStorage.get(input.relativePath);
      const file = await this.repository.create({
        ...input,
        fileType: "excel",
        mimeType: XLSX_MIME,
        storageFilename: input.storageFilename || path.basename(input.relativePath),
        fileSize: content.length,
        fileHash: hashFileBuffer(content),
        status: "available",
      });
      await auditFile(this.audit, input.sourceType === "product_package_import" ? "file.upload" : "file.export.created", file);
      return { file, reused: false };
    } catch (error) {
      if (movedFile?.storageKey) await this.exportStorage.remove(movedFile.storageKey);
      if (input.requestKey) {
        try {
          const concurrent = await this.repository.getByRequestKey(input.requestKey);
          if (concurrent) {
            if (input.temporaryPath) await this.tempStorage.remove(this.temporaryKey(input.temporaryPath));
            return { file: concurrent, reused: true };
          }
        } catch {
          // The original persistence error remains the useful failure.
        }
      }
      await auditFile(this.audit, input.sourceType === "product_package_import" ? "file.upload.rejected" : "file.export.failed", pending, {
        status: "failed",
        sourceType: input.sourceType,
        errorCode: error?.code || "FILE_METADATA_WRITE_FAILED",
        errorSummary: "Export file persistence failed",
      });
      throw error;
    }
  }

  async markMissing(file) {
    const updated = await this.repository.updateStatus(file.id, "missing", { missingAt: new Date() });
    await auditFile(this.audit, "file.download.failed", updated, {
      status: "failed",
      errorCode: FILE_ERROR_CODES.FILE_MISSING,
      errorSummary: "Export file is missing",
    });
    return updated;
  }

  async markIntegrityFailed(file, code = FILE_ERROR_CODES.FILE_INTEGRITY_FAILED) {
    const updated = await this.repository.updateStatus(file.id, "integrity_failed");
    await auditFile(this.audit, "file.integrity_failed", updated, {
      status: "failed",
      errorCode: code,
      errorSummary: "Export file integrity validation failed",
    });
    return updated;
  }

  async verifyAvailableFile(id, { readContent = false } = {}) {
    const stored = await this.getFile(id);
    if (!stored) throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_FOUND);
    if (stored.status !== "available") throw unavailableError(stored);
    const file = validateDownloadMetadata(stored);

    let target;
    try {
      target = await this.exportStorage.resolveExisting(file.relativePath, { allowedExtensions: [".xlsx"] });
    } catch (error) {
      if (error instanceof FilePolicyError && error.code === FILE_ERROR_CODES.FILE_NOT_FOUND) {
        await this.markMissing(file);
        throw new FilePolicyError(FILE_ERROR_CODES.FILE_MISSING);
      }
      throw error;
    }
    if (target.stat.size <= 0 || target.stat.size !== Number(file.fileSize || 0)) {
      await this.markIntegrityFailed(file, "FILE_SIZE_MISMATCH");
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_INTEGRITY_FAILED);
    }
    if (!readContent) return { file, target, content: null };

    const content = await this.exportStorage.get(file.relativePath);
    const actualHash = hashFileBuffer(content);
    if (!file.fileHash || actualHash.toLowerCase() !== String(file.fileHash).toLowerCase()) {
      await this.markIntegrityFailed(file, "FILE_HASH_MISMATCH");
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_INTEGRITY_FAILED);
    }
    return { file, target, content };
  }

  async listFiles(filters = {}) {
    const result = await this.repository.list(filters);
    const checked = [];
    for (const file of result.files) {
      if (file.status !== "available") {
        checked.push(file);
        continue;
      }
      try {
        const verified = await this.verifyAvailableFile(file.id);
        checked.push(verified.file);
      } catch (error) {
        if ([FILE_ERROR_CODES.FILE_MISSING, FILE_ERROR_CODES.FILE_INTEGRITY_FAILED].includes(error?.code)) {
          checked.push(await this.repository.get(file.id));
        } else {
          throw error;
        }
      }
    }
    return { ...result, files: checked };
  }

  async download(id) {
    return this.verifyAvailableFile(id, { readContent: true });
  }
}

export function createExportFileService(options) {
  return new ExportFileService(options);
}
