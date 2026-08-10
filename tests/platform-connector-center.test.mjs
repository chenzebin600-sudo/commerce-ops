import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BaseConnector } from "../connectors/base/connector.mjs";
import { ConnectorRegistry } from "../connectors/base/registry.mjs";
import { LazadaClient } from "../connectors/lazada/client.mjs";
import { signLazadaRequest } from "../connectors/lazada/signing.mjs";
import { SqlitePlatformRepository } from "../connectors/persistence/sqlite-platform-repository.mjs";
import { createPlatformConnectorRuntime } from "../connectors/runtime.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";
import { registerPlatformGatewayTools } from "../lib/ai/tools/platform-gateway-tools.mjs";
import { createPlatformGatewayApi } from "../lib/platform-gateway/platform-gateway-api.mjs";
import { CommercePlatformGatewayService } from "../lib/platform-gateway/platform-gateway-service.mjs";

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");

function temporaryRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "commerce-platform-center-"));
  const repository = new SqlitePlatformRepository({
    databasePath: path.join(root, "connectors.sqlite"),
    encryptionKey: ENCRYPTION_KEY,
  });
  t.after(() => {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repository };
}

function addShop(repository, {
  sellerId = "seller-1",
  country = "MY",
  accessToken = "access-secret",
  refreshToken = "refresh-secret",
  expiresAt = new Date(Date.now() + 3600_000).toISOString(),
  refreshExpiresAt = new Date(Date.now() + 7200_000).toISOString(),
  credentialGroupId = "group-1",
} = {}) {
  const shop = repository.upsertShop({
    platformId: "lazada",
    shopName: `Shop ${sellerId}`,
    sellerId,
    country,
    status: "active",
  });
  repository.saveAuthorization({
    shopId: shop.id,
    applicationId: "app-1",
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt,
    credentialGroupId,
  });
  return shop;
}

class FakeLazadaConnector extends BaseConnector {
  constructor(context, calls) {
    super({
      ...context,
      capabilities: [
        "refresh_token", "get_shop", "get_orders", "get_order_items", "ready_to_ship",
        "get_products", "get_inventory", "update_inventory",
      ],
    });
    this.calls = calls;
  }

  refreshToken() {
    this.calls.push(["refresh_token", this.shop.id]);
    return {
      accessToken: "refreshed-access",
      refreshToken: "refreshed-refresh",
      expireTime: new Date(Date.now() + 4 * 3600_000).toISOString(),
      refreshExpireTime: new Date(Date.now() + 8 * 3600_000).toISOString(),
    };
  }

  getShop() { return { record: { name: "Provider Shop", status: "active" }, providerRequestId: "seller-request" }; }
  getOrders(input) {
    this.calls.push(["get_orders", this.authorization.accessToken, input.limit]);
    return { records: [{ id: "order-1" }], page: { count: 1 }, providerRequestId: "order-request" };
  }
  getOrderItems(input) {
    this.calls.push(["get_order_items", input.orderId]);
    return { records: [{ id: "item-1", packageId: "FP-1", status: "packed" }], providerRequestId: "items-request" };
  }
  readyToShip(input) {
    this.calls.push(["ready_to_ship", input.packageIds]);
    return {
      records: input.packageIds.map((packageId) => ({ packageId, success: true, itemErrorCode: "0" })),
      success: true,
      providerRequestId: "rts-request",
    };
  }
  getProducts() { return { records: [], page: { count: 0 } }; }
  getInventory() { return { records: [], page: { count: 0 } }; }
  updateInventory() { return { accepted: true }; }
}

function fakeGateway(repository, { writeEnabled = false, refreshSkewMs = 300_000 } = {}) {
  const calls = [];
  const registry = new ConnectorRegistry();
  registry.register("lazada", (context) => new FakeLazadaConnector(context, calls));
  return {
    calls,
    service: new CommercePlatformGatewayService({ repository, registry, writeEnabled, refreshSkewMs }),
  };
}

