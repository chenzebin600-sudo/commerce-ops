import { inventoryPageHash, normalizeSku } from "./extraction.mjs";
import { ImageValidationError } from "./image-assets.mjs";

const MODES = new Set(["full_initial", "missing_only", "retry_failed"]);
const TERMINAL_STATUSES = new Set(["completed", "partial_success", "failed"]);
const RETRYABLE_HTTP = new Set([403, 429, 500, 502, 503, 504]);
const AUDIT_RESULTS = new Set(["success", "failed"]);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function serviceError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function createMabangImageAuditRecord({ action, actor, metadata, result }) {
  if (!AUDIT_RESULTS.has(result)) {
    throw new TypeError("Mabang image audit result must be explicit.");
  }
  return {
    module: "mabang",
    action,
    status: result,
    actorType: actor,
    metadata,
  };
}

function publicDownloadError(error, httpStatus = null) {
  if (error instanceof ImageValidationError) return { code: error.code, message: error.message, httpStatus: error.httpStatus || httpStatus };
  const code = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "IMAGE_DOWNLOAD_FAILED";
  const messages = {
    IMAGE_DOWNLOAD_TIMEOUT: "图片下载超时。",
    IMAGE_HTTP_403: "图片服务拒绝访问（403）。",
    IMAGE_HTTP_404: "图片不存在（404）。",
    IMAGE_HTTP_429: "图片服务限流（429）。",
    IMAGE_TOO_LARGE: "图片超过允许大小。",
  };
  return { code, message: messages[code] || "图片下载或校验失败。", httpStatus };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const results = [];
  const jobs = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await worker(item));
    }
  });
  await Promise.all(jobs);
  return results;
}

function discoverySku(row) {
  return normalizeSku(row?.sourceSkuNormalized || row?.normalizedSku || row?.sourceSku);
}

export function selectRowsWithinSkuLimit(rows, selectedSkus, maxSkus) {
  const selected = new Set([...selectedSkus].map((sku) => normalizeSku(sku)).filter(Boolean));
  const acceptedRows = [];
  for (const row of rows) {
    const sku = discoverySku(row);
    if (!sku) continue;
    if (!selected.has(sku)) {
      if (selected.size >= maxSkus) continue;
      selected.add(sku);
    }
    acceptedRows.push(row);
  }
  return {
    rows: acceptedRows,
    selectedSkus: selected,
    actualSelectedSkuCount: selected.size,
    limitReached: selected.size >= maxSkus,
  };
}

export class MabangSkuImageCollectorService {
  constructor({ repository, assetService, browserFactory, accountRepository = null, audit = null,
    wait = delay, concurrency = 4, retryAttempts = 4, maxPages = 10000, maxSkusPerBatch = 100 }) {
    this.repository = repository;
    this.assetService = assetService;
    this.browserFactory = browserFactory;
    this.accountRepository = accountRepository;
    this.audit = audit;
    this.wait = wait;
    this.concurrency = Math.max(3, Math.min(Number(concurrency) || 4, 5));
    this.retryAttempts = Math.max(1, Math.min(Number(retryAttempts) || 4, 6));
    this.maxPages = Math.max(1, Math.min(Number(maxPages) || 10000, 10000));
    this.maxSkusPerBatch = Math.max(1, Math.min(Number(maxSkusPerBatch) || 100, 10000));
    this.active = new Map();
  }

  batchSkuLimit(batch) {
    const configured = Number(batch?.interfaceProfile?.collectionPolicy?.maxSkusPerBatch);
    return Number.isFinite(configured) && configured > 0
      ? Math.max(1, Math.min(Math.floor(configured), 10000))
      : this.maxSkusPerBatch;
  }

  async recoverInterruptedBatches() {
    const batches = await this.repository.listBatches({ limit: 200 });
    const interrupted = batches.filter((batch) => ["pending", "running", "pause_requested"].includes(batch.status));
    for (const batch of interrupted) {
      await this.repository.updateBatch(batch.id, {
        status: "paused", pausedAt: new Date().toISOString(),
        lastErrorCode: "PROCESS_RESTARTED", lastErrorMessage: "服务进程已重启，可从最近检查点继续。",
      });
    }
    return interrupted.length;
  }

