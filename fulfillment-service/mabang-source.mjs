import path from "node:path";
import { createMabangWorkerRunner } from "../lib/mabang-worker-runner.mjs";

function dateText(date) { return date.toISOString().slice(0, 10); }
function orderReference(row) {
  const sourceOrderId = String(row["订单编号"] || "").trim();
  const tradeNumber = String(row["交易编号"] || "").trim();
  // Lazada 红框订单号在导出中对应“交易编号”；“订单编号”可能是马帮内部 ID + 平台订单号。
  return platformKey(row["平台"]) === "lazada" ? tradeNumber || sourceOrderId : sourceOrderId || tradeNumber;
}
function orderTime(row) {
  const text = String(row["付款时间"] || "").trim();
  const timestamp = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function oldestOrderRows(records, maximumOrders) {
  const groups = new Map();
  for (const row of records) {
    const key = orderReference(row);
    if (!key) continue;
    const group = groups.get(key) || { key, timestamp: 0, rows: [] };
    group.timestamp = Math.max(group.timestamp, orderTime(row));
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => (left.timestamp || Number.MAX_SAFE_INTEGER) - (right.timestamp || Number.MAX_SAFE_INTEGER)
      || left.key.localeCompare(right.key))
    .slice(0, maximumOrders)
    .flatMap((group) => group.rows);
}

function normalizedText(value) { return String(value || "").trim(); }
function platformKey(value) {
  const text = normalizedText(value).toLocaleLowerCase();
  if (text.includes("shopee") || text.includes("虾皮")) return "shopee";
  if (text.includes("lazada")) return "lazada";
  return text;
}

export function inferFulfillmentPolicySuggestions(records, shops, { scannedAt = new Date().toISOString(), lookbackDays = 30 } = {}) {
  const shopsByName = new Map((shops || []).map((shop) => [normalizedText(shop.shopName), shop]));
  const orders = new Map();
  for (const row of records || []) {
    const shop = shopsByName.get(normalizedText(row["店铺名"]));
    if (!shop) continue;
    const expectedPlatform = platformKey(shop.platform || shop.platformName);
    const actualPlatform = platformKey(row["平台"]);
    if (expectedPlatform && actualPlatform && expectedPlatform !== actualPlatform) continue;
    const reference = orderReference(row);
    if (!reference) continue;
    const key = `${shop.shopId}:${reference}`;
    const order = orders.get(key) || { shop, timestamp: 0, channels: new Set(), warehouses: new Set() };
    order.timestamp = Math.max(order.timestamp, orderTime(row));
    const channel = normalizedText(row["物流渠道"]);
    const warehouse = normalizedText(row["仓库"] || row["平台订单仓库"]);
    if (channel) order.channels.add(channel);
    if (warehouse) order.warehouses.add(warehouse);
    orders.set(key, order);
  }
  const result = new Map((shops || []).map((shop) => [String(shop.shopId), {
    shopId: String(shop.shopId), shopName: shop.shopName, scannedAt, lookbackDays,
    orderCount: 0, channel: null, warehouses: [], status: "insufficient_history",
  }]));
  const stats = new Map();
  for (const order of orders.values()) {
    const shopId = String(order.shop.shopId);
    const current = stats.get(shopId) || { orderCount: 0, channels: new Map(), warehouses: new Map() };
    current.orderCount += 1;
    for (const channelName of order.channels) {
      const item = current.channels.get(channelName) || { name: channelName, orderCount: 0, lastUsedAt: 0 };
      item.orderCount += 1; item.lastUsedAt = Math.max(item.lastUsedAt, order.timestamp); current.channels.set(channelName, item);
    }
    for (const warehouseName of order.warehouses) {
      const item = current.warehouses.get(warehouseName) || { name: warehouseName, orderCount: 0, lastUsedAt: 0 };
      item.orderCount += 1; item.lastUsedAt = Math.max(item.lastUsedAt, order.timestamp); current.warehouses.set(warehouseName, item);
    }
    stats.set(shopId, current);
  }
  for (const [shopId, current] of stats) {
    const channels = [...current.channels.values()].sort((a, b) => b.orderCount - a.orderCount || b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name, "zh-CN"));
    const warehouses = [...current.warehouses.values()].sort((a, b) => b.orderCount - a.orderCount || b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name, "zh-CN"));
    const suggestion = result.get(shopId);
    suggestion.orderCount = current.orderCount;
    suggestion.channel = channels[0] ? { ...channels[0], confidence: channels[0].orderCount / current.orderCount } : null;
    suggestion.warehouses = warehouses.map((item) => ({ ...item, confidence: item.orderCount / current.orderCount }));
    suggestion.status = suggestion.channel || suggestion.warehouses.length ? "ready_for_review" : "insufficient_history";
  }
  return [...result.values()];
}

