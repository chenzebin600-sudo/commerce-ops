import { performance } from "node:perf_hooks";
import {
  ConnectorAuthenticationError,
  ConnectorConfigurationError,
  ConnectorError,
} from "../../connectors/base/errors.mjs";

const OPERATION_METHODS = Object.freeze({
  get_shop: "getShop",
  get_orders: "getOrders",
  get_order_items: "getOrderItems",
  ready_to_ship: "readyToShip",
  get_products: "getProducts",
  update_product: "updateProduct",
  get_inventory: "getInventory",
  update_inventory: "updateInventory",
});

const WRITE_OPERATIONS = new Set(["ready_to_ship", "update_product", "update_inventory"]);

function dateValue(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Platform Gateway clock returned an invalid date");
  return date;
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new ConnectorError(`${label} is required`, {
      code: "COMMERCE_PLATFORM_REQUEST_INVALID",
      status: 400,
    });
  }
  return normalized;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function safeErrorMessage(error) {
  if (error instanceof ConnectorError) return String(error.message || "").slice(0, 500);
  return "Platform connector request failed";
}

export class CommercePlatformGatewayService {
  constructor({
    repository,
    registry,
    writeEnabled = false,
    refreshSkewMs = 5 * 60 * 1000,
    clock = () => new Date(),
  } = {}) {
    if (!repository) throw new TypeError("Platform repository is required");
    if (!registry || typeof registry.create !== "function") throw new TypeError("Connector registry is required");
    this.repository = repository;
    this.registry = registry;
    this.writeEnabled = writeEnabled === true;
    this.refreshSkewMs = Math.max(30_000, Number(refreshSkewMs) || 5 * 60 * 1000);
    this.clock = clock;
    this.refreshLocks = new Map();
  }

  listPlatforms() {
    return this.repository.listPlatforms().map((platform) => ({
      ...platform,
      connectorRegistered: this.registry.has(platform.type),
      writesEnabled: this.writeEnabled && platform.status === "active",
    }));
  }

  listShops(filters = {}) {
    return this.repository.listShops(filters).map((shop) => ({
      ...shop,
      authorization: this.repository.getAuthorizationMetadata(shop.id),
    }));
  }

  listApiRequestLogs(filters = {}) {
    return this.repository.listApiRequestLogs({
      ...filters,
      limit: positiveInteger(filters.limit, 100, 1000),
    });
  }

