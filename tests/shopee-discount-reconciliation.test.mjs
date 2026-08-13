import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";

const NOW = "2026-08-14T00:00:00.000Z";
const OPERATION_UUID = "11111111-1111-4111-8111-111111111111";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-reconciliation-"));
  const access = openCommerceDataAccess({
    rootDir: path.resolve("."),
    databasePath: path.join(root, "commerce.sqlite"),
    migrationsDir: path.resolve("migrations"),
  });
  const repository = access.repositories.shopeeDiscount;
  repository.now = () => new Date(NOW);
  let plan = await repository.createPlan({
    id: "plan-reconcile",
    country: "TH",
    shopId: "1",
    targetStartsAt: "2026-08-15T00:00:00.000Z",
    targetEndsAt: "2026-09-14T00:00:00.000Z",
    sourceSnapshotHash: "snapshot-1",
    policyHash: "policy-1",
    createdBy: "planner",
    expiresAt: "2026-08-14T01:00:00.000Z",
  });
  await repository.appendPlanShard({
    planId: plan.id,
    shardIndex: 0,
    shardHash: "shard-1",
    items: [{
      id: "plan-item-1",
      sequence: 0,
      shopId: "1",
      itemId: "100",
      modelId: "1000",
      sku: "SKU-1",
      currency: "THB",
      scale: 2,
      currentPriceMinor: "129900",
      controlPriceMinor: "119900",
      targetPriceMinor: "119900",
      payloadHash: "approval-payload-1",
      payload: { originalMinor: "129900", activity: { discountId: "900" } },
    }],
  });
  plan = await repository.sealPlan({ planId: plan.id, merkleRoot: "root-1", itemCount: 1, shardCount: 1, expectedVersion: plan.stateVersion });
  await repository.approvePlan({
    planId: plan.id,
    merkleRoot: "root-1",
    policyHash: "policy-1",
    approval: { actorId: "approver", evidence: { confirmationText: "confirm" } },
    expectedVersion: plan.stateVersion,
  });
  const job = await repository.createJob({ id: "job-reconcile", planId: plan.id, jobType: "EXECUTE", createdBy: "executor" });
  const claim = await repository.claimJob({ jobId: job.id, ownerId: "worker-1", leaseMs: 60_000 });
  await repository.prepareExecutionItems({ jobId: job.id, planId: plan.id, ownerId: "worker-1", epoch: claim.epoch });
  const intent = await repository.createDispatchIntent({
    id: "intent-reconcile",
    jobId: job.id,
    planId: plan.id,
    planItemId: "plan-item-1",
    operationUuid: OPERATION_UUID,
    targetType: "updateDiscountItems",
    targetKey: "1\u001f900\u001f100\u001f1000",
    payloadHash: "write-payload-1",
    ownerId: "worker-1",
    epoch: claim.epoch,
  });
  await repository.markDispatchUnknown({
    intentId: intent.id,
    ownerId: "worker-1",
    epoch: claim.epoch,
    evidence: { code: "SHOPEE_WRITE_UNKNOWN" },
  });
  return {
    access,
    repository,
    intent,
    async close() {
      access.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("LINK_VERIFIED_OBJECT requires exact official object, membership, and minor-unit price evidence", async () => {
  const context = await fixture();
  try {
    const { reconcileIntent } = await import("../lib/shopee-discount/reconciliation.mjs");
    const baseReadback = {
      verified: true,
      operationUuid: context.intent.operationUuid,
      payloadHash: context.intent.payloadHash,
      platformObjectId: "900",
      activityId: "900",
      membership: true,
      itemId: "100",
      modelId: "1000",
      priceMinor: "119900",
    };
    for (const readback of [
      { ...baseReadback, itemId: "101" },
      { ...baseReadback, modelId: "1001" },
      { ...baseReadback, priceMinor: "119899" },
    ]) {
      await assert.rejects(reconcileIntent(context.intent.id, "LINK_VERIFIED_OBJECT", {
        repository: context.repository,
        actorId: "trusted-auditor",
        requestId: "reconcile-wrong-object",
        async readbackIntent() { return readback; },
      }), { code: "SHOPEE_DISCOUNT_RECONCILIATION_READBACK_MISMATCH" });
    }
    const result = await reconcileIntent(context.intent.id, "LINK_VERIFIED_OBJECT", {
      repository: context.repository,
      actorId: "trusted-auditor",
      requestId: "reconcile-1",
      async readbackIntent(intent) {
        return {
          verified: true,
          operationUuid: intent.operationUuid,
          payloadHash: intent.payloadHash,
          platformObjectId: "900",
          activityId: "900",
          membership: true,
          itemId: "100",
          modelId: "1000",
          priceMinor: "119900",
        };
      },
    });
    assert.equal(result.status, "LINK_VERIFIED_OBJECT");
    assert.equal(result.platformObjectId, "900");
    const db = context.access.provider.connection;
    const intent = db.prepare("SELECT status,platform_object_id,reconciled_by FROM shopee_discount_dispatch_intents WHERE id=?").get(context.intent.id);
    assert.equal(intent.status, "LINK_VERIFIED_OBJECT");
    assert.equal(intent.platform_object_id, "900");
    assert.equal(intent.reconciled_by, "trusted-auditor");
    assert.equal(db.prepare("SELECT status FROM shopee_discount_execution_items WHERE job_id='job-reconcile'").get().status, "SUCCEEDED");
  } finally {
    await context.close();
  }
});

test("CONFIRMED_NOT_SENT requires deterministic official or relay non-transmission evidence and never requeues", async () => {
  const context = await fixture();
  try {
    const { reconcileIntent } = await import("../lib/shopee-discount/reconciliation.mjs");
    const base = { repository: context.repository, actorId: "trusted-auditor", requestId: "reconcile-2" };
    await assert.rejects(reconcileIntent(context.intent.id, "CONFIRMED_NOT_SENT", base), {
      code: "SHOPEE_DISCOUNT_RECONCILIATION_EVIDENCE_REQUIRED",
    });
    await assert.rejects(reconcileIntent(context.intent.id, "CONFIRMED_NOT_SENT", {
      ...base,
      async confirmNotSent() { return { deterministic: false, source: "RELAY", transmitted: false, operationUuid: OPERATION_UUID }; },
    }), { code: "SHOPEE_DISCOUNT_RECONCILIATION_EVIDENCE_REQUIRED" });
    const result = await reconcileIntent(context.intent.id, "CONFIRMED_NOT_SENT", {
      ...base,
      async confirmNotSent(intent) {
        return { deterministic: true, source: "RELAY", transmitted: false, operationUuid: intent.operationUuid, relaySequence: "42" };
      },
    });
    assert.equal(result.status, "CONFIRMED_NOT_SENT");
    const db = context.access.provider.connection;
    const intent = db.prepare("SELECT status,operation_uuid FROM shopee_discount_dispatch_intents WHERE id=?").get(context.intent.id);
    assert.equal(intent.status, "CONFIRMED_NOT_SENT");
    assert.equal(intent.operation_uuid, OPERATION_UUID);
    assert.equal(db.prepare("SELECT status FROM shopee_discount_execution_items WHERE job_id='job-reconcile'").get().status, "SKIPPED");
  } finally {
    await context.close();
  }
});

test("ABANDONED records bounded redacted operator acceptance without claiming platform success", async () => {
  const context = await fixture();
  try {
    const { reconcileIntent } = await import("../lib/shopee-discount/reconciliation.mjs");
    const base = { repository: context.repository, actorId: "trusted-auditor", requestId: "reconcile-3" };
    await assert.rejects(reconcileIntent(context.intent.id, "ABANDONED", base), {
      code: "SHOPEE_DISCOUNT_RECONCILIATION_EVIDENCE_REQUIRED",
    });
    const result = await reconcileIntent(context.intent.id, "ABANDONED", {
      ...base,
      evidence: {
        accepted: true,
        reasonCode: "OPERATOR_ACCEPTED_UNRESOLVED",
        note: "platform state cannot be determined",
        authorization: "Bearer must-not-persist",
        oversized: "x".repeat(1_000),
      },
    });
    assert.equal(result.status, "ABANDONED");
    assert.equal(result.platformObjectId, null);
    const db = context.access.provider.connection;
    const intent = db.prepare("SELECT evidence_json,readback_json FROM shopee_discount_dispatch_intents WHERE id=?").get(context.intent.id);
    assert.equal(intent.readback_json, null);
    assert.equal(intent.evidence_json.includes("must-not-persist"), false);
    assert.ok(intent.evidence_json.length <= 4_096);
    assert.equal(db.prepare("SELECT status FROM shopee_discount_execution_items WHERE job_id='job-reconcile'").get().status, "UNKNOWN");
  } finally {
    await context.close();
  }
});

test("reconciliation rejects invalid transitions, requeue, replacement UUID, and already-closed intents", async () => {
  const context = await fixture();
  try {
    const { reconcileIntent } = await import("../lib/shopee-discount/reconciliation.mjs");
    const base = {
      repository: context.repository,
      actorId: "trusted-auditor",
      requestId: "reconcile-4",
      evidence: { accepted: true, reasonCode: "OPERATOR_ACCEPTED_UNRESOLVED" },
    };
    await assert.rejects(reconcileIntent(context.intent.id, "PENDING", base), {
      code: "SHOPEE_DISCOUNT_RECONCILIATION_INVALID",
    });
    await assert.rejects(reconcileIntent(context.intent.id, "ABANDONED", { ...base, requeue: true }), {
      code: "SHOPEE_DISCOUNT_RECONCILIATION_REPLACEMENT_FORBIDDEN",
    });
    await assert.rejects(reconcileIntent(context.intent.id, "ABANDONED", {
      ...base,
      replacementOperationUuid: "22222222-2222-4222-8222-222222222222",
    }), { code: "SHOPEE_DISCOUNT_RECONCILIATION_REPLACEMENT_FORBIDDEN" });
    await reconcileIntent(context.intent.id, "ABANDONED", base);
    await assert.rejects(reconcileIntent(context.intent.id, "ABANDONED", base), {
      code: "SHOPEE_DISCOUNT_RECONCILIATION_CLOSED",
    });
  } finally {
    await context.close();
  }
});

test("LINK_VERIFIED_OBJECT for create verifies the stored marker identity and atomically binds the activity", async () => {
  const context = await fixture();
  try {
    const metadata = {
      workflow: "NEXT_RENEWAL",
      priceTier: "DAILY",
      discountName: "PM-TH-DAILY-2026-08-15-A1B2C3D4",
      marker: "PM-TH-DAILY-2026-08-15-A1B2C3D4",
      fingerprint: "f".repeat(64),
    };
    context.access.provider.connection.prepare(`UPDATE shopee_discount_activities
      SET activity_type='NEXT_RENEWAL',platform_activity_id=NULL,metadata_json=? WHERE plan_id='plan-reconcile'`).run(JSON.stringify(metadata));
    const target = {
      discountName: metadata.discountName,
      startTime: String(Date.parse("2026-08-15T00:00:00.000Z") / 1_000),
      endTime: String(Date.parse("2026-09-14T00:00:00.000Z") / 1_000),
      fingerprint: metadata.fingerprint,
    };
    const intent = await context.repository.createDispatchIntent({
      id: "intent-create-reconcile", jobId: "job-reconcile", planId: "plan-reconcile",
      operationUuid: "22222222-2222-4222-8222-222222222222", targetType: "createDiscount",
      targetKey: `1\u001f${metadata.fingerprint}`,
      payloadHash: createHash("sha256").update(JSON.stringify(target)).digest("hex"), ownerId: "worker-1", epoch: 1,
    });
    await context.repository.markDispatchUnknown({ intentId: intent.id, ownerId: "worker-1", epoch: 1, evidence: { responseLost: true } });
    const { reconcileIntent } = await import("../lib/shopee-discount/reconciliation.mjs");
    const exact = {
      verified: true, markerVerified: true, operationUuid: intent.operationUuid, payloadHash: intent.payloadHash,
      platformObjectId: "901", shopId: "1", discountName: metadata.discountName, marker: metadata.marker,
      fingerprint: metadata.fingerprint, startTime: target.startTime, endTime: target.endTime,
    };
    await assert.rejects(reconcileIntent(intent.id, "LINK_VERIFIED_OBJECT", {
      repository: context.repository, actorId: "trusted-auditor", requestId: "reconcile-create-wrong",
      async readbackIntent() { return { ...exact, fingerprint: "wrong" }; },
    }), { code: "SHOPEE_DISCOUNT_RECONCILIATION_READBACK_MISMATCH" });
    const result = await reconcileIntent(intent.id, "LINK_VERIFIED_OBJECT", {
      repository: context.repository, actorId: "trusted-auditor", requestId: "reconcile-create",
      async readbackIntent() { return exact; },
    });
    assert.equal(result.status, "LINK_VERIFIED_OBJECT");
    const activity = context.access.provider.connection.prepare(`SELECT platform_activity_id FROM shopee_discount_activities
      WHERE plan_id='plan-reconcile' AND shop_id='1'`).get();
    assert.equal(activity.platform_activity_id, "901");
  } finally { await context.close(); }
});

test("oversized reconciliation evidence keeps essential proof fields and a cryptographic digest", async () => {
  const context = await fixture();
  try {
    const { reconcileIntent } = await import("../lib/shopee-discount/reconciliation.mjs");
    await reconcileIntent(context.intent.id, "CONFIRMED_NOT_SENT", {
      repository: context.repository, actorId: "trusted-auditor", requestId: "reconcile-large-proof",
      async confirmNotSent(intent) {
        return { deterministic: true, source: "RELAY", transmitted: false, operationUuid: intent.operationUuid, trace: "x".repeat(20_000) };
      },
    });
    const evidence = JSON.parse(context.access.provider.connection.prepare(
      "SELECT evidence_json FROM shopee_discount_dispatch_intents WHERE id=?",
    ).get(context.intent.id).evidence_json);
    assert.equal(evidence.requestId, "reconcile-large-proof");
    assert.equal(evidence.operationUuid, OPERATION_UUID);
    assert.equal(evidence.source, "RELAY");
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
    assert.ok(JSON.stringify(evidence).length <= 4_096);
  } finally { await context.close(); }
});
