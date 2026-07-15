import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_TOKEN_SESSION_KEY,
  createAuthorizedFetch,
  readSessionToken,
  saveSessionToken,
} from "../public/auth-client.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test("authorized fetch reads sessionStorage and adds the Bearer header", async () => {
  const storage = memoryStorage();
  saveSessionToken("temporary-frontend-token", storage);
  let requestHeaders;
  const authorizedFetch = createAuthorizedFetch({
    storage,
    fetchImpl: async (_input, init) => {
      requestHeaders = init.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await authorizedFetch("/api/example", { headers: { "content-type": "application/json" } });
  assert.equal(requestHeaders.get("Authorization"), "Bearer temporary-frontend-token");
  assert.equal(requestHeaders.get("content-type"), "application/json");
  assert.equal(readSessionToken(storage), "temporary-frontend-token");
});

test("a 401 response clears the session token and invokes the lock callback", async () => {
  const storage = memoryStorage();
  storage.setItem(ACCESS_TOKEN_SESSION_KEY, "temporary-expired-token");
  let locked = false;
  const authorizedFetch = createAuthorizedFetch({
    storage,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 401 }),
    onUnauthorized: () => { locked = true; },
  });

  const response = await authorizedFetch("/api/protected");
  assert.equal(response.status, 401);
  assert.equal(readSessionToken(storage), "");
  assert.equal(locked, true);
});
