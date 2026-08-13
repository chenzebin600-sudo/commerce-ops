import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeReadAdapter } from "../lib/shopee-discount/shopee-read-adapter.mjs";
import { ShopeeWriteAdapter } from "../lib/shopee-discount/shopee-write-adapter.mjs";

const REQUEST_ID = "req-task-4";
const OPERATION_UUID = "11111111-1111-4111-8111-111111111111";

function successfulPlatformPayload(response = {}) {
  return {
    status: 200,
    body: {
      ok: true,
      data: {
        error: "",
        message: "",
        warning: "",
        request_id: "shopee-request-1",
        response,
      },
    },
  };
}

test("Shopee read adapter binds every public operation to its fixed relay contract", async () => {
  const calls = [];
  const responses = [
    { status: 200, body: { shops: [{ shop_id: 1768286475, country: "SG" }] } },
    successfulPlatformPayload({ item: [{ item_id: 2500139861, item_status: "NORMAL", update_time: 1608128470 }], total_count: 1, has_next_page: false, next_offset: 0 }),
    successfulPlatformPayload({ item_list: [{ item_id: 34002, item_name: "seller discount", item_sku: "SKU-1", price_info: [{ currency: "SGD", original_price: 122.02, current_price: 122.02 }] }] }),
    successfulPlatformPayload({ tier_variation: [], model: [{ model_id: 1776782, model_sku: "blue bag", model_status: "MODEL_NORMAL", price_info: [{ currency: "SGD", original_price: 100, current_price: 100 }] }] }),
    successfulPlatformPayload({ discount_list: [{ status: "ongoing", discount_name: "testqwert001", start_time: 1644910200, discount_id: 1000021581, source: 0, end_time: 1645864200 }], more: false }),
    successfulPlatformPayload({ status: "ongoing", discount_name: "test-upload-keep", item_list: [], start_time: 1604408400, discount_id: 1000029882, end_time: 1605276000, more: false }),
  ];
  const adapter = new ShopeeReadAdapter({
    transport: async (request) => {
      calls.push(request);
      return responses[calls.length - 1];
    },
  });

  const results = [
    await adapter.listShops({ requestId: REQUEST_ID }),
    await adapter.listActiveItems({ shopId: "1768286475", cursor: "0", pageSize: 250, requestId: REQUEST_ID }),
    await adapter.getItemBaseInfo({ shopId: "1768286475", itemIds: ["34001", "34002"], requestId: REQUEST_ID }),
    await adapter.getModelList({ shopId: "1768286475", itemId: "178312", requestId: REQUEST_ID }),
    await adapter.listDiscounts({ shopId: "1768286475", status: "ongoing", pageNo: 1, pageSize: 250, updatedFrom: "1643860467", updatedTo: "1646020467", requestId: REQUEST_ID }),
    await adapter.getDiscount({ shopId: "1768286475", discountId: "1000029882", pageNo: 1, pageSize: 50, requestId: REQUEST_ID }),
  ];

  assert.deepEqual(calls, [
    { relayPath: "/api/token/shops", relayMethod: "GET", requestId: REQUEST_ID },
    { relayPath: "/api/shopee/call", relayMethod: "POST", requestId: REQUEST_ID, body: { shop_id: "1768286475", api_path: "/api/v2/product/get_item_list", method: "GET", params: { offset: "0", page_size: 100, item_status: ["NORMAL"] } } },
    { relayPath: "/api/shopee/call", relayMethod: "POST", requestId: REQUEST_ID, body: { shop_id: "1768286475", api_path: "/api/v2/product/get_item_base_info", method: "GET", params: { item_id_list: ["34001", "34002"] } } },
    { relayPath: "/api/shopee/call", relayMethod: "POST", requestId: REQUEST_ID, body: { shop_id: "1768286475", api_path: "/api/v2/product/get_model_list", method: "GET", params: { item_id: "178312" } } },
    { relayPath: "/api/shopee/call", relayMethod: "POST", requestId: REQUEST_ID, body: { shop_id: "1768286475", api_path: "/api/v2/discount/get_discount_list", method: "GET", params: { discount_status: "ongoing", page_no: 1, page_size: 100, update_time_from: "1643860467", update_time_to: "1646020467" } } },
    { relayPath: "/api/shopee/call", relayMethod: "POST", requestId: REQUEST_ID, body: { shop_id: "1768286475", api_path: "/api/v2/discount/get_discount", method: "GET", params: { discount_id: "1000029882", page_no: 1, page_size: 50 } } },
  ]);
  assert.deepEqual(results[0], { data: { shops: [{ shop_id: 1768286475, country: "SG" }] }, requestId: REQUEST_ID, attempts: 1 });
  assert.deepEqual(results[1], { data: responses[1].body.data.response, requestId: "shopee-request-1", attempts: 1 });
});

