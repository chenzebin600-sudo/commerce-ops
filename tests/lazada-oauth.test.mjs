import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LazadaOAuthRepository,
  buildLazadaAuthorizationUrl,
  createLazadaOAuthHandler,
  exchangeAuthorizationCode,
  resolveLazadaOAuthConfig,
  signLazadaRequest,
} from "../integrations/lazada-oauth/lazada-oauth-service.mjs";

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "commerce-ops-lazada-oauth-"));
}

function testConfig(root, appCount = 1) {
  const apps = Array.from({ length: appCount }, (_, offset) => {
    const index = offset + 1;
    return {
      id: `app-${index}`,
      index,
      name: `Lazada App ${index}`,
      appKey: `key-${index}`,
      appSecret: `secret-${index}`,
      callbackUrl: index === 1
        ? "https://oauth.example.com/lazada/callback"
        : `https://oauth.example.com/lazada/apps/app-${index}/callback`,
      authBaseUrl: "https://auth.lazada.com",
      apiBaseUrl: "https://auth.lazada.com/rest",
    };
  });
  return {
    host: "127.0.0.1",
    port: 8977,
    apps,
    defaultAppId: "app-1",
    appKey: apps[0].appKey,
    appSecret: apps[0].appSecret,
    callbackUrl: apps[0].callbackUrl,
    authBaseUrl: "https://auth.lazada.com",
    apiBaseUrl: "https://auth.lazada.com/rest",
    databasePath: path.join(root, "oauth.sqlite"),
    envPath: path.join(root, ".env"),
    tokenEncryptionKey: TEST_ENCRYPTION_KEY,
    stateTtlSeconds: 900,
    requestTimeoutMs: 2000,
  };
}

