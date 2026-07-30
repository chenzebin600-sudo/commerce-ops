import { createHash } from "node:crypto";
import path from "node:path";
import {
  createTemporaryFilePath,
  removeFileInsideRoot,
} from "../security/file-policy.mjs";

const SOURCE_TYPES = Object.freeze({
  orders: "mabang_order",
  inventory: "mabang_inventory",
});
const FINGERPRINT_SCOPE_KEYS = Object.freeze([
  "platform",
  "countryCode",
  "queryType",
  "dateFrom",
  "dateTo",
  "snapshotAt",
  "shopScope",
  "countryScope",
  "warehouseScope",
]);

function normalizedKind(value) {
  const kind = String(value || "");
  if (!Object.hasOwn(SOURCE_TYPES, kind)) {
    throw new TypeError("Mabang data persistence kind must be orders or inventory");
  }
  return kind;
}

function observationTimestamp(kind, sourceScope, collectedAt) {
  if (kind !== "inventory") return null;
  return sourceScope?.snapshotAt || collectedAt || null;
}

export function mabangCollectionFingerprint({ kind: rawKind, columns = [], records = [], sourceScope = {}, collectedAt = null }) {
  const kind = normalizedKind(rawKind);
  const fingerprintScope = Object.fromEntries(
    FINGERPRINT_SCOPE_KEYS
      .filter((key) => sourceScope?.[key] !== undefined)
      .map((key) => [key, sourceScope[key]]),
  );
  const payload = {
    version: "mabang_collected_rows_v1",
    kind,
    columns,
    records,
    sourceScope: fingerprintScope,
  };
  if (kind === "inventory") payload.observedAt = observationTimestamp(kind, sourceScope, collectedAt);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function publicResult(sourceType, preview, applied) {
  return Object.freeze({
    status: applied.reused ? "reused" : "applied",
    sourceType,
    batchId: applied.batch.id,
    rowCount: Number(applied.batch.rowCount || preview.rowCount || 0),
    createdCount: Number(applied.applicationResult?.createdCount || 0),
    updatedCount: Number(applied.applicationResult?.updatedCount || 0),
    ignoredCount: Number(applied.applicationResult?.ignoredCount || 0),
    reused: Boolean(applied.reused),
  });
}

export class MabangDataPersistenceService {
  constructor({
    growthRadarService,
    runWorker,
    tempRoot,
    now = () => new Date(),
  }) {
    if (!growthRadarService) throw new TypeError("growthRadarService is required");
    if (typeof runWorker !== "function") throw new TypeError("runWorker is required");
    if (!tempRoot) throw new TypeError("tempRoot is required");
    this.growthRadarService = growthRadarService;
    this.runWorker = runWorker;
    this.tempRoot = path.resolve(tempRoot);
    this.now = now;
  }

  async persistCollected({
    kind: rawKind,
    columns = [],
    records = [],
    summary = {},
    collectedAt = null,
    sourceAccountId = null,
    sourceScope = {},
    sourceFilename = null,
    actorLabel = "mabang_collector",
  }) {
    const kind = normalizedKind(rawKind);
    if (!Array.isArray(columns) || !Array.isArray(records)) {
      throw new TypeError("Mabang collected columns and records must be arrays");
    }
    if (!records.length) {
      return Object.freeze({
        status: "empty",
        sourceType: SOURCE_TYPES[kind],
        batchId: null,
        rowCount: 0,
        createdCount: 0,
        updatedCount: 0,
        ignoredCount: 0,
        reused: false,
      });
    }

    const capturedAt = collectedAt || this.now().toISOString();
    const sourceIdempotencyKey = mabangCollectionFingerprint({
      kind,
      columns,
      records,
      sourceScope,
      collectedAt: capturedAt,
    });
    const temporary = await createTemporaryFilePath(this.tempRoot, {
      prefix: `mabang-${kind}-database`,
      extension: ".xlsx",
    });
    try {
      await this.runWorker({
        action: "write-xlsx",
        outputPath: temporary.path,
        kind,
        columns,
        records,
        metadataSheetName: "入库信息",
        summary,
      }, 3 * 60 * 1000);
      return await this.persistFile({
        kind,
        filename: temporary.path,
        sourceFilename: sourceFilename || `mabang-${kind}-collected.xlsx`,
        sourceIdempotencyKey,
        sourceAccountId,
        sourceScope,
        collectedAt: capturedAt,
        columns,
        records,
        actorLabel,
      });
    } finally {
      await removeFileInsideRoot(this.tempRoot, temporary.path).catch(() => {});
    }
  }

  async persistFile({
    kind: rawKind,
    filename,
    sourceFilename,
    sourceSha256 = null,
    sourceIdempotencyKey = null,
    sourceFileId = null,
    sourceAccountId = null,
    sourceScope = {},
    collectedAt = null,
    columns = null,
    records = null,
    actorLabel = "mabang_scheduler",
  }) {
    const kind = normalizedKind(rawKind);
    const sourceType = SOURCE_TYPES[kind];
    const semanticKey = sourceIdempotencyKey || (
      Array.isArray(columns) && Array.isArray(records)
        ? mabangCollectionFingerprint({ kind, columns, records, sourceScope, collectedAt })
        : null
    );
    const preview = await this.growthRadarService.previewFile(sourceType, {
      filename,
      sourceFilename,
      sourceSha256,
      sourceIdempotencyKey: semanticKey,
      sourceFileId,
      sourceAccountId,
      sourceScope,
      collectedAt,
    });
    const applied = await this.growthRadarService.applyPreview(sourceType, {
      previewId: preview.previewId,
      idempotencyKey: preview.sourceSha256,
    }, {
      actorLabel,
      confirmationGranted: true,
    });
    return publicResult(sourceType, preview, applied);
  }
}

export function createMabangDataPersistenceService(options) {
  return new MabangDataPersistenceService(options);
}