test("Shopee read adapter exposes no arbitrary relay-call method", () => {
  const adapter = new ShopeeReadAdapter({ transport: async () => successfulPlatformPayload() });
  assert.equal(adapter.call, undefined);
  assert.equal(adapter.request, undefined);
});

test("Shopee read adapter rejects empty, oversized, and duplicate base-info ID batches before dispatch", async () => {
  let calls = 0;
  const adapter = new ShopeeReadAdapter({ transport: async () => { calls += 1; } });
  const batches = [[], Array.from({ length: 51 }, (_, index) => String(index + 1)), ["34001", "34001"]];
  for (const itemIds of batches) {
    await assert.rejects(
      adapter.getItemBaseInfo({ shopId: "1768286475", itemIds, requestId: REQUEST_ID }),
      (error) => error.code === "SHOPEE_INPUT_INVALID",
    );
  }
  assert.equal(calls, 0);
});

test("Shopee read adapter rejects caller-supplied routing fields on every fixed method", async () => {
  let calls = 0;
  const adapter = new ShopeeReadAdapter({ transport: async () => { calls += 1; } });
  const inputs = [
    () => adapter.listShops({ requestId: REQUEST_ID, apiPath: "/api/v2/discount/add_discount" }),
    () => adapter.listActiveItems({ shopId: "1", cursor: "0", pageSize: 1, requestId: REQUEST_ID, method: "POST" }),
    () => adapter.getItemBaseInfo({ shopId: "1", itemIds: ["2"], requestId: REQUEST_ID, params: { unsafe: true } }),
    () => adapter.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID, tokenKey: "must-not-be-accepted" }),
    () => adapter.listDiscounts({ shopId: "1", status: "all", pageNo: 1, pageSize: 1, requestId: REQUEST_ID, retryCount: 10 }),
    () => adapter.getDiscount({ shopId: "1", discountId: "2", pageNo: 1, pageSize: 1, requestId: REQUEST_ID, api_path: "/api/v2/discount/add_discount" }),
  ];
  for (const invoke of inputs) {
    await assert.rejects(invoke, (error) => error.code === "SHOPEE_INPUT_INVALID");
  }
  assert.equal(calls, 0);
});

test("Shopee read adapter applies injected bounded retries only to safe transient GET failures", async () => {
  const calls = [];
  const sleeps = [];
  const adapter = new ShopeeReadAdapter({
    retryPolicy: { maxAttempts: 3, delaysMs: [5, 10] },
    sleep: async (delay) => { sleeps.push(delay); },
    transport: async (request) => {
      calls.push(request);
      if (calls.length === 1) return { status: 429, body: { error: "rate_limit", message: "too many requests", request_id: "relay-rate-1" } };
      if (calls.length === 2) {
        const error = new Error("socket reset");
        error.code = "ECONNRESET";
        throw error;
      }
      return successfulPlatformPayload({ item: [], total_count: 0, has_next_page: false, next_offset: 0 });
    },
  });

  const result = await adapter.listActiveItems({ shopId: "1", cursor: "0", pageSize: 100, requestId: REQUEST_ID });
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [5, 10]);
});

