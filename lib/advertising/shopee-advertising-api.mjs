import { appendVaryHeader, encodeHttpBody } from "../http-content-encoding.mjs";

async function sendJson(req, res, status, payload) {
  const encoded = await encodeHttpBody(JSON.stringify(payload), req.headers?.["accept-encoding"]);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": String(encoded.body.length), vary: appendVaryHeader(res.getHeader?.("vary"), "Accept-Encoding") };
  if (encoded.encoding) headers["content-encoding"] = encoded.encoding;
  res.writeHead(status, headers); res.end(encoded.body); return true;
}

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw Object.assign(new Error("请求内容超过3MB限制。"), { status: 413, code: "ADS_REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function createShopeeAdvertisingApi({ service }) {
  return async function handleShopeeAdvertisingApi(req, res, url) {
    if (!url.pathname.startsWith("/api/shopee-advertising/")) return false;
    try {
      if (url.pathname === "/api/shopee-advertising/dashboard" && req.method === "GET") {
        return sendJson(req, res, 200, { ok: true, dashboard: service.dashboard({ shopId: url.searchParams.get("shop_id") }) });
      }
      if (url.pathname === "/api/shopee-advertising/import" && req.method === "POST") {
        const result = service.importCsv(await readJson(req));
        req.auditContext?.annotate({ metadata: { platform: "shopee", batchId: result.batch.id, duplicate: result.duplicate } });
        return sendJson(req, res, result.duplicate ? 200 : 201, { ok: true, ...result });
      }
      const batchDelete = url.pathname.match(/^\/api\/shopee-advertising\/batches\/([^/]+)$/);
      if (batchDelete && req.method === "DELETE") {
        const result = service.deleteBatch(decodeURIComponent(batchDelete[1]));
        req.auditContext?.annotate({ metadata: {
          platform: "shopee", batchId: result.batch.id, shopId: result.batch.shopId,
          deletedFacts: result.deletedFacts,
        } });
        return sendJson(req, res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/shopee-advertising/targets" && req.method === "PUT") {
        const result = service.saveTargets(await readJson(req));
        return sendJson(req, res, 200, { ok: true, ...result });
      }
      return sendJson(req, res, 404, { ok: false, code: "SHOPEE_ADS_API_NOT_FOUND", error: "Shopee广告巡检接口不存在。" });
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "shopee_advertising", errorCode: error?.code || "SHOPEE_ADS_FAILED", errorSummary: error });
      const status = Number(error?.status || 500);
      return sendJson(req, res, status, { ok: false, code: error?.code || "SHOPEE_ADS_FAILED", error: status < 500 ? String(error?.message || "请求失败。").slice(0, 240) : "Shopee广告巡检处理失败。" });
    }
  };
}
