import { createHash, randomUUID } from "node:crypto";
import { buildApprovalRoot, buildApprovalRootFromShardHashes } from "./approval-hash.mjs";
import { assertShopeeWriteAuthorized } from "./write-security.mjs";
import { buildRenewalActivityIdentity } from "./renewal-activity.mjs";

const TERMINAL_ITEM_STATES = Object.freeze([
  "SUCCEEDED", "REJECTED", "CONFLICT", "AUTH_BLOCKED", "UNKNOWN", "REQUIRES_REAPPROVAL", "SKIPPED",
]);

function executionError(code, message, evidence = null) {
  return Object.assign(new Error(message), { code, ...(evidence ? { evidence } : {}) });
}

function requiredContext(workerContext) {
  if (!workerContext?.repository || !workerContext?.foundation?.operationPlans) {
    throw new TypeError("Executor repository and Foundation services are required");
  }
  return workerContext;
}

function nonEmptyText(value, name) {
  const output = String(value ?? "").trim();
  if (!output) throw new TypeError(`${name} is required`);
  return output;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function assertDualApproval(planId, workerContext) {
  const context = requiredContext(workerContext);
  const plan = await context.repository.getPlan(planId);
  if (!plan) throw executionError("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
  const jobs = await context.repository.listExecutionJobs(plan.id);
  const job = jobs[0] || null;
  const resuming = plan.state === "EXECUTING" && job?.status === "RUNNING";
  if (plan.state !== "APPROVED" && !resuming) {
    throw executionError("SHOPEE_DISCOUNT_EXECUTION_NOT_APPROVED", "Domain plan is not approved");
  }
  const [approval, phase, foundationPlan] = await Promise.all([
    context.repository.getPlanApproval(plan.id),
    context.repository.getApprovalSagaPhase(plan.id),
    plan.foundationPlanId ? context.foundation.operationPlans.get(plan.foundationPlanId) : null,
  ]);
  const matches = approval
    && phase?.phase === "BOTH_APPROVED"
    && (foundationPlan?.state === "APPROVED" || (resuming && foundationPlan?.state === "IN_FLIGHT"))
    && approval.merkleRoot === plan.merkleRoot
    && approval.policyHash === plan.policyHash
    && foundationPlan.summary?.merkleRoot === plan.merkleRoot
    && foundationPlan.policyHash === plan.policyHash
    && foundationPlan.approvedBy === approval.actorId
    && phase.evidence?.foundationPlanHash === foundationPlan.planHash;
  if (!matches) {
    throw executionError(
      "SHOPEE_DISCOUNT_FOUNDATION_APPROVAL_REQUIRED",
      "Execution requires matching domain and Foundation approvals",
    );
  }
  const now = context.now ? context.now() : new Date();
  if (!plan.expiresAt || new Date(plan.expiresAt).getTime() <= new Date(now).getTime()) {
    throw executionError("SHOPEE_DISCOUNT_PLAN_EXPIRED", "Approved plan has expired");
  }
  if (nonEmptyText(context.currentPolicyHash, "currentPolicyHash") !== plan.policyHash) {
    throw executionError("SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH", "Execution policy changed after approval");
  }
  return { plan, approval, foundationPlan, job, resuming };
}

function approvalItem(plan, item) {
  const target = item.payload.approvalTarget || {};
  return {
    shop_id: item.shopId,
    item_id: item.itemId,
    model_id: item.modelId,
    country: plan.country,
    sku: item.sku,
    original_minor: item.payload.originalMinor,
    target_minor: item.targetPriceMinor,
    price_source: item.payload.priceSource,
    price_tier: item.payload.priceTier,
    rule_source: item.payload.ruleSource,
    warehouse_watermark: item.payload.warehouseWatermark,
    warehouse_approved_at: item.payload.warehouseApprovedAt ?? null,
    activity_type: target.activityType,
    target_discount_id: target.targetDiscountId ?? null,
    renewal_discount_name: target.renewalDiscountName ?? null,
    renewal_marker: target.renewalMarker ?? null,
    renewal_price_tier: target.renewalPriceTier ?? null,
    renewal_starts_at: target.renewalStartsAt ?? null,
    renewal_ends_at: target.renewalEndsAt ?? null,
    renewal_fingerprint: target.renewalFingerprint ?? null,
  };
}

async function assertApprovalRoot(plan, repository) {
  const shards = await repository.listPlanShards(plan.id);
  const rebuiltHashes = [];
  let cursor = -1;
  let itemCount = 0;
  for (const shard of shards) {
    if (shard.itemCount < 1 || shard.itemCount > 1000) {
      throw executionError("SHOPEE_DISCOUNT_APPROVAL_SHARD_LIMIT", "Approval shard exceeds the bounded verifier limit");
    }
    const items = [];
    while (items.length < shard.itemCount) {
      const page = await repository.listPlanItems(plan.id, { cursor, pageSize: Math.min(100, shard.itemCount - items.length) });
      if (!page.items.length) break;
      items.push(...page.items);
      cursor = Number(page.items.at(-1).sequence);
    }
    const rebuiltShard = buildApprovalRoot(items.map((item) => approvalItem(plan, item)), { shardSize: shard.itemCount });
    rebuiltHashes.push(rebuiltShard.shardHashes[0]);
    itemCount += items.length;
  }
  const rebuilt = buildApprovalRootFromShardHashes(rebuiltHashes, itemCount);
  const exactShards = rebuilt.shardHashes.length === shards.length
    && rebuilt.shardHashes.every((hash, index) => hash === shards[index]?.shardHash);
  if (!exactShards || rebuilt.root !== plan.merkleRoot || rebuilt.itemCount !== plan.itemCount) {
    throw executionError("SHOPEE_DISCOUNT_APPROVAL_REHASH_MISMATCH", "Persisted preview items do not match the approved Merkle root");
  }
}

function leaseGuard({ repository, jobId, workerId, epoch, leaseMs }) {
  let stopped = false;
  let lost = false;
  let inFlight = null;
  const renew = async () => {
    if (stopped || lost) return false;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const current = await repository.renewJobLease({ jobId, ownerId: workerId, epoch, leaseMs });
        if (!current) lost = true;
        return Boolean(current);
      } catch {
        lost = true;
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  const interval = setInterval(() => { renew().catch(() => { lost = true; }); }, Math.max(1, Math.floor(leaseMs / 3)));
  interval.unref?.();
  return {
    renew,
    get lost() { return lost; },
    stop() { stopped = true; clearInterval(interval); },
  };
}

async function markItem(repository, lease, input) {
  if (!await lease.renew()) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution lease was lost");
  const updated = await repository.setExecutionItemStatus(input);
  if (!updated) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution item checkpoint lost fencing ownership");
}

async function appendAuthIssue(repository, { planId, jobId, shopId, requestId, actorId, intentId = null }) {
  await repository.appendEvent({
    planId,
    jobId,
    intentId,
    eventType: "EXECUTION_ISSUE",
    actorId,
    reasonCode: "SHOPEE_AUTH_ERROR",
    evidence: { priority: "HIGH", shopId, requestId },
  });
}

function itemWritePayload(item, add) {
  return {
    itemId: item.itemId,
    models: [{ modelId: item.modelId, modelPromotionPriceMinor: item.targetPriceMinor }],
    ...(add ? { purchaseLimit: 0 } : {}),
  };
}

function definiteWriteOutcome(cause) {
  if (cause?.code === "SHOPEE_AUTH_ERROR") return { intentStatus: "CONFIRMED_NOT_SENT", itemStatus: "AUTH_BLOCKED" };
  if (new Set(["SHOPEE_BUSINESS_ERROR", "SHOPEE_INPUT_INVALID"]).has(cause?.code)) {
    return { intentStatus: "CONFIRMED_NOT_SENT", itemStatus: "REJECTED" };
  }
  return { intentStatus: "UNKNOWN", itemStatus: "UNKNOWN" };
}

function exactReadback(readback, item, activityId) {
  return Boolean(readback
    && String(readback.activityId || "") === String(activityId)
    && String(readback.platformObjectId || "") === String(activityId)
    && readback.membership === true
    && String(readback.itemId || "") === String(item.itemId)
    && readback.modelId != null
    && String(readback.modelId) === String(item.modelId)
    && String(readback.priceMinor ?? "") === item.targetPriceMinor
  );
}

function epochSeconds(value, name) {
  const millis = new Date(value).getTime();
  if (!Number.isFinite(millis) || millis <= 0 || millis % 1_000 !== 0) throw new TypeError(`${name} must be a whole-second timestamp`);
  return String(millis / 1_000);
}

function resultSummary(planId, jobId, status, items) {
  const counts = Object.fromEntries(TERMINAL_ITEM_STATES.map((state) => [state, 0]));
  for (const item of items) if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  return { planId, jobId, status, counts, itemCount: items.length };
}

function jobOutcome(items) {
  if (items.length && items.every((item) => new Set(["SUCCEEDED", "SKIPPED"]).has(item.status))) return "SUCCEEDED";
  if (items.some((item) => item.status === "SUCCEEDED")) return "PARTIAL_SUCCESS";
  if (items.some((item) => new Set(["UNKNOWN", "AUTH_BLOCKED"]).has(item.status))) return "BLOCKED";
  return "FAILED";
}

function summaryFromCounts(planId, jobId, counts) {
  const normalized = Object.fromEntries(TERMINAL_ITEM_STATES.map((state) => [state, Number(counts[state] || 0)]));
  const itemCount = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  const successful = normalized.SUCCEEDED + normalized.SKIPPED;
  const status = itemCount > 0 && successful === itemCount ? "SUCCEEDED"
    : normalized.SUCCEEDED > 0 ? "PARTIAL_SUCCESS"
      : normalized.UNKNOWN + normalized.AUTH_BLOCKED > 0 ? "BLOCKED" : "FAILED";
  return { planId, jobId, status, counts: normalized, itemCount };
}

function warehouseMatches(item, warehouse) {
  return Boolean(warehouse
    && warehouse.targetPriceMinor === item.targetPriceMinor
    && warehouse.watermark === item.payload.warehouseWatermark
    && (warehouse.approvedAt ?? null) === (item.payload.warehouseApprovedAt ?? null));
}

async function prepareRenewalShop({ plan, job, activity, items, approval, context, lease, epoch }) {
  if (!items.length) return { status: "SKIPPED", reasonCode: "SHOPEE_DISCOUNT_NO_EXECUTABLE_ITEMS" };
  const blocked = (status, reasonCode, evidence = {}) => ({ status, reasonCode, evidence });
  try {
    const metadata = activity.metadata || {};
    const identityBound = items.every((item) => {
      const target = item.payload.approvalTarget || {};
      return target.activityType === activity.activityType
        && target.targetDiscountId == null
        && target.renewalDiscountName === metadata.discountName
        && target.renewalMarker === metadata.marker
        && target.renewalPriceTier === metadata.priceTier
        && target.renewalStartsAt === activity.startsAt
        && target.renewalEndsAt === activity.endsAt
        && target.renewalFingerprint === metadata.fingerprint;
    });
    if (!identityBound) return blocked("REQUIRES_REAPPROVAL", "SHOPEE_DISCOUNT_ACTIVITY_IDENTITY_DRIFT");
    assertShopeeWriteAuthorized(context.writeSecurity(), {
      action: "execute",
      identity: context.identity,
      approvalIdentity: approval.evidence?.approvalIdentity,
      country: plan.country,
      shopId: activity.shopId,
      batchSize: 1,
    });
    if (!Number.isSafeInteger(context.siteCapability?.maxAddItems) || context.siteCapability.maxAddItems < 1
      || items.some((item) => context.siteCapability?.priceScale !== item.scale)) {
      return blocked("REQUIRES_REAPPROVAL", "SHOPEE_SITE_CAPABILITY_CHANGED");
    }
    const authorization = await context.readers.getShopAuthorization({ shopId: activity.shopId, requestId: context.requestId });
    if (authorization?.authorized !== true) return blocked("AUTH_BLOCKED", "SHOPEE_AUTH_ERROR");
    for (const item of items) {
      const warehouse = await context.readers.getWarehouseState({ plan, item, requestId: context.requestId });
      if (!warehouseMatches(item, warehouse)) return blocked("REQUIRES_REAPPROVAL", "WAREHOUSE_PRICE_DRIFT", { planItemId: item.id });
      const listing = await context.readers.getListingState({ plan, item, requestId: context.requestId });
      if (!listing || listing.status !== "ACTIVE" || listing.sku !== item.sku || listing.originalPriceMinor !== item.payload.originalMinor) {
        return blocked("REQUIRES_REAPPROVAL", "SHOPEE_LISTING_DRIFT", { planItemId: item.id });
      }
      const discount = await context.readers.getDiscountState({ plan, item, activity, requestId: context.requestId });
      if (discount?.conflict) return blocked("CONFLICT", "SHOPEE_DISCOUNT_EXTERNAL_CONFLICT", { planItemId: item.id });
    }
    if (!await lease.renew()) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution lease was lost during shop preparation");
    return { status: "READY" };
  } catch (cause) {
    if (cause?.code === "SHOPEE_DISCOUNT_LEASE_LOST") throw cause;
    if (new Set(["SHOPEE_AUTH_ERROR", "SHOPEE_WRITE_TARGET_NOT_AUTHORIZED"]).has(cause?.code)) {
      await appendAuthIssue(context.repository, {
        planId: plan.id, jobId: job.id, shopId: activity.shopId, requestId: context.requestId,
        actorId: context.workerId, reasonCode: cause.code,
      });
      return blocked("AUTH_BLOCKED", cause.code);
    }
    return blocked("UNKNOWN", cause?.code || "SHOPEE_PREFLIGHT_UNKNOWN");
  }
}

async function processItem({ plan, job, item, activity, approval, context, lease, epoch }) {
  const base = { jobId: job.id, planItemId: item.id, ownerId: context.workerId, epoch };
  const security = context.writeSecurity();
  try {
    assertShopeeWriteAuthorized(security, {
      action: "execute",
      identity: context.identity,
      approvalIdentity: approval.evidence?.approvalIdentity,
      country: plan.country,
      shopId: item.shopId,
      batchSize: 1,
    });
  } catch (cause) {
    if (cause?.code !== "SHOPEE_WRITE_TARGET_NOT_AUTHORIZED") throw cause;
    await markItem(context.repository, lease, {
      ...base, status: "AUTH_BLOCKED", reasonCode: cause.code, evidence: { shopId: item.shopId },
    });
    await appendAuthIssue(context.repository, {
      planId: plan.id, jobId: job.id, shopId: item.shopId, requestId: context.requestId, actorId: context.workerId,
      reasonCode: cause.code,
    });
    return { stopShop: true, status: "AUTH_BLOCKED", reasonCode: cause.code };
  }
  if (context.siteCapability?.priceScale !== item.scale) {
    await markItem(context.repository, lease, { ...base, status: "REQUIRES_REAPPROVAL", reasonCode: "SHOPEE_SITE_SCALE_CHANGED" });
    return;
  }
  const authorization = await context.readers.getShopAuthorization({ shopId: item.shopId, requestId: context.requestId });
  if (authorization?.authorized !== true) {
    await markItem(context.repository, lease, { ...base, status: "AUTH_BLOCKED", reasonCode: "SHOPEE_AUTH_ERROR" });
    await appendAuthIssue(context.repository, {
      planId: plan.id, jobId: job.id, shopId: item.shopId, requestId: context.requestId, actorId: context.workerId,
    });
    return { stopShop: true, status: "AUTH_BLOCKED", reasonCode: "SHOPEE_AUTH_ERROR" };
  }
  const warehouse = await context.readers.getWarehouseState({ plan, item, requestId: context.requestId });
  if (!warehouseMatches(item, warehouse)) {
    await markItem(context.repository, lease, { ...base, status: "REQUIRES_REAPPROVAL", reasonCode: "WAREHOUSE_PRICE_DRIFT" });
    return;
  }
  const listing = await context.readers.getListingState({ plan, item, requestId: context.requestId });
  if (!listing || listing.status !== "ACTIVE" || listing.sku !== item.sku || listing.originalPriceMinor !== item.payload.originalMinor) {
    await markItem(context.repository, lease, { ...base, status: "REQUIRES_REAPPROVAL", reasonCode: "SHOPEE_LISTING_DRIFT" });
    return;
  }
  const discount = await context.readers.getDiscountState({ plan, item, activity, requestId: context.requestId });
  if (discount?.conflict) {
    await markItem(context.repository, lease, { ...base, status: "CONFLICT", reasonCode: "SHOPEE_DISCOUNT_EXTERNAL_CONFLICT", evidence: { shopId: item.shopId } });
    return { stopShop: true, status: "CONFLICT", reasonCode: "SHOPEE_DISCOUNT_EXTERNAL_CONFLICT" };
  }
  const approvedActivityId = item.payload.approvalTarget?.targetDiscountId;
  const renewalTarget = item.payload.approvalTarget?.renewalFingerprint != null;
  if ((!renewalTarget && (!approvedActivityId || (activity?.platformActivityId && String(activity.platformActivityId) !== String(approvedActivityId))))
    || (renewalTarget && !activity?.platformActivityId)) {
    await markItem(context.repository, lease, { ...base, status: "REQUIRES_REAPPROVAL", reasonCode: "SHOPEE_DISCOUNT_APPROVED_TARGET_DRIFT" });
    return;
  }
  const activityId = approvedActivityId || activity.platformActivityId;
  if (!activityId) {
    await markItem(context.repository, lease, { ...base, status: "REQUIRES_REAPPROVAL", reasonCode: "SHOPEE_DISCOUNT_ACTIVITY_TARGET_MISSING" });
    return;
  }
  if (discount?.activityId && String(discount.activityId) !== String(activityId)) {
    await markItem(context.repository, lease, { ...base, status: "REQUIRES_REAPPROVAL", reasonCode: "SHOPEE_DISCOUNT_ACTIVITY_CHANGED" });
    return;
  }
  const add = discount?.membership !== true;
  const operation = add ? "addDiscountItems" : "updateDiscountItems";
  const payload = itemWritePayload(item, add);
  const operationUuid = randomUUID();
  const intent = await context.repository.createDispatchIntent({
    jobId: job.id,
    planId: plan.id,
    planItemId: item.id,
    operationUuid,
    targetType: operation,
    targetKey: `${item.shopId}\u001f${activityId}\u001f${item.itemId}\u001f${item.modelId}`,
    payloadHash: sha256(payload),
    ownerId: context.workerId,
    epoch,
  });
  await context.afterIntentPersisted?.(intent);
  if (!await lease.renew()) {
    throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution lease was lost immediately before dispatch");
  }
  try {
    await context.shopeeWrite[operation]({
      operationUuid,
      shopId: item.shopId,
      discountId: String(activityId),
      items: [payload],
      requestId: context.requestId,
    });
  } catch (cause) {
    const outcome = definiteWriteOutcome(cause);
    const recorded = await context.repository.recordIntentOutcome({
      intentId: intent.id, jobId: job.id, ownerId: context.workerId, epoch,
      ...outcome,
      reasonCode: cause?.code || "SHOPEE_WRITE_UNKNOWN",
      evidence: { operationUuid, requestId: context.requestId, code: cause?.code || "SHOPEE_WRITE_UNKNOWN", phase: "POST" },
    });
    if (!recorded) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Write outcome lost fencing ownership");
    if (outcome.itemStatus === "AUTH_BLOCKED") await appendAuthIssue(context.repository, {
      planId: plan.id, jobId: job.id, shopId: item.shopId, requestId: context.requestId,
      actorId: context.workerId, intentId: intent.id,
    });
    return outcome.itemStatus === "AUTH_BLOCKED"
      ? { stopShop: true, status: "AUTH_BLOCKED", reasonCode: cause.code }
      : { stopShop: false };
  }
  let readback;
  try {
    readback = await context.readers.readbackIntent({
      intent, plan, item, activity: { ...activity, platformActivityId: String(activityId) }, requestId: context.requestId,
    });
  } catch (cause) {
    const recorded = await context.repository.recordIntentOutcome({
      intentId: intent.id, jobId: job.id, ownerId: context.workerId, epoch,
      intentStatus: "UNKNOWN", itemStatus: "UNKNOWN", reasonCode: "SHOPEE_POST_WRITE_READBACK_UNKNOWN",
      evidence: { operationUuid, requestId: context.requestId, code: cause?.code || "READBACK_ERROR", phase: "READBACK" },
    });
    if (!recorded) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Readback uncertainty lost fencing ownership");
    return { stopShop: false };
  }
  try {
    if (!await lease.renew()) {
      await context.repository.appendEvent({
        planId: plan.id,
        jobId: job.id,
        intentId: intent.id,
        eventType: "LATE_RESPONSE_IGNORED",
        reasonCode: "SHOPEE_DISCOUNT_LEASE_LOST",
        evidence: { operationUuid, requestId: context.requestId },
      }).catch(() => {});
      throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Late response was fenced after lease loss");
    }
    const exact = exactReadback(readback, item, activityId);
    const mismatchStatus = readback?.membership === false
      || (readback?.activityId && String(readback.activityId) !== String(activityId)) ? "CONFLICT" : "UNKNOWN";
    const recorded = await context.repository.recordIntentOutcome({
      intentId: intent.id,
      jobId: job.id,
      ownerId: context.workerId,
      epoch,
      intentStatus: exact ? "SUCCEEDED" : "UNKNOWN",
      itemStatus: exact ? "SUCCEEDED" : mismatchStatus,
      reasonCode: exact ? null : "SHOPEE_POST_WRITE_READBACK_MISMATCH",
      platformObjectId: readback?.platformObjectId || null,
      readback,
      evidence: { operationUuid, requestId: context.requestId },
    });
    if (!recorded) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Late write result could not advance canonical state");
    return mismatchStatus === "CONFLICT"
      ? { stopShop: true, status: "CONFLICT", reasonCode: "SHOPEE_POST_WRITE_READBACK_CONFLICT" }
      : { stopShop: false };
  } catch (cause) {
    if (cause?.code === "SHOPEE_DISCOUNT_LEASE_LOST") throw cause;
    throw cause;
  }
}

async function recoverIntent({ intent, plan, job, item, activity, context, lease, epoch }) {
  if (!await lease.renew()) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution lease was lost before recovery readback");
  let readback = null;
  let itemStatus = "UNKNOWN";
  let reasonCode = "SHOPEE_RECOVERY_READBACK_UNKNOWN";
  try {
    readback = await context.readers.readbackIntent({ intent, plan, item, activity, requestId: context.requestId, recovery: true });
    if (!item && intent.targetType === "createDiscount" && readback?.markerVerified === true && readback?.platformObjectId) {
      const platformActivityId = String(readback.platformObjectId);
      const bound = await context.repository.bindActivityPlatformId({
        jobId: job.id, planId: plan.id, shopId: activity.shopId, ownerId: context.workerId, epoch,
        platformActivityId, evidence: { recovery: true, operationUuid: intent.operationUuid, requestId: context.requestId },
      });
      if (!bound) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Recovered activity binding lost fencing ownership");
      itemStatus = "SUCCEEDED";
      reasonCode = null;
      readback = { ...readback, platformObjectId };
    } else if (item && activity?.platformActivityId && exactReadback(readback, item, activity.platformActivityId)) {
      itemStatus = "SUCCEEDED";
      reasonCode = null;
    } else if (readback?.membership === false
      || (activity?.platformActivityId && readback?.activityId && String(readback.activityId) !== String(activity.platformActivityId))) {
      itemStatus = "CONFLICT";
      reasonCode = "SHOPEE_RECOVERY_READBACK_CONFLICT";
    }
  } catch (cause) {
    if (cause?.code === "SHOPEE_AUTH_ERROR") {
      itemStatus = "AUTH_BLOCKED";
      reasonCode = "SHOPEE_AUTH_ERROR";
    }
  }
  if (!await lease.renew()) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution lease was lost after recovery readback");
  const recorded = await context.repository.recordIntentOutcome({
    intentId: intent.id,
    jobId: job.id,
    ownerId: context.workerId,
    epoch,
    intentStatus: itemStatus === "SUCCEEDED" ? "SUCCEEDED" : "UNKNOWN",
    itemStatus,
    reasonCode,
    platformObjectId: readback?.platformObjectId || null,
    readback,
    evidence: { operationUuid: intent.operationUuid, requestId: context.requestId, recovery: true },
  });
  if (!recorded) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Recovery outcome lost fencing ownership");
  return { status: itemStatus, reasonCode, readback };
}

async function ensureRenewalActivity({ plan, job, activity, context, lease, epoch, validateBeforeCreate }) {
  if (activity.platformActivityId) return { activity, status: "READY" };
  const metadata = activity.metadata || {};
  let expectedIdentity = null;
  try {
    expectedIdentity = buildRenewalActivityIdentity({
      planId: plan.id,
      country: plan.country,
      shopId: activity.shopId,
      priceTier: metadata.priceTier,
      targetStartsAt: activity.startsAt,
      targetEndsAt: activity.endsAt,
    });
  } catch {
    expectedIdentity = null;
  }
  if (!expectedIdentity
    || activity.startsAt !== plan.targetStartsAt
    || activity.endsAt !== plan.targetEndsAt
    || metadata.workflow !== expectedIdentity.workflow
    || metadata.discountName !== expectedIdentity.discountName
    || metadata.fingerprint !== expectedIdentity.fingerprint) {
    return { activity, status: "REQUIRES_REAPPROVAL", reasonCode: "SHOPEE_DISCOUNT_ACTIVITY_FINGERPRINT_MISSING" };
  }
  let existing;
  try {
    existing = await context.readers.findActivityByMarker({ plan, activity, requestId: context.requestId });
  } catch (cause) {
    return {
      activity,
      status: cause?.code === "SHOPEE_AUTH_ERROR" ? "AUTH_BLOCKED" : "UNKNOWN",
      reasonCode: cause?.code || "SHOPEE_DISCOUNT_ACTIVITY_LOOKUP_UNKNOWN",
    };
  }
  if (existing) {
    if (existing.markerVerified !== true || !existing.platformObjectId) {
      return { activity, status: "UNKNOWN", reasonCode: "SHOPEE_DISCOUNT_ACTIVITY_LOOKUP_AMBIGUOUS" };
    }
    const bound = await context.repository.bindActivityPlatformId({
      jobId: job.id,
      planId: plan.id,
      shopId: activity.shopId,
      ownerId: context.workerId,
      epoch,
      platformActivityId: String(existing.platformObjectId),
      evidence: { markerVerified: true, requestId: context.requestId },
    });
    if (!bound) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Activity lookup binding lost fencing ownership");
    return { activity: { ...activity, platformActivityId: String(existing.platformObjectId) }, status: "READY" };
  }
  const operationUuid = randomUUID();
  const target = {
    discountName: metadata.discountName,
    startTime: epochSeconds(activity.startsAt, "activity.startsAt"),
    endTime: epochSeconds(activity.endsAt, "activity.endsAt"),
    fingerprint: metadata.fingerprint,
  };
  const revalidated = await validateBeforeCreate();
  if (revalidated.status !== "READY") return { activity, ...revalidated };
  const intent = await context.repository.createDispatchIntent({
    jobId: job.id,
    planId: plan.id,
    operationUuid,
    targetType: "createDiscount",
    targetKey: `${activity.shopId}\u001f${metadata.fingerprint}`,
    payloadHash: sha256(target),
    ownerId: context.workerId,
    epoch,
  });
  await context.afterIntentPersisted?.(intent);
  if (!await lease.renew()) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution lease was lost before activity creation");
  try {
    await context.shopeeWrite.createDiscount({
      operationUuid,
      shopId: activity.shopId,
      discountName: target.discountName,
      startTime: target.startTime,
      endTime: target.endTime,
      requestId: context.requestId,
    });
  } catch (cause) {
    const outcome = definiteWriteOutcome(cause);
    const recorded = await context.repository.recordIntentOutcome({
      intentId: intent.id, jobId: job.id, ownerId: context.workerId, epoch,
      ...outcome, reasonCode: cause?.code || "SHOPEE_WRITE_UNKNOWN",
      evidence: { operationUuid, requestId: context.requestId, code: cause?.code || "SHOPEE_WRITE_UNKNOWN", phase: "POST" },
    });
    if (!recorded) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Activity write outcome lost fencing ownership");
    if (outcome.itemStatus === "AUTH_BLOCKED") await appendAuthIssue(context.repository, {
      planId: plan.id, jobId: job.id, shopId: activity.shopId, requestId: context.requestId,
      actorId: context.workerId, intentId: intent.id,
    });
    return { activity, status: outcome.itemStatus, reasonCode: cause?.code || "SHOPEE_WRITE_UNKNOWN" };
  }
  let readback;
  try {
    readback = await context.readers.readbackIntent({
      intent, plan, item: null, activity, requestId: context.requestId,
    });
  } catch (cause) {
    const recorded = await context.repository.recordIntentOutcome({
      intentId: intent.id, jobId: job.id, ownerId: context.workerId, epoch,
      intentStatus: "UNKNOWN", itemStatus: "UNKNOWN", reasonCode: "SHOPEE_CREATE_READBACK_UNKNOWN",
      evidence: { operationUuid, requestId: context.requestId, code: cause?.code || "READBACK_ERROR", phase: "READBACK" },
    });
    if (!recorded) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Activity readback uncertainty lost fencing ownership");
    return { activity, status: "UNKNOWN", reasonCode: "SHOPEE_CREATE_READBACK_UNKNOWN" };
  }
  try {
    if (!await lease.renew()) {
      await context.repository.appendEvent({
        planId: plan.id,
        jobId: job.id,
        intentId: intent.id,
        eventType: "LATE_RESPONSE_IGNORED",
        reasonCode: "SHOPEE_DISCOUNT_LEASE_LOST",
        evidence: { operationUuid, requestId: context.requestId },
      }).catch(() => {});
      throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Late activity response was fenced after lease loss");
    }
    if (readback?.markerVerified !== true || !readback?.platformObjectId) {
      await context.repository.recordIntentOutcome({
        intentId: intent.id, jobId: job.id, ownerId: context.workerId, epoch,
        intentStatus: "UNKNOWN", itemStatus: "UNKNOWN", reasonCode: "SHOPEE_CREATE_READBACK_UNKNOWN",
        readback, evidence: { operationUuid, requestId: context.requestId },
      });
      return { activity, status: "UNKNOWN", reasonCode: "SHOPEE_CREATE_READBACK_UNKNOWN" };
    }
    const platformActivityId = String(readback.platformObjectId);
    const bound = await context.repository.bindActivityPlatformId({
      jobId: job.id, planId: plan.id, shopId: activity.shopId, ownerId: context.workerId, epoch,
      platformActivityId, evidence: { operationUuid, markerVerified: true, requestId: context.requestId },
    });
    if (!bound) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Created activity binding lost fencing ownership");
    const recorded = await context.repository.recordIntentOutcome({
      intentId: intent.id, jobId: job.id, ownerId: context.workerId, epoch,
      intentStatus: "SUCCEEDED", itemStatus: "SUCCEEDED", platformObjectId: platformActivityId,
      readback, evidence: { operationUuid, requestId: context.requestId },
    });
    if (!recorded) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Created activity outcome lost fencing ownership");
    return { activity: { ...activity, platformActivityId }, status: "READY" };
  } catch (cause) {
    if (cause?.code === "SHOPEE_DISCOUNT_LEASE_LOST") throw cause;
    throw cause;
  }
}

async function repairTerminalCompletion({ plan, job, context }) {
  if (job.input?.planId !== plan.id || job.input?.merkleRoot !== plan.merkleRoot || job.input?.policyHash !== plan.policyHash) {
    throw executionError("SHOPEE_DISCOUNT_JOB_BINDING_MISMATCH", "Execution job does not bind the requested plan");
  }
  let domainPlan = plan;
  if (domainPlan.state === "EXECUTING") {
    domainPlan = await context.repository.markPlanState({
      planId: domainPlan.id,
      fromState: "EXECUTING",
      toState: job.status,
      expectedVersion: domainPlan.stateVersion,
    });
  } else if (domainPlan.state !== job.status) {
    throw executionError("SHOPEE_DISCOUNT_COMPLETION_STATE_MISMATCH", "Terminal job and plan states do not match");
  }
  const foundationPlan = domainPlan.foundationPlanId
    ? await context.foundation.operationPlans.get(domainPlan.foundationPlanId)
    : null;
  if (!foundationPlan) throw executionError("SHOPEE_DISCOUNT_FOUNDATION_APPROVAL_REQUIRED", "Foundation plan is missing");
  const foundationOutcome = job.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
  if (foundationPlan.state === "APPROVED") {
    await beginFoundationExecution(foundationPlan, context);
  }
  const currentFoundation = await context.foundation.operationPlans.get(foundationPlan.id);
  if (currentFoundation.state === "IN_FLIGHT") {
    await context.foundation.operationPlans.finish(currentFoundation.id, foundationOutcome, {
      result: job.result,
      actorId: context.workerId,
      evidence: { domainState: domainPlan.state, completionRepair: true },
    });
  } else if (currentFoundation.state !== foundationOutcome) {
    throw executionError("SHOPEE_DISCOUNT_FOUNDATION_COMPLETION_MISMATCH", "Foundation completion state does not match the durable job");
  }
  return job.result;
}

async function beginFoundationExecution(foundationPlan, context) {
  const started = await context.foundation.operationPlans.beginExecution(foundationPlan.id, {
    planHash: foundationPlan.planHash,
    scope: foundationPlan.scope,
    sourceSnapshot: foundationPlan.sourceSnapshot,
    policy: foundationPlan.policy,
    items: foundationPlan.items,
    actorId: context.workerId,
  });
  if (started?.state !== "IN_FLIGHT") {
    throw executionError("SHOPEE_DISCOUNT_FOUNDATION_EXECUTION_REQUIRED", "Foundation plan did not enter execution");
  }
  return started;
}

export async function runApprovedPlan(planId, workerContext) {
  const context = requiredContext(workerContext);
  nonEmptyText(context.workerId, "workerId");
  nonEmptyText(context.requestId, "requestId");
  if (!context.readers || !context.shopeeWrite || typeof context.writeSecurity !== "function") {
    throw new TypeError("Executor read, write, and security adapters are required");
  }
  const persistedPlan = await context.repository.getPlan(planId);
  if (!persistedPlan) throw executionError("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
  const persistedJob = (await context.repository.listExecutionJobs(persistedPlan.id))[0] || null;
  if (persistedJob && ["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED", "BLOCKED"].includes(persistedJob.status)) {
    return repairTerminalCompletion({ plan: persistedPlan, job: persistedJob, context });
  }
  const { plan, approval, foundationPlan, job, resuming } = await assertDualApproval(planId, context);
  await assertApprovalRoot(plan, context.repository);
  if (!job) throw executionError("SHOPEE_DISCOUNT_JOB_NOT_FOUND", "Approved plan has no durable execution job");
  if (job.input?.planId !== plan.id || job.input?.merkleRoot !== plan.merkleRoot || job.input?.policyHash !== plan.policyHash) {
    throw executionError("SHOPEE_DISCOUNT_JOB_BINDING_MISMATCH", "Execution job does not bind the approved plan");
  }
  const security = context.writeSecurity();
  assertShopeeWriteAuthorized(security, {
    action: "execute_plan",
    identity: context.identity,
    approvalIdentity: approval.evidence?.approvalIdentity,
  });
  const storage = await context.repository.getStorageMode();
  const shopCount = await context.repository.countPlanShops(plan.id);
  if (!storage.productionScale && (plan.itemCount > storage.pilotLimits.variants || shopCount > storage.pilotLimits.shops)) {
    throw executionError("SHOPEE_DISCOUNT_SQLITE_LIMIT", "SQLite execution exceeds pilot limits");
  }
  const leaseMs = Math.max(100, Number(context.leaseMs) || 30_000);
  const claim = await context.repository.claimJob({ jobId: job.id, ownerId: context.workerId, leaseMs });
  if (!claim.claimed) throw executionError("SHOPEE_DISCOUNT_JOB_NOT_CLAIMED", "Execution job is owned by another live worker");
  await context.repository.prepareExecutionItems({
    jobId: job.id, planId: plan.id, ownerId: context.workerId, epoch: claim.epoch,
  });
  let executingPlan = plan;
  if (!resuming) {
    executingPlan = await context.repository.markPlanState({
      planId: plan.id, fromState: "APPROVED", toState: "EXECUTING", expectedVersion: plan.stateVersion,
    });
    await context.afterDomainExecuting?.({ planId: plan.id, jobId: job.id });
  }
  let executingFoundation = foundationPlan;
  if (executingFoundation.state === "APPROVED") executingFoundation = await beginFoundationExecution(executingFoundation, context);
  if (executingFoundation.state !== "IN_FLIGHT") {
    throw executionError("SHOPEE_DISCOUNT_FOUNDATION_EXECUTION_REQUIRED", "Writes require Foundation IN_FLIGHT state");
  }
  const lease = leaseGuard({
    repository: context.repository, jobId: job.id, workerId: context.workerId, epoch: claim.epoch, leaseMs,
  });
  try {
    const blockedActivities = new Map();
    let intentCursor = null;
    for (;;) {
      const recoveryPage = await context.repository.listDispatchIntentsPage({ jobId: job.id, statuses: ["DISPATCHED", "UNKNOWN"], cursor: intentCursor, pageSize: 100 });
      for (const intent of recoveryPage.items) {
      const item = intent.planItemId ? await context.repository.getPlanItem(intent.planItemId) : null;
      const recoveryShopId = item?.shopId || intent.targetKey.split("\u001f", 1)[0];
      const activity = await context.repository.getPlanActivity(plan.id, recoveryShopId);
      const recovered = await recoverIntent({
        intent, plan, job, item, activity, context, lease, epoch: claim.epoch,
      });
      if (!item && intent.targetType === "createDiscount" && recovered.status !== "SUCCEEDED") {
        blockedActivities.set(recoveryShopId, {
          status: recovered.status,
          reasonCode: recovered.reasonCode || "SHOPEE_CREATE_RECOVERY_UNKNOWN",
        });
      } else if (!item && intent.targetType === "createDiscount" && recovered.status === "SUCCEEDED") {
        const bound = await context.repository.bindActivityPlatformId({
          jobId: job.id, planId: plan.id, shopId: recoveryShopId, ownerId: context.workerId, epoch: claim.epoch,
          platformActivityId: String(recovered.readback.platformObjectId), evidence: { recoveredIntentId: intent.id, requestId: context.requestId },
        });
        if (!bound) {
          const current = await context.repository.getPlanActivity(plan.id, recoveryShopId);
          if (String(current?.platformActivityId || "") !== String(recovered.readback.platformObjectId)) {
            throw executionError("SHOPEE_CREATE_RECOVERY_BINDING_CONFLICT", "Recovered Discount object could not be bound to the approved activity");
          }
        }
        let resetCursor = -1;
        for (;;) {
          const resetPage = await context.repository.listExecutionItemsPage(job.id, { cursor: resetCursor, shopId: recoveryShopId, statuses: ["UNKNOWN"], pageSize: 100 });
          for (const blockedItem of resetPage.items) await markItem(context.repository, lease, {
            jobId: job.id, planItemId: blockedItem.id, ownerId: context.workerId, epoch: claim.epoch,
            status: "PENDING", reasonCode: null, evidence: { createRecovered: true, requestId: context.requestId },
          });
          if (resetPage.nextCursor == null) break;
          resetCursor = resetPage.nextCursor;
        }
      }
      }
      if (recoveryPage.nextCursor == null) break;
      intentCursor = recoveryPage.nextCursor;
    }
    let authCursor = -1;
    for (;;) {
      const authPage = await context.repository.listExecutionItemsPage(job.id, { cursor: authCursor, statuses: ["AUTH_BLOCKED"], pageSize: 100 });
      for (const item of authPage.items) {
      try {
        const authorization = await context.readers.getShopAuthorization({ shopId: item.shopId, requestId: context.requestId });
        if (authorization?.authorized === true) await context.repository.setExecutionItemStatus({
          jobId: job.id, planItemId: item.id, ownerId: context.workerId, epoch: claim.epoch,
          status: "PENDING", reasonCode: null, evidence: { reauthorized: true, requestId: context.requestId },
        });
      } catch {
        // Remains AUTH_BLOCKED and resumable; another shop may continue.
      }
      }
      if (authPage.nextCursor == null) break;
      authCursor = authPage.nextCursor;
    }
    if (foundationPlan.scope?.workflow === "NEXT_RENEWAL") {
      let activityCursor = "";
      for (;;) {
        const activityPage = await context.repository.listPlanActivitiesPage(plan.id, { cursor: activityCursor, pageSize: 100 });
        for (const activity of activityPage.items) {
        const shopId = activity.shopId;
        if (blockedActivities.has(shopId)) continue;
        const shopItems = [];
        let shopCursor = -1;
        for (;;) {
          const shopPage = await context.repository.listExecutionItemsPage(job.id, { cursor: shopCursor, shopId, statuses: ["PENDING"], pageSize: 100 });
          shopItems.push(...shopPage.items);
          if (shopItems.length > 1000) throw executionError("SHOPEE_DISCOUNT_SHOP_ITEM_LIMIT", "A renewal shop exceeds the bounded execution preflight limit");
          if (shopPage.nextCursor == null) break;
          shopCursor = shopPage.nextCursor;
        }
        const preflight = await prepareRenewalShop({
          plan, job, activity, items: shopItems, approval, context, lease, epoch: claim.epoch,
        });
        if (preflight.status !== "READY") {
          blockedActivities.set(shopId, preflight);
          continue;
        }
        const prepared = await ensureRenewalActivity({
          plan, job, activity, context, lease, epoch: claim.epoch,
          validateBeforeCreate: () => prepareRenewalShop({
            plan, job, activity, items: shopItems, approval, context, lease, epoch: claim.epoch,
          }),
        });
        if (prepared.status !== "READY") blockedActivities.set(shopId, prepared);
        }
        if (activityPage.nextCursor == null) break;
        activityCursor = activityPage.nextCursor;
      }
    }
    const blockedShops = new Map();
    let pendingCursor = -1;
    for (;;) {
      const pendingPage = await context.repository.listExecutionItemsPage(job.id, { cursor: pendingCursor, statuses: ["PENDING"], pageSize: 100 });
      for (const item of pendingPage.items) {
      if (blockedActivities.has(item.shopId)) {
        const blocked = blockedActivities.get(item.shopId);
        await markItem(context.repository, lease, {
          jobId: job.id,
          planItemId: item.id,
          ownerId: context.workerId,
          epoch: claim.epoch,
          status: blocked.status,
          reasonCode: blocked.reasonCode,
          evidence: { shopId: item.shopId, activityCreateBlocked: true },
        });
        continue;
      }
      if (blockedShops.has(item.shopId)) {
        const blocked = blockedShops.get(item.shopId);
        await markItem(context.repository, lease, {
          jobId: job.id,
          planItemId: item.id,
          ownerId: context.workerId,
          epoch: claim.epoch,
          status: blocked.status,
          reasonCode: blocked.reasonCode,
          evidence: { shopId: item.shopId, dispatchStopped: true },
        });
        continue;
      }
      let result;
      try {
        result = await processItem({
          plan, job, item, activity: await context.repository.getPlanActivity(plan.id, item.shopId), approval, context, lease, epoch: claim.epoch,
        });
      } catch (cause) {
        if (cause?.code === "SHOPEE_DISCOUNT_LEASE_LOST" || cause?.code === "SIMULATED_CRASH") throw cause;
        const status = cause?.code === "SHOPEE_AUTH_ERROR" ? "AUTH_BLOCKED" : "UNKNOWN";
        if (status === "AUTH_BLOCKED") await appendAuthIssue(context.repository, {
          planId: plan.id, jobId: job.id, shopId: item.shopId, requestId: context.requestId, actorId: context.workerId,
        });
        await markItem(context.repository, lease, {
          jobId: job.id, planItemId: item.id, ownerId: context.workerId, epoch: claim.epoch,
          status, reasonCode: cause?.code || "SHOPEE_READER_UNKNOWN",
          evidence: { shopId: item.shopId, requestId: context.requestId, predispatchReaderFailure: true },
        });
        result = { status, reasonCode: cause?.code || "SHOPEE_READER_UNKNOWN", stopShop: true };
      }
      if (result?.stopShop) blockedShops.set(item.shopId, result);
      }
      await context.repository.checkpointJob({ jobId: job.id, ownerId: context.workerId, epoch: claim.epoch,
        cursor: { sequence: pendingPage.items.at(-1)?.sequence ?? pendingCursor }, counters: await context.repository.countExecutionItemsByStatus(job.id) });
      if (pendingPage.nextCursor == null) break;
      pendingCursor = pendingPage.nextCursor;
    }
    const aggregateCounts = await context.repository.countExecutionItemsByStatus(job.id);
    const summary = summaryFromCounts(plan.id, job.id, aggregateCounts);
    const outcome = summary.status;
    if (Number(aggregateCounts.UNKNOWN || 0) + Number(aggregateCounts.AUTH_BLOCKED || 0) + Number(aggregateCounts.DISPATCHED || 0) > 0) {
      await context.repository.checkpointJob({
        jobId: job.id, ownerId: context.workerId, epoch: claim.epoch,
        cursor: { resumable: true }, counters: summary.counts,
      });
      return { ...summary, status: "BLOCKED" };
    }
    if (!await lease.renew() || !await context.repository.completeJob({
      jobId: job.id,
      ownerId: context.workerId,
      epoch: claim.epoch,
      status: outcome,
      result: summary,
      counters: summary.counts,
    })) throw executionError("SHOPEE_DISCOUNT_LEASE_LOST", "Execution lease was lost before completion");
    await context.afterJobCompleted?.({ planId: plan.id, jobId: job.id, summary });
    executingPlan = await context.repository.markPlanState({
      planId: plan.id, fromState: "EXECUTING", toState: outcome, expectedVersion: executingPlan.stateVersion,
    });
    await context.foundation.operationPlans.finish(foundationPlan.id, outcome === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", {
      result: summary,
      actorId: context.workerId,
      evidence: { domainState: executingPlan.state },
    });
    return summary;
  } finally {
    lease.stop();
  }
}