test("Shopee read adapter retries documented platform transient codes before generic business classification", async () => {
  for (const [platformCode, stableCode] of [["error_limit", "SHOPEE_RATE_LIMITED"], ["error_network", "SHOPEE_UNAVAILABLE"], ["error_server", "SHOPEE_UNAVAILABLE"], ["error_inner", "SHOPEE_UNAVAILABLE"], ["error_system_busy", "SHOPEE_UNAVAILABLE"]]) {
    let calls = 0;
    const adapter = new ShopeeReadAdapter({
      retryPolicy: { maxAttempts: 2, delaysMs: [0] },
      sleep: async () => undefined,
      transport: async () => {
        calls += 1;
        if (calls === 1) return { status: 200, body: { ok: true, data: { error: platformCode, message: "technical", request_id: "platform-transient", response: {} } } };
        return successfulPlatformPayload({ model: [], tier_variation: [] });
      },
    });
    const result = await adapter.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID });
    assert.equal(result.attempts, 2, `${platformCode} -> ${stableCode}`);
    assert.equal(calls, 2);
  }
});

test("read technical codes take precedence over auth-like message text and remain retryable", async () => {
  for (const platformCode of ["error_server", "error_network"]) {
    let calls = 0;
    const adapter = new ShopeeReadAdapter({
      retryPolicy: { maxAttempts: 2, delaysMs: [0] },
      sleep: async () => undefined,
      transport: async () => {
        calls += 1;
        if (calls === 1) return { status: 200, body: { ok: true, data: { error: platformCode, message: "auth token service failed", request_id: "read-precedence", response: {} } } };
        return successfulPlatformPayload({ model: [], tier_variation: [] });
      },
    });
    assert.equal((await adapter.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID })).attempts, 2);
  }
});

test("read valid HTTP auth status takes precedence even when the body is malformed", async () => {
  for (const status of [401, 403]) {
    const adapter = new ShopeeReadAdapter({ transport: async () => ({ status, body: "not-json" }) });
    await assert.rejects(adapter.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID }), (error) => error.code === "SHOPEE_AUTH_ERROR");
  }
});

test("known read business code takes precedence over auth and rate message heuristics", async () => {
  let calls = 0;
  const adapter = new ShopeeReadAdapter({
    retryPolicy: { maxAttempts: 2, delaysMs: [0] },
    sleep: async () => undefined,
    transport: async () => {
      calls += 1;
      return { status: 200, body: { ok: true, data: { error: "discount.error_time", message: "auth token rate limit wording", request_id: "known-business", response: {} } } };
    },
  });
  await assert.rejects(adapter.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID }), (error) => error.code === "SHOPEE_BUSINESS_ERROR");
  assert.equal(calls, 1);
});

test("Shopee read adapter does not retry an unclassified transport failure", async () => {
  let calls = 0;
  const adapter = new ShopeeReadAdapter({
    retryPolicy: { maxAttempts: 3, delaysMs: [0, 0] },
    sleep: async () => undefined,
    transport: async () => { calls += 1; throw new TypeError("transport contract bug"); },
  });
  await assert.rejects(
    adapter.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID }),
    (error) => error.code === "SHOPEE_UNAVAILABLE",
  );
  assert.equal(calls, 1);
});

test("Shopee read adapter classifies auth, business, and malformed contracts without retrying", async () => {
  const cases = [
    {
      response: { status: 403, body: { error: "forbidden", message: "token invalid", request_id: "auth-request" } },
      code: "SHOPEE_AUTH_ERROR",
      requestId: "auth-request",
    },
    {
      response: { status: 200, body: { ok: true, data: { error: "discount.error_time", message: "time error", request_id: "business-request", response: {} } } },
      code: "SHOPEE_BUSINESS_ERROR",
      requestId: "business-request",
    },
    {
      response: { status: 200, body: "{not-json" },
      code: "SHOPEE_MALFORMED_CONTRACT",
      requestId: REQUEST_ID,
    },
    {
      response: { status: 200, body: { ok: true, data: { error: "", message: "", request_id: "incomplete-read" } } },
      code: "SHOPEE_MALFORMED_CONTRACT",
      requestId: "incomplete-read",
    },
  ];

  for (const fixture of cases) {
    let calls = 0;
    const adapter = new ShopeeReadAdapter({
      retryPolicy: { maxAttempts: 3, delaysMs: [0, 0] },
      sleep: async () => undefined,
      transport: async () => {
        calls += 1;
        return fixture.response;
      },
    });
    await assert.rejects(
      adapter.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID }),
      (error) => error.code === fixture.code && error.requestId === fixture.requestId,
    );
    assert.equal(calls, 1, fixture.code);
  }
});

