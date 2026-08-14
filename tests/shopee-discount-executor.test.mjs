import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { foundationContentHash } from "../lib/foundation/foundation-contracts.mjs";
import { buildApprovalRoot } from "../lib/shopee-discount/approval-hash.mjs";
import { buildRenewalActivityIdentity } from "../lib/shopee-discount/renewal-activity.mjs";
import { ShopeeWriteAdapter } from "../lib/shopee-discount/shopee-write-adapter.mjs";

const START = "2026-08-14T00:00:00.000Z";
const ACTOR = "approved-operator";

function approvalItem(overrides = {}) {
  return {
    shop_id: "1",
    item_id: "100",
    model_id: "1000",
    country: "TH",
    sku: "SKU-1",
    original_minor: "129900",
    target_minor: "119900",
    price_source: "WAREHOUSE",
    price_tier: "DAILY",
    rule_source: "COUNTRY_DEFAULT",
    warehouse_watermark: "2026-08-13T23:00:00.000Z",
    warehouse_approved_at: "2026-08-13T22:00:00.000Z",
    activity_type: "CURRENT_CORRECTION",
    target_discount_id: "900",
    renewal_discount_name: null,
    renewal_marker: null,
    renewal_price_tier: null,
    renewal_starts_at: null,
    renewal_ends_at: null,
    renewal_fingerprint: null,
    ...overrides,
  };
}

