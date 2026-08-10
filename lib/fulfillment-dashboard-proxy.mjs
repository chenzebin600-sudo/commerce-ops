import { createFulfillmentActorAssertion, FULFILLMENT_ACTOR_ASSERTION_HEADER } from "./security/fulfillment-actor-assertion.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:3112";
const MAX_WAREHOUSE_BATCH_ORDERS = 100;
const WAREHOUSE_BATCH_TIMEOUT_MS = 30 * 60 * 1000;

function dashboardRoute(url, method) {
  const pathname = url.pathname;
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/health") return "/health";
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/scheduler") return "/api/fulfillment/scheduler";
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/dashboard") {
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));
    return `/api/fulfillment/dashboard?days=${days}`;
  }
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/scheduler/scan") return "/api/fulfillment/scheduler/scan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/scheduler/pause") return "/api/fulfillment/scheduler/pause";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/scheduler/resume") return "/api/fulfillment/scheduler/resume";
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/settings") return "/api/fulfillment/settings";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/settings/account") return "/api/fulfillment/settings/account";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/channels/sync") return "/api/fulfillment/channels/sync";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/policy-suggestions/scan") return "/api/fulfillment/policy-suggestions/scan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/policy-suggestions/confirm") return "/api/fulfillment/policy-suggestions/confirm";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/shop-policies/batch") return "/api/fulfillment/shop-policies/batch";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/policy-imports/preview") return "/api/fulfillment/policy-imports/preview";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/policy-imports/confirm") return "/api/fulfillment/policy-imports/confirm";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/warehouse-transfers/preview") return "/api/fulfillment/warehouse-transfers/preview";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/warehouse-transfers/execute") return "/api/fulfillment/warehouse-transfers/execute";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/warehouse-transfers/batch-preview") return "/api/fulfillment/warehouse-transfers/batch-preview";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/warehouse-transfers/batch-recover") return "/api/fulfillment/warehouse-transfers/batch-recover";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/warehouse-transfers/batch-execute") return "/api/fulfillment/warehouse-transfers/batch-execute";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-preview") return "/api/fulfillment/sku-replacements/batch-preview";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-recover") return "/api/fulfillment/sku-replacements/batch-recover";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/plan") return "/api/fulfillment/sku-replacements/plan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/execute") return "/api/fulfillment/sku-replacements/execute";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-plan") return "/api/fulfillment/sku-replacements/batch-plan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-execute") return "/api/fulfillment/sku-replacements/batch-execute";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/manual-reviews/recheck") return "/api/fulfillment/manual-reviews/recheck";
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/message-review-recoveries/candidates") {
    const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || 3));
    return `/api/fulfillment/message-review-recoveries/candidates?limit=${limit}`;
  }
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/message-review-recoveries") {
    return "/api/fulfillment/message-review-recoveries";
  }
  if (method === "PUT" && pathname === "/api/fulfillment-dashboard/message-review-recoveries/mode") {
    return "/api/fulfillment/message-review-recoveries/mode";
  }
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/tracking-recoveries") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    return `/api/fulfillment/tracking-recoveries?limit=${limit}`;
  }
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/batches") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    return `/api/fulfillment/batches?limit=${limit}`;
  }
  const previewMatch = pathname.match(/^\/api\/fulfillment-dashboard\/previews\/([a-zA-Z0-9-]+)$/);
  if (method === "GET" && previewMatch) return `/api/fulfillment/previews/${encodeURIComponent(previewMatch[1])}`;
  const batchMatch = pathname.match(/^\/api\/fulfillment-dashboard\/batches\/([a-zA-Z0-9-]+)$/);
  if (method === "GET" && batchMatch) return `/api/fulfillment/batches/${encodeURIComponent(batchMatch[1])}`;
  const policyMatch = pathname.match(/^\/api\/fulfillment-dashboard\/shops\/(\d{1,24})\/policy$/);
  if (method === "PUT" && policyMatch) return `/api/fulfillment/shops/${policyMatch[1]}/policy`;
  const skuBatchTaskMatch = pathname.match(/^\/api\/fulfillment-dashboard\/sku-replacements\/batch-executions\/([a-zA-Z0-9-]{1,80})$/);
  if (method === "GET" && skuBatchTaskMatch) return `/api/fulfillment/sku-replacements/batch-executions/${encodeURIComponent(skuBatchTaskMatch[1])}`;
  return null;
}

