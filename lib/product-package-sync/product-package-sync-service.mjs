import {
  PRODUCT_PACKAGE_SOURCE_FIELDS,
  createProductPackageSnapshotHasher,
  normalizeProductPackageSourceRow,
  publicProductPackageSourceFields,
} from "./product-package-source-contract.mjs";

function boundedRatio(value, fallback = 0.2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : fallback;
}

function errorCode(error, fallback = "PRODUCT_PACKAGE_SYNC_FAILED") {
  return String(error?.code || fallback).slice(0, 80);
}

export class ProductPackageSyncError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "ProductPackageSyncError";
    this.code = code;
    this.status = status;
  }
}

export class ProductPackageSyncService {
  constructor({
    repository,
    source = null,
    enabled = false,
    manualSyncEnabled = true,
    batchSize = 2_000,
    maxRemovalRatio = 0.2,
    audit = null,
    now = () => new Date(),
  }) {
    this.repository = repository;
    this.source = source;
    this.enabled = Boolean(enabled);
    this.manualSyncEnabled = Boolean(manualSyncEnabled);
    this.batchSize = Math.max(100, Math.min(Number(batchSize) || 2_000, 10_000));
    this.maxRemovalRatio = boundedRatio(maxRemovalRatio);
    this.audit = audit;
    this.now = now;
  }

  async status({ probe = false } = {}) {
    const schemaReady = await this.repository.isReady();
    const latestRun = schemaReady ? await this.repository.latestRun() : null;
    const currentRowCount = schemaReady ? await this.repository.currentRowCount() : 0;
    let sourceStatus = null;
    if (probe && this.source) {
      try {
        sourceStatus = await this.source.status();
      } catch (error) {
        sourceStatus = { connected: false, errorCode: errorCode(error, "PRODUCT_PACKAGE_SOURCE_UNAVAILABLE") };
      }
    }
    return {
      schemaReady,
      sourceConfigured: Boolean(this.source),
      syncEnabled: this.enabled,
      manualSyncEnabled: this.manualSyncEnabled,
      schedule: { time: "09:00", timezone: "Asia/Shanghai", catchUpAfterRestart: true },
      batchSize: this.batchSize,
      maxRemovalRatio: this.maxRemovalRatio,
      currentRowCount,
      latestRun,
      source: sourceStatus,
      fields: publicProductPackageSourceFields(),
    };
  }

  async sync({ triggerType = "manual", scheduleDate = null, requestedBy = "local_session", allowLargeRemoval = false } = {}) {
    if (!await this.repository.isReady()) {
      throw new ProductPackageSyncError("PRODUCT_PACKAGE_SYNC_SCHEMA_NOT_READY", 503, "产品包数据库同步迁移尚未完成。");
    }
    if (!this.source) {
      throw new ProductPackageSyncError("PRODUCT_PACKAGE_SOURCE_NOT_CONFIGURED", 503, "产品包 MySQL 数据源尚未配置。");
    }
    if (triggerType === "scheduled" && !this.enabled) {
      throw new ProductPackageSyncError("PRODUCT_PACKAGE_SYNC_DISABLED", 409, "产品包定时同步尚未启用。");
    }
    if (triggerType === "manual" && !this.manualSyncEnabled) {
      throw new ProductPackageSyncError("PRODUCT_PACKAGE_MANUAL_SYNC_DISABLED", 409, "产品包手动同步尚未启用。");
    }
    const active = await this.repository.getActiveRun();
    if (active) {
      throw new ProductPackageSyncError("PRODUCT_PACKAGE_SYNC_BUSY", 409, "已有产品包同步正在执行，请稍后重试。");
    }
    const claimed = await this.repository.createRun({
      triggerType,
      scheduleDate,
      requestedBy,
      now: this.now(),
    });
    if (!claimed.claimed) return { run: claimed.run, skipped: true, changed: false };
    const runId = claimed.run.id;
    try {
      const result = await this.repository.reconcile({
        runId,
        requestedBy,
        mapping: PRODUCT_PACKAGE_SOURCE_FIELDS,
        maxRemovalRatio: this.maxRemovalRatio,
        allowLargeRemoval,
        loadRows: async (stage) => {
          const hasher = createProductPackageSnapshotHasher();
          let sourceRowNumber = 2;
          const metadata = await this.source.readSnapshot({
            batchSize: this.batchSize,
            onBatch: async (sourceRows) => {
              const rows = sourceRows.map((sourceRow) => normalizeProductPackageSourceRow(sourceRow, sourceRowNumber++));
              for (const row of rows) hasher.update(row);
              await stage(rows);
            },
          });
          if (!metadata.rowCount) {
            throw new ProductPackageSyncError(
              "PRODUCT_PACKAGE_SOURCE_EMPTY",
              409,
              "源产品包为空，已拒绝清空本地产品包。",
            );
          }
          return { metadata, snapshot: hasher.digest() };
        },
      });
      const finishedAt = this.now().toISOString();
      const run = await this.repository.updateRun(runId, {
        status: result.changed ? "SUCCEEDED" : "NO_CHANGES",
        importBatchId: result.importBatchId,
        sourceSnapshotSha256: result.snapshot.sha256,
        sourceRowCount: result.sourceCount,
        localRowCountBefore: result.localBefore,
        localRowCountAfter: result.localAfter,
        newCount: result.counts.newCount,
        updatedCount: result.counts.updatedCount,
        unchangedCount: result.counts.unchangedCount,
        removedCount: result.counts.removedCount,
        fieldChangeCount: result.fieldChangeCount,
        sourceCheckedAt: result.metadata?.sourceCheckedAt || null,
        sourceTableUpdatedAt: result.metadata?.tableUpdatedAt || null,
        sourceMaxUpdatedAt: result.metadata?.maxUpdatedAt || null,
        finishedAt,
        errorCode: null,
        errorMessage: null,
      }, this.now());
      await this.audit?.recordSafely?.({
        module: "product",
        action: "product.package.database_sync",
        status: "success",
        runId,
        actorIdentifier: requestedBy,
        metadata: {
          triggerType,
          sourceRowCount: result.sourceCount,
          newCount: result.counts.newCount,
          updatedCount: result.counts.updatedCount,
          removedCount: result.counts.removedCount,
          fieldChangeCount: result.fieldChangeCount,
          result: result.changed ? "updated" : "no_changes",
        },
      });
      return { run, changed: result.changed, skipped: false };
    } catch (error) {
      await this.repository.updateRun(runId, {
        status: "FAILED",
        finishedAt: this.now().toISOString(),
        errorCode: errorCode(error),
        errorMessage: error?.message || "产品包同步失败。",
      }, this.now()).catch(() => null);
      await this.audit?.recordSafely?.({
        module: "product",
        action: "product.package.database_sync",
        status: "failed",
        runId,
        actorIdentifier: requestedBy,
        errorCode: errorCode(error),
        errorSummary: error,
        metadata: { triggerType, result: "failed" },
      });
      throw error;
    }
  }

  listRuns(options) {
    return this.repository.listRuns(options);
  }

  listChanges(options) {
    return this.repository.listChanges(options);
  }
}
