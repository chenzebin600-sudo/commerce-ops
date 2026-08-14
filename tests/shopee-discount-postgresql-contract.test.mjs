import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ShopeeDiscountRepository } from "../lib/shopee-discount/repository.mjs";
import { PostgresqlShopeeDiscountRepository } from "../lib/shopee-discount/postgresql-repository.mjs";

const PUBLIC_METHODS = [
  "getStorageMode", "getSettings", "saveSettings", "createPlan", "getPlan", "listPlans",
  "appendPlanShard", "sealPlan", "approvePlan", "markPlanState", "createJob", "getJob", "claimJob",
  "renewJobLease", "checkpointJob", "createDispatchIntent", "completeDispatchIntent",
  "markDispatchUnknown", "getDispatchIntent", "listDispatchIntents", "recordIntentOutcome", "reconcileIntent",
  "appendEvent", "createDueJob", "claimDueJobs", "renewDueJobLease", "deferDueJob", "completeDueJob", "completeJob", "bindActivityPlatformId",
  "bindFoundationPlan", "getPlanShopIds", "listPlanShards", "listPlanShardsPage", "listPlanItems", "getPlanItem", "getPlanApproval",
  "countPlanItemsByShop", "countPlanShops", "listExecutionJobs", "listPlanActivities", "listPlanActivitiesPage", "getPlanActivity", "prepareExecutionItems", "listExecutionItems",
  "listExecutionItemsPage", "listDispatchIntentsPage", "countExecutionItemsByStatus",
  "setExecutionItemStatus", "listRunsScoped", "listActivitiesScoped", "listIssuesScoped",
  "getStoredSystemActivity", "getLatestWarehouseBaseline", "saveWarehouseBaseline",
  "getApprovalSagaPhase", "recordApprovalSagaPhase",
  "createNotification", "getNotificationByDedupeKey", "claimNotificationDelivery", "markNotificationDelivery", "markNotificationUnknown",
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

test("PostgreSQL notification delivery uses persistent dedupe and compare-and-set claiming", async () => {
  const notification = {
    id: "notification-1", plan_id: null, dedupe_key: "reminder:one", notification_type: "RENEWAL_REMINDER",
    severity: "INFO", title: "Shopee Discount INFO", message: "Safe operational summary", channel: "DINGTALK_GROUP",
    delivery_status: "PENDING", attempt_count: 0, last_error_code: null, metadata_json: {}, read_at: null,
    delivered_at: null, retention_until: null, created_at: new Date("2026-08-14T00:00:00.000Z"), updated_at: new Date("2026-08-14T00:00:00.000Z"),
  };
  const provider = new RecordingProvider([
    { rows: [notification], rowCount: 1 },
    { rows: [{ ...notification, delivery_status: "SENDING", attempt_count: 1 }], rowCount: 1 },
    { rows: [{ ...notification, delivery_status: "DELIVERED", attempt_count: 1, delivered_at: new Date("2026-08-14T00:01:00.000Z") }], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-14T00:00:00.000Z") });
  await repository.createNotification({ id: "notification-1", dedupeKey: "reminder:one", planId: null,
    notificationType: "RENEWAL_REMINDER", severity: "INFO", title: "Shopee Discount INFO",
    message: "Safe operational summary", channel: "DINGTALK_GROUP", metadata: {} });
  await repository.claimNotificationDelivery({ notificationId: "notification-1", expectedAttemptCount: 0 });
  await repository.markNotificationDelivery({ notificationId: "notification-1", patch: {
    status: "DELIVERED", attemptCount: 1, deliveredAt: "2026-08-14T00:01:00.000Z",
  } });
  assert.match(provider.calls[0].text, /dedupe_key/);
  assert.match(provider.calls[1].text, /attempt_count=\$4/);
  assert.match(provider.calls[1].text, /delivery_status=ANY/);
  assert.match(provider.calls[2].text, /delivery_status='SENDING'/);
  assert.equal(provider.calls.every((call) => !call.text.includes("reminder:one")), true);
});

test("PostgreSQL expired notification send is fenced into UNKNOWN coordination without resend", async () => {
  const provider = new RecordingProvider([{ rows: [{
    id: "notification-unknown", dedupe_key: "reminder:unknown", notification_type: "RENEWAL_REMINDER",
    severity: "WARNING", title: "Shopee Discount WARNING", message: "Safe operational summary",
    channel: "DINGTALK_GROUP", delivery_status: "FAILED", attempt_count: 1,
    coordination_state: "UNKNOWN", coordination_evidence_json: { recovery: true },
    created_at: new Date("2026-08-14T00:00:00.000Z"), updated_at: new Date("2026-08-14T01:00:00.000Z"),
  }], rowCount: 1 }]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-14T01:00:00.000Z") });
  const row = await repository.markNotificationUnknown({ notificationId: "notification-unknown", evidence: { recovery: true } });
  assert.equal(row.coordinationState, "UNKNOWN");
  assert.deepEqual(row.coordinationEvidence, { recovery: true });
  assert.match(provider.calls[0].text, /delivery_lease_until<=\$3/);
  assert.match(provider.calls[0].text, /coordination_state='UNKNOWN'/);
});

test("forward notification coordination migration keeps SQLite and PostgreSQL leases parallel", async () => {
  const [sqlite, postgres] = await Promise.all([
    fs.readFile(path.resolve("migrations/031_shopee_discount_notification_coordination.sql"), "utf8"),
    fs.readFile(path.resolve("migrations/postgresql/039_shopee_discount_notification_coordination.sql"), "utf8"),
  ]);
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /delivery_lease_until/);
    assert.match(sql, /coordination_state/);
    assert.match(sql, /UNKNOWN/);
    assert.match(sql, /delivery_status[^;]*FAILED/s);
    assert.match(sql, /WHERE[^;]*delivery_status[^;]*SENDING[^;]*delivery_lease_until[^;]*NULL/s);
  }
});

test("PostgreSQL due-job deferral is owner/epoch fenced and returns unique work to PENDING", async () => {
  const provider = new RecordingProvider([{ rowCount: 1, rows: [] }]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-14T01:00:00.000Z") });
  assert.equal(await repository.deferDueJob({ dueJobId: "due-1", ownerId: "worker", epoch: 2,
    dueAt: "2026-08-14T01:00:10.000Z", result: { code: "IN_FLIGHT" }, lastErrorCode: "IN_FLIGHT" }), true);
  assert.match(provider.calls[0].text, /status='PENDING'/);
  assert.match(provider.calls[0].text, /owner_id=\$6 AND fencing_epoch=\$7/);
  assert.equal(provider.calls[0].values.includes("2026-08-14T01:00:10.000Z"), true);
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

test("PostgreSQL events normalize driver Date values to ISO strings", async () => {
  const provider = new RecordingProvider([{ rows: [{
    id: "event-1",
    occurred_at: new Date("2026-08-13T01:00:00.000Z"),
    created_at: new Date("2026-08-13T01:00:01.000Z"),
  }], rowCount: 1 }]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider });
  const event = await repository.appendEvent({ id: "event-1", eventType: "TEST" });
  assert.equal(event.occurredAt, "2026-08-13T01:00:00.000Z");
  assert.equal(event.createdAt, "2026-08-13T01:00:01.000Z");
});

test("PostgreSQL settings require an allowlisted metadata object and bind safe metadata", async () => {
  const provider = new RecordingProvider();
  const repository = new PostgresqlShopeeDiscountRepository({ provider });
  for (const metadata of ["display metadata", ["display metadata"]]) {
    await assert.rejects(repository.saveSettings({ metadata }, { actorId: "admin" }), {
      code: "SHOPEE_DISCOUNT_SETTINGS_METADATA_INVALID",
    });
  }
  for (const key of ["credential", "credentials", "privateKey", "accessKey", "key", "unknownDisplayField"]) {
    for (const metadata of [{ [key]: "plaintext-secret" }, { notes: { [key]: "nested-plaintext-secret" } }]) {
      await assert.rejects(repository.saveSettings({ metadata }, { actorId: "admin" }), {
        code: "SHOPEE_DISCOUNT_SETTINGS_METADATA_INVALID",
      });
    }
  }
  for (const metadata of [{ notes: "actual-secret" }, { warehouseKeyMask: "zndr_live_raw_warehouse_key" }]) {
    await assert.rejects(repository.saveSettings({ metadata }, { actorId: "admin" }), {
      code: "SHOPEE_DISCOUNT_SETTINGS_METADATA_INVALID",
    });
  }
  assert.equal(provider.calls.length, 0);

  const metadata = {
    warehouseKeyVerifiedAt: "2026-08-13T11:30:00.000Z",
    warehouseKeyMask: "key-…9f2a",
    catalogPermissionVerifiedAt: "2026-08-13T11:31:00.000Z",
  };
  provider.responses.push({ rows: [{
    id: "default", enabled: true, timezone: "Asia/Shanghai", metadata_json: metadata,
    created_at: new Date("2026-08-13T00:00:00.000Z"), updated_at: new Date("2026-08-13T00:00:00.000Z"),
  }], rowCount: 1 });
  const settings = await repository.saveSettings({ metadata }, { actorId: "admin" });
  assert.deepEqual(settings.metadata, metadata);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].values.includes(JSON.stringify(metadata)), true);
});

test("PostgreSQL settings redact historical credential-shaped metadata on output", async () => {
  const provider = new RecordingProvider([{ rows: [{
    id: "default", enabled: true, timezone: "Asia/Shanghai",
    metadata_json: {
      warehouseKeyVerifiedAt: "2026-08-13T11:30:00.000Z",
      warehouseKeyMask: "zndr_historical_raw_warehouse_key",
      notes: "historical free-form field",
      credentials: "historical-plaintext-secret",
      nested: { label: "unknown historical data" },
    },
    created_at: new Date("2026-08-13T00:00:00.000Z"), updated_at: new Date("2026-08-13T00:00:00.000Z"),
  }], rowCount: 1 }]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider });
  const settings = await repository.getSettings();
  assert.equal(JSON.stringify(settings).includes("historical-plaintext-secret"), false);
  assert.deepEqual(settings.metadata, {
    warehouseKeyVerifiedAt: "2026-08-13T11:30:00.000Z",
  });
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

test("PostgreSQL sealing rejects an empty Merkle root before opening a transaction", async () => {
  const provider = new RecordingProvider();
  const repository = new PostgresqlShopeeDiscountRepository({ provider });
  await assert.rejects(repository.sealPlan({
    planId: "plan-1", merkleRoot: "   ", itemCount: 1, shardCount: 1, expectedVersion: 1,
  }), /merkleRoot is required/);
  assert.equal(provider.transactions, 0);
  assert.equal(provider.calls.length, 0);
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

test("PostgreSQL dispatch fencing uses repository now while storing caller occurrence time and validates UUID", async () => {
  const provider = new RecordingProvider([
    { rows: [{ id: "job-1" }], rowCount: 1 },
    { rows: [{ attempt_no: 1 }], rowCount: 1 },
    { rows: [{
      id: "intent-1", job_id: "job-1", plan_id: "plan-1", operation_uuid: "11111111-1111-4111-8111-111111111111",
      target_type: "discount", target_key: "target-1", payload_hash: "payload-1", epoch: 1, owner_id: "worker-1",
      status: "DISPATCHED", dispatched_at: "2026-08-12T23:00:00.000Z", updated_at: "2026-08-13T00:01:00.000Z",
    }], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-13T00:01:00.000Z") });
  await assert.rejects(repository.createDispatchIntent({
    jobId: "job-1", planId: "plan-1", operationUuid: "operation-1", targetType: "discount", targetKey: "target-1",
    payloadHash: "payload-1", ownerId: "worker-1", epoch: 1,
  }), { code: "SHOPEE_DISCOUNT_OPERATION_UUID_INVALID" });
  assert.equal(provider.calls.length, 0);
  await repository.createDispatchIntent({
    id: "intent-1", jobId: "job-1", planId: "plan-1", operationUuid: "11111111-1111-4111-8111-111111111111",
    targetType: "discount", targetKey: "target-1", payloadHash: "payload-1", ownerId: "worker-1", epoch: 1,
    dispatchedAt: "2026-08-12T23:00:00.000Z",
  });
  assert.equal(provider.calls[0].values[4], "2026-08-13T00:01:00.000Z");
  assert.equal(provider.calls[2].values[11], "2026-08-12T23:00:00.000Z");
});

test("PostgreSQL dispatch intent atomically checkpoints its canonical execution item", async () => {
  const provider = new RecordingProvider([
    { rows: [{ id: "job-1" }], rowCount: 1 },
    { rows: [{ attempt_no: 1 }], rowCount: 1 },
    { rows: [{
      id: "intent-1", job_id: "job-1", plan_id: "plan-1", plan_item_id: "item-1",
      operation_uuid: "11111111-1111-4111-8111-111111111111", target_type: "discount_item",
      target_key: "shop-1:item-1:model-1", payload_hash: "payload-1", epoch: 1, owner_id: "worker-1",
      status: "DISPATCHED", dispatched_at: "2026-08-13T00:01:00.000Z", updated_at: "2026-08-13T00:01:00.000Z",
    }], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({
    provider, now: () => new Date("2026-08-13T00:01:00.000Z"),
  });
  await repository.createDispatchIntent({
    id: "intent-1", jobId: "job-1", planId: "plan-1", planItemId: "item-1",
    operationUuid: "11111111-1111-4111-8111-111111111111", targetType: "discount_item",
    targetKey: "shop-1:item-1:model-1", payloadHash: "payload-1", ownerId: "worker-1", epoch: 1,
  });
  assert.equal(provider.transactions, 1);
  assert.match(provider.calls[0].text, /FOR UPDATE/i);
  assert.match(provider.calls[3].text, /shopee_discount_execution_items/i);
  assert.match(provider.calls[3].text, /status='PENDING'/i);
  assert.deepEqual(provider.calls[3].values.slice(-3), ["job-1", "item-1", "intent-1"]);
});

test("PostgreSQL rejected intent outcomes receive a durable completion timestamp", async () => {
  const provider = new RecordingProvider([
    { rows: [{ id: "intent-1", plan_item_id: "item-1" }], rowCount: 1 },
    { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeDiscountRepository({ provider, now: () => new Date("2026-08-13T00:01:00.000Z") });
  assert.equal(await repository.recordIntentOutcome({ intentId: "intent-1", jobId: "job-1", ownerId: "worker-1", epoch: 1,
    intentStatus: "REJECTED", itemStatus: "REJECTED", reasonCode: "SHOPEE_BUSINESS_ERROR", evidence: { requestId: "request-1" } }), true);
  assert.match(provider.calls[1].text, /completed_at=CASE WHEN \$1=ANY\(ARRAY\['SUCCEEDED','REJECTED'\]\)/);
  assert.equal(provider.calls[1].values[4], "2026-08-13T00:01:00.000Z");
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
  assert.match(sql, /length\(btrim\("merkle_root"\)\)\s*>\s*0/i);
});

test("PostgreSQL execution migration stores canonical item outcomes and unique dispatch targets", async () => {
  const sql = await fs.readFile(path.resolve("migrations/postgresql/036_shopee_discount_execution.sql"), "utf8");
  assert.match(sql, /CREATE TABLE\s+"app"\."shopee_discount_execution_items"/i);
  assert.match(sql, /PRIMARY KEY\s*\(\s*"job_id"\s*,\s*"plan_item_id"\s*\)/i);
  assert.match(sql, /FOREIGN KEY\s*\(\s*"job_id"\s*\).*shopee_discount_jobs/i);
  assert.match(sql, /FOREIGN KEY\s*\(\s*"plan_item_id"\s*\).*shopee_discount_plan_items/i);
  assert.match(sql, /UNIQUE INDEX[\s\S]*"job_id"\s*,\s*"target_type"\s*,\s*"target_key"/i);
  assert.match(sql, /REQUIRES_REAPPROVAL/);
});

test("PostgreSQL forward intent migration preserves attempts and honest rejection", async () => {
  const sql = await fs.readFile(path.resolve("migrations/postgresql/037_shopee_discount_intent_attempts.sql"), "utf8");
  assert.match(sql, /ADD COLUMN "attempt_no"/);
  assert.match(sql, /'REJECTED'/);
  assert.match(sql, /uq_shopee_discount_intents_job_target_attempt/);
  assert.match(sql, /uq_shopee_discount_intents_active_target[\s\S]*WHERE "status" IN \('DISPATCHED','UNKNOWN'\)/);
  assert.doesNotMatch(sql, /UPDATE[\s\S]*operation_uuid/i);
});

test("PostgreSQL 027 has no forward foreign keys to relations first created by later migrations", async () => {
  const migrationsDir = path.resolve("migrations", "postgresql");
  const discount = await fs.readFile(path.join(migrationsDir, "027_shopee_discount.sql"), "utf8");
  const later = [
    await fs.readFile(path.join(migrationsDir, "033_shared_development_modules.sql"), "utf8"),
    await fs.readFile(path.join(migrationsDir, "034_shared_module_text_identifiers.sql"), "utf8"),
  ].join("\n");
  const laterTables = new Set([...later.matchAll(/CREATE TABLE\s+"app"\."([a-z0-9_]+)"/gi)].map((match) => match[1]));
  const forwardReferences = [...discount.matchAll(/REFERENCES\s+"app"\."([a-z0-9_]+)"/gi)]
    .map((match) => match[1]).filter((table) => laterTables.has(table));
  assert.deepEqual(forwardReferences, []);
});