test("read and write adapters replace unsafe response request IDs with the validated caller ID", async () => {
  const unsafeIds = ["credential=secret", "raw payload text", "line\nbreak", "ümlaut", "a".repeat(201)];
  for (const unsafeId of unsafeIds) {
    const read = new ShopeeReadAdapter({ transport: async () => successfulPlatformPayload({ model: [], tier_variation: [] }) });
    const readPayload = successfulPlatformPayload({ model: [], tier_variation: [] });
    readPayload.body.data.request_id = unsafeId;
    read.transport = async () => readPayload;
    assert.equal((await read.getModelList({ shopId: "1", itemId: "2", requestId: REQUEST_ID })).requestId, REQUEST_ID);

    const write = new ShopeeWriteAdapter({
      siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "99999999", priceStepMinor: "1", maxAddItems: 50 },
      nowEpochSeconds: () => 1_700_000_000,
      transport: async () => ({ status: 200, body: { ok: true, data: { error: "", request_id: unsafeId, response: { discount_id: 2 } } } }),
    });
    assert.equal((await write.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID })).requestId, REQUEST_ID);
  }
});

test("read and write adapters reject unsafe caller request IDs before transport", async () => {
  const unsafeIds = ["credential=secret", "raw payload text", "line\nbreak", "ümlaut", "a".repeat(129)];
  for (const unsafeId of unsafeIds) {
    let calls = 0;
    const read = new ShopeeReadAdapter({ transport: async () => { calls += 1; } });
    await assert.rejects(read.getModelList({ shopId: "1", itemId: "2", requestId: unsafeId }), (error) => error.code === "SHOPEE_INPUT_INVALID");
    const write = new ShopeeWriteAdapter({ siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "9", priceStepMinor: "1", maxAddItems: 1 }, nowEpochSeconds: () => 1_700_000_000, transport: async () => { calls += 1; } });
    await assert.rejects(write.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: unsafeId }), (error) => error.code === "SHOPEE_INPUT_INVALID");
    assert.equal(calls, 0);
  }
});

test("Shopee read adapter rejects non-canonical IDs and invalid documented discount filters", async () => {
  let calls = 0;
  const adapter = new ShopeeReadAdapter({ transport: async () => { calls += 1; } });
  const invalidCalls = [
    () => adapter.listActiveItems({ shopId: "01", cursor: "0", pageSize: 100, requestId: REQUEST_ID }),
    () => adapter.getItemBaseInfo({ shopId: "1", itemIds: ["0"], requestId: REQUEST_ID }),
    () => adapter.getModelList({ shopId: 1, itemId: "2", requestId: REQUEST_ID }),
    () => adapter.getDiscount({ shopId: "1", discountId: "-2", pageNo: 1, pageSize: 50, requestId: REQUEST_ID }),
    () => adapter.listDiscounts({ shopId: "1", status: "active", pageNo: 1, pageSize: 100, requestId: REQUEST_ID }),
    () => adapter.listDiscounts({ shopId: "1", status: "all", pageNo: 1, pageSize: 100, updatedFrom: "1643860467", requestId: REQUEST_ID }),
    () => adapter.listDiscounts({ shopId: "1", status: "all", pageNo: 1, pageSize: 100, updatedFrom: "1643860467", updatedTo: "1646452468", requestId: REQUEST_ID }),
    () => adapter.listShops({ requestId: "unsafe\r\nheader" }),
  ];
  for (const invoke of invalidCalls) {
    await assert.rejects(invoke, (error) => error.code === "SHOPEE_INPUT_INVALID");
  }
  assert.equal(calls, 0);
});

