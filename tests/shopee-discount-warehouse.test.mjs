import assert from "node:assert/strict";
import test from "node:test";

import { WarehouseControlPriceClient } from "../lib/shopee-discount/warehouse-client.mjs";
import { validateWarehouseSnapshot } from "../lib/shopee-discount/warehouse-validator.mjs";

const WATERMARK = "2026-07-09T00:00:00.000Z";
const NOW = new Date("2026-08-13T00:00:00.000Z");

function sourceRow(overrides = {}) {
  return {
    "库存SKU": "  00Ab-C_+ ",
    "国家": "SG",
    "大品类": "FURNITURE",
    "平台": "SHOPEE",
    "控价状态": "ACTIVE",
    "日常控价": "12.34",
    "日常控价批准时间": "2026-07-10T00:00:00.000Z",
    "活动价": "11.20",
    "活动价批准时间": "2026-07-11T00:00:00.000Z",
    "大促价": "10.05",
    "大促价批准时间": "2026-07-12T00:00:00.000Z",
    "数据水位": WATERMARK,
    ...overrides,
  };
}

function page({ rows = [sourceRow()], cursor = null, hasMore = false, watermark = WATERMARK, totalCount = rows.length } = {}) {
  return { rows, nextCursor: cursor, hasMore, watermark, totalCount };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function fetchSequence(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
}

function client(responses, calls = [], options = {}) {
  return new WarehouseControlPriceClient({
    fetchImpl: fetchSequence([...responses], calls),
    baseUrl: "https://warehouse.example/internal",
    getKey: () => "super-secret-api-key",
    timeoutMs: 500,
    pageSize: 2,
    maxPages: 3,
    scale: 2,
    ...options,
  });
}

function snapshot(rows, overrides = {}) {
  const { evidence: evidenceOverrides = {}, ...snapshotOverrides } = overrides;
  return {
    status: "READY",
    rows,
    evidence: {
      requestId: "req-validator",
      pageCount: 1,
      watermark: WATERMARK,
      scope: { country: "SG", category: "FURNITURE", skus: ["00Ab-C_+"] },
      ...evidenceOverrides,
    },
    ...snapshotOverrides,
  };
}

function normalizedRow(overrides = {}) {
  return {
    sku: "00Ab-C_+",
    country: "SG",
    category: "FURNITURE",
    platform: "SHOPEE",
    status: "ACTIVE",
    dailyMinor: "1234",
    eventMinor: "1120",
    megaMinor: "1005",
    dailyApprovedAt: "2026-07-10T00:00:00.000Z",
    eventApprovedAt: "2026-07-11T00:00:00.000Z",
    megaApprovedAt: "2026-07-12T00:00:00.000Z",
    watermark: WATERMARK,
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    tier: "DAILY",
    maxMissingCount: 0,
    maxMissingRatio: 0,
    ...overrides,
  };
}

test("client sends fixed verification and scan endpoints with the request id and secret only in its configured header", async () => {
  const calls = [];
  const service = client([
    jsonResponse({ ok: true }),
    jsonResponse(page({ rows: [sourceRow()], cursor: "c-2", hasMore: true, totalCount: 2 })),
    jsonResponse(page({ rows: [sourceRow({ "库存SKU": "  001-Z  " })], totalCount: 2 })),
  ], calls);

  assert.equal((await service.verifyKey({ requestId: "req-1" })).status, "READY");
  const result = await service.scanPrices({
    country: "SG", category: "FURNITURE", skus: [" 00Ab-C_+ ", "001-Z"], watermark: WATERMARK, requestId: "req-2",
  });

  assert.equal(result.status, "READY");
  assert.equal(result.rows.length, 2);
  assert.equal(calls[0].url, "https://warehouse.example/internal/control-prices/verify-key");
  assert.equal(calls[1].url, "https://warehouse.example/internal/control-prices/scan?platform=SHOPEE&country=SG&category=FURNITURE&skus=00Ab-C_%2B%2C001-Z&watermark=2026-07-09T00%3A00%3A00.000Z&limit=2");
  assert.match(calls[2].url, /cursor=c-2/);
  for (const call of calls) {
    assert.equal(call.options.headers["x-api-key"], "super-secret-api-key");
    assert.ok(["req-1", "req-2"].includes(call.options.headers["x-request-id"]));
    assert.equal(call.options.body, undefined);
  }
});

test("client returns an unavailable block for request, timeout, non-2xx, and invalid JSON without exposing its key", async () => {
  const cases = [
    new Error("connection reset"),
    new DOMException("aborted", "AbortError"),
    jsonResponse({ error: "denied" }, { status: 401 }),
    { ok: true, status: 200, text: async () => "not json" },
  ];
  for (const response of cases) {
    const result = await client([response]).scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-secret" });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.code, "WAREHOUSE_UNAVAILABLE");
    assert.equal(JSON.stringify(result).includes("super-secret-api-key"), false);
    assert.equal(result.rows.some((row) => row.warehouseResult === "VALIDATED_MISSING"), false);
  }
});

test("client distinguishes invalid response schema from an empty successful scan", async () => {
  const invalid = await client([jsonResponse({ rows: "not-an-array", hasMore: false, watermark: WATERMARK, totalCount: 0 })])
    .scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-schema" });
  assert.equal(invalid.code, "WAREHOUSE_SCHEMA_INVALID");

  const empty = await client([jsonResponse(page({ rows: [] }))])
    .scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-empty" });
  assert.equal(empty.status, "READY");
  assert.deepEqual(empty.rows, []);
});

test("complete scans normalize the documented Chinese aliases and decimal money without number arithmetic", async () => {
  const result = await client([jsonResponse(page())]).scanPrices({
    country: "SG", category: "FURNITURE", skus: ["00Ab-C_+"], requestId: "req-normalize",
  });
  assert.deepEqual(result.rows, [normalizedRow()]);
});

test("pagination blocks repeated cursors, missing continuation cursors, max-page exhaustion, and count mismatches", async () => {
  const repeated = await client([
    jsonResponse(page({ cursor: "same", hasMore: true, totalCount: 3 })),
    jsonResponse(page({ cursor: "same", hasMore: true, totalCount: 3 })),
  ]).scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-repeat" });
  assert.equal(repeated.code, "WAREHOUSE_PAGINATION_INCOMPLETE");

  const noCursor = await client([jsonResponse(page({ cursor: null, hasMore: true, totalCount: 1 }))])
    .scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-nocursor" });
  assert.equal(noCursor.code, "WAREHOUSE_PAGINATION_INCOMPLETE");

  const maxPages = await client([
    jsonResponse(page({ cursor: "2", hasMore: true, totalCount: 4 })),
    jsonResponse(page({ cursor: "3", hasMore: true, totalCount: 4 })),
  ], [], { maxPages: 2 }).scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-max" });
  assert.equal(maxPages.code, "WAREHOUSE_PAGINATION_INCOMPLETE");

  const mismatch = await client([jsonResponse(page({ totalCount: 2 }))])
    .scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-count" });
  assert.equal(mismatch.code, "WAREHOUSE_PAGINATION_INCOMPLETE");
});

test("a changing page watermark blocks the scan before it can be treated as missing data", async () => {
  const result = await client([
    jsonResponse(page({ cursor: "2", hasMore: true, totalCount: 2 })),
    jsonResponse(page({ rows: [sourceRow({ "库存SKU": "001-Z", "数据水位": "2026-07-10T00:00:00.000Z" })], watermark: "2026-07-10T00:00:00.000Z", totalCount: 2 })),
  ]).scanPrices({ country: "SG", skus: ["00Ab-C_+", "001-Z"], requestId: "req-watermark" });
  assert.equal(result.code, "WAREHOUSE_WATERMARK_CHANGED");
});

test("scope mismatches from a successful response are blocked rather than filtered away", async () => {
  for (const changes of [
    { "平台": "LAZADA" },
    { "国家": "MY" },
    { "大品类": "ELECTRONICS" },
  ]) {
    const result = await client([jsonResponse(page({ rows: [sourceRow(changes)] }))])
      .scanPrices({ country: "SG", category: "FURNITURE", skus: ["00Ab-C_+"], requestId: "req-scope" });
    assert.equal(result.code, "WAREHOUSE_SCOPE_MISMATCH");
  }
});

test("validator blocks exact and conflicting country-SKU-platform duplicates instead of silently choosing a row", () => {
  const original = normalizedRow();
  for (const duplicate of [original, normalizedRow({ dailyMinor: "999" })]) {
    const result = validateWarehouseSnapshot(snapshot([original, duplicate]), null, policy(), { now: NOW });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.code, "WAREHOUSE_DUPLICATE_SKU");
  }
});

