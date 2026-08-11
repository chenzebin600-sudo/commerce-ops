import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createMabangWorkerRunner } from "../lib/mabang-worker-runner.mjs";
import { InventorySnapshotStore } from "../lib/inventory-sync/inventory-snapshot-store.mjs";

const PLAN_TTL_MS = 10 * 60 * 1000;
const BATCH_PLAN_TTL_MS = 60 * 60 * 1000;
const BATCH_RECOVERY_MAX_AGE_MS = 45 * 60 * 1000;
const MAX_BATCH_ORDERS = 100;
const IGNORED_SKUS = new Set(["直播赠品单", "TKZP001"]);
const WAREHOUSE_TRANSFER_SCHEMA_VERSION = 2;

function text(value) { return String(value ?? "").trim(); }
function sku(value) { return text(value).toUpperCase().replace(/\s+/g, ""); }
function warehouseScopeLabel(value) { return text(value).replace(/\/[-\d.]+$/, "").trim(); }
function warehouseKey(value) { return text(value).replace(/\/[-\d.]+$/, "").replace(/\s+/g, "").toUpperCase(); }
function number(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }
function ignored(item) { return IGNORED_SKUS.has(sku(item.stockSku)) || IGNORED_SKUS.has(text(item.title).replace(/\s+/g, "")); }
function reconciliationItems(items = []) {
  return items.map((item) => ({
    itemId: text(item.itemId), stockSku: sku(item.stockSku), quantity: number(item.quantity),
    currentWarehouse: warehouseScopeLabel(item.stockWarehouseName ?? item.currentWarehouse ?? item.warehouse),
  })).sort((left, right) => left.itemId.localeCompare(right.itemId) || left.stockSku.localeCompare(right.stockSku)
    || left.quantity - right.quantity);
}
function reconciliationIdentity(items = []) {
  return reconciliationItems(items).map(({ itemId, stockSku, quantity }) => ({ itemId, stockSku, quantity }));
}
function inventoryFields(row) {
  return { warehouse: text(row["仓库"] ?? row.warehouse), sku: sku(row["库存SKU编号"] ?? row["SKU"] ?? row.sku), available: number(row["可用库存"] ?? row["可用量"] ?? row["可用库存量"] ?? row.availableQuantity ?? row.available) };
}

function warehouseOptionBinding(item, warehouse) {
  const option = (item.warehouseOptions || []).find((candidate) => warehouseKey(candidate?.text ?? candidate?.name ?? candidate?.warehouse) === warehouseKey(warehouse));
  if (!option) return null;
  return { itemId: text(item.itemId), optionValue: text(option.value ?? option.id),
    optionText: text(option.text ?? option.name ?? option.warehouse), optionWarehouseKey: warehouseKey(option.text ?? option.name ?? option.warehouse) };
}

function inventoryLedger(records = []) {
  const ledger = new Map();
  for (const raw of records) {
    const row = inventoryFields(raw);
    if (!row.warehouse || !row.sku) continue;
    const key = `${warehouseKey(row.warehouse)}\u0000${row.sku}`;
    ledger.set(key, (ledger.get(key) || 0) + row.available);
  }
  return ledger;
}

export class WarehouseTransferService {
  constructor({ rootDir, credentials, hasShopAccess, allowedWarehouses, runWorker = null, snapshotStore = null, now = () => new Date() }) {
    this.rootDir = rootDir;
    this.credentials = credentials;
    this.hasShopAccess = hasShopAccess;
    this.allowedWarehouses = allowedWarehouses;
    this.runWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
    this.snapshotStore = snapshotStore || new InventorySnapshotStore({ rootDir: path.join(rootDir, "storage", "inventory-sync", "snapshots") });
    this.now = now;
    this.plans = new Map();
    this.batches = new Map();
    this.historyDir = path.join(rootDir, "storage", "warehouse-transfers");
  }

  async previewKeepCurrentReconciliation({ orderReference, targetWarehouse, expectedItems = [] } = {}) {
    const originalWarehouse = warehouseScopeLabel(targetWarehouse);
    const expected = reconciliationItems(expectedItems);
    if (!originalWarehouse || !expected.length
        || expected.some((item) => warehouseKey(item.currentWarehouse) !== warehouseKey(originalWarehouse))) {
      throw coded("WAREHOUSE_RECONCILIATION_INVALID", "保留原仓的内部换仓授权无效");
    }
    return this.preview({ orderReference, targetWarehouse: originalWarehouse }, {
      keepCurrentReconciliation: { mode: "KEEP_CURRENT", originalWarehouse, expectedItems: expected },
    });
  }

