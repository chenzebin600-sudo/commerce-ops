import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  ShopeeDiscountScheduler,
  computeRenewalSchedule,
  durableActivityVariantCount,
  localDateTimeToUtc,
  reminderDueJobs,
  schedulerRequestId,
} from "../lib/shopee-discount/scheduler.mjs";

function duplicateError() {
  return Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
}

function memoryRepository(now) {
  const dueJobs = new Map();
  let renewals = 0;
  return {
    dueJobs,
    get renewals() { return renewals; },
    async getSettings() { return { enabled: true, timezone: "Asia/Shanghai", metadata: {} }; },
    async createDueJob(input) {
      if ([...dueJobs.values()].some((job) => job.dedupeKey === input.dedupeKey)) throw duplicateError();
      const job = { id: input.id || `due-${dueJobs.size + 1}`, status: "PENDING", epoch: 0, ...input };
      dueJobs.set(job.id, job);
      return job;
    },
    async claimDueJobs({ ownerId, now: claimedAt }) {
      const jobs = [...dueJobs.values()].filter((job) => job.status === "PENDING" && new Date(job.dueAt) <= claimedAt);
      for (const job of jobs) Object.assign(job, { status: "CLAIMED", ownerId, epoch: job.epoch + 1 });
      return jobs;
    },
    async completeDueJob({ dueJobId, status, result, lastErrorCode }) {
      Object.assign(dueJobs.get(dueJobId), { status, result, lastErrorCode });
      return true;
    },
    async deferDueJob({ dueJobId, dueAt, result, lastErrorCode }) {
      Object.assign(dueJobs.get(dueJobId), { status: "PENDING", ownerId: null, dueAt: new Date(dueAt), result, lastErrorCode });
      return true;
    },
    async renewDueJobLease() { renewals += 1; return true; },
  };
}

function activePolicy() {
  return { status: () => ({ enabled: true, state: "active" }), assertAllowed() { return true; } };
}

test("daily scan dedupes each shop-local day across changing scopes while manual scans remain independent", async () => {
  const now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  const scans = [];
  const scheduler = new ShopeeDiscountScheduler({
    repository, externalTaskPolicy: activePolicy(), ownerId: "worker-1", now: () => now,
    scan: async (payload) => scans.push(payload),
  });

  await scheduler.enqueueDailyScan({ country: "TH", shops: [{ shopId: "1", timeZone: "Asia/Bangkok" }] });
  await scheduler.enqueueDailyScan({ country: "TH", shops: [
    { shopId: "1", timeZone: "Asia/Bangkok" }, { shopId: "2", timeZone: "Asia/Singapore" },
  ] });
  await repository.createDueJob({ jobType: "MANUAL_SCAN", dedupeKey: "manual:one", dueAt: now, payload: { country: "TH", shopIds: ["1"] } });
  await repository.createDueJob({ jobType: "MANUAL_SCAN", dedupeKey: "manual:two", dueAt: now, payload: { country: "TH", shopIds: ["1"] } });
  await scheduler.tick({ enqueueDaily: false });

  assert.equal([...repository.dueJobs.values()].filter((job) => job.jobType === "DAILY_SCAN").length, 2);
  assert.deepEqual(scans.map((entry) => [entry.triggerType, entry.shopIds, entry.timeZone]), [
    ["daily", ["1"], "Asia/Bangkok"], ["daily", ["2"], "Asia/Singapore"],
    ["manual", ["1"], undefined], ["manual", ["1"], undefined],
  ]);
  assert.equal(repository.renewals >= 8, true);
});

test("restart catches up durable due work and inactive lease fails closed", async () => {
  const now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  await repository.createDueJob({ jobType: "MANUAL_SCAN", dedupeKey: "old", dueAt: "2026-08-13T00:00:00.000Z", payload: { country: "TH", shopIds: ["1"] } });
  let scans = 0;
  const scheduler = new ShopeeDiscountScheduler({ repository, externalTaskPolicy: activePolicy(), ownerId: "restarted", now: () => now, scan: async () => { scans += 1; } });
  await scheduler.tick({ enqueueDaily: false });
  assert.equal(scans, 1);

  const inactive = new ShopeeDiscountScheduler({ repository, ownerId: "inactive", now: () => now,
    externalTaskPolicy: { status: () => ({ enabled: true, state: "waiting_for_lease" }), assertAllowed() { return true; } } });
  await assert.rejects(inactive.tick(), { code: "SHOPEE_DISCOUNT_SCHEDULER_INACTIVE" });
});

