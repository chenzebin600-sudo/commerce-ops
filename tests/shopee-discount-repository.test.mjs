import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { FOUNDATION_CAPABILITIES } from "../lib/foundation/foundation-contracts.mjs";

const TABLES = [
  "shopee_discount_settings",
  "shopee_discount_activities",
  "shopee_discount_plans",
  "shopee_discount_plan_shards",
  "shopee_discount_plan_items",
  "shopee_discount_approvals",
  "shopee_discount_jobs",
  "shopee_discount_dispatch_intents",
  "shopee_discount_events",
  "shopee_discount_due_jobs",
  "shopee_discount_notifications",
];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-repository-"));
  const access = openCommerceDataAccess({
    rootDir: path.resolve("."),
    databasePath: path.join(root, "commerce.sqlite"),
    migrationsDir: path.resolve("migrations"),
  });
  return {
    access,
    db: access.provider.connection,
    repository: access.repositories.shopeeDiscount,
    async close() {
      access.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function plan(id = "plan-1", overrides = {}) {
  return {
    id,
    foundationPlanId: null,
    country: "TH",
    shopId: "shop-1",
    targetStartsAt: "2026-08-14T00:00:00.000Z",
    targetEndsAt: "2026-08-15T00:00:00.000Z",
    sourceSnapshotHash: `snapshot-${id}`,
    policyHash: `policy-${id}`,
    createdBy: "planner@example.test",
    createdAt: "2026-08-13T10:00:00.000Z",
    expiresAt: "2026-08-13T23:00:00.000Z",
    ...overrides,
  };
}

function item(sequence = 0, overrides = {}) {
  const shopId = overrides.shopId || "shop-1";
  const itemId = overrides.itemId || `item-${sequence}`;
  const modelId = overrides.modelId || `model-${sequence}`;
  return {
    id: overrides.id || `plan-item-${sequence}`,
    sequence,
    shopId,
    itemId,
    modelId,
    itemKey: `${shopId}\u001f${itemId}\u001f${modelId}`,
    sku: `SKU-${sequence}`,
    currency: "THB",
    scale: 2,
    currentPriceMinor: "129900",
    controlPriceMinor: "119900",
    targetPriceMinor: "119900",
    payloadHash: `payload-${sequence}`,
    payload: { discountName: "Daily Price Match" },
    ...overrides,
  };
}

const OPERATION_UUID = "11111111-1111-4111-8111-111111111111";

async function appendAndSeal(repository, planId = "plan-1", merkleRoot = "root-1") {
  await repository.appendPlanShard({
    planId,
    shardIndex: 0,
    shardHash: "shard-0",
    items: [item(0)],
  });
  return repository.sealPlan({ planId, merkleRoot, itemCount: 1, shardCount: 1, expectedVersion: 1 });
}

test("migration registers every Shopee Discount table and both data-access storage modes", async () => {
  const context = await fixture();
  try {
    const actual = context.db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'shopee_discount_%' ORDER BY name`).all().map(({ name }) => name);
    assert.deepEqual(actual, [...TABLES].sort());
    assert.ok(context.repository);
    assert.deepEqual(await context.repository.getStorageMode(), {
      dialect: "sqlite",
      productionScale: false,
      pilotLimits: { shops: 1, variants: 10 },
    });
  } finally {
    await context.close();
  }
});

test("Foundation accepts discount integration-account capabilities", async () => {
  const context = await fixture();
  try {
    assert.equal(FOUNDATION_CAPABILITIES.includes("discount.read"), true);
    assert.equal(FOUNDATION_CAPABILITIES.includes("discount.write"), true);
    await context.access.repositories.foundation.upsertAccount({
      id: "discount-account", sourceSystem: "mabang", displayName: "Discount integration",
      credentialRefType: "none", status: "active", metadata: {},
    });
    await context.access.repositories.foundation.upsertCapability("discount-account", "discount.read");
    await context.access.repositories.foundation.upsertCapability("discount-account", "discount.write");
    const capabilities = context.db.prepare(`SELECT capability_code FROM foundation_account_capabilities
      WHERE account_id=? ORDER BY capability_code`).all("discount-account").map(({ capability_code }) => capability_code);
    assert.deepEqual(capabilities, ["discount.read", "discount.write"]);
  } finally {
    await context.close();
  }
});

test("plan shards are transactional, contiguous, and immutable after sealing", async () => {
  const context = await fixture();
  try {
    const repository = context.repository;
    assert.equal((await repository.createPlan(plan())).state, "PREVIEWING");
    await repository.appendPlanShard({ planId: "plan-1", shardIndex: 0, shardHash: "shard-0", items: [item(0)] });
    await repository.appendPlanShard({ planId: "plan-1", shardIndex: 2, shardHash: "shard-2", items: [item(2)] });
    await assert.rejects(
      repository.sealPlan({ planId: "plan-1", merkleRoot: "root", itemCount: 2, shardCount: 2, expectedVersion: 1 }),
      { code: "SHOPEE_DISCOUNT_SHARDS_NOT_CONTIGUOUS" },
    );
    await repository.appendPlanShard({ planId: "plan-1", shardIndex: 1, shardHash: "shard-1", items: [item(1)] });
    const sealed = await repository.sealPlan({ planId: "plan-1", merkleRoot: "root", itemCount: 3, shardCount: 3, expectedVersion: 1 });
    assert.equal(sealed.state, "PREVIEWED");
    await assert.rejects(
      repository.appendPlanShard({ planId: "plan-1", shardIndex: 3, shardHash: "shard-3", items: [item(3)] }),
      { code: "SHOPEE_DISCOUNT_PLAN_IMMUTABLE" },
    );
    assert.throws(() => context.db.prepare("UPDATE shopee_discount_plan_items SET target_price_minor='1' WHERE id='plan-item-0'").run(), /immutable/i);
  } finally {
    await context.close();
  }
});

test("database plan-state invariant rejects an empty sealed Merkle root", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    assert.throws(() => context.db.prepare(`UPDATE shopee_discount_plans
      SET state='PREVIEWED',merkle_root='' WHERE id=?`).run("plan-1"), /CHECK constraint failed/);
  } finally {
    await context.close();
  }
});

test("duplicate item identity rolls back its entire shard", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    await assert.rejects(context.repository.appendPlanShard({
      planId: "plan-1",
      shardIndex: 0,
      shardHash: "duplicate-shard",
      items: [item(0), item(1, { itemId: "item-0", modelId: "model-0", itemKey: "shop-1\u001fitem-0\u001fmodel-0" })],
    }), /UNIQUE|duplicate/i);
    assert.equal(context.db.prepare("SELECT COUNT(*) count FROM shopee_discount_plan_shards WHERE plan_id=?").get("plan-1").count, 0);
    assert.equal(context.db.prepare("SELECT COUNT(*) count FROM shopee_discount_plan_items WHERE plan_id=?").get("plan-1").count, 0);
  } finally {
    await context.close();
  }
});

test("approval binds the exact stored Merkle root and optimistic version once", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    await appendAndSeal(context.repository);
    await assert.rejects(context.repository.approvePlan({
      planId: "plan-1", merkleRoot: "wrong-root", policyHash: "policy-plan-1",
      approval: { id: "approval-wrong", actorId: "approver", mode: "human", approvedAt: "2026-08-13T12:00:00.000Z" }, expectedVersion: 2,
    }), { code: "SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH" });
    const approved = await context.repository.approvePlan({
      planId: "plan-1", merkleRoot: "root-1", policyHash: "policy-plan-1",
      approval: { id: "approval-1", actorId: "approver", mode: "human", approvedAt: "2026-08-13T12:00:00.000Z" }, expectedVersion: 2,
    });
    assert.equal(approved.state, "APPROVED");
    assert.equal(approved.stateVersion, 3);
    await assert.rejects(context.repository.approvePlan({
      planId: "plan-1", merkleRoot: "root-1", policyHash: "policy-plan-1",
      approval: { id: "approval-2", actorId: "approver-2", mode: "human" }, expectedVersion: 2,
    }), { code: "SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT" });
  } finally {
    await context.close();
  }
});

test("plan state changes enforce the execution lifecycle", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    await appendAndSeal(context.repository);
    await context.repository.approvePlan({
      planId: "plan-1", merkleRoot: "root-1", policyHash: "policy-plan-1",
      approval: { id: "approval-1", actorId: "approver", mode: "human" }, expectedVersion: 2,
    });
    await assert.rejects(context.repository.markPlanState({
      planId: "plan-1", fromState: "APPROVED", toState: "SUCCEEDED", expectedVersion: 3,
    }), { code: "SHOPEE_DISCOUNT_PLAN_TRANSITION_INVALID" });
    const executing = await context.repository.markPlanState({
      planId: "plan-1", fromState: "APPROVED", toState: "EXECUTING", expectedVersion: 3,
    });
    assert.equal(executing.state, "EXECUTING");
  } finally {
    await context.close();
  }
});

test("same-shop overlapping active target windows cannot have two plans", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    await assert.rejects(context.repository.createPlan(plan("plan-2", {
      targetStartsAt: "2026-08-14T12:00:00.000Z",
      targetEndsAt: "2026-08-16T00:00:00.000Z",
    })), { code: "SHOPEE_DISCOUNT_ACTIVE_WINDOW_CONFLICT" });
    const nonOverlapping = await context.repository.createPlan(plan("plan-3", {
      targetStartsAt: "2026-08-15T00:00:00.000Z",
      targetEndsAt: "2026-08-16T00:00:00.000Z",
    }));
    assert.equal(nonOverlapping.id, "plan-3");
  } finally {
    await context.close();
  }
});

test("job leases use fencing epochs for renewal and checkpoints", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    await context.repository.createJob({ id: "job-1", planId: "plan-1", jobType: "EXECUTE", createdBy: "scheduler" });
    const claim = await context.repository.claimJob({ jobId: "job-1", ownerId: "worker-a", leaseMs: 30_000 });
    assert.equal(claim.claimed, true);
    assert.equal(claim.epoch, 1);
    assert.equal((await context.repository.claimJob({ jobId: "job-1", ownerId: "worker-a", leaseMs: 30_000 })).epoch, 1);
    assert.equal(await context.repository.renewJobLease({ jobId: "job-1", ownerId: "worker-a", epoch: 1, leaseMs: 30_000 }), true);
    assert.equal(await context.repository.renewJobLease({ jobId: "job-1", ownerId: "worker-b", epoch: 1, leaseMs: 30_000 }), false);
    assert.equal(await context.repository.checkpointJob({ jobId: "job-1", ownerId: "worker-a", epoch: 0, cursor: { shard: 0 }, counters: { succeeded: 1 } }), false);
    assert.equal(await context.repository.checkpointJob({ jobId: "job-1", ownerId: "worker-a", epoch: 1, cursor: { shard: 0 }, counters: { succeeded: 1 } }), true);
    context.db.prepare("UPDATE shopee_discount_jobs SET lease_until=? WHERE id=?").run("2000-01-01T00:00:00.000Z", "job-1");
    const takeover = await context.repository.claimJob({ jobId: "job-1", ownerId: "worker-b", leaseMs: 30_000 });
    assert.equal(takeover.claimed, true);
    assert.equal(takeover.epoch, 2);
    assert.equal(await context.repository.checkpointJob({ jobId: "job-1", ownerId: "worker-a", epoch: 1, cursor: {}, counters: {} }), false);
  } finally {
    await context.close();
  }
});

test("dispatch intent is durable before completion and has one-way UNKNOWN reconciliation", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    await context.repository.createJob({ id: "job-1", planId: "plan-1", jobType: "EXECUTE", createdBy: "scheduler" });
    const claim = await context.repository.claimJob({ jobId: "job-1", ownerId: "worker-a", leaseMs: 30_000 });
    const intent = await context.repository.createDispatchIntent({
      id: "intent-1", jobId: "job-1", planId: "plan-1", operationUuid: OPERATION_UUID,
      targetType: "discount", targetKey: "shop-1\u001fitem-0\u001fmodel-0", payloadHash: "payload-0",
      ownerId: "worker-a", epoch: claim.epoch,
    });
    assert.equal(intent.status, "DISPATCHED");
    assert.equal(await context.repository.completeDispatchIntent({
      intentId: "intent-1", ownerId: "worker-a", epoch: 0, platformObjectId: "discount-1", readback: { verified: true },
    }), false);
    assert.equal(await context.repository.markDispatchUnknown({
      intentId: "intent-1", ownerId: "worker-a", epoch: claim.epoch, evidence: { reason: "timeout" },
    }), true);
    await assert.rejects(context.repository.reconcileIntent({
      intentId: "intent-1", resolution: "DISPATCHED", evidence: { source: "readback" }, actor: { id: "operator" },
    }), { code: "SHOPEE_DISCOUNT_RECONCILIATION_INVALID" });
    const reconciled = await context.repository.reconcileIntent({
      intentId: "intent-1", resolution: "CONFIRMED_NOT_SENT", evidence: { source: "platform-list" }, actor: { id: "operator" },
    });
    assert.equal(reconciled.status, "CONFIRMED_NOT_SENT");
    await assert.rejects(context.repository.reconcileIntent({
      intentId: "intent-1", resolution: "ABANDONED", evidence: { source: "operator" }, actor: { id: "operator" },
    }), { code: "SHOPEE_DISCOUNT_RECONCILIATION_CLOSED" });
  } finally {
    await context.close();
  }
});

test("dispatch intent rejects invalid UUIDs and backdated occurrence times cannot bypass an expired lease", async () => {
  const context = await fixture();
  try {
    await context.repository.createPlan(plan());
    await context.repository.createJob({ id: "job-1", planId: "plan-1", jobType: "EXECUTE", createdBy: "scheduler" });
    const claim = await context.repository.claimJob({ jobId: "job-1", ownerId: "worker-a", leaseMs: 30_000 });
    await assert.rejects(context.repository.createDispatchIntent({
      id: "intent-invalid", jobId: "job-1", planId: "plan-1", operationUuid: "operation-1",
      targetType: "discount", targetKey: "target-1", payloadHash: "payload-1", ownerId: "worker-a", epoch: claim.epoch,
    }), { code: "SHOPEE_DISCOUNT_OPERATION_UUID_INVALID" });
    context.db.prepare("UPDATE shopee_discount_jobs SET lease_until=? WHERE id=?").run("2000-01-01T00:00:00.000Z", "job-1");
    await assert.rejects(context.repository.createDispatchIntent({
      id: "intent-backdated", jobId: "job-1", planId: "plan-1", operationUuid: "22222222-2222-4222-8222-222222222222",
      targetType: "discount", targetKey: "target-1", payloadHash: "payload-1", ownerId: "worker-a", epoch: claim.epoch,
      dispatchedAt: "1999-01-01T00:00:00.000Z",
    }), { code: "SHOPEE_DISCOUNT_STALE_EPOCH" });
  } finally {
    await context.close();
  }
});

test("settings persist encrypted warehouse references and never accept or return plaintext credentials", async () => {
  const context = await fixture();
  try {
    await assert.rejects(context.repository.saveSettings({ warehouseKey: "plaintext-secret" }, { actorId: "admin" }), {
      code: "SHOPEE_DISCOUNT_PLAINTEXT_SECRET_REJECTED",
    });
    await assert.rejects(context.repository.saveSettings({
      metadata: { integration: { api_key: "nested-plaintext-secret" } },
    }, { actorId: "admin" }), { code: "SHOPEE_DISCOUNT_PLAINTEXT_SECRET_REJECTED" });
    const settings = await context.repository.saveSettings({
      encryptedWarehouseKeyCiphertext: "ciphertext-value",
      warehouseKeyReference: "vault://commerce/shopee-discount",
      warehouseKeyHint: "key-…9f2a",
      timezone: "Asia/Shanghai",
      enabled: true,
    }, { actorId: "admin", occurredAt: "2026-08-13T12:00:00.000Z" });
    assert.equal(settings.encryptedWarehouseKeyCiphertext, "ciphertext-value");
    assert.equal(settings.warehouseKeyReference, "vault://commerce/shopee-discount");
    assert.equal(settings.warehouseKeyHint, "key-…9f2a");
    assert.equal(Object.hasOwn(settings, "warehouseKey"), false);
    assert.equal(JSON.stringify(settings).includes("plaintext-secret"), false);
    assert.deepEqual(await context.repository.getSettings(), settings);
    context.db.prepare("UPDATE shopee_discount_settings SET metadata_json=? WHERE id='default'").run(
      JSON.stringify({ integration: { access_token: "historical-plaintext-secret", label: "safe" } }),
    );
    const sanitized = await context.repository.getSettings();
    assert.equal(JSON.stringify(sanitized).includes("historical-plaintext-secret"), false);
    assert.equal(sanitized.metadata.integration.label, "safe");
  } finally {
    await context.close();
  }
});
