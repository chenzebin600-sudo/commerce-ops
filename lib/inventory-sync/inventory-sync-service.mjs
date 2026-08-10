import { createHash, randomUUID } from "node:crypto";
import { decryptSecret } from "../mabang-scheduler/crypto.mjs";
import { buildInventoryConfigImportPreview, parseInventorySyncConfigWorkbook } from "./inventory-config-import.mjs";

export const INVENTORY_SYNC_OPERATION_TYPE = "MABANG.INVENTORY_SYNC.SHOPEE";
export const LAZADA_INVENTORY_SYNC_OPERATION_TYPE = "MABANG.INVENTORY_SYNC.LAZADA";
export const SKU_REBIND_OPERATION_TYPE = "MABANG.SKU_REBIND.SHOPEE";
const SNAPSHOT_TTL_MS = 15 * 60_000;
const MAX_EXECUTABLE_PRODUCTS = 100;
const MAX_EXECUTABLE_VARIANTS = 500;

function stateProgressMessage(state) {
  return ({
    PREVIEWED: "换绑计划等待批准。",
    APPROVED: "换绑计划已批准，等待执行。",
    SUCCEEDED: "换绑任务已完成。",
    FAILED: "换绑任务执行失败。",
    UNKNOWN: "换绑结果暂时无法确认，请人工核对。",
    EXPIRED: "换绑计划已过期。",
    BLOCKED: "换绑任务已被安全规则阻止。",
  })[state] || "当前没有正在执行的换绑任务。";
}

function fail(message, code, status = 400, extras = {}) {
  return Object.assign(new Error(message), { code, status, ...extras });
}

function text(value) {
  return String(value ?? "").trim();
}

function inventoryPlatform(value) {
  const platform = text(value || "shopee").toLowerCase();
  if (!new Set(["shopee", "lazada"]).has(platform)) {
    throw fail("库存同步平台只支持 Shopee 或 Lazada。", "INVENTORY_SYNC_PLATFORM_INVALID");
  }
  return platform;
}

function platformLabel(value) {
  return inventoryPlatform(value) === "lazada" ? "Lazada" : "Shopee";
}

function inventoryOperationType(value) {
  return inventoryPlatform(value) === "lazada" ? LAZADA_INVENTORY_SYNC_OPERATION_TYPE : INVENTORY_SYNC_OPERATION_TYPE;
}

function isInventoryOperationType(value) {
  return new Set([INVENTORY_SYNC_OPERATION_TYPE, LAZADA_INVENTORY_SYNC_OPERATION_TYPE]).has(text(value));
}

function normalizedSku(value) {
  return text(value).normalize("NFKC").replace(/\s+/g, "").toLocaleUpperCase("en-US");
}

function isComboSku(value) {
  return /X\d*$/i.test(normalizedSku(value));
}

function productKey(value) {
  const base = normalizedSku(value).replace(/X\d*$/i, "");
  const match = base.match(/^[TMP]\d([A-Z]{2})\d*(\d{4})$/i);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : "";
}

function inventoryCandidates(inventoryBySku, sellerSku) {
  const key = productKey(sellerSku);
  if (!key || isComboSku(sellerSku)) return [];
  return [...inventoryBySku.values()]
    .filter((item) => productKey(item.normalizedSku) === key && !isComboSku(item.normalizedSku))
    .map((item) => ({ stockSku: item.sourceSku, availableQuantity: item.availableQuantity }))
    .sort((a, b) => b.availableQuantity - a.availableQuantity || a.stockSku.localeCompare(b.stockSku));
}

function integer(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    usernameMasked: account.usernameMasked,
    enabled: Boolean(account.enabled),
    passwordConfigured: Boolean(account.passwordConfigured),
    lastVerifyStatus: account.lastVerifyStatus || "",
  };
}

function publicPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    operationType: plan.operationType,
    state: plan.state,
    planHash: plan.planHash,
    scope: plan.scope,
    sourceSnapshot: plan.sourceSnapshot,
    policy: plan.policy,
    items: plan.items,
    summary: plan.summary,
    result: plan.result,
    expiresAt: plan.expiresAt,
    createdAt: plan.createdAt,
    approvedAt: plan.approvedAt,
    finishedAt: plan.finishedAt,
    lastErrorCode: plan.lastErrorCode,
    lastErrorMessage: plan.lastErrorMessage,
  };
}

function targetIdentity(item) {
  return [item.shopId, item.internalId, item.variationId, item.sellerSku].map(text).join("\u0000");
}

