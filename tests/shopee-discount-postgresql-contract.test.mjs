import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ShopeeDiscountRepository } from "../lib/shopee-discount/repository.mjs";
import { PostgresqlShopeeDiscountRepository } from "../lib/shopee-discount/postgresql-repository.mjs";

const PUBLIC_METHODS = [
  "getStorageMode", "getSettings", "saveSettings", "createPlan", "getPlan", "listPlans",
  "appendPlanShard", "sealPlan", "approvePlan", "markPlanState", "createJob", "claimJob",
  "renewJobLease", "checkpointJob", "createDispatchIntent", "completeDispatchIntent",
  "markDispatchUnknown", "reconcileIntent", "appendEvent", "createDueJob", "claimDueJobs", "completeDueJob",
];

class RecordingProvider {
  constructor(responses = []) {
    this.config = { schema: "app" };
    this.responses = [...responses];
    this.calls = [];
    this.transactions = 0;
  }
  async query(text, values = []) {
    this.calls.push({ kind: "query", text, values });
    return this.responses.shift() || { rows: [], rowCount: 0 };
  }
  async execute(text, values = []) {
    this.calls.push({ kind: "execute", text, values });
    return this.responses.shift() || { rows: [], rowCount: 0 };
  }
  async transaction(callback) {
    this.transactions += 1;
    return callback(this);
  }
}

