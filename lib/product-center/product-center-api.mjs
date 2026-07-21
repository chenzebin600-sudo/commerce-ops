import { FILE_ERROR_CODES, FilePolicyError, publicFileError } from "../security/file-policy.mjs";
import { readProductPackageUpload } from "./product-import-service.mjs";
import { createProductAccessPolicy } from "./product-access-policy.mjs";

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
  const { errorSummary, ...safe } = batch;
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
    changes: detail.changes,
  };
}

export function createProductCenterApi({
  service,
  catalogService,
  imageService,
  aiContentService = null,
  imageGenerationService = null,
  listingService = null,
  accessPolicy = createProductAccessPolicy(),
  maxUploadBytes,
}) {
  return async function handleProductCenterApi(req, res, url) {
    if (!url.pathname.startsWith("/api/product-center/")) return false;
    try {
      const audit = {
        operatorLabel: req.auditContext?.actorType || "local_session",
        requestId: req.auditContext?.requestId || null,
      };
      const scopedProduct = async (id, permission) => {
        const product = await catalogService.detail(id);
        if (!product) return null;
        accessPolicy.assert(permission, product);
        return product;
      };
      if (url.pathname === "/api/product-center/capabilities" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...accessPolicy.publicCapabilities() });
      }
      if (url.pathname === "/api/product-center/ai/status" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, {
          ok: true,
          ...(aiContentService?.status() || { configured: false }),
          imageGeneration: imageGenerationService?.status() || { configured: false },
        });
      }
      if (url.pathname === "/api/product-center/products" && req.method === "GET") {
        accessPolicy.assert("product.view");
        const result = await catalogService.list({
          keyword: url.searchParams.get("keyword"),
          country: url.searchParams.get("country"),
          categoryL1: url.searchParams.get("category_l1"),
          categoryL2: url.searchParams.get("category_l2"),
          lifecycleStatus: url.searchParams.get("lifecycle_status"),
          deleted: url.searchParams.get("deleted"),
          accessScope: accessPolicy.listScope,
          sortBy: url.searchParams.get("sort_by"),
          sortDirection: url.searchParams.get("sort_direction"),
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("page_size"),
        });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/product-center/products/filters" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, { ok: true, filters: await catalogService.filters(accessPolicy.listScope) });
      }
      if (url.pathname === "/api/product-center/products/fields" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, { ok: true, ...(await catalogService.fields()) });
      }
      if (url.pathname === "/api/product-center/products/detail-preferences" && req.method === "PUT") {
        accessPolicy.assert("product.edit");
        const body = await readJson(req);
        const preference = await catalogService.saveFieldPreference(body.visibleFields, {
          operatorLabel: req.auditContext?.actorType,
          requestId: req.auditContext?.requestId,
        });
        return sendJson(res, 200, { ok: true, preference });
      }

      const listingMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/listing-drafts(?:\/([0-9a-f-]+))?$/i);
      if (listingMatch) {
        if (!listingService) return sendJson(res, 503, { ok: false, code: "PRODUCT_LISTING_UNAVAILABLE", error: "上架草稿服务尚未启用。" });
        const [, productId, draftId] = listingMatch;
        if (!draftId && req.method === "GET") {
          const product = await scopedProduct(productId, "product.listing.view");
          if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          return sendJson(res, 200, { ok: true, drafts: await listingService.list(productId) });
        }
        if (!draftId && req.method === "POST") {
          const body = await readJson(req, 512 * 1024);
          const permission = body.check === true ? "product.listing.check" : "product.listing.edit";
          const product = await scopedProduct(productId, permission);
          if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          const draft = await listingService.save(product, body.draft || {}, audit, body.check === true);
          req.auditContext?.annotate({ metadata: { productId, country: product.country, result: body.check === true ? "checked" : "saved" } });
          return sendJson(res, 200, { ok: true, draft });
        }
        if (draftId && req.method === "DELETE") {
          const product = await scopedProduct(productId, "product.listing.edit");
          if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          await listingService.remove(productId, draftId, audit);
          req.auditContext?.annotate({ metadata: { productId, country: product.country, result: "archived" } });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      const imageMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/images(?:\/([0-9a-f-]+)(?:\/(content))?)?$/i);
      if (imageMatch) {
        const [, productId, imageId, action] = imageMatch;
        if (!imageId && req.method === "POST") {
          if (!await scopedProduct(productId, "product.edit")) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
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
          if (!await scopedProduct(productId, "product.view")) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          return sendImage(res, await imageService.read(productId, imageId));
        }
        if (imageId && !action && req.method === "DELETE") {
          if (!await scopedProduct(productId, "product.edit")) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          await imageService.remove(productId, imageId);
          req.auditContext?.annotate({ metadata: { productId, imageId, result: "deleted" } });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      const aiMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/ai(?:\/(generate|contents)(?:\/([0-9a-f-]+)\/(confirm))?)?$/i);
      const listingAiGenerateMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/ai\/listing\/generate$/i);
      if (listingAiGenerateMatch && req.method === "POST") {
        if (!aiContentService) return sendJson(res, 503, { ok: false, code: "AI_NOT_CONFIGURED", error: "产品 AI 服务尚未配置。" });
        const product = await scopedProduct(listingAiGenerateMatch[1], "product.ai.generate");
        if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
        const body = await readJson(req, 512 * 1024);
        const controller = new AbortController();
        req.once("aborted", () => controller.abort());
        const result = await aiContentService.generateListingContent(product, body, { ...audit, signal: controller.signal });
        req.auditContext?.annotate({ metadata: { productId: product.id, country: product.country, result: "generated_candidates", contentTypes: result.contentTypes } });
        return sendJson(res, 200, { ok: true, result });
      }

      const aiContentActionMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/ai\/contents\/([0-9a-f-]+)\/(restore|manual)$/i);
      if (aiContentActionMatch && req.method === "POST") {
        if (!aiContentService) return sendJson(res, 503, { ok: false, code: "AI_NOT_CONFIGURED", error: "产品 AI 服务尚未配置。" });
        const [, productId, contentId, action] = aiContentActionMatch;
        const product = await scopedProduct(productId, "product.ai.confirm");
        if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
        const body = await readJson(req, 256 * 1024);
        const content = action === "restore"
          ? await aiContentService.restore(product, contentId, body.adoptedContent, audit)
          : await aiContentService.markManual(product, contentId, body.manualContent, audit);
        if (!content) return sendJson(res, 404, { ok: false, error: "AI 内容不存在。" });
        req.auditContext?.annotate({ metadata: { productId, contentId, result: action } });
        return sendJson(res, 200, { ok: true, content });
      }

      const imageAiMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/ai\/images(?:\/(plan|tasks)(?:\/([0-9a-f-]+)(?:\/(generate|cancel|items)(?:\/([0-9a-f-]+)\/adopt)?)?)?)?$/i);
      if (imageAiMatch) {
        if (!imageGenerationService) return sendJson(res, 503, { ok: false, code: "IMAGE_AI_UNAVAILABLE", error: "图片生成服务尚未启用。" });
        const [, productId, resource, taskId, operation, itemId] = imageAiMatch;
        const product = await scopedProduct(productId, resource === "tasks" && req.method === "GET" ? "product.view" : "product.ai.generate");
        if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
        if (!resource && req.method === "GET") return sendJson(res, 200, { ok: true, ...imageGenerationService.status() });
        if (resource === "plan" && req.method === "POST") {
          const task = await imageGenerationService.createPlan(product, await readJson(req, 512 * 1024), audit);
          req.auditContext?.annotate({ metadata: { productId, taskId: task.id, result: "image_prompt_ready" } });
          return sendJson(res, 201, { ok: true, task, status: imageGenerationService.status() });
        }
        if (resource === "tasks" && !taskId && req.method === "GET") return sendJson(res, 200, { ok: true, tasks: await imageGenerationService.list(productId) });
        if (resource === "tasks" && taskId && operation === "generate" && req.method === "POST") {
          const task = await imageGenerationService.generate(productId, taskId, await readJson(req, 128 * 1024));
          return sendJson(res, 200, { ok: true, task });
        }
        if (resource === "tasks" && taskId && operation === "cancel" && req.method === "POST") {
          return sendJson(res, 200, { ok: true, task: await imageGenerationService.cancel(productId, taskId) });
        }
        if (resource === "tasks" && taskId && operation === "items" && itemId && req.method === "POST") {
          return sendJson(res, 200, { ok: true, task: await imageGenerationService.adopt(product, taskId, itemId, audit) });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      if (aiMatch) {
        if (!aiContentService) return sendJson(res, 503, { ok: false, code: "AI_NOT_CONFIGURED", error: "产品 AI 服务尚未配置。" });
        const [, productId, action, contentId, subAction] = aiMatch;
        if (action === "generate" && req.method === "POST") {
          const product = await scopedProduct(productId, "product.ai.generate");
          if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          const body = await readJson(req, 128 * 1024);
          const controller = new AbortController();
          req.once("aborted", () => controller.abort());
          const result = await aiContentService.generate(product, body, { ...audit, signal: controller.signal });
          req.auditContext?.annotate({ metadata: { productId, country: product.country, result: "generated" } });
          return sendJson(res, 200, { ok: true, result });
        }
        if (action === "contents" && !contentId && req.method === "GET") {
          const product = await scopedProduct(productId, "product.ai.view_history");
          if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          return sendJson(res, 200, { ok: true, ...(await aiContentService.history(productId, {
            page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size"), contentType: url.searchParams.get("content_type"),
          })) });
        }
        if (action === "contents" && !contentId && req.method === "POST") {
          const body = await readJson(req, 256 * 1024);
          const permission = body.status === "confirmed" ? "product.ai.confirm" : "product.ai.generate";
          const product = await scopedProduct(productId, permission);
          if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          const content = await aiContentService.save(product, body, audit);
          req.auditContext?.annotate({ metadata: { productId, country: product.country, result: content.status, version: content.version } });
          return sendJson(res, 201, { ok: true, content });
        }
        if (action === "contents" && contentId && subAction === "confirm" && req.method === "POST") {
          const product = await scopedProduct(productId, "product.ai.confirm");
          if (!product) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
          const body = await readJson(req, 256 * 1024);
          const content = await aiContentService.confirm(product, contentId, body.adoptedContent ?? null, audit);
          if (!content) return sendJson(res, 404, { ok: false, error: "AI 内容不存在。" });
          req.auditContext?.annotate({ metadata: { productId, country: product.country, result: "confirmed", version: content.version } });
          return sendJson(res, 200, { ok: true, content });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      const productMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)$/i);
      if (productMatch && req.method === "GET") {
        const product = await scopedProduct(productMatch[1], "product.view");
        if (product && aiContentService) {
          product.confirmedAiContent = await aiContentService.latestConfirmed(product.id);
          product.confirmedAiContents = await aiContentService.latestConfirmedByTypes(product.id);
        }
        return product ? sendJson(res, 200, { ok: true, product }) : sendJson(res, 404, { ok: false, error: "产品不存在。" });
      }
      if (productMatch && req.method === "PATCH") {
        if (!await scopedProduct(productMatch[1], "product.edit")) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
        const body = await readJson(req);
        const product = await catalogService.update(productMatch[1], body.fields, {
          operatorLabel: req.auditContext?.actorType,
          requestId: req.auditContext?.requestId,
        }, body.clearFields);
        req.auditContext?.annotate({ metadata: { productId: productMatch[1], fieldCount: Object.keys(body.fields || {}).length, result: "updated" } });
        return product ? sendJson(res, 200, { ok: true, product }) : sendJson(res, 404, { ok: false, error: "产品不存在。" });
      }
      if (productMatch && req.method === "DELETE") {
        const current = await scopedProduct(productMatch[1], "product.delete");
        if (!current) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
        const body = await readJson(req);
        const product = await catalogService.softDelete(productMatch[1], body.reason, audit);
        if (listingService) await listingService.archiveForProduct(productMatch[1], audit);
        req.auditContext?.annotate({ metadata: {
          productId: product.id, country: product.country, sku: product.sku,
          reason: String(body.reason || "").trim().slice(0, 240) || null, result: "soft_deleted",
        } });
        return sendJson(res, 200, { ok: true, product });
      }
      const restoreMatch = url.pathname.match(/^\/api\/product-center\/products\/([0-9a-f-]+)\/restore$/i);
      if (restoreMatch && req.method === "POST") {
        const current = await scopedProduct(restoreMatch[1], "product.restore");
        if (!current) return sendJson(res, 404, { ok: false, error: "产品不存在。" });
        const product = await catalogService.restore(restoreMatch[1], audit);
        req.auditContext?.annotate({ metadata: { productId: product.id, country: product.country, sku: product.sku, result: "restored" } });
        return sendJson(res, 200, { ok: true, product });
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

      const match = url.pathname.match(/^\/api\/product-center\/imports\/([0-9a-f-]+)(?:\/(rows|issues|changes|apply|revalidate))?$/i);
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
      if (action === "changes" && req.method === "GET") {
        const changes = await service.changes(batchId, {
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("page_size"),
          country: url.searchParams.get("country"),
          sku: url.searchParams.get("sku"),
          field: url.searchParams.get("field"),
        });
        return sendJson(res, 200, { ok: true, ...changes });
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
        "PRODUCT_DELETE_REASON_INVALID", "PRODUCT_PERMISSION_DENIED", "PRODUCT_AI_GENERATION_IN_PROGRESS", "PRODUCT_AI_STATE_INVALID",
        "PRODUCT_AI_EMPTY_RESPONSE", "PRODUCT_AI_RESPONSE_TOO_LARGE", "PRODUCT_AI_RESPONSE_NOT_JSON", "PRODUCT_AI_RESPONSE_SCHEMA_INVALID", "PRODUCT_AI_CONTENT_TYPE_INVALID", "AI_NOT_CONFIGURED",
        "PRODUCT_LISTING_PLATFORM_INVALID", "PRODUCT_LISTING_COUNTRY_INVALID", "PRODUCT_LISTING_NOT_FOUND", "PRODUCT_LISTING_UNAVAILABLE",
        "IMAGE_AI_NOT_CONFIGURED", "IMAGE_AI_UNAVAILABLE", "IMAGE_PROMPT_SLOT_MISSING", "IMAGE_GENERATION_TASK_NOT_FOUND",
        "IMAGE_GENERATION_ITEM_NOT_FOUND", "IMAGE_GENERATION_ITEM_NOT_READY", "IMAGE_GENERATION_IN_PROGRESS", "IMAGE_LISTING_DRAFT_REQUIRED",
        "AI_TIMEOUT", "AI_RATE_LIMITED", "AI_PROVIDER_ERROR", "AI_INVALID_RESPONSE", "AI_CANCELLED",
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
