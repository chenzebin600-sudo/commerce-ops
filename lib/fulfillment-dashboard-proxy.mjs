const DEFAULT_BASE_URL = "http://127.0.0.1:3112";

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
  if (method === "POST" && pathname === "/api/fulfillment-dashboard/tracking-recoveries/acknowledge") return "/api/fulfillment/tracking-recoveries/acknowledge";
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/tracking-recoveries") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    return `/api/fulfillment/tracking-recoveries?limit=${limit}`;
  }
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/message-review-recoveries/candidates") {
    const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    return `/api/fulfillment/message-review-recoveries/candidates?limit=${limit}`;
  }
  if (method === "GET" && pathname === "/api/fulfillment-dashboard/batches") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    return `/api/fulfillment/batches?limit=${limit}`;
  }
  const previewMatch = pathname.match(/^\/api\/fulfillment-dashboard\/previews\/([a-zA-Z0-9-]+)$/);
  if (method === "GET" && previewMatch) return `/api/fulfillment/previews/${encodeURIComponent(previewMatch[1])}`;
  const batchMatch = pathname.match(/^\/api\/fulfillment-dashboard\/batches\/([a-zA-Z0-9-]+)$/);
  if (method === "GET" && batchMatch) return `/api/fulfillment/batches/${encodeURIComponent(batchMatch[1])}`;
  return null;
}

async function recheckBody(req) {
  let raw = "";
  if (typeof req?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of req) {
      raw += chunk.toString("utf8");
      if (raw.length > 4096) throw Object.assign(new Error("请求内容过大"), { code: "BODY_TOO_LARGE" });
    }
  }
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("请求格式无效"), { code: "INVALID_BODY" }); }
  const shopId = String(payload.shopId || "").trim();
  const orderId = String(payload.orderId || "").trim();
  if (!/^\d{1,24}$/.test(shopId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)) {
    throw Object.assign(new Error("店铺或订单参数无效"), { code: "INVALID_MANUAL_REVIEW" });
  }
  return JSON.stringify({ shopId, orderId });
}

async function trackingAcknowledgementBody(req) {
  let raw = "";
  if (typeof req?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of req) {
      raw += chunk.toString("utf8");
      if (raw.length > 16384) throw Object.assign(new Error("请求内容过大"), { code: "BODY_TOO_LARGE" });
    }
  }
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("请求格式无效"), { code: "INVALID_BODY" }); }
  const items = Array.isArray(payload.items) ? payload.items.map((item) => ({
    shopId:String(item?.shopId || "").trim(),orderId:String(item?.orderId || "").trim(),
  })) : [];
  if (!items.length || items.length > 20 || items.some((item) => !/^\d{1,24}$/.test(item.shopId)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.orderId))) {
    throw Object.assign(new Error("请选择 1 至 20 个有效的待确认订单"), { code: "INVALID_TRACKING_ACKNOWLEDGEMENTS" });
  }
  return JSON.stringify({ items });
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
      const requestBody = req.method === "POST" && upstreamPath === "/api/fulfillment/manual-reviews/recheck"
        ? await recheckBody(req) : req.method === "POST" && upstreamPath === "/api/fulfillment/tracking-recoveries/acknowledge"
          ? await trackingAcknowledgementBody(req) : req.method === "POST" ? "{}" : undefined;
      const response = await fetchImpl(new URL(upstreamPath, upstreamBase), {
        method: req.method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout((req.method === "POST"
          || upstreamPath.startsWith("/api/fulfillment/message-review-recoveries/candidates")) ? 120000 : 8000),
      });
      const body = await response.text();
      res.writeHead(response.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body || JSON.stringify({ success: false, error: { code: "EMPTY_RESPONSE", message: "履约服务返回空内容" } }));
    } catch (error) {
      if (["BODY_TOO_LARGE", "INVALID_BODY", "INVALID_MANUAL_REVIEW", "INVALID_TRACKING_ACKNOWLEDGEMENTS"].includes(error?.code)) {
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