async function fixture({ workflow = "CURRENT_CORRECTION", approvalItems = [approvalItem()] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-executor-"));
  const access = openCommerceDataAccess({
    rootDir: path.resolve("."),
    databasePath: path.join(root, "commerce.sqlite"),
    migrationsDir: path.resolve("migrations"),
  });
  const clock = {
    value: new Date(START),
    now() { return new Date(this.value); },
    advance(ms) { this.value = new Date(this.value.getTime() + ms); },
  };
  const repository = access.repositories.shopeeDiscount;
  repository.now = () => clock.now();
  const foundation = new FoundationService({ repository: access.repositories.foundation, now: () => clock.now() });
  const policy = { contractVersion: 1, writeGate: "strict" };
  const policyHash = foundationContentHash(policy);
  const planId = `plan-${workflow.toLowerCase()}`;
  const targetStartsAt = "2026-08-15T00:00:00.000Z";
  const targetEndsAt = "2026-09-14T00:00:00.000Z";
  const approvedItems = approvalItems.map((item) => {
    if (workflow !== "NEXT_RENEWAL") return item;
    const identity = buildRenewalActivityIdentity({
      planId, country: "TH", shopId: item.shop_id, priceTier: item.price_tier, targetStartsAt, targetEndsAt,
    });
    return {
      ...item,
      activity_type: workflow,
      target_discount_id: null,
      renewal_discount_name: identity.discountName,
      renewal_marker: identity.marker,
      renewal_price_tier: identity.priceTier,
      renewal_starts_at: targetStartsAt,
      renewal_ends_at: targetEndsAt,
      renewal_fingerprint: identity.fingerprint,
    };
  });
  const approvalHash = buildApprovalRoot(approvedItems, { shardSize: 2 });
  const confirmationText = `confirm ${workflow}`;
  const sourceSnapshot = { merkleRoot: approvalHash.root, shopIds: [...new Set(approvedItems.map((item) => item.shop_id))] };
  const foundationPlan = await foundation.operationPlans.create({
    id: `foundation-${workflow.toLowerCase()}`,
    operationType: "SHOPEE.DISCOUNT.PRICE_MATCH",
    scope: { country: "TH", shopIds: sourceSnapshot.shopIds, workflow },
    sourceSnapshot,
    policy,
    items: [],
    summary: { merkleRoot: approvalHash.root },
    approvalMode: "human",
    approvalText: confirmationText,
    ttlMs: 60 * 60_000,
    createdBy: ACTOR,
  });
  const activities = sourceSnapshot.shopIds.map((shopId) => ({
    shopId,
    activityType: workflow,
    platformActivityId: workflow === "CURRENT_CORRECTION" ? "900" : null,
    targetStartsAt,
    targetEndsAt,
    metadata: workflow === "NEXT_RENEWAL"
      ? buildRenewalActivityIdentity({ planId, country: "TH", shopId, priceTier: "DAILY", targetStartsAt, targetEndsAt })
      : { workflow, targetDiscountId: "900" },
  }));
  let domainPlan = await repository.createPlan({
    id: planId,
    foundationPlanId: foundationPlan.id,
    country: "TH",
    activities,
    targetStartsAt,
    targetEndsAt,
    sourceSnapshotHash: foundationPlan.sourceSnapshotHash,
    policyHash,
    createdBy: ACTOR,
    expiresAt: "2026-08-14T01:00:00.000Z",
    summary: { merkleRoot: approvalHash.root },
  });
  const persistedItems = approvedItems.map((item, sequence) => ({
      id: `plan-item-${sequence}`,
      sequence,
      shopId: item.shop_id,
      itemId: item.item_id,
      modelId: item.model_id,
      sku: item.sku,
      currency: "THB",
      scale: 2,
      currentPriceMinor: item.target_minor,
      controlPriceMinor: item.target_minor,
      targetPriceMinor: item.target_minor,
      payloadHash: `payload-${sequence}`,
      payload: {
        priceTier: item.price_tier,
        priceSource: item.price_source,
        ruleSource: item.rule_source,
        originalMinor: item.original_minor,
        warehouseWatermark: item.warehouse_watermark,
        warehouseApprovedAt: item.warehouse_approved_at,
        approvalTarget: {
          activityType: item.activity_type,
          targetDiscountId: item.target_discount_id,
          renewalDiscountName: item.renewal_discount_name,
          renewalMarker: item.renewal_marker,
          renewalPriceTier: item.renewal_price_tier,
          renewalStartsAt: item.renewal_starts_at,
          renewalEndsAt: item.renewal_ends_at,
          renewalFingerprint: item.renewal_fingerprint,
        },
        stock: 10,
        activity: workflow === "CURRENT_CORRECTION" ? { discountId: "900" } : null,
      },
    }));
  for (let shardIndex = 0; shardIndex < approvalHash.shardHashes.length; shardIndex += 1) {
    await repository.appendPlanShard({
      planId: domainPlan.id,
      shardIndex,
      shardHash: approvalHash.shardHashes[shardIndex],
      items: persistedItems.slice(shardIndex * 2, (shardIndex + 1) * 2),
    });
  }
  domainPlan = await repository.sealPlan({
    planId: domainPlan.id,
    merkleRoot: approvalHash.root,
    itemCount: approvedItems.length,
    shardCount: approvalHash.shardHashes.length,
    expectedVersion: domainPlan.stateVersion,
  });
  domainPlan = await repository.approvePlan({
    planId: domainPlan.id,
    merkleRoot: approvalHash.root,
    policyHash,
    approval: {
      actorId: ACTOR,
      actorName: "Approved Operator",
      evidence: { confirmationText, approvalIdentity: null },
    },
    expectedVersion: domainPlan.stateVersion,
  });
  const approvedFoundation = await foundation.operationPlans.approve(foundationPlan.id, {
    planHash: foundationPlan.planHash,
    approvalText: confirmationText,
    actorType: "user",
    actorId: ACTOR,
  });
  await repository.recordApprovalSagaPhase(domainPlan.id, "BOTH_APPROVED", {
    foundationPlanId: approvedFoundation.id,
    foundationPlanHash: approvedFoundation.planHash,
  });
  const job = await repository.createJob({
    id: `execute-${workflow.toLowerCase()}`,
    planId: domainPlan.id,
    jobType: "EXECUTE",
    input: { planId: domainPlan.id, merkleRoot: approvalHash.root, policyHash },
    createdBy: ACTOR,
  });
  const calls = [];
  const hooks = {};
  const workerContext = {
    repository,
    foundation,
    workerId: "worker-1",
    requestId: "request-1",
    identity: "trusted-worker",
    currentPolicyHash: policyHash,
    leaseMs: 1_000,
    writeSecurity: () => ({
      enabled: true,
      mode: "trusted_single_role",
      constraints: { countries: ["TH"], shops: sourceSnapshot.shopIds, maxBatchItems: 10 },
    }),
    storageLimits: { maxShops: 1, maxVariants: 10 },
    siteCapability: { priceScale: 2, maxAddItems: 10 },
    readers: {
      async findActivityByMarker() { return null; },
      async getShopAuthorization({ shopId }) { return { authorized: sourceSnapshot.shopIds.includes(shopId) }; },
      async getWarehouseState({ item }) {
        return {
          targetPriceMinor: item.targetPriceMinor,
          watermark: item.payload.warehouseWatermark,
          approvedAt: item.payload.warehouseApprovedAt,
        };
      },
      async getListingState({ item }) {
        return { status: "ACTIVE", sku: item.sku, originalPriceMinor: item.payload.originalMinor };
      },
      async getDiscountState({ activity }) {
        return { conflict: false, activityId: activity.platformActivityId || "901", membership: workflow === "CURRENT_CORRECTION" };
      },
      async readbackIntent({ intent, item, activity }) {
        return {
          verified: true,
          operationUuid: intent.operationUuid,
          payloadHash: intent.payloadHash,
          activityId: activity.platformActivityId || "901",
          platformObjectId: activity.platformActivityId || "901",
          markerVerified: item == null,
          shopId: activity.shopId,
          discountName: activity.metadata.discountName,
          marker: activity.metadata.marker,
          fingerprint: activity.metadata.fingerprint,
          startTime: String(new Date(activity.startsAt).getTime() / 1000),
          endTime: String(new Date(activity.endsAt).getTime() / 1000),
          membership: true,
          itemId: item?.itemId ?? null,
          modelId: item?.modelId ?? null,
          priceMinor: item?.targetPriceMinor ?? null,
        };
      },
    },
    shopeeWrite: {
      async createDiscount(input) { await hooks.beforeWrite?.("createDiscount", input); calls.push({ operation: "createDiscount", input }); return { data: { discount_id: "901" } }; },
      async addDiscountItems(input) { await hooks.beforeWrite?.("addDiscountItems", input); calls.push({ operation: "addDiscountItems", input }); return { data: {} }; },
      async updateDiscountItems(input) { await hooks.beforeWrite?.("updateDiscountItems", input); calls.push({ operation: "updateDiscountItems", input }); return { data: {} }; },
    },
    now: () => clock.now(),
  };
  return {
    access,
    repository,
    foundation,
    clock,
    domainPlan,
    foundationPlan: approvedFoundation,
    job,
    approvalHash,
    calls,
    hooks,
    workerContext,
    async close() {
      access.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("execution refuses a domain plan whose Foundation approval is no longer approved", async () => {
  const context = await fixture();
  try {
    context.access.provider.connection.prepare("UPDATE foundation_operation_plans SET state='BLOCKED' WHERE id=?")
      .run(context.foundationPlan.id);
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), {
      code: "SHOPEE_DISCOUNT_FOUNDATION_APPROVAL_REQUIRED",
    });
    assert.equal(context.calls.length, 0);
  } finally {
    await context.close();
  }
});

test("execution re-hashes immutable preview items and refuses a forged approved root", async () => {
  const context = await fixture();
  try {
    const forgedRoot = "f".repeat(64);
    const db = context.access.provider.connection;
    db.prepare("UPDATE shopee_discount_plans SET merkle_root=? WHERE id=?").run(forgedRoot, context.domainPlan.id);
    db.prepare("UPDATE shopee_discount_approvals SET merkle_root=? WHERE plan_id=?").run(forgedRoot, context.domainPlan.id);
    db.prepare("UPDATE shopee_discount_jobs SET input_json=? WHERE id=?").run(JSON.stringify({
      planId: context.domainPlan.id,
      merkleRoot: forgedRoot,
      policyHash: context.domainPlan.policyHash,
    }), context.job.id);
    db.prepare("UPDATE foundation_operation_plans SET summary_json=? WHERE id=?")
      .run(JSON.stringify({ merkleRoot: forgedRoot }), context.foundationPlan.id);
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), {
      code: "SHOPEE_DISCOUNT_APPROVAL_REHASH_MISMATCH",
    });
    assert.equal(context.calls.length, 0);
  } finally {
    await context.close();
  }
});

test("executor durably checkpoints the dispatch intent before sending and completes only after exact readback", async () => {
  const context = await fixture();
  try {
    let persistedBeforeWrite = false;
    context.hooks.beforeWrite = () => {
      const db = context.access.provider.connection;
      const intent = db.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id);
      const item = db.prepare("SELECT status FROM shopee_discount_execution_items WHERE job_id=? AND plan_item_id='plan-item-0'").get(context.job.id);
      persistedBeforeWrite = intent?.status === "DISPATCHED" && item?.status === "DISPATCHED";
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(persistedBeforeWrite, true);
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].operation, "updateDiscountItems");
    assert.equal(summary.status, "SUCCEEDED");
    assert.equal(summary.counts.SUCCEEDED, 1);
    const intent = context.access.provider.connection.prepare("SELECT status,readback_json FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id);
    assert.equal(intent.status, "SUCCEEDED");
    assert.equal(JSON.parse(intent.readback_json).priceMinor, "119900");
  } finally {
    await context.close();
  }
});

