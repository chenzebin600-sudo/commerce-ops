import { appendVaryHeader, encodeHttpBody } from "../http-content-encoding.mjs";

async function sendJson(req, res, status, payload) {
  const raw = JSON.stringify(payload);
  const encoded = await encodeHttpBody(raw, req.headers?.["accept-encoding"]);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(encoded.body.length),
    vary: appendVaryHeader(res.getHeader?.("vary"), "Accept-Encoding"),
  };
  if (encoded.encoding) headers["content-encoding"] = encoded.encoding;
  res.writeHead(status, headers);
  res.end(encoded.body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) {
      const error = new Error("请求内容过大。");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function dashboardInput(value = {}) {
  return {
    periodDays: value.periodDays,
    dateFrom: value.dateFrom,
    dateTo: value.dateTo,
    comparisonDays: value.comparisonDays,
    country: value.country,
    categoryL1: value.categoryL1,
    categoryL2: value.categoryL2,
    style: value.style,
    store: value.store,
    forceRefresh: Boolean(value.forceRefresh),
  };
}

function dashboardInputFromUrl(url) {
  return dashboardInput({
    periodDays: url.searchParams.get("period_days"),
    dateFrom: url.searchParams.get("date_from"),
    dateTo: url.searchParams.get("date_to"),
    comparisonDays: url.searchParams.get("comparison_days"),
    country: url.searchParams.get("country"),
    categoryL1: url.searchParams.get("category_l1"),
    categoryL2: url.searchParams.get("category_l2"),
    style: url.searchParams.get("style"),
    store: url.searchParams.get("store"),
    forceRefresh: url.searchParams.get("force_refresh") === "1",
  });
}

export function createSalesAssortmentApi({ service, aiService, accessPolicy }) {
  return async function handleSalesAssortmentApi(req, res, url) {
    if (!url.pathname.startsWith("/api/sales-assortment/")) return false;
    try {
      if (url.pathname === "/api/sales-assortment/dashboard" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const dashboard = await service.dashboard(dashboardInputFromUrl(url));
        return sendJson(req, res, 200, { ok: true, dashboard });
      }
      if (url.pathname === "/api/sales-assortment/overview" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const dashboard = await service.overview(dashboardInputFromUrl(url));
        return sendJson(req, res, 200, { ok: true, dashboard });
      }
      if (url.pathname === "/api/sales-assortment/trend" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const trend = await service.trend(dashboardInputFromUrl(url));
        return sendJson(req, res, 200, { ok: true, data: trend });
      }
      if (url.pathname === "/api/sales-assortment/source-rows" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const result = await service.sourceRows({
          source: url.searchParams.get("source"),
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("page_size"),
        });
        return sendJson(req, res, 200, { ok: true, result });
      }
      if (url.pathname === "/api/sales-assortment/ai-status" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(req, res, 200, { ok: true, ...aiService.status() });
      }
      if (url.pathname === "/api/sales-assortment/analyze" && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.view");
        const analysis = await aiService.analyze(dashboardInput(await readJson(req)));
        req.auditContext?.annotate({
          metadata: {
            provider: analysis.provider,
            model: analysis.model,
            promptVersion: analysis.promptVersion,
            analysisId: analysis.id,
            cached: analysis.cached,
          },
        });
        return sendJson(req, res, 200, { ok: true, analysis });
      }
      return sendJson(req, res, 404, {
        ok: false,
        code: "SALES_ASSORTMENT_API_NOT_FOUND",
        error: "销售与货盘驾驶舱接口不存在。",
      });
    } catch (error) {
      req.auditContext?.annotate({
        errorStage: "sales_assortment",
        errorCode: error?.code || "SALES_ASSORTMENT_FAILED",
        errorSummary: error,
      });
      const status = Number(error?.status || 500);
      const safeAiError = String(error?.code || "").startsWith("AI_");
      return sendJson(req, res, status, {
        ok: false,
        code: error?.code || "SALES_ASSORTMENT_FAILED",
        error: status < 500 || status === 503 || safeAiError
          ? String(error?.message || "请求失败。").slice(0, 240)
          : "销售与货盘数据读取失败。",
      });
    }
  };
}
