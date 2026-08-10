import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FilePolicyError,
  createTemporaryFilePath,
  publicFileError,
  removeFileInsideRoot,
  validateXlsxUpload,
} from "../security/file-policy.mjs";
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

function audit(req, { confirmationGranted = false } = {}) {
  return { actorLabel: req.auditContext?.annotations?.actorIdentifier || req.auditContext?.actorIdentifier
      || req.auditContext?.actorType || "local_session",
    requestId: req.auditContext?.requestId || null, confirmationGranted };
}

function pageFilters(url) {
  return { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") };
}

function uploadFilename(req, fallback) {
  const raw = String(req.headers["x-file-name"] || "");
  try { return decodeURIComponent(raw) || fallback; } catch { return raw || fallback; }
}

async function persistManualSource({ domain, filename, mimeType, buffer, fileService, fileStorageConfig }) {
  if (!fileService || !fileStorageConfig) return null;
  const validated = validateXlsxUpload({ filename, mimeType, buffer, config: fileStorageConfig });
  const sourceType = domain === "orders" ? "mabang_manual_order" : "mabang_manual_inventory";
  const requestKey = `manual-import:${sourceType}:${validated.fileHash}`;
  const existing = await fileService.getByRequestKey(requestKey);
  if (existing) return (await fileService.verifyAvailableFile(existing.id)).file;

  const temporary = await createTemporaryFilePath(fileStorageConfig.tempRoot, {
    prefix: `manual-${domain}-import`,
    extension: ".xlsx",
  });
  try {
    await writeFile(temporary.path, buffer, { flag: "wx" });
    const id = randomUUID();
    const month = new Date().toISOString().slice(0, 7);
    const result = await fileService.persistTemporaryExport({
      id,
      requestKey,
      temporaryPath: temporary.path,
      sourceType,
      originalFilename: validated.originalFilename,
      storageFilename: `${id}.xlsx`,
      relativePath: path.posix.join("manual-imports", domain, month, `${id}.xlsx`),
      metadata: { generatedBy: "manual_import" },
    });
    return result.file;
  } catch (error) {
    await removeFileInsideRoot(fileStorageConfig.tempRoot, temporary.path).catch(() => {});
    throw error;
  }
}

export function createGrowthRadarApi({
  service,
  accessPolicy,
  maxUploadBytes = 50 * 1024 * 1024,
  fileService = null,
  fileStorageConfig = null,
}) {
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
      if (url.pathname === "/api/growth-radar/semantics/status" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, semantics: await service.semanticStatus() });
      }
      if (url.pathname === "/api/growth-radar/observations" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, ...(await service.listObservations({ ...pageFilters(url),
          platform: url.searchParams.get("platform"), internalShopId: url.searchParams.get("internal_shop_id"),
          formalScopeOnly: url.searchParams.get("formal_scope") !== "false" })) });
      }
      if (url.pathname === "/api/growth-radar/coverage/status" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, historicalObservedImplemented: true,
          currentOnlineImplemented: false, currentOnlineAuthority: "unavailable" });
      }
      if (url.pathname === "/api/growth-radar/source-batches" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, ...(await service.listBatches({ ...pageFilters(url), sourceType: url.searchParams.get("source_type"),
          confirmationStatus: url.searchParams.get("confirmation_status") })) });
      }
      const batchResultMatch = url.pathname.match(/^\/api\/growth-radar\/source-batches\/([0-9a-f-]+)\/result$/i);
      if (batchResultMatch && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const detail = await service.batchDetail(batchResultMatch[1]);
        return detail ? sendJson(res, 200, { ok: true, batch: detail.batch, applicationResult: detail.metrics })
          : sendJson(res, 404, { ok: false, code: "GROWTH_RADAR_BATCH_NOT_FOUND", error: "来源批次不存在。" });
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
          batchId: url.searchParams.get("batch_id"), status: url.searchParams.get("status"), severity: url.searchParams.get("severity") })) });
      }
      if (url.pathname === "/api/growth-radar/shops") {
        if (req.method === "GET") {
          accessPolicy.assert("growth_radar.data.view");
          return sendJson(res, 200, { ok: true, ...(await service.listShops({ ...pageFilters(url),
            platform: url.searchParams.get("platform"), status: url.searchParams.get("status"),
            confirmationStatus: url.searchParams.get("confirmation_status") })) });
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
      if (shopMatch) {
        if (req.method === "GET") {
          accessPolicy.assert("growth_radar.data.view", shopMatch[1]);
          return sendJson(res, 200, { ok: true, detail: await service.shopDetail(shopMatch[1]) });
        }
        if (req.method === "PATCH") {
          accessPolicy.assert("growth_radar.shop.manage", shopMatch[1]);
          const shop = await service.updateShop(shopMatch[1], await readJson(req));
          req.auditContext?.annotate({ metadata: { shopId: shop.id, result: "updated" } });
          return sendJson(res, 200, { ok: true, shop });
        }
        return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
      }
      const shopConfirmationMatch = url.pathname.match(/^\/api\/growth-radar\/shops\/([0-9a-f-]+)\/(confirm|revoke|history)$/i);
      if (shopConfirmationMatch) {
        const [, shopId, action] = shopConfirmationMatch;
        if (action === "history" && req.method === "GET") {
          accessPolicy.assert("growth_radar.data.view", shopId);
          return sendJson(res, 200, { ok: true, events: await service.shopConfirmationHistory(shopId) });
        }
        if (action === "confirm" && req.method === "POST") {
          accessPolicy.assert("growth_radar.scope.confirm", shopId);
          const result = await service.confirmShopScope(shopId, audit(req));
          req.auditContext?.annotate({ metadata: { shopId, result: result.reused ? "reused" : "confirmed",
            changedFields: "identityStatus,mappingStatus,countryCode" } });
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (action === "revoke" && req.method === "POST") {
          accessPolicy.assert("growth_radar.scope.confirm", shopId);
          const body = await readJson(req);
          const result = await service.revokeShopScope(shopId, body, audit(req));
          req.auditContext?.annotate({ metadata: { shopId, result: result.reused ? "reused" : "revoked", reason: result.reason } });
          return sendJson(res, 200, { ok: true, ...result });
        }
        return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
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
        accessPolicy.assert("growth_radar.data.preview");
        const domain = previewMatch[1];
        const buffer = await readBuffer(req, maxUploadBytes);
        const filename = uploadFilename(req, `${domain}.xlsx`);
        const persistedFile = req.headers["x-source-file-id"] ? null : await persistManualSource({
          domain,
          filename,
          mimeType: req.headers["content-type"],
          buffer,
          fileService,
          fileStorageConfig,
        });
        const result = await service.previewBuffer(domain === "orders" ? "mabang_order" : "mabang_inventory", {
          filename,
          mimeType: req.headers["content-type"],
          buffer,
          sourceFileId: req.headers["x-source-file-id"] || persistedFile?.id || null,
          collectedAt: req.headers["x-collected-at"] || null,
          sourceScope: {
            platform: req.headers["x-source-platform"] || null,
            countryCode: req.headers["x-source-country"] || null,
            warehouseScope: req.headers["x-warehouse-scope"] || null,
          },
        });
        req.auditContext?.annotate({
          fileId: persistedFile?.id || req.headers["x-source-file-id"] || null,
          metadata: { result: "previewed", sourceType: result.sourceType, rowCount: result.rowCount },
        });
        return sendJson(res, 200, { ok: true, preview: result });
      }
      const applyMatch = url.pathname.match(/^\/api\/growth-radar\/import\/(orders|inventory)\/apply$/i);
      if (applyMatch && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.apply");
        const body = await readJson(req);
        const result = await service.applyPreview(applyMatch[1] === "orders" ? "mabang_order" : "mabang_inventory", body,
          audit(req, { confirmationGranted: true }));
        req.auditContext?.annotate({ metadata: { batchId: result.batch.id, result: result.reused ? "reused" : "applied",
          rowCount: result.batch.rowCount, createdCount: result.applicationResult.createdCount,
          updatedCount: result.applicationResult.updatedCount, ignoredCount: result.applicationResult.ignoredCount } });
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
        issue_code: publicError ? String(error.issueCode || code) : code,
        error: publicError ? String(error.message).split(/\r?\n/, 1)[0].slice(0, 180) : "增长雷达数据操作失败。",
      });
    }
  };
}
