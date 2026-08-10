import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQueryRequest,
  emptyResultState,
  mergeResultPage,
  PRODUCTS,
  validateKey,
  validateQueryPayload,
} from "../shared/query-model.mjs";

test("exposes immutable product definitions", () => {
  assert.equal(Object.isFrozen(PRODUCTS), true);
  assert.equal(Object.isFrozen(PRODUCTS.日销), true);
  assert.equal(Object.isFrozen(PRODUCTS.日销.required), true);
});

test("accepts a valid narrowed daily-sales query", () => {
  assert.deepEqual(buildQueryRequest({
    product: "日销",
    pageSize: 500,
    params: { 开始: "2026-08-01", 结束: "2026-08-09", 国家: "MY", 店编: "" },
  }), {
    ok: true,
    value: { 产品: "日销", 参数: { 开始: "2026-08-01", 结束: "2026-08-09", 国家: "MY" }, 页大小: 500 },
  });
});

test("rejects a daily-sales window longer than 92 inclusive days", () => {
  const result = buildQueryRequest({
    product: "日销",
    pageSize: 500,
    params: { 开始: "2026-01-01", 结束: "2026-04-03" },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /92/);
});

test("rejects unknown fields and invalid enum values", () => {
  const result = buildQueryRequest({
    product: "控价",
    pageSize: 500,
    params: { 平台: "AMAZON", 国家: "US", sql: "select 1" },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /平台|国家|参数/);
});

test("validates the data-key prefix without returning the key", () => {
  assert.deepEqual(validateKey(["zndr", "example123"].join("_")), { ok: true });
  assert.equal(validateKey("zntk_wrong").ok, false);
});

test("rejects forbidden top-level API fields", () => {
  const result = validateQueryPayload({ 产品: "库存", 参数: {}, 页大小: 500, sql: "select 1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /顶层字段/);
});

test("appends a page and retains server metadata", () => {
  const next = mergeResultPage(emptyResultState(), {
    产品: "库存", 角色: "储高", 行数: 1, 耗时ms: 12,
    范围版本: "v1", 水位: "2026-08-10 07:06:24",
    游标: "opaque", 还有更多: true, rows: [{ stock_sku: "A1" }],
  });
  assert.deepEqual(next.rows, [{ stock_sku: "A1" }]);
  assert.equal(next.cursor, "opaque");
  assert.equal(next.hasMore, true);
  assert.equal(next.meta.product, "库存");
});
