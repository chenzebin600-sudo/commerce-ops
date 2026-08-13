import assert from "node:assert/strict";
import test from "node:test";
import { assertShopeeWriteAuthorized, resolveShopeeWriteSecurity } from "../lib/shopee-discount/write-security.mjs";

const TRUSTED_ATTESTATION = "I_ATTEST_ALL_CREDENTIAL_HOLDERS_ARE_AUTHORIZED";

function trustedEnv(overrides = {}) {
  return {
    SHOPEE_WRITE_SECURITY_MODE: "trusted_single_role",
    SHOPEE_REAL_WRITE_ENABLED: "true",
    SHOPEE_REAL_WRITE_SWITCH_PROTECTED: "true",
    SHOPEE_WRITE_MANAGED_ATTESTATION: TRUSTED_ATTESTATION,
    SHOPEE_WRITE_COUNTRY_WHITELIST: "SG",
    SHOPEE_WRITE_SHOP_WHITELIST: "1768286475",
    SHOPEE_WRITE_MAX_BATCH_ITEMS: "10",
    ...overrides,
  };
}

function separateEnv(overrides = {}) {
  return {
    SHOPEE_WRITE_SECURITY_MODE: "separate_execute_identity",
    SHOPEE_REAL_WRITE_ENABLED: "true",
    SHOPEE_REAL_WRITE_SWITCH_PROTECTED: "true",
    SHOPEE_WRITE_COUNTRY_WHITELIST: "SG",
    SHOPEE_WRITE_SHOP_WHITELIST: "1768286475",
    SHOPEE_WRITE_MAX_BATCH_ITEMS: "10",
    ...overrides,
  };
}

test("trusted_single_role enables only with managed attestation, protected switch, private listener, whitelist, caps, and HTTPS", () => {
  const security = resolveShopeeWriteSecurity({
    env: trustedEnv(),
    listener: { host: "127.0.0.1", exposure: "private", behindTrustedProxy: false },
    relay: { url: "https://relay.internal.example" },
  });
  assert.equal(security.enabled, true);
  assert.equal(security.mode, "trusted_single_role");
  assert.equal(security.privilegedApprovalRequired, false);
  assert.equal(security.reasonCode, "SHOPEE_WRITE_ENABLED");
  assert.deepEqual(security.transportSecurity, { https: true, mtls: false, signedRequests: false, replayProtected: false });
  assert.doesNotThrow(() => assertShopeeWriteAuthorized(security, { action: "execute", identity: "shared_app_token", country: "SG", shopId: "1768286475", batchSize: 10 }));
});

test("execute authorization enforces normalized country, shop, and batch constraints and rejects missing context", () => {
  const security = resolveShopeeWriteSecurity({
    env: trustedEnv({ SHOPEE_WRITE_COUNTRY_WHITELIST: " SG,MY,SG ", SHOPEE_WRITE_SHOP_WHITELIST: "1768286475, 2,2", SHOPEE_WRITE_MAX_BATCH_ITEMS: "10" }),
    listener: { host: "127.0.0.1", exposure: "private", behindTrustedProxy: false },
    relay: { url: "https://relay.internal.example" },
  });
  assert.deepEqual(security.constraints, { countries: ["SG", "MY"], shops: ["1768286475", "2"], maxBatchItems: 10 });
  for (const context of [
    { action: "execute", identity: "shared_app_token" },
    { action: "execute", identity: "shared_app_token", country: "US", shopId: "1768286475", batchSize: 1 },
    { action: "execute", identity: "shared_app_token", country: "SG", shopId: "3", batchSize: 1 },
    { action: "execute", identity: "shared_app_token", country: "SG", shopId: "1768286475", batchSize: 11 },
  ]) {
    assert.throws(() => assertShopeeWriteAuthorized(security, context), (error) => error.code === "SHOPEE_WRITE_TARGET_NOT_AUTHORIZED");
  }
  assert.doesNotThrow(() => assertShopeeWriteAuthorized(security, { action: "execute", identity: "shared_app_token", country: "MY", shopId: "2", batchSize: 10 }));
});

