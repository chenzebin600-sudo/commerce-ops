import { createHash } from "node:crypto";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DUE_JOB_TYPES = new Set([
  "DAILY_SCAN", "MANUAL_SCAN", "RENEWAL_DRAFT", "REMINDER", "DINGTALK_RETRY", "EXECUTE_APPROVED",
]);

function schedulerError(code, message, evidence = undefined) {
  return Object.assign(new Error(message), { code, ...(evidence === undefined ? {} : { evidence }) });
}

function validDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid date/time`);
  return date;
}

function positiveNumber(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new TypeError(`${name} must be positive`);
  return result;
}

function localParts(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_INVALID_LOCAL_TIME", "Local date/time must use YYYY-MM-DDTHH:mm:ss");
  const [, year, month, day, hour, minute, second] = match;
  const parts = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute), second: Number(second) };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day
    || check.getUTCHours() !== parts.hour || check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second) {
    throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_INVALID_LOCAL_TIME", "Local date/time is invalid");
  }
  return parts;
}

function formatterFor(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_INVALID", "Shop IANA timezone is invalid");
  }
}

function formattedParts(formatter, instant) {
  const output = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") output[part.type] = Number(part.value);
  }
  return output;
}

function sameParts(left, right) {
  return ["year", "month", "day", "hour", "minute", "second"].every((key) => left[key] === right[key]);
}

function utcToLocalDateTime(instant, timeZone) {
  const parts = formattedParts(formatterFor(timeZone), validDate(instant, "instant"));
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
}

export function localDateTimeToUtc(localDateTime, timeZone) {
  const requested = localParts(localDateTime);
  const formatter = formatterFor(String(timeZone || ""));
  const naive = Date.UTC(requested.year, requested.month - 1, requested.day, requested.hour, requested.minute, requested.second);
  const offsets = new Set();
  for (let delta = -36 * HOUR_MS; delta <= 36 * HOUR_MS; delta += 30 * 60_000) {
    const sampled = naive + delta;
    const observed = formattedParts(formatter, sampled);
    const observedNaive = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    offsets.add(observedNaive - sampled);
  }
  const matches = [...offsets]
    .map((offset) => new Date(naive - offset))
    .filter((candidate) => sameParts(formattedParts(formatter, candidate), requested));
  const unique = [...new Map(matches.map((date) => [date.toISOString(), date])).values()];
  if (!unique.length) throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_INVALID_LOCAL_TIME", "Local time falls in a timezone gap");
  if (unique.length > 1) throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_AMBIGUOUS_LOCAL_TIME", "Local time is ambiguous in the shop timezone");
  return unique[0].toISOString();
}

export function reminderDueJobs({ planId, shopId, localStartsAt, timeZone }) {
  const startsAt = validDate(localDateTimeToUtc(localStartsAt, timeZone), "localStartsAt");
  return [24, 6, 1].map((hours) => ({
    jobType: "REMINDER",
    dedupeKey: `reminder:${planId}:${shopId}:T-${hours}h`,
    dueAt: new Date(startsAt.getTime() - hours * HOUR_MS).toISOString(),
    payload: { planId, shopId, severity: hours === 1 ? "CRITICAL" : hours === 6 ? "WARNING" : "INFO", hoursBefore: hours, startsAt: startsAt.toISOString(), timeZone },
  }));
}

export function computeRenewalSchedule({
  now = new Date(), currentEndsAt, currentTier = "DAILY", cycleDays = 30,
  minimumPlatformLeadMs = 0, variantCount = 0, throughputPerHour = 1_000,
  safetyFactor = 1.5, minimumDraftLeadHours = 24, maximumDraftLeadDays = 30,
} = {}) {
  if (!new Set(["DAILY", "EVENT", "MEGA"]).has(currentTier)) throw new TypeError("currentTier is invalid");
  const clock = validDate(now, "now");
  const currentEnd = validDate(currentEndsAt, "currentEndsAt");
  const days = positiveNumber(cycleDays, "cycleDays");
  const platformLead = Number(minimumPlatformLeadMs);
  if (!Number.isFinite(platformLead) || platformLead < 0) throw new TypeError("minimumPlatformLeadMs must be non-negative");
  const earliest = clock.getTime() + platformLead;
  const startMs = Math.max(currentEnd.getTime(), earliest);
  const startsAt = new Date(startMs);
  const endsAt = new Date(startMs + days * DAY_MS);
  const count = Number(variantCount);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("variantCount must be a non-negative safe integer");
  const rate = positiveNumber(throughputPerHour, "throughputPerHour");
  const safety = positiveNumber(safetyFactor, "safetyFactor");
  const minimumLead = positiveNumber(minimumDraftLeadHours, "minimumDraftLeadHours");
  const maximumLead = positiveNumber(maximumDraftLeadDays, "maximumDraftLeadDays") * 24;
  const capacityHours = count ? Math.ceil((count / rate) * safety) : 0;
  const requiredLeadHours = Math.max(minimumLead, capacityHours);
  if (requiredLeadHours > maximumLead) {
    throw schedulerError("SHOPEE_DISCOUNT_CAPACITY_SLO_IMPOSSIBLE", "Required renewal lead exceeds the configured safe range", {
      variantCount: count, throughputPerHour: rate, requiredLeadHours, maximumLeadHours: maximumLead,
    });
  }
  return Object.freeze({
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    draftDueAt: new Date(startMs - requiredLeadHours * HOUR_MS).toISOString(),
    requiredLeadHours,
    resetAfterPromotion: currentTier !== "DAILY",
    missedWindow: currentEnd.getTime() < earliest,
  });
}

function localDay(now, timeZone) {
  const formatter = formatterFor(timeZone);
  const parts = formattedParts(formatter, now);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function schedulerRequestId(dueJobId) {
  const id = String(dueJobId || "").trim();
  if (!id || id.length > 120) throw new TypeError("dueJobId is invalid");
  return `scheduler:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