test("a watermark exactly 35 days old is allowed and an older watermark is blocked", () => {
  const exact = validateWarehouseSnapshot(snapshot([normalizedRow({ watermark: "2026-07-09T00:00:00.000Z" })], {
    evidence: { watermark: "2026-07-09T00:00:00.000Z" },
  }), null, policy(), { now: NOW });
  assert.equal(exact.status, "READY");

  const stale = validateWarehouseSnapshot(snapshot([normalizedRow({ watermark: "2026-07-08T23:59:59.999Z" })], {
    evidence: { watermark: "2026-07-08T23:59:59.999Z" },
  }), null, policy(), { now: NOW });
  assert.equal(stale.code, "WAREHOUSE_WATERMARK_STALE");
});

test("old selected-tier approvals warn per SKU and warn the batch when more than twenty percent are old", () => {
  const rows = [
    normalizedRow({ sku: "A", dailyApprovedAt: "2026-07-08T23:59:59.999Z" }),
    normalizedRow({ sku: "B", dailyApprovedAt: "2026-07-10T00:00:00.000Z" }),
    normalizedRow({ sku: "C", dailyApprovedAt: "2026-07-10T00:00:00.000Z" }),
    normalizedRow({ sku: "D", dailyApprovedAt: "2026-07-10T00:00:00.000Z" }),
  ];
  const result = validateWarehouseSnapshot(snapshot(rows, { evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["A", "B", "C", "D"] } } }), null, policy(), { now: NOW });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["WAREHOUSE_APPROVAL_STALE", "WAREHOUSE_APPROVAL_STALE_RATIO"]);
  assert.equal(result.warnings[0].sku, "A");
});

