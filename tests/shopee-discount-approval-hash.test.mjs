import assert from "node:assert/strict";
import test from "node:test";

import { buildApprovalRoot, buildApprovalRootFromShardHashes } from "../lib/shopee-discount/approval-hash.mjs";

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
    warehouse_approved_at: null,
    activity_type: "CURRENT_CORRECTION",
    target_discount_id: "900",
    renewal_discount_name: null,
    renewal_marker: null,
    renewal_price_tier: null,
    renewal_starts_at: null,
    renewal_ends_at: null,
    renewal_fingerprint: null,
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

test("approval V2 binds current targets, warehouse null transitions, and complete renewal identity", () => {
  const current = buildApprovalRoot([item()]);
  for (const changed of [
    item({ target_discount_id: "901" }),
    item({ warehouse_approved_at: "2026-08-13T08:00:00.000Z" }),
  ]) assert.notEqual(buildApprovalRoot([changed]).root, current.root);

  const renewal = item({
    activity_type: "NEXT_RENEWAL",
    target_discount_id: null,
    renewal_discount_name: "PM-TH-DAILY-2026-08-15-A1B2C3D4",
    renewal_marker: "PM-TH-DAILY-2026-08-15-A1B2C3D4",
    renewal_price_tier: "DAILY",
    renewal_starts_at: "2026-08-15T00:00:00.000Z",
    renewal_ends_at: "2026-09-14T00:00:00.000Z",
    renewal_fingerprint: "f".repeat(64),
  });
  const renewalRoot = buildApprovalRoot([renewal]).root;
  for (const field of ["renewal_discount_name", "renewal_marker", "renewal_price_tier", "renewal_starts_at", "renewal_ends_at", "renewal_fingerprint"]) {
    assert.notEqual(buildApprovalRoot([{ ...renewal, [field]: `${renewal[field]}-changed` }]).root, renewalRoot, field);
  }
});

test("approval merkle vectors duplicate an odd leaf and bind shard boundaries", () => {
  const alpha = item({ shop_id: "shop-b", item_id: "item-a", model_id: "model-a", sku: "A", warehouse_watermark: "v1" });
  const beta = item({ shop_id: "shop-a", item_id: "item-b", model_id: "model-b", sku: "B", warehouse_watermark: "v2" });
  const gamma = item({ shop_id: "shop-a", item_id: "item-a", model_id: "model-c", sku: "C", warehouse_watermark: "v3" });

  const odd = buildApprovalRoot([alpha, beta, gamma], { shardSize: 3 });
  assert.deepEqual(odd, {
    version: "SHOPEE_DISCOUNT_APPROVAL_V2",
    root: "3db9f860967316a6e71ccaea9f8cfbc9c40381f54ff6ee30977d29c9a5205bf2",
    shardHashes: ["b63d016b2383cc2746b83ba2368e7996c0ee322fde3bf5fbcbb279d076a14874"],
    itemCount: 3,
  });

  const sharded = buildApprovalRoot([alpha, beta, gamma], { shardSize: 2 });
  assert.deepEqual(sharded, {
    version: "SHOPEE_DISCOUNT_APPROVAL_V2",
    root: "41fec20fdc3c7328a466c1775606aedc6bab46624d9641a886a992faeab0d314",
    shardHashes: [
      "b7abf0b8a9993fce7ead3b57b9698253024554079033e1dd734e66bf62ebbfaa",
      "a579f2fc1d1dadef3d9699423f0e2f60a4aaf3d67fddd54a5430e814ab8d5e29",
    ],
    itemCount: 3,
  });
  assert.notEqual(sharded.root, odd.root);
});

test("a streamed shard accumulator reproduces the canonical approval root", () => {
  const built = buildApprovalRoot([
    item({ shop_id: "shop-b", item_id: "item-2", model_id: "model-2" }),
    item({ shop_id: "shop-a", item_id: "item-1", model_id: "model-1" }),
  ], { shardSize: 1 });
  assert.deepEqual(buildApprovalRootFromShardHashes(built.shardHashes, built.itemCount), built);
});
