import assert from "node:assert/strict";
import test from "node:test";

import { createUnavailableWarehouseControlPriceClient, isAllowedWarehouseBaseUrl, WarehouseControlPriceClient } from "../lib/shopee-discount/warehouse-client.mjs";
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

function relayPage({ rows = [sourceRow()], cursor = null, hasMore = false, watermark = WATERMARK } = {}) {
  return { ok: true, 产品: "控价", 行数: rows.length, 源最新: watermark, 游标: cursor, 还有更多: hasMore, rows };
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status });
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
    baseUrl: "http://10.110.80.95:8788",
    getKey: () => "super-secret-api-key",
    timeoutMs: 500,
    pageSize: 2,
    maxPages: 3,
    scale: 2,
    ...options,
  });
}

test("warehouse client allows the documented slow relay query window by default", () => {
  const service = new WarehouseControlPriceClient({
    fetchImpl: async () => jsonResponse({ ok: true }),
    baseUrl: "http://10.110.80.95:8788",
    getKey: () => "super-secret-api-key",
  });

  assert.equal(service.timeoutMs, 60_000);
  assert.equal(service.pageSize, 2_000);
});

test("warehouse prices use the selected site's minor-unit scale", async () => {
  const service = client([jsonResponse(relayPage({ rows: [sourceRow({
    "库存SKU": "ID-SKU",
    "国家": "ID",
    "大品类": "家具",
    "日常控价": 489000,
    "活动价": 484000,
    "大促价": 474000,
  })] }))]);

  const result = await service.scanPrices({
    country: "ID", category: "家具", skus: ["ID-SKU"], requestId: "req-id-minor-units",
  });

  assert.equal(result.status, "READY", JSON.stringify(result));
  assert.deepEqual(
    { daily: result.rows[0].dailyMinor, event: result.rows[0].eventMinor, mega: result.rows[0].megaMinor },
    { daily: "489000", event: "484000", mega: "474000" },
  );
});

test("approved warehouse control classifications are not mistaken for lifecycle statuses", async () => {
  const scan = await client([jsonResponse(relayPage({ rows: [sourceRow({ "控价状态": "引流款" })] }))])
    .scanPrices({ country: "SG", category: "FURNITURE", skus: ["00Ab-C_+"], requestId: "req-control-class" });
  const validated = validateWarehouseSnapshot(scan, null, policy(), { now: NOW });

  assert.equal(validated.status, "READY", JSON.stringify(validated));
  assert.equal(validated.rows[0].status, "引流款");
});

test("malformed unrelated warehouse rows do not block requested SKU validation", async () => {
  const requested = sourceRow({ "库存SKU": "REQUESTED" });
  const unrelated = sourceRow({ "库存SKU": "UNRELATED" });
  delete unrelated["活动价批准时间"];
  const result = await client([jsonResponse(relayPage({ rows: [unrelated, requested] }))], [], { pageSize: 10 })
    .scanPrices({ country: "SG", category: "FURNITURE", skus: ["REQUESTED"], requestId: "req-ignore-unrelated" });

  assert.equal(result.status, "READY", JSON.stringify(result));
  assert.deepEqual(result.rows.map(({ sku }) => sku), ["REQUESTED"]);
});

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