async function readJsonBody(req, maxLength = 16384) {
  let raw = "";
  if (typeof req?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of req) {
      raw += chunk.toString("utf8");
      if (raw.length > maxLength) throw Object.assign(new Error("请求内容过大"), { code: "BODY_TOO_LARGE" });
    }
  }
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("请求格式无效"), { code: "INVALID_BODY" }); }
  return payload;
}

async function recheckBody(req) {
  const payload = await readJsonBody(req, 4096);
  const shopId = String(payload.shopId || "").trim();
  const orderId = String(payload.orderId || "").trim();
  if (!/^\d{1,24}$/.test(shopId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)) {
    throw Object.assign(new Error("店铺或订单参数无效"), { code: "INVALID_MANUAL_REVIEW" });
  }
  return JSON.stringify({ shopId, orderId });
}

async function messageReviewRecoveryBody(req) {
  const payload = await readJsonBody(req, 4096);
  const orderId = String(payload.orderId || "").trim();
  const confirmation = String(payload.confirmation || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)
    || confirmation !== "MESSAGE_REVIEW_RECOVERY_CONFIRMED") {
    throw Object.assign(new Error("待审核订单或确认参数无效"), { code: "INVALID_MESSAGE_REVIEW_RECOVERY" });
  }
  return JSON.stringify({ orderId, confirmation });
}

async function messageReviewModeBody(req) {
  const payload = await readJsonBody(req, 1024);
  const mode = String(payload.mode || "").trim();
  if (!new Set(["off", "manual", "auto"]).has(mode)) {
    throw Object.assign(new Error("待审核留言处理模式无效"), { code: "INVALID_MESSAGE_REVIEW_MODE" });
  }
  return JSON.stringify({ mode });
}

async function accountBody(req) {
  const payload = await readJsonBody(req, 4096);
  const accountProfileId = String(payload.accountProfileId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(accountProfileId)) {
    throw Object.assign(new Error("马帮账号参数无效"), { code: "INVALID_MABANG_ACCOUNT" });
  }
  return JSON.stringify({ accountProfileId });
}

async function policySuggestionConfirmationBody(req) {
  const payload = await readJsonBody(req, 8192);
  const shopIds = [...new Set((Array.isArray(payload.shopIds) ? payload.shopIds : []).map(String).map((value) => value.trim()).filter(Boolean))];
  if (!shopIds.length || shopIds.length > 200 || shopIds.some((value) => !/^\d{1,24}$/.test(value))) {
    throw Object.assign(new Error("请选择有效的待审查店铺"), { code: "INVALID_POLICY_SUGGESTION_SHOPS" });
  }
  return JSON.stringify({ shopIds });
}

