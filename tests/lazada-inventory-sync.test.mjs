import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLazadaInventoryPlan,
  chunkLazadaInventoryItems,
  executeLazadaInventoryPlan,
  resolveLazadaShopMappings,
} from "../lib/inventory-sync/lazada-inventory-sync-runner.mjs";

test("Lazada shop mappings resolve configured source warehouses without cross-shop pooling", () => {
  const result = resolveLazadaShopMappings([
    { shopName: "YADUO.SG", warehouseNames: ["新加坡EPD-AH仓-1308", "新加坡易企通-A仓-1308"] },
    { shopName: "KIKING HOME", warehouseNames: ["新加坡LONG-A仓-1308"] },
  ], [
    { id: "s1", name: "YADUO.SG" },
    { id: "s2", name: "KIKING HOME" },
  ], [
    { name: "新加坡EPD-AH仓-1308" },
    { name: "新加坡易企通-A仓-1308" },
    { name: "新加坡LONG-A仓-1308" },
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.mappings.map((item) => [item.shopId, item.warehouseNames]), [
    ["s1", ["新加坡EPD-AH仓-1308", "新加坡易企通-A仓-1308"]],
    ["s2", ["新加坡LONG-A仓-1308"]],
  ]);
});

test("Lazada plan sums mapped warehouses, reserves 50, and splits duplicate online SKUs", () => {
  const plan = buildLazadaInventoryPlan({
    safetyStock: 50,
    mappings: [
      { shopId: "s1", shopName: "YADUO.SG", warehouseNames: ["A仓", "B仓"] },
      { shopId: "s2", shopName: "KIKING HOME", warehouseNames: ["C仓"] },
    ],
    inventoryRecords: [
      { 库存SKU编号: "SKU-1", 仓库: "A仓", 可用库存量: 80 },
      { 库存SKU编号: "SKU-1", 仓库: "B仓", 可用库存量: 40 },
      { 库存SKU编号: "SKU-1", 仓库: "C仓", 可用库存量: 60 },
    ],
    listings: [
      { shop_id: "s1", internal_id: "p1", product_id: "x1", title: "One", variants: [{ sku_id: "v1", sku: "SKU-1", stock: 0 }] },
      { shop_id: "s1", internal_id: "p2", product_id: "x2", title: "Two", variants: [{ sku_id: "v2", sku: "SKU-1", stock: 0 }] },
      { shop_id: "s2", internal_id: "p3", product_id: "x3", title: "Three", variants: [{ sku_id: "v3", sku: "SKU-1", stock: 0 }] },
    ],
  });
  const targets = plan.items.map((item) => [item.shop_id, item.target_stock, item.inventory_available]);
  assert.deepEqual(targets, [["s1", 35, 120], ["s1", 35, 120], ["s2", 10, 60]]);
  assert.equal(plan.summary.readyCount, 3);
});

test("Lazada plan blocks an inventory SKU missing from the source snapshot", () => {
  const plan = buildLazadaInventoryPlan({
    mappings: [{ shopId: "s1", shopName: "Shop", warehouseNames: ["A仓"] }],
    listings: [{ shop_id: "s1", internal_id: "p1", variants: [{ sku_id: "v1", sku: "MISSING", stock: 8 }] }],
    inventoryRecords: [],
    safetyStock: 50,
  });
  assert.equal(plan.summary.blockedCount, 1);
  assert.equal(plan.items[0].reason_code, "INVENTORY_SKU_NOT_FOUND");
  assert.equal(plan.items[0].target_stock, null);
});

test("Lazada execution batching never splits a product", () => {
  const items = [
    { shop_id: "s1", internal_id: "p1", variation_id: "v1" },
    { shop_id: "s1", internal_id: "p1", variation_id: "v2" },
    { shop_id: "s1", internal_id: "p2", variation_id: "v3" },
  ];
  const batches = chunkLazadaInventoryItems(items, { maxProducts: 1, maxVariants: 2 });
  assert.deepEqual(batches.map((batch) => batch.map((item) => item.variation_id)), [["v1", "v2"], ["v3"]]);
});

test("Lazada execution isolates a failed product and continues with the next product", async () => {
  const items = [
    { status: "READY", platform: "lazada", shop_id: "s1", shop_name: "Shop", internal_id: "bad", product_id: "x1", variation_id: "v1", seller_sku: "SKU-1", target_stock: 10 },
    { status: "READY", platform: "lazada", shop_id: "s1", shop_name: "Shop", internal_id: "good", product_id: "x2", variation_id: "v2", seller_sku: "SKU-2", target_stock: 20 },
  ];
  const client = {
    async inventoryPreview(batch) {
      if (batch.length > 1 || batch[0].internal_id === "bad") throw new Error("warehouse cannot be selected");
      return { preview_token: "preview", changes: [{ change_id: "change" }] };
    },
    async executePreview() { return { job_id: "job-1" }; },
    async waitForJob() {
      return { job_id: "job-1", state: "completed", successful_products: 1, failed_products: 0, results: [{ internal_id: "good", status: "success" }] };
    },
  };
  const result = await executeLazadaInventoryPlan({ plan: { items }, listingClient: client });
  assert.equal(result.successfulProducts, 1);
  assert.equal(result.failedProducts, 1);
  assert.equal(result.failureCount, 1);
  assert.equal(result.failures[0].internalId, "bad");
});
