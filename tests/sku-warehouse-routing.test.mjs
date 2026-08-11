import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSkuWarehouseRoutes, warehouseKey, warehouseScope } from "../fulfillment-service/sku-warehouse-routing.mjs";

const keepFixture = {
  replacementItemId: "replace-line",
  replacementSku: "NEW-SKU",
  allowedWarehouses: ["允许仓B", "允许仓A"],
  items: [
    { itemId: "replace-line", stockSku: "OLD-SKU", quantity: 2, stockWarehouseName: "当前仓/1308", warehouseOptions: [{ text: "当前仓" }] },
    { itemId: "other-line", stockSku: "OTHER-SKU", quantity: 3, stockWarehouseName: "当前仓", warehouseOptions: [{ text: "当前仓" }, { text: "允许仓A" }, { text: "允许仓B" }] },
  ],
  inventory: [
    { warehouse: "当前仓", sku: "NEW-SKU", available: 2 },
    { warehouse: "当前仓", sku: "OTHER-SKU", available: 3 },
    { warehouse: "允许仓A", sku: "NEW-SKU", available: 9 },
    { warehouse: "允许仓A", sku: "OTHER-SKU", available: 9 },
    { warehouse: "允许仓B", sku: "NEW-SKU", available: 9 },
    { warehouse: "允许仓B", sku: "OTHER-SKU", available: 9 },
  ],
};

const moveFixture = {
  replacementItemId: "replace-line",
  replacementSku: "NEW-SKU",
  allowedWarehouses: ["允许仓A", "允许仓B"],
  items: [
    { itemId: "replace-line", stockSku: "OLD-SKU", quantity: 2, stockWarehouseName: "当前仓", warehouseOptions: [{ text: "当前仓" }] },
    { itemId: "other-line", stockSku: "OTHER-SKU", quantity: 3, stockWarehouseName: "当前仓", warehouseOptions: [{ text: "当前仓" }, { text: "允许仓A" }, { text: "允许仓B" }] },
  ],
  inventory: [
    { warehouse: "当前仓", sku: "NEW-SKU", available: 1 },
    { warehouse: "当前仓", sku: "OTHER-SKU", available: 3 },
    { warehouse: "允许仓A", sku: "NEW-SKU", available: 4 },
    { warehouse: "允许仓A", sku: "OTHER-SKU", available: 4 },
    { warehouse: "允许仓B", sku: "NEW-SKU", available: 4 },
    { warehouse: "允许仓B", sku: "OTHER-SKU", available: 7 },
  ],
};

const multiWarehouseFixture = {
  replacementItemId: "replace-line",
  replacementSku: "NEW-SKU",
  allowedWarehouses: ["允许仓A", "允许仓B"],
  items: [
    { itemId: "replace-line", stockSku: "OLD-SKU", quantity: 1, stockWarehouseName: "当前仓甲", warehouseOptions: [{ text: "当前仓甲" }] },
    { itemId: "other-line", stockSku: "OTHER-SKU", quantity: 1, stockWarehouseName: "当前仓乙", warehouseOptions: [{ text: "当前仓乙" }, { text: "允许仓A" }, { text: "允许仓B" }] },
  ],
  inventory: [
    { warehouse: "允许仓A", sku: "NEW-SKU", available: 3 },
    { warehouse: "允许仓A", sku: "OTHER-SKU", available: 3 },
    { warehouse: "允许仓B", sku: "NEW-SKU", available: 2 },
    { warehouse: "允许仓B", sku: "OTHER-SKU", available: 2 },
  ],
};

const emptyAllowlistFixture = {
  replacementItemId: "replace-line",
  replacementSku: "NEW-SKU",
  allowedWarehouses: [],
  items: [
    { itemId: "replace-line", stockSku: "OLD-SKU", quantity: 1, stockWarehouseName: "当前仓甲", warehouseOptions: [] },
    { itemId: "other-line", stockSku: "OTHER-SKU", quantity: 1, stockWarehouseName: "当前仓乙", warehouseOptions: [] },
  ],
  inventory: [],
};

test("keeps the observed single current warehouse when the prospective order fits", () => {
  const result = evaluateSkuWarehouseRoutes(keepFixture);
  assert.equal(result.selected.mode, "KEEP_CURRENT");
  assert.equal(result.alternatives.some((item) => item.mode === "MOVE_WHOLE_ORDER"), false);
});

test("moves the whole prospective order only to an eligible allowlisted warehouse", () => {
  assert.equal(evaluateSkuWarehouseRoutes(moveFixture).selected.warehouse, "允许仓B");
  assert.deepEqual(evaluateSkuWarehouseRoutes(moveFixture).alternatives.map((item) => item.warehouse), ["允许仓B", "允许仓A"]);
});

test("does not offer KEEP_CURRENT when active items have multiple observed warehouses", () => {
  assert.equal(evaluateSkuWarehouseRoutes(multiWarehouseFixture).alternatives.some((item) => item.mode === "KEEP_CURRENT"), false);
});

test("returns no selection when a move is required but no warehouses are allowlisted", () => {
  assert.equal(evaluateSkuWarehouseRoutes(emptyAllowlistFixture).selected, null);
});

test("normalizes warehouse scopes and comparison keys", () => {
  assert.equal(warehouseScope("  当前 仓 /1308  "), "当前 仓");
  assert.equal(warehouseKey("  当前 仓 /1308  "), "当前仓");
});