async function batchShopPolicyBody(req) {
  const payload = await readJsonBody(req, 16 * 1024);
  const shopIds = [...new Set((Array.isArray(payload.shopIds) ? payload.shopIds : []).map(String).map((value) => value.trim()).filter(Boolean))];
  const patch = {};
  if (payload.patch?.mode != null && String(payload.patch.mode).trim()) patch.mode = String(payload.patch.mode).trim();
  if (payload.patch?.minOrderAgeMinutes != null && String(payload.patch.minOrderAgeMinutes).trim()) patch.minOrderAgeMinutes = Number(payload.patch.minOrderAgeMinutes);
  if (payload.patch?.maxBatchSize != null && String(payload.patch.maxBatchSize).trim()) patch.maxBatchSize = Number(payload.patch.maxBatchSize);
  if (!shopIds.length || shopIds.length > 200 || shopIds.some((value) => !/^\d{1,24}$/.test(value))
    || (!Object.keys(patch).length) || (patch.mode && !new Set(["paused", "manual", "auto"]).has(patch.mode))
    || (patch.minOrderAgeMinutes != null && !new Set([2, 5, 10, 15, 30, 60]).has(patch.minOrderAgeMinutes))
    || (patch.maxBatchSize != null && !new Set([1, 2, 5, 10]).has(patch.maxBatchSize))) {
    throw Object.assign(new Error("批量店铺配置参数无效"), { code: "INVALID_BATCH_SHOP_POLICY" });
  }
  return JSON.stringify({ shopIds, patch });
}

async function policyImportPreviewBody(req) {
  const payload = await readJsonBody(req, 1536 * 1024);
  const filename = String(payload.filename || "").trim();
  const fileBase64 = String(payload.fileBase64 || "").trim();
  if (!filename || filename.length > 180 || !/\.(xlsx|csv)$/i.test(filename) || !fileBase64
    || fileBase64.length > 1400 * 1024 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(fileBase64)) {
    throw Object.assign(new Error("请选择不超过 1MB 的 .xlsx 或 .csv 配置表"), { code: "INVALID_POLICY_IMPORT_FILE" });
  }
  return JSON.stringify({ filename, fileBase64, allowOverwrite: payload.allowOverwrite === true });
}

async function policyImportConfirmationBody(req) {
  const payload = await readJsonBody(req, 32 * 1024);
  const previewId = String(payload.previewId || "").trim();
  const rowIds = [...new Set((Array.isArray(payload.rowIds) ? payload.rowIds : []).map(String).map((value) => value.trim()).filter(Boolean))];
  if (!/^[a-f0-9-]{36}$/i.test(previewId) || !rowIds.length || rowIds.length > 500
    || rowIds.some((value) => !/^\d{1,4}$/.test(value))) {
    throw Object.assign(new Error("请选择有效的导入配置行"), { code: "INVALID_POLICY_IMPORT_CONFIRMATION" });
  }
  return JSON.stringify({ previewId, rowIds });
}

async function policyBody(req) {
  const payload = await readJsonBody(req);
  return JSON.stringify({
    mode: String(payload.mode || ""), channelId: String(payload.channelId || ""),
    warehousePolicy: String(payload.warehousePolicy || ""),
    allowedWarehouses: Array.isArray(payload.allowedWarehouses) ? payload.allowedWarehouses.map(String).slice(0, 20) : [],
    minOrderAgeMinutes: Number(payload.minOrderAgeMinutes), maxBatchSize: Number(payload.maxBatchSize),
  });
}

async function warehouseTransferPreviewBody(req) {
  const payload = await readJsonBody(req, 4096);
  const orderReference = String(payload.orderReference || "").trim();
  const targetWarehouse = String(payload.targetWarehouse || "").trim();
  if (!/^[a-zA-Z0-9_-]{4,100}$/.test(orderReference) || targetWarehouse.length > 160) {
    throw Object.assign(new Error("订单号或目标仓库无效"), { code: "INVALID_WAREHOUSE_TRANSFER_PREVIEW" });
  }
  return JSON.stringify({ orderReference, targetWarehouse });
}

async function warehouseTransferExecuteBody(req) {
  const payload = await readJsonBody(req, 8192);
  const planHash = String(payload.planHash || "").trim();
  const approvalText = String(payload.approvalText || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(planHash) || !approvalText || approvalText.length > 300) {
    throw Object.assign(new Error("换仓计划或确认文字无效"), { code: "INVALID_WAREHOUSE_TRANSFER_EXECUTE" });
  }
  return JSON.stringify({ planHash, approvalText });
}