export function planFulfillmentPolicySuggestionConfirmations({ shopIds, shops, policies, suggestions, channels, hasAccess = () => true }) {
  const shopMap = shops instanceof Map ? shops : new Map((shops || []).map((shop) => [String(shop.shopId), shop]));
  const policyMap = policies instanceof Map ? policies : new Map((policies || []).map((policy) => [String(policy.shopId), policy]));
  const suggestionMap = suggestions instanceof Map ? suggestions : new Map((suggestions || []).map((item) => [String(item.shopId), item]));
  const changes = []; const skipped = [];
  for (const shopId of shopIds || []) {
    const shop = shopMap.get(String(shopId)); const policy = policyMap.get(String(shopId)); const suggestion = suggestionMap.get(String(shopId));
    if (!hasAccess(shopId) || !shop) { skipped.push({ shopId, reason: "SHOP_ACCESS_REVOKED" }); continue; }
    if (!policy || policy.updatedBy !== "catalog_sync") { skipped.push({ shopId, reason: "ALREADY_REVIEWED" }); continue; }
    const channelName = normalizedText(suggestion?.channel?.name);
    const channel = channelName ? (channels || []).find((item) => item.active && [item.channelName, item.logisticsName]
      .some((name) => normalizedText(name) === channelName)
      && (!item.platformId || String(item.platformId) === String(shop.platformId || ""))
      && (!item.countryCode || String(item.countryCode).toUpperCase() === String(shop.countryCode || "").toUpperCase())) : null;
    const warehouses = [...new Set((suggestion?.warehouses || []).map((item) => normalizedText(item.name)).filter(Boolean))].slice(0, 20);
    if (!channel || !warehouses.length) { skipped.push({ shopId, reason: "SUGGESTION_INCOMPLETE" }); continue; }
    changes.push({ ...policy, channelId: channel.channelId, warehousePolicy: "allowlist", allowedWarehouses: warehouses });
  }
  return { changes, skipped };
}