test("Shopee write adapter binds the three official POST schemas and converts minor prices exactly", async () => {
  const calls = [];
  const responses = [
    { status: 200, body: { ok: true, data: { error: "", message: "", request_id: "write-request-1", response: { discount_id: 665123666665499 } } } },
    { status: 200, body: { ok: true, data: { error: "", message: "", request_id: "write-request-2", response: { discount_id: 665123666665499, count: 2, error_list: [], warning: "" } } } },
    { status: 200, body: { ok: true, data: { error: "", message: "", warning: "", request_id: "write-request-3", response: { discount_id: 665123666665499, count: 1, error_list: [] } } } },
  ];
  const adapter = new ShopeeWriteAdapter({
    siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "99999999", priceStepMinor: "1", maxAddItems: 50 },
    nowEpochSeconds: () => 1_700_000_000,
    transport: async (request) => {
      calls.push(request);
      return responses[calls.length - 1];
    },
  });

  await adapter.createDiscount({
    operationUuid: OPERATION_UUID,
    shopId: "1768286475",
    discountName: "PM-SG-DAILY-2023-11-15-A1B2",
    startTime: "1700003600",
    endTime: "1700608400",
    requestId: REQUEST_ID,
  });
  await adapter.addDiscountItems({
    operationUuid: OPERATION_UUID,
    shopId: "1768286475",
    discountId: "665123666665499",
    requestId: REQUEST_ID,
    items: [
      { itemId: "1776783", itemPromotionPriceMinor: "1100", itemPromotionStock: 22, purchaseLimit: 2 },
      { itemId: "1776784", models: [{ modelId: "1776782", modelPromotionPriceMinor: "1101", modelPromotionStock: 22 }], purchaseLimit: 0 },
    ],
  });
  await adapter.updateDiscountItems({
    operationUuid: OPERATION_UUID,
    shopId: "1768286475",
    discountId: "665123666665499",
    requestId: REQUEST_ID,
    items: [{ itemId: "1776783", itemPromotionPriceMinor: "9600", purchaseLimit: 1 }],
  });

  const headers = { "x-operation-uuid": OPERATION_UUID, "x-request-id": REQUEST_ID };
  assert.deepEqual(calls, [
    { relayPath: "/api/shopee/call", relayMethod: "POST", headers, body: { shop_id: "1768286475", api_path: "/api/v2/discount/add_discount", method: "POST", params: { discount_name: "PM-SG-DAILY-2023-11-15-A1B2", start_time: 1700003600, end_time: 1700608400 } } },
    { relayPath: "/api/shopee/call", relayMethod: "POST", headers, body: { shop_id: "1768286475", api_path: "/api/v2/discount/add_discount_item", method: "POST", params: { discount_id: "665123666665499", item_list: [
      { item_id: "1776783", item_promotion_price: "11.00", item_promotion_stock: 22, purchase_limit: 2 },
      { item_id: "1776784", model_list: [{ model_id: "1776782", model_promotion_price: "11.01", model_promotion_stock: 22 }], purchase_limit: 0 },
    ] } } },
    { relayPath: "/api/shopee/call", relayMethod: "POST", headers, body: { shop_id: "1768286475", api_path: "/api/v2/discount/update_discount_item", method: "POST", params: { discount_id: "665123666665499", item_list: [
      { item_id: "1776783", item_promotion_price: "96.00", purchase_limit: 1 },
    ] } } },
  ]);
});