function aggregateInventory(records, selectedWarehouses) {
  const selected = new Set(selectedWarehouses.map(text));
  const bySku = new Map();
  const warehouseSummary = new Map();
  let rejectedRows = 0;
  for (const record of records) {
    const sourceSku = text(record["库存SKU编号"]);
    const sku = normalizedSku(sourceSku);
    const warehouse = text(record["仓库"]);
    if (!sku || !warehouse) {
      rejectedRows += 1;
      continue;
    }
    const available = integer(record["可用库存量"]);
    const summary = warehouseSummary.get(warehouse) || { name: warehouse, rowCount: 0, availableQuantity: 0 };
    summary.rowCount += Math.max(1, integer(record._sourceRowCount, 1));
    summary.availableQuantity += available;
    warehouseSummary.set(warehouse, summary);
    if (selected.size && !selected.has(warehouse)) continue;
    const current = bySku.get(sku) || { sourceSku, normalizedSku: sku, availableQuantity: 0, warehouses: [] };
    current.availableQuantity += available;
    current.warehouses.push({ warehouse, availableQuantity: available });
    bySku.set(sku, current);
  }
  return {
    bySku,
    warehouses: [...warehouseSummary.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    rejectedRows,
  };
}

function compactInventoryRecords(records) {
  const compacted = new Map();
  let sourceRowCount = 0;
  for (const record of records || []) {
    const sourceSku = text(record["库存SKU编号"]);
    const sku = normalizedSku(sourceSku);
    const warehouse = text(record["仓库"]);
    if (!sku || !warehouse) continue;
    sourceRowCount += 1;
    const key = `${sku}\u0000${warehouse}`;
    const current = compacted.get(key) || {
      "库存SKU编号": sourceSku,
      "仓库": warehouse,
      "可用库存量": 0,
      _sourceRowCount: 0,
    };
    current["可用库存量"] += integer(record["可用库存量"]);
    current._sourceRowCount += 1;
    compacted.set(key, current);
  }
  const compactRecords = [...compacted.values()].sort((left, right) => (
    normalizedSku(left["库存SKU编号"]).localeCompare(normalizedSku(right["库存SKU编号"]))
    || text(left["仓库"]).localeCompare(text(right["仓库"]), "zh-CN")
  ));
  return { records: compactRecords, sourceRowCount };
}

function inventoryScopeHash(records, selectedWarehouses, relevantSkus = []) {
  const inventory = aggregateInventory(records, selectedWarehouses);
  const selectedSkus = new Set((relevantSkus || []).map(normalizedSku).filter(Boolean));
  const canonical = [...inventory.bySku.values()]
    .filter((item) => !selectedSkus.size || selectedSkus.has(item.normalizedSku))
    .map((item) => ({
      sku: item.normalizedSku,
      availableQuantity: item.availableQuantity,
    }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
  return contentHash(canonical);
}

function normalizeInventoryPools(rawPools, legacyShopIds = [], legacyWarehouseNames = [], platform = "shopee") {
  const label = platformLabel(platform);
  const source = Array.isArray(rawPools) && rawPools.length
    ? rawPools
    : [{ id: "pool-1", name: "库存池 1", shopIds: legacyShopIds, warehouseNames: legacyWarehouseNames }];
  const pools = [];
  const usedIds = new Set();
  const usedShops = new Set();
  for (const [index, raw] of source.entries()) {
    const id = text(raw?.id) || `pool-${index + 1}`;
    const name = text(raw?.name) || `库存池 ${index + 1}`;
    const shopIds = [...new Set((raw?.shopIds || []).map(text).filter(Boolean))];
    const warehouseNames = [...new Set((raw?.warehouseNames || []).map(text).filter(Boolean))];
    if (usedIds.has(id)) throw fail(`库存池标识重复：${id}。`, "INVENTORY_SYNC_POOL_ID_DUPLICATE");
    if (!shopIds.length) throw fail(`${name} 至少需要绑定一个 ${label} 店铺。`, "INVENTORY_SYNC_POOL_SHOP_REQUIRED");
    if (shopIds.length > 1) throw fail(`${name} 只能绑定一个 ${label} 店铺，库存不允许在店铺之间共享。`, "INVENTORY_SYNC_POOL_SHOP_SHARING_FORBIDDEN");
    if (!warehouseNames.length) throw fail(`${name} 至少需要绑定一个来源仓库。`, "INVENTORY_SYNC_POOL_WAREHOUSE_REQUIRED");
    for (const shopId of shopIds) {
      if (usedShops.has(shopId)) throw fail(`店铺 ${shopId} 被分配到多个库存池。`, "INVENTORY_SYNC_POOL_SHOP_DUPLICATE");
      usedShops.add(shopId);
    }
    usedIds.add(id);
    pools.push({ id, name, shopIds, warehouseNames });
  }
  return pools;
}

function inventoryPoolsFromScope(scope = {}) {
  return normalizeInventoryPools(scope.inventoryPools, scope.shopIds || [], scope.warehouseNames || [], scope.platform || "shopee");
}

function inventoryPoolForItem(pools, item) {
  return pools.find((pool) => pool.id === text(item?.inventoryPoolId))
    || pools.find((pool) => pool.shopIds.includes(text(item?.shopId)))
    || null;
}

function flattenListings(listings, selectedShopIds, platform = "shopee") {
  const normalizedPlatform = inventoryPlatform(platform);
  const selected = new Set(selectedShopIds.map(text));
  const rows = [];
  for (const listing of listings) {
    const shopId = text(listing.shop_id);
    if (!selected.has(shopId)) continue;
    for (const variant of listing.variants || []) {
      rows.push({
        platform: normalizedPlatform,
        shopId,
        shopName: text(listing.shop_name),
        internalId: text(listing.internal_id),
        productId: text(listing.product_id),
        title: text(listing.title),
        variationId: text(variant.variant_id || variant.sku_id || variant.id || variant.sku),
        sellerSku: text(variant.sku),
        stockSku: text(variant.stock_sku),
        normalizedStockSku: normalizedSku(variant.stock_sku),
        currentStock: integer(variant.stock),
      });
    }
  }
  return rows;
}

function buildPlanItems(listingRows, inventoryBySku, policy) {
  const items = [];
  const matchedBySku = new Map();
  for (const row of listingRows) {
    if (!row.sellerSku) {
      items.push({ ...row, status: "BLOCKED", reasonCode: "SELLER_SKU_IDENTITY_MISSING", targetStock: null });
      continue;
    }
    const explicitStockSku = row.normalizedStockSku;
    const sellerSkuFallback = normalizedSku(row.sellerSku);
    const matchedStockSku = explicitStockSku || sellerSkuFallback;
    const inventory = inventoryBySku.get(matchedStockSku);
    if (!inventory) {
      const candidates = explicitStockSku ? [] : inventoryCandidates(inventoryBySku, row.sellerSku);
      const reasonCode = explicitStockSku
        ? "INVENTORY_SKU_NOT_FOUND"
        : isComboSku(row.sellerSku)
          ? "COMBO_SKU_MAPPING_REQUIRED"
          : candidates.length
            ? "SELLER_SKU_REBIND_REQUIRED"
            : "SELLER_SKU_NOT_IN_INVENTORY";
      items.push({
        ...row,
        status: "BLOCKED",
        reasonCode,
        targetStock: null,
        stockSkuSource: explicitStockSku ? "listing_stock_sku" : "seller_sku_candidate_unmatched",
        productKey: productKey(row.sellerSku),
        candidateStockSkus: candidates.slice(0, 20),
      });
      continue;
    }
    const resolved = {
      ...row,
      stockSku: inventory.sourceSku || row.stockSku || row.sellerSku,
      normalizedStockSku: matchedStockSku,
      stockSkuSource: explicitStockSku ? "listing_stock_sku" : "seller_sku_exact_inventory_match",
      inventoryAvailable: inventory.availableQuantity,
    };
    const group = matchedBySku.get(matchedStockSku) || [];
    group.push(resolved);
    matchedBySku.set(matchedStockSku, group);
  }

  for (const [sku, rows] of [...matchedBySku.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort((a, b) => targetIdentity(a).localeCompare(targetIdentity(b)));
    const inventory = inventoryBySku.get(sku);
    const distributable = Math.max(0, inventory.availableQuantity - policy.safetyStock);
    const base = Math.floor(distributable / rows.length);
    let remainder = distributable % rows.length;
    for (const row of rows) {
      const allocated = Math.min(policy.perListingCap, base + (remainder > 0 ? 1 : 0));
      if (remainder > 0 && allocated > base) remainder -= 1;
      const unchanged = row.currentStock === allocated;
      items.push({
        ...row,
        inventoryAvailable: inventory.availableQuantity,
        sharedTargetCount: rows.length,
        targetStock: allocated,
        status: unchanged ? "UNCHANGED" : "READY",
        reasonCode: unchanged ? "ALREADY_MATCHED" : "SHARED_POOL_EQUAL_ALLOCATION",
      });
    }
  }
  return items.sort((a, b) => targetIdentity(a).localeCompare(targetIdentity(b)));
}

function rebaseExecutionItems(plan, currentListings, currentRecords) {
  const pools = inventoryPoolsFromScope(plan.scope);
  const latestItems = pools.flatMap((pool) => {
    const inventory = aggregateInventory(currentRecords, pool.warehouseNames);
    const rows = flattenListings(currentListings, pool.shopIds, plan.scope?.platform).map((row) => ({
      ...row,
      inventoryPoolId: pool.id,
      inventoryPoolName: pool.name,
    }));
    return buildPlanItems(rows, inventory.bySku, plan.policy || {});
  });
  const latestByIdentity = new Map(latestItems.map((item) => [targetIdentity(item), item]));
  const plannedReady = (plan.items || []).filter((item) => item.status === "READY");
  const executable = [];
  const adjusted = [];
  const skipped = [];

  for (const planned of plannedReady) {
    const identity = targetIdentity(planned);
    const latest = latestByIdentity.get(identity);
    if (!latest) {
      skipped.push({
        identity,
        shopId: planned.shopId,
        shopName: planned.shopName,
        internalId: planned.internalId,
        productId: planned.productId,
        title: planned.title,
        variationId: planned.variationId,
        sellerSku: planned.sellerSku,
        reasonCode: "LISTING_IDENTITY_CHANGED",
      });
      continue;
    }
    if (latest.status === "BLOCKED" || normalizedSku(latest.stockSku) !== normalizedSku(planned.stockSku)) {
      skipped.push({
        identity,
        shopId: planned.shopId,
        shopName: planned.shopName,
        internalId: planned.internalId,
        productId: planned.productId,
        title: planned.title,
        variationId: planned.variationId,
        sellerSku: planned.sellerSku,
        reasonCode: latest.reasonCode || "STOCK_SKU_CHANGED",
      });
      continue;
    }
    const approvedTarget = Math.max(0, integer(planned.targetStock));
    const latestSafeTarget = Math.max(0, integer(latest.targetStock));
    const targetStock = Math.min(approvedTarget, latestSafeTarget);
    const targetReduced = targetStock < approvedTarget;
    const onlineStockChanged = integer(latest.currentStock) !== integer(planned.currentStock);
    if (integer(latest.currentStock) === targetStock) {
      skipped.push({
        identity,
        shopId: planned.shopId,
        shopName: planned.shopName,
        internalId: planned.internalId,
        productId: planned.productId,
        title: planned.title,
        variationId: planned.variationId,
        sellerSku: planned.sellerSku,
        reasonCode: "ALREADY_AT_REBASED_TARGET",
        approvedTarget,
        latestSafeTarget,
        currentStock: integer(latest.currentStock),
      });
      continue;
    }
    const rebased = {
      ...planned,
      currentStock: integer(latest.currentStock),
      targetStock,
      inventoryAvailable: latest.inventoryAvailable,
      sharedTargetCount: latest.sharedTargetCount,
    };
    executable.push(rebased);
    if (targetReduced || onlineStockChanged) {
      adjusted.push({
        identity,
        shopId: planned.shopId,
        internalId: planned.internalId,
        variationId: planned.variationId,
        sellerSku: planned.sellerSku,
        approvedTarget,
        latestSafeTarget,
        executionTarget: targetStock,
        plannedCurrentStock: integer(planned.currentStock),
        latestCurrentStock: integer(latest.currentStock),
        targetReduced,
        onlineStockChanged,
      });
    }
  }

  return {
    plannedCount: plannedReady.length,
    executable,
    adjusted,
    skipped,
  };
}

function collectContinuousExceptions(plan, batchNumber, deferredProducts, exceptions) {
  let executionFailures = 0;
  for (const row of plan?.result?.results || []) {
    if (text(row?.status).toLowerCase() !== "failed") continue;
    const internalId = text(row.internal_id || row.internalId);
    const shopName = text(row.shop_name || row.shopName);
    const item = (plan.items || []).find((candidate) => candidate.internalId === internalId && (!shopName || candidate.shopName === shopName));
    const shopId = text(row.shop_id || row.shopId || item?.shopId);
    if (!shopId || !internalId) continue;
    deferredProducts.set(`${shopId}\u0000${internalId}`, { shopId, internalId });
    exceptions.set(`EXECUTE:${shopId}:${internalId}`, {
      source: "执行失败", batch: batchNumber, shopId, shopName: shopName || item?.shopName || "",
      internalId, productId: text(row.product_id || row.productId || internalId), title: text(row.title || item?.title),
      variationId: "", sellerSku: "", reasonCode: "MABANG_ITEM_EXECUTION_FAILED",
      message: text(row.message) || "马帮商品执行或回读失败",
    });
    executionFailures += 1;
  }
  for (const item of plan?.items || []) {
    if (item.status !== "BLOCKED" || item.reasonCode === "DEFERRED_AFTER_BATCH_FAILURE") continue;
    const key = `MATCH:${item.shopId}:${item.internalId}:${item.variationId}:${item.reasonCode}`;
    exceptions.set(key, {
      source: "匹配阻断", batch: batchNumber, shopId: item.shopId, shopName: item.shopName,
      internalId: item.internalId, productId: item.productId, title: item.title,
      variationId: item.variationId, sellerSku: item.sellerSku, reasonCode: item.reasonCode,
      message: text(item.message) || item.reasonCode,
    });
  }
  for (const item of plan?.result?.executionAdjustment?.skipped || []) {
    const key = `SKIP:${item.shopId}:${item.internalId}:${item.variationId}:${item.reasonCode}`;
    exceptions.set(key, {
      source: "执行跳过", batch: batchNumber, shopId: text(item.shopId), shopName: text(item.shopName),
      internalId: text(item.internalId), productId: text(item.productId), title: text(item.title),
      variationId: text(item.variationId), sellerSku: text(item.sellerSku), reasonCode: text(item.reasonCode) || "EXECUTION_ITEM_SKIPPED",
      message: text(item.message) || "执行前重新校验未通过，已记录并跳过",
    });
  }
  return executionFailures;
}

function retainContinuousAttemptedProducts(plan, deferredProducts) {
  for (const item of plan?.items || []) {
    if (item.status !== "READY") continue;
    const shopId = text(item.shopId);
    const internalId = text(item.internalId);
    if (!shopId || !internalId) continue;
    deferredProducts.set(`${shopId}\u0000${internalId}`, { shopId, internalId });
  }
}

export class InventorySyncService {
  constructor({ accountRepository, operationPlans, runWorker, listingClient, ensureListingService, snapshotStore = null, scopeStore = null, now = () => new Date() }) {
    this.accountRepository = accountRepository;
    this.operationPlans = operationPlans;
    this.runWorker = runWorker;
    this.listingClient = listingClient;
    this.ensureListingService = ensureListingService;
    this.snapshotStore = snapshotStore;
    this.scopeStore = scopeStore;
    this.now = now;
    this.snapshots = new Map();
    this.prepareTasks = new Map();
    this.prepareProgress = new Map();
    this.previewProgress = new Map();
    this.rebindExecutions = new Map();
    this.rebindProgress = new Map();
    this.inventoryExecutions = new Map();
    this.inventoryProgress = new Map();
    this.continuousExecutions = new Map();
    this.continuousRuns = new Map();
  }

  #setContinuousRun(runId, update) {
    const previous = this.continuousRuns.get(runId) || {};
    const run = {
      id: runId, state: "QUEUED", message: "连续库存任务已进入后台队列。",
      platform: "shopee",
      startingPlanId: runId, currentPlanId: runId, completedBatches: 0, estimatedBatches: 1,
      successfulProducts: 0, failedProducts: 0, exceptionCount: 0, exceptions: [], terminal: false,
      ...previous, ...update, updatedAt: this.now().toISOString(),
    };
    this.continuousRuns.set(runId, run);
    if (this.continuousRuns.size > 20) this.continuousRuns.delete(this.continuousRuns.keys().next().value);
    return structuredClone(run);
  }

  async getContinuousRun(runId) {
    const run = this.continuousRuns.get(text(runId));
    if (!run) throw fail("连续库存任务不存在。", "INVENTORY_SYNC_CONTINUOUS_RUN_NOT_FOUND", 404);
    return { run: structuredClone(run) };
  }

  async startContinuousExecution({ planId, approvalText = "", actorId = "local_session" }) {
    const id = text(planId);
    const plan = await this.operationPlans.get(id);
    if (!plan || !isInventoryOperationType(plan.operationType)) {
      throw fail("库存同步计划不存在。", "INVENTORY_SYNC_PLAN_NOT_FOUND", 404);
    }
    if (!new Set(["PREVIEWED", "APPROVED", "SUCCEEDED", "FAILED", "UNKNOWN", "EXPIRED"]).has(plan.state)) {
      throw fail("当前计划状态不能启动连续处理。", "INVENTORY_SYNC_CONTINUOUS_STATE_INVALID", 409);
    }
    if (this.continuousExecutions.has(id)) return this.getContinuousRun(id);
    const initial = this.#setContinuousRun(id, {
      state: "RUNNING", message: "后台连续处理已启动。", currentPlanId: id,
      platform: inventoryPlatform(plan.scope?.platform),
      estimatedBatches: Math.max(1, Number(plan.summary?.productBatchCount || 1)), terminal: false,
    });
    const task = this.#runContinuousExecution(id, plan, actorId, text(approvalText))
      .catch((error) => this.#setContinuousRun(id, {
        state: "FAILED", message: String(error?.message || "后台连续处理失败。"), terminal: true,
      }))
      .finally(() => this.continuousExecutions.delete(id));
    this.continuousExecutions.set(id, task);
    return { run: initial };
  }

  async #runContinuousExecution(runId, startingPlan, actorId, initialApprovalText = "") {
    const deferredProducts = new Map();
    for (const product of startingPlan.scope?.excludedProducts || []) {
      const shopId = text(product?.shopId);
      const internalId = text(product?.internalId);
      if (shopId && internalId) deferredProducts.set(`${shopId}\u0000${internalId}`, { shopId, internalId });
    }
    const exceptions = new Map();
    let current = startingPlan;
    let pendingApprovalText = initialApprovalText;
    let completedBatches = 0;
    let successfulProducts = 0;
    let failedProducts = 0;
    for (let guard = 0; guard < 200; guard += 1) {
      if (current.state === "UNKNOWN") {
        const jobId = text(current.result?.jobId);
        if (!jobId) throw new Error("库存写入结果未知且缺少马帮任务号，连续处理已安全停止。");
        const batchNumber = Math.max(1, completedBatches);
        exceptions.set(`READBACK:${jobId}`, {
          source: "回读超时", batch: batchNumber, shopId: "", shopName: "",
          internalId: "", productId: "", title: "", variationId: "", sellerSku: "",
          reasonCode: current.lastErrorCode || "INVENTORY_SYNC_READBACK_TIMEOUT",
          message: `马帮任务 ${jobId} 已提交；超时已记录，后台继续追踪原任务。`,
        });
        this.#setContinuousRun(runId, {
          state: "RUNNING", currentPlanId: current.id,
          message: "回读超时已记录，正在继续追踪原马帮任务。",
          completedBatches, exceptionCount: exceptions.size, exceptions: [...exceptions.values()], terminal: false,
        });
        let job = null;
        while (!job) {
          try {
            job = await this.listingClient.waitForJob(jobId, {
              timeoutMs: 30 * 60_000,
              onProgress: (progress) => this.#setContinuousRun(runId, {
                state: "RUNNING", currentPlanId: current.id,
                message: progress.message || "正在继续追踪原马帮任务。",
                stage: "RECOVERING", batchProcessed: Number(progress.processed_products || 0),
                batchTotal: Number(progress.total_products || current.summary?.uniqueProductCount || 0),
                batchSuccessful: Number(progress.successful_products || 0),
                batchFailed: Number(progress.failed_products || 0),
              }),
            });
          } catch (error) {
            if (error?.code !== "INVENTORY_SYNC_READBACK_TIMEOUT") throw error;
            this.#setContinuousRun(runId, {
              state: "RUNNING", currentPlanId: current.id,
              message: "原马帮任务仍在运行；已记录本次超时并继续追踪，不会重复提交。",
              stage: "RECOVERING", exceptionCount: exceptions.size, exceptions: [...exceptions.values()], terminal: false,
            });
          }
        }
        const success = text(job.state).toLowerCase() === "completed" && Number(job.failed_products || 0) === 0;
        current = await this.operationPlans.reconcileUnknown(current.id, success ? "SUCCEEDED" : "FAILED", {
          result: {
            jobId, state: job.state, successfulProducts: job.successful_products,
            failedProducts: job.failed_products, results: job.results || [],
          },
          evidence: { source: "mabang_job_recovery_after_readback_timeout", jobId, observedAt: this.now().toISOString() },
          actorId: `${actorId}:continuous-recovery`,
          reasonCode: success ? "INVENTORY_SYNC_READBACK_RECOVERED" : "INVENTORY_SYNC_MABANG_PARTIAL_OR_FAILED",
          message: success ? null : (job.message || "马帮库存批次存在失败项。"),
        });
        completedBatches = Math.max(1, completedBatches);
        continue;
      }
      if (["SUCCEEDED", "FAILED", "EXPIRED"].includes(current.state)) {
        const failures = collectContinuousExceptions(current, Math.max(1, completedBatches), deferredProducts, exceptions);
        if (current.state === "FAILED" && failures === 0) {
          throw new Error(current.lastErrorMessage || "当前批次发生无法隔离的全局错误，连续处理已停止。");
        }
        // A continuous pass should advance through the remaining product pool.
        // Products already attempted in this pass stay retained even if live sales
        // make them differ again before the later batches have had their first turn.
        retainContinuousAttemptedProducts(current, deferredProducts);
        successfulProducts += Number(current.result?.successfulProducts || 0);
        failedProducts += Number(current.result?.failedProducts || 0);
        this.#setContinuousRun(runId, {
          state: "RUNNING", message: "正在刷新库存并生成下一批。", completedBatches,
          successfulProducts, failedProducts, exceptionCount: exceptions.size, exceptions: [...exceptions.values()],
        });
        const pools = current.scope?.inventoryPools || [];
        const warehouseNames = [...new Set(pools.flatMap((pool) => pool.warehouseNames || []))];
        const platform = inventoryPlatform(current.scope?.platform);
        const prepared = await this.prepare({ accountProfileId: current.scope.accountProfileId, platform, forceRefresh: false, warehouseNames });
        const next = await this.preview({
          snapshotId: prepared.snapshot.id, accountProfileId: current.scope.accountProfileId,
          platform,
          inventoryPools: pools, safetyStock: current.policy?.safetyStock, perListingCap: current.policy?.perListingCap,
          multiWarehouseMode: current.policy?.multiWarehouseMode, productBatchNumber: 1,
          excludedProducts: [...deferredProducts.values()], actorId: `${actorId}:continuous`,
        });
        pendingApprovalText = next.approvalText;
        current = await this.operationPlans.get(next.plan.id);
        collectContinuousExceptions(current, completedBatches + 1, deferredProducts, exceptions);
        this.#setContinuousRun(runId, {
          currentPlanId: current.id, estimatedBatches: completedBatches + Math.max(1, Number(current.summary?.productBatchCount || 1)),
          exceptionCount: exceptions.size, exceptions: [...exceptions.values()],
        });
        if (!Number(current.summary?.readyCount || 0)) {
          return this.#setContinuousRun(runId, {
            state: "COMPLETED", message: "所有可执行店铺商品已处理完成。", terminal: true,
            completedBatches, successfulProducts, failedProducts,
            exceptionCount: exceptions.size, exceptions: [...exceptions.values()],
          });
        }
      }
      if (current.state === "PREVIEWED") {
        current = await this.operationPlans.approve(current.id, {
          planHash: current.planHash, approvalText: pendingApprovalText, actorId: `${actorId}:continuous`,
        });
      }
      if (current.state !== "APPROVED") throw new Error(`连续处理无法执行状态 ${current.state}。`);
      this.#setContinuousRun(runId, {
        state: "RUNNING", currentPlanId: current.id,
        message: `正在执行第 ${completedBatches + 1} 批。`, completedBatches,
      });
      current = await this.execute({
        planId: current.id, planHash: current.planHash,
        onProgress: (progress) => this.#setContinuousRun(runId, {
          state: "RUNNING", currentPlanId: current.id, message: progress.message,
          stage: progress.stage, batchProcessed: progress.processedCount, batchTotal: progress.totalCount,
          batchSuccessful: progress.successfulCount, batchFailed: progress.failedCount,
        }),
      });
      completedBatches += 1;
    }
    throw new Error("连续处理超过安全批次数限制。 ");
  }

  #setInventoryProgress(planId, update) {
    const previous = this.inventoryProgress.get(planId) || {};
    const progress = {
      planId,
      stage: "QUEUED",
      percent: 0,
      message: "任务已进入执行队列。",
      totalCount: 0,
      processedCount: 0,
      successfulCount: 0,
      failedCount: 0,
      jobId: null,
      terminal: false,
      ...previous,
      ...update,
      updatedAt: this.now().toISOString(),
    };
    progress.percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
    this.inventoryProgress.set(planId, progress);
    if (this.inventoryProgress.size > 50) this.inventoryProgress.delete(this.inventoryProgress.keys().next().value);
    return progress;
  }

  async getInventoryProgress(planId) {
    const id = text(planId);
    const plan = await this.operationPlans.get(id);
    if (!plan || !isInventoryOperationType(plan.operationType)) {
      throw fail("库存同步计划不存在。", "INVENTORY_SYNC_PLAN_NOT_FOUND", 404);
    }
    let progress = this.inventoryProgress.get(id);
    if (!progress) {
      const terminal = ["SUCCEEDED", "FAILED", "UNKNOWN", "BLOCKED", "EXPIRED"].includes(plan.state);
      progress = this.#setInventoryProgress(id, {
        stage: terminal ? plan.state : (plan.state === "IN_FLIGHT" ? "RECOVERING" : "IDLE"),
        percent: plan.state === "SUCCEEDED" ? 100 : (plan.state === "IN_FLIGHT" ? 50 : 0),
        message: plan.state === "IN_FLIGHT" ? "服务正在恢复任务状态，请稍后刷新。" : (plan.lastErrorMessage || stateProgressMessage(plan.state).replaceAll("换绑", "库存同步")),
        totalCount: Number(plan.summary?.readyCount || 0),
        terminal,
      });
    }
    return { plan: publicPlan(plan), progress };
  }

  async startInventoryExecution({ planId, planHash }) {
    const id = text(planId);
    const plan = await this.operationPlans.get(id);
    if (!plan || !isInventoryOperationType(plan.operationType)) {
      throw fail("库存同步计划不存在。", "INVENTORY_SYNC_PLAN_NOT_FOUND", 404);
    }
    if (this.inventoryExecutions.has(id)) return this.getInventoryProgress(id);
    if (plan.state !== "APPROVED") {
      throw fail("库存同步计划尚未批准或已不可执行。", "INVENTORY_SYNC_PLAN_NOT_APPROVED", 409);
    }
    const initial = this.#setInventoryProgress(id, {
      stage: "QUEUED",
      percent: 2,
      message: "库存同步已启动，正在准备安全检查。",
      totalCount: Number(plan.summary?.readyCount || 0),
      terminal: false,
    });
    const task = this.execute({
      planId: id,
      planHash,
      onProgress: (update) => this.#setInventoryProgress(id, update),
    }).then((finished) => {
      const succeeded = finished.state === "SUCCEEDED";
      this.#setInventoryProgress(id, {
        stage: finished.state,
        percent: succeeded ? 100 : Number(this.inventoryProgress.get(id)?.percent || 0),
        message: succeeded ? "库存写入与马帮任务回读已完成。" : (finished.lastErrorMessage || "库存任务已结束，请检查结果。"),
        terminal: true,
      });
      return finished;
    }).catch((error) => {
      this.#setInventoryProgress(id, {
        stage: error?.plan?.state || "FAILED",
        message: String(error?.message || "库存同步执行失败。"),
        terminal: true,
      });
    }).finally(() => {
      this.inventoryExecutions.delete(id);
    });
    this.inventoryExecutions.set(id, task);
    return { plan: publicPlan(plan), progress: initial };
  }

  #setRebindProgress(planId, update) {
    const previous = this.rebindProgress.get(planId) || {};
    const progress = {
      planId,
      stage: "QUEUED",
      percent: 0,
      message: "任务已进入执行队列。",
      totalCount: 0,
      processedCount: 0,
      successfulCount: 0,
      failedCount: 0,
      jobId: null,
      terminal: false,
      ...previous,
      ...update,
      updatedAt: this.now().toISOString(),
    };
    progress.percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
    this.rebindProgress.set(planId, progress);
    if (this.rebindProgress.size > 50) this.rebindProgress.delete(this.rebindProgress.keys().next().value);
    return progress;
  }

  async getRebindProgress(planId) {
    const id = text(planId);
    const plan = await this.operationPlans.get(id);
    if (!plan || plan.operationType !== SKU_REBIND_OPERATION_TYPE) {
      throw fail("SKU 换绑计划不存在。", "SKU_REBIND_PLAN_NOT_FOUND", 404);
    }
    let progress = this.rebindProgress.get(id);
    if (!progress) {
      const terminal = ["SUCCEEDED", "FAILED", "UNKNOWN", "BLOCKED", "EXPIRED"].includes(plan.state);
      progress = this.#setRebindProgress(id, {
        stage: terminal ? plan.state : (plan.state === "IN_FLIGHT" ? "RECOVERING" : "IDLE"),
        percent: plan.state === "SUCCEEDED" ? 100 : (plan.state === "IN_FLIGHT" ? 50 : 0),
        message: plan.state === "IN_FLIGHT" ? "服务正在恢复任务状态，请稍后刷新。" : (plan.lastErrorMessage || stateProgressMessage(plan.state)),
        totalCount: Number(plan.summary?.readyCount || 0),
        terminal,
      });
    }
    return { plan: publicPlan(plan), progress };
  }

  async startRebindExecution({ planId, planHash }) {
    const id = text(planId);
    const plan = await this.operationPlans.get(id);
    if (!plan || plan.operationType !== SKU_REBIND_OPERATION_TYPE) {
      throw fail("SKU 换绑计划不存在。", "SKU_REBIND_PLAN_NOT_FOUND", 404);
    }
    if (this.rebindExecutions.has(id)) return this.getRebindProgress(id);
    if (plan.state !== "APPROVED") {
      throw fail("SKU 换绑计划尚未批准或已不可执行。", "SKU_REBIND_PLAN_NOT_APPROVED", 409);
    }
    const initial = this.#setRebindProgress(id, {
      stage: "QUEUED",
      percent: 2,
      message: "任务已启动，正在准备安全检查。",
      totalCount: Number(plan.summary?.readyCount || 0),
      terminal: false,
    });
    const task = this.executeRebind({
      planId: id,
      planHash,
      onProgress: (update) => this.#setRebindProgress(id, update),
    }).then((finished) => {
      const succeeded = finished.state === "SUCCEEDED";
      this.#setRebindProgress(id, {
        stage: finished.state,
        percent: succeeded ? 100 : Number(this.rebindProgress.get(id)?.percent || 0),
        message: succeeded ? "换绑完成，在线回读结果全部一致。" : (finished.lastErrorMessage || "换绑任务已结束，请检查结果。"),
        terminal: true,
      });
      return finished;
    }).catch((error) => {
      this.#setRebindProgress(id, {
        stage: error?.plan?.state || "FAILED",
        message: String(error?.message || "SKU 换绑执行失败。"),
        terminal: true,
      });
    }).finally(() => {
      this.rebindExecutions.delete(id);
    });
    this.rebindExecutions.set(id, task);
    return { plan: publicPlan(plan), progress: initial };
  }

  async status() {
    const [shopeePlans, lazadaPlans, rebindPlans] = await Promise.all([
      this.operationPlans.list({ operationType: INVENTORY_SYNC_OPERATION_TYPE, limit: 20 }),
      this.operationPlans.list({ operationType: LAZADA_INVENTORY_SYNC_OPERATION_TYPE, limit: 20 }),
      this.operationPlans.list({ operationType: SKU_REBIND_OPERATION_TYPE, limit: 20 }),
    ]);
    return {
      mode: "mabang_internal_api",
      platform: "multi",
      platforms: ["shopee", "lazada"],
      officialApiRequired: false,
      accounts: this.accountRepository.list().map(publicAccount),
      plans: [...shopeePlans, ...lazadaPlans].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 30).map(publicPlan),
      rebindPlans: rebindPlans.map(publicPlan),
      continuousRuns: [...this.continuousRuns.values()].map((run) => structuredClone(run)).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
    };
  }

  #account(accountProfileId) {
    const account = this.accountRepository.get(text(accountProfileId), { includeSecret: true });
    if (!account?.enabled || !account.encryptedPassword) {
      throw fail("请选择已启用且已保存密码的马帮账号。", "INVENTORY_SYNC_ACCOUNT_UNAVAILABLE", 409);
    }
    return account;
  }

  async #connect(account) {
    const service = await this.ensureListingService();
    if (!service?.ok) throw fail(service?.error || "马帮刊登服务不可用。", service?.errorCode || "MABANG_LISTING_UNAVAILABLE", 503);
    await this.listingClient.login({ username: account.username, password: decryptSecret(account.encryptedPassword) });
  }

  #platformShops(platform) {
    const normalized = inventoryPlatform(platform);
    if (normalized === "lazada" && typeof this.listingClient.lazadaShops === "function") return this.listingClient.lazadaShops();
    if (normalized === "shopee" && typeof this.listingClient.shopeeShops === "function") return this.listingClient.shopeeShops();
    return this.listingClient.shops(normalized);
  }

  #platformListings(platform, shopIds, options) {
    const normalized = inventoryPlatform(platform);
    if (normalized === "lazada" && typeof this.listingClient.lazadaListings === "function") return this.listingClient.lazadaListings(shopIds, options);
    if (normalized === "shopee" && typeof this.listingClient.shopeeListings === "function") return this.listingClient.shopeeListings(shopIds, options);
    return this.listingClient.listings(normalized, shopIds, options);
  }

  #setPrepareProgress(accountProfileId, update) {
    const accountId = text(accountProfileId);
    const progress = {
      accountProfileId: accountId,
      stage: "IDLE",
      percent: 0,
      message: "尚未开始读取库存。",
      terminal: false,
      ...(this.prepareProgress.get(accountId) || {}),
      ...update,
      updatedAt: this.now().toISOString(),
    };
    progress.percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
    this.prepareProgress.set(accountId, progress);
    return progress;
  }

  async getPrepareProgress(accountProfileId) {
    const account = this.#account(accountProfileId);
    const stored = this.prepareProgress.get(account.id) || this.#setPrepareProgress(account.id, {});
    const startedAtMs = Date.parse(stored.startedAt || "");
    return {
      progress: {
        ...stored,
        elapsedMs: Number.isFinite(startedAtMs)
          ? (stored.terminal ? Number(stored.elapsedMs || 0) : Math.max(0, Date.now() - startedAtMs))
          : Number(stored.elapsedMs || 0),
      },
    };
  }

  #setPreviewProgress(accountProfileId, update) {
    const accountId = text(accountProfileId);
    const progress = {
      accountProfileId: accountId,
      stage: "IDLE",
      percent: 0,
      message: "尚未开始马帮预检。",
      terminal: false,
      fetchedCount: 0,
      totalCount: 0,
      page: 0,
      pageCount: 0,
      elapsedMs: 0,
      ...(this.previewProgress.get(accountId) || {}),
      ...update,
      updatedAt: this.now().toISOString(),
    };
    progress.percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
    this.previewProgress.set(accountId, progress);
    return progress;
  }

  async getPreviewProgress(accountProfileId) {
    const account = this.#account(accountProfileId);
    return {
      progress: this.previewProgress.get(account.id) || this.#setPreviewProgress(account.id, {}),
    };
  }

  async warehouseCatalog({ accountProfileId }) {
    const account = this.#account(accountProfileId);
    const result = await this.runWorker({
      action: "inventory-warehouse-catalog",
      username: account.username,
      password: decryptSecret(account.encryptedPassword),
    });
    const catalog = result?.catalog || {};
    return {
      accountProfileId: account.id,
      options: Array.isArray(catalog.options)
        ? catalog.options.map((option) => ({ id: text(option.id), name: text(option.name) })).filter((option) => option.id && option.name)
        : [],
      fieldNames: Array.isArray(catalog.fieldNames) ? catalog.fieldNames.map(text).filter(Boolean) : [],
      candidateElements: Array.isArray(catalog.candidateElements) ? catalog.candidateElements.slice(0, 30) : [],
      endpointCandidates: Array.isArray(catalog.endpointCandidates) ? catalog.endpointCandidates.map(text).filter(Boolean).slice(0, 30) : [],
      candidateSelectCount: integer(catalog.candidateSelectCount),
      supportsWarehouseId: catalog.supportsWarehouseId === true,
      supportsWarehouseIdArr: catalog.supportsWarehouseIdArr === true,
      supportsWarehouseIdsArray: catalog.supportsWarehouseIdsArray === true,
    };
  }

  async warehouseScopeProbe({ accountProfileId, warehouseIds = [], validateExport = false }) {
    const account = this.#account(accountProfileId);
    const ids = [...new Set((Array.isArray(warehouseIds) ? warehouseIds : []).map(text).filter(Boolean))];
    if (!ids.length || ids.length > 5) {
      throw fail("仓库范围探测需要选择1至5个仓库。", "INVENTORY_SYNC_WAREHOUSE_PROBE_SCOPE_INVALID");
    }
    const result = await this.runWorker({
      action: "inventory-warehouse-scope-probe",
      username: account.username,
      password: decryptSecret(account.encryptedPassword),
      warehouseIds: ids,
      validateExport: validateExport === true,
    });
    return {
      accountProfileId: account.id,
      warehouseIds: Array.isArray(result.warehouseIds) ? result.warehouseIds.map(text) : [],
      warehouseNames: Array.isArray(result.warehouseNames) ? result.warehouseNames.map(text) : [],
      reportedRows: integer(result.reportedRows),
      parsedRows: integer(result.parsedRows),
      exportValidated: result.exportValidated === true,
      exportedWarehouses: Array.isArray(result.exportedWarehouses) ? result.exportedWarehouses.map(text) : [],
      unexpectedWarehouses: Array.isArray(result.unexpectedWarehouses) ? result.unexpectedWarehouses.map(text) : [],
    };
  }

  async inventoryPageContractProbe({ accountProfileId, warehouseNames = [], page = 1, rowsPerPage = 50 }) {
    const account = this.#account(accountProfileId);
    const names = [...new Set((Array.isArray(warehouseNames) ? warehouseNames : []).map(text).filter(Boolean))];
    if (names.length > 5) {
      throw fail("库存分页结构探测最多选择5个仓库。", "INVENTORY_SYNC_PAGE_PROBE_SCOPE_INVALID");
    }
    const result = await this.runWorker({
      action: "inventory-page-contract-probe",
      username: account.username,
      password: decryptSecret(account.encryptedPassword),
      warehouseNames: names,
      page: Math.max(1, integer(page, 1)),
      rowsPerPage: Math.max(1, Math.min(200, integer(rowsPerPage, 50))),
    });
    return {
      accountProfileId: account.id,
      scopeWarehouseNames: Array.isArray(result.scopeWarehouseNames) ? result.scopeWarehouseNames.map(text) : [],
      scopeWarehouseCount: integer(result.scopeWarehouseCount),
      searchContract: result.searchContract || {},
      searchMessageContract: result.searchMessageContract || {},
      contract: result.contract || {},
      iframeContract: result.iframeContract || {},
    };
  }

  async inventoryHtmlPageProbe({ accountProfileId, warehouseNames = [], page = 1, rowsPerPage = 50 }) {
    const account = this.#account(accountProfileId);
    const names = [...new Set((Array.isArray(warehouseNames) ? warehouseNames : []).map(text).filter(Boolean))];
    if (!names.length || names.length > 5) {
      throw fail("库存 HTML 分页探测需要选择1至5个仓库。", "INVENTORY_SYNC_HTML_PAGE_PROBE_SCOPE_INVALID");
    }
    const result = await this.runWorker({
      action: "inventory-html-page-probe",
      username: account.username,
      password: decryptSecret(account.encryptedPassword),
      warehouseNames: names,
      page: Math.max(1, integer(page, 1)),
      rowsPerPage: Math.max(1, Math.min(200, integer(rowsPerPage, 50))),
    });
    return {
      accountProfileId: account.id,
      page: integer(result.page),
      rowsPerPage: integer(result.rowsPerPage),
      parsedRows: integer(result.parsedRows),
      warehouseCount: integer(result.warehouseCount),
      pageHash: text(result.pageHash),
      durationMs: integer(result.durationMs),
    };
  }

  async inventoryHtmlFullProbe({ accountProfileId, warehouseNames = [] }) {
    const account = this.#account(accountProfileId);
    const names = [...new Set((Array.isArray(warehouseNames) ? warehouseNames : []).map(text).filter(Boolean))];
    if (!names.length || names.length > 5) {
      throw fail("库存 HTML 完整探测需要选择1至5个仓库。", "INVENTORY_SYNC_HTML_FULL_PROBE_SCOPE_INVALID");
    }
    const result = await this.runWorker({
      action: "inventory-html-full-probe",
      username: account.username,
      password: decryptSecret(account.encryptedPassword),
      warehouseNames: names,
    });
    return {
      accountProfileId: account.id,
      reportedRows: integer(result.reportedRows),
      parsedRows: integer(result.parsedRows),
      uniqueSkuCount: integer(result.uniqueSkuCount),
      normalizedUniqueSkuCount: integer(result.normalizedUniqueSkuCount),
      normalizationCollisionCount: integer(result.normalizationCollisionCount),
      normalizedIdentityCount: integer(result.normalizedIdentityCount),
      identityCollisionCount: integer(result.identityCollisionCount),
      missingSkuCount: integer(result.missingSkuCount),
      missingWarehouseCount: integer(result.missingWarehouseCount),
      availableQuantity: Number(result.availableQuantity || 0),
      coreHash: text(result.coreHash),
      durationMs: integer(result.durationMs),
    };
  }

  #snapshotResponse(snapshot, reused = false) {
    const aggregate = aggregateInventory(snapshot.records, []);
    const summaries = new Map(aggregate.warehouses.map((warehouse) => [warehouse.name, warehouse]));
    const catalog = Array.isArray(snapshot.warehouseCatalog?.options) ? snapshot.warehouseCatalog.options : [];
    const warehouseNames = new Set([...catalog.map((option) => text(option.name)), ...summaries.keys()]);
    const catalogByName = new Map(catalog.map((option) => [text(option.name), text(option.id)]));
    return {
      snapshot: {
        id: snapshot.id,
        platform: inventoryPlatform(snapshot.platform),
        capturedAt: snapshot.capturedAt,
        expiresAt: snapshot.expiresAt,
        rowCount: Number(snapshot.sourceRowCount || snapshot.records.length),
        compactRowCount: snapshot.records.length,
        cacheUpdateTime: snapshot.summary?.cacheUpdateTime || null,
        hash: snapshot.hash,
        reused,
        scoped: Array.isArray(snapshot.scopeWarehouseNames) && snapshot.scopeWarehouseNames.length > 0,
        scopeWarehouseNames: snapshot.scopeWarehouseNames || [],
        readMetrics: snapshot.readMetrics || null,
        sourceMode: text(snapshot.summary?.sourceMode),
        sourcePageCount: Number(snapshot.summary?.htmlPageCount || 0),
      },
      shops: (snapshot.shops || []).map((shop) => ({ id: text(shop.id), name: text(shop.name), site: text(shop.site) })),
      warehouses: [...warehouseNames].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN")).map((name) => ({
        id: catalogByName.get(name) || "",
        name,
        rowCount: Number(summaries.get(name)?.rowCount || 0),
        availableQuantity: Number(summaries.get(name)?.availableQuantity || 0),
        loaded: summaries.has(name),
      })),
      inventoryPools: Array.isArray(snapshot.configuredInventoryPools) ? snapshot.configuredInventoryPools : [],
    };
  }

  async #loadReusableSnapshot(accountProfileId, requestedWarehouseNames = [], platform = "shopee") {
    const normalizedPlatform = inventoryPlatform(platform);
    const requested = [...new Set(requestedWarehouseNames.map(text).filter(Boolean))].sort();
    const matchesScope = (snapshot) => {
      const existing = [...new Set((snapshot.scopeWarehouseNames || []).map(text).filter(Boolean))].sort();
      return !existing.length || JSON.stringify(existing) === JSON.stringify(requested);
    };
    const inMemory = [...this.snapshots.values()]
      .filter((snapshot) => snapshot.accountProfileId === accountProfileId && inventoryPlatform(snapshot.platform) === normalizedPlatform && snapshot.expiresAt > this.now().toISOString() && matchesScope(snapshot))
      .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))[0];
    if (inMemory) return inMemory;
    const persisted = await this.snapshotStore?.loadLatest(accountProfileId, normalizedPlatform);
    if (!persisted || persisted.expiresAt <= this.now().toISOString() || !matchesScope(persisted)) return null;
    this.snapshots.set(persisted.id, persisted);
    return persisted;
  }

  async #resolveSnapshot(snapshotId, accountProfileId, platform = "shopee") {
    const id = text(snapshotId);
    const accountId = text(accountProfileId);
    const inMemory = this.snapshots.get(id);
    const normalizedPlatform = inventoryPlatform(platform);
    if (inMemory?.accountProfileId === accountId && inventoryPlatform(inMemory.platform) === normalizedPlatform) return inMemory;
    const persisted = await this.snapshotStore?.loadLatest(accountId, normalizedPlatform);
    if (!persisted || persisted.id !== id) return null;
    this.snapshots.set(persisted.id, persisted);
    return persisted;
  }

  async prepare({ accountProfileId, platform = "shopee", forceRefresh = false, warehouseNames = [] }) {
    const normalizedPlatform = inventoryPlatform(platform);
    const account = this.#account(accountProfileId);
    const storedScope = await this.scopeStore?.load(account.id, normalizedPlatform);
    const storedPools = Array.isArray(storedScope?.inventoryPools) ? storedScope.inventoryPools : [];
    const explicitWarehouseNames = [...new Set((Array.isArray(warehouseNames) ? warehouseNames : []).map(text).filter(Boolean))];
    const requestedWarehouseNames = (explicitWarehouseNames.length
      ? explicitWarehouseNames
      : storedPools.flatMap((pool) => Array.isArray(pool?.warehouseNames) ? pool.warehouseNames : []))
      .map(text).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).sort();
    const taskKey = `${account.id}:${normalizedPlatform}:${contentHash(requestedWarehouseNames)}`;
    const running = this.prepareTasks.get(taskKey);
    if (running) return running;
    const task = this.#prepareAccount(account, normalizedPlatform, forceRefresh === true, requestedWarehouseNames, storedPools)
      .catch((error) => {
        const startedAtMs = Date.parse(this.prepareProgress.get(account.id)?.startedAt || "");
        this.#setPrepareProgress(account.id, {
          stage: "FAILED",
          message: String(error?.message || "库存读取失败。").slice(0, 300),
          terminal: true,
          elapsedMs: Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0,
        });
        throw error;
      })
      .finally(() => {
        if (this.prepareTasks.get(taskKey) === task) this.prepareTasks.delete(taskKey);
      });
    this.prepareTasks.set(taskKey, task);
    return task;
  }

  async previewConfigImport({ accountProfileId, snapshotId, platform = "shopee", filename, fileBase64 }) {
    const normalizedPlatform = inventoryPlatform(platform);
    const snapshot = await this.#resolveSnapshot(snapshotId, accountProfileId, normalizedPlatform);
    if (!snapshot || snapshot.accountProfileId !== text(accountProfileId)) {
      throw fail("库存快照不存在或已失效，请先读取库存和店铺。", "INVENTORY_SYNC_SNAPSHOT_MISSING", 409);
    }
    const safeFilename = text(filename);
    if (!/\.(xlsx|csv)$/i.test(safeFilename)) {
      throw fail("请选择 .xlsx 或 .csv 库存同步配置表。", "INVENTORY_SYNC_CONFIG_FILE_TYPE_INVALID");
    }
    const encoded = text(fileBase64).replace(/\s+/g, "");
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw fail("库存同步配置表内容无效。", "INVENTORY_SYNC_CONFIG_FILE_INVALID");
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > 1024 * 1024) {
      throw fail("库存同步配置表不能超过 1MB。", "INVENTORY_SYNC_CONFIG_FILE_TOO_LARGE", 413);
    }
    let parsed;
    try {
      parsed = parseInventorySyncConfigWorkbook({ filename: safeFilename, buffer });
    } catch (error) {
      throw fail(String(error?.message || "库存同步配置表解析失败。"), "INVENTORY_SYNC_CONFIG_PARSE_FAILED");
    }
    const source = this.#snapshotResponse(snapshot, false);
    const preview = buildInventoryConfigImportPreview({
      rows: parsed.rows,
      shops: source.shops,
      warehouseOptions: source.warehouses,
      selectedPlatform: platformLabel(normalizedPlatform),
    });
    return { filename: safeFilename, sheetName: parsed.sheetName, ...preview };
  }

  async #prepareAccount(account, platform, forceRefresh, requestedWarehouseNames, configuredInventoryPools) {
    const label = platformLabel(platform);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    this.#setPrepareProgress(account.id, {
      stage: "CACHE_CHECK",
      percent: 5,
      message: forceRefresh ? "已要求强制刷新，正在准备连接马帮。" : "正在检查可复用的库存快照。",
      terminal: false,
      startedAt,
      elapsedMs: 0,
      metrics: {},
    });
    if (!forceRefresh) {
      const cached = await this.#loadReusableSnapshot(account.id, requestedWarehouseNames, platform);
      if (cached) {
        if (!Array.isArray(cached.configuredInventoryPools) || !cached.configuredInventoryPools.length) {
          cached.configuredInventoryPools = configuredInventoryPools;
        }
        this.#setPrepareProgress(account.id, { stage: "REUSED", percent: 100, message: "已复用有效库存快照。", terminal: true, elapsedMs: Date.now() - startedAtMs });
        return this.#snapshotResponse(cached, true);
      }
    }
    this.#setPrepareProgress(account.id, { stage: "LOGIN", percent: 15, message: "正在登录马帮并初始化刊登会话。" });
    const loginStartedAtMs = Date.now();
    await this.#connect(account);
    const loginMs = Date.now() - loginStartedAtMs;
    this.#setPrepareProgress(account.id, { stage: "COLLECTING", percent: 30, message: `正在并行读取 ${label} 店铺并导出马帮库存。`, metrics: { loginMs } });
    let shopReadMs = 0;
    let inventoryReadMs = 0;
    const [shops, inventory] = await Promise.all([
      (async () => {
        const phaseStartedAtMs = Date.now();
        const result = await this.#platformShops(platform);
        shopReadMs = Date.now() - phaseStartedAtMs;
        return result;
      })(),
      (async () => {
        const phaseStartedAtMs = Date.now();
        const result = await this.runWorker({ action: "inventory", compact: true, warehouseNames: requestedWarehouseNames, username: account.username, password: decryptSecret(account.encryptedPassword) });
        inventoryReadMs = Date.now() - phaseStartedAtMs;
        return result;
      })(),
    ]);
    const readMetrics = { loginMs, shopReadMs, inventoryReadMs, totalMs: Date.now() - startedAtMs };
    this.#setPrepareProgress(account.id, { stage: "COMPACTING", percent: 85, message: "库存已下载，正在合并仓库与 SKU 数据。", metrics: readMetrics });
    const rawRecords = Array.isArray(inventory.records) ? inventory.records : [];
    const compacted = compactInventoryRecords(rawRecords);
    if (!compacted.records.length) throw fail("马帮库存查询没有返回可用记录。", "INVENTORY_SYNC_EMPTY_SNAPSHOT", 409);
    const snapshotId = randomUUID();
    const capturedAt = this.now().toISOString();
    const snapshot = {
      id: snapshotId,
      platform,
      accountProfileId: account.id,
      capturedAt,
      expiresAt: new Date(new Date(capturedAt).getTime() + SNAPSHOT_TTL_MS).toISOString(),
      sourceRowCount: Number(inventory.summary?.rows || compacted.sourceRowCount),
      scopeWarehouseNames: Array.isArray(inventory.summary?.scopeWarehouseNames) ? inventory.summary.scopeWarehouseNames.map(text).filter(Boolean) : requestedWarehouseNames,
      records: compacted.records,
      warehouseCatalog: inventory.warehouseCatalog || {},
      configuredInventoryPools,
      shops: shops.map((shop) => ({ id: text(shop.id), name: text(shop.name), site: text(shop.site) })),
      summary: inventory.summary || {},
      readMetrics,
      hash: contentHash(compacted.records),
    };
    this.snapshots.set(snapshotId, snapshot);
    this.#setPrepareProgress(account.id, { stage: "PERSISTING", percent: 95, message: "正在保存可复用库存快照。" });
    await this.snapshotStore?.save(snapshot);
    this.#setPrepareProgress(account.id, { stage: "COMPLETED", percent: 100, message: "库存快照读取完成。", terminal: true, elapsedMs: Date.now() - startedAtMs, metrics: { ...readMetrics, totalMs: Date.now() - startedAtMs } });
    return this.#snapshotResponse(snapshot, false);
  }

  async preview(input) {
    const accountProfileId = text(input?.accountProfileId);
    this.#setPreviewProgress(accountProfileId, {
      stage: "VALIDATING",
      percent: 3,
      message: "正在校验库存快照和库存池范围。",
      terminal: false,
      fetchedCount: 0,
      totalCount: 0,
      page: 0,
      pageCount: 0,
      elapsedMs: 0,
    });
    try {
      return await this.#previewAccount(input);
    } catch (error) {
      this.#setPreviewProgress(accountProfileId, {
        stage: "FAILED",
        message: String(error?.message || "马帮预检失败。").slice(0, 300),
        terminal: true,
      });
      throw error;
    }
  }

  async #previewAccount({ snapshotId, accountProfileId, platform = "shopee", shopIds = [], warehouseNames = [], inventoryPools = [], safetyStock = 5, perListingCap = 999, multiWarehouseMode = "block", productBatchNumber = null, selectedProducts = [], selectedItems = [], excludedProducts = [], actorId = "local_session" }) {
    const normalizedPlatform = inventoryPlatform(platform);
    const label = platformLabel(normalizedPlatform);
    const snapshot = await this.#resolveSnapshot(snapshotId, accountProfileId, normalizedPlatform);
    if (!snapshot || snapshot.accountProfileId !== text(accountProfileId)) {
      throw fail("库存快照不存在或已失效，请重新读取。", "INVENTORY_SYNC_SNAPSHOT_MISSING", 409);
    }
    if (snapshot.expiresAt <= this.now().toISOString()) {
      this.snapshots.delete(snapshot.id);
      throw fail("库存快照已超过15分钟，请重新读取。", "INVENTORY_SYNC_SNAPSHOT_EXPIRED", 409);
    }
    const normalizedPools = normalizeInventoryPools(inventoryPools, shopIds, warehouseNames, normalizedPlatform);
    const visibleShopIds = new Set((snapshot.shops || []).map((shop) => text(shop.id)).filter(Boolean));
    const knownWarehouseNames = new Set([
      ...(snapshot.warehouseCatalog?.options || []).map((option) => text(option?.name)).filter(Boolean),
      ...(snapshot.records || []).map((record) => text(record?.["仓库"])).filter(Boolean),
    ]);
    const snapshotScope = new Set((snapshot.scopeWarehouseNames || []).map(text).filter(Boolean));
    const scopeExceptions = [];
    const activePools = [];
    for (const pool of normalizedPools) {
      const shopId = pool.shopIds[0] || "";
      const missingWarehouses = pool.warehouseNames.filter((name) => !knownWarehouseNames.has(name));
      const unloadedWarehouses = snapshotScope.size ? pool.warehouseNames.filter((name) => !snapshotScope.has(name)) : [];
      let reasonCode = "";
      let message = "";
      if (!visibleShopIds.has(shopId)) {
        reasonCode = "SHOP_NOT_FOUND";
        message = `当前马帮账号未找到 ${label} 店铺 ${shopId}`;
      } else if (missingWarehouses.length) {
        reasonCode = "WAREHOUSE_NOT_FOUND";
        message = `未找到来源仓库：${missingWarehouses.join("、")}`;
      } else if (unloadedWarehouses.length) {
        reasonCode = "WAREHOUSE_OUTSIDE_SNAPSHOT";
        message = `本次快照未读取仓库：${unloadedWarehouses.join("、")}；请强制刷新`;
      }
      if (!reasonCode) {
        activePools.push(pool);
        continue;
      }
      scopeExceptions.push({
        platform: normalizedPlatform, shopId, shopName: text((snapshot.shops || []).find((shop) => text(shop.id) === shopId)?.name) || shopId,
        internalId: `scope:${pool.id}`, productId: "", title: pool.name, variationId: "", sellerSku: "", stockSku: "",
        currentStock: 0, targetStock: null, inventoryPoolId: pool.id, inventoryPoolName: pool.name,
        status: "BLOCKED", reasonCode, message,
      });
    }
    const selectedShops = activePools.flatMap((pool) => pool.shopIds);
    const selectedWarehouses = activePools.flatMap((pool) => pool.warehouseNames);
    const normalizedMultiWarehouseMode = text(multiWarehouseMode).toLowerCase() || "block";
    if (!new Set(["block", "single_largest", "proportional"]).has(normalizedMultiWarehouseMode)) {
      throw fail("多仓写入策略不受支持。", "INVENTORY_SYNC_MULTI_WAREHOUSE_MODE_INVALID");
    }
    const policy = {
      version: 3,
      allocationMode: "equal_share",
      multiWarehouseMode: normalizedMultiWarehouseMode,
      safetyStock: Math.min(100000, integer(safetyStock, 5)),
      perListingCap: Math.max(1, Math.min(9_999_999, integer(perListingCap, 999))),
      maxExecutableProducts: MAX_EXECUTABLE_PRODUCTS,
    };
    const account = this.#account(accountProfileId);
    this.#setPreviewProgress(account.id, { stage: "LOGIN", percent: 8, message: "正在确认马帮刊登会话。" });
    await this.#connect(account);
    this.#setPreviewProgress(account.id, { stage: "LISTINGS", percent: 12, message: `正在读取 ${selectedShops.length} 个店铺的在线商品。` });
    const listings = await this.#platformListings(normalizedPlatform, selectedShops, {
      refresh: true,
      onProgress: (current) => {
        const total = Number(current?.total || 0);
        const fetched = Number(current?.fetched || 0);
        const ratio = total > 0 ? fetched / total : 0;
        const retrying = current?.stage === "RETRYING";
        this.#setPreviewProgress(account.id, {
          stage: retrying ? "RETRYING" : "LISTINGS",
          percent: Math.min(82, 12 + Math.round(ratio * 70)),
          message: retrying
            ? `第 ${current.page || 1} 页读取失败，正在进行第 ${current.retry || 1} 次重试。`
            : `在线商品已读取 ${fetched}/${total} 条，第 ${current.page || 1}/${current.pageCount || "?"} 页。`,
          fetchedCount: fetched,
          totalCount: total,
          page: Number(current?.page || 0),
          pageCount: Number(current?.pageCount || 0),
          elapsedMs: Number(current?.elapsedMs || 0),
        });
      },
    });
    if (selectedShops.length && !listings.length) {
      for (const pool of activePools) {
        const shopId = pool.shopIds[0] || "";
        scopeExceptions.push({
          platform: normalizedPlatform, shopId, shopName: text((snapshot.shops || []).find((shop) => text(shop.id) === shopId)?.name) || shopId,
          internalId: `scope:${pool.id}:listings`, productId: "", title: pool.name, variationId: "", sellerSku: "", stockSku: "",
          currentStock: 0, targetStock: null, inventoryPoolId: pool.id, inventoryPoolName: pool.name,
          status: "BLOCKED", reasonCode: "ONLINE_LISTINGS_EMPTY", message: `未读取到 ${label} 在线商品，已跳过该库存池`,
        });
      }
    }
    this.#setPreviewProgress(account.id, { stage: "CALCULATING", percent: 87, message: "在线商品读取完成，正在计算库存差异。" });
    const allItems = [...scopeExceptions, ...activePools.flatMap((pool) => {
      const inventory = aggregateInventory(snapshot.records, pool.warehouseNames);
      const rows = flattenListings(listings, pool.shopIds, normalizedPlatform).map((row) => ({
        ...row,
        inventoryPoolId: pool.id,
        inventoryPoolName: pool.name,
      }));
      return buildPlanItems(rows, inventory.bySku, policy);
    })];
    const allReadyProductKeys = [...new Set(allItems
      .filter((item) => item.status === "READY")
      .map((item) => `${item.shopId}\u0000${item.internalId}`))].sort();
    const normalizedSelectedProducts = [...new Map((Array.isArray(selectedProducts) ? selectedProducts : [])
      .map((product) => ({ shopId: text(product?.shopId), internalId: text(product?.internalId) }))
      .filter((product) => product.shopId && product.internalId)
      .map((product) => [`${product.shopId}\u0000${product.internalId}`, product])).values()];
    if (normalizedSelectedProducts.length > 3) {
      throw fail("专项验证一次最多选择 3 个商品。", "INVENTORY_SYNC_SELECTED_PRODUCT_LIMIT", 409);
    }
    const normalizedSelectedItems = [...new Map((Array.isArray(selectedItems) ? selectedItems : [])
      .map((item) => ({ shopId: text(item?.shopId), internalId: text(item?.internalId), variationId: text(item?.variationId) }))
      .filter((item) => item.shopId && item.internalId && item.variationId)
      .map((item) => [`${item.shopId}\u0000${item.internalId}\u0000${item.variationId}`, item])).values()];
    const normalizedExcludedProducts = [...new Map((Array.isArray(excludedProducts) ? excludedProducts : [])
      .map((product) => ({ shopId: text(product?.shopId), internalId: text(product?.internalId) }))
      .filter((product) => product.shopId && product.internalId)
      .map((product) => [`${product.shopId}\u0000${product.internalId}`, product])).values()];
    if (normalizedExcludedProducts.length > 2_000) {
      throw fail("单次连续处理最多保留 2000 个延后商品。", "INVENTORY_SYNC_EXCLUDED_PRODUCT_LIMIT", 409);
    }
    if (normalizedSelectedItems.length > MAX_EXECUTABLE_VARIANTS) {
      throw fail(`精确规格批次一次最多选择 ${MAX_EXECUTABLE_VARIANTS} 个规格。`, "INVENTORY_SYNC_SELECTED_ITEM_LIMIT", 409);
    }
    if (normalizedSelectedProducts.length && normalizedSelectedItems.length) {
      throw fail("商品级与规格级专项范围不能同时使用。", "INVENTORY_SYNC_SELECTION_CONFLICT", 409);
    }
    const requestedProductKeys = new Set(normalizedSelectedProducts.map((product) => `${product.shopId}\u0000${product.internalId}`));
    for (const item of normalizedSelectedItems) requestedProductKeys.add(`${item.shopId}\u0000${item.internalId}`);
    const requestedItemKeys = new Set(normalizedSelectedItems.map((item) => `${item.shopId}\u0000${item.internalId}\u0000${item.variationId}`));
    const excludedProductKeys = new Set(normalizedExcludedProducts.map((product) => `${product.shopId}\u0000${product.internalId}`));
    const allProductStatuses = new Map();
    for (const item of allItems) {
      const key = `${item.shopId}\u0000${item.internalId}`;
      const statuses = allProductStatuses.get(key) || new Set();
      statuses.add(item.status);
      allProductStatuses.set(key, statuses);
    }
    const totalVariantCount = allItems.length;
    const totalReadyVariantCount = allItems.filter((item) => item.status === "READY").length;
    const totalUnchangedVariantCount = allItems.filter((item) => item.status === "UNCHANGED").length;
    const totalBlockedVariantCount = allItems.filter((item) => item.status === "BLOCKED").length;
    const blockedOnlyProductCount = [...allProductStatuses.values()].filter((statuses) => statuses.has("BLOCKED") && !statuses.has("READY")).length;
    const totalReadyProductCount = allReadyProductKeys.length;
    const missingSelectedProducts = normalizedSelectedProducts.filter((product) => !allProductStatuses.has(`${product.shopId}\u0000${product.internalId}`));
    if (missingSelectedProducts.length) {
      throw fail("专项验证商品不在本次在线商品结果中，请刷新后重试。", "INVENTORY_SYNC_SELECTED_PRODUCT_NOT_FOUND", 409, { missingSelectedProducts });
    }
    const selectedProductsWithoutReadyItems = normalizedSelectedProducts.filter((product) => !allReadyProductKeys.includes(`${product.shopId}\u0000${product.internalId}`));
    if (selectedProductsWithoutReadyItems.length) {
      throw fail("专项验证商品没有可执行的库存差异，请检查阻断原因或当前库存。", "INVENTORY_SYNC_SELECTED_PRODUCT_NOT_READY", 409, { selectedProducts: selectedProductsWithoutReadyItems });
    }
    const allItemsByKey = new Map(allItems.map((item) => [`${item.shopId}\u0000${item.internalId}\u0000${item.variationId}`, item]));
    const missingSelectedItems = normalizedSelectedItems.filter((item) => !allItemsByKey.has(`${item.shopId}\u0000${item.internalId}\u0000${item.variationId}`));
    if (missingSelectedItems.length) {
      throw fail("专项验证规格不在本次在线商品结果中，请刷新后重试。", "INVENTORY_SYNC_SELECTED_ITEM_NOT_FOUND", 409, { missingSelectedItems });
    }
    const selectedItemsWithoutReadyStatus = normalizedSelectedItems.filter((item) => allItemsByKey.get(`${item.shopId}\u0000${item.internalId}\u0000${item.variationId}`)?.status !== "READY");
    if (selectedItemsWithoutReadyStatus.length) {
      throw fail("专项验证规格没有可执行的库存差异，请检查阻断原因或当前库存。", "INVENTORY_SYNC_SELECTED_ITEM_NOT_READY", 409, { selectedItems: selectedItemsWithoutReadyStatus });
    }
    const scopedReadyProductKeysBeforeExclusion = requestedProductKeys.size
      ? allReadyProductKeys.filter((key) => requestedProductKeys.has(key))
      : allReadyProductKeys;
    const scopedReadyProductKeys = scopedReadyProductKeysBeforeExclusion.filter((key) => !excludedProductKeys.has(key));
    const scopedReadyProductCount = scopedReadyProductKeys.length;
    const readyVariantCountByProduct = new Map();
    for (const item of allItems) {
      if (item.status !== "READY") continue;
      const key = `${item.shopId}\u0000${item.internalId}`;
      readyVariantCountByProduct.set(key, (readyVariantCountByProduct.get(key) || 0) + 1);
    }
    const productBatches = [];
    if (requestedItemKeys.size) {
      productBatches.push(scopedReadyProductKeys);
    } else {
      let currentBatch = [];
      let currentVariantCount = 0;
      for (const productKey of scopedReadyProductKeys) {
        const productVariantCount = Number(readyVariantCountByProduct.get(productKey) || 0);
        if (productVariantCount > MAX_EXECUTABLE_VARIANTS) {
          throw fail(
            `单个商品包含 ${productVariantCount} 个待写变体，超过单批安全上限 ${MAX_EXECUTABLE_VARIANTS} 个；为避免拆散商品，已停止生成计划。`,
            "INVENTORY_SYNC_SINGLE_PRODUCT_VARIANT_LIMIT",
            409,
            { productKey, productVariantCount, maxExecutableVariants: MAX_EXECUTABLE_VARIANTS },
          );
        }
        const exceedsProductLimit = currentBatch.length >= MAX_EXECUTABLE_PRODUCTS;
        const exceedsVariantLimit = currentBatch.length > 0 && currentVariantCount + productVariantCount > MAX_EXECUTABLE_VARIANTS;
        if (exceedsProductLimit || exceedsVariantLimit) {
          productBatches.push(currentBatch);
          currentBatch = [];
          currentVariantCount = 0;
        }
        currentBatch.push(productKey);
        currentVariantCount += productVariantCount;
      }
      if (currentBatch.length) productBatches.push(currentBatch);
    }
    const productBatchCount = Math.max(1, productBatches.length);
    const requestedBatchNumber = productBatchNumber === null || productBatchNumber === undefined || productBatchNumber === ""
      ? null
      : integer(productBatchNumber, 0);
    if (productBatchCount > 1 && requestedBatchNumber === null) {
      throw fail(
        `本次预览涉及 ${scopedReadyProductCount} 个待写商品，需同时满足每批最多 ${MAX_EXECUTABLE_PRODUCTS} 个商品和 ${MAX_EXECUTABLE_VARIANTS} 个变体；请按 ${productBatchCount} 批生成预览。`,
        "INVENTORY_SYNC_PRODUCT_LIMIT",
        409,
        { totalReadyProductCount, totalReadyVariantCount, productBatchCount, maxExecutableProducts: MAX_EXECUTABLE_PRODUCTS, maxExecutableVariants: MAX_EXECUTABLE_VARIANTS },
      );
    }
    if (requestedBatchNumber !== null && (requestedBatchNumber < 1 || requestedBatchNumber > productBatchCount)) {
      throw fail(`商品批次必须在 1 至 ${productBatchCount} 之间。`, "INVENTORY_SYNC_PRODUCT_BATCH_INVALID", 409);
    }
    const activeBatchNumber = requestedBatchNumber || 1;
    const isBatched = productBatchCount > 1;
    const selectedProductKeys = new Set(isBatched
      ? productBatches[activeBatchNumber - 1]
      : scopedReadyProductKeys);
    const batchItems = requestedItemKeys.size
      ? allItems.filter((item) => requestedItemKeys.has(`${item.shopId}\u0000${item.internalId}\u0000${item.variationId}`))
      : (isBatched || requestedProductKeys.size
        ? allItems.filter((item) => selectedProductKeys.has(`${item.shopId}\u0000${item.internalId}`))
        : allItems);
    const retainedBlockedItems = requestedProductKeys.size || requestedItemKeys.size
      ? []
      : allItems.filter((item) => item.status === "BLOCKED");
    const deferredItems = allItems
      .filter((item) => item.status === "READY" && excludedProductKeys.has(`${item.shopId}\u0000${item.internalId}`))
      .map((item) => ({
        ...item,
        status: "BLOCKED",
        reasonCode: "DEFERRED_AFTER_BATCH_FAILURE",
        targetStock: null,
      }));
    const items = [...new Map([...batchItems, ...retainedBlockedItems, ...deferredItems]
      .map((item) => [targetIdentity(item), item])).values()];
    const ready = items.filter((item) => item.status === "READY");
    const poolSnapshots = activePools.map((pool) => {
      const poolReady = ready.filter((item) => item.inventoryPoolId === pool.id);
      const readyStockSkus = [...new Set(poolReady.map((item) => item.stockSku).filter(Boolean))];
      return {
        id: pool.id,
        name: pool.name,
        shopIds: pool.shopIds,
        warehouseNames: pool.warehouseNames,
        inventoryScopeHash: inventoryScopeHash(snapshot.records, pool.warehouseNames),
        executionInventoryHash: inventoryScopeHash(snapshot.records, pool.warehouseNames, readyStockSkus),
        readyStockSkus,
      };
    });
    const selectedInventoryHash = contentHash(poolSnapshots.map((pool) => ({ id: pool.id, hash: pool.inventoryScopeHash })));
    const uniqueProducts = new Set(ready.map((item) => `${item.shopId}\u0000${item.internalId}`)).size;
    if (uniqueProducts > MAX_EXECUTABLE_PRODUCTS) {
      throw fail(`本批涉及 ${uniqueProducts} 个待写商品，超过安全上限 ${MAX_EXECUTABLE_PRODUCTS} 个。`, "INVENTORY_SYNC_PRODUCT_LIMIT", 409);
    }
    if (ready.length > MAX_EXECUTABLE_VARIANTS) {
      throw fail(`本批涉及 ${ready.length} 个待写变体，超过安全上限 ${MAX_EXECUTABLE_VARIANTS} 个。`, "INVENTORY_SYNC_VARIANT_LIMIT", 409);
    }
    const batchLabel = requestedItemKeys.size
      ? `（专项验证 ${requestedItemKeys.size} 个规格）`
      : (requestedProductKeys.size
        ? `（专项验证 ${requestedProductKeys.size} 个商品）`
        : (isBatched ? `（第 ${activeBatchNumber}/${productBatchCount} 批）` : ""));
    const approvalText = `确认同步 ${label} 库存 ${ready.length} 项${batchLabel}`;
    this.#setPreviewProgress(account.id, { stage: "PERSISTING", percent: 96, message: "正在保存库存池绑定和不可变计划。" });
    await this.scopeStore?.save(account.id, normalizedPools, this.now().toISOString(), normalizedPlatform);
    const listingRead = listings.readMetrics || {
      shopCount: selectedShops.length,
      listingCount: listings.length,
      fresh: true,
    };
    const plan = await this.operationPlans.create({
      operationType: inventoryOperationType(normalizedPlatform),
      scope: {
        platform: normalizedPlatform,
        accountProfileId: account.id,
        shopIds: selectedShops,
        warehouseNames: selectedWarehouses,
        inventoryPools: activePools,
        selectedProducts: normalizedSelectedProducts,
        selectedItems: normalizedSelectedItems,
        excludedProducts: normalizedExcludedProducts,
        productBatch: isBatched ? { number: activeBatchNumber, count: productBatchCount, totalReadyProductCount } : null,
      },
      sourceSnapshot: {
        snapshotId: snapshot.id,
        capturedAt: snapshot.capturedAt,
        expiresAt: snapshot.expiresAt,
        rowCount: Number(snapshot.sourceRowCount || snapshot.records.length),
        sourceHash: snapshot.hash,
        inventoryScopeHash: selectedInventoryHash,
        executionInventoryHash: contentHash(poolSnapshots.map((pool) => ({ id: pool.id, hash: pool.executionInventoryHash }))),
        inventoryHashMode: "inventory_pools_plan_skus_v2",
        inventoryPools: poolSnapshots,
        mabangCacheUpdateTime: snapshot.summary.cacheUpdateTime || null,
        listingRead,
      },
      policy,
      items,
      summary: {
        listingCount: listings.length,
        variantCount: items.length,
        readyCount: ready.length,
        unchangedCount: items.filter((item) => item.status === "UNCHANGED").length,
        blockedCount: items.filter((item) => item.status === "BLOCKED").length,
        uniqueProductCount: uniqueProducts,
        totalReadyProductCount,
        selectedReadyProductCount: requestedProductKeys.size ? scopedReadyProductCount : null,
        selectedReadyVariantCount: requestedItemKeys.size ? ready.length : null,
        totalProductCount: allProductStatuses.size,
        totalVariantCount,
        totalReadyVariantCount,
        totalUnchangedVariantCount,
        totalBlockedVariantCount,
        blockedOnlyProductCount,
        deferredProductCount: new Set(deferredItems.map((item) => `${item.shopId}\u0000${item.internalId}`)).size,
        deferredVariantCount: deferredItems.length,
        remainingReadyProductCount: scopedReadyProductCount,
        productBatchNumber: isBatched ? activeBatchNumber : 1,
        productBatchCount,
        inventoryPoolCount: activePools.length,
        skippedInventoryPoolCount: normalizedPools.length - activePools.length,
        listingReadDurationMs: Number(listingRead.durationMs || 0),
        listingPageCount: Number(listingRead.pageCount || 0),
      },
      approvalMode: "human",
      approvalText,
      ttlMs: SNAPSHOT_TTL_MS,
      createdBy: actorId,
    });
    this.#setPreviewProgress(account.id, {
      stage: "COMPLETED",
      percent: 100,
      message: `马帮预检完成：${listings.length} 个在线商品，${items.length} 个变体。`,
      fetchedCount: listings.length,
      totalCount: listings.length,
      page: Number(listingRead.pageCount || 0),
      pageCount: Number(listingRead.pageCount || 0),
      elapsedMs: Number(listingRead.durationMs || 0),
      terminal: true,
    });
    return { plan: publicPlan(plan), approvalText };
  }

  async previewRebind({ sourcePlanId, sourcePlanHash, mappings = [], actorId = "local_session" }) {
    const sourcePlan = await this.operationPlans.get(text(sourcePlanId));
    if (!sourcePlan || sourcePlan.operationType !== INVENTORY_SYNC_OPERATION_TYPE) {
      throw fail("普通 SKU 换绑所引用的库存计划不存在。", "SKU_REBIND_SOURCE_PLAN_NOT_FOUND", 404);
    }
    if (sourcePlan.planHash !== text(sourcePlanHash)) {
      throw fail("库存计划内容已经变化，请重新生成预览。", "SKU_REBIND_SOURCE_PLAN_HASH_MISMATCH", 409);
    }
    if (!["PREVIEWED", "APPROVED"].includes(sourcePlan.state) || sourcePlan.expiresAt <= this.now().toISOString()) {
      throw fail("库存计划已执行、失效或过期，请重新生成库存预览后再换绑。", "SKU_REBIND_SOURCE_PLAN_STALE", 409);
    }
    const snapshot = await this.#resolveSnapshot(sourcePlan.sourceSnapshot?.snapshotId, sourcePlan.scope?.accountProfileId);
    if (!snapshot || snapshot.accountProfileId !== sourcePlan.scope.accountProfileId) {
      throw fail("人工映射所需的库存快照已失效，请重新读取库存。", "SKU_REBIND_SNAPSHOT_MISSING", 409);
    }
    const sourcePools = inventoryPoolsFromScope(sourcePlan.scope);
    const inventoryByPool = new Map(sourcePools.map((pool) => [
      pool.id,
      aggregateInventory(snapshot.records, pool.warehouseNames),
    ]));
    const minimumAvailable = Number(sourcePlan.policy?.safetyStock || 0) + 1;
    const manualMappings = new Map();
    for (const entry of Array.isArray(mappings) ? mappings : []) {
      const fromSku = normalizedSku(entry?.fromSku);
      const toSku = normalizedSku(entry?.toSku);
      if (!fromSku || !toSku) throw fail("人工 SKU 映射必须同时包含当前 Seller SKU 和目标库存 SKU。", "SKU_REBIND_MAPPING_INVALID");
      if (isComboSku(fromSku) || isComboSku(toSku)) {
        throw fail("人工 SKU 映射暂不支持组合 SKU。", "SKU_REBIND_MAPPING_COMBO_BLOCKED", 409);
      }
      const previous = manualMappings.get(fromSku);
      if (previous && previous !== toSku) {
        throw fail(`Seller SKU ${fromSku} 存在多个不同目标。`, "SKU_REBIND_MAPPING_CONFLICT", 409);
      }
      manualMappings.set(fromSku, toSku);
    }
    const eligibleRows = sourcePlan.items.filter((item) => ["SELLER_SKU_REBIND_REQUIRED", "SELLER_SKU_NOT_IN_INVENTORY"].includes(item.reasonCode) && !isComboSku(item.sellerSku));
    const eligibleSellerSkus = new Set(eligibleRows.map((item) => normalizedSku(item.sellerSku)));
    for (const [fromSku, toSku] of manualMappings) {
      if (!eligibleSellerSkus.has(fromSku)) {
        throw fail(`Seller SKU ${fromSku} 不属于当前计划的可换绑普通 SKU。`, "SKU_REBIND_MAPPING_SOURCE_NOT_FOUND", 409);
      }
      const matchingRows = eligibleRows.filter((row) => normalizedSku(row.sellerSku) === fromSku);
      for (const row of matchingRows) {
        const pool = inventoryPoolForItem(sourcePools, row);
        const inventory = pool ? inventoryByPool.get(pool.id)?.bySku.get(toSku) : null;
        if (!inventory) {
          throw fail(`目标库存 SKU ${toSku} 不存在于 ${pool?.name || "对应库存池"}。`, "SKU_REBIND_MAPPING_TARGET_NOT_FOUND", 409);
        }
        if (inventory.availableQuantity < minimumAvailable) {
          throw fail(`目标库存 SKU ${toSku} 在 ${pool?.name || "对应库存池"} 的可用库存 ${inventory.availableQuantity}，未达到换绑阈值 ${minimumAvailable}。`, "SKU_REBIND_MAPPING_TARGET_STOCK_LOW", 409);
        }
      }
    }
    const sourceRows = eligibleRows.filter((item) => item.reasonCode === "SELLER_SKU_REBIND_REQUIRED" || manualMappings.has(normalizedSku(item.sellerSku)));
    if (!sourceRows.length) {
      throw fail("当前库存计划没有可处理的普通 SKU 换绑候选。", "SKU_REBIND_CANDIDATE_EMPTY", 409);
    }

    const account = this.#account(sourcePlan.scope.accountProfileId);
    await this.#connect(account);
    const listings = await this.listingClient.shopeeListings(sourcePlan.scope.shopIds, { refresh: true });
    const listingRows = flattenListings(listings, sourcePlan.scope.shopIds);
    const currentByIdentity = new Map(listingRows.map((item) => [targetIdentity(item), item]));
    const productSkus = new Map();
    for (const row of listingRows) {
      const key = `${row.shopId}\u0000${row.internalId}`;
      const values = productSkus.get(key) || new Set();
      values.add(normalizedSku(row.sellerSku));
      productSkus.set(key, values);
    }
    const reservedTargets = new Set();
    const items = sourceRows.map((row) => {
      const current = currentByIdentity.get(targetIdentity(row));
      const manualTarget = manualMappings.get(normalizedSku(row.sellerSku));
      const pool = inventoryPoolForItem(sourcePools, row);
      const manualInventory = manualTarget && pool ? inventoryByPool.get(pool.id)?.bySku.get(manualTarget) : null;
      const candidate = manualInventory
        ? { stockSku: manualInventory.sourceSku, availableQuantity: manualInventory.availableQuantity }
        : (row.candidateStockSkus || []).find((item) => Number(item.availableQuantity || 0) >= minimumAvailable) || null;
      const toSku = text(candidate?.stockSku);
      let status = "READY";
      let reasonCode = manualTarget ? "MANUAL_CONFIRMED_INVENTORY_SKU" : "HIGHEST_AVAILABLE_PRODUCT_SKU";
      if (!current || normalizedSku(current.sellerSku) !== normalizedSku(row.sellerSku)) {
        status = "BLOCKED";
        reasonCode = "SKU_REBIND_LISTING_DRIFT";
      } else if (!toSku) {
        status = "BLOCKED";
        reasonCode = "SKU_REBIND_NO_STOCKED_REPLACEMENT";
      } else {
        const productKeyValue = `${row.shopId}\u0000${row.internalId}`;
        const reservationKey = `${productKeyValue}\u0000${normalizedSku(toSku)}`;
        if (productSkus.get(productKeyValue)?.has(normalizedSku(toSku)) || reservedTargets.has(reservationKey)) {
          status = "BLOCKED";
          reasonCode = "SKU_REBIND_TARGET_COLLISION";
        } else {
          reservedTargets.add(reservationKey);
        }
      }
      return {
        platform: "shopee",
        shopId: row.shopId,
        shopName: row.shopName,
        internalId: row.internalId,
        productId: row.productId,
        title: row.title,
        variationId: row.variationId,
        inventoryPoolId: pool?.id || "",
        inventoryPoolName: pool?.name || "",
        fromSku: row.sellerSku,
        toSku,
        productKey: row.productKey,
        targetAvailable: candidate?.availableQuantity ?? null,
        status,
        reasonCode,
      };
    });
    const ready = items.filter((item) => item.status === "READY");
    const uniqueProducts = new Set(ready.map((item) => `${item.shopId}\u0000${item.internalId}`)).size;
    if (uniqueProducts > MAX_EXECUTABLE_PRODUCTS) {
      throw fail(`本次换绑涉及 ${uniqueProducts} 个商品，超过安全上限 ${MAX_EXECUTABLE_PRODUCTS} 个。`, "SKU_REBIND_PRODUCT_LIMIT", 409);
    }
    if (!ready.length) {
      throw fail("当前候选均未通过库存阈值、在线身份或目标冲突检查。", "SKU_REBIND_READY_EMPTY", 409);
    }
    const approvalText = `确认换绑 Shopee SKU ${ready.length} 项`;
    const remainingTtl = Math.max(1_000, new Date(sourcePlan.expiresAt).getTime() - this.now().getTime());
    const plan = await this.operationPlans.create({
      operationType: SKU_REBIND_OPERATION_TYPE,
      scope: sourcePlan.scope,
      sourceSnapshot: {
        sourcePlanId: sourcePlan.id,
        sourcePlanHash: sourcePlan.planHash,
        snapshotId: sourcePlan.sourceSnapshot.snapshotId,
        capturedAt: sourcePlan.sourceSnapshot.capturedAt,
        inventoryScopeHash: sourcePlan.sourceSnapshot.inventoryScopeHash,
        inventoryPools: sourcePlan.sourceSnapshot.inventoryPools || [],
      },
      policy: {
        version: 1,
        targetSelection: "highest_available_same_product_key",
        minimumAvailable,
        excludesComboSku: true,
        manualMappingCount: manualMappings.size,
      },
      items,
      summary: {
        candidateCount: items.length,
        readyCount: ready.length,
        blockedCount: items.length - ready.length,
        uniqueProductCount: uniqueProducts,
      },
      approvalMode: "human",
      approvalText,
      ttlMs: Math.min(SNAPSHOT_TTL_MS, remainingTtl),
      createdBy: actorId,
    });
    return { plan: publicPlan(plan), approvalText };
  }

  async approve({ planId, planHash, approvalText, actorId = "local_session" }) {
    const plan = await this.operationPlans.approve(text(planId), { planHash: text(planHash), approvalText, actorId });
    return publicPlan(plan);
  }

  async approveRebind(input) {
    const plan = await this.operationPlans.get(text(input.planId));
    if (!plan || plan.operationType !== SKU_REBIND_OPERATION_TYPE) {
      throw fail("SKU 换绑计划不存在。", "SKU_REBIND_PLAN_NOT_FOUND", 404);
    }
    return this.approve(input);
  }

  async executeRebind({ planId, planHash, onProgress = () => {} }) {
    const plan = await this.operationPlans.get(text(planId));
    if (!plan || plan.operationType !== SKU_REBIND_OPERATION_TYPE) {
      throw fail("SKU 换绑计划不存在。", "SKU_REBIND_PLAN_NOT_FOUND", 404);
    }
    if (plan.state !== "APPROVED") {
      throw fail("SKU 换绑计划尚未批准或已不可执行。", "SKU_REBIND_PLAN_NOT_APPROVED", 409);
    }
    onProgress({ stage: "VALIDATING", percent: 5, message: "正在重新检查库存与在线 Seller SKU。", totalCount: Number(plan.summary?.readyCount || 0) });
    const account = this.#account(plan.scope.accountProfileId);
    await this.#connect(account);
    const [listings, firstInventory] = await Promise.all([
      this.listingClient.shopeeListings(plan.scope.shopIds, { refresh: true }),
      this.runWorker({ action: "inventory", compact: true, warehouseNames: plan.scope.warehouseNames, username: account.username, password: decryptSecret(account.encryptedPassword) }),
    ]);
    let currentRecords = Array.isArray(firstInventory.records) ? firstInventory.records : [];
    if (!currentRecords.length) {
      throw fail("执行换绑前未能读取马帮库存，已停止写入。", "SKU_REBIND_INVENTORY_EMPTY", 409);
    }
    const ready = plan.items.filter((item) => item.status === "READY");
    const executionPools = inventoryPoolsFromScope(plan.scope);
    const targetInventoryMatches = (records) => {
      return ready.every((item) => {
        const pool = inventoryPoolForItem(executionPools, item);
        const target = pool
          ? aggregateInventory(records, pool.warehouseNames).bySku.get(normalizedSku(item.toSku))
          : null;
        return target && target.availableQuantity === Number(item.targetAvailable);
      });
    };
    if (!targetInventoryMatches(currentRecords)) {
      onProgress({ stage: "VALIDATING", percent: 10, message: "首次目标 SKU 库存校验不一致，正在二次读取确认，尚未写入。" });
      const confirmedInventory = await this.runWorker({ action: "inventory", compact: true, warehouseNames: plan.scope.warehouseNames, username: account.username, password: decryptSecret(account.encryptedPassword) });
      currentRecords = Array.isArray(confirmedInventory.records) ? confirmedInventory.records : [];
    }
    if (!currentRecords.length || !targetInventoryMatches(currentRecords)) {
      throw fail("来源仓库库存已经变化，请重新生成库存预览和换绑计划。", "SKU_REBIND_INVENTORY_DRIFT", 409);
    }
    const listingRows = flattenListings(listings, plan.scope.shopIds);
    const currentByStableIdentity = new Map(listingRows.map((item) => [
      [item.shopId, item.internalId, item.variationId].map(text).join("\u0000"),
      item,
    ]));
    const targetKeys = new Set();
    for (const item of ready) {
      const stableKey = [item.shopId, item.internalId, item.variationId].map(text).join("\u0000");
      const current = currentByStableIdentity.get(stableKey);
      if (!current || normalizedSku(current.sellerSku) !== normalizedSku(item.fromSku)) {
        throw fail("在线商品 Seller SKU 已经变化，请重新生成换绑计划。", "SKU_REBIND_LISTING_DRIFT", 409);
      }
      const targetKey = [item.shopId, item.internalId, normalizedSku(item.toSku)].join("\u0000");
      const collision = listingRows.some((row) => row.shopId === item.shopId
        && row.internalId === item.internalId
        && row.variationId !== item.variationId
        && normalizedSku(row.sellerSku) === normalizedSku(item.toSku));
      if (collision || targetKeys.has(targetKey)) {
        throw fail("目标 Seller SKU 已存在于同一商品，已停止换绑。", "SKU_REBIND_TARGET_COLLISION", 409);
      }
      targetKeys.add(targetKey);
    }
    onProgress({ stage: "VALIDATING", percent: 15, message: `安全检查通过，共 ${ready.length} 项待换绑。`, totalCount: ready.length });
    await this.operationPlans.beginExecution(plan.id, {
      planHash: text(planHash),
      scope: plan.scope,
      sourceSnapshot: plan.sourceSnapshot,
      policy: plan.policy,
      items: plan.items,
      actorId: "sku-rebind-executor",
    });
    let jobId = null;
    let writeAttempted = false;
    try {
      onProgress({ stage: "PREFLIGHT", percent: 20, message: "正在生成马帮精确换绑预检。" });
      const preview = await this.listingClient.skuRebindPreview(ready.map((item) => ({
        platform: "shopee",
        shop_id: item.shopId,
        shop_name: item.shopName,
        internal_id: item.internalId,
        product_id: item.productId,
        variation_id: item.variationId,
        title: item.title,
        from_sku: item.fromSku,
        to_sku: item.toSku,
      })));
      const changeIds = (preview.changes || []).map((change) => change.change_id);
      if (changeIds.length !== ready.length || new Set(changeIds).size !== ready.length) {
        throw fail("马帮 SKU 换绑预检数量与计划不一致。", "SKU_REBIND_PREFLIGHT_MISMATCH", 409);
      }
      onProgress({ stage: "SUBMITTING", percent: 32, message: "预检一致，正在向马帮提交换绑批次。" });
      writeAttempted = true;
      const submitted = await this.listingClient.executePreview(preview.preview_token, changeIds);
      jobId = submitted.job_id;
      onProgress({ stage: "PROCESSING", percent: 40, message: "马帮批次已提交，正在处理商品。", jobId });
      const job = await this.listingClient.waitForJob(jobId, { onProgress: (current) => {
        const totalCount = Number(current.total_products || ready.length || 0);
        const processedCount = Number(current.processed_products || 0);
        const ratio = totalCount > 0 ? processedCount / totalCount : 0;
        onProgress({
          stage: "PROCESSING",
          percent: Math.min(85, 40 + Math.floor(ratio * 45)),
          message: current.message || `马帮正在处理 ${processedCount}/${totalCount} 项。`,
          jobId,
          totalCount,
          processedCount,
          successfulCount: Number(current.successful_products || 0),
          failedCount: Number(current.failed_products || 0),
        });
      } });
      const jobSucceeded = job.state === "completed" && Number(job.failed_products || 0) === 0;
      let verification = { totalCount: ready.length, verifiedCount: 0, failedCount: ready.length, rows: [] };
      if (jobSucceeded) {
        onProgress({ stage: "READBACK", percent: 90, message: "马帮批次完成，正在独立回读在线 Seller SKU。", jobId });
        let readbackListings;
        try {
          readbackListings = await this.listingClient.shopeeListings(plan.scope.shopIds, { refresh: true });
        } catch (error) {
          throw Object.assign(error, { resultUnknown: true, jobId });
        }
        const observedByIdentity = new Map(flattenListings(readbackListings, plan.scope.shopIds).map((item) => [
          [item.shopId, item.internalId, item.variationId].map(text).join("\u0000"),
          item,
        ]));
        const rows = ready.map((item) => {
          const stableKey = [item.shopId, item.internalId, item.variationId].map(text).join("\u0000");
          const observed = observedByIdentity.get(stableKey);
          const verified = Boolean(observed && normalizedSku(observed.sellerSku) === normalizedSku(item.toSku));
          return {
            shopId: item.shopId,
            shopName: item.shopName,
            internalId: item.internalId,
            variationId: item.variationId,
            fromSku: item.fromSku,
            toSku: item.toSku,
            observedSku: observed?.sellerSku || "",
            status: verified ? "VERIFIED" : "MISMATCH",
          };
        });
        const verifiedCount = rows.filter((row) => row.status === "VERIFIED").length;
        verification = { totalCount: rows.length, verifiedCount, failedCount: rows.length - verifiedCount, rows };
      }
      const success = jobSucceeded && verification.failedCount === 0;
      onProgress({
        stage: success ? "SUCCEEDED" : "FAILED",
        percent: success ? 100 : (jobSucceeded ? 95 : 85),
        message: success ? `在线回读 ${verification.verifiedCount}/${verification.totalCount} 项一致。` : "任务处理完成，但存在失败或回读不一致。",
        processedCount: ready.length,
        successfulCount: success ? ready.length : Number(job.successful_products || 0),
        failedCount: success ? 0 : Math.max(Number(job.failed_products || 0), verification.failedCount),
        terminal: true,
      });
      const finished = await this.operationPlans.finish(plan.id, success ? "SUCCEEDED" : "FAILED", {
        result: { jobId, state: job.state, successfulProducts: job.successful_products, failedProducts: job.failed_products, results: job.results || [], verification },
        errorCode: success ? null : (jobSucceeded ? "SKU_REBIND_POST_READBACK_MISMATCH" : "SKU_REBIND_MABANG_PARTIAL_OR_FAILED"),
        errorMessage: success ? null : (jobSucceeded ? `SKU 换绑回读不一致 ${verification.failedCount} 项。` : job.message),
        evidence: { source: "mabang_job_and_fresh_listing_readback", jobId, observedAt: this.now().toISOString(), verifiedCount: verification.verifiedCount, failedCount: verification.failedCount },
      });
      return publicPlan(finished);
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      const unknown = Boolean(error?.resultUnknown || (writeAttempted && timedOut));
      const finished = await this.operationPlans.finish(plan.id, unknown ? "UNKNOWN" : "FAILED", {
        result: { jobId },
        errorCode: error?.code || (unknown ? "SKU_REBIND_RESULT_UNKNOWN" : "SKU_REBIND_EXECUTION_FAILED"),
        errorMessage: String(error?.message || "SKU 换绑执行失败。"),
        evidence: jobId ? { source: "mabang_job_submission", jobId } : {},
      });
      if (unknown) return publicPlan(finished);
      throw Object.assign(error, { plan: publicPlan(finished) });
    }
  }

  async execute({ planId, planHash, onProgress = () => {} }) {
    const plan = await this.operationPlans.get(text(planId));
    if (!plan) throw fail("库存同步计划不存在。", "INVENTORY_SYNC_PLAN_NOT_FOUND", 404);
    if (!isInventoryOperationType(plan.operationType)) throw fail("该计划不是库存同步计划。", "INVENTORY_SYNC_PLAN_TYPE_MISMATCH", 409);
    if (plan.state !== "APPROVED") throw fail("库存同步计划尚未批准或已不可执行。", "INVENTORY_SYNC_PLAN_NOT_APPROVED", 409);
    onProgress({ stage: "VALIDATING", percent: 5, message: "正在重新读取马帮库存和在线商品。", totalCount: Number(plan.summary?.readyCount || 0) });
    const account = this.#account(plan.scope.accountProfileId);
    const platform = inventoryPlatform(plan.scope?.platform);
    await this.#connect(account);
    if (!plan.sourceSnapshot?.inventoryScopeHash) {
      throw fail("该库存计划缺少执行前库存校验信息，请重新生成预览。", "INVENTORY_SYNC_PLAN_REPREVIEW_REQUIRED", 409);
    }
    const [currentListings, firstInventory] = await Promise.all([
      this.#platformListings(platform, plan.scope.shopIds, { refresh: true }),
      this.runWorker({ action: "inventory", compact: true, warehouseNames: plan.scope.warehouseNames, username: account.username, password: decryptSecret(account.encryptedPassword) }),
    ]);
    let currentRecords = Array.isArray(firstInventory.records) ? firstInventory.records : [];
    if (!currentRecords.length) {
      throw fail("执行前未能读取马帮库存，已停止写入。", "INVENTORY_SYNC_EXECUTION_INVENTORY_EMPTY", 409);
    }
    const execution = rebaseExecutionItems(plan, currentListings, currentRecords);
    const ready = execution.executable;
    const executionAdjustment = {
      plannedCount: execution.plannedCount,
      executableCount: ready.length,
      adjustedCount: execution.adjusted.length,
      skippedCount: execution.skipped.length,
      adjusted: execution.adjusted,
      skipped: execution.skipped,
    };
    const adjustmentText = execution.adjusted.length ? `，自动重算 ${execution.adjusted.length} 项` : "";
    const skippedText = execution.skipped.length ? `，安全跳过 ${execution.skipped.length} 项` : "";
    onProgress({
      stage: "VALIDATING",
      percent: 18,
      message: `已按最新库存重算，可执行 ${ready.length}/${execution.plannedCount} 项${adjustmentText}${skippedText}。`,
      totalCount: execution.plannedCount,
      processedCount: execution.skipped.length,
      skippedCount: execution.skipped.length,
      adjustedCount: execution.adjusted.length,
    });
    await this.operationPlans.beginExecution(plan.id, {
      planHash: text(planHash),
      scope: plan.scope,
      sourceSnapshot: plan.sourceSnapshot,
      policy: plan.policy,
      items: plan.items,
      actorId: "inventory-sync-executor",
    });
    let jobId = null;
    let writeAttempted = false;
    try {
      if (!ready.length) {
        const finished = await this.operationPlans.finish(plan.id, "SUCCEEDED", {
          result: {
            changedCount: 0,
            message: execution.skipped.length ? "最新库存重算后没有需要写入的变更。" : "没有需要写入的库存变更。",
            executionAdjustment,
          },
          evidence: { source: "fresh_inventory_execution_rebase", observedAt: this.now().toISOString() },
        });
        return publicPlan(finished);
      }
      onProgress({
        stage: "PREFLIGHT",
        percent: 25,
        message: `正在为 ${ready.length} 项生成马帮库存修改预检${execution.adjusted.length ? `（已自动重算 ${execution.adjusted.length} 项）` : ""}。`,
        totalCount: execution.plannedCount,
        processedCount: execution.skipped.length,
        skippedCount: execution.skipped.length,
        adjustedCount: execution.adjusted.length,
      });
      const preview = await this.listingClient.inventoryPreview(ready.map((item) => ({
        platform,
        shop_id: item.shopId,
        shop_name: item.shopName,
        internal_id: item.internalId,
        product_id: item.productId,
        variation_id: item.variationId,
        title: item.title,
        seller_sku: item.sellerSku,
        target_stock: item.targetStock,
        multi_warehouse_mode: plan.policy?.multiWarehouseMode || "block",
      })));
      const changeIds = (preview.changes || []).map((change) => change.change_id);
      if (changeIds.length < ready.length || new Set(changeIds).size !== changeIds.length) {
        throw fail("马帮写入预检数量与计划不一致。", "INVENTORY_SYNC_PREFLIGHT_MISMATCH", 409);
      }
      onProgress({ stage: "SUBMITTING", percent: 35, message: "预检一致，正在提交马帮库存批次。" });
      writeAttempted = true;
      const submitted = await this.listingClient.executePreview(preview.preview_token, changeIds);
      jobId = submitted.job_id;
      onProgress({ stage: "PROCESSING", percent: 40, message: "马帮库存批次已提交，正在处理商品。", jobId });
      const job = await this.listingClient.waitForJob(jobId, { onProgress: (current) => {
        const submittedTotal = Number(current.total_products || ready.length || 0);
        const submittedProcessed = Number(current.processed_products || 0);
        const ratio = submittedTotal > 0 ? submittedProcessed / submittedTotal : 0;
        onProgress({
          stage: "PROCESSING",
          percent: Math.min(95, 40 + Math.floor(ratio * 55)),
          message: current.message || `马帮正在处理 ${submittedProcessed}/${submittedTotal} 项。`,
          jobId,
          totalCount: execution.plannedCount,
          processedCount: Math.min(execution.plannedCount, execution.skipped.length + submittedProcessed),
          successfulCount: Number(current.successful_products || 0),
          failedCount: Number(current.failed_products || 0),
          skippedCount: execution.skipped.length,
          adjustedCount: execution.adjusted.length,
        });
      } });
      const success = job.state === "completed" && Number(job.failed_products || 0) === 0;
      onProgress({
        stage: success ? "SUCCEEDED" : "FAILED",
        percent: success ? 100 : 95,
        message: success
          ? `马帮已完成 ${ready.length} 项库存修改${execution.adjusted.length ? `，自动重算 ${execution.adjusted.length} 项` : ""}${execution.skipped.length ? `，安全跳过 ${execution.skipped.length} 项` : ""}。`
          : (job.message || "马帮库存批次存在失败项。"),
        totalCount: execution.plannedCount,
        processedCount: Math.min(execution.plannedCount, execution.skipped.length + Number(job.processed_products || ready.length)),
        successfulCount: Number(job.successful_products || 0),
        failedCount: Number(job.failed_products || 0),
        skippedCount: execution.skipped.length,
        adjustedCount: execution.adjusted.length,
        terminal: true,
      });
      const finished = await this.operationPlans.finish(plan.id, success ? "SUCCEEDED" : "FAILED", {
        result: {
          jobId,
          state: job.state,
          successfulProducts: job.successful_products,
          failedProducts: job.failed_products,
          results: job.results || [],
          executionAdjustment,
        },
        errorCode: success ? null : "INVENTORY_SYNC_MABANG_PARTIAL_OR_FAILED",
        errorMessage: success ? null : job.message,
        evidence: {
          source: "mabang_batch_and_detail_readback_with_fresh_inventory_rebase",
          jobId,
          observedAt: this.now().toISOString(),
          plannedCount: execution.plannedCount,
          executableCount: ready.length,
          adjustedCount: execution.adjusted.length,
          skippedCount: execution.skipped.length,
        },
      });
      return publicPlan(finished);
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      const unknown = Boolean(error?.resultUnknown || (writeAttempted && timedOut));
      const finished = await this.operationPlans.finish(plan.id, unknown ? "UNKNOWN" : "FAILED", {
        result: { jobId },
        errorCode: error?.code || (unknown ? "INVENTORY_SYNC_RESULT_UNKNOWN" : "INVENTORY_SYNC_EXECUTION_FAILED"),
        errorMessage: String(error?.message || "库存同步执行失败。"),
        evidence: jobId ? { source: "mabang_job_submission", jobId } : {},
      });
      if (unknown) return publicPlan(finished);
      throw Object.assign(error, { plan: publicPlan(finished) });
    }
  }

  async get(planId) {
    return publicPlan(await this.operationPlans.get(text(planId)));
  }
}

export const inventorySyncInternals = { aggregateInventory, inventoryScopeHash, normalizeInventoryPools, flattenListings, buildPlanItems, rebaseExecutionItems, normalizedSku, productKey, isComboSku };