export function resolveShopeeDiscountSchedulerStartup(env = {}) {
  if (String(env.SHOPEE_DISCOUNT_SCHEDULER_ENABLED || "").trim().toLowerCase() !== "true") {
    return Object.freeze({ enabled: false, reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_DISABLED", shopIds: [], shopTimeZones: {} });
  }
  const rawShopIds = String(env.SHOPEE_DISCOUNT_SCHEDULER_SHOP_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!rawShopIds.length || rawShopIds.some((value) => !/^[1-9]\d*$/.test(value)) || new Set(rawShopIds).size !== rawShopIds.length) {
    return Object.freeze({ enabled: false, reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_SHOPS_REQUIRED", shopIds: [], shopTimeZones: {} });
  }
  let shopTimeZones;
  try { shopTimeZones = JSON.parse(String(env.SHOPEE_DISCOUNT_SHOP_TIMEZONES_JSON || "")); }
  catch { shopTimeZones = null; }
  if (!shopTimeZones || typeof shopTimeZones !== "object" || Array.isArray(shopTimeZones)) {
    return Object.freeze({ enabled: false, reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_TIMEZONES_REQUIRED", shopIds: [], shopTimeZones: {} });
  }
  try {
    for (const shopId of rawShopIds) {
      const timeZone = String(shopTimeZones[shopId] || "").trim();
      if (!timeZone) throw new Error("missing");
      formatterFor(timeZone);
      shopTimeZones[shopId] = timeZone;
    }
  } catch {
    return Object.freeze({ enabled: false, reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_TIMEZONES_REQUIRED", shopIds: [], shopTimeZones: {} });
  }
  let warehouseBaseUrl;
  try {
    const parsed = new URL(String(env.SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL || "").trim());
    if (parsed.protocol !== "https:") throw new Error("protocol");
    warehouseBaseUrl = parsed.href.replace(/\/$/, "");
  } catch {
    return Object.freeze({ enabled: false, reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_WAREHOUSE_REQUIRED", shopIds: [], shopTimeZones: {} });
  }
  if (!String(env.SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID || "").trim()) {
    return Object.freeze({ enabled: false, reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_DINGTALK_REQUIRED", shopIds: [], shopTimeZones: {} });
  }
  try {
    const entry = new URL(String(env.SHOPEE_DISCOUNT_ENTRY_BASE_URL || "").trim());
    if (!new Set(["http:", "https:"]).has(entry.protocol)) throw new Error("protocol");
  } catch {
    return Object.freeze({ enabled: false, reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_ENTRY_REQUIRED", shopIds: [], shopTimeZones: {} });
  }
  return Object.freeze({
    enabled: true,
    reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_READY",
    shopIds: Object.freeze([...rawShopIds]),
    shopTimeZones: Object.freeze(Object.fromEntries(rawShopIds.map((shopId) => [shopId, shopTimeZones[shopId]]))),
    warehouseBaseUrl,
  });
}

function disabledReadiness(startup, reasonCode) {
  return Object.freeze({ ...startup, enabled: false, reasonCode });
}

export async function resolveShopeeDiscountSchedulerReadiness({
  env = {}, getDiscountSettings, verifyWarehouseKey, listAuthorizedShops, getDingTalkConfig,
} = {}) {
  const startup = resolveShopeeDiscountSchedulerStartup(env);
  if (!startup.enabled) return startup;
  if (![getDiscountSettings, verifyWarehouseKey, listAuthorizedShops, getDingTalkConfig].every((probe) => typeof probe === "function")) {
    return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_PROBES_REQUIRED");
  }
  let settings;
  try { settings = await getDiscountSettings(); }
  catch { return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_WAREHOUSE_KEY_REQUIRED"); }
  if (!settings?.encryptedWarehouseKeyCiphertext && !settings?.warehouseKeyReference) {
    return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_WAREHOUSE_KEY_REQUIRED");
  }
  try {
    if (await verifyWarehouseKey({ settings, warehouseBaseUrl: startup.warehouseBaseUrl }) !== true) {
      return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_WAREHOUSE_KEY_INVALID");
    }
  } catch { return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_WAREHOUSE_KEY_INVALID"); }
  let authorized;
  try { authorized = await listAuthorizedShops({ shopIds: startup.shopIds }); }
  catch { return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_SHOP_AUTH_REQUIRED"); }
  const byShop = new Map((Array.isArray(authorized) ? authorized : []).map((entry) => [String(entry?.shopId ?? entry?.shop_id ?? ""), entry]));
  if (startup.shopIds.some((shopId) => {
    const entry = byShop.get(shopId);
    return !entry || entry.authorized === false || entry.healthy === false;
  })) return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_SHOP_AUTH_REQUIRED");
  let group;
  try { group = await getDingTalkConfig(String(env.SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID || "").trim()); }
  catch { return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_DINGTALK_UNAVAILABLE"); }
  if (!group?.enabled) return disabledReadiness(startup, "SHOPEE_DISCOUNT_SCHEDULER_DINGTALK_UNAVAILABLE");
  return startup;
}

export async function durableActivityVariantCount(repository, activity) {
  if (!repository?.countPlanItemsByShop) throw schedulerError("SHOPEE_DISCOUNT_CAPACITY_COUNT_UNAVAILABLE", "Durable plan item counts are unavailable");
  const planId = String(activity?.planId || "").trim();
  const shopId = String(activity?.shopId || "").trim();
  if (!planId || !shopId) throw schedulerError("SHOPEE_DISCOUNT_CAPACITY_COUNT_UNAVAILABLE", "Activity plan and shop identity are required for capacity planning");
  const counts = await repository.countPlanItemsByShop(planId);
  const count = Number(counts.find((entry) => String(entry.shopId) === shopId)?.itemCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw schedulerError("SHOPEE_DISCOUNT_CAPACITY_COUNT_UNAVAILABLE", "A positive durable activity variant count is required");
  }
  return count;
}

function isDuplicate(cause) {
  return /UNIQUE|duplicate/i.test(String(cause?.message || cause));
}

export class ShopeeDiscountScheduler {
  constructor({
    repository, foundation = null, notifications = null, externalTaskPolicy, ownerId,
    now = () => new Date(), scan = null, createRenewalDraft = null, executeApprovedPlan = null,
    batchSize = 20, dailyScope = null, pollIntervalMs = 60_000, onError = null, acquireSharedLease = null,
  } = {}) {
    if (!repository?.createDueJob || !repository?.claimDueJobs || !repository?.renewDueJobLease
      || !repository?.deferDueJob || !repository?.completeDueJob) {
      throw new TypeError("Shopee Discount due-job repository is required");
    }
    this.repository = repository;
    this.foundation = foundation;
    this.notifications = notifications;
    this.externalTaskPolicy = externalTaskPolicy;
    this.ownerId = String(ownerId || "").trim();
    if (!this.ownerId) throw new TypeError("Shopee Discount scheduler ownerId is required");
    this.now = now;
    this.scan = scan;
    this.createRenewalDraft = createRenewalDraft;
    this.executeApprovedPlan = executeApprovedPlan;
    this.batchSize = Math.min(100, Math.max(1, Number(batchSize) || 20));
    this.dailyScope = dailyScope;
    this.pollIntervalMs = Math.max(5_000, Number(pollIntervalMs) || 60_000);
    this.onError = typeof onError === "function" ? onError : () => {};
    this.acquireSharedLease = typeof acquireSharedLease === "function" ? acquireSharedLease : null;
    this.timer = null;
    this.inFlight = null;
  }

  async #assertActive() {
    const status = this.externalTaskPolicy?.status?.();
    if (!status?.enabled || status.state !== "active") {
      throw schedulerError("SHOPEE_DISCOUNT_SCHEDULER_INACTIVE", "Shopee Discount scheduler requires the active shared external-task lease");
    }
    this.externalTaskPolicy.assertAllowed?.("shopee_discount_scheduler");
    if (this.acquireSharedLease && !await this.acquireSharedLease()) {
      throw schedulerError("SHOPEE_DISCOUNT_SCHEDULER_INACTIVE", "Shopee Discount scheduler does not own the shared scheduler lease");
    }
  }

  async #createOnce(input) {
    try { return await this.repository.createDueJob(input); }
    catch (cause) { if (isDuplicate(cause)) return null; throw cause; }
  }

  async enqueueDailyScan({ country, shops }) {
    if (!Array.isArray(shops) || !shops.length) throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_REQUIRED", "Daily scheduling requires per-shop IANA timezones");
    const normalized = new Map();
    for (const entry of shops) {
      const shopId = String(entry?.shopId || "").trim();
      const timeZone = String(entry?.timeZone || "").trim();
      if (!/^[1-9]\d*$/.test(shopId) || !timeZone) throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_REQUIRED", "Each daily shop requires an exact shop ID and IANA timezone");
      formatterFor(timeZone);
      const existing = normalized.get(shopId);
      if (existing && existing !== timeZone) throw schedulerError("SHOPEE_DISCOUNT_TIMEZONE_CONFLICT", "A shop cannot have multiple timezones");
      normalized.set(shopId, timeZone);
    }
    const jobs = [];
    for (const [shopId, timeZone] of [...normalized.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const day = localDay(this.now(), timeZone);
      jobs.push(await this.#createOnce({
        jobType: "DAILY_SCAN", dedupeKey: `daily:${country}:${shopId}:${day}`,
        dueAt: this.now(), payload: { country, shopIds: [shopId], shopId, timeZone, logicalDay: day },
      }));
    }
    return jobs.filter(Boolean);
  }

  async scheduleRenewal(input) {
    const schedule = computeRenewalSchedule(input);
    const job = await this.#createOnce({
      jobType: "RENEWAL_DRAFT",
      dedupeKey: `renewal:${input.country}:${input.shopId}:${schedule.startsAt}:${input.priceTier || "DAILY"}`,
      dueAt: schedule.draftDueAt,
      payload: { ...input, targetStartsAt: schedule.startsAt, targetEndsAt: schedule.endsAt, schedule },
    });
    return { job, schedule };
  }

  async #foundationTask(job, draft = null) {
    if (!this.foundation?.tasks?.create) throw schedulerError("SHOPEE_DISCOUNT_FOUNDATION_UNAVAILABLE", "Foundation task service is required");
    const planId = draft?.planId || job.payload.planId || null;
    const task = await this.foundation.tasks.create({
      domain: "product",
      taskKind: job.jobType === "REMINDER" ? "shopee_discount_renewal_reminder" : "shopee_discount_operator_confirmation",
      executionMode: "human",
      domainRefType: "shopee_discount_due_job",
      domainRefId: job.id,
      idempotencyKey: `shopee-discount:${job.id}`,
      state: "PENDING",
      priority: job.payload.severity === "CRITICAL" ? "P0" : job.payload.severity === "WARNING" ? "P1" : "P2",
      input: { planId, shopId: job.payload.shopId || null, targetStartsAt: job.payload.targetStartsAt || job.payload.startsAt || null },
      evidence: { dueJobId: job.id, source: "shopee-discount-scheduler" },
      createdBy: "shopee-discount-scheduler",
    });
    if (planId && task?.input?.planId !== planId) {
      throw schedulerError("SHOPEE_DISCOUNT_FOUNDATION_PLAN_BINDING_MISMATCH", "Existing Foundation task is bound to a different renewal plan");
    }
    return task;
  }

  async #handle(job) {
    if (!DUE_JOB_TYPES.has(job.jobType)) throw schedulerError("SHOPEE_DISCOUNT_DUE_JOB_UNSUPPORTED", "Unsupported Shopee Discount due-job type");
    if (["DAILY_SCAN", "MANUAL_SCAN"].includes(job.jobType)) {
      if (typeof this.scan !== "function") throw schedulerError("SHOPEE_DISCOUNT_SCAN_UNAVAILABLE", "Scan handler is unavailable");
      return this.scan({ ...job.payload, triggerType: job.jobType === "DAILY_SCAN" ? "daily" : "manual", dueJobId: job.id });
    }
    if (job.jobType === "RENEWAL_DRAFT") {
      if (typeof this.createRenewalDraft !== "function") throw schedulerError("SHOPEE_DISCOUNT_DRAFT_UNAVAILABLE", "Renewal draft handler is unavailable");
      const draft = await this.createRenewalDraft({ ...job.payload, dueJobId: job.id });
      const task = await this.#foundationTask(job, draft);
      if ((job.payload.localStartsAt || job.payload.targetStartsAt) && job.payload.timeZone) {
        const localStartsAt = job.payload.localStartsAt || utcToLocalDateTime(job.payload.targetStartsAt, job.payload.timeZone);
        for (const reminder of reminderDueJobs({ planId: draft.planId, shopId: job.payload.shopId, localStartsAt, timeZone: job.payload.timeZone })) {
          await this.#createOnce(reminder);
        }
      }
      return { draft, foundationTaskId: task.id };
    }
    if (job.jobType === "REMINDER") {
      const task = await this.#foundationTask(job);
      let notification = { status: "SKIPPED", reason: "not_configured" };
      if (this.notifications?.sendReminder) notification = await this.notifications.sendReminder({ ...job.payload, dueJobId: job.id, foundationTaskId: task.id });
      return { foundationTaskId: task.id, notification };
    }
    if (job.jobType === "DINGTALK_RETRY") {
      if (!this.notifications?.retry) throw schedulerError("SHOPEE_DISCOUNT_NOTIFICATION_UNAVAILABLE", "Notification retry handler is unavailable");
      return this.notifications.retry({ ...job.payload, dueJobId: job.id });
    }
    if (job.payload.approvalState !== "APPROVED") throw schedulerError("SHOPEE_DISCOUNT_EXECUTION_NOT_APPROVED", "Scheduled execution requires an explicitly approved plan");
    if (typeof this.executeApprovedPlan !== "function") throw schedulerError("SHOPEE_DISCOUNT_EXECUTOR_UNAVAILABLE", "Approved-plan executor is unavailable");
    return this.executeApprovedPlan(job.payload.planId, { dueJobId: job.id });
  }

  async #withLease(job, callback) {
    let lost = false;
    let renewing = null;
    const renew = async () => {
      if (renewing) return renewing;
      renewing = this.repository.renewDueJobLease({
        dueJobId: job.id, ownerId: this.ownerId, epoch: job.epoch, leaseMs: 60_000,
      }).then((ok) => { if (!ok) lost = true; return ok; }).finally(() => { renewing = null; });
      return renewing;
    };
    if (!await renew()) throw schedulerError("SHOPEE_DISCOUNT_DUE_JOB_LEASE_LOST", "Due-job lease was lost before processing");
    const timer = setInterval(() => { renew().catch(() => { lost = true; }); }, 20_000);
    timer.unref?.();
    try {
      const result = await callback();
      if (lost || !await renew()) throw schedulerError("SHOPEE_DISCOUNT_DUE_JOB_LEASE_LOST", "Due-job lease was lost during processing");
      return result;
    } finally {
      clearInterval(timer);
      await renewing?.catch(() => {});
    }
  }

  async tick({ enqueueDaily = true } = {}) {
    await this.#assertActive();
    const now = validDate(this.now(), "now");
    if (enqueueDaily) {
      const settings = await this.repository.getSettings?.();
      const scope = this.dailyScope;
      if (settings?.enabled && scope?.country && Array.isArray(scope.shops) && scope.shops.length) {
        await this.enqueueDailyScan(scope);
      }
    }
    const jobs = await this.repository.claimDueJobs({ now, limit: this.batchSize, ownerId: this.ownerId });
    const outcomes = [];
    for (const job of jobs) {
      try {
        const result = await this.#withLease(job, () => this.#handle(job));
        await this.repository.completeDueJob({ dueJobId: job.id, ownerId: this.ownerId, epoch: job.epoch, status: "SUCCEEDED", result, completedAt: this.now() });
        outcomes.push({ id: job.id, status: "SUCCEEDED", result });
      } catch (cause) {
        const code = cause?.code || "SHOPEE_DISCOUNT_DUE_JOB_FAILED";
        if (code === "SHOPEE_DISCOUNT_NOTIFICATION_IN_FLIGHT") {
          const retryAt = validDate(cause.retryAt, "notification retryAt");
          if (retryAt <= validDate(this.now(), "now")) throw schedulerError("SHOPEE_DISCOUNT_NOTIFICATION_RETRY_INVALID", "Notification retry time is not in the future");
          const deferred = await this.repository.deferDueJob({
            dueJobId: job.id, ownerId: this.ownerId, epoch: job.epoch, dueAt: retryAt,
            result: { code, retryAt: retryAt.toISOString() }, lastErrorCode: code,
          });
          if (!deferred) throw schedulerError("SHOPEE_DISCOUNT_DUE_JOB_LEASE_LOST", "Due-job lease was lost before notification deferral");
          outcomes.push({ id: job.id, status: "DEFERRED", code, retryAt: retryAt.toISOString() });
          continue;
        }
        await this.repository.completeDueJob({ dueJobId: job.id, ownerId: this.ownerId, epoch: job.epoch, status: "FAILED", result: { code }, lastErrorCode: code, completedAt: this.now() });
        outcomes.push({ id: job.id, status: "FAILED", code });
      }
    }
    return outcomes;
  }

  async start() {
    await this.#assertActive();
    if (this.timer) return false;
    const run = async () => {
      if (this.inFlight) return this.inFlight;
      this.inFlight = this.tick().catch((cause) => this.onError(cause)).finally(() => { this.inFlight = null; });
      return this.inFlight;
    };
    await run();
    this.timer = setInterval(run, this.pollIntervalMs);
    this.timer.unref?.();
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