test("connector repository centralizes shops and encrypts every token at rest", (t) => {
  const { root, repository } = temporaryRepository(t);
  const shop = addShop(repository);
  assert.equal(repository.listPlatforms().some((platform) => platform.type === "lazada"), true);
  assert.equal(repository.listShops({ platformId: "lazada" })[0].sellerId, "seller-1");
  assert.equal(repository.getAuthorization(shop.id).accessToken, "access-secret");
  assert.equal(repository.getAuthorizationMetadata(shop.id).accessToken, undefined);
  const bytes = fs.readFileSync(path.join(root, "connectors.sqlite"));
  assert.equal(bytes.includes(Buffer.from("access-secret")), false);
  assert.equal(bytes.includes(Buffer.from("refresh-secret")), false);
});

test("legacy authorization synchronization preserves provider-verified shop names", (t) => {
  const { repository } = temporaryRepository(t);
  const shop = addShop(repository);
  repository.updateShop(shop.id, {
    shopName: "Verified Shop Name",
    metadata: { providerLastSyncedAt: new Date().toISOString(), providerShortCode: "MYSHORT" },
  });
  repository.db.exec(`
    CREATE TABLE lazada_store_tokens (
      app_id TEXT NOT NULL, shop_id TEXT NOT NULL, account_id TEXT, country TEXT,
      account_platform TEXT, account TEXT, access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL, expire_time TEXT NOT NULL,
      refresh_expire_time TEXT, country_user_info_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (app_id, shop_id)
    )
  `);
  const encrypted = repository.db.prepare("SELECT * FROM connector_shop_authorizations WHERE shop_id=?").get(shop.id);
  const timestamp = new Date().toISOString();
  repository.db.prepare(`
    INSERT INTO lazada_store_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-1", "seller-1", "account-1", "MY", "seller_center", null,
    encrypted.access_token_encrypted, encrypted.refresh_token_encrypted,
    encrypted.expires_at, encrypted.refresh_expires_at,
    JSON.stringify([{ country: "MY", seller_id: "seller-1", short_code: "MYSHORT" }]),
    timestamp, timestamp,
  );
  repository.migrateLegacyLazadaTokens();
  const synchronized = repository.findShop({ platformId: "lazada", identifier: "seller-1" });
  assert.equal(synchronized.shopName, "Verified Shop Name");
  assert.equal(synchronized.metadata.providerShortCode, "MYSHORT");
});

test("gateway refreshes one credential group once and records auditable normalized reads", async (t) => {
  const { repository } = temporaryRepository(t);
  const expiresSoon = new Date(Date.now() + 1_000).toISOString();
  const first = addShop(repository, { sellerId: "seller-my", country: "MY", expiresAt: expiresSoon });
  const second = addShop(repository, { sellerId: "seller-sg", country: "SG", expiresAt: expiresSoon });
  const { service, calls } = fakeGateway(repository);
  const result = await service.getOrders({ platform: "lazada", shopId: first.id, input: { limit: 10 }, requestId: "req-1" });
  assert.equal(result.data.records[0].id, "order-1");
  assert.deepEqual(calls, [
    ["refresh_token", first.id],
    ["get_orders", "refreshed-access", 10],
  ]);
  assert.equal(repository.getAuthorization(second.id).accessToken, "refreshed-access");
  const logs = repository.listApiRequestLogs({ shopId: first.id });
  assert.equal(logs[0].apiName, "get_orders");
  assert.equal(logs[0].responseStatus, "success");
  assert.equal(logs[0].providerRequestId, "order-request");
});

test("gateway write operations fail closed and are still logged", async (t) => {
  const { repository } = temporaryRepository(t);
  const shop = addShop(repository);
  const { service } = fakeGateway(repository);
  await assert.rejects(
    service.updateInventory({ platform: "lazada", shopId: shop.id, input: { items: [] } }),
    (error) => error.code === "COMMERCE_PLATFORM_WRITES_DISABLED" && error.status === 403,
  );
  assert.equal(repository.listApiRequestLogs({ shopId: shop.id })[0].errorCode, "COMMERCE_PLATFORM_WRITES_DISABLED");
});

test("gateway executes ReadyToShip only when writes are explicitly enabled and audits it", async (t) => {
  const { repository } = temporaryRepository(t);
  const shop = addShop(repository);
  const { service, calls } = fakeGateway(repository, { writeEnabled: true });
  const result = await service.readyToShip({
    platform: "lazada",
    shopId: shop.id,
    input: { packageIds: ["FP-1", "FP-2"] },
    requestId: "rts-1",
  });
  assert.equal(result.data.success, true);
  assert.deepEqual(calls[0], ["ready_to_ship", ["FP-1", "FP-2"]]);
  const log = repository.listApiRequestLogs({ shopId: shop.id })[0];
  assert.equal(log.apiName, "ready_to_ship");
  assert.equal(log.providerRequestId, "rts-request");
});

test("platform API exposes normalized gateway endpoints without exposing credentials", async (t) => {
  const { repository } = temporaryRepository(t);
  const shop = addShop(repository);
  const { service } = fakeGateway(repository);
  const handler = createPlatformGatewayApi({ service, status: () => ({ enabled: true }) });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/platform/orders?platform=lazada&shop_id=${shop.id}&limit=5`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.records[0].id, "order-1");
  assert.equal(JSON.stringify(body).includes("access-secret"), false);
  const shops = await (await fetch(`${base}/api/platform/shops?platform=lazada`)).json();
  assert.equal(shops.shops[0].authorization.applicationId, "app-1");
  assert.equal(JSON.stringify(shops).includes("refresh-secret"), false);
});

