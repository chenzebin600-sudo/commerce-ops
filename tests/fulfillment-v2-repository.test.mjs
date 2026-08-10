import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";
import { FulfillmentV2PostgresqlProvider } from "../fulfillment-service/v2/postgresql-provider.mjs";
import { FulfillmentV2Repository } from "../fulfillment-service/v2/repository.mjs";
import { createFulfillmentDashboardProxy } from "../lib/fulfillment-dashboard-proxy.mjs";
import { createFulfillmentActorAssertion, verifyFulfillmentActorAssertion } from "../lib/security/fulfillment-actor-assertion.mjs";

const secret = "fulfillment-v2-test-secret-32-bytes-minimum";
const humanActor = Object.freeze({
  actorType: "human",
  authSource: "commerce_ops",
  externalSubject: "user:operator-001",
  displayName: "测试操作员",
});

function response() {
  return {
    status: null,
    body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = body || ""; },
  };
}

function fakeProvider({ policyMode = "manual", expiresAt = "2026-08-05T01:10:00.000Z" } = {}) {
  const calls = [];
  const transaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO fulfillment.actors")) return { rowCount: 1, rows: [{
        id: "actor-id", actor_type: values[1], auth_source: values[2], external_subject: values[3],
        display_name: values[4], status: "active",
      }] };
      if (sql.includes("FROM fulfillment.previews p")) return { rowCount: 1, rows: [{
        id: values[0], status: "pending", preview_hash: "c".repeat(64), policy_hash: "a".repeat(64),
        expires_at: expiresAt, policy_mode: policyMode,
      }] };
      if (sql.includes("INSERT INTO fulfillment.preview_approval_state")) return { rowCount: 1, rows: [] };
      if (sql.includes("UPDATE fulfillment.previews")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
  return {
    calls,
    provider: {
      async transaction(callback) { return callback(transaction); },
    },
  };
}

test("fulfillment actor assertion is signed, bounded and resistant to tampering", () => {
  const assertion = createFulfillmentActorAssertion(humanActor, {
    secret,
    requestId: "request-001",
    issuedAt: Date.parse("2026-08-05T01:00:00.000Z"),
  });
  assert.deepEqual(verifyFulfillmentActorAssertion(assertion, {
    secret,
    now: Date.parse("2026-08-05T01:00:30.000Z"),
  }), {
    ...humanActor,
    requestId: "request-001",
    issuedAt: Date.parse("2026-08-05T01:00:00.000Z"),
  });
  assert.throws(() => verifyFulfillmentActorAssertion(`${assertion.slice(0, -1)}x`, {
    secret,
    now: Date.parse("2026-08-05T01:00:30.000Z"),
  }), /signature/);
  assert.throws(() => verifyFulfillmentActorAssertion(assertion, {
    secret,
    now: Date.parse("2026-08-05T01:02:00.000Z"),
  }), /expired/);
});

