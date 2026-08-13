import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createShopeeConsoleProxy } from "../lib/shopee-console-proxy.mjs";

function request({ method = "GET", headers = {}, body = "" } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.headers = headers;
  return req;
}

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = Buffer.alloc(0)) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
    json() {
      return JSON.parse(this.body.toString("utf8"));
    },
  };
}

test("Shopee console proxy only handles its two fixed routes", async () => {
  const proxy = createShopeeConsoleProxy({ fetchImpl: async () => new Response("{}") });
  const handled = await proxy(
    request({ headers: { "x-token-key": "test" } }),
    responseRecorder(),
    new URL("http://local/api/elsewhere"),
  );
  assert.equal(handled, false);
});

test("Shopee console proxy requires a token key", async () => {
  let called = false;
  const proxy = createShopeeConsoleProxy({ fetchImpl: async () => { called = true; } });
  const res = responseRecorder();
  await proxy(request(), res, new URL("http://local/api/shopee-console/shops"));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "请填写 X-Token-Key");
  assert.equal(called, false);
});

test("Shopee console proxy forwards only the fixed shop scope request", async () => {
  let captured;
  const proxy = createShopeeConsoleProxy({
    baseUrl: "http://10.110.80.95:8788",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ shops: [{ shop_id: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const res = responseRecorder();
  await proxy(
    request({ headers: { "x-token-key": "secret-test-key" } }),
    res,
    new URL("http://local/api/shopee-console/shops"),
  );
  assert.equal(captured.url, "http://10.110.80.95:8788/api/token/shops");
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.headers.get("x-token-key"), "secret-test-key");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { shops: [{ shop_id: 1 }] });
});

test("Shopee console proxy forwards relay JSON without logging or persisting the key", async () => {
  const payload = { shop_id: 1768286475, api_path: "/api/v2/shop/get_shop_info", method: "GET", params: {} };
  let captured;
  const proxy = createShopeeConsoleProxy({
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body.toString("utf8")) };
      return new Response(JSON.stringify({ ok: true, data: { error: "" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const res = responseRecorder();
  await proxy(
    request({
      method: "POST",
      headers: { "x-token-key": "secret-test-key", "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    res,
    new URL("http://local/api/shopee-console/call"),
  );
  assert.equal(captured.url, "http://10.110.80.95:8788/api/shopee/call");
  assert.equal(captured.init.headers.get("x-token-key"), "secret-test-key");
  assert.deepEqual(captured.body, payload);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("Shopee console proxy rejects write methods locally", async () => {
  for (const method of [undefined, "POST", "DELETE", "get"]) {
    let calls = 0;
    const proxy = createShopeeConsoleProxy({ fetchImpl: async () => { calls += 1; } });
    const body = {
      shop_id: "1768286475",
      api_path: "/api/v2/discount/add_discount",
      params: { discount_name: "must-not-dispatch" },
    };
    if (method !== undefined) body.method = method;
    const res = responseRecorder();
    await proxy(
      request({
        method: "POST",
        headers: { "x-token-key": "secret-test-key", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      res,
      new URL("http://local/api/shopee-console/call"),
    );
    assert.equal(res.statusCode, 400);
    assert.equal(calls, 0);
  }
});

test("Shopee console proxy rejects non-allowlisted and non-canonical paths locally", async () => {
  const paths = [
    "/api/v2/discount/add_discount",
    "/api/v2/discount/%67et_discount",
    "/api/v2/discount/../discount/get_discount",
    "//api/v2/discount/get_discount",
    "https://partner.shopeemobile.com/api/v2/discount/get_discount",
    "/api/v2/discount/get_discount?page_no=1",
  ];
  for (const apiPath of paths) {
    let calls = 0;
    const proxy = createShopeeConsoleProxy({ fetchImpl: async () => { calls += 1; } });
    const res = responseRecorder();
    await proxy(
      request({
        method: "POST",
        headers: { "x-token-key": "secret-test-key", "content-type": "application/json" },
        body: JSON.stringify({ shop_id: "1768286475", api_path: apiPath, method: "GET", params: {} }),
      }),
      res,
      new URL("http://local/api/shopee-console/call"),
    );
    assert.equal(res.statusCode, 400, apiPath);
    assert.equal(calls, 0, apiPath);
  }
});

test("Shopee console proxy rejects malformed JSON locally", async () => {
  let calls = 0;
  const proxy = createShopeeConsoleProxy({ fetchImpl: async () => { calls += 1; } });
  const res = responseRecorder();
  await proxy(
    request({
      method: "POST",
      headers: { "x-token-key": "secret-test-key", "content-type": "application/json" },
      body: '{"shop_id":',
    }),
    res,
    new URL("http://local/api/shopee-console/call"),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("Shopee console proxy rejects unknown routing fields instead of forwarding the browser envelope", async () => {
  let calls = 0;
  const proxy = createShopeeConsoleProxy({ fetchImpl: async () => { calls += 1; } });
  const res = responseRecorder();
  await proxy(
    request({
      method: "POST",
      headers: { "x-token-key": "secret-test-key", "content-type": "application/json" },
      body: JSON.stringify({
        shop_id: "1768286475",
        api_path: "/api/v2/discount/get_discount",
        method: "GET",
        params: { discount_id: "1000029882", page_no: 1, page_size: 50 },
        upstream_url: "https://attacker.invalid/write",
      }),
    }),
    res,
    new URL("http://local/api/shopee-console/call"),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("Shopee console proxy accepts each fixed Discount read path and rebuilds a GET-only relay envelope", async () => {
  const allowedPaths = [
    "/api/v2/product/get_item_list",
    "/api/v2/product/get_item_base_info",
    "/api/v2/product/get_model_list",
    "/api/v2/discount/get_discount_list",
    "/api/v2/discount/get_discount",
  ];
  const bodies = [];
  const proxy = createShopeeConsoleProxy({
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body.toString("utf8")));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  for (const apiPath of allowedPaths) {
    const res = responseRecorder();
    await proxy(
      request({
        method: "POST",
        headers: { "x-token-key": "secret-test-key", "content-type": "application/json" },
        body: `  ${JSON.stringify({ params: {}, method: "GET", api_path: apiPath, shop_id: "1768286475" })}\n`,
      }),
      res,
      new URL("http://local/api/shopee-console/call"),
    );
    assert.equal(res.statusCode, 200);
  }
  assert.deepEqual(bodies, allowedPaths.map((apiPath) => ({
    shop_id: "1768286475",
    api_path: apiPath,
    method: "GET",
    params: {},
  })));
});

test("Shopee console proxy rejects oversized call bodies before fetch", async () => {
  let calls = 0;
  const proxy = createShopeeConsoleProxy({ requestLimitBytes: 32, fetchImpl: async () => { calls += 1; } });
  const res = responseRecorder();
  await proxy(
    request({
      method: "POST",
      headers: { "x-token-key": "secret-test-key", "content-type": "application/json" },
      body: JSON.stringify({ shop_id: "1768286475", api_path: "/api/v2/discount/get_discount", method: "GET", params: {} }),
    }),
    res,
    new URL("http://local/api/shopee-console/call"),
  );
  assert.equal(res.statusCode, 413);
  assert.equal(calls, 0);
});
