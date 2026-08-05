import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { createAiContextApi } from "../lib/ai/context/ai-context-api.mjs";
import { AiContextService } from "../lib/ai/context/ai-context-service.mjs";
import { AI_CONTEXT_VERSION } from "../lib/ai/context/ai-context-contracts.mjs";

const NOW = new Date("2026-08-05T03:00:00.000Z");

function fixture() {
  const freshness = {
    sourceBatches: [
      { source_type: "mabang_order", id: "order-batch", collected_at: "2026-08-04T02:00:00Z" },
      { source_type: "mabang_inventory", id: "inventory-batch", collected_at: "2026-08-04T02:10:00Z" },
    ],
    publishedAnalysis: null,
  };
  return {
    freshness: async () => freshness,
    latestValidOrderDay: async () => "2026-08-04",
    shopMaster: async (id) => id === "shop-1" ? {
      id, internal_shop_code: "SHOP-1", display_name: "Demo Shop", platform: "shopee",
      country_code: "TH", country_name: "Thailand", owner_user_id: "owner-1", status: "active",
    } : null,
    shopPublishedMetric: async () => null,
    shopPublishedHistory: async () => [],
    shopFactTrend: async () => [
      { day: "2026-07-24", sales_quantity: 5, order_count: 2 },
      { day: "2026-07-30", sales_quantity: 8, order_count: 3 },
      { day: "2026-08-04", sales_quantity: 12, order_count: 4 },
    ],
    shopFactInventory: async () => ({ sku_count: 2, available_quantity: 30, in_transit_quantity: 4, minimum_days_of_supply: 6, out_of_stock_rows: 0 }),
    shopSignals: async () => [],
    shopTasks: async () => ({ foundation: [{ id: "task-1", domain: "growth", task_kind: "review", state: "READY", priority: "P1", evidence_json: "{}", updated_at: "2026-08-04" }], growth: [] }),
    productMaster: async (id) => id === "product-1" ? { id, source_main_sku: "MAIN-1", canonical_name: "Demo Product", category_id: "category-1", identity_status: "confirmed" } : null,
    productSkus: async () => [{ id: "sku-1", source_sku: "SKU-1", normalized_sku: "sku-1", lifecycle_status: "active", source_sales_spec: "red" }],
    productPublishedMetrics: async () => [],
    productFactSales: async () => [{ day: "2026-08-04", sales_quantity: 3, normalized_source_sku: "sku-1" }],
    productFactInventory: async () => [{ source_sku: "SKU-1", warehouse_name: "TH-A", available_quantity: 9, in_transit_quantity: 2, days_of_supply: 3 }],
    productListings: async () => [{ id: "listing-1", product_sku_id: "sku-1", platform: "shopee", country: "TH", status: "ready", pricing_json: '{"price":100}', revision: 2, updated_at: "2026-08-04" }],
    productSignals: async () => [],
    productTasks: async () => [],
    skuMaster: async (id) => id === "sku-1" ? { id, source_sku: "SKU-1", normalized_sku: "sku-1", model_id: "product-1", source_product_name: "Demo Product", lifecycle_status: "active" } : null,
    skuPublishedMetrics: async () => [],
    skuPublishedWarehouseMetrics: async () => [],
    skuFactSales: async () => [{ day: "2026-08-04", sales_quantity: 3, order_count: 2 }],
    skuFactInventory: async () => [{ warehouse_name: "TH-A", available_quantity: 9, in_transit_quantity: 2, days_of_supply: 3 }],
    skuListings: async () => [],
    skuPriceHistory: async () => [{ country_raw: "TH", price_tier_45: 100, cost_cny: 60, exchange_rate: 5, created_at: "2026-08-01" }],
    skuSignals: async () => [],
    skuTasks: async () => ({ foundation: [], growth: [] }),
  };
}

test("AI Context Layer returns shop context from structured facts when no analysis is published", async () => {
  const context = await new AiContextService({ repository: fixture(), now: () => NOW }).get("shop", "shop-1");
  assert.equal(context.contextVersion, AI_CONTEXT_VERSION);
  assert.equal(context.contextType, "shop");
  assert.equal(context.quality.evidenceSource, "structured_facts");
  assert.equal(context.quality.limitations.includes("NO_PUBLISHED_ANALYSIS_USING_STRUCTURED_FACTS"), true);
  assert.equal(context.data.profile.platform, "shopee");
  assert.equal(context.data.sales.current7d, 20);
  assert.equal(context.data.sales.previous7d, 5);
  assert.equal(context.data.inventory.minimumDaysOfSupply, 6);
  assert.equal(context.data.currentTasks[0].source, "foundation");
});

