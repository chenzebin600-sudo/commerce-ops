import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConnectorRegistry } from "../connectors/base/registry.mjs";
import { SqlitePlatformRepository } from "../connectors/persistence/sqlite-platform-repository.mjs";
import { ShopeeConnector } from "../connectors/shopee/connector.mjs";
import { ShopeeRelayClient } from "../connectors/shopee/relay-client.mjs";
import { CommercePlatformGatewayService } from "../lib/platform-gateway/platform-gateway-service.mjs";

const ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64url");
const PLATFORM = { id: "shopee", type: "shopee", apiVersion: "2.0" };
const SHOP = { id: "shopee:1618749121", sellerId: "1618749121", shopName: "Vinco MALL", country: "TH", status: "active" };

function relayResponse(data, extra = {}) {
  return new Response(JSON.stringify({
    ok: true,
    "店编": "TH0001",
    shop_id: Number(SHOP.sellerId),
    "耗时ms": 12,
    data,
    ...extra,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function temporaryRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shopee-relay-"));
  const repository = new SqlitePlatformRepository({
    databasePath: path.join(root, "connectors.sqlite"),
    encryptionKey: ENCRYPTION_KEY,
  });
  t.after(() => {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return repository;
}

test("Shopee relay client exposes only fixed read operations and forces GET upstream", async () => {
  const requests = [];
  const client = new ShopeeRelayClient({
    baseUrl: "http://10.0.0.2:8788",
    apiKey: "test-relay-key",
    maxReadRetries: 0,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options, body: JSON.parse(options.body) });
      return relayResponse({ error: "", response: { item: [] }, request_id: "request-1" });
    },
  });
  const result = await client.call("get_item_list", {
    shopId: SHOP.sellerId,
    params: { offset: 0, page_size: 20, ignored: undefined },
  });
  assert.equal(result.providerRequestId, "request-1");
  assert.equal(requests[0].url, "http://10.0.0.2:8788/api/shopee/call");
  assert.deepEqual(requests[0].body, {
    shop_id: SHOP.sellerId,
    api_path: "/api/v2/product/get_item_list",
    method: "GET",
    params: { offset: 0, page_size: 20 },
  });
  assert.equal(requests[0].options.headers["X-Token-Key"], "test-relay-key");
  await client.call("generate_income_report", {
    shopId: SHOP.sellerId,
    params: { release_time_from: 1785513600, release_time_to: 1786118399 },
  });
  await client.call("get_income_report", {
    shopId: SHOP.sellerId,
    params: { income_report_id: "report-1" },
  });
  assert.equal(requests[1].body.api_path, "/api/v2/payment/generate_income_report");
  assert.equal(requests[2].body.api_path, "/api/v2/payment/get_income_report");
  assert.equal(requests[1].body.method, "GET");
  await assert.rejects(
    client.call("/api/v2/product/update_price", { shopId: SHOP.sellerId }),
    (error) => error.code === "SHOPEE_RELAY_OPERATION_NOT_ALLOWED" && error.status === 403,
  );
});

test("Shopee relay errors are classified without reflecting upstream secrets", async () => {
  const client = new ShopeeRelayClient({
    baseUrl: "http://10.0.0.2:8788",
    apiKey: "test-relay-key",
    maxReadRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({ error: "denied test-relay-key" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(client.call("get_shop_info", { shopId: SHOP.sellerId }), (error) => {
    assert.equal(error.code, "SHOPEE_RELAY_ACCESS_DENIED");
    assert.equal(error.status, 403);
    assert.equal(error.message.includes("test-relay-key"), false);
    return true;
  });
});

test("Shopee connector normalizes shop, order and safe order-item reads", async () => {
  const calls = [];
  const relayClient = {
    async call(operation, input) {
      calls.push({ operation, input });
      if (operation === "get_shop_info") {
        return { data: { shop_name: "Vinco MALL", region: "TH", status: "NORMAL" }, providerRequestId: "shop-request", relayMetadata: { shopCode: "TH0001" } };
      }
      if (operation === "get_order_list") {
        return { data: { request_id: "orders-request", response: { more: false, order_list: [{ order_sn: "260807PCYVFK58", order_status: "READY_TO_SHIP" }] } }, providerRequestId: "orders-request" };
      }
      return {
        data: {
          response: {
            order_list: [{
              order_sn: "260807PCYVFK58",
              order_status: "READY_TO_SHIP",
              create_time: 1786060800,
              update_time: 1786064400,
              total_amount: 2699,
              currency: "THB",
              payment_method: "COD",
              package_list: [{ package_number: "PKG-1", tracking_number: "TRACK-1", shipping_carrier: "SPX", logistics_status: "READY_TO_SHIP" }],
              item_list: [{ item_id: 49855748232, model_id: 410518481510, item_name: "Product", model_sku: "T4AA3038135", model_quantity_purchased: 1 }],
            }],
          },
        },
        providerRequestId: "detail-request",
      };
    },
  };
  const connector = new ShopeeConnector({
    platform: PLATFORM,
    shop: SHOP,
    relayClient,
    clock: () => new Date("2026-08-07T12:00:00.000Z"),
  });
  const shop = await connector.getShop();
  assert.equal(shop.record.name, "Vinco MALL");
  assert.equal(shop.record.status, "active");
  assert.equal(shop.record.providerStatus, "NORMAL");
  const orders = await connector.getOrders({ limit: 20 });
  assert.equal(orders.records[0].id, "260807PCYVFK58");
  assert.equal(orders.records[0].status, "READY_TO_SHIP");
  assert.equal(calls[1].input.params.response_optional_fields, "order_status");
  assert.equal(calls[1].input.params.time_to - calls[1].input.params.time_from, 15 * 24 * 60 * 60);
  const items = await connector.getOrderItems({ orderId: "260807PCYVFK58" });
  assert.equal(items.records[0].sellerSku, "T4AA3038135");
  assert.equal(items.records[0].packageId, "PKG-1");
  assert.equal(items.records[0].trackingCode, "TRACK-1");
  assert.equal(JSON.stringify(items).includes("buyer"), false);
});

test("Shopee connector assembles product and inventory records from bounded read calls", async () => {
  const calls = [];
  const relayClient = {
    async call(operation) {
      calls.push(operation);
      if (operation === "get_item_list") {
        return { data: { response: { item: [{ item_id: 49855748232 }], total_count: 18, has_next_page: true } }, providerRequestId: "list-request" };
      }
      if (operation === "get_item_base_info") {
        return { data: { response: { item_list: [{
          item_id: 49855748232,
          item_name: "Vinco Product",
          item_sku: "ITEM-SKU",
          item_status: "NORMAL",
          category_id: 100001,
          create_time: 1786060800,
          update_time: 1786064400,
          image: { image_url_list: ["https://example.invalid/product.jpg"] },
          attribute_list: [{ original_attribute_name: "Color", attribute_value_list: [{ original_value_name: "Black" }] }],
        }] } }, providerRequestId: "base-request" };
      }
      return { data: { response: { model: [{
        model_id: 410518481510,
        model_sku: "T4AA3038135",
        model_status: "NORMAL",
        price_info: [{ original_price: 2999, current_price: 2699 }],
        stock_info_v2: { summary_info: { total_available_stock: 666 }, seller_stock: [{ location_id: "THZ", stock: 666 }] },
      }] } }, providerRequestId: "model-request" };
    },
  };
  const connector = new ShopeeConnector({ platform: PLATFORM, shop: SHOP, relayClient });
  const products = await connector.getProducts({ limit: 50, offset: 0 });
  assert.deepEqual(calls, ["get_item_list", "get_item_base_info", "get_model_list"]);
  assert.equal(products.page.limit, 20);
  assert.equal(products.records[0].skus[0].specialPrice, "2699");
  assert.equal(products.records[0].skus[0].available, 666);
  assert.equal(products.records[0].attributes.Color, "Black");
  calls.length = 0;
  const inventory = await connector.getInventory({ limit: 1 });
  assert.equal(inventory.records[0].sellerSku, "T4AA3038135");
  assert.equal(inventory.records[0].warehouses[0].location_id, "THZ");
});

test("Gateway delegated authorization reaches Shopee without decrypting a local token and still blocks writes", async (t) => {
  const repository = temporaryRepository(t);
  const shop = repository.upsertShop({
    platformId: "shopee",
    id: SHOP.id,
    shopName: SHOP.shopName,
    sellerId: SHOP.sellerId,
    country: SHOP.country,
  });
  repository.getAuthorization = () => { throw new Error("delegated connector must not read local authorization"); };
  const registry = new ConnectorRegistry();
  registry.register("shopee", ({ platform, shop: contextShop }) => new ShopeeConnector({
    platform,
    shop: contextShop,
    relayClient: {
      async call() {
        return { data: { response: { order_list: [], more: false } }, providerRequestId: "delegated-request" };
      },
    },
  }), { authorizationMode: "delegated" });
  const service = new CommercePlatformGatewayService({ repository, registry, writeEnabled: true });
  const result = await service.getOrders({ platform: "shopee", shopId: shop.id });
  assert.equal(result.ok, true);
  assert.equal(result.data.providerRequestId, "delegated-request");
  await assert.rejects(
    service.updateInventory({ platform: "shopee", shopId: shop.id, input: { items: [] } }),
    (error) => error.code === "CONNECTOR_CAPABILITY_UNAVAILABLE" && error.status === 501,
  );
  const logs = repository.listApiRequestLogs({ shopId: shop.id });
  assert.equal(logs.some((log) => log.apiName === "get_orders" && log.responseStatus === "success"), true);
  assert.equal(logs.some((log) => log.apiName === "update_inventory" && log.responseStatus === "error"), true);
});
