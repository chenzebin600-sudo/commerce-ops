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
  const payload = { shop_id: 1768286475, api_path: "/api/v2/shop/get_shop_info", params: {} };
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