async function warehouseTransferBatchPreviewBody(req) {
  const payload = await readJsonBody(req, 16 * 1024);
  const orderReferences = [...new Set((Array.isArray(payload.orderReferences) ? payload.orderReferences : []).map(String).map((value) => value.trim()).filter(Boolean))];
  const targetWarehouse = String(payload.targetWarehouse || "").trim();
  if (!orderReferences.length || orderReferences.length > MAX_WAREHOUSE_BATCH_ORDERS || orderReferences.some((value) => !/^[a-zA-Z0-9_-]{4,100}$/.test(value)) || targetWarehouse.length > 160) {
    throw Object.assign(new Error(`请输入 1-${MAX_WAREHOUSE_BATCH_ORDERS} 个有效订单号`), { code: "INVALID_WAREHOUSE_BATCH_PREVIEW" });
  }
  return JSON.stringify({ orderReferences, targetWarehouse });
}

async function warehouseTransferBatchExecuteBody(req) {
  const payload = await readJsonBody(req, 16 * 1024);
  const batchHash = String(payload.batchHash || "").trim();
  const planHashes = [...new Set((Array.isArray(payload.planHashes) ? payload.planHashes : []).map(String).map((value) => value.trim()).filter(Boolean))];
  const approvalText = String(payload.approvalText || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(batchHash) || !planHashes.length || planHashes.length > MAX_WAREHOUSE_BATCH_ORDERS
    || planHashes.some((value) => !/^[a-f0-9]{64}$/i.test(value)) || !approvalText || approvalText.length > 100) {
    throw Object.assign(new Error("批量换仓计划或确认文字无效"), { code: "INVALID_WAREHOUSE_BATCH_EXECUTE" });
  }
  return JSON.stringify({ batchHash, planHashes, approvalText });
}

async function skuReplacementBatchPreviewBody(req) {
  const payload = await readJsonBody(req, 16 * 1024);
  const orderReferences = [...new Set((Array.isArray(payload.orderReferences) ? payload.orderReferences : [])
    .map(String).map((value) => value.trim()).filter(Boolean))];
  if (!orderReferences.length || orderReferences.length > MAX_WAREHOUSE_BATCH_ORDERS
    || orderReferences.some((value) => !/^[a-zA-Z0-9_-]{4,100}$/.test(value))) {
    throw Object.assign(new Error(`请输入 1-${MAX_WAREHOUSE_BATCH_ORDERS} 个有效订单号`), { code: "INVALID_SKU_REPLACEMENT_PREVIEW" });
  }
  return JSON.stringify({ orderReferences });
}

async function skuReplacementPlanBody(req) {
  const payload = await readJsonBody(req, 4096);
  const orderReference = String(payload.orderReference || "").trim();
  const itemId = String(payload.itemId || "").trim();
  const replacementSku = String(payload.replacementSku || "").trim();
  if (!/^[a-zA-Z0-9_-]{4,100}$/.test(orderReference) || !/^\d{1,40}$/.test(itemId) || !replacementSku
    || replacementSku.length > 160 || /[\u0000-\u001f\u007f]/.test(replacementSku)) {
    throw Object.assign(new Error("订单、商品行或替换 SKU 无效"), { code: "INVALID_SKU_REPLACEMENT_PLAN" });
  }
  return JSON.stringify({ orderReference, itemId, replacementSku });
}

async function skuReplacementExecuteBody(req) {
  const payload = await readJsonBody(req, 4096);
  const planHash = String(payload.planHash || "").trim();
  const approvalText = String(payload.approvalText || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(planHash) || !approvalText || approvalText.length > 300) {
    throw Object.assign(new Error("更换计划或确认文字无效"), { code: "INVALID_SKU_REPLACEMENT_EXECUTE" });
  }
  return JSON.stringify({ planHash, approvalText });
}

