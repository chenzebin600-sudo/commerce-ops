import path from "node:path";
import { createMabangWorkerRunner } from "../lib/mabang-worker-runner.mjs";

function dateText(date) { return date.toISOString().slice(0, 10); }
function orderReference(row) { return String(row["订单编号"] || row["交易编号"] || "").trim(); }
function orderTime(row) {
  const text = String(row["付款时间"] || "").trim();
  const timestamp = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function shippingDeadlineTime(row) {
  const text = String(row["最后发货期限"] || "").trim();
  if (!text) return Number.POSITIVE_INFINITY;
  const normalized = text.replaceAll("/", "-").replace(" ", "T");
  const timestamp = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}
function newestOrderRows(records, maximumOrders) {
  const groups = new Map();
  for (const row of records) {
    const key = orderReference(row);
    if (!key) continue;
    const group = groups.get(key) || { key, timestamp: 0, shippingDeadline: Number.POSITIVE_INFINITY, rows: [] };
    group.timestamp = Math.max(group.timestamp, orderTime(row));
    group.shippingDeadline = Math.min(group.shippingDeadline, shippingDeadlineTime(row));
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.shippingDeadline - right.shippingDeadline
      || right.timestamp - left.timestamp || right.key.localeCompare(left.key))
    .slice(0, maximumOrders)
    .flatMap((group) => group.rows);
}

const workerSafetyCodes = [
  "CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT", "ORDER_NOT_AVAILABLE_FOR_DELIVERY",
  "OUT_OF_STOCK_BEFORE_SUBMIT", "INVENTORY_UNKNOWN_BEFORE_SUBMIT", "MULTI_WAREHOUSE_REQUIRES_REVIEW",
  "MABANG_AUTH_REQUIRED", "MABANG_AUTH_FAILED", "MABANG_AUTH_EXPIRED", "MABANG_CAPTCHA_REQUIRED",
  "MABANG_AUTH_EXPIRED_DURING_SUBMIT", "MABANG_RESPONSE_INVALID",
  "MABANG_AUTH_EXPIRED_DURING_TRACKING_RESET", "TRACKING_RESET_SHOP_MISMATCH",
  "TRACKING_RESET_PLATFORM_MISMATCH", "TRACKING_RESET_STATUS_CHANGED", "TRACKING_RESET_HAS_TRACKING",
  "TRACKING_RESET_INVENTORY_UNSAFE", "TRACKING_RESET_NOT_PENDING", "TRACKING_RESET_ORDER_CHANGED",
  "TRACKING_RESET_EXTRA_CONFIRMATION_REQUIRED", "TRACKING_RESET_ORDER_NOT_FOUND", "TRACKING_RESET_VERIFY_FAILED",
  "MESSAGE_REVIEW_ORDER_NOT_FOUND", "MESSAGE_REVIEW_NOT_SAFE", "MESSAGE_REVIEW_TRANSITION_REJECTED",
  "MESSAGE_REVIEW_VERIFY_FAILED", "MABANG_AUTH_EXPIRED_DURING_MESSAGE_REVIEW",
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
      startDate: dateText(start), endDate: dateText(end), maxPages: 100,
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
  return {
    async listPending({ limit, orderIds = [] }) {
      if (orderIds.length) {
        const records = await collectByOrderIds(orderIds);
        const wanted = new Set(orderIds.map(String));
        return records.filter((row) => wanted.has(String(row["订单编号"] || "")) || wanted.has(String(row["交易编号"] || "")));
      }
      const records = await collect();
      // 先按付款时间选择最新候选订单，再由业务层排除缺货；缺货订单不会占用最终 10 单名额。
      return newestOrderRows(records, Math.max(limit * 20, limit));
    },
    async getByIds(ids) {
      const wanted = new Set(ids.map(String));
      return (await collectByOrderIds(ids)).filter((row) => wanted.has(String(row["订单编号"] || "")) || wanted.has(String(row["交易编号"] || "")));
    },
  };
}

export function createMabangFulfillmentScanSource({ config, shops = config.shops, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  const configuredShops = new Map((shops || []).map((shop) => [String(shop.shopId), shop]));
  return {
    async listPendingByShop({ shopIds = [...configuredShops.keys()], limit = config.maxBatchSize } = {}) {
      if (!config.mabangUsername || !config.mabangPassword) {
        const error = new Error("请配置 FULFILLMENT_MABANG_USERNAME 和 FULFILLMENT_MABANG_PASSWORD");
        error.code = "MABANG_CREDENTIALS_MISSING";
        throw error;
      }
      const selectedShops = [...new Set(shopIds.map(String))].map((shopId) => configuredShops.get(shopId)).filter(Boolean);
      const recordsByShopId = new Map(selectedShops.map((shop) => [String(shop.shopId), []]));
      if (!selectedShops.length) return recordsByShopId;
      const end = new Date();
      const start = new Date(end.getTime() - config.lookbackDays * 86400000);
      const result = await executeWorker({
        action: "orders", username: config.mabangUsername, password: config.mabangPassword,
        startDate: dateText(start), endDate: dateText(end), maxPages: 100,
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
      const requested = Math.max(1, Math.min(Number(limit) || config.maxBatchSize, config.maxBatchSize));
      for (const [shopId, records] of grouped) {
        recordsByShopId.set(shopId, newestOrderRows(records, Math.max(requested * 20, requested)));
      }
      return recordsByShopId;
    },
  };
}

export function createMabangMessageReviewRecovery({ config, shops = config.shops, rootDir, runWorker = null }) {
  const executeWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
  const workerShops = (shops || []).map((shop) => ({
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
        shops: workerShops, limit: Math.max(1, Math.min(Number(limit) || 3, 10)) });
      return result.records || [];
    },
    async recover(orderReference) {
      try {
        return await executeWorker({ action: "fulfillment-message-review-recover", ...credentials(),
          shops: workerShops, orderReference: String(orderReference || "").trim(),
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
      if (Array.isArray(config.allowedWarehouses) && config.allowedWarehouses.length
        && warehouses.some((warehouse) => !config.allowedWarehouses.includes(warehouse))) {
        const error = new Error("提交前订单仓库不属于店铺允许仓库");
        error.code = "WAREHOUSE_NOT_ALLOWED_BEFORE_SUBMIT";
        throw error;
      }
      const singleWarehouseVerified = warehouses.length === 1 && order.stockStatus === "in_stock" && order.eligible;
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
    async inspect(orderReference) {
      const result = await executeWorker({
        action: "fulfillment-inspect", username: config.mabangUsername, password: config.mabangPassword,
        orderReference, channelId: config.channelId, channelValue: config.channelValue,
      });
      return { trackingNumber: String(result.trackNumber || "").trim(), orderStatus: String(result.orderStatus || ""),
        channelMatched: Boolean(result.channelMatched), selectedOrderMatched: Boolean(result.selectedOrderMatched),
        shippingRecordPending: String(result.isSLogisticsChannel || "") === "2" || Boolean(result.trackingAcquisitionPending) };
    },
    async inspectManualResolution(orderReference) {
      const result = await executeWorker({
        action: "fulfillment-inspect-manual-resolution", username: config.mabangUsername, password: config.mabangPassword,
        orderReference,
      });
      return { trackingNumber: String(result.trackNumber || "").trim(),
        orderStatus: String(result.orderStatus || "").trim(), orderStatusText: String(result.orderStatusText || "").trim() };
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
      const result = await executeWorker({
        action: "fulfillment-distribute-existing", commit: "DISTRIBUTION_CONFIRMED",
        username: config.mabangUsername, password: config.mabangPassword, orderReference, trackingNumber,
        channelId: config.channelId, channelValue: config.channelValue, shopId: config.shopId, platformId: config.platformId,
        verifyTimeoutSeconds: config.verificationTimeoutSeconds,
      }, (config.verificationTimeoutSeconds + 60) * 1000);
      return { verified: Boolean(result.verified), trackingNumber: String(result.trackingNumber || trackingNumber).trim(),
        afterStatus: String(result.afterStatus || ""), message: String(result.message || "") };
    },
  };
}
