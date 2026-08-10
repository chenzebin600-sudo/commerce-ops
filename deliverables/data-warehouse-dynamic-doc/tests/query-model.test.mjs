import test from "node:test";
import assert from "node:assert/strict";
import * as queryModel from "../shared/query-model.mjs";
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

test("rejects inherited product names without throwing", () => {
  assert.deepEqual(buildQueryRequest({
    product: "__proto__",
    pageSize: 500,
    params: {},
  }), {
    ok: false,
    errors: ["产品无效"],
  });
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

test("merges later pages without mutating earlier state", () => {
  const first = mergeResultPage(emptyResultState(), { rows: [{ id: 1 }], 游标: "a", 还有更多: true });
  const second = mergeResultPage(first, { rows: [{ id: 2 }], 游标: null, 还有更多: false });
  assert.deepEqual(first.rows, [{ id: 1 }]);
  assert.deepEqual(second.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(second.hasMore, false);
});

test("a fresh empty state has no rows, cursor, or metadata", () => {
  assert.deepEqual(emptyResultState(), { rows: [], cursor: null, hasMore: false, meta: null });
});

test("fails closed when catalog enablement is not boolean", () => {
  for (const enabled of ["false", 0, null]) {
    assert.deepEqual(queryModel.readCatalog?.({
      products: [{ name: "库存", enabled, params: ["国家", "大品类", "SKU", "款号", "只看有货"] }],
    }), {
      valid: false,
      enabledProducts: ["日销", "库存", "产品包", "控价"],
      mismatches: new Set(["日销", "库存", "产品包", "控价"]),
    });
  }
});

test("preserves successful query row keys and values losslessly", () => {
  const unrelatedKey = ["zndr", "not-the-active-key"].join("_");
  const page = {
    rows: [{ " spaced key ": "  spaced value  ", exact: unrelatedKey, amount: 9007199254740991 }],
    游标: " opaque cursor \t",
    还有更多: true,
  };
  const validated = queryModel.validateResultPage?.(page);
  assert.equal(validated, page);
  assert.deepEqual(validated.rows, page.rows);
});

test("redacts only the exact active key from display and export rows", () => {
  const activeKey = ["zndr", "active-secret"].join("_");
  const unrelatedKey = ["zndr", "other-secret"].join("_");
  const rows = [{ note: `before ${activeKey} after`, unrelated: unrelatedKey, whitespace: "  keep  " }];
  assert.deepEqual(queryModel.rowsForOutput?.(rows, activeKey), [{
    note: "before [已隐藏] after",
    unrelated: unrelatedKey,
    whitespace: "  keep  ",
  }]);
  assert.deepEqual(rows, [{ note: `before ${activeKey} after`, unrelated: unrelatedKey, whitespace: "  keep  " }]);
});

test("preserves a non-empty opaque cursor byte-for-byte", () => {
  assert.deepEqual(buildQueryRequest({
    product: "库存",
    params: {},
    pageSize: 500,
    cursor: " opaque cursor \t",
  }), {
    ok: true,
    value: { 产品: "库存", 参数: {}, 页大小: 500, 游标: " opaque cursor \t" },
  });
});

test("rejects a whitespace-only next-page cursor", () => {
  const result = buildQueryRequest({ product: "库存", params: {}, pageSize: 500, cursor: "   " });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /游标/);
});

test("accepts every page size through 2000 and rejects values above it", () => {
  assert.equal(buildQueryRequest({ product: "库存", params: {}, pageSize: 501 }).ok, true);
  assert.equal(buildQueryRequest({ product: "库存", params: {}, pageSize: 2000 }).ok, true);
  const tooLarge = buildQueryRequest({ product: "库存", params: {}, pageSize: 2001 });
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.errors.join("\n"), /2000/);
});

test("switching products resets results and the pagination query", () => {
  const result = mergeResultPage(emptyResultState(), {
    rows: [{ id: 1 }], 游标: "next", 还有更多: true,
  });
  assert.deepEqual(queryModel.productSwitch?.("库存", "控价", result, {
    产品: "库存", 参数: {}, 页大小: 500,
  }), {
    product: "控价",
    result: emptyResultState(),
    currentQuery: null,
  });
});

test("successful export clears the error before rerendering", () => {
  const state = { error: "旧错误" };
  const renderedErrors = [];
  queryModel.completeSuccessfulExport?.(state, () => renderedErrors.push(state.error));
  assert.equal(state.error, null);
  assert.deepEqual(renderedErrors, [null]);
});