const workerSafetyCodes = [
  "CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT", "ORDER_NOT_AVAILABLE_FOR_DELIVERY",
  "OUT_OF_STOCK_BEFORE_SUBMIT", "INVENTORY_UNKNOWN_BEFORE_SUBMIT", "MULTI_WAREHOUSE_REQUIRES_REVIEW",
  "GIFT_ONLY_ORDER_NOT_ALLOWED",
  "ALREADY_HAS_TRACKING_NUMBER",
  "MABANG_AUTH_REQUIRED", "MABANG_AUTH_FAILED", "MABANG_AUTH_EXPIRED", "MABANG_CAPTCHA_REQUIRED",
  "MABANG_AUTH_EXPIRED_DURING_SUBMIT", "MABANG_RESPONSE_INVALID",
  "MABANG_AUTH_EXPIRED_DURING_TRACKING_RESET", "TRACKING_RESET_SHOP_MISMATCH",
  "TRACKING_RESET_PLATFORM_MISMATCH", "TRACKING_RESET_STATUS_CHANGED", "TRACKING_RESET_HAS_TRACKING",
  "TRACKING_RESET_INVENTORY_UNSAFE", "TRACKING_RESET_NOT_PENDING", "TRACKING_RESET_ORDER_CHANGED",
  "TRACKING_RESET_EXTRA_CONFIRMATION_REQUIRED", "TRACKING_RESET_ORDER_NOT_FOUND", "TRACKING_RESET_VERIFY_FAILED",
  "MESSAGE_REVIEW_ORDER_NOT_FOUND", "MESSAGE_REVIEW_NOT_SAFE", "MESSAGE_REVIEW_TRANSITION_REJECTED",
  "MESSAGE_REVIEW_VERIFY_FAILED", "MABANG_AUTH_EXPIRED_DURING_MESSAGE_REVIEW",
  "TRACKING_MISMATCH_BEFORE_DISTRIBUTION", "TRACKING_CHANNEL_MISMATCH_BEFORE_DISTRIBUTION",
  "TRACKING_CHANNEL_UNKNOWN_BEFORE_DISTRIBUTION", "TRACKING_MISMATCH_BEFORE_RESET",
  "TRACKING_CHANNEL_UNKNOWN_BEFORE_RESET", "TRACKING_CHANNEL_CHANGED_BEFORE_RESET",
  "ORDER_STATUS_NOT_PENDING_BEFORE_DISTRIBUTION", "MABANG_AUTH_EXPIRED_DURING_DISTRIBUTION",
];
function preserveWorkerSafetyCode(error) {
  const matched = workerSafetyCodes.find((code) => String(error?.message || "").includes(`${code}:`));
  if (matched) error.code = matched;
  return error;
}

