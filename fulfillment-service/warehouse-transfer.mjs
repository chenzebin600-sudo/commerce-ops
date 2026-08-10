import crypto from "node:crypto";
import path from "node:path";
import { createMabangWorkerRunner } from "../lib/mabang-worker-runner.mjs";

const ALLOWED_ANOMALY_REASONS = new Set(["pending_review", "out_of_stock", "multi_warehouse"]);
const PLAN_TTL_MS = 10 * 60 * 1000;

function text(value) {
  return String(value ?? "").trim();
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sku(value) {
  return text(value).toUpperCase().replace(/\s+/g, "");
}

function warehouseKey(value) {
  return text(value).replace(/\/[-\d.]+$/, "").replace(/\s+/g, "").toUpperCase();
}

function number(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

export class WarehouseTransferService {
  constructor({ rootDir, credentials, hasShopAccess, allowedWarehouses, runWorker = null,
    now = () => new Date(), writeEnabled = false }) {
    this.rootDir = rootDir;
    this.credentials = credentials;
    this.hasShopAccess = hasShopAccess;
    this.allowedWarehouses = allowedWarehouses;
    this.now = now;
    this.writeEnabled = writeEnabled === true;
    this.plans = new Map();
    this.runWorker = runWorker || createMabangWorkerRunner({
      rootDir,
      exportRoot: path.join(rootDir, "storage", "temp"),
    });
  }

  async preview({ orderReference } = {}, { reservations = new Map() } = {}) {
    const reference = text(orderReference);
    if (!/^[A-Za-z0-9_-]{4,100}$/.test(reference)) {
      throw coded("WAREHOUSE_ORDER_REFERENCE_INVALID", "请输入有效的订单号");
    }
    const account = this.credentials();
    if (!account?.ok) {
      throw coded(account?.code || "MABANG_ACCOUNT_NOT_CONNECTED", account?.message || "请先连接马帮账号");
    }
    const inspected = await this.runWorker({
      action: "order-warehouse-inspect",
      username: account.username,
      password: account.password,
      orderReference: reference,
    });
    const order = inspected?.order;
    if (!order?.shopId || !this.hasShopAccess(order.shopId)) {
      throw coded("WAREHOUSE_SHOP_ACCESS_REVOKED", "该订单店铺不属于当前马帮账号权限范围");
    }
    const anomalyReasons = new Set(Array.isArray(order.anomalyReasons) ? order.anomalyReasons.map(text) : []);
    if (![...anomalyReasons].some((reason) => ALLOWED_ANOMALY_REASONS.has(reason))) {
      throw coded("WAREHOUSE_ORDER_NOT_ANOMALOUS", "仅待审核、缺货或多仓异常订单允许换仓");
    }
    const activeItems = Array.isArray(order.items) ? order.items : [];
    if (!activeItems.length) {
      throw coded("WAREHOUSE_ORDER_HAS_NO_SELLABLE_ITEMS", "订单没有可换仓商品行");
    }
    const allowed = [...new Set((this.allowedWarehouses(order.shopId) || []).map(text).filter(Boolean))];
    const optionMaps = activeItems.map((item) => new Map(
      (item.warehouseOptions || []).map((option) => [warehouseKey(option.text), text(option.text)]).filter(([key]) => key),
    ));
    const candidates = allowed
      .map((warehouse) => optionMaps[0].get(warehouseKey(warehouse)))
      .filter((warehouse, index, all) => warehouse && all.indexOf(warehouse) === index
        && optionMaps.every((options) => options.has(warehouseKey(warehouse)))
        && !activeItems.every((item) => warehouseKey(item.stockWarehouseName) === warehouseKey(warehouse)));
    if (!candidates.length) {
      throw coded("WAREHOUSE_NO_COMMON_OPTION", "店铺允许仓库中没有所有订单商品行共同支持的目标仓");
    }
    const inventory = await this.runWorker({
      action: "inventory",
      compact: true,
      warehouseNames: candidates,
      username: account.username,
      password: account.password,
    });
    const ledger = new Map();
    for (const row of inventory?.records || []) {
      const warehouse = text(row["仓库"] ?? row.warehouse);
      const itemSku = sku(row["库存SKU编号"] ?? row["SKU"] ?? row.sku);
      if (!warehouse || !itemSku) continue;
      const key = `${warehouseKey(warehouse)}\u0000${itemSku}`;
      ledger.set(key, (ledger.get(key) || 0) + number(row["可用库存"] ?? row["可用量"] ?? row["可用库存量"] ?? row.availableQuantity ?? row.available));
    }
    const required = new Map();
    for (const item of activeItems) {
      const itemSku = sku(item.stockSku);
      required.set(itemSku, (required.get(itemSku) || 0) + number(item.quantity));
    }
    const evaluated = candidates.map((warehouse) => {
      const stock = [...required].map(([itemSku, quantity]) => ({
        sku: itemSku,
        quantity,
        available: Math.max(0, (ledger.get(`${warehouseKey(warehouse)}\u0000${itemSku}`) || 0)
          - (reservations.get(`${warehouseKey(warehouse)}\u0000${itemSku}`) || 0)),
      }));
      return {
        warehouse,
        stock,
        ready: stock.every((item) => item.available >= item.quantity),
        remaining: stock.reduce((sum, item) => sum + Math.max(0, item.available - item.quantity), 0),
      };
    }).sort((left, right) => Number(right.ready) - Number(left.ready)
      || right.remaining - left.remaining
      || left.warehouse.localeCompare(right.warehouse, "zh-CN"));
    const selected = evaluated.find((candidate) => candidate.ready);
    if (!selected) {
      throw coded("WAREHOUSE_NO_COMMON_STOCK", "允许仓库中没有一个仓库可同时满足订单内全部 SKU 库存");
    }
    for (const [itemSku, quantity] of required) {
      const key = `${warehouseKey(selected.warehouse)}\u0000${itemSku}`;
      reservations.set(key, (reservations.get(key) || 0) + quantity);
    }
    const createdAt = this.now();
    const record = {
      version: 1,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
      order: {
        internalOrderId: text(order.internalOrderId),
        platformOrderId: text(order.platformOrderId || reference),
        shopId: text(order.shopId),
        platformId: text(order.platformId),
        orderStatus: text(order.orderStatus),
        anomalyReasons: [...anomalyReasons].sort(),
      },
      targetWarehouse: selected.warehouse,
      items: activeItems.map((item) => ({
        itemId: text(item.itemId),
        stockSku: text(item.stockSku),
        title: text(item.title),
        quantity: number(item.quantity),
        currentWarehouse: text(item.stockWarehouseName),
      })),
      stock: selected.stock,
      alternatives: evaluated.filter((candidate) => candidate.ready).map((candidate) => ({
        warehouse: candidate.warehouse,
        remaining: candidate.remaining,
      })),
    };
    record.planHash = hash(record);
    record.approvalText = `确认换仓 ${record.order.platformOrderId} -> ${record.targetWarehouse}`;
    this.plans.set(record.planHash, record);
    return record;
  }

  async execute({ planHash, approvalText } = {}) {
    const normalizedHash = text(planHash);
    const record = this.plans.get(normalizedHash);
    if (!record) {
      throw coded("WAREHOUSE_PLAN_NOT_FOUND", "换仓计划不存在或已经执行，请重新预览");
    }
    if (!this.writeEnabled) {
      throw coded("WAREHOUSE_TRANSFER_DISABLED", "真实换仓未启用");
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) {
      this.plans.delete(normalizedHash);
      throw coded("WAREHOUSE_PLAN_EXPIRED", "换仓计划已过期，请重新预览");
    }
    if (text(approvalText) !== record.approvalText) {
      throw coded("WAREHOUSE_APPROVAL_INVALID", `请输入完整确认文字：${record.approvalText}`);
    }
    const semantic = Object.fromEntries(Object.entries(record).filter(([key]) => !["planHash", "approvalText"].includes(key)));
    if (hash(semantic) !== normalizedHash) {
      throw coded("WAREHOUSE_PLAN_HASH_INVALID", "换仓计划校验失败，请重新预览");
    }
    const account = this.credentials();
    if (!account?.ok || !this.hasShopAccess(record.order.shopId)) {
      throw coded("WAREHOUSE_ACCESS_CHANGED", "账号或店铺权限已变化，请重新预览");
    }
    const targetStillAllowed = (this.allowedWarehouses(record.order.shopId) || [])
      .some((warehouse) => warehouseKey(warehouse) === warehouseKey(record.targetWarehouse));
    if (!targetStillAllowed) {
      throw coded("WAREHOUSE_POLICY_CHANGED", "店铺允许仓库已变化，请重新预览");
    }
    const inventory = await this.runWorker({
      action: "inventory",
      compact: true,
      warehouseNames: [record.targetWarehouse],
      username: account.username,
      password: account.password,
    });
    const latest = new Map();
    for (const row of inventory?.records || []) {
      const warehouse = text(row["仓库"] ?? row.warehouse);
      const itemSku = sku(row["库存SKU编号"] ?? row["SKU"] ?? row.sku);
      if (!warehouse || !itemSku) continue;
      latest.set(`${warehouseKey(warehouse)}\u0000${itemSku}`,
        (latest.get(`${warehouseKey(warehouse)}\u0000${itemSku}`) || 0)
          + number(row["可用库存"] ?? row["可用量"] ?? row["可用库存量"] ?? row.availableQuantity ?? row.available));
    }
    if (record.stock.some((item) => (latest.get(`${warehouseKey(record.targetWarehouse)}\u0000${sku(item.sku)}`) || 0) < item.quantity)) {
      throw coded("WAREHOUSE_INVENTORY_CHANGED", "目标仓库存已不足，请重新预览");
    }
    this.plans.delete(normalizedHash);
    const result = await this.runWorker({
      action: "order-warehouse-change",
      commit: "WAREHOUSE_CHANGE_CONFIRMED",
      username: account.username,
      password: account.password,
      orderReference: record.order.platformOrderId,
      targetWarehouse: record.targetWarehouse,
      expectedItems: record.items,
    });
    return { ...record, status: "COMPLETED", executedAt: this.now().toISOString(), result: result.result };
  }

  restorePlan(plan) {
    const record = plan && typeof plan === "object" ? structuredClone(plan) : null;
    const normalizedHash = text(record?.planHash);
    const semantic = record
      ? Object.fromEntries(Object.entries(record).filter(([key]) => !["planHash", "approvalText"].includes(key)))
      : null;
    if (!record || !/^[a-f0-9]{64}$/.test(normalizedHash) || hash(semantic) !== normalizedHash) {
      throw coded("WAREHOUSE_PLAN_HASH_INVALID", "换仓计划校验失败，请重新预览");
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) {
      throw coded("WAREHOUSE_PLAN_EXPIRED", "换仓计划已过期，请重新预览");
    }
    const expectedApproval = `确认换仓 ${text(record.order?.platformOrderId)} -> ${text(record.targetWarehouse)}`;
    if (text(record.approvalText) !== expectedApproval) {
      throw coded("WAREHOUSE_PLAN_HASH_INVALID", "换仓计划确认文字无效，请重新预览");
    }
    this.plans.set(normalizedHash, record);
    return record;
  }
}