test("renewal scheduling is seamless, resets to a full 30 days after promotion, and never backfills", () => {
  const beforeEnd = new Date("2026-08-14T00:00:00.000Z");
  const normal = computeRenewalSchedule({ now: beforeEnd, currentEndsAt: "2026-08-20T00:00:00.000Z", currentTier: "DAILY" });
  assert.equal(normal.startsAt, "2026-08-20T00:00:00.000Z");
  assert.equal(normal.endsAt, "2026-09-19T00:00:00.000Z");

  const promotion = computeRenewalSchedule({ now: beforeEnd, currentEndsAt: "2026-08-15T00:00:00.000Z", currentTier: "MEGA" });
  assert.equal(promotion.startsAt, "2026-08-15T00:00:00.000Z");
  assert.equal(promotion.endsAt, "2026-09-14T00:00:00.000Z");

  const missed = computeRenewalSchedule({ now: new Date("2026-08-21T10:10:00.000Z"), currentEndsAt: "2026-08-20T00:00:00.000Z", currentTier: "DAILY", minimumPlatformLeadMs: 3_600_000 });
  assert.equal(missed.startsAt, "2026-08-21T11:10:00.000Z");
  assert.equal(missed.endsAt, "2026-09-20T11:10:00.000Z");
});

test("capacity SLO generates early enough and rejects impossible schedules", () => {
  const result = computeRenewalSchedule({
    now: new Date("2026-08-01T00:00:00.000Z"), currentEndsAt: "2026-08-20T00:00:00.000Z", currentTier: "DAILY",
    variantCount: 10_000, throughputPerHour: 1_000, safetyFactor: 1.5, minimumDraftLeadHours: 24, maximumDraftLeadDays: 7,
  });
  assert.equal(result.draftDueAt, "2026-08-19T00:00:00.000Z");
  assert.throws(() => computeRenewalSchedule({
    now: new Date("2026-08-01T00:00:00.000Z"), currentEndsAt: "2026-08-20T00:00:00.000Z", currentTier: "DAILY",
    variantCount: 1_000_000, throughputPerHour: 1, safetyFactor: 2, maximumDraftLeadDays: 7,
  }), { code: "SHOPEE_DISCOUNT_CAPACITY_SLO_IMPOSSIBLE" });
});

test("capacity SLO reads the authoritative durable activity plan count and rejects missing counts", async () => {
  const repository = {
    async countPlanItemsByShop(planId) {
      assert.equal(planId, "plan-source");
      return [{ shopId: "1", itemCount: 10_000 }];
    },
  };
  assert.equal(await durableActivityVariantCount(repository, { planId: "plan-source", shopId: "1" }), 10_000);
  await assert.rejects(durableActivityVariantCount(repository, { planId: "plan-source", shopId: "2" }), {
    code: "SHOPEE_DISCOUNT_CAPACITY_COUNT_UNAVAILABLE",
  });
  const rootSource = await fs.readFile(new URL("../scheduler.mjs", import.meta.url), "utf8");
  assert.match(rootSource, /variantCount:\s*await durableActivityVariantCount/);
  assert.doesNotMatch(rootSource, /metadata\?\.variantCount\s*\|\|\s*0/);
});

test("local wall-clock conversion stores unique UTC instants and rejects DST gaps/overlaps", () => {
  assert.equal(localDateTimeToUtc("2026-08-20T08:00:00", "Asia/Shanghai"), "2026-08-20T00:00:00.000Z");
  assert.throws(() => localDateTimeToUtc("2026-03-08T02:30:00", "America/New_York"), { code: "SHOPEE_DISCOUNT_TIMEZONE_INVALID_LOCAL_TIME" });
  assert.throws(() => localDateTimeToUtc("2026-11-01T01:30:00", "America/New_York"), { code: "SHOPEE_DISCOUNT_TIMEZONE_AMBIGUOUS_LOCAL_TIME" });
  assert.throws(() => localDateTimeToUtc("2026-08-20T08:00:00", "Invalid/Zone"), { code: "SHOPEE_DISCOUNT_TIMEZONE_INVALID" });

  const jobs = reminderDueJobs({ planId: "plan-1", shopId: "shop-1", localStartsAt: "2026-08-20T08:00:00", timeZone: "Asia/Shanghai" });
  assert.deepEqual(jobs.map((job) => job.dueAt), [
    "2026-08-19T00:00:00.000Z", "2026-08-19T18:00:00.000Z", "2026-08-19T23:00:00.000Z",
  ]);
  assert.equal(new Set(jobs.map((job) => job.dedupeKey)).size, 3);
});