test("Shopee write adapter never retries ambiguous POST outcomes and returns only safe UNKNOWN evidence", async () => {
  const faults = [
    Object.assign(new Error("timed out with secret-body"), { name: "AbortError" }),
    Object.assign(new Error("connection reset with secret-body"), { code: "ECONNRESET" }),
    { status: 200, body: "{malformed" },
    Object.assign(new Error("response lost with secret-body"), { code: "SHOPEE_RESPONSE_LOST" }),
    { status: 429, body: { error: "rate_limit", message: "secret-body", request_id: "write-rate-request" } },
    { status: 503, body: { error: "unavailable", message: "secret-body", request_id: "write-5xx-request" } },
    { status: 200, body: { ok: true, data: { error: "", message: "", request_id: "incomplete-write" } } },
  ];

  for (const fault of faults) {
    let calls = 0;
    const adapter = new ShopeeWriteAdapter({
      siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "99999999", priceStepMinor: "1", maxAddItems: 50 },
      nowEpochSeconds: () => 1_700_000_000,
      transport: async () => {
        calls += 1;
        if (fault instanceof Error) throw fault;
        return fault;
      },
    });
    await assert.rejects(
      adapter.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID }),
      (error) => {
        assert.equal(error.code, "SHOPEE_WRITE_UNKNOWN");
        assert.equal(error.operationUuid, OPERATION_UUID);
        assert.ok([REQUEST_ID, "write-rate-request", "write-5xx-request", "incomplete-write"].includes(error.requestId));
        assert.equal(String(error.message).includes("secret-body"), false);
        assert.deepEqual(Object.keys(error).sort(), ["code", "operationUuid", "requestId"]);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("Shopee write adapter requires valid HTTP status and gives ambiguous status precedence over auth text", async () => {
  const fixtures = [
    { body: { ok: true, data: { error: "", request_id: "missing-status", response: { discount_id: 2 } } } },
    { status: 503, body: { error: "auth service unavailable", request_id: "auth-service-down" } },
    { status: 429, body: { error: "unauthorized while rate limited", request_id: "rate-auth" } },
    { status: 200, body: { ok: true, data: { error: "auth service unavailable", request_id: "ambiguous-auth-text", response: {} } } },
  ];
  for (const response of fixtures) {
    const adapter = new ShopeeWriteAdapter({
      siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "99999999", priceStepMinor: "1", maxAddItems: 50 },
      nowEpochSeconds: () => 1_700_000_000,
      transport: async () => response,
    });
    await assert.rejects(
      adapter.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID }),
      (error) => error.code === "SHOPEE_WRITE_UNKNOWN",
    );
  }
});

test("Shopee write adapter treats malformed 401/403 as definite auth and technical platform codes as UNKNOWN", async () => {
  for (const status of [401, 403]) {
    const adapter = new ShopeeWriteAdapter({ siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "9", priceStepMinor: "1", maxAddItems: 1 }, nowEpochSeconds: () => 1_700_000_000, transport: async () => ({ status, body: "not-json" }) });
    await assert.rejects(adapter.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID }), (error) => error.code === "SHOPEE_AUTH_ERROR");
  }
  for (const code of ["error_network", "error_data", "error_server", "error_inner", "error_system_busy", "system_busy"]) {
    const adapter = new ShopeeWriteAdapter({ siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "9", priceStepMinor: "1", maxAddItems: 1 }, nowEpochSeconds: () => 1_700_000_000, transport: async () => ({ status: 200, body: { ok: true, data: { error: code, message: "technical", request_id: "technical-write", response: {} } } }) });
    await assert.rejects(adapter.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID }), (error) => error.code === "SHOPEE_WRITE_UNKNOWN");
  }
});

test("Shopee write adapter accepts only allowlisted documented definite business error codes", async () => {
  const fixtures = [
    { code: "discount.discount_period_too_long", invoke: (adapter) => adapter.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID }) },
    { code: "discount.item_id_not_exist", invoke: (adapter) => adapter.addDiscountItems({ operationUuid: OPERATION_UUID, shopId: "1", discountId: "2", items: [{ itemId: "3", itemPromotionPriceMinor: "1", purchaseLimit: 0 }], requestId: REQUEST_ID }) },
    { code: "discount.item_not_in_promotion", invoke: (adapter) => adapter.updateDiscountItems({ operationUuid: OPERATION_UUID, shopId: "1", discountId: "2", items: [{ itemId: "3", itemPromotionPriceMinor: "1" }], requestId: REQUEST_ID }) },
  ];
  for (const fixture of fixtures) {
    const adapter = new ShopeeWriteAdapter({ siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "9", priceStepMinor: "1", maxAddItems: 1 }, nowEpochSeconds: () => 1_700_000_000, transport: async () => ({ status: 200, body: { ok: true, data: { error: fixture.code, message: "definite rejection", request_id: "business-write", response: {} } } }) });
    await assert.rejects(fixture.invoke(adapter), (error) => error.code === "SHOPEE_BUSINESS_ERROR");
  }
});

