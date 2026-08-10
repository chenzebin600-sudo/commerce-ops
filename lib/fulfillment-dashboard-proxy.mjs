const DEFAULT_BASE_URL = "http://127.0.0.1:3112";
const MAX_SKU_BATCH_ORDERS = 100;
const SKU_BATCH_TIMEOUT_MS = 30 * 60 * 1000;

function dashboardRoute(url, method) {
  const pathname = url.pathname;
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/health") return "/health";
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/scheduler") return "/api/fulfillment/scheduler";
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/dashboard") {
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));
    return `/api/fulfillment/dashboard?days=${days}`;
  }
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/scheduler/scan") return "/api/fulfillment/scheduler/scan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/manual-reviews/recheck") return "/api/fulfillment/manual-reviews/recheck";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-preview") return "/api/fulfillment/sku-replacements/batch-preview";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-recover") return "/api/fulfillment/sku-replacements/batch-recover";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/plan") return "/api/fulfillment/sku-replacements/plan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/execute") return "/api/fulfillment/sku-replacements/execute";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-plan") return "/api/fulfillment/sku-replacements/batch-plan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-execute") return "/api/fulfillment/sku-replacements/batch-execute";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/warehouse-transfers/batch-plan") return "/api/fulfillment/warehouse-transfers/batch-plan";
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/warehouse-transfers/batch-execute") return "/api/fulfillment/warehouse-transfers/batch-execute";
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
  const skuBatchTaskMatch = pathname.match(/^\/api\/fulfillment-dashboard\/sku-replacements\/batch-executions\/([a-zA-Z0-9-]{1,80})$/);
  if (method === "GET" && skuBatchTaskMatch) return `/api/fulfillment/sku-replacements/batch-executions/${encodeURIComponent(skuBatchTaskMatch[1])}`;
  const warehouseTaskMatch = pathname.match(/^\/api\/fulfillment-dashboard\/warehouse-transfers\/batch-executions\/([a-zA-Z0-9-]{1,80})$/);
  if (method === "GET" && warehouseTaskMatch) return `/api/fulfillment/warehouse-transfers/batch-executions/${encodeURIComponent(warehouseTaskMatch[1])}`;
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

async function skuReplacementBatchPreviewBody(req) {
  const payload = await readJsonBody(req);
  const orderReferences = [...new Set((Array.isArray(payload.orderReferences) ? payload.orderReferences : [])
    .map(String).map((value) => value.trim()).filter(Boolean))];
  if (!orderReferences.length || orderReferences.length > MAX_SKU_BATCH_ORDERS
    || orderReferences.some((value) => !/^[a-zA-Z0-9_-]{4,100}$/.test(value))) {
    throw Object.assign(new Error(`请输入 1-${MAX_SKU_BATCH_ORDERS} 个有效订单号`), { code:"INVALID_SKU_REPLACEMENT_PREVIEW" });
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
    throw Object.assign(new Error("订单、商品行或替换 SKU 无效"), { code:"INVALID_SKU_REPLACEMENT_PLAN" });
  }
  return JSON.stringify({ orderReference,itemId,replacementSku });
}

async function skuReplacementExecuteBody(req) {
  const payload = await readJsonBody(req, 4096);
  const planHash = String(payload.planHash || "").trim();
  const approvalText = String(payload.approvalText || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(planHash) || !approvalText || approvalText.length > 300) {
    throw Object.assign(new Error("更换计划或确认文字无效"), { code:"INVALID_SKU_REPLACEMENT_EXECUTE" });
  }
  return JSON.stringify({ planHash,approvalText });
}

