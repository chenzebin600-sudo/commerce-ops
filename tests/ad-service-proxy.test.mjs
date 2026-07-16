import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  AD_SERVICE_INTERNAL_HEADER,
  buildAdServiceTarget,
  createAdServiceProxy,
  resolveAdServiceProxyConfig,
} from "../lib/ad-service-proxy.mjs";
import { createAccessPolicy, protectedApiAccessResponse } from "../lib/app-access.mjs";

const APP_TOKEN = "temporary-b2-app-token";
const INTERNAL_TOKEN = "temporary-b2-internal-token";

function request(method = "GET", headers = {}, body = []) {
  return Object.assign(Readable.from(body), { method, headers });
}

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = Buffer.alloc(0)) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
  };
}

test("advertising proxy defaults to the loopback advertising service", () => {
  assert.deepEqual(resolveAdServiceProxyConfig({}), {
    host: "127.0.0.1",
    port: 4173,
    baseUrl: "http://127.0.0.1:4173",
  });
  assert.throws(
    () => resolveAdServiceProxyConfig({ AD_SERVICE_BASE_URL: "http://192.168.1.20:4173" }),
    /回环地址/,
  );
});

test("advertising page and API paths map to the fixed service without changing its host", () => {
  const page = buildAdServiceTarget(
    "http://127.0.0.1:4173",
    new URL("http://lan-host:3101/ads/app.js?v=1"),
    "static",
  );
  const api = buildAdServiceTarget(
    "http://127.0.0.1:4173",
    new URL("http://lan-host:3101/api/ads/analyze?target=http://example.com"),
    "api",
  );
  assert.equal(page.href, "http://127.0.0.1:4173/app.js?v=1");
  assert.equal(api.origin, "http://127.0.0.1:4173");
  assert.equal(api.pathname, "/api/analyze");
  assert.equal(api.searchParams.get("target"), "http://example.com");
});

test("main access policy rejects an unauthenticated advertising API before proxying", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: APP_TOKEN });
  assert.equal(protectedApiAccessResponse({}, policy)?.status, 401);
  assert.equal(protectedApiAccessResponse({ authorization: `Bearer ${APP_TOKEN}` }, policy), null);
});

test("proxy replaces the browser Authorization header with the internal service token", async () => {
  let captured;
  const proxy = createAdServiceProxy({
    baseUrl: "http://127.0.0.1:4173",
    internalToken: INTERNAL_TOKEN,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const req = request("POST", {
    authorization: `Bearer ${APP_TOKEN}`,
    "content-type": "application/json",
  }, [Buffer.from('{"hello":"world"}')]);
  const res = responseRecorder();

  await proxy(req, res, new URL("http://office-host:3101/api/ads/chat"), "api");

  assert.equal(captured.url.href, "http://127.0.0.1:4173/api/chat");
  assert.equal(captured.init.headers.get("authorization"), null);
  assert.equal(captured.init.headers.get(AD_SERVICE_INTERNAL_HEADER), INTERNAL_TOKEN);
  assert.equal(res.status, 200);
});

test("proxy never treats a query parameter as an alternate target", async () => {
  let target;
  const proxy = createAdServiceProxy({
    baseUrl: "http://127.0.0.1:4173",
    internalToken: INTERNAL_TOKEN,
    fetchImpl: async (url) => {
      target = url;
      return new Response("not found", { status: 404 });
    },
  });
  const res = responseRecorder();
  await proxy(
    request(),
    res,
    new URL("http://office-host:3101/api/ads/proxy?url=http://169.254.169.254/latest"),
    "api",
  );
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.pathname, "/api/proxy");
});

test("internal authentication failures are not exposed as browser session failures", async () => {
  const proxy = createAdServiceProxy({
    baseUrl: "http://127.0.0.1:4173",
    internalToken: INTERNAL_TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ error: "internal" }), { status: 401 }),
  });
  const res = responseRecorder();
  await proxy(request(), res, new URL("http://host/api/ads/result/example"), "api");
  assert.equal(res.status, 502);
  assert.match(res.body.toString("utf8"), /内部认证失败/);
  assert.equal(res.body.toString("utf8").includes(INTERNAL_TOKEN), false);
});

test("unavailable advertising service returns a bounded generic error", async () => {
  const proxy = createAdServiceProxy({
    baseUrl: "http://127.0.0.1:4173",
    internalToken: INTERNAL_TOKEN,
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED C:\\private\\path"); },
  });
  const res = responseRecorder();
  await proxy(request(), res, new URL("http://host/ads/"), "static");
  assert.equal(res.status, 503);
  assert.match(res.body.toString("utf8"), /未启动或不可用/);
  assert.equal(res.body.toString("utf8").includes("C:\\private"), false);
});

test("advertising proxy enforces request limits and method restrictions", async () => {
  let forwarded = false;
  const proxy = createAdServiceProxy({
    baseUrl: "http://127.0.0.1:4173",
    internalToken: INTERNAL_TOKEN,
    requestLimitBytes: 4,
    fetchImpl: async () => {
      forwarded = true;
      return new Response("ok");
    },
  });
  const oversized = responseRecorder();
  await proxy(request("POST", { "content-length": "5" }, [Buffer.from("12345")]), oversized, new URL("http://host/api/ads/analyze"), "api");
  assert.equal(oversized.status, 413);
  assert.equal(forwarded, false);

  const invalidMethod = responseRecorder();
  await proxy(request("POST"), invalidMethod, new URL("http://host/ads/"), "static");
  assert.equal(invalidMethod.status, 405);
});
