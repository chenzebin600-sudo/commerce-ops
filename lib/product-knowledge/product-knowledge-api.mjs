function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
  return true;
}

async function readJson(req, maxBytes = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large");
      error.code = "PK_REQUEST_TOO_LARGE";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
    return value;
  } catch (error) {
    if (error.code === "PK_REQUEST_TOO_LARGE") throw error;
    const invalid = new Error("Request body must be a JSON object");
    invalid.code = "PK_REQUEST_JSON_INVALID";
    invalid.status = 400;
    throw invalid;
  }
}

function actor(req) {
  return String(req.auditContext?.annotations?.actorIdentifier
    || req.auditContext?.actorIdentifier
    || req.headers?.["x-user-id"]
    || "local-user").trim().slice(0, 120);
}

function methodNotAllowed(res) {
  return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
}

function errorResponse(res, error) {
  const known = String(error?.code || "").startsWith("PK_");
  return sendJson(res, Number(error?.status || (known ? 400 : 500)), {
    ok: false,
    code: known ? error.code : "PK_INTERNAL_ERROR",
    error: known ? error.message : "Product-knowledge request failed",
  });
}

export function createProductKnowledgeApi({ service }) {
  if (!service) throw new TypeError("Product-knowledge API service is required");
  return async function handleProductKnowledgeApi(req, res, url) {
    const prefix = "/api/product-knowledge";
    if (!url.pathname.startsWith(prefix)) return false;
    try {
      if (url.pathname === `${prefix}/status`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, { ok: true, status: await service.status() });
      }
      if (url.pathname === `${prefix}/candidates`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        const candidates = await service.listCandidates({
          status: url.searchParams.get("status"),
          targetDomain: url.searchParams.get("target_domain"),
          riskLevel: url.searchParams.get("risk_level"),
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
        });
        return sendJson(res, 200, { ok: true, candidates });
      }
      const reviewMatch = url.pathname.match(/^\/api\/product-knowledge\/candidates\/([^/]+)\/reviews$/);
      if (reviewMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const result = await service.reviewCandidate(
          decodeURIComponent(reviewMatch[1]), await readJson(req), { actorId: actor(req) },
        );
        req.auditContext?.annotate({ actorIdentifier: actor(req), metadata: {
          operation: "product_knowledge_candidate_review",
          candidateId: decodeURIComponent(reviewMatch[1]),
          reviewId: result?.reviewId || null,
          action: result?.candidate?.status || null,
        } });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === `${prefix}/releases`) {
        if (req.method === "GET") {
          const releases = await service.listReleases({
            consumerScope: url.searchParams.get("consumer_scope"),
            status: url.searchParams.get("status"),
            limit: url.searchParams.get("limit"),
          });
          return sendJson(res, 200, { ok: true, releases });
        }
        if (req.method === "POST") {
          const result = await service.createRelease(await readJson(req), { actorId: actor(req) });
          req.auditContext?.annotate({ actorIdentifier: actor(req), metadata: {
            operation: "product_knowledge_release_create",
            releaseId: result.release?.id || null,
            duplicate: result.duplicate === true,
          } });
          return sendJson(res, result.duplicate ? 200 : 201, { ok: true, ...result });
        }
        return methodNotAllowed(res);
      }
      const publishMatch = url.pathname.match(/^\/api\/product-knowledge\/releases\/([^/]+)\/publish$/);
      if (publishMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const release = await service.publishRelease(
          decodeURIComponent(publishMatch[1]), await readJson(req), { actorId: actor(req) },
        );
        req.auditContext?.annotate({ actorIdentifier: actor(req), metadata: {
          operation: "product_knowledge_release_publish",
          releaseId: release.id,
          consumerScope: release.consumerScope,
          version: release.version,
        } });
        return sendJson(res, 200, { ok: true, release });
      }
      if (url.pathname === `${prefix}/support-view`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        const claims = await service.resolveSupportKnowledge({
          productModelId: url.searchParams.get("product_model_id"),
          productSkuId: url.searchParams.get("product_sku_id"),
          categoryId: url.searchParams.get("category_id"),
          countryCode: url.searchParams.get("country"),
          languageCode: url.searchParams.get("language"),
          keyword: url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
        });
        return sendJson(res, 200, { ok: true, claims });
      }
      if (url.pathname === `${prefix}/support-bundle`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        const bundle = await service.resolveSupportBundle({
          productModelId: url.searchParams.get("product_model_id"),
          productSkuId: url.searchParams.get("product_sku_id"),
          categoryId: url.searchParams.get("category_id"),
          categoryName: url.searchParams.get("category_name"),
          countryCode: url.searchParams.get("country"),
          languageCode: url.searchParams.get("language"),
          keyword: url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
        });
        return sendJson(res, 200, { ok: true, bundle });
      }
      return sendJson(res, 404, { ok: false, code: "PK_ROUTE_NOT_FOUND", error: "Product-knowledge route was not found" });
    } catch (error) {
      return errorResponse(res, error);
    }
  };
}
