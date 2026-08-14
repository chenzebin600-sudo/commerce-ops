const SEVERITIES = new Set(["INFO", "WARNING", "CRITICAL"]);
const COUNT_KEYS = Object.freeze(["shops", "links", "variants", "exceptions", "written", "unknown"]);

function notificationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function text(value, name, max = 120) {
  const output = String(value ?? "").trim();
  if (!output || output.length > max || /[\r\n]/.test(output)) throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_INPUT_INVALID", `${name} is invalid`);
  return output;
}

function safeCode(cause) {
  const candidate = String(cause?.code || "DELIVERY_FAILED").trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,80}$/.test(candidate) ? candidate : "DELIVERY_FAILED";
}

function safeCounts(value = {}) {
  const output = {};
  for (const key of COUNT_KEYS) {
    if (value[key] == null) continue;
    const count = Number(value[key]);
    if (!Number.isSafeInteger(count) || count < 0) throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_INPUT_INVALID", `${key} count is invalid`);
    output[key] = count;
  }
  return output;
}

function notificationConfig(config) {
  let url;
  try { url = new URL(config.entryBaseUrl); }
  catch { throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_CONFIG_INVALID", "Internal entry base URL is invalid"); }
  const allowedHost = text(config.allowedEntryHost || url.host, "allowedEntryHost", 255).toLowerCase();
  if (url.protocol !== "https:" || url.host.toLowerCase() !== allowedHost || url.username || url.password || url.search || url.hash) {
    throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_CONFIG_INVALID", "Internal entry URL must use the configured HTTPS host");
  }
  return { url, allowedHost };
}

export function buildDingTalkSummary(input, config) {
  const severity = text(input.severity || "INFO", "severity", 20).toUpperCase();
  if (!SEVERITIES.has(severity)) throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_INPUT_INVALID", "severity is invalid");
  const planId = text(input.planId, "planId", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(planId)) throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_INPUT_INVALID", "planId is invalid");
  const { url } = notificationConfig(config);
  const entry = new URL(`/shopee-discount/plans/${encodeURIComponent(planId)}`, url);
  const counts = safeCounts(input.counts);
  const countLine = COUNT_KEYS.filter((key) => counts[key] != null).map((key) => `${key}: ${counts[key]}`).join(" · ") || "counts: 0";
  const hours = input.hoursBefore == null ? null : Number(input.hoursBefore);
  const timing = Number.isFinite(hours) && hours > 0 ? `T-${hours}h` : "status update";
  return Object.freeze({
    msgtype: "markdown",
    markdown: Object.freeze({
      title: `Shopee Discount ${severity}`,
      text: `### Shopee Discount ${severity}\n\n${timing}\n\n${countLine}\n\n[Open internal task](${entry.href})`,
    }),
  });
}

function duplicate(cause) {
  return /UNIQUE|duplicate/i.test(String(cause?.message || cause));
}

export class ShopeeDiscountNotifications {
  constructor({ repository, transport, groupId, entryBaseUrl, allowedEntryHost = null, maxAttempts = 3, now = () => new Date() } = {}) {
    if (!repository?.getNotificationByDedupeKey || !repository?.createNotification
      || !repository?.claimNotificationDelivery || !repository?.markNotificationDelivery || !repository?.markNotificationUnknown) {
      throw new TypeError("Persistent notification repository is required");
    }
    if (typeof transport !== "function") throw new TypeError("DingTalk transport is required");
    this.repository = repository;
    this.transport = transport;
    this.groupId = text(groupId, "groupId", 120);
    this.entryBaseUrl = entryBaseUrl;
    this.allowedEntryHost = allowedEntryHost;
    this.maxAttempts = Math.min(5, Math.max(1, Number(maxAttempts) || 3));
    this.now = now;
    notificationConfig({ entryBaseUrl, allowedEntryHost });
  }

  async #record(input) {
    const existing = await this.repository.getNotificationByDedupeKey(input.dedupeKey);
    if (existing) return existing;
    try {
      return await this.repository.createNotification({
        dedupeKey: input.dedupeKey,
        planId: input.planId,
        notificationType: input.notificationType || "DINGTALK_SUMMARY",
        severity: input.severity,
        title: `Shopee Discount ${input.severity}`,
        message: "Safe operational summary",
        channel: "DINGTALK_GROUP",
        metadata: { summaryInput: { planId: input.planId, shopId: input.shopId || null, severity: input.severity, hoursBefore: input.hoursBefore || null, counts: safeCounts(input.counts) } },
        createdAt: this.now(),
      });
    } catch (cause) {
      if (!duplicate(cause)) throw cause;
      return this.repository.getNotificationByDedupeKey(input.dedupeKey);
    }
  }

  async #scheduleRetry(row, summaryInput, attempt) {
    if (attempt >= this.maxAttempts || !this.repository.createDueJob) return false;
    try {
      await this.repository.createDueJob({
        jobType: "DINGTALK_RETRY",
        dedupeKey: `notification:${row.id}:attempt:${attempt + 1}`,
        dueAt: new Date(this.now().getTime() + Math.min(60, 2 ** attempt) * 60_000),
        payload: { notificationId: row.id, dedupeKey: row.dedupeKey, attempt: attempt + 1, summaryInput },
      });
      return true;
    } catch (cause) {
      if (duplicate(cause)) return true;
      return false;
    }
  }

  async #deliver(input, { retry = false } = {}) {
    const dedupeKey = text(input.dedupeKey, "dedupeKey", 240);
    const summaryInput = {
      planId: text(input.planId, "planId", 100), shopId: input.shopId == null ? null : text(input.shopId, "shopId", 100),
      severity: text(input.severity || "INFO", "severity", 20).toUpperCase(), hoursBefore: input.hoursBefore,
      counts: safeCounts(input.counts),
    };
    const row = await this.#record({ ...summaryInput, dedupeKey, notificationType: input.notificationType });
    if (row.status === "DELIVERED") return { status: "DELIVERED", reused: true, notificationId: row.id };
    if (row.coordinationState === "UNKNOWN") {
      throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_COORDINATION_REQUIRED", "DingTalk delivery requires manual coordination");
    }
    if (row.status === "SENDING") {
      const coordinated = await this.repository.markNotificationUnknown({
        notificationId: row.id,
        reasonCode: "DINGTALK_DELIVERY_UNKNOWN",
        evidence: { notificationId: row.id, attemptCount: row.attemptCount },
      });
      throw notificationError(
        coordinated ? "SHOPEE_DISCOUNT_NOTIFICATION_COORDINATION_REQUIRED" : "SHOPEE_DISCOUNT_NOTIFICATION_IN_FLIGHT",
        coordinated ? "DingTalk delivery outcome is unknown and requires manual coordination" : "DingTalk delivery is still in flight",
      );
    }
    const requestedAttempt = retry ? Number(input.attempt || row.attemptCount + 1) : Number(row.attemptCount || 0) + 1;
    if (!Number.isSafeInteger(requestedAttempt) || requestedAttempt < 1 || requestedAttempt > this.maxAttempts) {
      return { status: "FAILED", reused: true, notificationId: row.id };
    }
    const claimed = await this.repository.claimNotificationDelivery({ notificationId: row.id, expectedAttemptCount: requestedAttempt - 1 });
    if (!claimed) {
      const current = await this.repository.getNotificationByDedupeKey(dedupeKey);
      return { status: current?.status || "SENDING", reused: true, notificationId: row.id };
    }
    const attempt = claimed.attemptCount;
    const payload = buildDingTalkSummary(summaryInput, { entryBaseUrl: this.entryBaseUrl, allowedEntryHost: this.allowedEntryHost });
    try {
      await this.transport({ groupId: this.groupId, payload });
      await this.repository.markNotificationDelivery({ notificationId: row.id, patch: {
        status: "DELIVERED", attemptCount: attempt, deliveredAt: this.now().toISOString(), lastErrorCode: null, updatedAt: this.now().toISOString(),
      } });
      return { status: "DELIVERED", reused: false, notificationId: row.id };
    } catch (cause) {
      const terminal = attempt >= this.maxAttempts;
      await this.repository.markNotificationDelivery({ notificationId: row.id, patch: {
        status: terminal ? "FAILED" : "RETRY_WAIT", attemptCount: attempt, lastErrorCode: safeCode(cause), updatedAt: this.now().toISOString(),
      } });
      if (!terminal) await this.#scheduleRetry(row, summaryInput, attempt);
      return { status: terminal ? "FAILED" : "RETRY_WAIT", notificationId: row.id, errorCode: safeCode(cause) };
    }
  }

  async sendReminder(input) {
    return this.#deliver({
      ...input,
      dedupeKey: `reminder:${text(input.dueJobId, "dueJobId", 120)}`,
      notificationType: "RENEWAL_REMINDER",
    });
  }

  async retry(input) {
    const row = await this.repository.getNotificationByDedupeKey(text(input.dedupeKey, "dedupeKey", 240));
    if (!row) throw notificationError("SHOPEE_DISCOUNT_NOTIFICATION_NOT_FOUND", "Notification retry target was not found");
    const summaryInput = input.summaryInput || row.metadata?.summaryInput;
    return this.#deliver({ ...summaryInput, dedupeKey: row.dedupeKey, attempt: input.attempt, notificationType: row.notificationType }, { retry: true });
  }

  async sendBusinessSummary(input) {
    const notification = await this.#deliver({
      ...input,
      dedupeKey: text(input.dedupeKey, "dedupeKey", 240),
      notificationType: "BUSINESS_SUMMARY",
    });
    return { businessResult: input.businessResult, notification };
  }
}