test("a repeated run repairs completion after process loss without dispatching again", async () => {
  const context = await fixture();
  try {
    context.workerContext.afterJobCompleted = async () => {
      throw Object.assign(new Error("injected completion crash"), { code: "INJECTED_COMPLETION_CRASH" });
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), { code: "INJECTED_COMPLETION_CRASH" });
    assert.equal(context.calls.length, 1);
    assert.equal((await context.repository.getJob(context.job.id)).status, "SUCCEEDED");
    assert.equal((await context.repository.getPlan(context.domainPlan.id)).state, "EXECUTING");
    delete context.workerContext.afterJobCompleted;
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "SUCCEEDED");
    assert.equal(context.calls.length, 1);
    assert.equal((await context.repository.getPlan(context.domainPlan.id)).state, "SUCCEEDED");
    assert.equal((await context.foundation.operationPlans.get(context.foundationPlan.id)).state, "SUCCEEDED");
  } finally {
    await context.close();
  }
});

test("resume repairs domain EXECUTING and Foundation APPROVED before any write", async () => {
  const context = await fixture();
  try {
    context.workerContext.afterDomainExecuting = async () => {
      throw Object.assign(new Error("injected begin gap"), { code: "INJECTED_FOUNDATION_BEGIN_GAP" });
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), { code: "INJECTED_FOUNDATION_BEGIN_GAP" });
    assert.equal((await context.repository.getPlan(context.domainPlan.id)).state, "EXECUTING");
    assert.equal((await context.foundation.operationPlans.get(context.foundationPlan.id)).state, "APPROVED");
    assert.equal(context.calls.length, 0);
    delete context.workerContext.afterDomainExecuting;
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "SUCCEEDED");
    assert.equal(context.calls.length, 1);
    assert.equal((await context.foundation.operationPlans.get(context.foundationPlan.id)).state, "SUCCEEDED");
  } finally { await context.close(); }
});

test("executor continuously renews its lease while a Shopee network response is deferred", async () => {
  const context = await fixture();
  try {
    context.workerContext.leaseMs = 100;
    let renewals = 0;
    const renew = context.repository.renewJobLease.bind(context.repository);
    context.repository.renewJobLease = async (input) => {
      renewals += 1;
      return renew(input);
    };
    let releaseWrite;
    let notifyEntered;
    const entered = new Promise((resolve) => { notifyEntered = resolve; });
    const deferred = new Promise((resolve) => { releaseWrite = resolve; });
    context.hooks.beforeWrite = async () => {
      notifyEntered();
      await deferred;
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const running = runApprovedPlan(context.domainPlan.id, context.workerContext);
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(renewals >= 3, `expected continuous renewal, observed ${renewals}`);
    releaseWrite();
    const summary = await running;
    assert.equal(summary.status, "SUCCEEDED");
  } finally {
    await context.close();
  }
});

test("lease loss immediately before dispatch stops the transport after the durable intent checkpoint", async () => {
  const context = await fixture();
  try {
    context.repository.renewJobLease = async () => false;
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), {
      code: "SHOPEE_DISCOUNT_LEASE_LOST",
    });
    assert.equal(context.calls.length, 0);
    const intent = context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id);
    assert.equal(intent.status, "DISPATCHED");
  } finally {
    await context.close();
  }
});

test("predispatch awaits an in-flight renewal that loses the epoch and sends nothing", async () => {
  const context = await fixture();
  try {
    context.workerContext.leaseMs = 100;
    let releaseRenewal;
    let enteredRenewal;
    const entered = new Promise((resolve) => { enteredRenewal = resolve; });
    const deferred = new Promise((resolve) => { releaseRenewal = resolve; });
    let renewals = 0;
    const original = context.repository.renewJobLease.bind(context.repository);
    context.repository.renewJobLease = async (input) => {
      renewals += 1;
      if (renewals === 1) {
        enteredRenewal();
        return deferred;
      }
      return original(input);
    };
    context.workerContext.afterIntentPersisted = async () => {
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 1));
      releaseRenewal(false);
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), { code: "SHOPEE_DISCOUNT_LEASE_LOST" });
    assert.equal(context.calls.length, 0);
  } finally { await context.close(); }
});

test("a late response after fencing loss is coordination evidence and cannot advance canonical state", async () => {
  const context = await fixture();
  try {
    context.hooks.beforeWrite = () => {
      context.access.provider.connection.prepare(`UPDATE shopee_discount_jobs
        SET owner_id='worker-2',fencing_epoch=fencing_epoch+1,lease_until='2026-08-14T00:10:00.000Z' WHERE id=?`).run(context.job.id);
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), {
      code: "SHOPEE_DISCOUNT_LEASE_LOST",
    });
    assert.equal(context.calls.length, 1);
    const db = context.access.provider.connection;
    assert.equal(db.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id).status, "DISPATCHED");
    assert.equal(db.prepare("SELECT status FROM shopee_discount_execution_items WHERE job_id=?").get(context.job.id).status, "DISPATCHED");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM shopee_discount_events WHERE job_id=? AND event_type='LATE_RESPONSE_IGNORED'").get(context.job.id).count, 1);
  } finally {
    await context.close();
  }
});

test("restart after a crash between intent persistence and send performs readback only and never resends", async () => {
  const context = await fixture();
  try {
    const crash = Object.assign(new Error("simulated process crash"), { code: "SIMULATED_CRASH" });
    context.workerContext.afterIntentPersisted = () => { throw crash; };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), { code: "SIMULATED_CRASH" });
    assert.equal(context.calls.length, 0);
    assert.equal(context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id).status, "DISPATCHED");

    context.clock.advance(2_000);
    context.workerContext.workerId = "worker-2";
    context.workerContext.afterIntentPersisted = null;
    let readbacks = 0;
    context.workerContext.readers.readbackIntent = async () => { readbacks += 1; return null; };
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(context.calls.length, 0);
    assert.equal(readbacks, 1);
    assert.equal(summary.status, "BLOCKED");
    assert.equal(summary.counts.UNKNOWN, 1);
    assert.equal(context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id).status, "UNKNOWN");
  } finally {
    await context.close();
  }
});