test("separate_execute_identity requires trusted independent identity and privileged approval plus execution", () => {
  const security = resolveShopeeWriteSecurity({
    env: separateEnv(),
    listener: { host: "0.0.0.0", exposure: "proxy_only", behindTrustedProxy: true },
    relay: { url: "https://relay.internal.example", executeIdentity: { independent: true, trusted: true } },
  });
  assert.equal(security.enabled, true);
  assert.equal(security.mode, "separate_execute_identity");
  assert.equal(security.privilegedApprovalRequired, true);
  assert.doesNotThrow(() => assertShopeeWriteAuthorized(security, { action: "preview", identity: "shared_app_token" }));
  assert.doesNotThrow(() => assertShopeeWriteAuthorized(security, { action: "edit", identity: "shared_app_token" }));
  assert.throws(
    () => assertShopeeWriteAuthorized(security, { action: "approve", identity: "shared_app_token" }),
    (error) => error.code === "SHOPEE_WRITE_PRIVILEGED_IDENTITY_REQUIRED",
  );
  assert.throws(
    () => assertShopeeWriteAuthorized(security, { action: "execute", identity: "privileged_execute_identity", approvalIdentity: "shared_app_token", country: "SG", shopId: "1768286475", batchSize: 1 }),
    (error) => error.code === "SHOPEE_WRITE_PRIVILEGED_APPROVAL_REQUIRED",
  );
  assert.doesNotThrow(() => assertShopeeWriteAuthorized(security, {
    action: "execute",
    identity: "privileged_execute_identity",
    approvalIdentity: "privileged_execute_identity",
    country: "SG",
    shopId: "1768286475",
    batchSize: 1,
  }));
});

test("write security fails closed on invalid mode, switch, attestation, public listener, whitelist, or caps", () => {
  const cases = [
    { env: trustedEnv({ SHOPEE_WRITE_SECURITY_MODE: "shared" }), listener: { host: "127.0.0.1", exposure: "private" }, reason: "SHOPEE_WRITE_MODE_INVALID" },
    { env: trustedEnv({ SHOPEE_REAL_WRITE_ENABLED: "false" }), listener: { host: "127.0.0.1", exposure: "private" }, reason: "SHOPEE_WRITE_SWITCH_DISABLED" },
    { env: trustedEnv({ SHOPEE_REAL_WRITE_SWITCH_PROTECTED: "false" }), listener: { host: "127.0.0.1", exposure: "private" }, reason: "SHOPEE_WRITE_SWITCH_UNPROTECTED" },
    { env: trustedEnv({ SHOPEE_WRITE_MANAGED_ATTESTATION: "true" }), listener: { host: "127.0.0.1", exposure: "private" }, reason: "SHOPEE_WRITE_ATTESTATION_INVALID" },
    { env: trustedEnv(), listener: { host: "0.0.0.0", exposure: "public" }, reason: "SHOPEE_WRITE_LISTENER_MISMATCH" },
    { env: trustedEnv({ SHOPEE_WRITE_SHOP_WHITELIST: "" }), listener: { host: "127.0.0.1", exposure: "private" }, reason: "SHOPEE_WRITE_WHITELIST_INVALID" },
    { env: trustedEnv({ SHOPEE_WRITE_MAX_BATCH_ITEMS: "0" }), listener: { host: "127.0.0.1", exposure: "private" }, reason: "SHOPEE_WRITE_BATCH_CAP_INVALID" },
  ];
  for (const fixture of cases) {
    const security = resolveShopeeWriteSecurity({ env: fixture.env, listener: fixture.listener, relay: { url: "https://relay.internal.example" } });
    assert.equal(security.enabled, false, fixture.reason);
    assert.equal(security.reasonCode, fixture.reason);
    if (fixture.reason === "SHOPEE_WRITE_MODE_INVALID") assert.equal(security.mode, null);
    assert.throws(() => assertShopeeWriteAuthorized(security, { action: "execute", identity: "shared_app_token" }), (error) => error.code === "SHOPEE_WRITE_DISABLED");
  }
});