test("empty and sharply missing scans compare to the last successful baseline with explicit thresholds and zero-default tolerance", () => {
  const baseline = { rows: [normalizedRow({ sku: "A" }), normalizedRow({ sku: "B" }), normalizedRow({ sku: "C" })] };
  const empty = validateWarehouseSnapshot(snapshot([], { evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["A", "B", "C"] } } }), baseline, policy(), { now: NOW });
  assert.equal(empty.code, "WAREHOUSE_EMPTY_ANOMALY");

  const atBoundary = validateWarehouseSnapshot(snapshot([normalizedRow({ sku: "A" }), normalizedRow({ sku: "B" })], {
    evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["A", "B", "C"] } },
  }), baseline, policy({ maxMissingCount: 1, maxMissingRatio: 1 / 3 }), { now: NOW });
  assert.equal(atBoundary.status, "READY");

  const aboveBoundary = validateWarehouseSnapshot(snapshot([normalizedRow({ sku: "A" })], {
    evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["A", "B", "C"] } },
  }), baseline, policy({ maxMissingCount: 1, maxMissingRatio: 1 / 3 }), { now: NOW });
  assert.equal(aboveBoundary.code, "WAREHOUSE_EMPTY_ANOMALY");

  const defaultTolerance = validateWarehouseSnapshot(snapshot([normalizedRow({ sku: "A" }), normalizedRow({ sku: "B" })], {
    evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["A", "B", "C"] } },
  }), baseline, { tier: "DAILY" }, { now: NOW });
  assert.equal(defaultTolerance.code, "WAREHOUSE_EMPTY_ANOMALY");
});

test("a missing or zero selected tier becomes validated missing only after every warehouse gate passes", () => {
  const ready = validateWarehouseSnapshot(snapshot([
    normalizedRow({ sku: "NO-PRICE", dailyMinor: null, dailyApprovedAt: null }),
    normalizedRow({ sku: "ZERO", dailyMinor: "0" }),
  ], { evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["NO-PRICE", "ZERO"] } } }), null, policy(), { now: NOW });
  assert.equal(ready.status, "READY");
  assert.deepEqual(ready.rows.map((row) => row.warehouseResult), ["VALIDATED_MISSING", "VALIDATED_MISSING"]);

  const unavailable = validateWarehouseSnapshot({ status: "BLOCKED", code: "WAREHOUSE_UNAVAILABLE", rows: [], evidence: {} }, null, policy(), { now: NOW });
  assert.equal(unavailable.status, "BLOCKED");
  assert.equal(unavailable.code, "WAREHOUSE_UNAVAILABLE");
  assert.equal(unavailable.rows.length, 0);
});

test("validator preserves a client pagination block and measures stale approval ratio over selected prices", () => {
  const inherited = validateWarehouseSnapshot({ status: "BLOCKED", code: "WAREHOUSE_PAGINATION_INCOMPLETE", rows: [], evidence: {} }, null, policy(), { now: NOW });
  assert.equal(inherited.code, "WAREHOUSE_PAGINATION_INCOMPLETE");

  const selectedAndMissing = validateWarehouseSnapshot(snapshot([
    normalizedRow({ sku: "STALE", dailyApprovedAt: "2026-07-08T23:59:59.999Z" }),
    normalizedRow({ sku: "MISSING-1", dailyMinor: null, dailyApprovedAt: null }),
    normalizedRow({ sku: "MISSING-2", dailyMinor: null, dailyApprovedAt: null }),
    normalizedRow({ sku: "MISSING-3", dailyMinor: null, dailyApprovedAt: null }),
    normalizedRow({ sku: "MISSING-4", dailyMinor: null, dailyApprovedAt: null }),
  ], { evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["STALE", "MISSING-1", "MISSING-2", "MISSING-3", "MISSING-4"] } } }), null, policy(), { now: NOW });
  assert.deepEqual(selectedAndMissing.warnings.map((warning) => warning.code), ["WAREHOUSE_APPROVAL_STALE", "WAREHOUSE_APPROVAL_STALE_RATIO"]);
});