test("AI Context Layer exposes product and SKU context without reading source files", async () => {
  const service = new AiContextService({ repository: fixture(), now: () => NOW });
  const product = await service.get("product", "product-1");
  const sku = await service.get("sku", "sku-1");
  assert.equal(product.data.skus[0].sku, "SKU-1");
  assert.equal(product.data.inventory.availableQuantity, 9);
  assert.equal(product.data.listingStatus[0].pricing.price, 100);
  assert.equal(sku.data.sales.current7d, 3);
  assert.equal(sku.data.inventory.minimumDaysOfSupply, 3);
  assert.equal(sku.data.priceChanges[0].standardPriceTier45, 100);
});

test("AI Context Layer rejects unsupported subjects with stable errors", async () => {
  const service = new AiContextService({ repository: fixture(), now: () => NOW });
  await assert.rejects(() => service.get("shop", "missing"), { code: "AI_CONTEXT_SUBJECT_NOT_FOUND" });
  await assert.rejects(() => service.get("excel", "source.xlsx"), { code: "AI_CONTEXT_TYPE_INVALID" });
});

test("AI Context repository queries the fully migrated SQLite schema without writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-layer-"));
  const dataAccess = openCommerceDataAccess({
    rootDir: path.resolve("."),
    databasePath: path.join(root, "commerce.sqlite"),
    migrationsDir: path.resolve("migrations"),
  });
  try {
    const repository = dataAccess.repositories.aiContext;
    const changesBefore = dataAccess.provider.connection.prepare("SELECT total_changes() changes").get().changes;
    await repository.freshness();
    await repository.latestValidOrderDay();
    await Promise.all([
      repository.shopMaster("missing"),
      repository.shopPublishedMetric("missing"),
      repository.shopPublishedHistory("missing"),
      repository.shopFactTrend("missing", "2026-01-01"),
      repository.shopFactInventory("missing"),
      repository.shopSignals("missing"),
      repository.shopTasks("missing"),
      repository.productMaster("missing"),
      repository.productSkus("missing"),
      repository.productPublishedMetrics("missing"),
      repository.productFactSales("missing", "2026-01-01"),
      repository.productFactInventory("missing"),
      repository.productListings("missing"),
      repository.productSignals("missing"),
      repository.productTasks("missing"),
      repository.skuMaster("missing"),
      repository.skuPublishedMetrics("missing"),
      repository.skuPublishedWarehouseMetrics("missing"),
      repository.skuFactSales("missing", "2026-01-01"),
      repository.skuFactInventory("missing"),
      repository.skuListings("missing"),
      repository.skuPriceHistory("missing"),
      repository.skuSignals("missing"),
      repository.skuTasks("missing"),
    ]);
    const changesAfter = dataAccess.provider.connection.prepare("SELECT total_changes() changes").get().changes;
    assert.equal(changesAfter, changesBefore);
  } finally {
    dataAccess.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("AI Context API exposes read-only context routes with stable status codes", async () => {
  const operations = [];
  const service = {
    get: async (type, id) => {
      if (id === "missing") throw Object.assign(new Error(`${type} context subject was not found`), {
        code: "AI_CONTEXT_SUBJECT_NOT_FOUND",
      });
      return { contextVersion: AI_CONTEXT_VERSION, contextType: type, subject: { type, id } };
    },
  };
  const handler = createAiContextApi({ service });
  const invoke = async (method, pathname) => {
    let status = null;
    let body = "";
    const req = {
      method,
      auditContext: {
        setOperation: (...args) => operations.push(args),
        annotate: () => {},
      },
    };
    const res = {
      writeHead: (value) => { status = value; },
      end: (value) => { body = value || ""; },
    };
    const handled = await handler(req, res, new URL(`http://localhost${pathname}`));
    return { handled, status, body: body ? JSON.parse(body) : null };
  };

  const success = await invoke("GET", "/api/ai/context/shop/shop-1");
  assert.equal(success.handled, true);
  assert.equal(success.status, 200);
  assert.equal(success.body.context.contextType, "shop");
  assert.deepEqual(operations[0], ["ai", "ai.context.read"]);

  const missing = await invoke("GET", "/api/ai/context/sku/missing");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "AI_CONTEXT_SUBJECT_NOT_FOUND");

  const disallowed = await invoke("POST", "/api/ai/context/product/product-1");
  assert.equal(disallowed.status, 405);
  assert.equal(await handler({ method: "GET" }, {}, new URL("http://localhost/api/other")), false);
});

test("AI Context production modules cannot read Excel or source files", async () => {
  const files = [
    "lib/ai/context/ai-context-contracts.mjs",
    "lib/ai/context/ai-context-repository.mjs",
    "lib/ai/context/ai-context-service.mjs",
    "lib/ai/context/ai-context-api.mjs",
  ];
  for (const file of files) {
    const source = await fs.readFile(path.resolve(file), "utf8");
    assert.doesNotMatch(source, /node:fs|\.xlsx\b|exceljs|growth-radar-parser|source_file_path/i, file);
  }
});