for (const ambiguous of [
  { name: "connection reset", result: () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } },
  { name: "malformed response", result: () => ({ status: 200, body: "{" }) },
  { name: "HTTP 429", result: () => ({ status: 429, body: { error: "rate_limit" } }) },
  { name: "HTTP 500", result: () => ({ status: 500, body: { error: "error_server" } }) },
  { name: "response loss", result: () => undefined },
]) {
  test(`ambiguous ${ambiguous.name} is attempted once and becomes UNKNOWN`, async () => {
    const context = await fixture();
    try {
      let attempts = 0;
      context.workerContext.shopeeWrite = new ShopeeWriteAdapter({
        siteCapability: {
          priceScale: 2,
          minPriceMinor: "1",
          maxPriceMinor: "999999999",
          priceStepMinor: "1",
          maxAddItems: 10,
        },
        transport: async () => {
          attempts += 1;
          return ambiguous.result();
        },
      });
      const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
      const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(attempts, 1);
      assert.equal(summary.status, "BLOCKED");
      assert.equal(summary.counts.UNKNOWN, 1);
      assert.equal(context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id).status, "UNKNOWN");
      assert.equal((await context.repository.getJob(context.job.id)).status, "RUNNING");
      assert.equal((await context.foundation.operationPlans.get(context.foundationPlan.id)).state, "IN_FLIGHT");
    } finally {
      await context.close();
    }
  });
}

test("an UNKNOWN job later proves the same intent by readback without replaying POST", async () => {
  const context = await fixture();
  try {
    context.workerContext.shopeeWrite.updateDiscountItems = async (input) => {
      context.calls.push({ operation: "updateDiscountItems", input });
      throw Object.assign(new Error("response lost"), { code: "SHOPEE_WRITE_UNKNOWN" });
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const blocked = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(blocked.counts.UNKNOWN, 1);
    context.workerContext.readers.readbackIntent = async ({ item, activity }) => ({
      activityId: activity.platformActivityId,
      platformObjectId: activity.platformActivityId,
      membership: true,
      itemId: item.itemId,
      modelId: item.modelId,
      priceMinor: item.targetPriceMinor,
    });
    const recovered = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(recovered.status, "SUCCEEDED");
    assert.equal(context.calls.length, 1);
  } finally { await context.close(); }
});

test("AUTH_BLOCKED shop resumes after reauthorization and revalidates before first POST", async () => {
  const context = await fixture();
  try {
    let authorized = false;
    let warehouseReads = 0;
    const originalWarehouse = context.workerContext.readers.getWarehouseState;
    context.workerContext.readers.getShopAuthorization = async () => ({ authorized });
    context.workerContext.readers.getWarehouseState = async (input) => { warehouseReads += 1; return originalWarehouse(input); };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const blocked = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(blocked.counts.AUTH_BLOCKED, 1);
    assert.equal((await context.repository.getJob(context.job.id)).status, "RUNNING");
    authorized = true;
    const resumed = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(warehouseReads, 1);
    assert.equal(context.calls.length, 1);
  } finally { await context.close(); }
});

test("definite POST auth rejection preserves its attempt and reauthorization creates a new UUID", async () => {
  const context = await fixture();
  try {
    let attempts = 0;
    context.workerContext.shopeeWrite.updateDiscountItems = async (input) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("reauthorize"), { code: "SHOPEE_AUTH_ERROR" });
      context.calls.push({ operation: "updateDiscountItems", input });
      return { data: {} };
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const blocked = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(blocked.counts.AUTH_BLOCKED, 1);
    const resumed = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(resumed.status, "SUCCEEDED");
    const intents = context.access.provider.connection.prepare(`SELECT operation_uuid,status,attempt_no FROM shopee_discount_dispatch_intents
      WHERE job_id=? ORDER BY attempt_no`).all(context.job.id);
    assert.deepEqual(intents.map(({ status, attempt_no }) => [status, attempt_no]), [["REJECTED", 1], ["SUCCEEDED", 2]]);
    assert.notEqual(intents[0].operation_uuid, intents[1].operation_uuid);
  } finally { await context.close(); }
});

test("post-write readback distinguishes membership conflict from a one-minor-unit UNKNOWN price", async () => {
  const conflict = await fixture();
  try {
    conflict.workerContext.readers.readbackIntent = async () => ({
      activityId: "900", platformObjectId: "900", membership: false, priceMinor: "119900",
    });
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(conflict.domainPlan.id, conflict.workerContext);
    assert.equal(summary.counts.CONFLICT, 1);
    assert.equal(summary.counts.UNKNOWN, 0);
  } finally {
    await conflict.close();
  }

  const priceMismatch = await fixture();
  try {
    priceMismatch.workerContext.readers.readbackIntent = async () => ({
      activityId: "900", platformObjectId: "900", membership: true, priceMinor: "119899",
    });
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(priceMismatch.domainPlan.id, priceMismatch.workerContext);
    assert.equal(summary.counts.UNKNOWN, 1);
    assert.equal(summary.counts.SUCCEEDED, 0);
  } finally {
    await priceMismatch.close();
  }
});

for (const invalidReadback of [
  { name: "missing platform object", value: { activityId: "900", platformObjectId: null, membership: true, itemId: "100", modelId: "1000", priceMinor: "119900" } },
  { name: "wrong item", value: { activityId: "900", platformObjectId: "900", membership: true, itemId: "101", modelId: "1000", priceMinor: "119900" } },
  { name: "wrong model", value: { activityId: "900", platformObjectId: "900", membership: true, itemId: "100", modelId: "1001", priceMinor: "119900" } },
  { name: "missing model", value: { activityId: "900", platformObjectId: "900", membership: true, itemId: "100", modelId: null, priceMinor: "119900" } },
]) {
  test(`official readback with ${invalidReadback.name} stays UNKNOWN`, async () => {
    const context = await fixture();
    try {
      context.workerContext.readers.readbackIntent = async () => invalidReadback.value;
      const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
      const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(summary.counts.UNKNOWN, 1);
      assert.equal(summary.counts.SUCCEEDED, 0);
    } finally { await context.close(); }
  });
}

