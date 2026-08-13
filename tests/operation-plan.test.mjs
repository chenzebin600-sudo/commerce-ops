import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import {
  foundationCanonicalJson,
  foundationContentHash,
} from "../lib/foundation/foundation-contracts.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";

const PROJECT_ROOT = path.resolve(".");

async function createContext() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-operation-plan-"));
  const access = openCommerceDataAccess({
    rootDir: PROJECT_ROOT,
    databasePath: path.join(root, "operation-plan.sqlite"),
  });
  let current = new Date("2026-08-04T06:00:00.000Z");
  return {
    root,
    access,
    service: new FoundationService({
      repository: access.repositories.foundation,
      now: () => new Date(current),
    }),
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    async close() {
      access.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function preview(overrides = {}) {
  return {
    operationType: "FULFILLMENT.SUBMIT",
    scope: { shopId: "shop-1", orderIds: ["order-1"] },
    sourceSnapshot: { capturedAt: "2026-08-04T05:59:00.000Z", inventory: 8 },
    policy: { channelId: "channel-1", warehouseMode: "single" },
    items: [{ orderId: "order-1", quantity: 1 }],
    summary: { orderCount: 1 },
    approvalMode: "human",
    approvalText: "确认发货 1 单",
    createdBy: "operator-1",
    ...overrides,
  };
}

test("operation plan hashing is canonical and rejects unsafe values", () => {
  assert.equal(
    foundationCanonicalJson({ z: 1, nested: { b: 2, a: 1 } }),
    foundationCanonicalJson({ nested: { a: 1, b: 2 }, z: 1 }),
  );
  assert.equal(
    foundationContentHash({ z: 1, a: [2, 3] }),
    foundationContentHash({ a: [2, 3], z: 1 }),
  );
  assert.throws(() => foundationContentHash({ invalid: Number.NaN }), /finite/);
  assert.throws(() => foundationContentHash({ invalid: undefined }), /undefined/);
});

test("operation plans bind exact content, approval text and immutable hashes", async () => {
  const context = await createContext();
  try {
    const plan = await context.service.operationPlans.create(preview());
    assert.equal(plan.state, "PREVIEWED");
    assert.equal(plan.approvalMode, "human");
    assert.equal(JSON.stringify(plan).includes("确认发货 1 单"), false);
    await assert.rejects(
      context.service.operationPlans.approve(plan.id, {
        planHash: plan.planHash,
        approvalText: "确认发货 2 单",
        actorId: "operator-1",
      }),
      { code: "FOUNDATION_OPERATION_APPROVAL_TEXT_MISMATCH" },
    );
    const approved = await context.service.operationPlans.approve(plan.id, {
      planHash: plan.planHash,
      approvalText: "确认发货 1 单",
      actorId: "operator-1",
    });
    assert.equal(approved.state, "APPROVED");
    assert.equal(approved.planHash, plan.planHash);
    assert.equal(approved.approvedBy, "operator-1");
    const events = await context.service.operationPlans.events(plan.id);
    assert.deepEqual(events.map((event) => event.toState), ["PREVIEWED", "APPROVED"]);
  } finally {
    await context.close();
  }
});

test("supplied operation-plan IDs are idempotent only for the complete immutable binding", async () => {
  const context = await createContext();
  try {
    const input = preview({ id: "stable-preview-id", ttlMs: 60_000 });
    const created = await context.service.operationPlans.create(input);
    context.advance(5_000);
    assert.equal((await context.service.operationPlans.create(input)).id, created.id);
    for (const changed of [
      { scope: { shopId: "shop-2", orderIds: ["order-1"] } },
      { approvalText: "确认发货 2 单" },
      { approvalMode: "system", approvalText: null },
      { ttlMs: 120_000 },
      { createdBy: "operator-2" },
    ]) {
      await assert.rejects(context.service.operationPlans.create({ ...input, ...changed }),
        { code: "FOUNDATION_OPERATION_PLAN_IDEMPOTENCY_CONFLICT" });
    }
  } finally { await context.close(); }
});

test("repeated approval verifies actor type, actor ID, exact text, plan hash and mode", async () => {
  const context = await createContext();
  try {
    const plan = await context.service.operationPlans.create(preview());
    const binding = { planHash: plan.planHash, approvalText: "确认发货 1 单", actorType: "user", actorId: "operator-1" };
    await context.service.operationPlans.approve(plan.id, binding);
    assert.equal((await context.service.operationPlans.approve(plan.id, binding)).state, "APPROVED");
    for (const changed of [
      { actorType: "system" }, { actorId: "operator-2" }, { approvalText: "确认发货 2 单" }, { planHash: "changed" },
    ]) await assert.rejects(context.service.operationPlans.approve(plan.id, { ...binding, ...changed }),
      { code: "FOUNDATION_OPERATION_APPROVAL_CHANGED" });
  } finally { await context.close(); }
});

test("approval state and exact APPROVED event commit atomically and retry after event failure", async () => {
  const context = await createContext();
  try {
    const plan = await context.service.operationPlans.create(preview());
    const provider = context.access.provider;
    const execute = provider.execute.bind(provider);
    let failApprovalEvent = true;
    provider.execute = async (sql, parameters) => {
      if (failApprovalEvent && sql.includes("INSERT INTO foundation_operation_plan_events") && parameters[2] === "APPROVED") {
        failApprovalEvent = false;
        throw Object.assign(new Error("event store unavailable"), { code: "FOUNDATION_EVENT_WRITE_FAILED" });
      }
      return execute(sql, parameters);
    };
    const binding = { planHash: plan.planHash, approvalText: "确认发货 1 单", actorType: "user", actorId: "operator-1" };
    await assert.rejects(context.service.operationPlans.approve(plan.id, binding), { code: "FOUNDATION_EVENT_WRITE_FAILED" });
    assert.equal((await context.service.operationPlans.get(plan.id)).state, "PREVIEWED");
    assert.equal((await context.service.operationPlans.events(plan.id)).some((event) => event.eventType === "APPROVED"), false);
    const approved = await Promise.all([
      context.service.operationPlans.approve(plan.id, binding),
      context.service.operationPlans.approve(plan.id, binding),
    ]);
    assert.equal(approved.every(({ state }) => state === "APPROVED"), true);
    const approvalEvents = (await context.service.operationPlans.events(plan.id)).filter((event) => event.eventType === "APPROVED");
    assert.equal(approvalEvents.length, 1);
    assert.equal(approvalEvents[0].evidence.approvalTextHash, plan.approvalTextHash);
    assert.equal((await context.service.operationPlans.approve(plan.id, binding)).state, "APPROVED");
  } finally { await context.close(); }
});

test("operation plans reject secrets before persistence", async () => {
  const context = await createContext();
  try {
    await assert.rejects(
      context.service.operationPlans.create(preview({
        sourceSnapshot: { orderId: "order-1", accessToken: "must-not-persist" },
      })),
      { code: "FOUNDATION_OPERATION_PLAN_SENSITIVE_DATA" },
    );
    assert.equal(
      context.access.provider.connection.prepare(
        "SELECT COUNT(*) AS count FROM foundation_operation_plans",
      ).get().count,
      0,
    );
  } finally {
    await context.close();
  }
});

test("execution blocks when the approved source snapshot drifts", async () => {
  const context = await createContext();
  try {
    const input = preview();
    const plan = await context.service.operationPlans.create(input);
    await context.service.operationPlans.approve(plan.id, {
      planHash: plan.planHash,
      approvalText: input.approvalText,
      actorId: "operator-1",
    });
    await assert.rejects(
      context.service.operationPlans.beginExecution(plan.id, {
        planHash: plan.planHash,
        scope: input.scope,
        sourceSnapshot: { ...input.sourceSnapshot, inventory: 7 },
        policy: input.policy,
        items: input.items,
      }),
      { code: "FOUNDATION_OPERATION_PLAN_INPUT_DRIFT" },
    );
    const blocked = await context.service.operationPlans.get(plan.id);
    assert.equal(blocked.state, "BLOCKED");
    assert.equal(blocked.lastErrorCode, "FOUNDATION_OPERATION_PLAN_INPUT_DRIFT");
  } finally {
    await context.close();
  }
});

test("UNKNOWN cannot be re-executed and only official readback can reconcile it", async () => {
  const context = await createContext();
  try {
    const input = preview();
    const plan = await context.service.operationPlans.create(input);
    await context.service.operationPlans.approve(plan.id, {
      planHash: plan.planHash,
      approvalText: input.approvalText,
      actorId: "operator-1",
    });
    await context.service.operationPlans.beginExecution(plan.id, {
      planHash: plan.planHash,
      scope: input.scope,
      sourceSnapshot: input.sourceSnapshot,
      policy: input.policy,
      items: input.items,
    });
    const unknown = await context.service.operationPlans.finish(plan.id, "UNKNOWN", {
      errorCode: "MABANG_TIMEOUT",
      errorMessage: "Write response was not observed.",
    });
    assert.equal(unknown.state, "UNKNOWN");
    await assert.rejects(
      context.service.operationPlans.beginExecution(plan.id, {
        planHash: plan.planHash,
        scope: input.scope,
        sourceSnapshot: input.sourceSnapshot,
        policy: input.policy,
        items: input.items,
      }),
      { code: "FOUNDATION_OPERATION_PLAN_TRANSITION_INVALID" },
    );
    await assert.rejects(
      context.service.operationPlans.reconcileUnknown(plan.id, "SUCCEEDED", { evidence: {} }),
      /official readback evidence/,
    );
    const reconciled = await context.service.operationPlans.reconcileUnknown(plan.id, "SUCCEEDED", {
      result: { externalStatus: "shipped" },
      evidence: { source: "mabang_order_readback", observedAt: "2026-08-04T06:02:00.000Z" },
    });
    assert.equal(reconciled.state, "SUCCEEDED");
    assert.equal(reconciled.lastErrorCode, null);
  } finally {
    await context.close();
  }
});

test("expired plans cannot be approved", async () => {
  const context = await createContext();
  try {
    const input = preview({ ttlMs: 1_000 });
    const plan = await context.service.operationPlans.create(input);
    context.advance(1_001);
    await assert.rejects(
      context.service.operationPlans.approve(plan.id, {
        planHash: plan.planHash,
        approvalText: input.approvalText,
        actorId: "operator-1",
      }),
      { code: "FOUNDATION_OPERATION_PLAN_EXPIRED" },
    );
    assert.equal((await context.service.operationPlans.get(plan.id)).state, "EXPIRED");
  } finally {
    await context.close();
  }
});