  async start({ accountId, mode, createdBy, sourceBatchId = null }) {
    if (!MODES.has(mode)) throw serviceError("MABANG_IMAGE_MODE_INVALID", "采集模式无效。 ");
    if (!accountId) throw serviceError("MABANG_ACCOUNT_REQUIRED", "必须选择马帮账号。 ");
    if (mode === "retry_failed" && !sourceBatchId) throw serviceError("SOURCE_BATCH_REQUIRED", "重试失败图片需要来源批次。 ");
    if (this.accountRepository && !await this.accountRepository.get(accountId)) {
      throw serviceError("MABANG_ACCOUNT_NOT_FOUND", "马帮账号不存在。", 404);
    }
    const running = (await this.repository.listBatches({ limit: 200 })).find((batch) => ["pending", "running", "pause_requested"].includes(batch.status));
    if (running) throw serviceError("MABANG_IMAGE_BATCH_ACTIVE", "已有马帮图片采集任务正在运行。", 409);
    let batch = await this.repository.createBatch({ accountId, mode, createdBy: createdBy || "local_session", sourceBatchId });
    batch = await this.repository.updateBatch(batch.id, {
      interfaceProfile: {
        ...(batch.interfaceProfile || {}),
        collectionPolicy: { maxSkusPerBatch: this.maxSkusPerBatch },
      },
    });
    await this.recordAudit({
      action: "mabang_images.collect_started", result: "success", actor: createdBy, metadata: {
        batchId: batch.id, accountId, mode, sourceBatchId: sourceBatchId || null,
        configuredMaxSkusPerBatch: this.maxSkusPerBatch, actualSelectedSkuCount: 0,
      },
    });
    this.launch(batch.id);
    return batch;
  }

  launch(batchId) {
    if (this.active.has(batchId)) return this.active.get(batchId);
    const task = this.run(batchId).catch(() => {}).finally(() => this.active.delete(batchId));
    this.active.set(batchId, task);
    return task;
  }

