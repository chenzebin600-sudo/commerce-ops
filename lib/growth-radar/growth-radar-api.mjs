import { FilePolicyError, publicFileError } from "../security/file-policy.mjs";
import { GrowthRadarError } from "./growth-radar-service.mjs";

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
  return true;
}

async function readBuffer(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("上传文件过大。"), { code: "FILE_TOO_LARGE", status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxBytes = 512 * 1024) {
  const buffer = await readBuffer(req, maxBytes);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString("utf8")); } catch {
    throw Object.assign(new Error("请求 JSON 格式无效。"), { code: "REQUEST_JSON_INVALID", status: 400 });
  }
}

function audit(req) {
  return { actorLabel: req.auditContext?.actorType || "local_session", requestId: req.auditContext?.requestId || null };
}

function pageFilters(url) {
  return { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") };
}

export function createGrowthRadarApi({ service, accessPolicy, maxUploadBytes = 50 * 1024 * 1024 }) {
  return async function handleGrowthRadarApi(req, res, url) {
    if (!url.pathname.startsWith("/api/growth-radar/")) return false;
    try {
      if (url.pathname === "/api/growth-radar/capabilities" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, capabilities: accessPolicy.publicCapabilities() });
      }
      if (url.pathname === "/api/growth-radar/summary" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, summary: await service.summary() });
      }
      if (url.pathname === "/api/growth-radar/freshness" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, freshness: await service.freshness(),
          inventoryProductionValidated: false, currentOnlineImplemented: false });
      }
      if (url.pathname === "/api/growth-radar/coverage/status" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, historicalObservedImplemented: true,
          currentOnlineImplemented: false, currentOnlineAuthority: "unavailable" });
      }
      if (url.pathname === "/api/growth-radar/source-batches" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, ...(await service.listBatches({ ...pageFilters(url), sourceType: url.searchParams.get("source_type") })) });
      }
      const batchMatch = url.pathname.match(/^\/api\/growth-radar\/source-batches\/([0-9a-f-]+)$/i);
      if (batchMatch && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const detail = await service.batchDetail(batchMatch[1]);
        return detail ? sendJson(res, 200, { ok: true, detail }) : sendJson(res, 404, { ok: false, code: "GROWTH_RADAR_BATCH_NOT_FOUND", error: "来源批次不存在。" });
      }
      if (url.pathname === "/api/growth-radar/data-quality/issues" && req.method === "GET") {
        accessPolicy.assert("growth_radar.quality.view");
        return sendJson(res, 200, { ok: true, ...(await service.listQualityIssues({ ...pageFilters(url),
          status: url.searchParams.get("status"), severity: url.searchParams.get("severity") })) });
      }
      if (url.pathname === "/api/growth-radar/shops") {
        if (req.method === "GET") {
          accessPolicy.assert("growth_radar.data.view");
          return sendJson(res, 200, { ok: true, ...(await service.listShops({ ...pageFilters(url),
            platform: url.searchParams.get("platform"), status: url.searchParams.get("status") })) });
        }
        if (req.method === "POST") {
          accessPolicy.assert("growth_radar.shop.manage");
          const shop = await service.createShop(await readJson(req));
          req.auditContext?.annotate({ metadata: { shopId: shop.id, result: "created" } });
          return sendJson(res, 201, { ok: true, shop });
        }
        return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
      }
      const shopMatch = url.pathname.match(/^\/api\/growth-radar\/shops\/([0-9a-f-]+)$/i);
      if (shopMatch && req.method === "PATCH") {
        accessPolicy.assert("growth_radar.shop.manage", shopMatch[1]);
        const shop = await service.updateShop(shopMatch[1], await readJson(req));
        req.auditContext?.annotate({ metadata: { shopId: shop.id, result: "updated" } });
        return sendJson(res, 200, { ok: true, shop });
      }
      if (url.pathname === "/api/growth-radar/mappings/shops" && req.method === "GET") {
        accessPolicy.assert("growth_radar.mapping.view");
        return sendJson(res, 200, { ok: true, ...(await service.listShopMappings({ ...pageFilters(url), status: url.searchParams.get("status") })) });
      }
      if (url.pathname === "/api/growth-radar/mappings/shops/unresolved" && req.method === "GET") {
        accessPolicy.assert("growth_radar.mapping.view");
        const mappings = await service.listShopMappings({ ...pageFilters(url), unresolved: true });
        const issues = await service.listMappingIssues({ ...pageFilters(url), issueTypes: ["shop_unmatched", "shop_ambiguous"], status: "open" });
        return sendJson(res, 200, { ok: true, ...mappings, issues: issues.issues, issueTotal: issues.total });
      }
      if (url.pathname === "/api/growth-radar/mappings/shops/confirm" && req.method === "POST") {
        accessPolicy.assert("growth_radar.mapping.confirm");
        const result = await service.confirmShopMapping(await readJson(req), audit(req));
        req.auditContext?.annotate({ metadata: { mappingId: result.mapping.id, shopId: result.mapping.internalShopId, result: "confirmed" } });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/growth-radar/mappings/shops/revoke" && req.method === "POST") {
        accessPolicy.assert("growth_radar.mapping.confirm");
        const result = await service.revokeShopMapping(await readJson(req), audit(req));
        req.auditContext?.annotate({ metadata: { mappingId: result.mapping.id, result: "revoked" } });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/growth-radar/mappings/products" && req.method === "GET") {
        accessPolicy.assert("growth_radar.mapping.view");
        return sendJson(res, 200, { ok: true, ...(await service.listProductMappings({ ...pageFilters(url), status: url.searchParams.get("status") })) });
      }
      if (url.pathname === "/api/growth-radar/mappings/products/unresolved" && req.method === "GET") {
        accessPolicy.assert("growth_radar.mapping.view");
        const mappings = await service.listProductMappings({ ...pageFilters(url), unresolved: true });
        const issues = await service.listMappingIssues({ ...pageFilters(url),
          issueTypes: ["country_unresolved", "sku_unmatched", "sku_ambiguous", "product_country_conflict"], status: "open" });
        return sendJson(res, 200, { ok: true, ...mappings, issues: issues.issues, issueTotal: issues.total });
      }
      if (url.pathname === "/api/growth-radar/mappings/products/confirm" && req.method === "POST") {
        accessPolicy.assert("growth_radar.mapping.confirm");
        const result = await service.confirmProductMapping(await readJson(req), audit(req));
        req.auditContext?.annotate({ metadata: { mappingId: result.mapping.id, productId: result.mapping.internalProductId, result: "confirmed" } });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/growth-radar/mappings/products/revoke" && req.method === "POST") {
        accessPolicy.assert("growth_radar.mapping.confirm");
        const result = await service.revokeProductMapping(await readJson(req), audit(req));
        req.auditContext?.annotate({ metadata: { mappingId: result.mapping.id, result: "revoked" } });
        return sendJson(res, 200, { ok: true, ...result });
      }
      const historyMatch = url.pathname.match(/^\/api\/growth-radar\/mappings\/(shops|products)\/([0-9a-f-]+)\/history$/i);
      if (historyMatch && req.method === "GET") {
        accessPolicy.assert("growth_radar.mapping.view");
        return sendJson(res, 200, { ok: true, events: await service.mappingHistory(historyMatch[1] === "shops" ? "shop" : "product", historyMatch[2]) });
      }
      const previewMatch = url.pathname.match(/^\/api\/growth-radar\/import\/(orders|inventory)\/preview$/i);
      if (previewMatch && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.import");
        const domain = previewMatch[1];
        const buffer = await readBuffer(req, maxUploadBytes);
        const result = await service.previewBuffer(domain === "orders" ? "mabang_order" : "mabang_inventory", {
          filename: decodeURIComponent(String(req.headers["x-file-name"] || `${domain}.xlsx`)),
          mimeType: req.headers["content-type"],
          buffer,
          sourceFileId: req.headers["x-source-file-id"] || null,
          collectedAt: req.headers["x-collected-at"] || null,
          sourceScope: {
            platform: req.headers["x-source-platform"] || null,
            countryCode: req.headers["x-source-country"] || null,
            warehouseScope: req.headers["x-warehouse-scope"] || null,
          },
        });
        req.auditContext?.annotate({ metadata: { result: "previewed", sourceType: result.sourceType, rowCount: result.rowCount } });
        return sendJson(res, 200, { ok: true, preview: result });
      }
      const applyMatch = url.pathname.match(/^\/api\/growth-radar\/import\/(orders|inventory)\/apply$/i);
      if (applyMatch && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.import");
        const body = await readJson(req);
        const result = await service.applyPreview(applyMatch[1] === "orders" ? "mabang_order" : "mabang_inventory", body, audit(req));
        req.auditContext?.annotate({ metadata: { batchId: result.batch.id, result: result.reused ? "reused" : "applied", rowCount: result.batch.rowCount } });
        return sendJson(res, result.reused ? 200 : 201, { ok: true, ...result });
      }
      return sendJson(res, 404, { ok: false, code: "GROWTH_RADAR_API_NOT_FOUND", error: "增长雷达接口不存在。" });
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "growth_radar", errorCode: error?.code || "GROWTH_RADAR_FAILED", errorSummary: error });
      if (error instanceof FilePolicyError) {
        const safe = publicFileError(error);
        return sendJson(res, safe.status || 400, { ok: false, code: safe.code, issue_code: safe.code, error: safe.message });
      }
      const publicError = error instanceof GrowthRadarError || String(error?.code || "").startsWith("GROWTH_RADAR_")
        || error?.code === "REQUEST_JSON_INVALID" || error?.code === "FILE_TOO_LARGE";
      const code = publicError ? String(error.code) : "GROWTH_RADAR_FAILED";
      return sendJson(res, publicError ? Number(error.status || 400) : 500, {
        ok: false,
        code,
        issue_code: code,
        error: publicError ? String(error.message).split(/\r?\n/, 1)[0].slice(0, 180) : "增长雷达数据操作失败。",
      });
    }
  };
}