test("a definite platform rejection isolates one variant while later variants still succeed", async () => {
  const context = await fixture({
    approvalItems: [
      approvalItem(),
      approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-2" }),
    ],
  });
  try {
    const attemptedItems = [];
    context.workerContext.shopeeWrite.updateDiscountItems = async (input) => {
      const itemId = input.items[0].itemId;
      attemptedItems.push(itemId);
      if (itemId === "100") throw Object.assign(new Error("variant rejected"), { code: "SHOPEE_BUSINESS_ERROR", requestId: "platform-1" });
      return { data: {} };
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.deepEqual(attemptedItems, ["100", "101"]);
    assert.equal(summary.status, "PARTIAL_SUCCESS");
    assert.equal(summary.counts.REJECTED, 1);
    assert.equal(summary.counts.SUCCEEDED, 1);
    const rejectedIntent = context.access.provider.connection.prepare(`SELECT status,completed_at FROM shopee_discount_dispatch_intents
      WHERE plan_item_id='plan-item-0'`).get();
    assert.equal(rejectedIntent.status, "REJECTED");
    assert.ok(rejectedIntent.completed_at);
  } finally {
    await context.close();
  }
});

for (const readbackFailure of ["SHOPEE_BUSINESS_ERROR", "SHOPEE_AUTH_ERROR"]) {
  test(`a successful POST followed by ${readbackFailure} readback remains UNKNOWN`, async () => {
    const context = await fixture();
    try {
      context.workerContext.readers.readbackIntent = async () => {
        throw Object.assign(new Error("readback failed after send"), { code: readbackFailure });
      };
      const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
      const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(context.calls.length, 1);
      assert.equal(summary.counts.UNKNOWN, 1);
      assert.equal(summary.counts.REJECTED, 0);
      assert.equal(summary.counts.AUTH_BLOCKED, 0);
      assert.equal(context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id).status, "UNKNOWN");
    } finally { await context.close(); }
  });
}

test("post-write item auth readback keeps uncertainty, pauses that shop, and permits another shop", async () => {
  const context = await fixture({ approvalItems: [
    approvalItem(),
    approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-1B" }),
    approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
  ] });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    context.workerContext.readers.readbackIntent = async ({ item }) => {
      if (item.shopId === "1") throw Object.assign(new Error("reauthorization required"), { code: "SHOPEE_AUTH_ERROR" });
      return {
        activityId: "900", platformObjectId: "900", membership: true,
        itemId: item.itemId, modelId: item.modelId, priceMinor: item.targetPriceMinor,
      };
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.UNKNOWN, 2);
    assert.equal(summary.counts.AUTH_BLOCKED, 0);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["1", "2"]);
    const intents = context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").all(context.job.id);
    assert.deepEqual(intents.map(({ status }) => status).sort(), ["SUCCEEDED", "UNKNOWN"]);
    const issues = context.access.provider.connection.prepare(`SELECT reason_code,evidence_json FROM shopee_discount_events
      WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].reason_code, "SHOPEE_AUTH_ERROR");
    assert.deepEqual(JSON.parse(issues[0].evidence_json), {
      priority: "HIGH", shopId: "1", requestId: "request-1",
    });
  } finally { await context.close(); }
});

test("AUTH_BLOCKED resume reports authorized false once and continues a reauthorized shop", async () => {
  const context = await fixture({ approvalItems: [
    approvalItem(),
    approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
  ] });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    let resume = false;
    context.workerContext.readers.getShopAuthorization = async ({ shopId }) => ({ authorized: resume && shopId === "2" });
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const first = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(first.counts.AUTH_BLOCKED, 2);
    resume = true;
    context.workerContext.requestId = "request-2";
    const second = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(second.counts.AUTH_BLOCKED, 1);
    assert.equal(second.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["2"]);
    const issues = context.access.provider.connection.prepare(`SELECT evidence_json FROM shopee_discount_events
      WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id)
      .map(({ evidence_json: evidenceJson }) => JSON.parse(evidenceJson))
      .filter((evidence) => evidence.requestId === "request-2");
    assert.deepEqual(issues, [{ priority: "HIGH", shopId: "1", requestId: "request-2" }]);
  } finally { await context.close(); }
});

for (const authCheck of ["false", "throw"]) {
  test(`AUTH_BLOCKED resume ${authCheck} pauses mixed-state shop before its PENDING item`, async () => {
    const context = await fixture({ approvalItems: [
      approvalItem(),
      approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-1B" }),
      approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
    ] });
    try {
      context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
      context.workerContext.readers.getShopAuthorization = async () => ({ authorized: false });
      const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
      const first = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(first.counts.AUTH_BLOCKED, 3);
      context.access.provider.connection.prepare(`UPDATE shopee_discount_execution_items SET status='PENDING',reason_code=NULL
        WHERE job_id=? AND plan_item_id IN ('plan-item-1','plan-item-2')`).run(context.job.id);
      context.clock.advance(2_000);
      context.workerContext.workerId = "worker-2";
      context.workerContext.requestId = `request-mixed-${authCheck}`;
      const authorizationReads = [];
      context.workerContext.readers.getShopAuthorization = async ({ shopId }) => {
        authorizationReads.push(shopId);
        if (shopId === "2") return { authorized: true };
        if (authCheck === "throw") throw Object.assign(new Error("still unauthorized"), { code: "SHOPEE_AUTH_ERROR" });
        return { authorized: false };
      };
      const second = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(second.counts.AUTH_BLOCKED, 2);
      assert.equal(second.counts.SUCCEEDED, 1);
      assert.deepEqual(authorizationReads, ["1", "2"]);
      assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["2"]);
      assert.equal(context.access.provider.connection.prepare("SELECT COUNT(*) count FROM shopee_discount_dispatch_intents WHERE plan_item_id='plan-item-1'").get().count, 0);
      const issues = context.access.provider.connection.prepare(`SELECT evidence_json FROM shopee_discount_events
        WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id)
        .map(({ evidence_json: evidenceJson }) => JSON.parse(evidenceJson))
        .filter((evidence) => evidence.requestId === `request-mixed-${authCheck}`);
      assert.deepEqual(issues, [{ priority: "HIGH", shopId: "1", requestId: `request-mixed-${authCheck}` }]);
    } finally { await context.close(); }
  });
}

test("shop authorization failure creates a high-priority issue and does not stop another shop", async () => {
  const context = await fixture({
    approvalItems: [
      approvalItem(),
      approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-1B" }),
      approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
    ],
  });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    const authorizationReads = [];
    context.workerContext.readers.getShopAuthorization = async ({ shopId }) => {
      authorizationReads.push(shopId);
      return { authorized: shopId === "2" };
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "BLOCKED");
    assert.equal(summary.counts.AUTH_BLOCKED, 2);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(authorizationReads, ["1", "2"]);
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].input.shopId, "2");
    const issues = context.access.provider.connection.prepare(`SELECT reason_code,evidence_json FROM shopee_discount_events
      WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id);
    assert.equal(issues.length, 1);
    const issue = issues[0];
    assert.equal(issue.reason_code, "SHOPEE_AUTH_ERROR");
    assert.equal(JSON.parse(issue.evidence_json).priority, "HIGH");
  } finally {
    await context.close();
  }
});

