import assert from "node:assert/strict";
import test from "node:test";
import { createProductionReaders } from "../lib/shopee-discount/production-runtime.mjs";

function shopeeFixture() {
  const details = {
    "900": { discount_id: "900", discount_name: "DAILY", start_time: "1", end_time: "2", more: false, item_list: [{ item_id: "10", model_list: [{ model_id: "100", model_promotion_price: "90.01" }] }] },
    "901": { discount_id: "901", discount_name: "OTHER", start_time: "1", end_time: "2", more: false, item_list: [{ item_id: "10", model_list: [{ model_id: "100", model_promotion_price: "89.00" }] }] },
  };
  return {
    async listShops() { return { data: { shops: [{ shop_id: "1", authorized: true }] } }; },
    async getItemBaseInfo() { return { data: { item_list: [{ item_id: "10", item_status: "NORMAL", item_sku: "BASE" }] } }; },
    async getModelList() { return { data: { model: [{ model_id: "100", model_sku: "SKU", original_price: "100.00" }] } }; },
    async listDiscounts() { return { data: { discount_list: [{ discount_id: "900" }, { discount_id: "901" }], more: false } }; },
    async getDiscount({ discountId }) { return { data: details[discountId] }; },
  };
}

test("production readers derive listing and readback money from official responses and detect overlap", async () => {
  const readers = createProductionReaders({ shopee: shopeeFixture(), warehouse: { async scanPrices() { return { rows: [] }; } } });
  const item = { shopId: "1", itemId: "10", modelId: "100", sku: "SKU", scale: 2, targetPriceMinor: "9000" };
  assert.deepEqual(await readers.getListingState({ item, requestId: "reader-1" }), { status: "ACTIVE", sku: "SKU", originalPriceMinor: "10000" });
  const activity = { shopId: "1", platformActivityId: "900", startsAt: "1970-01-01T00:00:01.000Z", endsAt: "1970-01-01T00:00:02.000Z", metadata: { discountName: "DAILY", marker: "DAILY", fingerprint: "fingerprint" } };
  assert.equal((await readers.getDiscountState({ item, activity, requestId: "reader-2" })).conflict, true);
  const readback = await readers.readbackIntent({ intent: { operationUuid: "00000000-0000-4000-8000-000000000001", payloadHash: "hash" }, item, activity, requestId: "reader-3" });
  assert.equal(readback.priceMinor, "9001");
  assert.equal(readback.markerVerified, true);
});

test("production readback never substitutes the approved target for missing official price", async () => {
  const shopee = shopeeFixture();
  shopee.getDiscount = async () => ({ data: { discount_id: "900", discount_name: "DAILY", start_time: "1", end_time: "2", more: false, item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }] } });
  const readers = createProductionReaders({ shopee, warehouse: { async scanPrices() { return { rows: [] }; } } });
  const item = { shopId: "1", itemId: "10", modelId: "100", sku: "SKU", scale: 2, targetPriceMinor: "9000" };
  const activity = { shopId: "1", platformActivityId: "900", startsAt: "1970-01-01T00:00:01.000Z", endsAt: "1970-01-01T00:00:02.000Z", metadata: { discountName: "DAILY", marker: "DAILY", fingerprint: "fingerprint" } };
  const result = await readers.readbackIntent({ intent: { operationUuid: "00000000-0000-4000-8000-000000000001", payloadHash: "hash" }, item, activity, requestId: "reader-4" });
  assert.equal(result.priceMinor, null);
});