test("missing warehouse endpoint reports a specific configuration error during key verification", async () => {
  const service = createUnavailableWarehouseControlPriceClient();

  await assert.rejects(service.verifyKey({ requestId: "req-unconfigured" }), {
    code: "SHOPEE_DISCOUNT_WAREHOUSE_ENDPOINT_UNCONFIGURED",
    message: "未配置数仓控价接口地址",
  });
  assert.deepEqual(await service.scanPrices(), {
    status: "BLOCKED", code: "WAREHOUSE_UNAVAILABLE", rows: [], warnings: [], evidence: {},
  });
});

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
    jsonResponse(page({ rows: [sourceRow()] })),
    jsonResponse(page({ rows: [sourceRow({ "库存SKU": "  001-Z  " })] })),
  ], calls, { pageSize: 1 });

  assert.equal((await service.verifyKey({ requestId: "req-1" })).status, "READY");
  const result = await service.scanPrices({
    country: "SG", category: "FURNITURE", skus: [" 00Ab-C_+ ", "001-Z"], watermark: WATERMARK, requestId: "req-2",
  });

  assert.equal(result.status, "READY");
  assert.equal(result.rows.length, 2);
  assert.equal(calls[0].url, "http://10.110.80.95:8788/api/data/me");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "http://10.110.80.95:8788/api/data/query");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    产品: "控价", 参数: { 平台: "SHOPEE", 国家: "SG", 大品类: "FURNITURE", SKU: "00Ab-C_+" }, 页大小: 1,
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    产品: "控价", 参数: { 平台: "SHOPEE", 国家: "SG", 大品类: "FURNITURE", SKU: "001-Z" }, 页大小: 1,
  });
  for (const call of calls) {
    assert.equal(call.options.headers["X-Data-Key"], "super-secret-api-key");
    assert.ok(["req-1", "req-2"].includes(call.options.headers["x-request-id"]));
  }
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].options.headers["content-type"], "application/json; charset=utf-8");
});

test("client accepts only HTTPS or the exact documented private HTTP relay", () => {
  assert.equal(isAllowedWarehouseBaseUrl("https://warehouse.example/path"), true);
  assert.equal(isAllowedWarehouseBaseUrl("http://10.110.80.95:8788"), true);
  for (const rejected of ["http://10.110.80.95:8789", "http://warehouse.internal", "http://10.110.80.95:8788/extra"] ) {
    assert.equal(isAllowedWarehouseBaseUrl(rejected), false);
    assert.throws(() => client([], [], { baseUrl: rejected }), /approved HTTPS or private relay URL/);
  }
});

test("relay response uses top-level source freshness as the only normalized watermark", async () => {
  const row = sourceRow({ "数据水位": "2026-07-08T00:00:00.000Z" });
  const result = await client([jsonResponse(relayPage({ rows: [row] }))]).scanPrices({
    country: "SG", category: "FURNITURE", skus: ["00Ab-C_+"], requestId: "req-source-watermark",
  });
  assert.equal(result.status, "READY");
  assert.equal(result.evidence.watermark, WATERMARK);
  assert.equal(result.rows[0].watermark, WATERMARK);
});

test("relay read retries one 429 after the configured bounded delay", async () => {
  const calls = [];
  const delays = [];
  const service = client([
    jsonResponse({ error: "busy" }, { status: 429 }),
    jsonResponse({ role: "运营", products: ["控价"] }),
  ], calls, { retryDelaysMs: [0], sleep: async (delay) => { delays.push(delay); } });

  assert.equal((await service.verifyKey({ requestId: "req-rate-limit" })).status, "READY");
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [0]);
});

test("multi-SKU reads use exact SKU queries and reuse an exact request-scoped result", async () => {
  const calls = [];
  const service = client([
    jsonResponse(relayPage({ rows: [sourceRow({ "库存SKU": "A" })] })),
    jsonResponse(relayPage({ rows: [sourceRow({ "库存SKU": "B" })] })),
    jsonResponse(relayPage({ rows: [sourceRow({ "库存SKU": "C" })] })),
  ], calls, { pageSize: 10 });

  const first = await service.scanPrices({ country: "SG", category: "FURNITURE", skus: ["A", "B"], requestId: "req-preview-cache" });
  const second = await service.scanPrices({ country: "SG", category: "FURNITURE", skus: ["B", "C"], requestId: "req-preview-cache" });

  assert.deepEqual(first.rows.map(({ sku }) => sku), ["A", "B"]);
  assert.deepEqual(second.rows.map(({ sku }) => sku), ["B", "C"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => JSON.parse(call.options.body).参数.SKU), ["A", "B", "C"]);
});