test("a shop removed from the write whitelist is isolated while another shop continues", async () => {
  const context = await fixture({
    approvalItems: [
      approvalItem(),
      approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
    ],
  });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    let securityReads = 0;
    context.workerContext.writeSecurity = () => ({
      enabled: true,
      mode: "trusted_single_role",
      constraints: {
        countries: ["TH"],
        shops: securityReads++ === 0 ? ["1", "2"] : ["2"],
        maxBatchItems: 10,
      },
    });
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "BLOCKED");
    assert.equal(summary.counts.AUTH_BLOCKED, 1);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].input.shopId, "2");
  } finally {
    await context.close();
  }
});

test("an external activity race stops new dispatches for that shop while another shop continues", async () => {
  const context = await fixture({
    approvalItems: [
      approvalItem(),
      approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-1B" }),
      approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
    ],
  });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    context.workerContext.readers.getDiscountState = async ({ item, activity }) => ({
      conflict: item.itemId === "100",
      activityId: activity.platformActivityId,
      membership: true,
    });
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "PARTIAL_SUCCESS");
    assert.equal(summary.counts.CONFLICT, 2);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].input.shopId, "2");
  } finally {
    await context.close();
  }
});

for (const drift of [
  { name: "warehouse price", change: (context) => { context.workerContext.readers.getWarehouseState = async ({ item }) => ({ targetPriceMinor: String(BigInt(item.targetPriceMinor) - 1n), watermark: item.payload.warehouseWatermark }); } },
  { name: "warehouse watermark", change: (context) => { context.workerContext.readers.getWarehouseState = async ({ item }) => ({ targetPriceMinor: item.targetPriceMinor, watermark: "2026-08-14T00:00:00.000Z" }); } },
  { name: "warehouse approval time", change: (context) => { context.workerContext.readers.getWarehouseState = async ({ item }) => ({ targetPriceMinor: item.targetPriceMinor, watermark: item.payload.warehouseWatermark, approvedAt: "2026-08-13T21:00:00.000Z" }); } },
  { name: "listing status", change: (context) => { context.workerContext.readers.getListingState = async ({ item }) => ({ status: "DELISTED", sku: item.sku, originalPriceMinor: item.payload.originalMinor }); } },
  { name: "listing SKU", change: (context) => { context.workerContext.readers.getListingState = async ({ item }) => ({ status: "ACTIVE", sku: `${item.sku}-CHANGED`, originalPriceMinor: item.payload.originalMinor }); } },
  { name: "original price", change: (context) => { context.workerContext.readers.getListingState = async ({ item }) => ({ status: "ACTIVE", sku: item.sku, originalPriceMinor: String(BigInt(item.payload.originalMinor) + 1n) }); } },
  { name: "activity identity", change: (context) => { context.workerContext.readers.getDiscountState = async () => ({ conflict: false, activityId: "999", membership: true }); } },
]) {
  test(`${drift.name} drift requires reapproval without changing the approved target`, async () => {
    const context = await fixture();
    try {
      drift.change(context);
      const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
      const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(summary.counts.REQUIRES_REAPPROVAL, 1);
      assert.equal(summary.counts.SUCCEEDED, 0);
      assert.equal(context.calls.length, 0);
      const checkpoint = context.access.provider.connection.prepare("SELECT status FROM shopee_discount_execution_items WHERE job_id=?").get(context.job.id);
      assert.equal(checkpoint.status, "REQUIRES_REAPPROVAL");
      assert.equal(context.access.provider.connection.prepare("SELECT target_price_minor FROM shopee_discount_plan_items WHERE id='plan-item-0'").get().target_price_minor, "119900");
    } finally {
      await context.close();
    }
  });
}

test("NEXT_RENEWAL creates one activity intent, verifies its marker, then adds items", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL" });
  try {
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "SUCCEEDED");
    assert.deepEqual(context.calls.map((call) => call.operation), ["createDiscount", "addDiscountItems"]);
    const activity = context.access.provider.connection.prepare("SELECT platform_activity_id FROM shopee_discount_activities WHERE plan_id=?").get(context.domainPlan.id);
    assert.equal(activity.platform_activity_id, "901");
    const intents = context.access.provider.connection.prepare("SELECT target_type,status FROM shopee_discount_dispatch_intents WHERE job_id=? ORDER BY target_type").all(context.job.id);
    assert.deepEqual(intents.map(({ target_type, status }) => ({ target_type, status })), [
      { target_type: "addDiscountItems", status: "SUCCEEDED" },
      { target_type: "createDiscount", status: "SUCCEEDED" },
    ]);
  } finally {
    await context.close();
  }
});

test("renewal marker lookup auth blocks only that shop and reports it once", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL", approvalItems: [
    approvalItem(),
    approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
  ] });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    context.workerContext.readers.findActivityByMarker = async ({ activity }) => {
      if (activity.shopId === "1") throw Object.assign(new Error("authorization expired"), { code: "SHOPEE_AUTH_ERROR" });
      return null;
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.AUTH_BLOCKED, 1);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["2", "2"]);
    const issues = context.access.provider.connection.prepare(`SELECT evidence_json FROM shopee_discount_events
      WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id);
    assert.equal(issues.length, 1);
    assert.equal(JSON.parse(issues[0].evidence_json).priority, "HIGH");
  } finally { await context.close(); }
});

test("post-create auth readback stays UNKNOWN and reports the affected renewal shop", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL" });
  try {
    context.workerContext.readers.readbackIntent = async () => {
      throw Object.assign(new Error("authorization expired after POST"), { code: "SHOPEE_AUTH_ERROR" });
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.UNKNOWN, 1);
    assert.equal(summary.counts.AUTH_BLOCKED, 0);
    assert.deepEqual(context.calls.map(({ operation }) => operation), ["createDiscount"]);
    const intent = context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id);
    assert.equal(intent.status, "UNKNOWN");
    const issues = context.access.provider.connection.prepare(`SELECT reason_code,evidence_json FROM shopee_discount_events
      WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].reason_code, "SHOPEE_AUTH_ERROR");
    assert.equal(JSON.parse(issues[0].evidence_json).priority, "HIGH");
  } finally { await context.close(); }
});