test("fulfillment proxy forwards only a server-provided signed actor assertion", async () => {
  let forwarded;
  const proxy = createFulfillmentDashboardProxy({
    actorAssertionSecret: secret,
    now: () => Date.parse("2026-08-05T01:00:00.000Z"),
    fetchImpl: async (_url, options) => {
      forwarded = options.headers["x-commerce-actor-assertion"];
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });
  const request = Readable.from(["{}"]);
  request.method = "POST";
  request.headers = {};
  request.auditContext = { requestId: "request-proxy-001" };
  request.fulfillmentActor = humanActor;
  await proxy(request, response(), new URL("http://localhost/api/fulfillment-dashboard/scheduler/scan"));
  assert.equal(verifyFulfillmentActorAssertion(forwarded, {
    secret,
    now: Date.parse("2026-08-05T01:00:00.000Z"),
  }).externalSubject, humanActor.externalSubject);
});

test("V2 repository records a manual approval with the authenticated operator snapshot", async () => {
  const database = fakeProvider();
  const ids = ["actor-generated-id", "decision-generated-id"];
  const repository = new FulfillmentV2Repository({
    provider: database.provider,
    now: () => new Date("2026-08-05T01:00:00.000Z"),
    createId: () => ids.shift(),
  });
  const result = await repository.approvePreview({
    previewId: "preview-001",
    actor: humanActor,
    approvalMode: "manual",
    reasonCode: "MANUAL_APPROVAL_CONFIRMED",
    requestId: "request-approval-001",
    sourceIp: "127.0.0.1",
    userAgent: "test-agent",
  });
  assert.equal(result.id, "decision-generated-id");
  assert.equal(result.actor.externalSubject, humanActor.externalSubject);
  const approvalInsert = database.calls.find((call) => call.sql.includes("INSERT INTO fulfillment.approval_decisions"));
  assert.ok(approvalInsert);
  assert.deepEqual(approvalInsert.values.slice(4, 8), [
    "human", humanActor.externalSubject, humanActor.displayName, humanActor.authSource,
  ]);
  assert.equal(database.calls.some((call) => call.sql.includes("FOR UPDATE")), true);
  const actorUpsert = database.calls.find((call) => call.sql.includes("INSERT INTO fulfillment.actors"));
  assert.match(actorUpsert.sql, /WHERE fulfillment\.actors\.actor_type=EXCLUDED\.actor_type/);
});

test("V2 repository rejects non-human manual approval before opening a transaction", async () => {
  let transactionCalls = 0;
  const repository = new FulfillmentV2Repository({ provider: {
    async transaction() { transactionCalls += 1; },
  } });
  await assert.rejects(() => repository.approvePreview({
    previewId: "preview-001",
    approvalMode: "manual",
    actor: { ...humanActor, actorType: "service" },
    reasonCode: "INVALID",
    requestId: "request-invalid-001",
  }), /human actor/);
  assert.equal(transactionCalls, 0);
});

test("V2 repository requires approval mode to match the immutable policy", async () => {
  const database = fakeProvider({ policyMode: "automatic" });
  const repository = new FulfillmentV2Repository({
    provider: database.provider,
    now: () => new Date("2026-08-05T01:00:00.000Z"),
    createId: () => "generated-id",
  });
  await assert.rejects(() => repository.approvePreview({
    previewId: "preview-001",
    approvalMode: "manual",
    actor: humanActor,
    reasonCode: "MANUAL_APPROVAL_CONFIRMED",
    requestId: "request-policy-mismatch-001",
  }), (error) => error.code === "APPROVAL_POLICY_MISMATCH");
});

test("V2 feature flags fail closed without PostgreSQL and assertion configuration", () => {
  assert.throws(() => resolveFulfillmentConfig({ rootDir: process.cwd(), env: {
    FULFILLMENT_V2_SHADOW_WRITE_ENABLED: "true",
  } }), /requires FULFILLMENT_V2_ENABLED/);
  assert.throws(() => resolveFulfillmentConfig({ rootDir: process.cwd(), env: {
    FULFILLMENT_V2_ENABLED: "true",
    FULFILLMENT_V2_DATABASE_URL: "sqlite:test.db",
    FULFILLMENT_ACTOR_ASSERTION_SECRET: secret,
  } }), /must use PostgreSQL/);
  const enabled = resolveFulfillmentConfig({ rootDir: process.cwd(), env: {
    FULFILLMENT_V2_ENABLED: "true",
    FULFILLMENT_V2_DATABASE_URL: "postgresql://test.invalid/fulfillment",
    FULFILLMENT_ACTOR_ASSERTION_SECRET: secret,
  } });
  assert.equal(enabled.fulfillmentV2Enabled, true);
  assert.equal(enabled.fulfillmentV2ShadowWriteEnabled, false);
});

test("V2 PostgreSQL provider commits successful work and rolls back failures", async () => {
  const commands = [];
  const client = {
    async query(input) {
      const text = typeof input === "string" ? input : input.text;
      commands.push(text);
      return { rows: text.includes("schema_migrations") ? [{ version: "FULFILLMENT_V2_FOUNDATION_001" }] : [] };
    },
    release() { commands.push("RELEASE"); },
  };
  const pool = {
    async connect() { return client; },
    async query(input) { return client.query(input); },
  };
  const provider = new FulfillmentV2PostgresqlProvider({ pool });
  assert.deepEqual(await provider.readiness(), { ready: true, schemaVersion: "FULFILLMENT_V2_FOUNDATION_001" });
  await provider.transaction((transaction) => transaction.query("SELECT 1"));
  assert.deepEqual(commands.slice(-4), ["BEGIN", "SELECT 1", "COMMIT", "RELEASE"]);
  await assert.rejects(() => provider.transaction(async () => { throw new Error("test rollback"); }), /test rollback/);
  assert.deepEqual(commands.slice(-3), ["BEGIN", "ROLLBACK", "RELEASE"]);
});