test("each shop carries its own persisted IANA timezone and invalid zones fail before enqueue", async () => {
  const now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  const scheduler = new ShopeeDiscountScheduler({ repository, externalTaskPolicy: activePolicy(), ownerId: "worker", now: () => now });
  await scheduler.enqueueDailyScan({ country: "US", shops: [
    { shopId: "1", timeZone: "America/New_York" }, { shopId: "2", timeZone: "America/Los_Angeles" },
  ] });
  assert.deepEqual([...repository.dueJobs.values()].map((job) => job.payload.timeZone).sort(), ["America/Los_Angeles", "America/New_York"]);
  await assert.rejects(scheduler.enqueueDailyScan({ country: "US", shops: [{ shopId: "3", timeZone: "Invalid/Zone" }] }), {
    code: "SHOPEE_DISCOUNT_TIMEZONE_INVALID",
  });
  const rootSource = await fs.readFile(new URL("../scheduler.mjs", import.meta.url), "utf8");
  assert.match(rootSource, /SHOPEE_DISCOUNT_SHOP_TIMEZONES_JSON/);
  assert.match(rootSource, /shops:\s*shopeeDiscountShopIds\.map/);
});

test("renewal draft creates one authoritative human Foundation task and never approves", async () => {
  const now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  const createdTasks = [];
  const scheduler = new ShopeeDiscountScheduler({
    repository, externalTaskPolicy: activePolicy(), ownerId: "worker-1", now: () => now,
    createRenewalDraft: async () => ({ planId: "plan-1", merkleRoot: "root-1", itemCount: 10 }),
    foundation: { tasks: { create: async (task) => { createdTasks.push(task); return { id: "foundation-task-1", input: task.input }; } } },
  });
  await repository.createDueJob({ jobType: "RENEWAL_DRAFT", dedupeKey: "draft:shop-1", dueAt: now,
    payload: { country: "TH", shopId: "shop-1", targetStartsAt: "2026-08-20T00:00:00.000Z", targetEndsAt: "2026-09-19T00:00:00.000Z", timeZone: "Asia/Shanghai" } });
  await scheduler.tick({ enqueueDaily: false });
  assert.equal(createdTasks.length, 1);
  assert.equal(createdTasks[0].executionMode, "human");
  assert.equal(createdTasks[0].state, "PENDING");
  assert.equal(createdTasks[0].domain, "product");
  assert.equal("approve" in createdTasks[0], false);
  assert.equal([...repository.dueJobs.values()].filter((job) => job.jobType === "REMINDER").length, 3);
});

test("due-job replay uses one deterministic preview identity and validates the Foundation plan binding", async () => {
  assert.equal(schedulerRequestId("due-job-1"), schedulerRequestId("due-job-1"));
  assert.notEqual(schedulerRequestId("due-job-1"), schedulerRequestId("due-job-2"));
  const rootSource = await fs.readFile(new URL("../scheduler.mjs", import.meta.url), "utf8");
  assert.match(rootSource, /requestId:\s*schedulerRequestId\(payload\.dueJobId\)/);
  assert.doesNotMatch(rootSource, /requestId:\s*`scheduler-\$\{Date\.now\(\)\}`/);

  const now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  const plans = new Map();
  const tasks = new Map();
  const scheduler = new ShopeeDiscountScheduler({ repository, externalTaskPolicy: activePolicy(), ownerId: "worker", now: () => now,
    createRenewalDraft: async ({ dueJobId }) => {
      const id = `plan:${schedulerRequestId(dueJobId)}`;
      if (!plans.has(id)) plans.set(id, { planId: id, itemCount: 10 });
      return plans.get(id);
    },
    foundation: { tasks: { create: async (input) => {
      if (!tasks.has(input.domainRefId)) tasks.set(input.domainRefId, { id: "task-1", input: input.input });
      return tasks.get(input.domainRefId);
    } } },
  });
  const job = await repository.createDueJob({ id: "due-job-1", jobType: "RENEWAL_DRAFT", dedupeKey: "draft:one", dueAt: now,
    payload: { country: "TH", shopId: "1", targetStartsAt: "2026-08-20T00:00:00.000Z", targetEndsAt: "2026-09-19T00:00:00.000Z" } });
  await scheduler.tick({ enqueueDaily: false });
  Object.assign(job, { status: "PENDING", ownerId: null });
  await scheduler.tick({ enqueueDaily: false });
  assert.equal(plans.size, 1);
  assert.equal(tasks.size, 1);
  assert.equal(tasks.get("due-job-1").input.planId, [...plans.values()][0].planId);
});