test("client returns an unavailable block for request, timeout, non-2xx, and invalid JSON without exposing its key", async () => {
  const cases = [
    new Error("connection reset"),
    new DOMException("aborted", "AbortError"),
    jsonResponse({ error: "denied" }, { status: 401 }),
    new Response("not json"),
  ];
  for (const response of cases) {
    const result = await client([response]).scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-secret" });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.code, "WAREHOUSE_UNAVAILABLE");
    assert.equal(JSON.stringify(result).includes("super-secret-api-key"), false);
    assert.equal(result.rows.some((row) => row.warehouseResult === "VALIDATED_MISSING"), false);
  }
});

test("client rejects oversized bodies before full consumption or JSON parsing", async () => {
  let reads = 0;
  let cancelled = false;
  const chunks = [new TextEncoder().encode('{"rows":['), new Uint8Array(24).fill(32), new TextEncoder().encode("this third chunk must never be read")];
  const streamedResponse = {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            const value = chunks[reads];
            reads += 1;
            return value ? { done: false, value } : { done: true };
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    },
  };
  const streamed = await client([streamedResponse], [], { maxBodyBytes: 16 })
    .scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-stream-limit" });
  assert.equal(streamed.code, "WAREHOUSE_UNAVAILABLE");
  assert.equal(reads, 2);
  assert.equal(cancelled, true);

  let contentLengthBodyRead = false;
  const declaredOversized = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": "17" }),
    body: {
      async cancel() {},
      getReader() {
        contentLengthBodyRead = true;
        throw new Error("body must not be read");
      },
    },
  };
  const declared = await client([declaredOversized], [], { maxBodyBytes: 16 })
    .scanPrices({ country: "SG", skus: ["00Ab-C_+"], requestId: "req-content-length" });
  assert.equal(declared.code, "WAREHOUSE_UNAVAILABLE");
  assert.equal(contentLengthBodyRead, false);
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
  ], [], { pageSize: 1 }).scanPrices({ country: "SG", skus: ["00Ab-C_+", "001-Z"], requestId: "req-watermark" });
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

test("baseline anomaly comparison includes only rows in the complete current scan scope", () => {
  const baseline = { rows: [
    normalizedRow({ sku: "A" }),
    normalizedRow({ sku: "A", category: "LIGHTING" }),
    normalizedRow({ sku: "A", country: "MY" }),
    normalizedRow({ sku: "A", platform: "LAZADA" }),
    normalizedRow({ sku: "OUTSIDE-CHUNK" }),
  ] };
  const result = validateWarehouseSnapshot(snapshot([normalizedRow({ sku: "A" })], {
    evidence: { scope: { country: "SG", category: "FURNITURE", skus: ["A"] } },
  }), baseline, policy(), { now: NOW });
  assert.equal(result.status, "READY");
  assert.equal(result.evidence.baselineRowCount, 1);
  assert.equal(result.evidence.missingCount, 0);
});

test("independent validator rejects malformed approval timestamps while allowing null", () => {
  for (const timestampField of ["dailyApprovedAt", "eventApprovedAt", "megaApprovedAt"]) {
    for (const invalid of ["not-a-time", 123, "2026-07-10 00:00:00Z"]) {
      const rejected = validateWarehouseSnapshot(snapshot([
        normalizedRow({ [timestampField]: invalid }),
      ]), null, policy(), { now: NOW });
      assert.equal(rejected.code, "WAREHOUSE_SCHEMA_INVALID");
    }
  }
  const validNull = validateWarehouseSnapshot(snapshot([
    normalizedRow({ dailyMinor: null, dailyApprovedAt: null, eventApprovedAt: null, megaApprovedAt: null }),
  ]), null, policy(), { now: NOW });
  assert.equal(validNull.status, "READY");
  assert.equal(validNull.rows[0].warehouseResult, "VALIDATED_MISSING");
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