test("NEXT_RENEWAL rejects a marker that no longer matches the immutable plan identity", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL" });
  try {
    context.access.provider.connection.prepare(`UPDATE shopee_discount_activities
      SET metadata_json=json_set(metadata_json,'$.discountName','PM-TH-DAILY-2026-08-15-TAMPERED')
      WHERE plan_id=?`).run(context.domainPlan.id);
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.REQUIRES_REAPPROVAL, 1);
    assert.equal(context.calls.length, 0);
  } finally {
    await context.close();
  }
});

for (const renewalBlock of [
  {
    name: "shop removed from whitelist",
    change(context) {
      context.workerContext.writeSecurity = () => ({ enabled: true, mode: "trusted_single_role", constraints: { countries: ["TH"], shops: ["2"], maxBatchItems: 10 } });
    },
    status: "AUTH_BLOCKED",
  },
  {
    name: "shop authorization revoked",
    change(context) { context.workerContext.readers.getShopAuthorization = async () => ({ authorized: false }); },
    status: "AUTH_BLOCKED",
  },
  {
    name: "warehouse drift",
    change(context) { context.workerContext.readers.getWarehouseState = async ({ item }) => ({ targetPriceMinor: "1", watermark: item.payload.warehouseWatermark, approvedAt: item.payload.warehouseApprovedAt }); },
    status: "REQUIRES_REAPPROVAL",
  },
  {
    name: "listing prerequisite failure",
    change(context) { context.workerContext.readers.getListingState = async ({ item }) => ({ status: "DELISTED", sku: item.sku, originalPriceMinor: item.payload.originalMinor }); },
    status: "REQUIRES_REAPPROVAL",
  },
  {
    name: "overlap race",
    change(context) { context.workerContext.readers.getDiscountState = async () => ({ conflict: true }); },
    status: "REQUIRES_REAPPROVAL",
  },
]) {
  test(`NEXT_RENEWAL performs no create when ${renewalBlock.name}`, async () => {
    const context = await fixture({ workflow: "NEXT_RENEWAL" });
    try {
      renewalBlock.change(context);
      const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
      const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(summary.counts[renewalBlock.status], 1);
      assert.equal(context.calls.length, 0);
    } finally { await context.close(); }
  });
}

test("renewal preflight reader failure isolates its shop and permits another shop", async () => {
  const context = await fixture({
    workflow: "NEXT_RENEWAL",
    approvalItems: [approvalItem(), approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" })],
  });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    const original = context.workerContext.readers.getWarehouseState;
    context.workerContext.readers.getWarehouseState = async (input) => {
      if (input.item.shopId === "1") throw Object.assign(new Error("warehouse unavailable"), { code: "WAREHOUSE_UNAVAILABLE" });
      return original(input);
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.UNKNOWN, 1);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["2", "2"]);
  } finally { await context.close(); }
});

test("renewal preflight checks every item and creates only for the fully checked partition", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL", approvalItems: [
    approvalItem(), approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-2" }),
  ] });
  try {
    const original = context.workerContext.readers.getWarehouseState;
    const checked = [];
    context.workerContext.readers.getWarehouseState = async (input) => {
      checked.push(input.item.id);
      if (input.item.itemId === "100") return { targetPriceMinor: "1", watermark: input.item.payload.warehouseWatermark, approvedAt: input.item.payload.warehouseApprovedAt };
      return original(input);
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.deepEqual(new Set(checked), new Set(["plan-item-0", "plan-item-1"]));
    assert.equal(summary.counts.REQUIRES_REAPPROVAL, 1);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ operation }) => operation), ["createDiscount", "addDiscountItems"]);
  } finally { await context.close(); }
});

test("renewal preflight preserves ready items from earlier pages when the final page is drift-only", async () => {
  const approvalItems = Array.from({ length: 101 }, (_, index) => approvalItem({
    item_id: String(100 + index),
    model_id: String(1000 + index),
    sku: `SKU-${index + 1}`,
  }));
  const context = await fixture({ workflow: "NEXT_RENEWAL", approvalItems });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    const original = context.workerContext.readers.getWarehouseState;
    context.workerContext.readers.getWarehouseState = async (input) => {
      if (input.item.itemId === "200") return {
        targetPriceMinor: "1",
        watermark: input.item.payload.warehouseWatermark,
        approvedAt: input.item.payload.warehouseApprovedAt,
      };
      return original(input);
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.SUCCEEDED, 100);
    assert.equal(summary.counts.REQUIRES_REAPPROVAL, 1);
    assert.equal(context.calls.filter(({ operation }) => operation === "createDiscount").length, 1);
    assert.equal(context.calls.filter(({ operation }) => operation === "addDiscountItems").length, 100);
  } finally { await context.close(); }
});