test("plain HTTP is enabled only with a complete signed-request binding and replay cache", () => {
  const signedRequestCapability = {
    bindsMethod: true,
    bindsPath: true,
    bindsTimestamp: true,
    bindsNonce: true,
    bindsBodyHash: true,
    bindsRequestId: true,
    clockWindowSeconds: 120,
    replayCache: true,
  };
  const enabled = resolveShopeeWriteSecurity({
    env: trustedEnv(),
    listener: { host: "127.0.0.1", exposure: "private" },
    relay: { url: "http://relay.internal.example", signedRequestCapability },
  });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.transportSecurity, { https: false, mtls: false, signedRequests: true, replayProtected: true });

  const missingReplay = resolveShopeeWriteSecurity({
    env: trustedEnv(),
    listener: { host: "127.0.0.1", exposure: "private" },
    relay: { url: "http://relay.internal.example", signedRequestCapability: { ...signedRequestCapability, replayCache: false } },
  });
  assert.equal(missingReplay.enabled, false);
  assert.equal(missingReplay.reasonCode, "SHOPEE_WRITE_TRANSPORT_INSECURE");
});

test("mTLS requires a TLS URL and safeStatus contains only redacted booleans, mode, and reason", () => {
  const secret = "do-not-expose-attestation-or-host";
  const security = resolveShopeeWriteSecurity({
    env: trustedEnv({ SHOPEE_WRITE_MANAGED_ATTESTATION: TRUSTED_ATTESTATION, RELAY_SECRET: secret }),
    listener: { host: "127.0.0.1", exposure: "private" },
    relay: { url: `https://${secret}.internal`, mtls: { verified: true, clientCertificate: secret } },
  });
  assert.equal(security.enabled, true);
  assert.deepEqual(security.transportSecurity, { https: true, mtls: true, signedRequests: false, replayProtected: false });
  assert.equal(JSON.stringify(security.safeStatus).includes(secret), false);
  assert.equal(JSON.stringify(security.safeStatus).includes(TRUSTED_ATTESTATION), false);
  for (const [key, value] of Object.entries(security.safeStatus)) {
    assert.ok(["boolean", "string"].includes(typeof value), key);
  }
});

test("plain HTTP cannot be enabled by an mTLS claim alone", () => {
  const security = resolveShopeeWriteSecurity({
    env: trustedEnv(),
    listener: { host: "127.0.0.1", exposure: "private" },
    relay: { url: "http://relay.internal.example", mtls: { verified: true } },
  });
  assert.equal(security.enabled, false);
  assert.equal(security.reasonCode, "SHOPEE_WRITE_TRANSPORT_INSECURE");
});

test("trusted listener requires a canonical loopback/private host or explicit trusted topology", () => {
  for (const listener of [
    { exposure: "private" },
    { host: "8.8.8.8", exposure: "private" },
    { host: "public.example.com", exposure: "private" },
    { host: "127.0.0.1:3101", exposure: "private" },
    { host: "127.000.0.1", exposure: "private" },
  ]) {
    const security = resolveShopeeWriteSecurity({ env: trustedEnv(), listener, relay: { url: "https://relay.internal.example" } });
    assert.equal(security.enabled, false);
    assert.equal(security.reasonCode, "SHOPEE_WRITE_LISTENER_MISMATCH");
  }
  const trustedTopology = resolveShopeeWriteSecurity({
    env: trustedEnv(),
    listener: { host: "ops.internal.example", trustedTopology: true },
    relay: { url: "https://relay.internal.example" },
  });
  assert.equal(trustedTopology.enabled, true);
});

test("separate identity mode fails closed without trusted proxy and independent execute identity", () => {
  const security = resolveShopeeWriteSecurity({
    env: separateEnv(),
    listener: { host: "0.0.0.0", exposure: "public", behindTrustedProxy: false },
    relay: { url: "https://relay.internal.example", executeIdentity: { independent: false, trusted: false } },
  });
  assert.equal(security.enabled, false);
  assert.equal(security.reasonCode, "SHOPEE_WRITE_EXECUTE_IDENTITY_INVALID");
});