async function skuReplacementBatchPlanBody(req) {
  const payload = await readJsonBody(req, 32 * 1024);
  if (!Array.isArray(payload.selections) || !payload.selections.length || payload.selections.length > MAX_SKU_BATCH_ORDERS) {
    throw Object.assign(new Error(`请选择 1-${MAX_SKU_BATCH_ORDERS} 个需要更换的商品行`), { code:"INVALID_SKU_REPLACEMENT_BATCH_PLAN" });
  }
  const selections = payload.selections.map((raw) => ({
    orderReference:String(raw?.orderReference || "").trim(),
    itemId:String(raw?.itemId || "").trim(),
    replacementSku:String(raw?.replacementSku || "").trim(),
  }));
  const keys = new Set();
  for (const selection of selections) {
    const key = `${selection.orderReference}\u0000${selection.itemId}`;
    if (!/^[a-zA-Z0-9_-]{4,100}$/.test(selection.orderReference) || !/^\d{1,40}$/.test(selection.itemId)
      || !selection.replacementSku || selection.replacementSku.length > 160
      || /[\u0000-\u001f\u007f]/.test(selection.replacementSku) || keys.has(key)) {
      throw Object.assign(new Error("批量更换中存在无效或重复的商品行"), { code:"INVALID_SKU_REPLACEMENT_BATCH_PLAN" });
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
    throw Object.assign(new Error("批量更换计划或确认文字无效"), { code:"INVALID_SKU_REPLACEMENT_BATCH_EXECUTE" });
  }
  return JSON.stringify({ batchHash,approvalText });
}

async function warehouseTransferBatchPlanBody(req) {
  const payload = await readJsonBody(req, 32 * 1024);
  const orderReferences = [...new Set((Array.isArray(payload.orderReferences) ? payload.orderReferences : [])
    .map(String).map((value) => value.trim()).filter(Boolean))];
  if (!orderReferences.length || orderReferences.length > MAX_SKU_BATCH_ORDERS
    || orderReferences.some((value) => !/^[a-zA-Z0-9_-]{4,100}$/.test(value))) {
    throw Object.assign(new Error(`请输入 1-${MAX_SKU_BATCH_ORDERS} 个有效订单号`), { code:"INVALID_WAREHOUSE_TRANSFER_BATCH_PLAN" });
  }
  return JSON.stringify({ orderReferences });
}

async function warehouseTransferBatchExecuteBody(req) {
  const payload = await readJsonBody(req, 4096);
  const batchHash = String(payload.batchHash || "").trim();
  const approvalText = String(payload.approvalText || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(batchHash) || !approvalText || approvalText.length > 300) {
    throw Object.assign(new Error("批量换仓计划或确认文字无效"), { code:"INVALID_WAREHOUSE_TRANSFER_BATCH_EXECUTE" });
  }
  return JSON.stringify({ batchHash,approvalText });
}

export function createFulfillmentDashboardProxy({
  baseUrl = DEFAULT_BASE_URL,
  apiToken = "",
  fetchImpl = fetch,
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
    if (req.method === "POST") headers["content-type"] = "application/json";

    try {
      let requestBody;
      if (req.method === "POST" && upstreamPath === "/api/fulfillment/manual-reviews/recheck") requestBody = await recheckBody(req);
      else if (req.method === "POST" && ["/api/fulfillment/sku-replacements/batch-preview",
        "/api/fulfillment/sku-replacements/batch-recover"].includes(upstreamPath)) requestBody = await skuReplacementBatchPreviewBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/plan") requestBody = await skuReplacementPlanBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/execute") requestBody = await skuReplacementExecuteBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/batch-plan") requestBody = await skuReplacementBatchPlanBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/sku-replacements/batch-execute") requestBody = await skuReplacementBatchExecuteBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/warehouse-transfers/batch-plan") requestBody = await warehouseTransferBatchPlanBody(req);
      else if (req.method === "POST" && upstreamPath === "/api/fulfillment/warehouse-transfers/batch-execute") requestBody = await warehouseTransferBatchExecuteBody(req);
      else if (req.method === "POST") requestBody = "{}";
      const skuBatchRequest = ["/api/fulfillment/sku-replacements/batch-preview",
        "/api/fulfillment/sku-replacements/batch-recover","/api/fulfillment/sku-replacements/batch-plan",
        "/api/fulfillment/warehouse-transfers/batch-plan"].includes(upstreamPath);
      const response = await fetchImpl(new URL(upstreamPath, upstreamBase), {
        method: req.method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(skuBatchRequest ? SKU_BATCH_TIMEOUT_MS : req.method === "POST" ? 120000 : 8000),
      });
      const body = await response.text();
      res.writeHead(response.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body || JSON.stringify({ success: false, error: { code: "EMPTY_RESPONSE", message: "履约服务返回空内容" } }));
    } catch (error) {
      if (["BODY_TOO_LARGE","INVALID_BODY","INVALID_MANUAL_REVIEW","INVALID_SKU_REPLACEMENT_PREVIEW",
        "INVALID_SKU_REPLACEMENT_PLAN","INVALID_SKU_REPLACEMENT_EXECUTE","INVALID_SKU_REPLACEMENT_BATCH_PLAN",
        "INVALID_SKU_REPLACEMENT_BATCH_EXECUTE","INVALID_WAREHOUSE_TRANSFER_BATCH_PLAN",
        "INVALID_WAREHOUSE_TRANSFER_BATCH_EXECUTE"].includes(error?.code)) {
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
