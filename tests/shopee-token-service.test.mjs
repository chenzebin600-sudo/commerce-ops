import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqlitePlatformRepository } from "../connectors/persistence/sqlite-platform-repository.mjs";
import { ShopeeTokenServiceClient } from "../connectors/shopee/token-service-client.mjs";
import { ShopeeTokenSyncService } from "../connectors/shopee/token-sync-service.mjs";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function listPayload() {
  return {
    "人": "Test Owner",
    "店数": 2,
    "有令牌": 1,
    shops: [
      {
        "店编": "MS0001",
        "店名": "Bound Shop",
        "国家": "马来",
        shop_id: "1234567890",
        "有令牌": true,
        "access剩余秒": 3600,
        "access可用": true,
      },
      {
        "店编": "YS0001",
        "店名": "Unbound Shop",
        "国家": "印尼",
        shop_id: "2234567890",
        "有令牌": false,
        "access剩余秒": null,
        "access可用": false,
      },
    ],
  };
}

test("Shopee token service client normalizes shops and never exposes its API key in errors", async () => {
  const requests = [];
  const client = new ShopeeTokenServiceClient({
    baseUrl: "http://10.0.0.2:8788",
    apiKey: "test-api-key",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), header: options.headers["X-Token-Key"] });
      return response(listPayload());
    },
  });
  const result = await client.listShops();
  assert.equal(result.authorized, 1);
  assert.equal(result.shops[0].countryCode, "MY");
  assert.equal(requests[0].header, "test-api-key");

  const denied = new ShopeeTokenServiceClient({
    baseUrl: "http://10.0.0.2:8788",
    apiKey: "test-api-key",
    fetchImpl: async () => response({ error: "key invalid test-api-key" }, 403),
  });
  await assert.rejects(denied.listShops(), (error) => {
    assert.equal(error.code, "SHOPEE_TOKEN_SERVICE_KEY_INVALID");
    assert.equal(String(error.message).includes("test-api-key"), false);
    return true;
  });
});

test("Shopee token sync atomically encrypts bound tokens and removes stale unbound authorization", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shopee-token-sync-"));
  const databasePath = path.join(root, "connectors.sqlite");
  const repository = new SqlitePlatformRepository({ databasePath, encryptionKey: ENCRYPTION_KEY });
  t.after(() => {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const staleShop = repository.upsertShop({
    platformId: "shopee",
    id: "shopee:2234567890",
    shopName: "Old Shop",
    sellerId: "2234567890",
    country: "ID",
  });
  repository.saveAuthorization({
    shopId: staleShop.id,
    applicationId: "old-app",
    accessToken: "test-stale-token",
    refreshToken: "",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  const client = {
    async listShops() { return new ShopeeTokenServiceClient({
      baseUrl: "http://10.0.0.2:8788",
      apiKey: "test-api-key",
      fetchImpl: async () => response(listPayload()),
    }).listShops(); },
    async getAccessToken(shopId) {
      assert.equal(shopId, "1234567890");
      return {
        accessToken: "test-live-token",
        partnerId: "2013594",
        shopId,
        shopCode: "MS0001",
        shopName: null,
        accessRemainingSeconds: 3600,
        expireTime: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
  };
  const result = await new ShopeeTokenSyncService({ repository, client }).synchronize();
  assert.equal(result.authorized, 1);
  assert.equal(result.unbound, 1);
  const bound = repository.findShop({ platformId: "shopee", identifier: "1234567890" });
  assert.equal(repository.getAuthorization(bound.id).accessToken, "test-live-token");
  assert.equal(repository.getAuthorization(staleShop.id), null);
  const raw = fs.readFileSync(databasePath);
  assert.equal(raw.includes(Buffer.from("test-live-token")), false);
  assert.equal(raw.includes(Buffer.from("test-stale-token")), false);
});
