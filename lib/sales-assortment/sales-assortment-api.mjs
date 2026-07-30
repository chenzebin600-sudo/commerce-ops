function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
  return true;
}

export function createSalesAssortmentApi({ service, accessPolicy }) {
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
      return sendJson(res, Number(error?.status || 500), {
        ok: false,
        code: error?.code || "SALES_ASSORTMENT_FAILED",
        error: Number(error?.status) < 500
          ? String(error?.message || "请求失败。").slice(0, 240)
          : "销售与货盘数据读取失败。",
      });
    }
  };
}