test("platform API reads and explicitly projects the Platform API authoritative shop catalog", async (t) => {
  const { repository } = temporaryRepository(t);
  const { service } = fakeGateway(repository);
  const calls = [];
  const shopDirectory = {
    async list(filters) {
      calls.push(["list", filters]);
      return [{ id: "directory-1", shopCode: "MS0001", shopName: "Manual Shop", authorizationStatus: "NOT_AUTHORIZED" }];
    },
    async synchronizeFromPlatformGateway() {
      calls.push(["sync-api"]);
      return { source: "API", observed: 1, total: 1, created: 0, updated: 1, rejected: [] };
    },
  };
  const handler = createPlatformGatewayApi({ service, shopDirectory, status: () => ({ enabled: true }) });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const listed = await (await fetch(`${base}/api/platform/shops?platform=lazada`)).json();
  assert.equal(listed.shops[0].shopCode, "MS0001");
  const manual = await fetch(`${base}/api/platform/shops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shopCode: "MS0002", shopName: "Second Shop", platform: "lazada", country: "MY" }),
  });
  assert.equal(manual.status, 409);
  assert.equal((await manual.json()).code, "PLATFORM_API_SHOP_AUTHORITY_REQUIRED");
  const synchronized = await (await fetch(`${base}/api/platform/shops/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })).json();
  assert.equal(synchronized.updated, 1);
  const uploadedRows = await fetch(`${base}/api/platform/shops/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shops: [{ shopCode: "MS0003" }] }),
  });
  assert.equal(uploadedRows.status, 400);
  assert.equal((await uploadedRows.json()).code, "PLATFORM_API_SHOP_ROWS_NOT_ACCEPTED");
  assert.deepEqual(calls.map((call) => call[0]), ["list", "sync-api"]);
});

test("platform API routes order-item reads and guarded ReadyToShip writes", async (t) => {
  const { repository } = temporaryRepository(t);
  const shop = addShop(repository);
  const { service } = fakeGateway(repository, { writeEnabled: true });
  const handler = createPlatformGatewayApi({ service, status: () => ({ enabled: true, writesEnabled: true }) });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const items = await (await fetch(
    `${base}/api/platform/order-items?platform=lazada&shop_id=${shop.id}&order_id=order-1`,
  )).json();
  assert.equal(items.data.records[0].packageId, "FP-1");
  const response = await fetch(`${base}/api/platform/orders/ready-to-ship`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "lazada", shop_id: shop.id, package_ids: ["FP-1"] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.records[0].success, true);
});

test("Agent tools can reach platforms only through a gateway-only boundary", async () => {
  const calls = [];
  const service = {
    getShop: async (input) => ({ ok: true, data: {}, meta: input }),
    getOrders: async (input) => { calls.push(input); return { ok: true, data: {}, meta: input }; },
    getProducts: async (input) => ({ ok: true, data: {}, meta: input }),
    getInventory: async (input) => ({ ok: true, data: {}, meta: input }),
  };
  const registry = registerPlatformGatewayTools({ registry: new AgentToolRegistry(), service });
  assert.equal(registry.list().length, 4);
  assert.equal(registry.get("platform.orders.query").boundary.external_access, "gateway_only");
  await registry.execute("platform.orders.query", "1.0.0", {
    input: { platform: "lazada", shop_id: "shop-1", limit: 25 },
    requestId: "agent-request",
  });
  assert.deepEqual(calls[0], {
    platform: "lazada",
    shopId: "shop-1",
    requestId: "agent-request",
    input: { platform: "lazada", shop_id: "shop-1", limit: 25 },
  });
});

test("Lazada connector uses country-specific endpoint and canonical signing", async () => {
  assert.equal(signLazadaRequest({
    apiPath: "/order/get",
    appSecret: "helloworld",
    parameters: {
      app_key: "123456", access_token: "test", timestamp: "1517820392000",
      sign_method: "sha256", order_id: "1234",
    },
  }), "4190D32361CFB9581350222F345CB77F3B19F0E31D162316848A2C1FFD5FAB4A");
  let endpoint;
  const client = new LazadaClient({
    app: { appKey: "key", appSecret: "secret" },
    shop: { country: "SG" },
    authorization: { accessToken: "access" },
    maxReadRetries: 0,
    fetchImpl: async (url) => {
      endpoint = new URL(url);
      return new Response(JSON.stringify({ code: "0", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client.request({ path: "/seller/get" });
  assert.equal(endpoint.origin, "https://api.lazada.sg");
  assert.ok(endpoint.searchParams.get("sign"));
  assert.equal(endpoint.searchParams.get("access_token"), "access");
});

test("Lazada order query supplies the provider-required default date window", async () => {
  let endpoint;
  const client = new LazadaClient({
    app: { appKey: "key", appSecret: "secret" },
    shop: { country: "MY" },
    authorization: { accessToken: "access" },
    maxReadRetries: 0,
    fetchImpl: async (url) => {
      endpoint = new URL(url);
      return new Response(JSON.stringify({ code: "0", data: { orders: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const { LazadaOrdersApi } = await import("../connectors/lazada/orders.mjs");
  await new LazadaOrdersApi(client).getOrders({ limit: 10 });
  assert.ok(endpoint.searchParams.get("created_after"));
});

test("Lazada fulfillment reads package ids and sends one non-retried ReadyToShip batch", async () => {
  const requests = [];
  const client = new LazadaClient({
    app: { appKey: "key", appSecret: "secret" },
    shop: { country: "PH" },
    authorization: { accessToken: "access" },
    maxReadRetries: 2,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (new URL(url).pathname.endsWith("/order/items/get")) {
        return new Response(JSON.stringify({
          code: "0",
          request_id: "items-request",
          data: [{ order_item_id: "item-1", order_id: "order-1", status: "packed", package_id: "FP-1" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        code: "0",
        request_id: "rts-request",
        result: { success: true, data: { packages: [{ package_id: "FP-1", item_err_code: "0", msg: "success" }] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const { LazadaOrdersApi } = await import("../connectors/lazada/orders.mjs");
  const api = new LazadaOrdersApi(client);
  const items = await api.getOrderItems({ orderId: "order-1" });
  assert.equal(items.records[0].packageId, "FP-1");
  const result = await api.readyToShip({ packageIds: ["FP-1", "FP-1"] });
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, "POST");
  assert.deepEqual(JSON.parse(new URLSearchParams(requests[1].options.body).get("readyToShipReq")), {
    packages: [{ package_id: "FP-1" }],
  });
});

test("runtime stays fail-closed when no token encryption key is configured", async () => {
  const runtime = createPlatformConnectorRuntime({ env: {}, rootDir: process.cwd() });
  assert.equal(runtime.status().enabled, false);
  assert.equal(runtime.status().code, "COMMERCE_CONNECTOR_ENCRYPTION_KEY_MISSING");
  runtime.close();
});
