import { SHOPEE_DISCOUNT_APPROVAL_FIELDS, SHOPEE_DISCOUNT_EXECUTION_FIELDS,
  SHOPEE_DISCOUNT_PREVIEW_FIELDS, SHOPEE_DISCOUNT_SCAN_FIELDS } from "./request-schemas.mjs";

const PREFIX = "/api/shopee-discount";
const PREVIEW_FIELDS = new Set(SHOPEE_DISCOUNT_PREVIEW_FIELDS);
const APPROVAL_FIELDS = new Set(SHOPEE_DISCOUNT_APPROVAL_FIELDS);
const EXECUTION_FIELDS = new Set(SHOPEE_DISCOUNT_EXECUTION_FIELDS);
const SCAN_FIELDS = new Set(SHOPEE_DISCOUNT_SCAN_FIELDS);

function apiError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
  return true;
}

async function readJson(req, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw apiError("SHOPEE_DISCOUNT_BODY_TOO_LARGE", "Request body is too large", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("body");
    return value;
  } catch {
    throw apiError("SHOPEE_DISCOUNT_JSON_INVALID", "Request body must be a JSON object", 400);
  }
}

function exactBody(body, fields) {
  const unknown = Object.keys(body).find((key) => !fields.has(key));
  if (unknown) throw apiError("SHOPEE_DISCOUNT_INPUT_INVALID", `Unknown request field: ${unknown}`, 400);
  return body;
}

function query(url, fields) {
  for (const key of url.searchParams.keys()) if (!fields.has(key)) throw apiError("SHOPEE_DISCOUNT_INPUT_INVALID", `Unknown query field: ${key}`, 400);
  const result = {};
  for (const key of fields) if (url.searchParams.has(key)) result[key] = url.searchParams.get(key);
  if (result.pageSize != null) {
    const value = Number(result.pageSize);
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw apiError("SHOPEE_DISCOUNT_INPUT_INVALID", "pageSize must be between 1 and 100", 400);
    result.pageSize = value;
  }
  if (result.limit != null) {
    const value = Number(result.limit);
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw apiError("SHOPEE_DISCOUNT_INPUT_INVALID", "limit must be between 1 and 100", 400);
    result.limit = value;
  }
  return result;
}

function trustedContext(req) {
  const audit = req.auditContext || {};
  return {
    requestId: audit.requestId || null,
    actorId: audit.identity?.actorId || audit.actorIdentifier || audit.annotations?.actorIdentifier || audit.actorType || "trusted-session",
    privilegedIdentity: audit.privilegedIdentity || null,
    identity: audit.identity || null,
    authorizedShopIds: Array.isArray(audit.authorizedShopIds) ? [...audit.authorizedShopIds] : undefined,
  };
}

function method(req, expected) {
  if (req.method !== expected) throw apiError("SHOPEE_DISCOUNT_METHOD_NOT_ALLOWED", "Method not allowed", 405);
}

function safeCode(error) {
  const code = String(error?.code || "");
  return /^(?:SHOPEE_|WAREHOUSE_|FOUNDATION_)/.test(code) ? code : "SHOPEE_DISCOUNT_INTERNAL_ERROR";
}

function errorStatus(error, code) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  if (code.endsWith("NOT_FOUND")) return 404;
  if (code.includes("EXPIRED")) return 410;
  if (code.includes("DISABLED") || code.includes("NOT_AUTHORIZED") || code.includes("PRIVILEGED_IDENTITY_REQUIRED") || code.includes("PRIVILEGED_APPROVAL_REQUIRED")) return 403;
  if (code.startsWith("WAREHOUSE_") || code.includes("UNAVAILABLE")) return 503;
  if (code.includes("CONFLICT") || code.includes("MISMATCH") || code.includes("IMMUTABLE") || code.includes("NOT_APPROVED") || code.includes("CHANGED")) return 409;
  if (code === "SHOPEE_DISCOUNT_INTERNAL_ERROR") return 500;
  return 400;
}

function auditSuccess(req, result) {
  const values = {};
  if (result?.planId) values.planId = result.planId;
  else if (result?.id && (result?.merkleRoot || result?.state === "APPROVED")) values.planId = result.id;
  if (result?.jobId) values.jobId = result.jobId;
  else if (result?.id && result?.status === "PENDING") values.jobId = result.id;
  const metadata = {};
  if (Number.isSafeInteger(result?.summary?.counts?.ready)) metadata.readyCount = result.summary.counts.ready;
  if (Number.isSafeInteger(result?.itemCount)) metadata.itemCount = result.itemCount;
  if (Object.keys(metadata).length) values.metadata = metadata;
  if (Object.keys(values).length) req.auditContext?.annotate?.(values);
}

function planId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw apiError("SHOPEE_DISCOUNT_INPUT_INVALID", "Plan ID is invalid", 400);
  return value;
}

