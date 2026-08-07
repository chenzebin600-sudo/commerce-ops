import path from "node:path";
import { ConnectorConfigurationError } from "./base/errors.mjs";
import { ConnectorRegistry } from "./base/registry.mjs";
import { LazadaConnector } from "./lazada/connector.mjs";
import { SqlitePlatformRepository } from "./persistence/sqlite-platform-repository.mjs";
import { resolveConnectorEncryptionKey } from "./security/token-cipher.mjs";
import { ShopeeConnector } from "./shopee/connector.mjs";
import {
  resolveShopeeRelayConfig,
  ShopeeRelayClient,
} from "./shopee/relay-client.mjs";
import { resolveLazadaOAuthConfig } from "../integrations/lazada-oauth/lazada-oauth-service.mjs";
import { createPlatformGatewayApi } from "../lib/platform-gateway/platform-gateway-api.mjs";
import { CommercePlatformGatewayService } from "../lib/platform-gateway/platform-gateway-service.mjs";

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function createPlatformConnectorRuntime({ env = process.env, rootDir = process.cwd(), fetchImpl = fetch } = {}) {
  const lazadaConfig = resolveLazadaOAuthConfig({ env, rootDir });
  const shopeeRelayConfig = resolveShopeeRelayConfig(env);
  const encryptionKey = resolveConnectorEncryptionKey(env);
  if (!encryptionKey) {
    const runtimeStatus = () => ({
      enabled: false,
      code: "COMMERCE_CONNECTOR_ENCRYPTION_KEY_MISSING",
      registeredConnectors: [],
      configuredApplications: [],
      shopCount: 0,
      writesEnabled: false,
    });
    return {
      service: null,
      repository: null,
      registry: null,
      status: runtimeStatus,
      async handleApi(req, res, url) {
        if (!url.pathname.startsWith("/api/platform")) return false;
        const status = url.pathname === "/api/platform/status" && req.method === "GET" ? 200 : 503;
        const body = JSON.stringify({ ok: status === 200, ...runtimeStatus() });
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
        return true;
      },
      close() {},
    };
  }
  const databasePath = path.resolve(rootDir, env.COMMERCE_CONNECTOR_DB_PATH || lazadaConfig.databasePath);
  const repository = new SqlitePlatformRepository({ databasePath, encryptionKey });
  const migration = repository.migrateLegacyLazadaTokens();
  const registry = new ConnectorRegistry();
  const apps = new Map(lazadaConfig.apps.map((app) => [app.id, app]));
  registry.register("lazada", ({ platform, shop, authorization }) => {
    const app = apps.get(authorization?.applicationId);
    if (!app?.appKey || !app?.appSecret) {
      throw new ConnectorConfigurationError(`Lazada application ${authorization?.applicationId || "unknown"} is not configured`, {
        platform: "lazada",
      });
    }
    return new LazadaConnector({
      platform,
      shop,
      authorization,
      app: { ...app, requestTimeoutMs: lazadaConfig.requestTimeoutMs },
      fetchImpl,
      timeoutMs: lazadaConfig.requestTimeoutMs,
      maxReadRetries: integer(env.COMMERCE_PLATFORM_READ_RETRIES, 2, 0, 5),
    });
  });
  if (shopeeRelayConfig.enabled) {
    const relayClient = new ShopeeRelayClient({
      ...shopeeRelayConfig,
      fetchImpl,
      maxReadRetries: integer(env.COMMERCE_PLATFORM_READ_RETRIES, 1, 0, 5),
    });
    registry.register("shopee", ({ platform, shop }) => new ShopeeConnector({
      platform,
      shop,
      relayClient,
      modelConcurrency: integer(env.SHOPEE_MODEL_REQUEST_CONCURRENCY, 4, 1, 8),
    }), { authorizationMode: "delegated" });
  }
  const service = new CommercePlatformGatewayService({
    repository,
    registry,
    writeEnabled: enabled(env.COMMERCE_PLATFORM_WRITES_ENABLED),
    refreshSkewMs: integer(env.COMMERCE_PLATFORM_REFRESH_SKEW_SECONDS, 300, 30, 3600) * 1000,
  });
  const runtimeStatus = () => ({
    enabled: true,
    storage: "sqlite",
    registeredConnectors: registry.list(),
    configuredApplications: lazadaConfig.apps.filter((app) => app.appKey && app.appSecret).map((app) => app.id),
    configuredRelays: shopeeRelayConfig.enabled ? ["shopee"] : [],
    shopCount: service.listShops().length,
    writesEnabled: service.writeEnabled,
    legacyMigration: migration,
  });
  return {
    service,
    repository,
    registry,
    status: runtimeStatus,
    handleApi: createPlatformGatewayApi({ service, status: runtimeStatus }),
    close() { repository.close(); },
  };
}