test("only explicitly approved execution work reaches the injected gated executor", async () => {
  const now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  const executed = [];
  const scheduler = new ShopeeDiscountScheduler({ repository, externalTaskPolicy: activePolicy(), ownerId: "worker-1", now: () => now,
    executeApprovedPlan: async (planId) => { executed.push(planId); return { status: "SUCCEEDED" }; } });
  await repository.createDueJob({ jobType: "EXECUTE_APPROVED", dedupeKey: "execute:plan-1", dueAt: now,
    payload: { planId: "plan-1", approvalState: "APPROVED" } });
  await repository.createDueJob({ jobType: "EXECUTE_APPROVED", dedupeKey: "execute:plan-2", dueAt: now,
    payload: { planId: "plan-2", approvalState: "PREVIEWED" } });
  await scheduler.tick({ enqueueDaily: false });
  assert.deepEqual(executed, ["plan-1"]);
  assert.equal([...repository.dueJobs.values()].find((job) => job.dedupeKey === "execute:plan-2").status, "FAILED");
});

test("runner start is single-instance, lease-gated, and stop waits for the in-flight tick", async () => {
  const now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  const scheduler = new ShopeeDiscountScheduler({ repository, externalTaskPolicy: activePolicy(), ownerId: "worker-1", now: () => now });
  assert.equal(await scheduler.start(), true);
  assert.equal(await scheduler.start(), false);
  await scheduler.stop();
  assert.equal(scheduler.timer, null);

  const inactive = new ShopeeDiscountScheduler({ repository, ownerId: "worker-2", now: () => now,
    externalTaskPolicy: { status: () => ({ enabled: false, state: "disabled_by_configuration" }) } });
  await assert.rejects(inactive.start(), { code: "SHOPEE_DISCOUNT_SCHEDULER_INACTIVE" });

  const lostSharedLease = new ShopeeDiscountScheduler({ repository, externalTaskPolicy: activePolicy(), ownerId: "worker-3", now: () => now,
    acquireSharedLease: async () => false });
  await assert.rejects(lostSharedLease.tick(), { code: "SHOPEE_DISCOUNT_SCHEDULER_INACTIVE" });
});

test("reclaimed reminder defers until the still-live notification lease instead of losing unique work", async () => {
  let now = new Date("2026-08-14T01:00:00.000Z");
  const repository = memoryRepository(now);
  const notifications = {
    async sendReminder() {
      if (now < new Date("2026-08-14T01:00:10.000Z")) {
        throw Object.assign(new Error("in flight"), {
          code: "SHOPEE_DISCOUNT_NOTIFICATION_IN_FLIGHT",
          retryAt: "2026-08-14T01:00:10.000Z",
        });
      }
      throw Object.assign(new Error("coordinate"), { code: "SHOPEE_DISCOUNT_NOTIFICATION_COORDINATION_REQUIRED" });
    },
  };
  const scheduler = new ShopeeDiscountScheduler({ repository, notifications, externalTaskPolicy: activePolicy(), ownerId: "recovery", now: () => now,
    foundation: { tasks: { create: async (input) => ({ id: "task", input: input.input }) } } });
  const job = await repository.createDueJob({ jobType: "REMINDER", dedupeKey: "reminder:race", dueAt: now,
    payload: { planId: "plan-1", shopId: "1", severity: "WARNING", startsAt: "2026-08-15T00:00:00.000Z" } });
  await scheduler.tick({ enqueueDaily: false });
  assert.equal(job.status, "PENDING");
  assert.equal(new Date(job.dueAt).toISOString(), "2026-08-14T01:00:10.000Z");
  now = new Date("2026-08-14T01:00:10.000Z");
  await scheduler.tick({ enqueueDaily: false });
  assert.equal(job.status, "FAILED");
  assert.equal(job.lastErrorCode, "SHOPEE_DISCOUNT_NOTIFICATION_COORDINATION_REQUIRED");
});