export function createShopeeDiscountApi({ service, maxBodyBytes = 256 * 1024 } = {}) {
  if (!service || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 2 * 1024 * 1024) {
    throw new TypeError("Shopee Discount API configuration is invalid");
  }
  return async function handleShopeeDiscountApi(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const context = trustedContext(req);
    try {
      let result;
      if (url.pathname === `${PREFIX}/status`) {
        method(req, "GET");
        query(url, new Set());
        result = await service.status(context);
      } else if (url.pathname === `${PREFIX}/shops`) {
        method(req, "GET");
        query(url, new Set());
        result = await service.listShops(context);
      } else if (url.pathname === `${PREFIX}/previews`) {
        method(req, "POST");
        query(url, new Set());
        result = await service.createPreview(exactBody(await readJson(req, maxBodyBytes), PREVIEW_FIELDS), context);
      } else if (url.pathname === `${PREFIX}/runs`) {
        method(req, "GET");
        result = await service.listRuns(query(url, new Set(["status", "planId", "limit"])), context);
      } else if (url.pathname === `${PREFIX}/activities`) {
        method(req, "GET");
        result = await service.listActivities(query(url, new Set(["shopId", "status", "limit"])), context);
      } else if (url.pathname === `${PREFIX}/issues`) {
        method(req, "GET");
        result = await service.listIssues(query(url, new Set(["planId", "code", "limit"])), context);
      } else if (url.pathname === `${PREFIX}/intents`) {
        method(req, "GET");
        result = await service.listUnknownIntents(query(url, new Set(["limit", "cursor"])), context);
      } else if (url.pathname === `${PREFIX}/scans`) {
        method(req, "POST");
        query(url, new Set());
        result = await service.requestManualScan(exactBody(await readJson(req, maxBodyBytes), SCAN_FIELDS), context);
      } else if (url.pathname === `${PREFIX}/settings`) {
        query(url, new Set());
        if (req.method === "GET") result = await service.getSettings(context);
        else if (req.method === "PUT") result = await service.updateSettings(exactBody(await readJson(req, maxBodyBytes), new Set(["enabled", "timezone", "warehouseKey", "warehouseKeyReference"])), context);
        else method(req, "GET");
      } else if (url.pathname === `${PREFIX}/settings/verify`) {
        method(req, "POST"); query(url, new Set()); exactBody(await readJson(req, maxBodyBytes), new Set());
        result = await service.verifySettings(context);
      } else if (url.pathname === `${PREFIX}/overrides/lookup`) {
        method(req, "POST"); query(url, new Set());
        result = await service.lookupOverrides(exactBody(await readJson(req, maxBodyBytes), new Set(["country", "shopIds", "query", "limit", "priceTier", "note"])), context);
      } else if (url.pathname === `${PREFIX}/overrides/lookup-batch`) {
        method(req, "POST"); query(url, new Set());
        result = await service.lookupOverrideBatch(exactBody(await readJson(req, maxBodyBytes), new Set(["country", "rows"])), context);
      } else {
        const approveMatch = url.pathname.match(/^\/api\/shopee-discount\/previews\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/approve$/);
        const executeMatch = url.pathname.match(/^\/api\/shopee-discount\/previews\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/execute$/);
        const itemsMatch = url.pathname.match(/^\/api\/shopee-discount\/previews\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/items$/);
        const detailMatch = url.pathname.match(/^\/api\/shopee-discount\/previews\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/);
        const intentMatch = url.pathname.match(/^\/api\/shopee-discount\/intents\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/);
        const reconcileMatch = url.pathname.match(/^\/api\/shopee-discount\/intents\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/reconcile$/);
        if (approveMatch) {
          method(req, "POST");
          query(url, new Set());
          const id = planId(approveMatch[1]);
          const body = exactBody(await readJson(req, maxBodyBytes), APPROVAL_FIELDS);
          if (body.planId !== id) throw apiError("SHOPEE_DISCOUNT_INPUT_INVALID", "Route and body plan IDs must match", 400);
          result = await service.approvePreview(body, context);
        } else if (executeMatch) {
          method(req, "POST");
          query(url, new Set());
          const id = planId(executeMatch[1]);
          const body = exactBody(await readJson(req, maxBodyBytes), EXECUTION_FIELDS);
          if (body.planId !== id) throw apiError("SHOPEE_DISCOUNT_INPUT_INVALID", "Route and body plan IDs must match", 400);
          result = await service.requestExecution(body, context);
        } else if (itemsMatch) {
          method(req, "GET");
          result = await service.listPreviewItems(planId(itemsMatch[1]), query(url, new Set(["cursor", "pageSize", "shopId", "status", "code"])), context);
        } else if (reconcileMatch) {
          method(req, "POST"); query(url, new Set());
          result = await service.reconcileUnknown(planId(reconcileMatch[1]), exactBody(await readJson(req, maxBodyBytes), new Set(["resolution", "evidence"])), context);
        } else if (intentMatch) {
          method(req, "GET"); query(url, new Set()); result = await service.getIntent(planId(intentMatch[1]), context);
        } else if (detailMatch) {
          method(req, "GET");
          query(url, new Set());
          result = await service.getPreview(planId(detailMatch[1]), context);
        } else {
          return json(res, 404, { ok: false, code: "SHOPEE_DISCOUNT_ROUTE_NOT_FOUND", error: "Shopee Discount route not found" });
        }
      }
      auditSuccess(req, result);
      return json(res, 200, { ok: true, data: result });
    } catch (error) {
      const code = safeCode(error);
      const status = errorStatus(error, code);
      req.auditContext?.annotate?.({ errorStage: "shopee_discount", errorCode: code });
      const message = code === "SHOPEE_DISCOUNT_INTERNAL_ERROR" ? "Shopee Discount request failed" : String(error?.message || "Shopee Discount request failed");
      return json(res, status, { ok: false, code, error: message });
    }
  };
}