async function skuReplacementBatchPlanBody(req) {
  const payload = await readJsonBody(req, 32 * 1024);
  if (!Array.isArray(payload.selections) || !payload.selections.length || payload.selections.length > MAX_WAREHOUSE_BATCH_ORDERS) {
    throw Object.assign(new Error(`请选择 1-${MAX_WAREHOUSE_BATCH_ORDERS} 个需要更换的商品行`), { code: "INVALID_SKU_REPLACEMENT_BATCH_PLAN" });
  }
  const selections = payload.selections.map((raw) => ({
    orderReference: String(raw?.orderReference || "").trim(),
    itemId: String(raw?.itemId || "").trim(),
    replacementSku: String(raw?.replacementSku || "").trim(),
  }));
  const keys = new Set();
  for (const selection of selections) {
    const key = `${selection.orderReference}\u0000${selection.itemId}`;
    if (!/^[a-zA-Z0-9_-]{4,100}$/.test(selection.orderReference) || !/^\d{1,40}$/.test(selection.itemId)
      || !selection.replacementSku || selection.replacementSku.length > 160 || /[\u0000-\u001f\u007f]/.test(selection.replacementSku)
      || keys.has(key)) {
      throw Object.assign(new Error("批量更换中存在无效或重复的商品行"), { code: "INVALID_SKU_REPLACEMENT_BATCH_PLAN" });
    }
    keys.add(key);
  }
  return JSON.stringify({ selections });
}

async function skuReplacementBatchExecuteBody(req) {
  const payload = await readJsonBody(req, 4096);
  const batchHash = String(payload.batchHash || "").trim();
  const approvalText = String(payload.approvalText || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(batchHash) || !approvalText || approvalText.length > 300) {
    throw Object.assign(new Error("批量更换计划或确认文字无效"), { code: "INVALID_SKU_REPLACEMENT_BATCH_EXECUTE" });
  }
  return JSON.stringify({ batchHash, approvalText });
}