function row(overrides = {}) {
  return {
    id: "plan-1", foundation_plan_id: null, country: "TH", state: "PREVIEWING",
    target_starts_at: "2026-08-14T00:00:00.000Z", target_ends_at: "2026-08-15T00:00:00.000Z",
    source_snapshot_hash: "snapshot-1", policy_hash: "policy-1", merkle_root: null,
    item_count: 0, shard_count: 0, state_version: 1, reason_code: null, expires_at: null,
    sealed_at: null, approved_at: null, created_by: "planner", retention_until: "2036-08-13T00:00:00.000Z",
    summary_json: {}, created_at: "2026-08-13T00:00:00.000Z", updated_at: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

test("PostgreSQL adapter exposes the complete SQLite interface and production capacity", async () => {
  const sqliteMethods = Object.getOwnPropertyNames(ShopeeDiscountRepository.prototype).filter((name) => name !== "constructor").sort();
  const postgresMethods = Object.getOwnPropertyNames(PostgresqlShopeeDiscountRepository.prototype).filter((name) => name !== "constructor").sort();
  assert.deepEqual(sqliteMethods, [...PUBLIC_METHODS].sort());
  assert.deepEqual(postgresMethods, [...PUBLIC_METHODS].sort());
  assert.deepEqual(await new PostgresqlShopeeDiscountRepository({ provider: new RecordingProvider() }).getStorageMode(), {
    dialect: "postgres", productionScale: true, pilotLimits: null,
  });
});

test("PostgreSQL row dates are normalized to ISO strings", async () => {
  const provider = new RecordingProvider([{ rows: [row({
    target_starts_at: new Date("2026-08-14T00:00:00.000Z"),
    target_ends_at: new Date("2026-08-15T00:00:00.000Z"),
    created_at: new Date("2026-08-13T00:00:00.000Z"),
    updated_at: new Date("2026-08-13T00:00:00.000Z"),
  })], rowCount: 1 }]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider });
  const plan = await repository.getPlan("plan-1");
  assert.equal(plan.targetStartsAt, "2026-08-14T00:00:00.000Z");
  assert.equal(plan.targetEndsAt, "2026-08-15T00:00:00.000Z");
  assert.equal(plan.createdAt, "2026-08-13T00:00:00.000Z");
});

test("PostgreSQL plan state changes reject lifecycle shortcuts before SQL", async () => {
  const provider = new RecordingProvider();
  const repository = new PostgresqlShopeeDiscountRepository({ provider });
  await assert.rejects(repository.markPlanState({
    planId: "plan-1", fromState: "APPROVED", toState: "SUCCEEDED", expectedVersion: 3,
  }), { code: "SHOPEE_DISCOUNT_PLAN_TRANSITION_INVALID" });
  assert.equal(provider.calls.length, 0);
});

test("PostgreSQL plan creation serializes each shop guard and binds hostile values", async () => {
  const provider = new RecordingProvider([
    { rows: [{ locked: null }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [row()], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-13T00:00:00.000Z") });
  await repository.createPlan({
    id: "plan-1", country: "TH", shopId: "shop-'quoted", targetStartsAt: "2026-08-14T00:00:00.000Z",
    targetEndsAt: "2026-08-15T00:00:00.000Z", sourceSnapshotHash: "snapshot-1", policyHash: "policy-1", createdBy: "planner",
  });
  assert.equal(provider.transactions, 1);
  assert.match(provider.calls[0].text, /pg_advisory_xact_lock|FOR UPDATE/i);
  assert.match(provider.calls[1].text, /target_starts_at\s*<\s*\$2/i);
  assert.match(provider.calls[1].text, /target_ends_at\s*>\s*\$3/i);
  assert.equal(provider.calls.every(({ text }) => !text.includes("shop-'quoted")), true);
  assert.equal(provider.calls.some(({ values }) => values.includes("shop-'quoted")), true);
});

test("PostgreSQL shard append uses one transaction and one parameterized item batch", async () => {
  const provider = new RecordingProvider([
    { rows: [{ id: "plan-1", state: "PREVIEWING" }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 2 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-13T00:00:00.000Z") });
  await repository.appendPlanShard({
    planId: "plan-1", shardIndex: 0, shardHash: "shard-0",
    items: [0, 1].map((sequence) => ({
      id: `item-${sequence}`, sequence, shopId: "shop-1", itemId: `product-${sequence}`, modelId: `model-${sequence}`,
      itemKey: `shop-1\u001fproduct-${sequence}\u001fmodel-${sequence}`, sku: `SKU-${sequence}`,
      currency: "THB", scale: 2, currentPriceMinor: "129900", controlPriceMinor: "119900",
      targetPriceMinor: "119900", payloadHash: `payload-${sequence}`, payload: { sequence },
    })),
  });
  assert.equal(provider.transactions, 1);
  const inserts = provider.calls.filter(({ text }) => /INSERT INTO .*shopee_discount_plan_items/i.test(text));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].text, /\$1/);
  assert.match(inserts[0].text, /\$38/);
  assert.equal(inserts[0].text.includes("129900"), false);
  assert.equal(inserts[0].values.includes("129900"), true);
});

test("PostgreSQL claim and fenced writes lock rows and include owner plus epoch predicates", async () => {
  const provider = new RecordingProvider([
    { rows: [{ id: "job-1", status: "PENDING", owner_id: null, fencing_epoch: 0, lease_until: null }], rowCount: 1 },
    { rows: [{ fencing_epoch: 1, lease_until: "2026-08-13T00:01:00.000Z" }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-13T00:00:00.000Z") });
  const claim = await repository.claimJob({ jobId: "job-1", ownerId: "worker-1", leaseMs: 60_000 });
  assert.equal(claim.epoch, 1);
  await repository.renewJobLease({ jobId: "job-1", ownerId: "worker-1", epoch: 1, leaseMs: 60_000 });
  await repository.checkpointJob({ jobId: "job-1", ownerId: "worker-1", epoch: 1, cursor: {}, counters: {} });
  await repository.markDispatchUnknown({ intentId: "intent-1", ownerId: "worker-1", epoch: 1, evidence: { timeout: true } });
  assert.match(provider.calls[0].text, /FOR UPDATE/);
  for (const call of provider.calls.slice(2)) {
    assert.match(call.text, /owner_id\s*=\s*\$/i);
    assert.match(call.text, /(?:fencing_epoch|epoch)\s*=\s*\$/i);
    assert.equal(call.text.includes("worker-1"), false);
  }
});

test("PostgreSQL due-job claims use skip-locked ordering and conditional updates", async () => {
  const provider = new RecordingProvider([
    { rows: [{ id: "due-1", fencing_epoch: 0 }], rowCount: 1 },
    { rows: [{
      id: "due-1", job_type: "SCAN", dedupe_key: "scan:1", due_at: "2026-08-13T00:00:00.000Z",
      status: "CLAIMED", owner_id: "scheduler-1", fencing_epoch: 1, lease_until: "2026-08-13T00:01:00.000Z",
      payload_json: {}, result_json: {}, created_at: "2026-08-12T00:00:00.000Z", updated_at: "2026-08-13T00:00:00.000Z",
    }], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider });
  await repository.claimDueJobs({ now: "2026-08-13T00:00:00.000Z", limit: 10, ownerId: "scheduler-1" });
  assert.equal(provider.transactions, 1);
  assert.match(provider.calls[0].text, /LIMIT \$2 FOR UPDATE SKIP LOCKED/i);
  assert.match(provider.calls[1].text, /fencing_epoch\s*=\s*\$\d+/i);
  assert.equal(provider.calls.every(({ text }) => !text.includes("scheduler-1")), true);
});

test("PostgreSQL migration keeps money textual and adds partial operational indexes", async () => {
  const sql = await fs.readFile(path.resolve("migrations/postgresql/027_shopee_discount.sql"), "utf8");
  assert.doesNotMatch(sql, /(?:price|amount)[^,\n]*(?:real|double precision|numeric|decimal)/i);
  assert.match(sql, /current_price_minor"?\s+text/i);
  assert.match(sql, /target_price_minor"?\s+text/i);
  assert.match(sql, /WHERE\s+"?status"?\s+IN\s*\(/i);
  assert.match(sql, /shopee_discount_due_jobs/i);
  assert.match(sql, /shopee_discount_dispatch_intents/i);
});
