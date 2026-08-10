import { appendVaryHeader, encodeHttpBody } from "../http-content-encoding.mjs";
import { writeFile } from "node:fs/promises";
import {
  createTemporaryFilePath,
  removeFileInsideRoot,
  validateXlsxUpload,
} from "../security/file-policy.mjs";

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
    if (size > 64 * 1024) throw Object.assign(new Error("请求内容过大。"), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
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

function decodedHeader(value, fallback = "") {
  const raw = String(value || "").trim();
  try { return decodeURIComponent(raw) || fallback; } catch { return raw || fallback; }
}

function rangeFromUrl(url) {
  return {
    dateFrom: url.searchParams.get("date_from"),
    dateTo: url.searchParams.get("date_to"),
    preset: url.searchParams.get("preset"),
    platform: url.searchParams.get("platform"),
  };
}

export function createProfitApi({
  service,
  accessPolicy,
  fileStorageConfig = null,
  parseShopeeStatement = null,
  maxUploadBytes = 64 * 1024 * 1024,
}) {
  return async function handleProfitApi(req, res, url) {
    if (!url.pathname.startsWith("/api/profit/")) return false;
    try {
      if (url.pathname === "/api/profit/dashboard" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        const dashboard = await service.dashboard({
          ...rangeFromUrl(url), country: url.searchParams.get("country"), shopId: url.searchParams.get("shop_id"),
        });
        return sendJson(req, res, 200, { ok: true, dashboard });
      }
      if (url.pathname === "/api/profit/status" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(req, res, 200, { ok: true, ...(await service.status(rangeFromUrl(url))) });
      }
      if (url.pathname === "/api/profit/periods" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(req, res, 200, { ok: true, ...(service.periods(rangeFromUrl(url))) });
      }
      if (url.pathname === "/api/profit/sync" && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.apply");
        const body = await readJson(req);
        const result = await service.startSync({
          dateFrom: body.dateFrom,
          dateTo: body.dateTo,
          preset: body.preset,
          platform: body.platform,
          triggerType: "manual_sync",
        });
        req.auditContext?.annotate({
          metadata: {
            operation: "profit_sync", platform: body.platform || "ALL", accepted: result.accepted,
          },
        });
        return sendJson(req, res, 202, { ok: true, ...result });
      }
      if (url.pathname === "/api/profit/shopee/import" && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.apply");
        if (!fileStorageConfig || typeof parseShopeeStatement !== "function" || typeof service.importShopeeStatement !== "function") {
          throw Object.assign(new Error("Shopee 账单导入器尚未配置。"), { code: "SHOPEE_STATEMENT_IMPORT_UNAVAILABLE", status: 503 });
        }
        const countryCode = decodedHeader(req.headers["x-country-code"]).toUpperCase();
        const shopId = decodedHeader(req.headers["x-shop-id"]);
        const filename = decodedHeader(req.headers["x-file-name"], "shopee-income-statement.xlsx");
        if (!countryCode || !shopId) throw Object.assign(new Error("请选择 Shopee 国家与店铺。"), { code: "SHOPEE_IMPORT_TARGET_REQUIRED", status: 400 });
        const buffer = await readBuffer(req, maxUploadBytes);
        const upload = validateXlsxUpload({
          filename,
          mimeType: req.headers["content-type"] || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer,
          config: fileStorageConfig,
        });
        const temporary = await createTemporaryFilePath(fileStorageConfig.tempRoot, { prefix: "shopee-profit", extension: ".xlsx" });
        try {
          await writeFile(temporary.path, buffer, { flag: "wx" });
          const statement = await parseShopeeStatement({ filename: temporary.path, countryCode });
          const run = await service.importShopeeStatement({ statement, shopId, triggerType: "manual_import" });
          req.auditContext?.annotate({
            metadata: {
              operation: "profit_shopee_statement_import",
              countryCode,
              shopId,
              runId: run.id,
              sourceHash: upload.fileHash,
              dateFrom: run.dateFrom,
              dateTo: run.dateTo,
            },
          });
          return sendJson(req, res, 201, { ok: true, run });
        } finally {
          await removeFileInsideRoot(fileStorageConfig.tempRoot, temporary.path).catch(() => {});
        }
      }
      if (url.pathname === "/api/profit/shopee/check-access" && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.apply");
        if (typeof service.checkShopeeStatementAccess !== "function") {
          throw Object.assign(new Error("Shopee 官方账单检查尚未配置。"), { code: "SHOPEE_STATEMENT_CHECK_UNAVAILABLE", status: 503 });
        }
        const body = await readJson(req);
        const result = await service.checkShopeeStatementAccess({
          shopId: body.shopId,
          dateFrom: body.dateFrom,
          dateTo: body.dateTo,
        });
        req.auditContext?.annotate({ metadata: {
          operation: "profit_shopee_statement_access_check",
          shopId: result.connectorShopId,
          countryCode: result.countryCode,
          dateFrom: result.requestedRange.dateFrom,
          dateTo: result.requestedRange.dateTo,
          available: result.available,
        } });
        return sendJson(req, res, 200, { ok: true, result });
      }
      return sendJson(req, res, 404, { ok: false, code: "PROFIT_API_NOT_FOUND", error: "利润模块接口不存在。" });
    } catch (error) {
      req.auditContext?.annotate({
        errorStage: "profit", errorCode: error?.code || "PROFIT_FAILED", errorSummary: error,
      });
      const status = Number(error?.status || 500);
      return sendJson(req, res, status, {
        ok: false,
        code: error?.code || "PROFIT_FAILED",
        reason: error?.reason || null,
        error: status < 500 || status === 503 ? String(error?.message || "利润请求失败。").slice(0, 240) : "利润模块处理失败。",
      });
    }
  };
}
