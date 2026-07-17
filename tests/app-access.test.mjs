import test from "node:test";
import assert from "node:assert/strict";
import {
  appStartupMessages,
  authenticationApiResponse,
  bearerTokenFromHeaders,
  constantTimeTokenEquals,
  createAccessPolicy,
  isPublicApiPath,
  protectedApiAccessResponse,
  resolveAppConfig,
} from "../lib/app-access.mjs";

const TEST_TOKEN = "temporary-b1-test-token";

function bearer(token = TEST_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

test("default listener is 127.0.0.1:3101", () => {
  const config = resolveAppConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3101);
  assert.equal(config.localCompatibilityMode, true);
});

test("APP_HOST and APP_PORT take priority over legacy HOST and PORT", () => {
  const config = resolveAppConfig({
    APP_HOST: "127.0.0.9",
    APP_PORT: "4101",
    HOST: "0.0.0.0",
    PORT: "4102",
  });
  assert.equal(config.host, "127.0.0.9");
  assert.equal(config.port, 4101);
});

test("external listener without a token is rejected", () => {
  assert.throws(
    () => resolveAppConfig({ APP_HOST: "0.0.0.0", APP_PORT: "3101" }),
    /外部监听必须配置 APP_ACCESS_TOKEN/,
  );
});

test("external listener with a token is allowed", () => {
  const config = resolveAppConfig({ APP_HOST: "0.0.0.0", APP_PORT: "3101", APP_ACCESS_TOKEN: TEST_TOKEN });
  assert.equal(config.authenticationEnabled, true);
  assert.equal(config.localCompatibilityMode, false);
});

test("external listener explicitly allows unauthenticated LAN access", () => {
  const config = resolveAppConfig({
    APP_HOST: "0.0.0.0",
    APP_PORT: "3101",
    APP_ALLOW_UNAUTHENTICATED_LAN: "true",
  });
  const policy = createAccessPolicy(config);
  assert.equal(config.authenticationEnabled, false);
  assert.equal(config.allowUnauthenticatedLan, true);
  assert.equal(policy.localCompatibilityMode, true);
  assert.equal(policy.isAuthenticated({}), true);
});

test("external listener rejects false or invalid unauthenticated LAN flags", () => {
  for (const value of ["", "false", "0", "disabled"]) {
    assert.throws(() => resolveAppConfig({
      APP_HOST: "0.0.0.0",
      APP_ALLOW_UNAUTHENTICATED_LAN: value,
    }));
  }
});

test("loopback listener without a token uses compatibility mode", () => {
  const config = resolveAppConfig({ APP_HOST: "127.0.0.1" });
  const policy = createAccessPolicy(config);
  assert.equal(policy.authenticationEnabled, false);
  assert.equal(policy.localCompatibilityMode, true);
  assert.equal(policy.isAuthenticated({}), true);
});

test("protected API rejects a missing token", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: TEST_TOKEN });
  assert.deepEqual(protectedApiAccessResponse({}, policy), {
    status: 401,
    body: { ok: false, error: "未授权访问" },
  });
});

test("protected API rejects an incorrect token", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: TEST_TOKEN });
  assert.equal(protectedApiAccessResponse(bearer("incorrect-test-token"), policy)?.status, 401);
});

test("protected API accepts the correct token", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: TEST_TOKEN });
  assert.equal(protectedApiAccessResponse(bearer(), policy), null);
});

test("malformed Authorization headers are rejected", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: TEST_TOKEN });
  for (const value of [TEST_TOKEN, `Basic ${TEST_TOKEN}`, `Bearer ${TEST_TOKEN} extra`, "Bearer "]) {
    assert.equal(policy.isAuthenticated({ authorization: value }), false);
  }
  assert.equal(bearerTokenFromHeaders(bearer()), TEST_TOKEN);
});

test("constant-time comparison safely handles different byte lengths", () => {
  assert.doesNotThrow(() => constantTimeTokenEquals(TEST_TOKEN, "x"));
  assert.equal(constantTimeTokenEquals(TEST_TOKEN, "x"), false);
  assert.equal(constantTimeTokenEquals(TEST_TOKEN, TEST_TOKEN), true);
});

test("auth status exposes only non-sensitive booleans", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: TEST_TOKEN });
  const response = authenticationApiResponse({ method: "GET", pathname: "/api/auth/status", headers: bearer() }, policy);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ["authenticated", "authenticationEnabled", "localCompatibilityMode"]);
  assert.equal(response.body.authenticated, true);
  assert.equal(JSON.stringify(response).includes(TEST_TOKEN), false);
});

test("auth verify returns generic success and failure responses", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: TEST_TOKEN });
  const success = authenticationApiResponse({ method: "POST", pathname: "/api/auth/verify", headers: bearer() }, policy);
  const failure = authenticationApiResponse({ method: "POST", pathname: "/api/auth/verify", headers: bearer("wrong") }, policy);
  assert.deepEqual(success, { status: 200, body: { ok: true, authenticated: true } });
  assert.deepEqual(failure, { status: 401, body: { ok: false, error: "访问密钥错误" } });
  assert.equal(JSON.stringify(failure).includes(TEST_TOKEN), false);
});

test("startup logs and authentication errors never include the configured token", () => {
  const config = resolveAppConfig({ APP_HOST: "0.0.0.0", APP_PORT: "3101", APP_ACCESS_TOKEN: TEST_TOKEN });
  const policy = createAccessPolicy(config);
  const messages = appStartupMessages(config, policy);
  const denied = protectedApiAccessResponse(bearer("wrong"), policy);
  assert.equal(JSON.stringify({ messages, denied }).includes(TEST_TOKEN), false);
});

test("health check remains public and minimal", () => {
  const policy = createAccessPolicy({ host: "0.0.0.0", accessToken: TEST_TOKEN });
  const response = authenticationApiResponse({ method: "GET", pathname: "/api/health", headers: {} }, policy);
  assert.deepEqual(response, { status: 200, body: { ok: true } });
});

test("only health and authentication endpoints bypass the API guard", () => {
  for (const pathname of ["/api/health", "/api/auth/status", "/api/auth/verify"]) {
    assert.equal(isPublicApiPath(pathname), true);
  }
  for (const pathname of [
    "/api/deepseek/status",
    "/api/extract",
    "/api/discover-top5-and-analyze",
    "/api/chrome/navigate",
    "/api/image",
    "/api/mabang-data/collect",
    "/api/mabang-data/export",
    "/api/mabang-data/export-files/00000000-0000-0000-0000-000000000000/download",
    "/api/mabang/scheduled-tasks",
    "/api/mabang/export-files/00000000-0000-0000-0000-000000000000/download",
    "/api/files",
    "/api/files/00000000-0000-0000-0000-000000000000",
    "/api/files/00000000-0000-0000-0000-000000000000/download",
    "/api/files/lifecycle/scan",
    "/api/files/lifecycle/reports",
    "/api/files/lifecycle/summary",
    "/api/files/lifecycle/reports/00000000-0000-0000-0000-000000000000",
    "/api/files/lifecycle/reports/00000000-0000-0000-0000-000000000000/export",
    "/api/notifications/dingtalk/configs",
    "/api/ad-analyzer/status",
    "/api/ads/analyze",
  ]) {
    assert.equal(isPublicApiPath(pathname), false, pathname);
  }
});