export function createFulfillmentDashboardProxy({
  baseUrl = DEFAULT_BASE_URL,
  apiToken = "",
  fetchImpl = fetch,
  actorAssertionSecret = "",
  resolveActor = (req) => req.fulfillmentActor || null,
  now = () => Date.now(),
} = {}) {
  const upstreamBase = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(upstreamBase.hostname)) {
    throw new Error("履约服务必须使用本机地址。");
  }

  return async function proxyFulfillmentDashboard(req, res, url) {
    if (!url.pathname.startsWith("/api/fulfillment-dashboard/")) return false;
    const upstreamPath = dashboardRoute(url, req.method || "GET");
    if (!upstreamPath) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "履约看板接口不存在" } }));
      return true;
    }

    const headers = { accept: "application/json" };
    if (apiToken) headers.authorization = `Bearer ${apiToken}`;
    if (["POST", "PUT"].includes(req.method)) headers["content-type"] = "application/json";
    const actor = ["POST", "PUT"].includes(req.method) ? resolveActor(req) : null;
    if (actor) {
      headers[FULFILLMENT_ACTOR_ASSERTION_HEADER] = createFulfillmentActorAssertion(actor, {
        secret: actorAssertionSecret,
        requestId: req.auditContext?.requestId || req.headers?.["x-request-id"],
        issuedAt: now(),
      });
    }

    try {
      let requestBody;
      if (req.method === "POST" && upstreamPath === "/api/fulfillment/manual-reviews/recheck") requestBody = await recheckBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/message-review-recoveries") requestBody = await messageReviewRecoveryBody(req);
      else if (req.method === "PUT" && upstreamPath === "/api/fulfillment/message-review-recoveries/mode") requestBody = await messageReviewModeBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/settings/account") requestBody = await accountBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/policy-suggestions/confirm") requestBody = await policySuggestionConfirmationBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/shop-policies/batch") requestBody = await batchShopPolicyBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/policy-imports/preview") requestBody = await policyImportPreviewBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/policy-imports/confirm") requestBody = await policyImportConfirmationBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/warehouse-transfers/preview") requestBody = await warehouseTransferPreviewBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/warehouse-transfers/execute") requestBody = await warehouseTransferExecuteBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/warehouse-transfers/batch-preview") requestBody = await warehouseTransferBatchPreviewBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/warehouse-transfers/batch-recover") requestBody = await warehouseTransferBatchPreviewBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/warehouse-transfers/batch-execute") requestBody = await warehouseTransferBatchExecuteBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/batch-preview") requestBody = await skuReplacementBatchPreviewBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/batch-recover") requestBody = await skuReplacementBatchPreviewBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/plan") requestBody = await skuReplacementPlanBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/execute") requestBody = await skuReplacementExecuteBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/batch-plan") requestBody = await skuReplacementBatchPlanBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/batch-execute") requestBody = await skuReplacementBatchExecuteBody(req);
      else if (req.method === "PUT" && /\/api\/fulfillment\/shops\/\d+\/policy$/.test(upstreamPath)) requestBody = await policyBody(req);
      else if (req.method === "POST") requestBody = "{}";
      const suggestionScan = upstreamPath === "/api/fulfillment/policy-suggestions/scan";
      const warehouseBatchRequest = upstreamPath === "/api/fulfillment/warehouse-transfers/batch-preview"
        || upstreamPath === "/api/fulfillment/warehouse-transfers/batch-execute"
        || upstreamPath === "/api/fulfillment/sku-replacements/batch-preview"
        || upstreamPath === "/api/fulfillment/sku-replacements/batch-recover"
        || upstreamPath === "/api/fulfillment/sku-replacements/batch-plan";
      const longRunningRequest = ["POST", "PUT"].includes(req.method)
        || upstreamPath.startsWith("/api/fulfillment/message-review-recoveries");
      const response = await fetchImpl(new URL(upstreamPath, upstreamBase), {
        method: req.method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(warehouseBatchRequest ? WAREHOUSE_BATCH_TIMEOUT_MS : suggestionScan ? 600000 : longRunningRequest ? 120000 : 8000),
      });
      const body = await response.text();
      res.writeHead(response.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body || JSON.stringify({ success: false, error: { code: "EMPTY_RESPONSE", message: "履约服务返回空内容" } }));
    } catch (error) {
      if (["BODY_TOO_LARGE", "INVALID_BODY", "INVALID_MANUAL_REVIEW", "INVALID_MESSAGE_REVIEW_RECOVERY", "INVALID_MESSAGE_REVIEW_MODE", "INVALID_MABANG_ACCOUNT", "INVALID_POLICY_SUGGESTION_SHOPS", "INVALID_BATCH_SHOP_POLICY", "INVALID_POLICY_IMPORT_FILE", "INVALID_POLICY_IMPORT_CONFIRMATION", "INVALID_WAREHOUSE_TRANSFER_PREVIEW", "INVALID_WAREHOUSE_TRANSFER_EXECUTE", "INVALID_WAREHOUSE_BATCH_PREVIEW", "INVALID_WAREHOUSE_BATCH_EXECUTE", "INVALID_SKU_REPLACEMENT_PREVIEW", "INVALID_SKU_REPLACEMENT_PLAN", "INVALID_SKU_REPLACEMENT_EXECUTE", "INVALID_SKU_REPLACEMENT_BATCH_PLAN", "INVALID_SKU_REPLACEMENT_BATCH_EXECUTE"].includes(error?.code)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ success: false, error: { code: error.code, message: error.message } }));
        return true;
      }
      const timeout = error?.name === "TimeoutError";
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        success: false,
        error: {
          code: timeout ? "FULFILLMENT_TIMEOUT" : "FULFILLMENT_UNAVAILABLE",
          message: timeout ? "履约服务响应超时，请稍后刷新。" : "履约服务未连接，请确认 3112 服务正在运行。",
        },
      }));
    }
    return true;
  };
}