export function createMabangFulfillmentSource({ config, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  async function collect() {
    if (!config.mabangUsername || !config.mabangPassword) {
      const error = new Error("请配置 FULFILLMENT_MABANG_USERNAME 和 FULFILLMENT_MABANG_PASSWORD");
      error.code = "MABANG_CREDENTIALS_MISSING";
      throw error;
    }
    const end = new Date();
    const start = new Date(end.getTime() - config.lookbackDays * 86400000);
    const result = await executeWorker({
      action: "orders", username: config.mabangUsername, password: config.mabangPassword,
      startDate: dateText(start), endDate: dateText(end), maxPages: config.scanMaxPages || 500,
      orderFilters: { conditions: [
        { field: "店铺名", operator: "equals", values: [config.shopName] },
        { field: "订单状态", operator: "equals", values: [config.pendingStatus] },
      ] },
    });
    return result.records || [];
  }
  async function collectByOrderIds(orderIds) {
    if (!config.mabangUsername || !config.mabangPassword) {
      const error = new Error("请配置 FULFILLMENT_MABANG_USERNAME 和 FULFILLMENT_MABANG_PASSWORD");
      error.code = "MABANG_CREDENTIALS_MISSING";
      throw error;
    }
    const references = [...new Set(orderIds.map(String).map((value) => value.trim()).filter(Boolean))];
    if (!references.length) return [];
    const result = await executeWorker({
      action: "fulfillment-orders", username: config.mabangUsername, password: config.mabangPassword,
      orderReferences: references, pendingStatusId: config.pendingStatusId,
    });
    return result.records || [];
  }
  function matchesReference(row, wanted) {
    const sourceOrderId = String(row["订单编号"] || "").trim();
    const tradeNumber = String(row["交易编号"] || "").trim();
    const platformOrderId = platformKey(row["平台"]) === "lazada" ? tradeNumber || sourceOrderId : tradeNumber;
    return [platformOrderId, tradeNumber, sourceOrderId].some((value) => value && wanted.has(value));
  }
  return {
    async listPending({ limit, orderIds = [] }) {
      if (orderIds.length) {
        const records = await collectByOrderIds(orderIds);
        const wanted = new Set(orderIds.map(String));
        return records.filter((row) => matchesReference(row, wanted));
      }
      const records = await collect();
      // 从最早付款订单开始取候选；安全排除项不会占用最终批次名额，也不能让新单越过积压单。
      return oldestOrderRows(records, Math.max(limit * 20, limit));
    },
    async getByIds(ids) {
      const wanted = new Set(ids.map(String));
      return (await collectByOrderIds(ids)).filter((row) => matchesReference(row, wanted));
    },
  };
}

export function createMabangFulfillmentScanSource({ config, shops = config.shops, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  return {
    async listPendingByShop({ shopIds = null, limit = config.maxBatchSize } = {}) {
      const configuredShops = new Map((shops || []).map((shop) => [String(shop.shopId), shop]));
      const requestedShopIds = Array.isArray(shopIds) ? shopIds : [...configuredShops.keys()];
      if (!config.mabangUsername || !config.mabangPassword) {
        const error = new Error("请配置 FULFILLMENT_MABANG_USERNAME 和 FULFILLMENT_MABANG_PASSWORD");
        error.code = "MABANG_CREDENTIALS_MISSING";
        throw error;
      }
      const selectedShops = [...new Set(requestedShopIds.map(String))].map((shopId) => configuredShops.get(shopId)).filter(Boolean);
      const recordsByShopId = new Map(selectedShops.map((shop) => [String(shop.shopId), []]));
      if (!selectedShops.length) return recordsByShopId;
      const end = new Date();
      const start = new Date(end.getTime() - config.lookbackDays * 86400000);
      const result = await executeWorker({
        action: "orders", username: config.mabangUsername, password: config.mabangPassword,
        startDate: dateText(start), endDate: dateText(end), maxPages: config.scanMaxPages || 500,
        orderFilters: { conditions: [
          { field: "店铺名", operator: "equals", values: selectedShops.map((shop) => shop.shopName) },
          { field: "订单状态", operator: "equals", values: [config.pendingStatus] },
        ] },
      });
      const shopIdByName = new Map(selectedShops.map((shop) => [String(shop.shopName), String(shop.shopId)]));
      const grouped = new Map(selectedShops.map((shop) => [String(shop.shopId), []]));
      for (const record of result.records || []) {
        const shopId = shopIdByName.get(String(record["店铺名"] || ""));
        if (shopId) grouped.get(shopId).push(record);
      }
      const backlogBatchesPerScan = Math.max(1, Math.min(Number(config.backlogBatchesPerScan) || 5, 10));
      const requested = Math.max(1, Math.min(Number(limit) || config.maxBatchSize,
        config.maxBatchSize * backlogBatchesPerScan));
      for (const [shopId, records] of grouped) {
        recordsByShopId.set(shopId, oldestOrderRows(records, Math.max(requested * 20, requested)));
      }
      return recordsByShopId;
    },
  };
}

export function createMabangPolicySuggestionSource({ config, shops = config.shops, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  return {
    async scan({ lookbackDays = 30, selectedShops: requestedShops = null } = {}) {
      if (!config.mabangUsername || !config.mabangPassword) {
        const error = new Error("请先在网页中连接马帮账号"); error.code = "MABANG_CREDENTIALS_MISSING"; throw error;
      }
      const selectedShops = (requestedShops || shops || []).filter((shop) => ["shopee", "lazada"].includes(platformKey(shop.platform)));
      const days = Math.max(1, Math.min(Number(lookbackDays) || 30, 90));
      const end = new Date(); const start = new Date(end.getTime() - days * 86400000);
      const orderRequest = executeWorker({ action: "orders", username: config.mabangUsername, password: config.mabangPassword,
        startDate: dateText(start), endDate: dateText(end), maxPages: 1000,
        orderFilters: { conditions: [{ field: "店铺名", operator: "equals", values: selectedShops.map((shop) => shop.shopName) }] } });
      const inventoryRequest = executeWorker({ action: "inventory", username: config.mabangUsername, password: config.mabangPassword })
        .then((inventory) => ({ ...inventory, catalogComplete: true }))
        .catch(() => ({ records: [], catalogComplete: false }));
      const [result, inventory] = await Promise.all([orderRequest, inventoryRequest]);
      const scannedAt = new Date().toISOString();
      const suggestions = inferFulfillmentPolicySuggestions(result.records || [], selectedShops, { scannedAt, lookbackDays: days });
      const warehouses = [...new Set([
        ...suggestions.flatMap((item) => item.warehouses.map((warehouse) => warehouse.name)),
        ...(inventory.records || []).map((record) => normalizedText(record["仓库"])),
      ].filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, "zh-CN"));
      return { suggestions, warehouses, scannedAt, lookbackDays: days,
        warehouseCatalogComplete: inventory.catalogComplete,
        orderCount: suggestions.reduce((sum, item) => sum + item.orderCount, 0) };
    },
  };
}

export function createMabangFulfillmentCatalogSource({ config, rootDir, runWorker = null, fetchImpl = fetch }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  const listingBaseUrl = "http://127.0.0.1:3101/api/mabang-listing";
  async function listingJson(pathname, options = {}) {
    const response = await fetchImpl(`${listingBaseUrl}${pathname}`, { ...options, signal: AbortSignal.timeout(120000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      const error = new Error(String(payload?.message || payload?.error || "马帮店铺权限读取失败"));
      error.code = String(payload?.code || "MABANG_SHOP_ACCESS_FAILED");
      throw error;
    }
    return payload;
  }
  return {
    async sync() {
      if (!config.mabangUsername || !config.mabangPassword) {
        const error = new Error("请先在网页中连接马帮账号");
        error.code = "MABANG_CREDENTIALS_MISSING";
        throw error;
      }
      await listingJson("/session/login", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: config.mabangUsername, password: config.mabangPassword }) });
      const [shopeeListing, lazadaListing] = await Promise.all([
        listingJson("/shops?platform=shopee"), listingJson("/shops?platform=lazada"),
      ]);
      const assignedShops = [
        ...(Array.isArray(shopeeListing.shops) ? shopeeListing.shops : []).map((shop) => ({ shop, platform:"Shopee", platformId:"17" })),
        ...(Array.isArray(lazadaListing.shops) ? lazadaListing.shops : []).map((shop) => ({ shop, platform:"Lazada", platformId:"8" })),
      ].map(({ shop, platform, platformId }) => ({
        shopId: String(shop.id || shop.shopId || "").trim(), shopName: String(shop.name || shop.shopName || "").trim(),
        platform, platformId, countryCode: String(shop.site || shop.countryCode || "").trim().toUpperCase(), status: "1",
      })).filter((shop, index, all) => shop.shopId && shop.shopName && all.findIndex((item) => item.shopId === shop.shopId) === index);
      if (!assignedShops.length) {
        const error = new Error("当前马帮账号没有返回已分配的 Shopee 或 Lazada 店铺，已拒绝使用公司总店铺目录");
        error.code = "MABANG_ASSIGNED_SHOPS_EMPTY";
        throw error;
      }
      const [result, warehouseResult] = await Promise.all([
        executeWorker({ action: "fulfillment-catalog", username: config.mabangUsername,
          password: config.mabangPassword, shopIds: assignedShops.map((shop) => shop.shopId) }),
        executeWorker({ action: "inventory-warehouse-catalog", username: config.mabangUsername,
          password: config.mabangPassword }),
      ]);
      const workerShops = new Map((Array.isArray(result.shops) ? result.shops : [])
        .map((shop) => [String(shop.shopId || ""), shop]));
      const scopedShops = assignedShops.filter((shop) => workerShops.has(shop.shopId));
      if (!scopedShops.length) {
        const error = new Error("马帮订单页没有返回当前员工被分配的 Shopee 或 Lazada 店铺，已拒绝使用账号总店铺目录");
        error.code = "MABANG_ASSIGNED_SHOPS_EMPTY";
        throw error;
      }
      const warehouses = [...new Map((warehouseResult?.catalog?.options || [])
        .map((warehouse) => ({ id: String(warehouse?.id || "").trim(),
          name: String(warehouse?.name || "").trim() }))
        .filter((warehouse) => warehouse.id && warehouse.name)
        .map((warehouse) => [`${warehouse.id}\u0000${warehouse.name}`, warehouse])).values()]
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
      return { shops: scopedShops.map((shop) => ({ ...shop, ...workerShops.get(shop.shopId),
          shopId: shop.shopId, shopName: shop.shopName, countryCode: shop.countryCode })),
        channels: Array.isArray(result.channels) ? result.channels : [],
        warehouses };
    },
  };
}

export function createMabangMessageReviewRecovery({ config, shops = config.shops, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  const workerShops = () => (shops || []).filter((shop) => shop?.mode !== "paused").map((shop) => ({
    shopId: String(shop.shopId), shopName: String(shop.shopName), platformId: String(shop.platformId),
  }));
  const credentials = () => {
    if (!config.mabangUsername || !config.mabangPassword) {
      const error = new Error("请配置马帮账号和密码"); error.code = "MABANG_CREDENTIALS_MISSING"; throw error;
    }
    return { username: config.mabangUsername, password: config.mabangPassword };
  };
  return {
    async listCandidates({ limit = config.messageReviewRecoveryLimit } = {}) {
      const result = await executeWorker({ action: "fulfillment-message-review-candidates", ...credentials(),
        shops: workerShops(), limit: Math.max(1, Math.min(Number(limit) || 3, 10)) });
      return result.records || [];
    },
    async recover(orderReference) {
      try {
        return await executeWorker({ action: "fulfillment-message-review-recover", ...credentials(),
          shops: workerShops(), orderReference: String(orderReference || "").trim(),
          commit: "MESSAGE_REVIEW_RECOVERY_CONFIRMED" });
      } catch (error) { throw preserveWorkerSafetyCode(error); }
    },
    async run({ limit = config.messageReviewRecoveryLimit } = {}) {
      const candidates = await this.listCandidates({ limit });
      const results = [];
      for (const candidate of candidates) {
        if (!candidate.eligible) { results.push({ ...candidate, status: "retained" }); continue; }
        try { results.push({ ...await this.recover(candidate.platformOrderId), status: "moved_to_pending" }); }
        catch (error) { results.push({ ...candidate, status: "failed", errorCode: error?.code || "MESSAGE_REVIEW_RECOVERY_FAILED" }); }
      }
      return { checked: candidates.length, moved: results.filter((item) => item.status === "moved_to_pending"), results };
    },
  };
}

export function createDisabledFulfillmentExecutor() {
  return { async fulfill() { const error = new Error("真实马帮发货适配器尚未启用"); error.code = "EXECUTOR_DISABLED"; throw error; } };
}

export function createMabangFulfillmentPreflight({ config, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  return {
    async run(orderReference, { singleWarehouseVerified = false } = {}) {
      const reference = String(orderReference || "").trim();
      if (!reference) { const error = new Error("必须指定一个订单号"); error.code = "INVALID_ORDER_ID"; throw error; }
      try {
        const result = await executeWorker({
          action: "fulfillment-preflight",
          username: config.mabangUsername, password: config.mabangPassword, orderReference: reference,
          channelId: config.channelId, channelValue: config.channelValue,
          shopId: config.shopId, platformId: config.platformId,
          singleWarehouseVerified: singleWarehouseVerified === true,
        });
        return {
          orderId: result.platformOrderId || reference,
          ready: Boolean(result.ready), wouldSubmit: false,
          orderStatus: result.orderStatus || "", hasTrackingNumber: Boolean(result.hasTrackingNumber),
          stockStatus: result.stockStatus || "unknown", channelMatched: Boolean(result.channelMatched),
          reportingSuccess: Boolean(result.reportingSuccess), hasDeclarationRows: Boolean(result.hasDeclarationRows),
          requiredPropertyCount: Number(result.requiredPropertyCount || 0),
          missingRequiredPropertyCount: Number(result.missingRequiredPropertyCount || 0),
          checks: Array.isArray(result.checks) ? result.checks : [],
        };
      } catch (error) {
        throw preserveWorkerSafetyCode(error);
      }
    },
  };
}

export function createMabangFulfillmentExecutor({ config, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  return {
    async fulfill({ order, channel }) {
      if (order.snapshot.shopName !== config.shopName || order.snapshot.orderStatus !== config.pendingStatus) {
        const error = new Error("提交前订单店铺或状态不一致"); error.code = "PRE_SUBMIT_CHECK_FAILED"; throw error;
      }
      if (String(channel.id) !== config.channelId || String(channel.providerId) !== config.channelProviderId) {
        const error = new Error("提交物流渠道与固定配置不一致"); error.code = "CHANNEL_MISMATCH"; throw error;
      }
      const orderReference = order.tradeNumber || order.snapshot.sourceOrderId;
      const warehouses = [...new Set((order.warehouses || order.snapshot.warehouses || [order.warehouse])
        .map(String).map((value) => value.trim()).filter(Boolean))];
      const isGiftWarehouse = (value) => String(value || "").replace(/\s+/g, "").toLocaleLowerCase() === "赠品sku仓";
      const fulfillmentWarehouses = warehouses.filter((warehouse) => !isGiftWarehouse(warehouse));
      if (!fulfillmentWarehouses.length && warehouses.some(isGiftWarehouse)) {
        const error = new Error("订单仅包含赠品SKU仓商品，赠品不可单独销售");
        error.code = "GIFT_ONLY_ORDER_NOT_ALLOWED";
        throw error;
      }
      if (Array.isArray(config.allowedWarehouses) && config.allowedWarehouses.length
        && fulfillmentWarehouses.some((warehouse) => !config.allowedWarehouses.includes(warehouse))) {
        const error = new Error("提交前订单仓库不属于店铺允许仓库");
        error.code = "WAREHOUSE_NOT_ALLOWED_BEFORE_SUBMIT";
        throw error;
      }
      const singleWarehouseVerified = fulfillmentWarehouses.length === 1
        && order.stockStatus === "in_stock" && order.eligible;
      if (!singleWarehouseVerified) {
        const error = new Error("提交前未确认订单全部 SKU 属于同一仓库");
        error.code = "MULTI_WAREHOUSE_REQUIRES_REVIEW";
        throw error;
      }
      let result;
      try {
        result = await executeWorker({
          action: "fulfillment-submit", commit: "FULFILLMENT_CONFIRMED",
          username: config.mabangUsername, password: config.mabangPassword, orderReference,
          channelId: config.channelId, channelValue: config.channelValue, channelSource: config.channelSource,
          shopId: config.shopId, platformId: config.platformId,
          singleWarehouseVerified,
          verifyTimeoutSeconds: config.verificationTimeoutSeconds,
          trackingWaitTimeoutSeconds: config.trackingWaitTimeoutSeconds,
          distributionVerifyTimeoutSeconds: config.distributionVerifyTimeoutSeconds,
        }, (config.verificationTimeoutSeconds + 60) * 1000);
      } catch (error) {
        throw preserveWorkerSafetyCode(error);
      }
      const trackingNumber = result.trackingNumber || "";
      const trackingPending = Boolean(result.submitted) && !trackingNumber;
      return { verified: Boolean(result.verified), trackingNumber,
        afterStatus: result.afterStatus || "", channelVerified: Boolean(result.channelVerified),
        distributionSubmitted: Boolean(result.distributionSubmitted), distributionSuccess: Boolean(result.distributionSuccess),
        errorCode: trackingPending ? "TRACKING_NUMBER_PENDING" : result.distributionErrorCode || "",
        errorMessage: trackingPending ? "交运已提交，Shopee 运单号审批中；系统将持续回查，禁止重复交运。" : result.distributionMessage || "",
        timings: result.timingsMs && typeof result.timingsMs === "object" ? result.timingsMs : null };
    },
  };
}

export function createMabangTrackingRecoveryAdapter({ config, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  return {
    async inspectState(orderReference) {
      const result = await executeWorker({
        action: "fulfillment-order-state", username: config.mabangUsername, password: config.mabangPassword,
        orderReference, channelId: config.channelId, channelValue: config.channelValue,
      });
      return { orderId: String(result.platformOrderId || orderReference).trim(),
        shopId: String(result.shopId || "").trim(), platformId: String(result.platformId || "").trim(),
        orderStatus: String(result.orderStatus || "").trim(), trackingNumber: String(result.trackNumber || "").trim(),
        channelMatched: Boolean(result.channelMatched), shippingRecordPending: Boolean(result.shippingRecordPending) };
    },
    async inspect(orderReference) {
      const result = await executeWorker({
        action: "fulfillment-inspect", username: config.mabangUsername, password: config.mabangPassword,
        orderReference, channelId: config.channelId, channelValue: config.channelValue,
      });
      return { trackingNumber: String(result.trackNumber || "").trim(), orderStatus: String(result.orderStatus || ""),
        channelMatched: Boolean(result.channelMatched), selectedOrderMatched: Boolean(result.selectedOrderMatched),
        shippingRecordPending: String(result.isSLogisticsChannel || "") === "2" || Boolean(result.trackingAcquisitionPending) };
    },
    async resetPending(orderReference) {
      try {
        const result = await executeWorker({
          action: "fulfillment-clear-pending-channel", commit: "TRACKING_RESET_CONFIRMED",
          username: config.mabangUsername, password: config.mabangPassword, orderReference,
          channelId: config.channelId, channelValue: config.channelValue,
          shopId: config.shopId, platformId: config.platformId,
        });
        return { cleared: Boolean(result.cleared), trackingNumber: String(result.trackingNumber || "").trim(),
          orderStatus: String(result.orderStatus || ""), message: String(result.message || "") };
      } catch (error) {
        throw preserveWorkerSafetyCode(error);
      }
    },
    async resubmitPending(orderReference) {
      try {
        const result = await executeWorker({
          action: "fulfillment-submit", commit: "FULFILLMENT_CONFIRMED",
          username: config.mabangUsername, password: config.mabangPassword, orderReference,
          channelId: config.channelId, channelValue: config.channelValue, channelSource: config.channelSource,
          shopId: config.shopId, platformId: config.platformId, singleWarehouseVerified: false,
          verifyTimeoutSeconds: config.verificationTimeoutSeconds,
        }, (config.verificationTimeoutSeconds + 60) * 1000);
        return { submitted: Boolean(result.submitted), verified: Boolean(result.verified),
          trackingNumber: String(result.trackingNumber || "").trim(), afterStatus: String(result.afterStatus || "") };
      } catch (error) {
        throw preserveWorkerSafetyCode(error);
      }
    },
    async distribute(orderReference, trackingNumber) {
      try {
        const result = await executeWorker({
          action: "fulfillment-distribute-existing", commit: "DISTRIBUTION_CONFIRMED",
          username: config.mabangUsername, password: config.mabangPassword, orderReference, trackingNumber,
          channelId: config.channelId, channelValue: config.channelValue, shopId: config.shopId, platformId: config.platformId,
          verifyTimeoutSeconds: config.distributionVerifyTimeoutSeconds,
        }, (config.verificationTimeoutSeconds + 60) * 1000);
        return { verified: Boolean(result.verified), trackingNumber: String(result.trackingNumber || trackingNumber).trim(),
          afterStatus: String(result.afterStatus || ""), message: String(result.message || "") };
      } catch (error) {
        throw preserveWorkerSafetyCode(error);
      }
    },
  };
}