test("generic error_param remains UNKNOWN for each write endpoint because the snapshot overloads it", async () => {
  const invocations = [
    (adapter) => adapter.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID }),
    (adapter) => adapter.addDiscountItems({ operationUuid: OPERATION_UUID, shopId: "1", discountId: "2", items: [{ itemId: "3", itemPromotionPriceMinor: "1", purchaseLimit: 0 }], requestId: REQUEST_ID }),
    (adapter) => adapter.updateDiscountItems({ operationUuid: OPERATION_UUID, shopId: "1", discountId: "2", items: [{ itemId: "3", itemPromotionPriceMinor: "1" }], requestId: REQUEST_ID }),
  ];
  for (const invoke of invocations) {
    const adapter = new ShopeeWriteAdapter({ siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "9", priceStepMinor: "1", maxAddItems: 1 }, nowEpochSeconds: () => 1_700_000_000, transport: async () => ({ status: 200, body: { ok: true, data: { error: "error_param", message: "overloaded", request_id: "ambiguous-param", response: {} } } }) });
    await assert.rejects(invoke(adapter), (error) => error.code === "SHOPEE_WRITE_UNKNOWN");
  }
});

test("Shopee write adapter requires canonical decimal strings for minor-unit capabilities", () => {
  for (const siteCapability of [
    { priceScale: 2, minPriceMinor: 1, maxPriceMinor: "9", priceStepMinor: "1", maxAddItems: 1 },
    { priceScale: 2, minPriceMinor: "1", maxPriceMinor: 9, priceStepMinor: "1", maxAddItems: 1 },
    { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "9", priceStepMinor: 1, maxAddItems: 1 },
    { priceScale: 2, minPriceMinor: "01", maxPriceMinor: "9", priceStepMinor: "1", maxAddItems: 1 },
  ]) assert.throws(() => new ShopeeWriteAdapter({ siteCapability, transport: async () => undefined }), TypeError);
});

test("Shopee write adapter distinguishes definite auth and business rejection without leaking payloads", async () => {
  const cases = [
    { response: { status: 401, body: { error: "unauthorized", message: "credential secret", request_id: "auth-write" } }, code: "SHOPEE_AUTH_ERROR" },
    { response: { status: 200, body: { ok: true, data: { error: "discount.discount_period_too_long", message: "payload secret", request_id: "business-write", response: {} } } }, code: "SHOPEE_BUSINESS_ERROR" },
    { thrown: Object.assign(new Error("transport credential secret"), { code: "SHOPEE_AUTH_ERROR", requestId: "thrown-auth" }), code: "SHOPEE_AUTH_ERROR" },
    { thrown: Object.assign(new Error("transport payload secret"), { code: "SHOPEE_BUSINESS_ERROR", requestId: "thrown-business" }), code: "SHOPEE_BUSINESS_ERROR" },
  ];
  for (const fixture of cases) {
    let calls = 0;
    const adapter = new ShopeeWriteAdapter({
      siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "99999999", priceStepMinor: "1", maxAddItems: 50 },
      nowEpochSeconds: () => 1_700_000_000,
      transport: async () => { calls += 1; if (fixture.thrown) throw fixture.thrown; return fixture.response; },
    });
    await assert.rejects(
      adapter.createDiscount({ operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID }),
      (error) => error.code === fixture.code && !String(error.message).includes("secret") && error.operationUuid === undefined,
    );
    assert.equal(calls, 1);
  }
});