  getShop(input) { return this.#execute("get_shop", input); }
  getOrders(input) { return this.#execute("get_orders", input); }
  getOrderItems(input) { return this.#execute("get_order_items", input); }
  readyToShip(input) { return this.#execute("ready_to_ship", input); }
  getProducts(input) { return this.#execute("get_products", input); }
  updateProduct(input) { return this.#execute("update_product", input); }
  getInventory(input) { return this.#execute("get_inventory", input); }
  updateInventory(input) { return this.#execute("update_inventory", input); }

  #resolveContext(input, operation) {
    const platformIdentifier = required(input?.platform, "platform").toLowerCase();
    const shopIdentifier = required(input?.shopId, "shop_id");
    const platform = this.repository.getPlatform(platformIdentifier);
    if (!platform) {
      throw new ConnectorError(`Platform ${platformIdentifier} was not found`, {
        code: "COMMERCE_PLATFORM_NOT_FOUND",
        status: 404,
        platform: platformIdentifier,
        operation,
      });
    }
    if (platform.status !== "active") {
      throw new ConnectorConfigurationError(`Platform ${platform.type} is not active`, {
        code: "COMMERCE_PLATFORM_NOT_ACTIVE",
        platform: platform.type,
        operation,
      });
    }
    const shop = this.repository.findShop({ platformId: platform.id, identifier: shopIdentifier });
    if (!shop) {
      throw new ConnectorError(`Shop ${shopIdentifier} was not found for ${platform.type}`, {
        code: "COMMERCE_PLATFORM_SHOP_NOT_FOUND",
        status: 404,
        platform: platform.type,
        operation,
      });
    }
    if (shop.status !== "active") {
      throw new ConnectorConfigurationError(`Shop ${shop.id} is not active`, {
        code: "COMMERCE_PLATFORM_SHOP_NOT_ACTIVE",
        platform: platform.type,
        operation,
      });
    }
    return { platform, shop, requestedShopId: shopIdentifier };
  }

  async #authorizationFor(platform, shop, operation) {
    let authorization = this.repository.getAuthorization(shop.id);
    if (!authorization) {
      throw new ConnectorAuthenticationError(`Shop ${shop.id} has no authorization`, {
        code: "COMMERCE_PLATFORM_AUTHORIZATION_NOT_FOUND",
        status: 409,
        platform: platform.type,
        operation,
      });
    }
    const expiresAt = Date.parse(authorization.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      this.repository.markAuthorizationStatus(shop.id, "invalid");
      throw new ConnectorAuthenticationError(`Shop ${shop.id} authorization expiry is invalid`, {
        code: "COMMERCE_PLATFORM_AUTHORIZATION_INVALID",
        platform: platform.type,
        operation,
      });
    }
    const now = dateValue(this.clock).getTime();
    if (expiresAt <= now + this.refreshSkewMs) {
      authorization = await this.#refreshAuthorization(platform, shop, authorization, operation);
    }
    return authorization;
  }

  async #refreshAuthorization(platform, shop, authorization, operation) {
    const refreshExpiry = authorization.refreshExpiresAt ? Date.parse(authorization.refreshExpiresAt) : null;
    if (refreshExpiry && refreshExpiry <= dateValue(this.clock).getTime()) {
      this.repository.markAuthorizationStatus(shop.id, "expired");
      throw new ConnectorAuthenticationError(`Shop ${shop.id} refresh token has expired`, {
        code: "COMMERCE_PLATFORM_REFRESH_TOKEN_EXPIRED",
        platform: platform.type,
        operation,
      });
    }
    const lockKey = authorization.credentialGroupId || shop.id;
    if (!this.refreshLocks.has(lockKey)) {
      const refreshPromise = (async () => {
        const connector = this.registry.create(platform.type, { platform, shop, authorization });
        const token = await connector.refreshToken();
        this.repository.saveAuthorizationGroup(shop.id, token);
      })().finally(() => this.refreshLocks.delete(lockKey));
      this.refreshLocks.set(lockKey, refreshPromise);
    }
    try {
      await this.refreshLocks.get(lockKey);
    } catch (error) {
      this.repository.markAuthorizationStatus(shop.id, "refresh_failed");
      throw error;
    }
    const refreshed = this.repository.getAuthorization(shop.id);
    if (!refreshed) {
      throw new ConnectorAuthenticationError("Refreshed authorization could not be loaded", {
        code: "COMMERCE_PLATFORM_AUTHORIZATION_RELOAD_FAILED",
        platform: platform.type,
        operation,
      });
    }
    return refreshed;
  }

  async #execute(operation, input = {}) {
    const requestTime = dateValue(this.clock).toISOString();
    const startedAt = performance.now();
    let platform = null;
    let shop = null;
    let requestedShopId = String(input?.shopId || "unknown").slice(0, 200);
    try {
      ({ platform, shop, requestedShopId } = this.#resolveContext(input, operation));
      if (WRITE_OPERATIONS.has(operation) && !this.writeEnabled) {
        throw new ConnectorError("Platform write operations are disabled", {
          code: "COMMERCE_PLATFORM_WRITES_DISABLED",
          status: 403,
          platform: platform.type,
          operation,
        });
      }
      const authorization = await this.#authorizationFor(platform, shop, operation);
      const connector = this.registry.create(platform.type, { platform, shop, authorization });
      connector.assertCapability(operation);
      const method = OPERATION_METHODS[operation];
      const result = await connector[method](input.input || {});
      if (operation === "get_shop" && result?.record) {
        this.repository.updateShop(shop.id, {
          shopName: result.record.name || shop.shopName,
          status: String(result.record.status || shop.status).toLowerCase(),
          metadata: {
            providerVerified: result.record.verified,
            providerShortCode: result.record.shortCode,
            providerLastSyncedAt: dateValue(this.clock).toISOString(),
          },
        });
      }
      this.repository.recordApiRequest({
        requestId: input.requestId || null,
        platform: platform.type,
        shopId: shop.id,
        apiName: operation,
        requestTime,
        responseStatus: "success",
        durationMs: performance.now() - startedAt,
        providerRequestId: result?.providerRequestId || null,
      });
      return {
        ok: true,
        data: result,
        meta: {
          platform: platform.type,
          platformId: platform.id,
          shopId: shop.id,
          sellerId: shop.sellerId,
          country: shop.country,
          operation,
        },
      };
    } catch (error) {
      this.repository.recordApiRequest({
        requestId: input.requestId || null,
        platform: platform?.type || String(input?.platform || "unknown").slice(0, 80),
        shopId: shop?.id || requestedShopId || "unknown",
        apiName: operation,
        requestTime,
        responseStatus: "error",
        durationMs: performance.now() - startedAt,
        errorCode: error?.code || "COMMERCE_PLATFORM_GATEWAY_FAILED",
        errorMessage: safeErrorMessage(error),
        providerRequestId: error?.providerRequestId || null,
      });
      throw error;
    }
  }
}
