function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
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
    country: value.country,
    categoryL1: value.categoryL1,
    categoryL2: value.categoryL2,
    style: value.style,
    forceRefresh: Boolean(value.forceRefresh),
  };
}

export function createSalesAssortmentApi({ service, aiService, accessPolicy }) {
  return async function handleSalesAssortmentApi(req, res, url) {
    if (!url.pathname.startsWith("/api/sales-assortment/")) return false;
    try {
      if (url.pathname === "/api/sales-assortment/dashboard" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const dashboard = await service.dashboard({
          periodDays: url.searchParams.get("period_days"),
          country: url.searchParams.get("country"),
          categoryL1: url.searchParams.get("category_l1"),
          categoryL2: url.searchParams.get("category_l2"),
          style: url.searchParams.get("style"),
        });
        return sendJson(res, 200, { ok: true, dashboard });
      }
      if (url.pathname === "/api/sales-assortment/ai-status" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, ...aiService.status() });
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
        return sendJson(res, 200, { ok: true, analysis });
      }
      return sendJson(res, 404, {
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
      return sendJson(res, status, {
        ok: false,
        code: error?.code || "SALES_ASSORTMENT_FAILED",
        error: status < 500 || status === 503 || safeAiError
          ? String(error?.message || "请求失败。").slice(0, 240)
          : "销售与货盘数据读取失败。",
      });
    }
  };
}