  async preview({ orderReference, targetWarehouse = "" } = {}, context = {}) {
    const reference = text(orderReference);
    if (!/^[A-Za-z0-9_-]{4,100}$/.test(reference)) throw coded("WAREHOUSE_ORDER_REFERENCE_INVALID", "请输入有效的订单号");
    const account = context.account || this.credentials();
    if (!account?.ok) throw coded(account?.code || "MABANG_ACCOUNT_NOT_CONNECTED", account?.message || "请先连接马帮账号");
    const inspected = await this.runWorker({ action: "order-warehouse-inspect", username: account.username, password: account.password, orderReference: reference });
    const order = inspected.order;
    if (!order?.shopId || !this.hasShopAccess(order.shopId)) throw coded("WAREHOUSE_SHOP_ACCESS_REVOKED", "该订单店铺不属于当前马帮账号权限范围");
    const activeItems = (order.items || []).filter((item) => !ignored(item));
    if (!activeItems.length) throw coded("WAREHOUSE_ORDER_HAS_NO_SELLABLE_ITEMS", "订单仅包含赠品 SKU，不执行换仓");
    const wanted = text(targetWarehouse);
    const reconciliation = context.keepCurrentReconciliation;
    const reconciliationAuthorized = reconciliation?.mode === "KEEP_CURRENT"
      && warehouseKey(reconciliation.originalWarehouse) === warehouseKey(wanted)
      && stable(reconciliationIdentity(activeItems)) === stable(reconciliationIdentity(reconciliation.expectedItems))
      && reconciliation.expectedItems.every((item) => warehouseKey(item.currentWarehouse) === warehouseKey(wanted));
    if (reconciliation && !reconciliationAuthorized) {
      throw coded("WAREHOUSE_RECONCILIATION_STATE_CHANGED", "订单商品已偏离保留原仓计划，请人工核对");
    }
    const policyWarehouses = new Set((this.allowedWarehouses(order.shopId) || []).map(text).filter(Boolean));
    if (!policyWarehouses.size && !reconciliationAuthorized) throw coded("WAREHOUSE_POLICY_EMPTY", "请先在自动发货店铺设置中配置该店铺允许的仓库");
    const eligibleWarehouses = reconciliationAuthorized ? [wanted] : [...policyWarehouses];
    const candidates = eligibleWarehouses.map(warehouseScopeLabel)
      .filter((warehouse, index, all) => warehouse && all.findIndex((candidate) => warehouseKey(candidate) === warehouseKey(warehouse)) === index
        && activeItems.every((item) => warehouseOptionBinding(item, warehouse))
        && !activeItems.every((item) => warehouseKey(item.stockWarehouseName) === warehouseKey(warehouse)));
    if (!candidates.length) throw coded("WAREHOUSE_NO_COMMON_OPTION", "店铺允许仓库中没有所有订单商品行共同支持的目标仓");
    const cacheKey = candidates.map(warehouseKey).sort().join("|");
    let inventory = context.inventory || context.inventoryCache?.get(cacheKey);
    if (!inventory) {
      inventory = await this.inventoryForWarehouses(account, candidates);
      context.inventoryCache?.set(cacheKey, inventory);
    }
    const ledger = inventoryLedger(inventory.records);
    for (const [key, reserved] of context.reservations || []) ledger.set(key, (ledger.get(key) || 0) - number(reserved));
    const required = new Map();
    for (const item of activeItems) required.set(sku(item.stockSku), (required.get(sku(item.stockSku)) || 0) + number(item.quantity));
    const evaluated = candidates.map((warehouse) => {
      const stock = [...required].map(([itemSku, quantity]) => ({ sku: itemSku, quantity, available: ledger.get(`${warehouseKey(warehouse)}\u0000${itemSku}`) || 0 }));
      return { warehouse, ready: stock.every((item) => item.available >= item.quantity), stock,
        remaining: stock.reduce((sum, item) => sum + Math.max(0, item.available - item.quantity), 0) };
    }).sort((left, right) => Number(right.ready) - Number(left.ready) || right.remaining - left.remaining || left.warehouse.localeCompare(right.warehouse, "zh-CN"));
    const selected = wanted ? evaluated.find((item) => warehouseKey(item.warehouse) === warehouseKey(wanted)) : evaluated.find((item) => item.ready);
    if (wanted && !selected) throw coded("WAREHOUSE_TARGET_NOT_ALLOWED", "目标仓库不在该店铺允许范围，或订单商品不支持该仓库");
    if (!selected?.ready) throw coded("WAREHOUSE_NO_COMMON_STOCK", "允许仓库中没有一个仓库可同时满足订单内全部 SKU 库存");
    const createdAt = this.now();
    const planTtlMs = Number(context.planTtlMs) || PLAN_TTL_MS;
    const itemBindings = activeItems.map((item) => warehouseOptionBinding(item, selected.warehouse));
    if (itemBindings.some((binding) => !binding)) throw coded("WAREHOUSE_LINE_BINDING_CHANGED", "商品行的目标仓库选项无法绑定，请重新预览");
    const record = { version: WAREHOUSE_TRANSFER_SCHEMA_VERSION, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + planTtlMs).toISOString(),
      order: { internalOrderId: order.internalOrderId, platformOrderId: order.platformOrderId, shopId: order.shopId, platformId: order.platformId, orderStatus: order.orderStatus },
      targetWarehouse: selected.warehouse,
      itemBindings,
      items: activeItems.map((item) => ({ itemId: text(item.itemId), stockSku: text(item.stockSku), title: text(item.title), quantity: number(item.quantity), currentWarehouse: text(item.stockWarehouseName) })),
      stock: selected.stock, alternatives: evaluated.filter((item) => item.ready).map((item) => ({ warehouse: item.warehouse, remaining: item.remaining })),
      ...(reconciliationAuthorized ? { reconciliation: { mode: "KEEP_CURRENT", originalWarehouse: reconciliation.originalWarehouse } } : {}) };
    record.planHash = hash(record);
    record.approvalText = `确认换仓 ${record.order.platformOrderId || reference} -> ${record.targetWarehouse}`;
    if (context.reservations) {
      for (const item of selected.stock) {
        const key = `${warehouseKey(selected.warehouse)}\u0000${item.sku}`;
        context.reservations.set(key, (context.reservations.get(key) || 0) + item.quantity);
      }
    }
    this.plans.set(record.planHash, record);
    this.write("previews", record.planHash, record);
    return record;
  }

  async previewBatch({ orderReferences = [], targetWarehouse = "" } = {}) {
    const references = [...new Set((Array.isArray(orderReferences) ? orderReferences : []).map(text).filter(Boolean))];
    if (!references.length || references.length > MAX_BATCH_ORDERS || references.some((reference) => !/^[A-Za-z0-9_-]{4,100}$/.test(reference))) {
      throw coded("WAREHOUSE_BATCH_ORDERS_INVALID", `请输入 1-${MAX_BATCH_ORDERS} 个有效订单号`);
    }
    const account = this.credentials();
    if (!account?.ok) throw coded(account?.code || "MABANG_ACCOUNT_NOT_CONNECTED", account?.message || "请先连接马帮账号");
    const snapshot = await this.freshSnapshot(account);
    const inventory = snapshot ? { records: snapshot.records, source: "inventory_sync_snapshot", capturedAt: snapshot.capturedAt, expiresAt: snapshot.expiresAt } : null;
    const plans = []; const failures = []; const reservations = new Map(); const inventoryCache = new Map();
    for (const orderReference of references) {
      try { plans.push(await this.preview({ orderReference, targetWarehouse }, { account, inventory, inventoryCache, reservations, planTtlMs: BATCH_PLAN_TTL_MS })); }
      catch (error) { failures.push({ orderReference, code: error.code || "WAREHOUSE_PREVIEW_FAILED", message: text(error.message || "换仓预览失败").slice(0, 300) }); }
    }
    const createdAt = this.now();
    const record = { version: WAREHOUSE_TRANSFER_SCHEMA_VERSION, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
      requestedCount: references.length, plans, failures };
    record.batchHash = hash({ version: record.version, createdAt: record.createdAt, expiresAt: record.expiresAt,
      requestedCount: record.requestedCount, planHashes: plans.map((plan) => plan.planHash), failures });
    record.approvalText = `确认批量换仓 ${plans.length} 单`;
    this.batches.set(record.batchHash, record);
    this.write("batch-previews", record.batchHash, record);
    return record;
  }

  recoverBatch({ orderReferences = [] } = {}) {
    const references = [...new Set((Array.isArray(orderReferences) ? orderReferences : []).map(text).filter(Boolean))];
    if (!references.length || references.length > MAX_BATCH_ORDERS || references.some((reference) => !/^[A-Za-z0-9_-]{4,100}$/.test(reference))) {
      throw coded("WAREHOUSE_BATCH_ORDERS_INVALID", `请输入 1-${MAX_BATCH_ORDERS} 个有效订单号`);
    }
    const wanted = [...references].sort().join("\u0000");
    const directory = path.join(this.historyDir, "batch-previews");
    const candidates = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        try { return JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")); } catch { return null; }
      }).filter(Boolean) : [];
    const source = candidates.filter((record) => {
      const recordReferences = [...new Set([
        ...(record.orderReferences || []),
        ...(record.plans || []).map((plan) => plan.order?.platformOrderId),
        ...(record.failures || []).map((failure) => failure.orderReference),
      ].map(text).filter(Boolean))].sort().join("\u0000");
      const age = this.now().getTime() - Date.parse(record.createdAt || "");
      return recordReferences === wanted && age >= 0 && age <= BATCH_RECOVERY_MAX_AGE_MS;
    }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    if (!source) throw coded("WAREHOUSE_BATCH_RECOVERY_NOT_FOUND", "没有找到这批订单最近完成的预览结果，请重新读取");
    if (source.version !== WAREHOUSE_TRANSFER_SCHEMA_VERSION
        || (source.plans || []).some((plan) => plan.version !== WAREHOUSE_TRANSFER_SCHEMA_VERSION || !Array.isArray(plan.itemBindings))) {
      throw coded("PREVIEW_SCHEMA_OBSOLETE", "最近的换仓预览由旧版安全规则生成，必须重新获取");
    }
    const createdAt = this.now();
    const recoveredPlans = source.plans.map((plan) => {
      const refreshed = { ...plan, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + BATCH_PLAN_TTL_MS).toISOString(),
        recoveredAt: createdAt.toISOString(), recoveredFromPlanHash: plan.recoveredFromPlanHash || plan.planHash };
      delete refreshed.planHash; delete refreshed.approvalText;
      refreshed.planHash = hash(refreshed);
      refreshed.approvalText = `确认换仓 ${refreshed.order.platformOrderId} -> ${refreshed.targetWarehouse}`;
      this.plans.set(refreshed.planHash, refreshed);
      this.write("previews", refreshed.planHash, refreshed);
      return refreshed;
    });
    const recovered = { ...source, plans: recoveredPlans, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
      orderReferences: references, recoveredAt: createdAt.toISOString() };
    recovered.batchHash = hash({ version: recovered.version, createdAt: recovered.createdAt, expiresAt: recovered.expiresAt,
      requestedCount: recovered.requestedCount, planHashes: recovered.plans.map((plan) => plan.planHash), failures: recovered.failures });
    recovered.approvalText = `确认批量换仓 ${recovered.plans.length} 单`;
    this.batches.set(recovered.batchHash, recovered);
    this.write("batch-previews", recovered.batchHash, recovered);
    return recovered;
  }

  async executeBatch({ batchHash, planHashes = [], approvalText } = {}) {
    const record = this.batches.get(text(batchHash));
    if (!record) throw coded("WAREHOUSE_BATCH_NOT_FOUND", "批量换仓预览不存在或已经执行，请重新预览");
    if (record.version !== WAREHOUSE_TRANSFER_SCHEMA_VERSION
        || (record.plans || []).some((plan) => plan.version !== WAREHOUSE_TRANSFER_SCHEMA_VERSION || !Array.isArray(plan.itemBindings))) {
      this.batches.delete(record.batchHash);
      throw coded("PREVIEW_SCHEMA_OBSOLETE", "批量换仓预览由旧版安全规则生成，禁止执行，请重新预览");
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) { this.batches.delete(record.batchHash); throw coded("WAREHOUSE_BATCH_EXPIRED", "批量换仓预览已过期，请重新预览"); }
    const requested = new Set((Array.isArray(planHashes) ? planHashes : []).map(text).filter(Boolean));
    const available = new Map(record.plans.map((plan) => [plan.planHash, plan]));
    if (!requested.size || requested.size > MAX_BATCH_ORDERS || [...requested].some((planHash) => !available.has(planHash))) throw coded("WAREHOUSE_BATCH_SELECTION_INVALID", "请选择当前批次中可执行的订单");
    // 始终沿用预览顺序，避免调用方通过重排 planHashes 改变同仓同 SKU 的库存优先级。
    const selected = record.plans.filter((plan) => requested.has(plan.planHash));
    const expectedApproval = `确认批量换仓 ${selected.length} 单`;
    if (text(approvalText) !== expectedApproval) throw coded("WAREHOUSE_BATCH_APPROVAL_INVALID", `请输入完整确认文字：${expectedApproval}`);
    const account = this.credentials();
    if (!account?.ok) throw coded(account?.code || "MABANG_ACCOUNT_NOT_CONNECTED", account?.message || "请先连接马帮账号");
    // 批次执行只刷新一次相关目标仓库存；后续订单共享扣减该账本，规避马帮库存更新延迟导致的重复分配。
    const freshInventory = await this.inventoryForWarehouses(account, selected.map((plan) => plan.targetWarehouse), { allowSnapshot: false });
    const executionLedger = inventoryLedger(freshInventory.records);
    this.batches.delete(record.batchHash);
    const results = [];
    for (const plan of selected) {
      try { results.push({ planHash: plan.planHash, orderReference: plan.order.platformOrderId, status: "COMPLETED",
        result: await this.execute({ planHash: plan.planHash, approvalText: plan.approvalText }, { account, inventoryLedger: executionLedger }) }); }
      catch (error) { results.push({ planHash: plan.planHash, orderReference: plan.order.platformOrderId, status: "FAILED",
        code: error.code || "WAREHOUSE_EXECUTE_FAILED", message: text(error.message || "换仓执行失败").slice(0, 300) }); }
    }
    const completed = { ...record, approvalText: expectedApproval, selectedCount: selected.length, executedAt: this.now().toISOString(), results,
      summary: { completed: results.filter((item) => item.status === "COMPLETED").length, failed: results.filter((item) => item.status === "FAILED").length } };
    this.write("batch-executions", record.batchHash, completed);
    return completed;
  }

  async execute({ planHash, approvalText } = {}, context = {}) {
    const record = this.plans.get(text(planHash));
    if (!record) throw coded("WAREHOUSE_PLAN_NOT_FOUND", "换仓预览不存在或已经执行，请重新预览");
    if (record.version !== WAREHOUSE_TRANSFER_SCHEMA_VERSION || !Array.isArray(record.itemBindings)) {
      this.plans.delete(record.planHash);
      throw coded("PREVIEW_SCHEMA_OBSOLETE", "换仓计划由旧版安全规则生成，禁止执行，请重新预览");
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) { this.plans.delete(record.planHash); throw coded("WAREHOUSE_PLAN_EXPIRED", "换仓预览已过期，请重新预览"); }
    if (text(approvalText) !== record.approvalText) throw coded("WAREHOUSE_APPROVAL_INVALID", `请输入完整确认文字：${record.approvalText}`);
    if (record.planHash !== hash(Object.fromEntries(Object.entries(record).filter(([key]) => !["planHash", "approvalText"].includes(key))))) throw coded("WAREHOUSE_PLAN_HASH_INVALID", "换仓计划校验失败");
    const account = context.account || this.credentials();
    if (!account?.ok || !this.hasShopAccess(record.order.shopId)) throw coded("WAREHOUSE_ACCESS_CHANGED", "账号或店铺权限已变化，请重新预览");
    const currentAllowed = (this.allowedWarehouses(record.order.shopId) || []).some((warehouse) => warehouseKey(warehouse) === warehouseKey(record.targetWarehouse));
    const keepCurrentReconciliation = record.reconciliation?.mode === "KEEP_CURRENT"
      && warehouseKey(record.reconciliation.originalWarehouse) === warehouseKey(record.targetWarehouse);
    if (!currentAllowed && !keepCurrentReconciliation) throw coded("WAREHOUSE_POLICY_CHANGED", "店铺允许仓库已变化，请重新预览");
    const inspected = await this.runWorker({ action: "order-warehouse-inspect", username: account.username, password: account.password,
      orderReference: record.order.platformOrderId });
    const activeItems = (inspected.order?.items || []).filter((item) => !ignored(item));
    const bindingByItem = new Map(record.itemBindings.map((binding) => [text(binding.itemId), binding]));
    const lineBindingsValid = activeItems.length === record.items.length && activeItems.every((item) => {
      const plannedItem = record.items.find((candidate) => candidate.itemId === text(item.itemId));
      const plannedBinding = bindingByItem.get(text(item.itemId));
      const currentBinding = warehouseOptionBinding(item, record.targetWarehouse);
      return plannedItem && plannedBinding && currentBinding
        && sku(plannedItem.stockSku) === sku(item.stockSku) && number(plannedItem.quantity) === number(item.quantity)
        && warehouseKey(plannedItem.currentWarehouse) === warehouseKey(item.stockWarehouseName)
        && text(plannedBinding.optionValue) === text(currentBinding.optionValue)
        && text(plannedBinding.optionText) === text(currentBinding.optionText);
    });
    if (!lineBindingsValid) throw coded("WAREHOUSE_LINE_BINDING_CHANGED", "订单商品或目标仓库选项已变化，请重新预览");
    this.plans.delete(record.planHash); // 从重新验库存开始即占用计划，保证并发请求也只能进入一次写入流程。
    const freshLedger = context.inventoryLedger || inventoryLedger((await this.inventoryForWarehouses(account, [record.targetWarehouse], { allowSnapshot: false })).records);
    const freshRequired = new Map();
    for (const item of record.items) freshRequired.set(sku(item.stockSku), (freshRequired.get(sku(item.stockSku)) || 0) + number(item.quantity));
    if ([...freshRequired].some(([itemSku, quantity]) => (freshLedger.get(`${warehouseKey(record.targetWarehouse)}\u0000${itemSku}`) || 0) < quantity)) {
      throw coded("WAREHOUSE_INVENTORY_CHANGED", "目标仓库存已不足，请重新预览");
    }
    if (context.inventoryLedger) {
      for (const [itemSku, quantity] of freshRequired) {
        const key = `${warehouseKey(record.targetWarehouse)}\u0000${itemSku}`;
        freshLedger.set(key, (freshLedger.get(key) || 0) - quantity);
      }
    }
    const result = await this.runWorker({ action: "order-warehouse-change", commit: "WAREHOUSE_CHANGE_CONFIRMED",
      username: account.username, password: account.password, orderReference: record.order.platformOrderId,
      targetWarehouse: record.targetWarehouse, expectedItems: record.items, itemBindings: record.itemBindings });
    const completed = { ...record, executedAt: this.now().toISOString(), status: "COMPLETED", result: result.result };
    this.write("executions", record.planHash, completed);
    return completed;
  }

  write(folder, id, value) {
    const directory = path.join(this.historyDir, folder); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${id}.json`); const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(temporary, file);
  }

  async freshSnapshot(account) {
    if (!account?.id) return null;
    const snapshot = await this.snapshotStore.loadLatest(account.id);
    return snapshot && Date.parse(snapshot.expiresAt) > this.now().getTime() ? snapshot : null;
  }

  async inventoryForWarehouses(account, warehouseNames, { allowSnapshot = true } = {}) {
    const snapshot = allowSnapshot ? await this.freshSnapshot(account) : null;
    if (snapshot) return { records: snapshot.records, source: "inventory_sync_snapshot", capturedAt: snapshot.capturedAt, expiresAt: snapshot.expiresAt };
    return this.runWorker({ action: "inventory", compact: true, warehouseNames: [...new Set(warehouseNames.map(warehouseScopeLabel).filter(Boolean))],
      username: account.username, password: account.password });
  }
}

function coded(code, message) { const error = new Error(message); error.code = code; return error; }
