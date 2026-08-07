import { ConnectorError, publicConnectorError } from "../../connectors/base/errors.mjs";

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

async function readJson(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ConnectorError("Request body is too large", {
        code: "COMMERCE_PLATFORM_REQUEST_TOO_LARGE",
        status: 413,
      });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed;
  } catch {
    throw new ConnectorError("Request body must be a JSON object", {
      code: "COMMERCE_PLATFORM_REQUEST_JSON_INVALID",
      status: 400,
    });
  }
}

function commaList(value) {
  const values = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? values.slice(0, 100) : undefined;
}

function requestContext(req, url) {
  return {
    platform: url.searchParams.get("platform"),
    shopId: url.searchParams.get("shop_id"),
    requestId: req.auditContext?.requestId || null,
  };
}

function methodNotAllowed(res) {
  return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
}

export function createPlatformGatewayApi({ service, status = () => ({}) } = {}) {
  if (!service) throw new TypeError("Platform Gateway service is required");
  return async function handlePlatformGatewayApi(req, res, url) {
    if (!url.pathname.startsWith("/api/platform")) return false;
    try {
      if (url.pathname === "/api/platform/status") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, { ok: true, ...status() });
      }
      if (url.pathname === "/api/platforms") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, { ok: true, platforms: service.listPlatforms() });
      }
      if (url.pathname === "/api/platform/shops") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, {
          ok: true,
          shops: service.listShops({
            platformId: url.searchParams.get("platform"),
            country: url.searchParams.get("country"),
            status: url.searchParams.get("status"),
          }),
        });
      }
      if (url.pathname === "/api/platform/logs") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, {
          ok: true,
          logs: service.listApiRequestLogs({
            platform: url.searchParams.get("platform"),
            shopId: url.searchParams.get("shop_id"),
            status: url.searchParams.get("status"),
            limit: url.searchParams.get("limit"),
          }),
        });
      }
      if (url.pathname === "/api/platform/shop") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, await service.getShop(requestContext(req, url)));
      }
      if (url.pathname === "/api/platform/orders") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, await service.getOrders({
          ...requestContext(req, url),
          input: {
            createdAfter: url.searchParams.get("created_after"),
            createdBefore: url.searchParams.get("created_before"),
            updatedAfter: url.searchParams.get("updated_after"),
            updatedBefore: url.searchParams.get("updated_before"),
            status: url.searchParams.get("status"),
            sortBy: url.searchParams.get("sort_by"),
            sortDirection: url.searchParams.get("sort_direction"),
            limit: url.searchParams.get("limit"),
            offset: url.searchParams.get("offset"),
            cursor: url.searchParams.get("cursor"),
          },
        }));
      }
      if (url.pathname === "/api/platform/order-items") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, await service.getOrderItems({
          ...requestContext(req, url),
          input: { orderId: url.searchParams.get("order_id") },
        }));
      }
      if (url.pathname === "/api/platform/orders/ready-to-ship") {
        if (req.method !== "POST") return methodNotAllowed(res);
        const body = await readJson(req);
        const result = await service.readyToShip({
          platform: body.platform,
          shopId: body.shop_id,
          requestId: req.auditContext?.requestId || null,
          input: { packageIds: body.package_ids },
        });
        req.auditContext?.annotate({
          metadata: {
            platform: body.platform,
            shopId: result.meta.shopId,
            operation: "ready_to_ship",
            packageCount: Array.isArray(body.package_ids) ? body.package_ids.length : 0,
          },
        });
        return sendJson(res, 200, result);
      }
      if (url.pathname === "/api/platform/products") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, await service.getProducts({
          ...requestContext(req, url),
          input: {
            filter: url.searchParams.get("filter"),
            search: url.searchParams.get("search"),
            sellerSkus: commaList(url.searchParams.get("seller_skus")),
            updatedAfter: url.searchParams.get("updated_after"),
            updatedBefore: url.searchParams.get("updated_before"),
            createdAfter: url.searchParams.get("created_after"),
            createdBefore: url.searchParams.get("created_before"),
            limit: url.searchParams.get("limit"),
            offset: url.searchParams.get("offset"),
            cursor: url.searchParams.get("cursor"),
          },
        }));
      }
      if (url.pathname === "/api/platform/inventory") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, await service.getInventory({
          ...requestContext(req, url),
          input: {
            filter: url.searchParams.get("filter"),
            sellerSkus: commaList(url.searchParams.get("seller_skus")),
            limit: url.searchParams.get("limit"),
            offset: url.searchParams.get("offset"),
            cursor: url.searchParams.get("cursor"),
          },
        }));
      }
      if (url.pathname === "/api/platform/products/update") {
        if (req.method !== "POST" && req.method !== "PATCH") return methodNotAllowed(res);
        const body = await readJson(req);
        const result = await service.updateProduct({
          platform: body.platform,
          shopId: body.shop_id,
          requestId: req.auditContext?.requestId || null,
          input: body.product || body.input || {},
        });
        req.auditContext?.annotate({ metadata: { platform: body.platform, shopId: result.meta.shopId, operation: "update_product" } });
        return sendJson(res, 200, result);
      }
      if (url.pathname === "/api/platform/inventory/update") {
        if (req.method !== "POST" && req.method !== "PATCH") return methodNotAllowed(res);
        const body = await readJson(req);
        const result = await service.updateInventory({
          platform: body.platform,
          shopId: body.shop_id,
          requestId: req.auditContext?.requestId || null,
          input: body.inventory || body.input || {},
        });
        req.auditContext?.annotate({ metadata: { platform: body.platform, shopId: result.meta.shopId, operation: "update_inventory" } });
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, {
        ok: false,
        code: "COMMERCE_PLATFORM_API_NOT_FOUND",
        error: "Commerce Platform Gateway endpoint was not found",
      });
    } catch (error) {
      req.auditContext?.annotate({
        errorStage: "platform_gateway",
        errorCode: error?.code || "COMMERCE_PLATFORM_GATEWAY_FAILED",
        errorSummary: error instanceof ConnectorError ? error.message : "Platform Gateway failed",
      });
      const safe = publicConnectorError(error);
      return sendJson(res, safe.status, safe.body);
    }
  };
}
