import assert from "node:assert/strict";
import test from "node:test";

import { buildApprovalRoot } from "../lib/shopee-discount/approval-hash.mjs";

function item(overrides = {}) {
  return {
    shop_id: "shop-a",
    item_id: "item-1",
    model_id: "model-1",
    country: "TH",
    sku: "SKU 01",
    original_minor: "1000",
    target_minor: "900",
    price_source: "WAREHOUSE",
    price_tier: "DAILY",
    rule_source: "COUNTRY_DEFAULT",
    warehouse_watermark: "warehouse-v1",
    ...overrides,
  };
}

test("approval root is stable across input order and mutable execution evidence", () => {
  const first = item({ item_id: "item-2", model_id: "model-2", sku: "ß SKU" });
  const second = item({ item_id: "item-1", model_id: "model-1", execution_status: "FAILED", attempts: 4 });
  const reordered = [
    { ...second, execution_status: "SUCCEEDED", attempts: 1, platform_response: { id: "x" }, readback: "900", message: "ignored" },
    first,
  ];
  assert.deepEqual(buildApprovalRoot([first, second]), buildApprovalRoot(reordered));
});

test("approval hashing rejects duplicate immutable identity keys and missing immutable fields", () => {
  assert.throws(() => buildApprovalRoot([item(), item({ sku: "another SKU" })]), /duplicate/i);
  const missing = item();
  delete missing.warehouse_watermark;
  assert.throws(() => buildApprovalRoot([missing]), /warehouse_watermark/i);
});

test("approval merkle vectors duplicate an odd leaf and bind shard boundaries", () => {
  const alpha = item({ shop_id: "shop-b", item_id: "item-a", model_id: "model-a", sku: "A", warehouse_watermark: "v1" });
  const beta = item({ shop_id: "shop-a", item_id: "item-b", model_id: "model-b", sku: "B", warehouse_watermark: "v2" });
  const gamma = item({ shop_id: "shop-a", item_id: "item-a", model_id: "model-c", sku: "C", warehouse_watermark: "v3" });

  const odd = buildApprovalRoot([alpha, beta, gamma], { shardSize: 3 });
  assert.deepEqual(odd, {
    version: "SHOPEE_DISCOUNT_APPROVAL_V1",
    root: "8bb86c28c8a960196565e59d678bef6b74d0368b08d1a1cb71742f6224ec4357",
    shardHashes: ["41776a5f27a8dfc5d72a3f293ba145410851353e4ac77731a8a134cdc90065f6"],
    itemCount: 3,
  });

  const sharded = buildApprovalRoot([alpha, beta, gamma], { shardSize: 2 });
  assert.deepEqual(sharded, {
    version: "SHOPEE_DISCOUNT_APPROVAL_V1",
    root: "3ef3a83ad24b5db0171b0305fdff2663808399cc0295b95b1a8ed2cf9af4221b",
    shardHashes: [
      "1064c012fa5a222099a7aca283af47ea87a52e237278731c975c72bf71b86ae4",
      "ac430c607a31be6fdeca4da42cf9db76ea5f7864142e30aef0821532185bfd49",
    ],
    itemCount: 3,
  });
  assert.notEqual(sharded.root, odd.root);
});
