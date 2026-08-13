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
  const approvalHash = buildApprovalRoot(approvalItems, { shardSize: 2 });
  const confirmationText = `confirm ${workflow}`;
  const sourceSnapshot = { merkleRoot: approvalHash.root, shopIds: [...new Set(approvalItems.map((item) => item.shop_id))] };
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
  const planId = `plan-${workflow.toLowerCase()}`;
  const targetStartsAt = "2026-08-15T00:00:00.000Z";
  const targetEndsAt = "2026-09-14T00:00:00.000Z";
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
  const persistedItems = approvalItems.map((item, sequence) => ({
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
    itemCount: approvalItems.length,
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
      async readbackIntent({ item, activity }) {
        return {
          activityId: activity.platformActivityId || "901",
          platformObjectId: activity.platformActivityId || "901",
          markerVerified: item == null,
          membership: true,
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
    } finally {
      await context.close();
    }
  });
}

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
  } finally {
    await context.close();
  }
});

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
    assert.equal(summary.status, "PARTIAL_SUCCESS");
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
    assert.equal(summary.status, "PARTIAL_SUCCESS");
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
    assert.deepEqual(second, first);
    assert.equal(createAttempts, 1);
    const intents = context.access.provider.connection.prepare("SELECT operation_uuid,status FROM shopee_discount_dispatch_intents WHERE job_id=?").all(context.job.id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, "UNKNOWN");
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
