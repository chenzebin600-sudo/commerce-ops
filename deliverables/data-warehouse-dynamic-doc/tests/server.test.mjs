import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createApp, listenOnAvailablePort } from "../server.mjs";

async function withServer(fetchImpl, run) {
  const server = createApp({
    upstreamBaseUrl: "http://warehouse.test",
    fetchImpl,
    logger: { log() {}, error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

function rawRequest(base, path) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path }, (response) => {
      response.resume();
      response.on("end", () => resolve(response));
    });
    request.on("error", reject);
    request.end();
  });
}

test("forwards only the data key to the fixed me endpoint", async () => {
  let observed;
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async (url, options) => {
    observed = { url, options };
    return new Response(JSON.stringify({ ok: true, 角色: "运营" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, async (base) => {
    const response = await fetch(`${base}/proxy/me`, {
      headers: { "x-data-key": testKey, "x-extra": "drop-me" },
    });
    assert.equal(response.status, 200);
  });
  assert.equal(observed.url, "http://warehouse.test/api/data/me");
  assert.equal(observed.options.headers["X-Data-Key"], testKey);
  assert.equal(observed.options.headers["x-extra"], undefined);
});

test("rejects unknown local proxy paths without calling upstream", async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; }, async (base) => {
    const response = await fetch(`${base}/proxy/http://evil.test`);
    assert.equal(response.status, 404);
  });
  assert.equal(calls, 0);
});

test("rejects forbidden query keys before calling upstream", async () => {
  let calls = 0;
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async () => { calls += 1; }, async (base) => {
    const response = await fetch(`${base}/proxy/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-data-key": testKey },
      body: JSON.stringify({ 产品: "库存", 参数: {}, 页大小: 500, sql: "select 1" }),
    });
    assert.equal(response.status, 400);
  });
  assert.equal(calls, 0);
});

test("preserves supported upstream error status and JSON", async () => {
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async () => new Response(JSON.stringify({ ok: false, error: "权限不足" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  }), async (base) => {
    const response = await fetch(`${base}/proxy/me`, { headers: { "x-data-key": testKey } });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: "权限不足" });
    assert.match(response.headers.get("cache-control"), /no-store/);
  });
});

test("sanitizes upstream network failures", async () => {
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async () => { throw new Error(`connect failed ${testKey}`); }, async (base) => {
    const response = await fetch(`${base}/proxy/me`, { headers: { "x-data-key": testKey } });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.doesNotMatch(body, /secret/);
  });
});

test("rejects unsupported method and path combinations", async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; }, async (base) => {
    for (const [method, path, expected] of [
      ["POST", "/proxy/me", 405],
      ["GET", "/proxy/query", 405],
      ["GET", "/unknown", 404],
    ]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, expected);
    }
  });
  assert.equal(calls, 0);
});

test("health route is available without a key", async () => {
  await withServer(async () => { throw new Error("not expected"); }, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("rejects an invalid key without echoing it", async () => {
  const invalidKey = ["zntk", "not-data"].join("_");
  await withServer(async () => { throw new Error("not expected"); }, async (base) => {
    const response = await fetch(`${base}/proxy/me`, { headers: { "x-data-key": invalidKey } });
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.equal(body.includes(invalidKey), false);
  });
});

test("falls back to the next loopback port", async () => {
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const preferredPort = blocker.address().port;
  assert.ok(preferredPort < 65535);
  const candidate = createServer((request, response) => response.end("ok"));
  const selected = await listenOnAvailablePort(candidate, {
    host: "127.0.0.1", preferredPort, attempts: 2,
  });
  try {
    assert.equal(selected.port, preferredPort + 1);
    assert.equal(selected.host, "127.0.0.1");
  } finally {
    const closed = [once(candidate, "close"), once(blocker, "close")];
    candidate.close();
    blocker.close();
    await Promise.all(closed);
  }
});

test("rejects encoded traversal before static route matching", async () => {
  await withServer(async () => { throw new Error("not expected"); }, async (base) => {
    const response = await rawRequest(base, "/%2e%2e/shared/query-model.mjs");
    assert.equal(response.statusCode, 404);
  });
});