test("renewal per-item auth failure raises one shop issue and does not stop a later shop", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL", approvalItems: [
    approvalItem(),
    approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-1B" }),
    approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
  ] });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    const original = context.workerContext.readers.getWarehouseState;
    context.workerContext.readers.getWarehouseState = async (input) => {
      if (input.item.shopId === "1" && input.item.itemId === "100") {
        throw Object.assign(new Error("reauthorization required"), { code: "SHOPEE_AUTH_ERROR" });
      }
      return original(input);
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.AUTH_BLOCKED, 2);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["2", "2"]);
    const issues = context.access.provider.connection.prepare(`SELECT reason_code,evidence_json FROM shopee_discount_events
      WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id)
      .filter(({ evidence_json: evidenceJson }) => JSON.parse(evidenceJson).shopId === "1");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].reason_code, "SHOPEE_AUTH_ERROR");
    assert.equal(JSON.parse(issues[0].evidence_json).priority, "HIGH");
  } finally { await context.close(); }
});

test("current-correction reader failure is isolated to its shop", async () => {
  const context = await fixture({ approvalItems: [approvalItem(), approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" })] });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    const original = context.workerContext.readers.getWarehouseState;
    context.workerContext.readers.getWarehouseState = async (input) => {
      if (input.item.shopId === "1") throw Object.assign(new Error("warehouse unavailable"), { code: "WAREHOUSE_UNAVAILABLE" });
      return original(input);
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "BLOCKED");
    assert.equal(summary.counts.UNKNOWN, 1);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["2"]);
  } finally { await context.close(); }
});

test("executor uses bounded pages and aggregate counts instead of materializing execution rows", async () => {
  const context = await fixture();
  try {
    context.repository.listExecutionItems = async () => { throw new Error("unbounded execution item read"); };
    context.repository.listDispatchIntents = async () => { throw new Error("unbounded intent read"); };
    context.repository.listPlanActivities = async () => { throw new Error("unbounded activity read"); };
    context.repository.listPlanShards = async () => { throw new Error("unbounded shard read"); };
    context.repository.getPlanShopIds = async () => { throw new Error("unbounded shop read"); };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "SUCCEEDED");
    assert.equal(summary.counts.SUCCEEDED, 1);
  } finally { await context.close(); }
});

test("ambiguous activity creation is at-most-once and repeated execution never creates a replacement", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL" });
  try {
    let createAttempts = 0;
    context.workerContext.shopeeWrite.createDiscount = async () => {
      createAttempts += 1;
      throw Object.assign(new Error("response lost"), { code: "SHOPEE_WRITE_UNKNOWN" });
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const first = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(first.status, "BLOCKED");
    assert.equal(first.counts.UNKNOWN, 1);
    const second = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(second.status, "SUCCEEDED");
    assert.equal(second.counts.SUCCEEDED, 1);
    assert.equal(createAttempts, 1);
    const intents = context.access.provider.connection.prepare("SELECT operation_uuid,target_type,status FROM shopee_discount_dispatch_intents WHERE job_id=?").all(context.job.id);
    assert.equal(intents.length, 2);
    assert.equal(intents.find((intent) => intent.target_type === "createDiscount")?.status, "SUCCEEDED");
  } finally {
    await context.close();
  }
});

test("restart readback of a DISPATCHED activity-create intent never dispatches a replacement", async () => {
  const context = await fixture({ workflow: "NEXT_RENEWAL" });
  try {
    context.workerContext.afterIntentPersisted = () => { throw Object.assign(new Error("crash"), { code: "SIMULATED_CRASH" }); };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), { code: "SIMULATED_CRASH" });
    context.clock.advance(2_000);
    context.workerContext.workerId = "worker-2";
    context.workerContext.afterIntentPersisted = null;
    let recoveryReadbacks = 0;
    context.workerContext.readers.readbackIntent = async () => { recoveryReadbacks += 1; return null; };
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.status, "BLOCKED");
    assert.equal(summary.counts.UNKNOWN, 1);
    assert.equal(recoveryReadbacks, 1);
    assert.equal(context.calls.length, 0);
    assert.equal(context.access.provider.connection.prepare("SELECT COUNT(*) count FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id).count, 1);
  } finally {
    await context.close();
  }
});

for (const workflow of ["CURRENT_CORRECTION", "NEXT_RENEWAL"]) {
  test(`${workflow} recovery auth readback remains UNKNOWN and emits one safe issue`, async () => {
    const context = await fixture({ workflow });
    try {
      context.workerContext.afterIntentPersisted = () => {
        throw Object.assign(new Error("crash before transport"), { code: "SIMULATED_CRASH" });
      };
      const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
      await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), { code: "SIMULATED_CRASH" });
      context.clock.advance(2_000);
      context.workerContext.workerId = "worker-2";
      context.workerContext.afterIntentPersisted = null;
      context.workerContext.readers.readbackIntent = async () => {
        throw Object.assign(new Error("authorization expired during recovery"), { code: "SHOPEE_AUTH_ERROR" });
      };
      const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
      assert.equal(summary.counts.UNKNOWN, 1);
      assert.equal(summary.counts.AUTH_BLOCKED, 0);
      assert.equal(context.calls.length, 0);
      const intent = context.access.provider.connection.prepare("SELECT status FROM shopee_discount_dispatch_intents WHERE job_id=?").get(context.job.id);
      assert.equal(intent.status, "UNKNOWN");
      const issues = context.access.provider.connection.prepare(`SELECT reason_code,evidence_json FROM shopee_discount_events
        WHERE plan_id=? AND event_type='EXECUTION_ISSUE'`).all(context.domainPlan.id);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].reason_code, "SHOPEE_AUTH_ERROR");
      assert.deepEqual(JSON.parse(issues[0].evidence_json), {
        priority: "HIGH", shopId: "1", requestId: "request-1",
      });
    } finally { await context.close(); }
  });
}

test("item recovery auth uncertainty pauses its shop without suppressing another shop", async () => {
  const context = await fixture({ approvalItems: [
    approvalItem(),
    approvalItem({ item_id: "101", model_id: "1001", sku: "SKU-1B" }),
    approvalItem({ shop_id: "2", item_id: "200", model_id: "2000", sku: "SKU-2" }),
  ] });
  try {
    context.repository.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    context.workerContext.afterIntentPersisted = () => {
      throw Object.assign(new Error("crash before transport"), { code: "SIMULATED_CRASH" });
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    await assert.rejects(runApprovedPlan(context.domainPlan.id, context.workerContext), { code: "SIMULATED_CRASH" });
    context.clock.advance(2_000);
    context.workerContext.workerId = "worker-2";
    context.workerContext.afterIntentPersisted = null;
    context.workerContext.readers.readbackIntent = async ({ item }) => {
      if (!item || item.shopId === "1") {
        throw Object.assign(new Error("authorization expired during recovery"), { code: "SHOPEE_AUTH_ERROR" });
      }
      return {
        activityId: "900", platformObjectId: "900", membership: true,
        itemId: item.itemId, modelId: item.modelId, priceMinor: item.targetPriceMinor,
      };
    };
    const summary = await runApprovedPlan(context.domainPlan.id, context.workerContext);
    assert.equal(summary.counts.UNKNOWN, 2);
    assert.equal(summary.counts.SUCCEEDED, 1);
    assert.deepEqual(context.calls.map(({ input }) => input.shopId), ["2"]);
    const intents = context.access.provider.connection.prepare("SELECT plan_item_id,status FROM shopee_discount_dispatch_intents WHERE job_id=?").all(context.job.id);
    assert.deepEqual(intents.map(({ plan_item_id: itemId, status }) => [itemId, status]).sort(), [
      ["plan-item-0", "UNKNOWN"], ["plan-item-2", "SUCCEEDED"],
    ]);
  } finally { await context.close(); }
});