function createRepository(config) {
  return new LazadaOAuthRepository(config.databasePath, {
    defaultAppId: config.defaultAppId,
    encryptionKey: config.tokenEncryptionKey,
  });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("Lazada request signing matches the official HMAC-SHA256 sample", () => {
  assert.equal(signLazadaRequest({
    apiPath: "/order/get",
    appSecret: "helloworld",
    parameters: {
      app_key: "123456",
      access_token: "test",
      timestamp: "1517820392000",
      sign_method: "sha256",
      order_id: "1234",
    },
  }), "4190D32361CFB9581350222F345CB77F3B19F0E31D162316848A2C1FFD5FAB4A");
});

test("authorization URL contains exact callback and CSRF state", () => {
  const url = new URL(buildLazadaAuthorizationUrl({
    authBaseUrl: "https://auth.lazada.com",
    callbackUrl: "https://oauth.example.com/lazada/callback",
    appKey: "100132",
  }, "state-value"));
  assert.equal(url.origin + url.pathname, "https://auth.lazada.com/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("force_auth"), "true");
  assert.equal(url.searchParams.get("redirect_uri"), "https://oauth.example.com/lazada/callback");
  assert.equal(url.searchParams.get("client_id"), "100132");
  assert.equal(url.searchParams.get("state"), "state-value");
});

test("configuration resolves three apps and derives separate callback paths", () => {
  const config = resolveLazadaOAuthConfig({
    rootDir: "C:/commerce-ops",
    env: {
      LAZADA_APP_COUNT: "3",
      LAZADA_APP_KEY: "legacy-key",
      LAZADA_APP_SECRET: "legacy-secret",
      LAZADA_CALLBACK_URL: "https://oauth.example.com/lazada/callback",
      LAZADA_APP_2_KEY: "key-2",
      LAZADA_APP_2_SECRET: "secret-2",
      LAZADA_APP_3_KEY: "key-3",
      LAZADA_APP_3_SECRET: "secret-3",
    },
  });
  assert.equal(config.apps.length, 3);
  assert.equal(config.apps[0].appKey, "legacy-key");
  assert.equal(config.apps[1].callbackUrl, "https://oauth.example.com/lazada/apps/app-2/callback");
  assert.equal(config.apps[2].callbackUrl, "https://oauth.example.com/lazada/apps/app-3/callback");
});

test("token exchange keeps a safe timeout when an app config omits the shared timeout", async () => {
  let signalWasAborted = true;
  const token = await exchangeAuthorizationCode({
    code: "one-time-code",
    config: {
      appKey: "key-1",
      appSecret: "secret-1",
      apiBaseUrl: "https://auth.lazada.com/rest",
    },
    fetchImpl: async (_endpoint, options) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      signalWasAborted = options.signal.aborted;
      return new Response(JSON.stringify({
        code: "0", access_token: "access", refresh_token: "refresh",
        expires_in: 3600, account_id: "account-1",
        country_user_info: [{ country: "TH", seller_id: "shop-1" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(signalWasAborted, false);
  assert.equal(token.shopId, "shop-1");
});

test("legacy callback saves an encrypted App 1 token and per-store env mirror", async (t) => {
  const root = temporaryRoot();
  const config = testConfig(root);
  const repository = createRepository(config);
  const fetchImpl = async () => new Response(JSON.stringify({
    code: "0",
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    expires_in: 3600,
    refresh_expires_in: 7200,
    account_id: "account-1",
    country: "th",
    country_user_info: [{ country: "TH", seller_id: "shop-1" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const server = await listen(createLazadaOAuthHandler({ config, repository, fetchImpl }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const auth = await (await fetch(`${base}/lazada/auth?format=json`)).json();
  const state = new URL(auth.authorization_url).searchParams.get("state");
  const callbackResponse = await fetch(`${base}/lazada/callback?code=one-time-code&state=${encodeURIComponent(state)}`);
  assert.equal(callbackResponse.status, 200);
  assert.match(await callbackResponse.text(), /callback received/i);

  const tokenResponse = await fetch(`${base}/lazada/token`, { method: "POST" });
  assert.equal(tokenResponse.status, 200);
  const saved = await tokenResponse.json();
  assert.equal(saved.app_id, "app-1");
  assert.equal(saved.shop_id, "shop-1");
  assert.equal(repository.status("app-1").token.shop_id, "shop-1");
  assert.equal(repository.tokenCredentials("app-1", "shop-1").access_token, "access-secret");
  const connectorShop = repository.platformRepository.findShop({ platformId: "lazada", identifier: "shop-1" });
  assert.equal(connectorShop.sellerId, "shop-1");
  assert.equal(repository.platformRepository.getAuthorization(connectorShop.id).accessToken, "access-secret");
  const env = fs.readFileSync(config.envPath, "utf8");
  assert.match(env, /^LAZADA_STORE_APP_1_SHOP_1_ACCESS_TOKEN=access-secret$/m);
  assert.match(env, /^LAZADA_ACCESS_TOKEN=access-secret$/m);
  assert.equal(fs.readFileSync(config.databasePath).includes(Buffer.from("access-secret")), false);
});

test("two Lazada apps retain independent store tokens without overwrite", async (t) => {
  const root = temporaryRoot();
  const config = testConfig(root, 2);
  const repository = createRepository(config);
  const fetchImpl = async (endpoint) => {
    const appKey = new URL(endpoint).searchParams.get("app_key");
    const suffix = appKey === "key-2" ? "2" : "1";
    return new Response(JSON.stringify({
      code: "0",
      access_token: `access-${suffix}`,
      refresh_token: `refresh-${suffix}`,
      expires_in: 3600,
      refresh_expires_in: 7200,
      account_id: `account-${suffix}`,
      country: "th",
      country_user_info: [{ country: "TH", seller_id: `shop-${suffix}` }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const server = await listen(createLazadaOAuthHandler({ config, repository, fetchImpl }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const appId of ["app-1", "app-2"]) {
    const auth = await (await fetch(`${base}/lazada/apps/${appId}/auth?format=json`)).json();
    const state = new URL(auth.authorization_url).searchParams.get("state");
    const callback = await fetch(`${base}/lazada/apps/${appId}/callback?code=code-${appId}&state=${encodeURIComponent(state)}`);
    const callbackHtml = await callback.text();
    const ticket = callbackHtml.match(/name="ticket" value="([^"]+)"/)?.[1];
    assert.ok(ticket);
    const token = await fetch(`${base}/lazada/apps/${appId}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket }),
    });
    assert.equal(token.status, 200);
  }

  assert.deepEqual(repository.listTokens().map((item) => [item.app_id, item.shop_id]), [
    ["app-1", "shop-1"],
    ["app-2", "shop-2"],
  ]);
  assert.equal(repository.tokenCredentials("app-1", "shop-1").access_token, "access-1");
  assert.equal(repository.tokenCredentials("app-2", "shop-2").access_token, "access-2");
});

test("state created for one app cannot be consumed by another app", async (t) => {
  const root = temporaryRoot();
  const config = testConfig(root, 2);
  const repository = createRepository(config);
  const server = await listen(createLazadaOAuthHandler({ config, repository }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = await (await fetch(`${base}/lazada/apps/app-1/auth?format=json`)).json();
  const state = new URL(auth.authorization_url).searchParams.get("state");
  const response = await fetch(`${base}/lazada/apps/app-2/callback?code=x&state=${encodeURIComponent(state)}`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Invalid or expired OAuth state/);
});

test("central manager returns metadata only and never token values", async (t) => {
  const root = temporaryRoot();
  const config = testConfig(root, 2);
  const repository = createRepository(config);
  repository.saveToken("app-1", {
    shopId: "shop-1", accountId: "account-1", country: "th", accountPlatform: "seller_center",
    account: "seller@example.com", accessToken: "never-show-access", refreshToken: "never-show-refresh",
    expireTime: new Date(Date.now() + 3600_000).toISOString(), refreshExpireTime: "", countryUserInfo: [],
  });
  const server = await listen(createLazadaOAuthHandler({ config, repository }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/lazada/manager`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /shop-1/);
  assert.doesNotMatch(body, /never-show-access|never-show-refresh|seller@example.com/);
});