test("Shopee write adapter rejects invalid names, timestamps, IDs, lists, identities, prices, and unknown fields before dispatch", async () => {
  let calls = 0;
  const adapter = new ShopeeWriteAdapter({
    siteCapability: { priceScale: 2, minPriceMinor: "10", maxPriceMinor: "99999999", priceStepMinor: "5", maxAddItems: 2 },
    nowEpochSeconds: () => 1_700_000_000,
    transport: async () => { calls += 1; },
  });
  const baseCreate = { operationUuid: OPERATION_UUID, shopId: "1", discountName: "PM-SG-DAILY-2023-11-15-A1B2", startTime: "1700003600", endTime: "1700608400", requestId: REQUEST_ID };
  const baseItems = { operationUuid: OPERATION_UUID, shopId: "1", discountId: "2", requestId: REQUEST_ID };
  const invalidCalls = [
    () => adapter.createDiscount({ ...baseCreate, discountName: "test-create" }),
    () => adapter.createDiscount({ ...baseCreate, startTime: "1700003599" }),
    () => adapter.createDiscount({ ...baseCreate, endTime: "1700007199" }),
    () => adapter.createDiscount({ ...baseCreate, endTime: "1715555600" }),
    () => adapter.createDiscount({ ...baseCreate, apiPath: "/api/v2/discount/end_discount" }),
    () => adapter.createDiscount({ ...baseCreate, shopId: "01" }),
    () => adapter.addDiscountItems({ ...baseItems, items: [] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [
      { itemId: "1", itemPromotionPriceMinor: "100", purchaseLimit: 0 },
      { itemId: "2", itemPromotionPriceMinor: "100", purchaseLimit: 0 },
      { itemId: "3", itemPromotionPriceMinor: "100", purchaseLimit: 0 },
    ] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [
      { itemId: "1", itemPromotionPriceMinor: "100", purchaseLimit: 0 },
      { itemId: "1", itemPromotionPriceMinor: "100", purchaseLimit: 0 },
    ] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [{ itemId: "01", itemPromotionPriceMinor: "100", purchaseLimit: 0 }] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [{ itemId: "1", itemPromotionPriceMinor: "010", purchaseLimit: 0 }] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [{ itemId: "1", itemPromotionPriceMinor: "11", purchaseLimit: 0 }] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [{ itemId: "1", itemPromotionPriceMinor: "100", purchaseLimit: 0, unexpected: true }] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [{ itemId: "1", models: [
      { modelId: "2", modelPromotionPriceMinor: "100" },
      { modelId: "2", modelPromotionPriceMinor: "100" },
    ], purchaseLimit: 0 }] }),
    () => adapter.addDiscountItems({ ...baseItems, items: [{ itemId: "1", models: Array.from({ length: 51 }, (_, index) => ({ modelId: String(index + 1), modelPromotionPriceMinor: "100" })), purchaseLimit: 0 }] }),
    () => adapter.updateDiscountItems({ ...baseItems, items: [{ itemId: "1", models: [{ modelId: "2", modelPromotionPriceMinor: "100", modelPromotionStock: 3 }] }] }),
  ];
  for (const [index, invoke] of invalidCalls.entries()) {
    await assert.rejects(invoke, (error) => error.code === "SHOPEE_INPUT_INVALID", `invalid write fixture ${index}`);
  }
  assert.equal(calls, 0);
});

test("Shopee write adapter exposes only the three fixed write methods", () => {
  const adapter = new ShopeeWriteAdapter({
    siteCapability: { priceScale: 2, minPriceMinor: "1", maxPriceMinor: "99999999", priceStepMinor: "1", maxAddItems: 50 },
    transport: async () => undefined,
  });
  assert.equal(adapter.call, undefined);
  assert.equal(adapter.request, undefined);
  assert.equal(adapter.deleteDiscount, undefined);
  assert.equal(adapter.endDiscount, undefined);
  assert.equal(adapter.updateDiscount, undefined);
});
