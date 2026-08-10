import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

function hash(value) { return createHash("sha256").update(String(value), "utf8").digest("hex"); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function bounded(value, length = 180) { return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, length); }
function firstDefined(...values) { return values.find((value) => value !== undefined && value !== null); }
const GIFT_SKU_WAREHOUSE = "赠品sku仓";
const PRODUCT_PREFIX_WAREHOUSE_SHOPS = new Set([
  "69345928", // Impressive MALL
  "2021245862", // Vigor Mall
  "2021537019", // Majestic Manor Furniture Outlet
]);
const PRODUCT_PREFIX_WAREHOUSE_RULES = Object.freeze([
  { prefixes: Object.freeze(["5E", "5G"]), warehouses: Object.freeze(["泰国TZ-AG仓-1308", "泰国壹慧-A仓-1308"]) },
  { prefixes: Object.freeze(["5F"]), warehouses: Object.freeze(["泰国日达顺-A仓-1308"]) },
  { prefixes: Object.freeze(["5J", "5B", "5Y"]), warehouses: Object.freeze(["泰国TLS-A仓-1308"]) },
]);
function isGiftSkuWarehouse(value) {
  return bounded(value, 160).replace(/\s+/g, "").toLocaleLowerCase() === GIFT_SKU_WAREHOUSE;
}
function productPrefixWarehouseState(raw, shopId, warehouse) {
  if (!PRODUCT_PREFIX_WAREHOUSE_SHOPS.has(String(shopId || ""))) return null;
  const productName = bounded(firstDefined(raw.productName, raw["商品中文名称"], raw["订单商品名称"]), 500)
    .normalize("NFKC").toLocaleUpperCase();
  const rule = PRODUCT_PREFIX_WAREHOUSE_RULES.find((item) => item.prefixes.some((prefix) => productName.startsWith(prefix)));
  if (!rule) return null;
  const prefix = rule.prefixes.find((value) => productName.startsWith(value));
  return { prefix, expectedWarehouses: [...rule.warehouses], warehouse,
    matched: rule.warehouses.includes(warehouse) };
}
function warehouseState(order) {
  const warehouses = [...new Set((order?.warehouses || order?.snapshot?.warehouses || [order?.warehouse])
    .map((value) => bounded(value, 160)).filter(Boolean))].sort();
  const giftWarehouses = warehouses.filter(isGiftSkuWarehouse);
  const fulfillmentWarehouses = warehouses.filter((warehouse) => !isGiftSkuWarehouse(warehouse));
  return { warehouses, giftWarehouses, fulfillmentWarehouses,
    singleFulfillmentWarehouseVerified: fulfillmentWarehouses.length === 1 };
}
function inventoryState(rawValue, requiredQuantity) {
  const text = bounded(rawValue, 80);
  if (!text) return { stockStatus: "unknown", isOutOfStock: null, availableQuantity: null };
  const normalizedNumber = text.replace(/,/g, "");
  if (/^-?\d+(?:\.\d+)?$/.test(normalizedNumber)) {
    const availableQuantity = Number(normalizedNumber);
    const isOutOfStock = availableQuantity < requiredQuantity;
    return { stockStatus: isOutOfStock ? "out_of_stock" : "in_stock", isOutOfStock, availableQuantity };
  }
  if (/(缺货|无货|售罄|out\s*of\s*stock)/i.test(text)) return { stockStatus: "out_of_stock", isOutOfStock: true, availableQuantity: null };
  if (/(有货|库存充足|in\s*stock)/i.test(text)) return { stockStatus: "in_stock", isOutOfStock: false, availableQuantity: null };
  return { stockStatus: "unknown", isOutOfStock: null, availableQuantity: null };
}
function maskTracking(value) {
  const text = bounded(value, 100); if (!text) return null;
  return text.length <= 8 ? "****" : `${text.slice(0, 4)}****${text.slice(-4)}`;
}
function snapshotItems(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  return items.map((item) => ({ sku: bounded(item.sku, 120), requiredQuantity: Number(item.requiredQuantity || 0),
    inventoryRaw: bounded(item.inventoryRaw, 80),
    warehouses: [...new Set((item.warehouses || [item.warehouse]).map((value) => bounded(value, 160)).filter(Boolean))].sort() }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
}
function itemShape(snapshot) { return JSON.stringify(snapshotItems(snapshot).map(({ sku, requiredQuantity, warehouses }) => ({ sku, requiredQuantity, warehouses }))); }
function inventoryShape(snapshot) { return JSON.stringify(snapshotItems(snapshot).map(({ sku, inventoryRaw }) => ({ sku, inventoryRaw }))); }
function orderShape(snapshot) {
  return JSON.stringify({ shopName: bounded(snapshot?.shopName), countryCode: bounded(snapshot?.countryCode),
    orderStatus: bounded(snapshot?.orderStatus), warehouse: bounded(snapshot?.warehouse),
    warehouses: [...new Set((snapshot?.warehouses || [snapshot?.warehouse]).map((value) => bounded(value, 160)).filter(Boolean))].sort() });
}
function paidTimestamp(order) {
  const text = bounded(order?.snapshot?.paidAt, 80);
  const timestamp = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function orderAgeState(order, nowMs, minimumMinutes) {
  if (!Number.isFinite(Number(minimumMinutes)) || Number(minimumMinutes) <= 0) return null;
  const paidAt = paidTimestamp(order);
  if (!paidAt) return { code: "ORDER_AGE_UNKNOWN", ageMinutes: null, retryAt: null };
  const ageMinutes = (nowMs - paidAt) / 60000;
  if (ageMinutes < Number(minimumMinutes)) {
    return { code: "ORDER_NOT_MATURE", ageMinutes: Math.max(0, ageMinutes),
      retryAt: new Date(paidAt + Number(minimumMinutes) * 60000).toISOString() };
  }
  return null;
}
function preflightPassed(checked) {
  return Boolean(checked?.ready) && !checked?.wouldSubmit && checked.stockStatus === "in_stock"
    && !checked.hasTrackingNumber && Boolean(checked.channelMatched) && Boolean(checked.reportingSuccess)
    && !checked.hasDeclarationRows && Number(checked.missingRequiredPropertyCount || 0) === 0;
}
const isolatedOrderFailureCodes = new Set([
  "OUT_OF_STOCK_BEFORE_SUBMIT", "INVENTORY_UNKNOWN_BEFORE_SUBMIT", "MULTI_WAREHOUSE_REQUIRES_REVIEW",
  "GIFT_ONLY_ORDER_NOT_ALLOWED",
  "PRODUCT_PREFIX_WAREHOUSE_MISMATCH_BEFORE_SUBMIT",
  "ALREADY_HAS_TRACKING_NUMBER", "DISTRIBUTION_PENDING", "TRACKING_NUMBER_PENDING",
  "EXISTING_TRACKING_NOT_READABLE", "EXISTING_TRACKING_RECOVERY_FAILED",
  "ORDER_NOT_AVAILABLE_FOR_DELIVERY", "CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT", "WAREHOUSE_NOT_ALLOWED_BEFORE_SUBMIT",
]);
const manualAttentionFailureCodes = new Set([
  "OUT_OF_STOCK_BEFORE_SUBMIT", "INVENTORY_UNKNOWN_BEFORE_SUBMIT", "MULTI_WAREHOUSE_REQUIRES_REVIEW",
  "GIFT_ONLY_ORDER_NOT_ALLOWED",
  "PRODUCT_PREFIX_WAREHOUSE_MISMATCH_BEFORE_SUBMIT",
  "EXISTING_TRACKING_NOT_READABLE", "TRACKING_MISMATCH_BEFORE_DISTRIBUTION",
  "TRACKING_CHANNEL_MISMATCH_BEFORE_DISTRIBUTION", "TRACKING_CHANNEL_UNKNOWN_BEFORE_DISTRIBUTION",
  "TRACKING_MISMATCH_BEFORE_RESET", "TRACKING_CHANNEL_UNKNOWN_BEFORE_RESET", "TRACKING_CHANNEL_CHANGED_BEFORE_RESET",
  "ORDER_STATUS_NOT_PENDING_BEFORE_DISTRIBUTION", "ORDER_NOT_AVAILABLE_FOR_DELIVERY",
]);
function mustStopLaterOrders(patch) {
  return patch.status !== "success" && !isolatedOrderFailureCodes.has(String(patch.errorCode || ""));
}

export class FulfillmentError extends Error {
  constructor(code, message, status = 400, details = undefined) { super(message); this.code = code; this.status = status; this.details = details; }
}

export class FulfillmentService {
  constructor({ config, repository, source, executor, preflight = null, trackingRecovery = null,
    notifier = { notify() {} }, now = () => new Date() }) {
    this.config = config; this.repository = repository; this.source = source; this.executor = executor; this.now = now;
    this.notifier = notifier;
    this.preflight = preflight;
    this.trackingRecovery = trackingRecovery;
    this.activeJobs = new Set();
  }

  normalizeOrder(raw, activeDispatchOrderKeys = null) {
    const sourceOrderId = bounded(raw.sourceOrderId || raw.orderId || raw["订单编号"]);
    const tradeNumber = bounded(raw.tradeNumber || raw["交易编号"]);
    const rawPlatform = bounded(raw.platform || raw["平台"] || this.config.platform).toLocaleLowerCase();
    const isLazada = rawPlatform.includes("lazada");
    // Lazada 的“订单编号”是马帮内部店铺 ID 与平台订单号的组合展示；
    // “交易编号”才是与 Lazada 店铺后台一致的平台订单号，必须作为业务主键。
    const platformOrderId = tradeNumber || sourceOrderId;
    const businessOrderId = isLazada ? platformOrderId : sourceOrderId || tradeNumber;
    const displayOrderId = platformOrderId;
    const orderKey = `${this.config.shopId}:${businessOrderId}`;
    const legacyOrderKey = isLazada && sourceOrderId && sourceOrderId !== businessOrderId
      ? `${this.config.shopId}:${sourceOrderId}` : "";
    const shopName = bounded(raw.shopName || raw["店铺名"]);
    const countryCode = bounded(raw.countryCode || raw["国家代码"] || this.config.countryCode);
    const orderStatus = bounded(raw.orderStatus || raw["订单状态"]);
    const warehouse = bounded(raw.warehouse || raw["仓库"]);
    const sku = bounded(raw.sku || raw["SKU"]);
    const quantity = Number(raw.quantity || raw["商品数量"] || 0);
    const inventoryRaw = firstDefined(raw.availableQuantity, raw.inventoryQuantity, raw.stock, raw["商品库存"]);
    const paidAt = bounded(raw.paidAt || raw["付款时间"], 80);
    const inventory = inventoryState(inventoryRaw, quantity);
    const warehouseRouting = productPrefixWarehouseState(raw, this.config.shopId, warehouse);
    const exclusions = [];
    if (!sourceOrderId && !tradeNumber) exclusions.push("MISSING_ORDER_ID");
    if (shopName !== this.config.shopName) exclusions.push("SHOP_MISMATCH");
    if (countryCode && countryCode !== this.config.countryCode) exclusions.push("COUNTRY_MISMATCH");
    if (orderStatus !== this.config.pendingStatus) exclusions.push("STATUS_NOT_PENDING");
    if (!warehouse) exclusions.push("MISSING_WAREHOUSE");
    if (warehouse && !isGiftSkuWarehouse(warehouse)
      && Array.isArray(this.config.allowedWarehouses) && this.config.allowedWarehouses.length
      && !this.config.allowedWarehouses.includes(warehouse)) exclusions.push("WAREHOUSE_NOT_ALLOWED");
    if (warehouseRouting && !warehouseRouting.matched) exclusions.push("PRODUCT_PREFIX_WAREHOUSE_MISMATCH");
    if (!sku) exclusions.push("MISSING_SKU");
    if (!Number.isFinite(quantity) || quantity <= 0) exclusions.push("INVALID_QUANTITY");
    if (inventory.stockStatus === "out_of_stock") exclusions.push("OUT_OF_STOCK");
    if (inventory.stockStatus === "unknown") exclusions.push("INVENTORY_UNKNOWN");
    if (this.repository.isCompleted(orderKey) || (legacyOrderKey && this.repository.isCompleted(legacyOrderKey))) {
      exclusions.push("ALREADY_FULFILLED");
    }
    if (activeDispatchOrderKeys?.has(orderKey) || (legacyOrderKey && activeDispatchOrderKeys?.has(legacyOrderKey))) {
      exclusions.push("QUEUED_FOR_FULFILLMENT");
    }
    return {
      orderKey, displayOrderId, tradeNumber, platformOrderId, warehouse, skuCount: sku ? 1 : 0,
      stockStatus: inventory.stockStatus, isOutOfStock: inventory.isOutOfStock,
      requiredQuantity: Number.isFinite(quantity) ? quantity : null, availableQuantity: inventory.availableQuantity,
      eligible: exclusions.length === 0, exclusions,
      snapshot: { sourceOrderId, tradeNumber, platformOrderId, shopName, countryCode, orderStatus, warehouse, sku, quantity,
        inventoryRaw: bounded(inventoryRaw, 80), paidAt,
        warehouseRouting: warehouseRouting ? { prefix: warehouseRouting.prefix,
          expectedWarehouses: warehouseRouting.expectedWarehouses, warehouse: warehouseRouting.warehouse,
          matched: warehouseRouting.matched } : null },
    };
  }

  aggregateOrders(rows) {
    const groups = new Map();
    for (const row of rows) {
      const group = groups.get(row.orderKey);
      if (group) group.push(row); else groups.set(row.orderKey, [row]);
    }
    return [...groups.values()].map((group) => {
      const first = group[0];
      const itemGroups = new Map();
      for (const row of group) {
        const sku = row.snapshot.sku;
        const key = sku || `__missing_${itemGroups.size}`;
        const current = itemGroups.get(key) || { sku, requiredQuantity: 0, inventoryValues: [], warehouses: [] };
        if (Number.isFinite(row.snapshot.quantity) && row.snapshot.quantity > 0) current.requiredQuantity += row.snapshot.quantity;
        current.inventoryValues.push(row.snapshot.inventoryRaw);
        if (row.snapshot.warehouse) current.warehouses.push(row.snapshot.warehouse);
        itemGroups.set(key, current);
      }
      const items = [...itemGroups.values()].map((item) => {
        const numericStocks = item.inventoryValues.map((value) => bounded(value, 80).replace(/,/g, ""))
          .filter((value) => /^-?\d+(?:\.\d+)?$/.test(value)).map(Number);
        const inventoryRaw = numericStocks.length === item.inventoryValues.length
          ? Math.min(...numericStocks)
          : item.inventoryValues.find((value) => inventoryState(value, item.requiredQuantity).stockStatus === "out_of_stock")
            ?? item.inventoryValues.find((value) => inventoryState(value, item.requiredQuantity).stockStatus === "unknown")
            ?? item.inventoryValues[0];
        return { sku: item.sku, requiredQuantity: item.requiredQuantity, inventoryRaw: bounded(inventoryRaw, 80),
          warehouses: [...new Set(item.warehouses.map((value) => bounded(value, 160)).filter(Boolean))].sort(),
          ...inventoryState(inventoryRaw, item.requiredQuantity) };
      });
      const warehouses = [...new Set(group.map((row) => row.snapshot.warehouse).filter(Boolean))].sort();
      const giftWarehouses = warehouses.filter(isGiftSkuWarehouse);
      const fulfillmentWarehouses = warehouses.filter((warehouse) => !isGiftSkuWarehouse(warehouse));
      const hasGiftItems = items.some((item) => item.warehouses.some(isGiftSkuWarehouse));
      const hasSellableItems = items.some((item) => item.warehouses.some((warehouse) => !isGiftSkuWarehouse(warehouse)));
      const outOfStockItemCount = items.filter((item) => item.stockStatus === "out_of_stock").length;
      const unknownStockItemCount = items.filter((item) => item.stockStatus === "unknown").length;
      const exclusions = [...new Set(group.flatMap((row) => row.exclusions)
        .filter((code) => code !== "OUT_OF_STOCK" && code !== "INVENTORY_UNKNOWN"))];
      if (outOfStockItemCount) exclusions.push("OUT_OF_STOCK");
      if (unknownStockItemCount) exclusions.push("INVENTORY_UNKNOWN");
      const warehouseRoutingIssues = group.map((row) => row.snapshot.warehouseRouting)
        .filter((routing) => routing && !routing.matched)
        .filter((routing, index, all) => all.findIndex((item) => item.prefix === routing.prefix
          && item.warehouse === routing.warehouse) === index);
      if (!hasSellableItems && hasGiftItems) exclusions.push("GIFT_ONLY_ORDER_NOT_ALLOWED");
      if (fulfillmentWarehouses.length > 1) exclusions.push("MULTI_WAREHOUSE_REQUIRES_REVIEW");
      const totalItemQuantity = items.reduce((sum, item) => sum + item.requiredQuantity, 0);
      const stockStatus = outOfStockItemCount ? "out_of_stock" : unknownStockItemCount ? "unknown" : "in_stock";
      return {
        ...first, warehouse: warehouses.join(" / ") || first.warehouse, warehouses, giftWarehouses, fulfillmentWarehouses,
        skuCount: new Set(items.map((item) => item.sku).filter(Boolean)).size,
        stockStatus, isOutOfStock: outOfStockItemCount ? true : unknownStockItemCount ? null : false,
        requiredQuantity: totalItemQuantity, totalItemQuantity,
        availableQuantity: items.length === 1 ? items[0].availableQuantity : null,
        outOfStockItemCount, unknownStockItemCount, eligible: exclusions.length === 0, exclusions,
        snapshot: { ...first.snapshot, warehouse: warehouses.join(" / ") || first.snapshot.warehouse,
          warehouses, giftWarehouses, fulfillmentWarehouses,
          warehouseRoutingIssues,
          sku: undefined, quantity: undefined, inventoryRaw: undefined, items },
      };
    });
  }

  previewRequest({ limit = this.config.maxBatchSize, orderIds } = {}) {
    const hasOrderIds = orderIds !== undefined;
    if (hasOrderIds && !Array.isArray(orderIds)) throw new FulfillmentError("INVALID_ORDER_IDS", "orderIds 必须是订单号数组");
    const requestedOrderIds = hasOrderIds
      ? [...new Set(orderIds.map((value) => bounded(value, 100)).filter(Boolean))]
      : [];
    if (hasOrderIds && (requestedOrderIds.length < 1 || requestedOrderIds.length > this.config.maxBatchSize)) {
      throw new FulfillmentError("INVALID_ORDER_IDS", `每次必须指定1-${this.config.maxBatchSize}个有效订单号`);
    }
    const requested = hasOrderIds ? requestedOrderIds.length : Number(limit);
    if (!hasOrderIds && (!Number.isInteger(requested) || requested < 1 || requested > this.config.maxBatchSize)) {
      throw new FulfillmentError("INVALID_LIMIT", `每批只能处理1-${this.config.maxBatchSize}单`);
    }
    return { hasOrderIds, requestedOrderIds, requested };
  }

  async createPreview(options = {}) {
    const request = this.previewRequest(options);
    const raw = await this.source.listPending({ shopId: this.config.shopId, shopName: this.config.shopName,
      status: this.config.pendingStatus, statusId: this.config.pendingStatusId,
      limit: request.requested, orderIds: request.requestedOrderIds });
    return this.createPreviewFromRaw(raw, request);
  }

  createPreviewFromRecords(records, options = {}) {
    if (!Array.isArray(records)) throw new FulfillmentError("INVALID_SCAN_RECORDS", "共享扫描结果格式无效", 500);
    const request = this.previewRequest(options);
    if (request.hasOrderIds) throw new FulfillmentError("INVALID_SCAN_RECORDS", "共享扫描不支持指定订单号", 500);
    return this.createPreviewFromRaw(records, request);
  }

  preparePreviewOrders(raw, { hasOrderIds, requestedOrderIds }) {
    const activeDispatchOrderKeys = new Set(this.repository.listActiveDispatchOrderKeys(this.config.shopId));
    let normalized = this.aggregateOrders(raw.map((order) => this.normalizeOrder(order, activeDispatchOrderKeys)));
    const nowMs = this.now().getTime();
    normalized = normalized.map((order) => {
      const ageState = orderAgeState(order, nowMs, this.config.minOrderAgeMinutes);
      if (!ageState) return order;
      const exclusions = [...new Set([...order.exclusions, ageState.code])];
      return { ...order, eligible: false, exclusions,
        snapshot: { ...order.snapshot, ageMinutes: ageState.ageMinutes, retryAt: ageState.retryAt } };
    });
    if (!hasOrderIds) normalized.sort((left, right) => paidTimestamp(left) - paidTimestamp(right));
    if (hasOrderIds) {
      const wanted = new Set(requestedOrderIds);
      normalized = normalized.filter((order) => wanted.has(order.snapshot.platformOrderId)
        || wanted.has(order.snapshot.sourceOrderId) || wanted.has(order.tradeNumber));
      const found = new Set(normalized.flatMap((order) => [order.snapshot.platformOrderId,
        order.snapshot.sourceOrderId, order.tradeNumber]).filter(Boolean));
      for (const requestedOrderId of requestedOrderIds.filter((id) => !found.has(id))) {
        normalized.push({
          orderKey: `${this.config.shopId}:requested:${requestedOrderId}`, displayOrderId: requestedOrderId,
          tradeNumber: "", warehouse: "", skuCount: 0, stockStatus: "unknown", isOutOfStock: null,
          requiredQuantity: 0, totalItemQuantity: 0, availableQuantity: null,
          outOfStockItemCount: 0, unknownStockItemCount: 0, eligible: false,
          exclusions: ["ORDER_NOT_FOUND_OR_NOT_PENDING"],
          snapshot: { sourceOrderId: "", requestedOrderId, orderStatus: "", items: [] },
        });
      }
    }
    return normalized;
  }

  persistPreviewOrders(orders) {
    const confirmationToken = randomBytes(24).toString("base64url");
    const createdAt = this.now();
    const preview = this.repository.createPreview({
      id: randomUUID(), status: "pending", shopId: this.config.shopId, shopName: this.config.shopName,
      channelId: this.config.channelId, channelName: this.config.channelName, confirmationHash: hash(confirmationToken),
      createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + this.config.previewTtlSeconds * 1000).toISOString(),
    }, orders);
    return this.presentPreview(preview, confirmationToken);
  }

  createPreviewFromRaw(raw, { hasOrderIds, requestedOrderIds, requested }) {
    const normalized = this.preparePreviewOrders(raw, { hasOrderIds, requestedOrderIds });
    const eligible = normalized.filter((order) => order.eligible).slice(0, requested);
    const excluded = normalized.filter((order) => !order.eligible);
    return this.persistPreviewOrders([...eligible, ...excluded]);
  }

  createBacklogPreviewsFromRecords(records, { limit = this.config.maxBatchSize, maxPreviews = 5 } = {}) {
    if (!Array.isArray(records)) throw new FulfillmentError("INVALID_SCAN_RECORDS", "共享扫描结果格式无效", 500);
    const request = this.previewRequest({ limit });
    const rounds = Math.max(1, Math.min(Number(maxPreviews) || 1, 10));
    const normalized = this.preparePreviewOrders(records, request);
    const eligible = normalized.filter((order) => order.eligible).slice(0, request.requested * rounds);
    const excluded = normalized.filter((order) => !order.eligible);
    if (!eligible.length) return [this.persistPreviewOrders(excluded)];
    const previews = [];
    for (let offset = 0; offset < eligible.length; offset += request.requested) {
      const chunk = eligible.slice(offset, offset + request.requested);
      previews.push(this.persistPreviewOrders(previews.length ? chunk : [...chunk, ...excluded]));
    }
    return previews;
  }

  presentPreview(preview, confirmationToken = undefined) {
    const presentOrder = ({ snapshot, orderKey, ...order }) => {
      const items = Array.isArray(snapshot.items) ? snapshot.items : [{ requiredQuantity: Number(snapshot.quantity), inventoryRaw: snapshot.inventoryRaw }];
      const inventoryItems = items.map((item) => ({ ...item, ...inventoryState(item.inventoryRaw, Number(item.requiredQuantity)) }));
      const outOfStockItemCount = inventoryItems.filter((item) => item.stockStatus === "out_of_stock").length;
      const unknownStockItemCount = inventoryItems.filter((item) => item.stockStatus === "unknown").length;
      const totalItemQuantity = inventoryItems.reduce((sum, item) => sum + (Number.isFinite(Number(item.requiredQuantity)) ? Number(item.requiredQuantity) : 0), 0);
      const stockStatus = outOfStockItemCount ? "out_of_stock" : (unknownStockItemCount || inventoryItems.length === 0) ? "unknown" : "in_stock";
      const warehouses = [...new Set((snapshot.warehouses || [snapshot.warehouse]).map((value) => bounded(value, 160)).filter(Boolean))].sort();
      const warehouseRoutingIssues = Array.isArray(snapshot.warehouseRoutingIssues) ? snapshot.warehouseRoutingIssues : [];
      return { ...order, warehouse: warehouses.join(" / ") || order.warehouse, warehouses,
        ...(warehouseRoutingIssues.length ? { warehouseRoutingIssues } : {}),
        requiredQuantity: totalItemQuantity, totalItemQuantity,
        availableQuantity: inventoryItems.length === 1 ? inventoryItems[0].availableQuantity : null,
        outOfStockItemCount, unknownStockItemCount,
        stockStatus, isOutOfStock: outOfStockItemCount ? true : (unknownStockItemCount || inventoryItems.length === 0) ? null : false };
    };
    const response = {
      previewId: preview.id, status: preview.status, expiresAt: preview.expiresAt,
      shop: { id: preview.shopId, name: preview.shopName }, channel: { id: preview.channelId, name: preview.channelName },
      oldestEligiblePaidAt: preview.orders.filter((order) => order.eligible)
        .map((order) => order.snapshot?.paidAt).filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null,
      eligibleOrders: preview.orders.filter((order) => order.eligible).map(presentOrder),
      excludedOrders: preview.orders.filter((order) => !order.eligible).map(presentOrder),
      requiresConfirmation: true,
    };
    if (confirmationToken) response.confirmationToken = confirmationToken;
    return response;
  }

  getPreview(id) {
    const preview = this.repository.getPreview(id);
    if (!preview) throw new FulfillmentError("PREVIEW_NOT_FOUND", "预览不存在", 404);
    return this.presentPreview(preview);
  }

  async recheckManualReview(orderId, preflight) {
    const reference = bounded(orderId, 100);
    if (!reference) throw new FulfillmentError("INVALID_ORDER_ID", "必须指定需要重新核对的订单号");
    const review = this.repository.getManualReview(this.config.shopId, reference);
    if (!review) throw new FulfillmentError("MANUAL_REVIEW_NOT_FOUND", "没有找到可重新核对的人工处理订单", 404);
    const currentOrders = await this.source.getByIds([reference]);
    const current = this.currentMap(currentOrders).get(reference);
    if (!current) throw new FulfillmentError("ORDER_NOT_FOUND_OR_NOT_PENDING",
      "订单尚未回到待处理状态，或马帮当前无法读取该订单", 409);
    const blockers = current.exclusions.filter((code) => code !== "ALREADY_FULFILLED");
    if (blockers.length) {
      const code = blockers.includes("MULTI_WAREHOUSE_REQUIRES_REVIEW")
        ? "MULTI_WAREHOUSE_REQUIRES_REVIEW" : "MANUAL_REVIEW_RECHECK_FAILED";
      throw new FulfillmentError(code, code === "MULTI_WAREHOUSE_REQUIRES_REVIEW"
        ? "订单中的SKU仍属于不同仓库，请完成换仓后再重新核对"
        : "订单仍未通过待处理、库存、仓库或信息完整性检查", 409,
      { orderId: reference, exclusions: blockers, warehouses: current.warehouses || [] });
    }
    if (!preflight?.run) throw new FulfillmentError("PREFLIGHT_UNAVAILABLE", "深度预检服务不可用", 503);
    const checked = await preflight.run(reference, {
      singleWarehouseVerified: warehouseState(current).singleFulfillmentWarehouseVerified,
    });
    if (!preflightPassed(checked)) {
      throw new FulfillmentError("MANUAL_REVIEW_PREFLIGHT_FAILED", "订单深度预检仍未通过，人工处理锁未解除", 409);
    }
    const releasedAt = this.now().toISOString();
    if (!this.repository.releaseManualReview(review, releasedAt)) {
      throw new FulfillmentError("MANUAL_REVIEW_CHANGED", "人工处理状态已经变化，请刷新后重试", 409);
    }
    return {
      released: true, releasedAt, orderId: reference, previousErrorCode: review.errorCode,
      shop: { id: this.config.shopId, name: this.config.shopName },
      warehouse: current.warehouse, warehouses: current.warehouses || [current.warehouse].filter(Boolean),
      skuCount: current.skuCount, requiredQuantity: current.requiredQuantity,
      stockStatus: current.stockStatus, channelMatched: checked.channelMatched,
      nextStep: "订单已解除人工处理锁，将在下一轮扫描重新进入正常预览；本次没有提交发货。",
    };
  }

  async autoRecoverManualReviews({ records = null, limit = 5 } = {}) {
    const reviews = this.repository.listRecoverableManualReviews(this.config.shopId, limit);
    const result = { shop: { id: this.config.shopId, name: this.config.shopName }, checked: 0,
      firstPass: [], released: [], retained: [] };
    if (!reviews.length || !this.preflight?.run) return result;
    let currentById = Array.isArray(records) ? this.currentMap(records) : new Map();
    const missing = reviews.filter((review) => !currentById.has(review.displayOrderId)).map((review) => review.displayOrderId);
    if (missing.length) {
      try {
        const targeted = await this.source.getByIds(missing);
        currentById = new Map([...currentById, ...this.currentMap(targeted)]);
      } catch (error) {
        for (const review of reviews) result.retained.push({ orderId: review.displayOrderId,
          code: bounded(error?.code || "AUTO_RECOVERY_READ_FAILED", 80) });
        return result;
      }
    }
    for (const review of reviews) {
      result.checked += 1;
      const current = currentById.get(review.displayOrderId);
      const blockers = current?.exclusions?.filter((code) => code !== "ALREADY_FULFILLED") || ["ORDER_NOT_FOUND_OR_NOT_PENDING"];
      if (!current || blockers.length || !warehouseState(current).singleFulfillmentWarehouseVerified) {
        this.repository.resetManualRecovery(review);
        result.retained.push({ orderId: review.displayOrderId, code: blockers[0] || "MULTI_WAREHOUSE_REQUIRES_REVIEW" });
        continue;
      }
      try {
        const checked = await this.preflight.run(review.displayOrderId, { singleWarehouseVerified: true });
        if (!preflightPassed(checked)) throw Object.assign(new Error("深度预检未通过"), { code: "AUTO_RECOVERY_PREFLIGHT_FAILED" });
        const passed = this.repository.recordManualRecoveryPass(review, this.now().toISOString());
        if (!passed) {
          result.retained.push({ orderId: review.displayOrderId, code: "MANUAL_REVIEW_CHANGED" });
        } else if (passed.passCount < 2) {
          result.firstPass.push({ orderId: review.displayOrderId, passCount: passed.passCount });
        } else if (this.repository.releaseManualReview(review, this.now().toISOString())) {
          result.released.push({ orderId: review.displayOrderId, previousErrorCode: review.errorCode });
        } else {
          result.retained.push({ orderId: review.displayOrderId, code: "MANUAL_REVIEW_CHANGED" });
        }
      } catch (error) {
        this.repository.resetManualRecovery(review);
        result.retained.push({ orderId: review.displayOrderId,
          code: bounded(error?.code || "AUTO_RECOVERY_PREFLIGHT_FAILED", 80) });
      }
    }
    if (result.released.length) this.notifier.notify({ title: `${this.config.shopName} 人工锁已自动解除`,
      message: `${result.released.length} 笔订单连续两轮复核通过，将在下一轮扫描重新进入发货流程。` });
    return result;
  }

  async runPreflight(orderId, preflight) {
    const reference = bounded(orderId, 100);
    if (!reference) throw new FulfillmentError("INVALID_ORDER_ID", "必须指定一个订单号");
    const currentOrders = await this.source.getByIds([reference]);
    const current = this.currentMap(currentOrders).get(reference);
    if (!current) throw new FulfillmentError("ORDER_NOT_FOUND_OR_NOT_PENDING",
      "订单不存在、不是待处理状态或马帮当前无法读取", 409);
    const blockers = current.exclusions.filter((code) => code !== "ALREADY_FULFILLED");
    if (blockers.length) {
      const code = blockers.includes("MULTI_WAREHOUSE_REQUIRES_REVIEW")
        ? "MULTI_WAREHOUSE_REQUIRES_REVIEW" : "PREFLIGHT_FAILED";
      throw new FulfillmentError(code, code === "MULTI_WAREHOUSE_REQUIRES_REVIEW"
        ? "订单中的 SKU 仍属于不同仓库" : "订单未通过待处理、库存、仓库或信息完整性检查", 409,
      { orderId: reference, exclusions: blockers, warehouses: current.warehouses || [] });
    }
    const checked = await preflight.run(reference, {
      singleWarehouseVerified: warehouseState(current).singleFulfillmentWarehouseVerified,
    });
    return { ...checked, warehouse: current.warehouse,
      warehouses: current.warehouses || [current.warehouse].filter(Boolean), skuCount: current.skuCount };
  }

  currentMap(rawOrders) {
    const map = new Map();
    for (const order of this.aggregateOrders(rawOrders.map((raw) => this.normalizeOrder(raw)))) {
      for (const key of [order.snapshot.platformOrderId, order.tradeNumber, order.snapshot.sourceOrderId].filter(Boolean)) map.set(key, order);
    }
    return map;
  }

  async reconcileInterruptedOrders({ limit = 5 } = {}) {
    const reviews = this.repository.listInterruptedManualReviews?.(this.config.shopId, limit) || [];
    const result = { shop: { id: this.config.shopId, name: this.config.shopName }, checked: 0,
      completed: [], trackingRecovery: [], safeToRecheck: [], retained: [] };
    if (!reviews.length || typeof this.trackingRecovery?.inspectState !== "function") return result;
    const completedStatus = /(配货中|已发货|待揽收|已妥投|已完成)/;
    const pendingStatus = /(待处理|^2$)/;
    for (const review of reviews) {
      result.checked += 1;
      try {
        const state = await this.trackingRecovery.inspectState(review.displayOrderId);
        if ((state.shopId && String(state.shopId) !== String(this.config.shopId))
          || (state.platformId && String(state.platformId) !== String(this.config.platformId))) {
          result.retained.push({ orderId: review.displayOrderId, code: "RESTART_RECONCILIATION_SCOPE_MISMATCH" });
          continue;
        }
        if (completedStatus.test(state.orderStatus) && state.trackingNumber) {
          const completedAt = this.now().toISOString();
          if (this.repository.resolveInterruptedReviewAsSuccess(review, { completedAt,
            trackingNumberMasked: maskTracking(state.trackingNumber), afterStatus: state.orderStatus })) {
            result.completed.push({ orderId: review.displayOrderId, status: state.orderStatus });
          }
          continue;
        }
        if (pendingStatus.test(state.orderStatus) && (state.trackingNumber || state.shippingRecordPending)) {
          const submittedAt = this.now().toISOString();
          const nextCheckAt = new Date(this.now().getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString();
          const deadlineAt = new Date(this.now().getTime() + this.config.trackingRecoveryDeadlineHours * 3600000).toISOString();
          if (this.repository.moveInterruptedReviewToTrackingRecovery(review, { submittedAt, nextCheckAt, deadlineAt,
            trackingNumberMasked: maskTracking(state.trackingNumber) })) {
            result.trackingRecovery.push({ orderId: review.displayOrderId,
              status: state.trackingNumber ? "tracking_found" : "tracking_pending" });
          }
          continue;
        }
        if (pendingStatus.test(state.orderStatus) && !state.trackingNumber && !state.shippingRecordPending) {
          result.safeToRecheck.push({ orderId: review.displayOrderId, status: state.orderStatus });
          continue;
        }
        result.retained.push({ orderId: review.displayOrderId, code: "RESTART_RECONCILIATION_UNCERTAIN_STATE",
          status: state.orderStatus || "unknown" });
      } catch (error) {
        result.retained.push({ orderId: review.displayOrderId,
          code: bounded(error?.code || "RESTART_RECONCILIATION_FAILED", 80) });
      }
    }
    if (result.completed.length || result.trackingRecovery.length) {
      this.notifier.notify({ title: `${this.config.shopName} 宕机订单已完成对账`,
        message: `${result.completed.length} 单确认已发货，${result.trackingRecovery.length} 单转入运单恢复，未执行重复交运。` });
    }
    return result;
  }

  currentOrderFor(previewOrder, map) {
    return map.get(previewOrder.snapshot.platformOrderId) || map.get(previewOrder.tradeNumber)
      || map.get(previewOrder.snapshot.sourceOrderId);
  }

  revalidationIssue(previewOrder, currentOrder) {
    if (!currentOrder) return { code: "ORDER_NOT_FOUND_BEFORE_SUBMIT", message: "订单已无法读取" };
    if (currentOrder.stockStatus === "out_of_stock") return { code: "OUT_OF_STOCK_BEFORE_SUBMIT", message: "提交前库存不足" };
    if (currentOrder.stockStatus === "unknown") return { code: "INVENTORY_UNKNOWN_BEFORE_SUBMIT", message: "提交前库存无法确认" };
    if (currentOrder.exclusions.includes("PRODUCT_PREFIX_WAREHOUSE_MISMATCH")) {
      return { code: "PRODUCT_PREFIX_WAREHOUSE_MISMATCH_BEFORE_SUBMIT", message: "商品名称前缀与分配仓库不匹配，请先人工换仓" };
    }
    if (!currentOrder.eligible) return { code: "ORDER_CHANGED_BEFORE_SUBMIT", message: "订单状态或信息已变化" };
    if (orderShape(previewOrder.snapshot) !== orderShape(currentOrder.snapshot)
      || itemShape(previewOrder.snapshot) !== itemShape(currentOrder.snapshot)) {
      return { code: "ORDER_CHANGED_BEFORE_SUBMIT", message: "订单仓库、状态、SKU或数量已变化" };
    }
    if (inventoryShape(previewOrder.snapshot) !== inventoryShape(currentOrder.snapshot)) {
      return { code: "INVENTORY_CHANGED_AFTER_PREVIEW", message: "库存与预览时不一致" };
    }
    return null;
  }

  throwBatchRevalidation(issues) {
    if (!issues.length) return;
    const priorities = ["OUT_OF_STOCK_BEFORE_SUBMIT", "INVENTORY_UNKNOWN_BEFORE_SUBMIT", "INVENTORY_CHANGED_AFTER_PREVIEW"];
    const code = priorities.find((candidate) => issues.some((issue) => issue.code === candidate)) || "ORDERS_CHANGED";
    const messages = {
      OUT_OF_STOCK_BEFORE_SUBMIT: "提交前发现缺货，整批已停止，请重新生成预览",
      INVENTORY_UNKNOWN_BEFORE_SUBMIT: "提交前库存无法确认，整批已停止，请重新生成预览",
      INVENTORY_CHANGED_AFTER_PREVIEW: "库存与预览时不一致，整批已停止，请重新生成预览",
      ORDERS_CHANGED: "订单状态或信息已变化，整批已停止，请重新生成预览",
    };
    throw new FulfillmentError(code, messages[code], 409, { orders: issues.map(({ displayOrderId, code: issueCode }) => ({ displayOrderId, code: issueCode })) });
  }

  createConfirmedBatch(id, confirmationToken) {
    const preview = this.repository.getPreview(id);
    if (!preview) throw new FulfillmentError("PREVIEW_NOT_FOUND", "预览不存在", 404);
    if (preview.status !== "pending") throw new FulfillmentError("PREVIEW_ALREADY_USED", "预览已经确认或失效", 409);
    if (new Date(preview.expiresAt) <= this.now()) throw new FulfillmentError("PREVIEW_EXPIRED", "预览已超过10分钟，请重新生成", 409);
    if (!safeEqual(preview.confirmationHash, hash(confirmationToken || ""))) throw new FulfillmentError("CONFIRMATION_INVALID", "确认令牌无效", 403);
    if (!this.config.realSubmitEnabled) throw new FulfillmentError("REAL_SUBMIT_DISABLED", "真实发货开关尚未启用", 409);
    const selected = preview.orders.filter((order) => order.eligible);
    if (!selected.length) throw new FulfillmentError("NO_ELIGIBLE_ORDERS", "预览中没有可发货订单", 409);
    const createdAt = this.now().toISOString();
    let batch;
    try {
      batch = this.repository.createBatch({ id: randomUUID(), previewId: preview.id, status: "queued", createdAt }, selected);
    } catch (error) {
      if (["BATCH_ALREADY_RUNNING", "PREVIEW_ALREADY_USED", "IDEMPOTENCY_CONFLICT"].includes(error.code)) {
        throw new FulfillmentError(error.code, error.message, 409);
      }
      throw error;
    }
    return { batch, selected };
  }

  createQueuedDispatchBatch(id) {
    const dispatch = this.repository.getDispatchByPreview(id);
    if (!dispatch || dispatch.status !== "queued") {
      throw new FulfillmentError("DISPATCH_NOT_QUEUED", "自动发货候选不在待执行队列中", 409);
    }
    const preview = this.repository.getPreview(id);
    if (!preview) throw new FulfillmentError("PREVIEW_NOT_FOUND", "预览不存在", 404);
    if (preview.status !== "pending") throw new FulfillmentError("PREVIEW_ALREADY_USED", "预览已经确认或失效", 409);
    if (!this.config.realSubmitEnabled) throw new FulfillmentError("REAL_SUBMIT_DISABLED", "真实发货开关尚未启用", 409);
    const selected = preview.orders.filter((order) => order.eligible);
    if (!selected.length) throw new FulfillmentError("NO_ELIGIBLE_ORDERS", "预览中没有可发货订单", 409);
    const createdAt = this.now().toISOString();
    let batch;
    try {
      batch = this.repository.createBatch({ id: randomUUID(), previewId: preview.id, status: "queued", createdAt }, selected);
    } catch (error) {
      if (["BATCH_ALREADY_RUNNING", "PREVIEW_ALREADY_USED", "IDEMPOTENCY_CONFLICT"].includes(error.code)) {
        throw new FulfillmentError(error.code, error.message, 409);
      }
      throw error;
    }
    return { batch, selected, dispatch };
  }

  failBatchBeforeSubmit(batch, selected, error, timings = null) {
    for (const order of selected) this.repository.updateBatchOrder(batch.id, order.orderKey, {
      status: "failed", errorCode: bounded(error.code || "PRE_SUBMIT_CHECK_FAILED", 80),
      errorMessage: bounded(error.message), timings, updatedAt: this.now().toISOString(),
    });
    if (timings) this.repository.updateBatchTimings(batch.id, timings);
    const finished = this.repository.finishBatch(batch.id, "failed", this.now().toISOString());
    this.notifier.notify({ title: `${this.config.shopName} 发货批次失败`, message: `批次 ${batch.id} 提交前检查未通过，请打开工作台处理。` });
    return finished;
  }

  async processBatch(batch, selected) {
    const batchStartedMs = Date.now();
    this.repository.startBatch(batch.id);
    let currentById;
    let executable = selected;
    let revalidationMs = 0;
    try {
      const revalidationStartedMs = Date.now();
      const current = await this.source.getByIds(selected.map((order) => order.tradeNumber || order.snapshot.sourceOrderId));
      currentById = this.currentMap(current);
      const preflightIssues = selected.map((order) => ({ displayOrderId: order.displayOrderId,
        ...this.revalidationIssue(order, this.currentOrderFor(order, currentById)) })).filter((issue) => issue.code);
      revalidationMs = Date.now() - revalidationStartedMs;
      if (preflightIssues.length) {
        const issuesByOrderId = new Map(preflightIssues.map((issue) => [issue.displayOrderId, issue]));
        const updatedAt = this.now().toISOString();
        for (const order of selected) {
          const issue = issuesByOrderId.get(order.displayOrderId);
          if (!issue) continue;
          this.repository.updateBatchOrder(batch.id, order.orderKey, {
            status: manualAttentionFailureCodes.has(issue.code) ? "needs_attention" : "failed",
            errorCode: issue.code, errorMessage: issue.message,
            timings: { preSubmitRevalidation: revalidationMs }, updatedAt,
          });
        }
        executable = selected.filter((order) => !issuesByOrderId.has(order.displayOrderId));
      }
      this.repository.updateBatchTimings(batch.id, { preSubmitRevalidation: revalidationMs,
        orderConcurrency: Math.min(2, Math.max(1, Number(this.config.orderConcurrency || 1))), total: null });
    } catch (error) {
      const timings = { preSubmitRevalidation: Date.now() - batchStartedMs, total: Date.now() - batchStartedMs };
      return this.failBatchBeforeSubmit(batch, selected, error, timings);
    }
    const orderConcurrency = Math.min(2, Math.max(1, Number(this.config.orderConcurrency || 1)));
    let successes = 0;
    const executeOrder = async (order) => {
      const orderStartedMs = Date.now();
      try {
        // 整批详细库存已在上方一次性复检；执行器仍会在每单真正提交前精确回查
        // 店铺、平台、待处理状态、空运单号、库存标志与固定物流渠道。
        const currentOrder = this.currentOrderFor(order, currentById);
        const result = await this.executor.fulfill({ order: currentOrder, channel: {
          id: this.config.channelId, providerId: this.config.channelProviderId, name: this.config.channelName,
        }});
        return { status: result.verified ? "success" : "needs_attention", trackingNumberMasked: maskTracking(result.trackingNumber),
          afterStatus: result.afterStatus, errorCode: result.verified ? null : bounded(result.errorCode || "VERIFY_FAILED", 80),
          errorMessage: result.verified ? null : bounded(result.errorMessage || "发货后回查不一致"),
          timings: { ...(result.timings || {}), executorTotal: Date.now() - orderStartedMs } };
      } catch (error) {
        const errorCode = bounded(error.code || "FULFILLMENT_FAILED", 80);
        if (errorCode === "ALREADY_HAS_TRACKING_NUMBER" && this.trackingRecovery) {
          try {
            const reference = order.tradeNumber || order.snapshot.sourceOrderId;
            const inspection = await this.trackingRecovery.inspect(reference);
            if (!inspection?.trackingNumber) {
              return { status: "needs_attention", errorCode: "EXISTING_TRACKING_NOT_READABLE",
                errorMessage: "马帮显示订单已有运单号，但无法安全读取运单号，已转人工核查。",
                timings: { executorTotal: Date.now() - orderStartedMs } };
            }
            if (String(inspection.orderStatus || "").includes("配货中")) {
              return { status: "success", trackingNumberMasked: maskTracking(inspection.trackingNumber),
                afterStatus: inspection.orderStatus, errorCode: null, errorMessage: null,
                timings: { executorTotal: Date.now() - orderStartedMs, existingTrackingReused: true } };
            }
            const distributed = await this.trackingRecovery.distribute(reference, inspection.trackingNumber);
            if (distributed?.verified && String(distributed.afterStatus || "").includes("配货中")) {
              return { status: "success", trackingNumberMasked: maskTracking(distributed.trackingNumber || inspection.trackingNumber),
                afterStatus: distributed.afterStatus, errorCode: null, errorMessage: null,
                timings: { executorTotal: Date.now() - orderStartedMs, existingTrackingReused: true } };
            }
            return { status: "needs_attention", trackingNumberMasked: maskTracking(inspection.trackingNumber),
              afterStatus: distributed?.afterStatus || inspection.orderStatus || null,
              errorCode: "DISTRIBUTION_PENDING", errorMessage: distributed?.message || "已有运单号，等待转入配货中。",
              timings: { executorTotal: Date.now() - orderStartedMs, existingTrackingReused: true } };
          } catch (recoveryError) {
            const recoveryErrorCode = bounded(recoveryError.code || "EXISTING_TRACKING_RECOVERY_FAILED", 80);
            return { status: manualAttentionFailureCodes.has(recoveryErrorCode) ? "needs_attention" : "failed",
              errorCode: recoveryErrorCode, errorMessage: bounded(recoveryError.message),
              timings: { executorTotal: Date.now() - orderStartedMs } };
          }
        }
        const status = manualAttentionFailureCodes.has(errorCode) ? "needs_attention" : "failed";
        return { status, errorCode, errorMessage: bounded(error.message),
          timings: { executorTotal: Date.now() - orderStartedMs } };
      }
    };
    for (let index = 0; index < executable.length; index += orderConcurrency) {
      const wave = executable.slice(index, index + orderConcurrency);
      const patches = await Promise.all(wave.map((order) => executeOrder(order)));
      patches.forEach((patch, patchIndex) => {
        const order = wave[patchIndex];
        if (patch.status === "success") successes += 1;
        const updatedAt = this.now().toISOString();
        this.repository.updateBatchOrder(batch.id, order.orderKey, { ...patch, updatedAt });
        if (["TRACKING_NUMBER_PENDING", "DISTRIBUTION_PENDING"].includes(patch.errorCode)) {
          const submittedAt = updatedAt;
          const firstRecoveryDelaySeconds = Math.min(60,
            Math.max(1, Number(this.config.trackingRecoveryCheckSeconds || 300)));
          this.repository.registerTrackingRecovery({ orderKey: order.orderKey, batchId: batch.id,
            displayOrderId: order.displayOrderId, shopId: this.config.shopId, submittedAt,
            nextCheckAt: new Date(this.now().getTime() + firstRecoveryDelaySeconds * 1000).toISOString(),
            deadlineAt: new Date(this.now().getTime() + this.config.trackingRecoveryDeadlineHours * 3600000).toISOString() });
        }
      });
      if (patches.some((patch) => mustStopLaterOrders(patch))) {
        for (const order of executable.slice(index + wave.length)) {
          this.repository.updateBatchOrder(batch.id, order.orderKey, {
            status: "skipped", errorCode: "SKIPPED_AFTER_BATCH_FAILURE",
            errorMessage: "当前并发波次出现失败，后续订单已停止", timings: { executorTotal: 0 },
            updatedAt: this.now().toISOString(),
          });
        }
        break;
      }
    }
    const status = successes === selected.length ? "success" : successes ? "partial_success" : "failed";
    this.repository.updateBatchTimings(batch.id, { preSubmitRevalidation: revalidationMs, orderConcurrency,
      execution: Math.max(0, Date.now() - batchStartedMs - revalidationMs), total: Date.now() - batchStartedMs });
    const finished = this.repository.finishBatch(batch.id, status, this.now().toISOString());
    this.notifier.notify({ title: status === "success" ? `${this.config.shopName} 发货批次完成` : `${this.config.shopName} 发货批次需处理`,
      message: `批次 ${batch.id} 已结束，状态：${status}，成功 ${successes}/${selected.length} 单。` });
    return finished;
  }

  async confirmPreview(id, confirmationToken) {
    const { batch, selected } = this.createConfirmedBatch(id, confirmationToken);
    return this.processBatch(batch, selected);
  }

  enqueuePreview(id, confirmationToken) {
    const { batch, selected } = this.createConfirmedBatch(id, confirmationToken);
    const job = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.processBatch(batch, selected))
      .catch((error) => this.failBatchBeforeSubmit(batch, selected, error));
    this.activeJobs.add(job);
    job.finally(() => this.activeJobs.delete(job));
    return batch;
  }

  enqueueQueuedPreview(id) {
    const { batch, selected } = this.createQueuedDispatchBatch(id);
    const job = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.processBatch(batch, selected))
      .catch((error) => this.failBatchBeforeSubmit(batch, selected, error));
    this.activeJobs.add(job);
    job.finally(() => this.activeJobs.delete(job));
    return batch;
  }

  async waitForIdle() {
    await Promise.allSettled([...this.activeJobs]);
  }

  listTrackingRecoveries(limit = 50) {
    return this.repository.listTrackingRecoveries(limit, this.config.shopId);
  }

  async recoverPendingTrackingNumbers({ limit = 5, orderId = null, allowReset = false } = {}) {
    if (!this.trackingRecovery) return { shop: { id: this.config.shopId, name: this.config.shopName }, checked: 0, results: [] };
    const now = this.now();
    const recoveryWriteEnabled = Boolean(this.config.trackingRecoveryResetEnabled || allowReset);
    const due = this.repository.listDueTrackingRecoveries(now.toISOString(), limit, this.config.shopId, orderId);
    const results = [];
    for (const recovery of due) {
      const checkedAt = this.now();
      if (checkedAt.getTime() >= Date.parse(recovery.deadlineAt)) {
        const errorCode = "TRACKING_APPROVAL_TIMEOUT";
        const errorMessage = "Shopee 运单号审批超过 24 小时，已停止自动恢复并转人工处理。";
        this.repository.expireTrackingRecovery(recovery, { completedAt: checkedAt.toISOString(), errorCode, errorMessage });
        this.notifier.notify({ title: `${this.config.shopName} 运单号需人工处理`, message: `${recovery.displayOrderId} 超过审批期限。` });
        results.push({ orderId: recovery.displayOrderId, status: "manual_attention", errorCode });
        continue;
      }
      try {
        const inspection = await this.trackingRecovery.inspect(recovery.displayOrderId);
        if (inspection.trackingNumber) {
          const distributed = await this.trackingRecovery.distribute(recovery.displayOrderId, inspection.trackingNumber);
          if (distributed.verified && String(distributed.afterStatus).includes("配货中")) {
            this.repository.completeTrackingRecovery(recovery, { completedAt: this.now().toISOString(),
              trackingNumberMasked: maskTracking(distributed.trackingNumber), afterStatus: distributed.afterStatus });
            this.notifier.notify({ title: `${this.config.shopName} 运单号恢复成功`,
              message: `${recovery.displayOrderId} 已获取运单号并转入配货中。` });
            results.push({ orderId: recovery.displayOrderId, status: "completed",
              trackingNumberMasked: maskTracking(distributed.trackingNumber), afterStatus: distributed.afterStatus });
          } else {
            const nextCheckAt = new Date(this.now().getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString();
            this.repository.deferTrackingRecovery(recovery.orderKey, { status: recovery.status,
              checkedAt: this.now().toISOString(), nextCheckAt, errorCode: "DISTRIBUTION_VERIFY_FAILED",
              errorMessage: distributed.message || "已有运单号，但转配货状态尚未确认。" });
            results.push({ orderId: recovery.displayOrderId, status: "waiting_distribution" });
          }
          continue;
        }

        // “resubmitting” 表示重新交运请求可能已发出但进程未能记录结果。此时只凭马帮现状收敛，绝不盲目重发。
        if (recovery.status === "resubmitting") {
          if (inspection.shippingRecordPending) {
            const nextCheckAt = new Date(checkedAt.getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString();
            this.repository.deferTrackingRecovery(recovery.orderKey, { status: "waiting_after_reset",
              checkedAt: checkedAt.toISOString(), nextCheckAt });
            results.push({ orderId: recovery.displayOrderId, status: "waiting_tracking_after_resubmit" });
          } else {
            const errorCode = "TRACKING_RESUBMIT_STATE_UNCERTAIN";
            const errorMessage = "重新交运过程曾中断，马帮未返回可确认的交运记录；为避免重复交运，已转人工处理。";
            this.repository.expireTrackingRecovery(recovery, { completedAt: checkedAt.toISOString(), errorCode, errorMessage });
            this.notifier.notify({ title: `${this.config.shopName} 运单号恢复需人工处理`,
              message: `${recovery.displayOrderId} 重新交运状态无法确认。` });
            results.push({ orderId: recovery.displayOrderId, status: "manual_attention", errorCode });
          }
          continue;
        }

        if (recovery.status === "ready_to_resubmit") {
          if (inspection.shippingRecordPending) {
            const nextCheckAt = new Date(checkedAt.getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString();
            this.repository.deferTrackingRecovery(recovery.orderKey, { status: "waiting_after_reset",
              checkedAt: checkedAt.toISOString(), nextCheckAt });
            results.push({ orderId: recovery.displayOrderId, status: "waiting_tracking_after_resubmit" });
            continue;
          }
          if (!recoveryWriteEnabled) {
            const nextCheckAt = new Date(checkedAt.getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString();
            this.repository.deferTrackingRecovery(recovery.orderKey, { status: "ready_to_resubmit",
              checkedAt: checkedAt.toISOString(), nextCheckAt, errorCode: "TRACKING_RESET_DISABLED",
              errorMessage: "自动清空渠道与重新交运开关未开启。" });
            results.push({ orderId: recovery.displayOrderId, status: "reset_disabled" });
            continue;
          }
          if (typeof this.trackingRecovery.resubmitPending !== "function") {
            const nextCheckAt = new Date(checkedAt.getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString();
            this.repository.deferTrackingRecovery(recovery.orderKey, { status: "ready_to_resubmit",
              checkedAt: checkedAt.toISOString(), nextCheckAt, errorCode: "TRACKING_RESUBMIT_ADAPTER_MISSING",
              errorMessage: "重新交运适配器尚未启用。" });
            results.push({ orderId: recovery.displayOrderId, status: "resubmit_adapter_pending" });
            continue;
          }

          // 先把不可重入状态持久化，再产生真实重新交运请求；即使服务在请求中断，也不会自动重复提交。
          const resubmitStartedAt = this.now().toISOString();
          this.repository.deferTrackingRecovery(recovery.orderKey, { status: "resubmitting",
            checkedAt: resubmitStartedAt,
            nextCheckAt: new Date(this.now().getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString() });
          try {
            const resubmitted = await this.trackingRecovery.resubmitPending(recovery.displayOrderId);
            const completedAt = this.now().toISOString();
            if (resubmitted.trackingNumber && resubmitted.verified && String(resubmitted.afterStatus).includes("配货中")) {
              this.repository.completeTrackingRecovery(recovery, { completedAt,
                trackingNumberMasked: maskTracking(resubmitted.trackingNumber), afterStatus: resubmitted.afterStatus });
              this.notifier.notify({ title: `${this.config.shopName} 运单号恢复成功`,
                message: `${recovery.displayOrderId} 重新交运后已转入配货中。` });
              results.push({ orderId: recovery.displayOrderId, status: "completed",
                trackingNumberMasked: maskTracking(resubmitted.trackingNumber), afterStatus: resubmitted.afterStatus });
            } else {
              this.repository.deferTrackingRecovery(recovery.orderKey, { status: "waiting_after_reset", checkedAt: completedAt,
                nextCheckAt: new Date(this.now().getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString() });
              results.push({ orderId: recovery.displayOrderId, status: "resubmitted_once" });
            }
          } catch (error) {
            const errorCode = bounded(error.code || "TRACKING_RESUBMIT_FAILED", 80);
            const errorMessage = `重新交运未能确认成功：${bounded(error.message)}`;
            this.repository.expireTrackingRecovery(recovery, { completedAt: this.now().toISOString(), errorCode, errorMessage });
            this.notifier.notify({ title: `${this.config.shopName} 运单号恢复需人工处理`,
              message: `${recovery.displayOrderId} 重新交运未能确认成功。` });
            results.push({ orderId: recovery.displayOrderId, status: "manual_attention", errorCode });
          }
          continue;
        }

        const elapsedMs = checkedAt.getTime() - Date.parse(recovery.submittedAt);
        const resetDue = elapsedMs >= this.config.trackingRecoveryResetMinutes * 60000 && recovery.resetCount < 1;
        if (resetDue && recoveryWriteEnabled && typeof this.trackingRecovery.resetPending === "function") {
          if (inspection.shippingRecordPending !== false) {
            try {
              await this.trackingRecovery.resetPending(recovery.displayOrderId);
            } catch (error) {
              const uncertainResetCodes = new Set(["MABANG_AUTH_EXPIRED_DURING_TRACKING_RESET",
                "TRACKING_RESET_VERIFY_FAILED", "TRACKING_RESET_EXTRA_CONFIRMATION_REQUIRED", "MABANG_RESPONSE_INVALID"]);
              if (uncertainResetCodes.has(error.code)) {
                const errorCode = bounded(error.code, 80);
                const errorMessage = `清空物流渠道的结果无法安全确认：${bounded(error.message)}`;
                this.repository.expireTrackingRecovery(recovery, { completedAt: this.now().toISOString(), errorCode, errorMessage });
                this.notifier.notify({ title: `${this.config.shopName} 运单号恢复需人工处理`,
                  message: `${recovery.displayOrderId} 清空物流渠道结果无法确认。` });
                results.push({ orderId: recovery.displayOrderId, status: "manual_attention", errorCode });
                continue;
              }
              throw error;
            }
          }
          const resetAt = this.now().toISOString();
          this.repository.deferTrackingRecovery(recovery.orderKey, { status: "ready_to_resubmit", checkedAt: resetAt,
            nextCheckAt: resetAt,
            resetCount: recovery.resetCount + 1, lastResetAt: resetAt });
          results.push({ orderId: recovery.displayOrderId, status: "channel_cleared_once" });
        } else {
          this.repository.deferTrackingRecovery(recovery.orderKey, { status: recovery.status,
            checkedAt: checkedAt.toISOString(),
            nextCheckAt: new Date(checkedAt.getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString() });
          results.push({ orderId: recovery.displayOrderId, status: resetDue && !recoveryWriteEnabled
            ? "reset_disabled" : resetDue ? "reset_adapter_pending" : "waiting_tracking" });
        }
      } catch (error) {
        this.repository.deferTrackingRecovery(recovery.orderKey, { status: recovery.status,
          checkedAt: this.now().toISOString(),
          nextCheckAt: new Date(this.now().getTime() + this.config.trackingRecoveryCheckSeconds * 1000).toISOString(),
          errorCode: bounded(error.code || "TRACKING_RECOVERY_CHECK_FAILED", 80), errorMessage: bounded(error.message) });
        results.push({ orderId: recovery.displayOrderId, status: "check_failed", errorCode: error.code || "TRACKING_RECOVERY_CHECK_FAILED" });
      }
    }
    return { shop: { id: this.config.shopId, name: this.config.shopName }, checked: due.length, results };
  }

  getActiveBatch() {
    return this.repository.getActiveBatch();
  }

  queuePreviewDispatch(previewId) {
    return this.repository.queuePreviewDispatch(previewId, this.config.shopId, this.now().toISOString());
  }

  getNextQueuedDispatch() { return this.repository.getNextQueuedDispatch(); }
  getDispatchByPreview(previewId) { return this.repository.getDispatchByPreview(previewId); }
  markDispatchRunning(id, batchId) {
    return this.repository.markDispatchRunning(id, batchId, this.now().toISOString());
  }
  finishDispatch(id, status, errorCode = null, errorMessage = null) {
    return this.repository.finishDispatch(id, status, this.now().toISOString(), errorCode,
      errorMessage == null ? null : bounded(errorMessage));
  }
  getDispatchQueueStatus(limit = 20) {
    return this.repository.getDispatchQueueStatus(this.now().toISOString(), limit);
  }

  getLatestPendingPreview() {
    const preview = this.repository.getLatestPendingPreview(this.now().toISOString(), this.config.shopId);
    return preview ? this.presentPreview(preview) : null;
  }

  listPendingPreviewSummaries(limit = 20) {
    return this.repository.listPendingPreviewSummaries(this.now().toISOString(), limit);
  }

  recordScanRun(run) {
    this.repository.recordScanRun(run);
  }

  listRecentScanRuns(limit = 10) {
    return this.repository.listRecentScanRuns(limit);
  }

  listRecentBatches(limit = 20) {
    return this.repository.listRecentBatches(limit);
  }

  issueConfirmationToken(id) {
    const preview = this.repository.getPreview(id);
    if (!preview) throw new FulfillmentError("PREVIEW_NOT_FOUND", "预览不存在", 404);
    if (preview.status !== "pending") throw new FulfillmentError("PREVIEW_ALREADY_USED", "预览已经确认或失效", 409);
    if (new Date(preview.expiresAt) <= this.now()) throw new FulfillmentError("PREVIEW_EXPIRED", "预览已过期，请重新扫描", 409);
    const confirmationToken = randomBytes(24).toString("base64url");
    if (!this.repository.updatePreviewConfirmationHash(id, hash(confirmationToken))) {
      throw new FulfillmentError("PREVIEW_ALREADY_USED", "预览已经确认或失效", 409);
    }
    return this.presentPreview(this.repository.getPreview(id), confirmationToken);
  }

  getBatch(id) {
    const batch = this.repository.getBatch(id);
    if (!batch) throw new FulfillmentError("BATCH_NOT_FOUND", "发货批次不存在", 404);
    return batch;
  }
}