  async shutdown({ timeoutMs = 2000 } = {}) {
    const active = [...this.active.entries()];
    if (!active.length) return { pauseRequested: 0, settled: 0 };
    await Promise.allSettled(active.map(([batchId]) => this.repository.requestPause(batchId)));
    let timeoutHandle;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ pauseRequested: active.length, settled: 0 }), Math.max(0, Number(timeoutMs) || 0));
      timeoutHandle.unref?.();
    });
    const settled = Promise.allSettled(active.map(([, task]) => task))
      .then(() => ({ pauseRequested: active.length, settled: active.length }));
    const result = await Promise.race([settled, timeout]);
    clearTimeout(timeoutHandle);
    return result;
  }

  async pause(batchId, actor) {
    const batch = await this.repository.requestPause(batchId);
    if (!batch) throw serviceError("MABANG_IMAGE_BATCH_NOT_FOUND", "采集批次不存在。", 404);
    await this.recordAudit({ action: "mabang_images.pause_requested", result: "success", actor, metadata: { batchId } });
    return batch;
  }

  async resume(batchId, actor) {
    const batch = await this.repository.getBatch(batchId);
    if (!batch) throw serviceError("MABANG_IMAGE_BATCH_NOT_FOUND", "采集批次不存在。", 404);
    if (!["paused", "failed", "partial_success"].includes(batch.status)) {
      throw serviceError("MABANG_IMAGE_BATCH_NOT_RESUMABLE", "当前批次不可继续。", 409);
    }
    await this.repository.updateBatch(batchId, {
      status: "pending", pausedAt: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null,
    });
    const selectedSkus = await this.repository.selectedSkuKeys(batchId);
    const maxSkusPerBatch = this.batchSkuLimit(batch);
    await this.recordAudit({
      action: "mabang_images.resumed", result: "success", actor, metadata: {
        batchId, mode: batch.mode, configuredMaxSkusPerBatch: maxSkusPerBatch,
        actualSelectedSkuCount: selectedSkus.length,
      },
    });
    this.launch(batchId);
    return this.repository.getBatch(batchId);
  }

  async run(batchId) {
    let browser = null;
    let batch = await this.repository.getBatch(batchId);
    let selectedSkus = new Set();
    if (!batch || TERMINAL_STATUSES.has(batch.status) && batch.status !== "partial_success") return batch;
    const maxSkusPerBatch = this.batchSkuLimit(batch);
    await this.repository.updateBatch(batchId, { status: "running", startedAt: batch.startedAt || new Date().toISOString() });
    try {
      selectedSkus = new Set(await this.repository.selectedSkuKeys(batchId));
      if (batch.mode === "retry_failed") {
        const failed = await this.repository.failedDownloads(batch.sourceBatchId);
        const candidates = failed.map((row, index) => ({ ...row, sourceKind: "retry", sourcePage: 1, sourceRowNumber: index + 1 }));
        const selection = selectRowsWithinSkuLimit(candidates, selectedSkus, maxSkusPerBatch);
        const retryRows = selection.rows;
        selectedSkus = selection.selectedSkus;
        await this.repository.saveDiscoveries(batchId, retryRows);
        browser = await this.browserFactory({ accountId: batch.accountId, batchId });
        await browser.open();
        const discoveries = await this.repository.pendingDownloads(batchId);
        await this.downloadRows(batch, discoveries, browser);
        await this.repository.upsertCheckpoint({ batchId, pageNumber: 1, pageHash: inventoryPageHash(retryRows),
          rowCount: retryRows.length, discoveredCount: new Set(retryRows.map(discoverySku)).size,
          failedCount: 0, status: "completed", completedAt: new Date().toISOString() });
      } else {
        browser = await this.browserFactory({ accountId: batch.accountId, batchId });
        const opened = await browser.open();
        await this.repository.updateBatch(batchId, {
          interfaceProfile: {
            ...(opened.interfaceProfile || {}),
            collectionPolicy: { maxSkusPerBatch },
          },
          totalPages: opened.totalPages,
        });
        const checkpoint = await this.repository.latestCheckpoint(batchId);
        let pageNumber = checkpoint?.status === "completed" ? checkpoint.pageNumber + 1 : Math.max(1, checkpoint?.pageNumber || batch.currentPage + 1 || 1);
        let previousHash = checkpoint?.status === "completed" ? checkpoint.pageHash : null;
        while (pageNumber <= this.maxPages) {
          batch = await this.repository.getBatch(batchId);
          if (batch.status === "pause_requested") {
            await this.repository.updateBatch(batchId, { status: "paused", pausedAt: new Date().toISOString() });
            await this.recordAudit({
              action: "mabang_images.paused", result: "success", actor: batch.createdBy, metadata: { batchId, pageNumber },
            });
            return this.repository.recomputeBatchCounters(batchId);
          }
          if (selectedSkus.size >= maxSkusPerBatch) break;
          await this.repository.upsertCheckpoint({ batchId, pageNumber, status: "running" });
          let page;
          try {
            page = await browser.page(pageNumber);
          } catch (error) {
            await this.repository.upsertCheckpoint({ batchId, pageNumber, status: "failed", errorCode: error.code || "PAGE_COLLECTION_FAILED" });
            throw error;
          }
          const sourceRows = page.rows || [];
          if (!sourceRows.length) {
            await this.repository.upsertCheckpoint({ batchId, pageNumber, pageHash: inventoryPageHash([]), rowCount: 0,
              discoveredCount: 0, failedCount: 0, status: "completed", completedAt: new Date().toISOString() });
            break;
          }
          const selection = selectRowsWithinSkuLimit(sourceRows, selectedSkus, maxSkusPerBatch);
          const rows = selection.rows;
          selectedSkus = selection.selectedSkus;
          const hash = inventoryPageHash(rows);
          if (previousHash && hash === previousHash) {
            await this.repository.upsertCheckpoint({ batchId, pageNumber, pageHash: hash, rowCount: rows.length,
              discoveredCount: 0, failedCount: 0, status: "repeated", errorCode: "REPEATED_PAGE_HASH", completedAt: new Date().toISOString() });
            break;
          }
          await this.repository.saveDiscoveries(batchId, rows);
          const stored = await this.repository.discoveriesForPage(batchId, pageNumber);
          await this.downloadRows(batch, stored, browser);
          const pageRows = await this.repository.discoveriesForPage(batchId, pageNumber);
          const failedCount = pageRows.filter((row) => row.downloadStatus === "failed").length;
          await this.repository.upsertCheckpoint({ batchId, pageNumber, pageHash: hash, rowCount: rows.length,
            discoveredCount: new Set(rows.map(discoverySku)).size, failedCount,
            status: "completed", completedAt: new Date().toISOString() });
          await this.repository.updateBatch(batchId, { currentPage: pageNumber, totalPages: page.totalPages || batch.totalPages });
          await this.repository.recomputeBatchCounters(batchId);
          previousHash = hash;
          if (selection.limitReached) break;
          if (page.hasNext === false || (page.totalPages && pageNumber >= page.totalPages)) break;
          pageNumber += 1;
        }
      }
      const counted = await this.repository.recomputeBatchCounters(batchId);
      const status = counted.failedImages > 0 ? "partial_success" : "completed";
      const completed = await this.repository.updateBatch(batchId, { status, completedAt: new Date().toISOString() });
      await this.recordAudit({
        action: "mabang_images.collect_completed", result: "success", actor: completed.createdBy, metadata: {
          batchId, accountId: completed.accountId, mode: completed.mode, discoveredSkus: completed.discoveredSkus,
          downloadedImages: completed.downloadedImages, duplicateImages: completed.duplicateImages,
          failedImages: completed.failedImages, linkedProducts: completed.linkedProducts,
          configuredMaxSkusPerBatch: maxSkusPerBatch,
          actualSelectedSkuCount: completed.discoveredSkus,
        },
      });
      return completed;
    } catch (error) {
      const code = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "MABANG_IMAGE_BATCH_FAILED";
      const counted = await this.repository.recomputeBatchCounters(batchId).catch(() => null);
      await this.repository.updateBatch(batchId, { status: "failed", completedAt: new Date().toISOString(),
        lastErrorCode: code, lastErrorMessage: "采集任务中断，可从失败页继续。" });
      await this.recordAudit({
        action: "mabang_images.collect_failed", result: "failed", actor: batch?.createdBy,
        metadata: {
          batchId, accountId: batch?.accountId, mode: batch?.mode, errorCode: code,
          configuredMaxSkusPerBatch: maxSkusPerBatch,
          actualSelectedSkuCount: counted?.discoveredSkus ?? selectedSkus.size,
        },
      });
      throw error;
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  async downloadRows(batch, discoveries, browser) {
    const candidates = [];
    for (const row of discoveries) {
      if (!row.sourceImageUrl) {
        await this.repository.updateDiscovery(row.id, { downloadStatus: "missing", validationStatus: "missing", errorCode: "IMAGE_URL_MISSING", errorMessage: "库存记录没有图片地址。" });
        continue;
      }
      if (batch.mode === "missing_only" && !await this.repository.skuNeedsImage(row.sourceSku)) {
        await this.repository.updateDiscovery(row.id, { downloadStatus: "skipped", errorCode: null, errorMessage: null });
        continue;
      }
      candidates.push(row);
    }
    await mapWithConcurrency(candidates, this.concurrency, async (row) => this.downloadOne(batch, row, browser));
  }

  async downloadOne(batch, row, browser) {
    let lastError;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      let httpStatus = null;
      try {
        const response = await browser.fetchImage(row.sourceImageUrl);
        httpStatus = Number(response?.status || 0);
        if (response?.tooLarge) throw new ImageValidationError("IMAGE_TOO_LARGE", "图片超过允许大小。", { status: 413, httpStatus });
        if (httpStatus !== 200) {
          const error = serviceError(`IMAGE_HTTP_${httpStatus}`, "图片服务返回失败状态。", httpStatus || 502);
          error.httpStatus = httpStatus;
          throw error;
        }
        const stored = await this.assetService.store({ buffer: response.buffer, contentType: response.contentType, sourceUrl: row.sourceImageUrl });
        await this.repository.updateDiscovery(row.id, { downloadStatus: stored.duplicate ? "duplicate" : "downloaded",
          validationStatus: row.qualityIssueCode ? "warning" : "valid", assetId: stored.asset.id,
          downloadAttempts: attempt, httpStatus, errorCode: null, errorMessage: null });
        const links = await this.repository.linkAssetToMatchingProducts({ assetId: stored.asset.id, sourceSku: row.sourceSku, linkedBy: batch.createdBy });
        await this.recordAudit({
          action: "mabang_images.linked", result: "success", actor: batch.createdBy,
          metadata: { batchId: batch.id, assetId: stored.asset.id,
            sourceSku: row.sourceSku, productCount: links.length, duplicate: stored.duplicate },
        });
        return { ok: true, duplicate: stored.duplicate, links };
      } catch (error) {
        lastError = publicDownloadError(error, httpStatus || error?.httpStatus || null);
        const retryable = RETRYABLE_HTTP.has(Number(lastError.httpStatus))
          || /TIMEOUT|NETWORK_ERROR|ECONNRESET|EAI_AGAIN/.test(String(error?.code || ""));
        if (!retryable || attempt === this.retryAttempts) {
          await this.repository.updateDiscovery(row.id, { downloadStatus: "failed", validationStatus: "invalid",
            downloadAttempts: attempt, httpStatus: lastError.httpStatus, errorCode: lastError.code, errorMessage: lastError.message });
          return { ok: false, errorCode: lastError.code };
        }
        await this.wait(Math.min(8000, 500 * (2 ** (attempt - 1))));
      }
    }
    return { ok: false, errorCode: lastError?.code || "IMAGE_DOWNLOAD_FAILED" };
  }

  async confirmPrimary(linkId, actor) {
    const link = await this.repository.confirmPrimary(linkId, actor || "local_session");
    if (!link) throw serviceError("MABANG_IMAGE_LINK_NOT_FOUND", "图片关联不存在。", 404);
    await this.recordAudit({
      action: "mabang_images.primary_confirmed", result: "success", actor,
      metadata: { linkId, assetId: link.assetId, productId: link.productId },
    });
    return link;
  }

  async recordAudit({ action, actor, metadata, result }) {
    if (!this.audit) return;
    if (!AUDIT_RESULTS.has(result)) return;
    await this.audit({ action, actor: actor || "local_session", metadata, result }).catch(() => {});
  }
}

export const mabangImageCollectorInternals = Object.freeze({ mapWithConcurrency, publicDownloadError });
