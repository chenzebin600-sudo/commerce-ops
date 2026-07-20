import { FILE_ERROR_CODES, FilePolicyError, publicFileError } from "../security/file-policy.mjs";
import { readProductPackageUpload } from "./product-import-service.mjs";

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

function sendImage(res, { image, buffer }) {
  res.writeHead(200, {
    "content-type": image.mimeType,
    "content-length": String(buffer.length),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(buffer);
  return true;
}

async function readBuffer(req, maxBytes) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > maxBytes) throw new FilePolicyError(FILE_ERROR_CODES.FILE_TOO_LARGE);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new FilePolicyError(FILE_ERROR_CODES.FILE_TOO_LARGE);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxBytes = 64 * 1024) {
  const text = (await readBuffer(req, maxBytes)).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function decodedHeader(value, fallback) {
  try { return decodeURIComponent(String(value || "")) || fallback; } catch { return fallback; }
}

function publicBatch(batch) {
  if (!batch) return null;
  const { fileSha256: _fileSha256, errorSummary, ...safe } = batch;
  return { ...safe, fileHashShort: batch.fileSha256?.slice(0, 12) || null, errorSummary: errorSummary || null };
}

function publicDetail(detail) {
  if (!detail) return null;
  return {
    batch: publicBatch(detail.batch),
    file: detail.file ? {
      exportFileId: detail.file.exportFileId,
      fileRole: detail.file.fileRole,
      sourceFilename: detail.file.sourceFilename,
    } : null,
    rows: detail.rows,
    issues: detail.issues,
  };
}

export function createProductCenterApi({ service, catalogService, imageService, maxUploadBytes }) {
  return async function handleProductCenterApi(req, res, url) {
    if (!url.pathname.startsWith("/api/product-center/")) return false;
    try {
      if (url.pathname === "/api/product-center/products" && req.method === "GET") {
        const result = await catalogService.list({
          keyword: url.searchParams.get("keyword"),
          country: url.searchParams.get("country"),
          categoryL1: url.searchParams.get("category_l1"),
          categoryL2: url.searchParams.get("category_l2"),
          lifecycleStatus: url.searchParams.get("lifecycle_status"),
          sortBy: url.searchParams.get("sort_by"),
          sortDirection: url.searchParams.get("sort_direction"),
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("page_size"),
        });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/product-center/products/filters" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, filters: await catalogService.filters() });
      }
      if (url.pathname === "/api/product-center/products/fields" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...(await catalogService.fields()) });
      }
      if (url.pathname === "/api/product-center/products/detail-preferences" && req.method === "PUT") {
        const body = await readJson(req);
        const preference = await catalogService.saveFieldPreference(body.visibleFields, {
          operatorLabel: req.auditContext?.actorType,
          requestId: req.auditContext?.requestId,
        });
        return sendJson(res, 200, { ok: true, preference });
      }

      const imageMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/images(?:\/([0-9a-f-]+)(?:\/(content))?)?$/i);
      if (imageMatch) {
        const [, productId, imageId, action] = imageMatch;
        if (!imageId && req.method === "POST") {
          const buffer = await readBuffer(req, imageService.maxBytes);
          const image = await imageService.upload(productId, {
            filename: decodedHeader(req.headers["x-file-name"], "product-image"),
            mimeType: req.headers["content-type"],
            buffer,
            operatorLabel: req.auditContext?.actorType,
            requestId: req.auditContext?.requestId,
          });
          req.auditContext?.annotate({ metadata: { productId, imageId: image.id, result: "uploaded" } });
          return sendJson(res, 201, { ok: true, image });
        }
        if (imageId && action === "content" && req.method === "GET") {
          return sendImage(res, await imageService.read(productId, imageId));
        }
        if (imageId && !action && req.method === "DELETE") {
          await imageService.remove(productId, imageId);
          req.auditContext?.annotate({ metadata: { productId, imageId, result: "deleted" } });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      const productMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)$/i);
      if (productMatch && req.method === "GET") {
        const product = await catalogService.detail(productMatch[1]);
        return product ? sendJson(res, 200, { ok: true, product }) : sendJson(res, 404, { ok: false, error: "产品不存在。" });
      }
      if (productMatch && req.method === "PATCH") {
        const body = await readJson(req);
        const product = await catalogService.update(productMatch[1], body.fields, {
          operatorLabel: req.auditContext?.actorType,
          requestId: req.auditContext?.requestId,
        });
        req.auditContext?.annotate({ metadata: { productId: productMatch[1], fieldCount: Object.keys(body.fields || {}).length, result: "updated" } });
        return product ? sendJson(res, 200, { ok: true, product }) : sendJson(res, 404, { ok: false, error: "产品不存在。" });
      }

      if (url.pathname === "/api/product-center/imports") {
        if (req.method === "GET") {
          const result = await service.list({ page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
          return sendJson(res, 200, { ok: true, ...result, batches: result.batches.map(publicBatch) });
        }
        if (req.method === "POST") {
          const upload = await readProductPackageUpload(req, { maxBytes: maxUploadBytes });
          const result = await service.uploadAndValidate({
            ...upload,
            operatorLabel: req.auditContext?.actorType || "local_session",
            requestId: req.auditContext?.requestId || null,
          });
          req.auditContext?.annotate({
            fileId: result.detail?.file?.exportFileId,
            metadata: { batchId: result.batch.id, rowCount: result.batch.rowCount, result: result.reused ? "reused" : "validated" },
          });
          if (!result.reused || result.revalidated) req.auditContext?.addRelated("product", "product.import.validated", { metadata: { batchId: result.batch.id, rowCount: result.batch.rowCount } });
          return sendJson(res, result.reused ? 200 : 201, {
            ok: true,
            reused: result.reused,
            revalidated: Boolean(result.revalidated),
            detail: publicDetail(result.detail),
          });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      const match = url.pathname.match(/^\/api\/product-center\/imports\/([0-9a-f-]+)(?:\/(rows|issues|apply|revalidate))?$/i);
      if (!match) return sendJson(res, 404, { ok: false, error: "产品包接口不存在。" });
      const [, batchId, action] = match;
      if (!action && req.method === "GET") {
        const detail = await service.detail(batchId);
        return detail ? sendJson(res, 200, { ok: true, detail: publicDetail(detail) }) : sendJson(res, 404, { ok: false, error: "导入批次不存在。" });
      }
      if (action === "rows" && req.method === "GET") {
        const rows = await service.rows(batchId, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size"), outcome: url.searchParams.get("outcome") });
        return sendJson(res, 200, { ok: true, ...rows });
      }
      if (action === "issues" && req.method === "GET") {
        const issues = await service.issues(batchId, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size"), severity: url.searchParams.get("severity") });
        return sendJson(res, 200, { ok: true, ...issues });
      }
      if (action === "revalidate" && req.method === "POST") {
        const batch = await service.revalidate(batchId, {
          operatorLabel: req.auditContext?.actorType || "local_session",
          requestId: req.auditContext?.requestId || null,
        });
        req.auditContext?.annotate({ metadata: { batchId, rowCount: batch.rowCount, result: "revalidated" } });
        req.auditContext?.addRelated("product", "product.import.validated", { metadata: { batchId, rowCount: batch.rowCount } });
        return sendJson(res, 200, { ok: true, detail: publicDetail(await service.detail(batchId)) });
      }
      if (action === "apply" && req.method === "POST") {
        const body = await readJson(req);
        const batch = await service.apply(batchId, {
          operatorLabel: req.auditContext?.actorType || "local_session",
          requestId: req.auditContext?.requestId || null,
          acknowledgeWarnings: body.acknowledgeWarnings === true,
          acknowledgeUnknownFields: body.acknowledgeUnknownFields === true,
        });
        req.auditContext?.annotate({ metadata: { batchId, rowCount: batch.rowCount, result: "applied" } });
        return sendJson(res, 200, { ok: true, batch: publicBatch(batch) });
      }
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      const importRequest = url.pathname.startsWith("/api/product-center/imports");
      if (importRequest) req.auditContext?.setOperation("product", "product.import.failed");
      req.auditContext?.annotate({
        errorStage: importRequest ? "product_import" : "product_center",
        errorCode: error?.code || "PRODUCT_CENTER_FAILED",
        errorSummary: error,
      });
      if (error instanceof FilePolicyError) {
        const safe = publicFileError(error, FILE_ERROR_CODES.FILE_STORAGE_ERROR);
        return sendJson(res, safe.status || 400, { ok: false, code: safe.code, error: safe.message });
      }
      const publicCodes = new Set([
        "PRODUCT_NOT_FOUND", "PRODUCT_FIELD_INVALID", "PRODUCT_FIELD_READ_ONLY", "PRODUCT_FIELD_PREFERENCE_INVALID",
        "PRODUCT_IMPORT_NOT_FOUND", "PRODUCT_IMPORT_BLOCKED", "PRODUCT_IMPORT_STATE_INVALID",
        "PRODUCT_IMPORT_WARNINGS_NOT_ACKNOWLEDGED", "PRODUCT_IMPORT_UNKNOWN_FIELDS_NOT_ACKNOWLEDGED",
        "PRODUCT_IMPORT_SOURCE_FILE_MISSING", "PRODUCT_PACKAGE_PARSE_FAILED", "PRODUCT_PACKAGE_ROW_LIMIT_EXCEEDED",
        "PRODUCT_PACKAGE_PARSE_TIMEOUT", "PRODUCT_PACKAGE_PARSE_OUTPUT_LIMIT", "PRODUCT_PACKAGE_PARSER_UNAVAILABLE",
      ]);
      const fallbackCode = importRequest ? "PRODUCT_IMPORT_FAILED" : "PRODUCT_CATALOG_FAILED";
      const fallbackMessage = importRequest ? "产品包导入失败。" : "产品中心操作失败。";
      const code = String(error?.code || fallbackCode).slice(0, 80);
      return sendJson(res, publicCodes.has(code) ? Number(error?.status || 400) : 500, {
        ok: false,
        code: publicCodes.has(code) ? code : fallbackCode,
        error: publicCodes.has(code) ? String(error?.message || fallbackMessage).split(/\r?\n/, 1)[0].slice(0, 180) : fallbackMessage,
      });
    }
  };
}
