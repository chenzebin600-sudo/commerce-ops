import { addDateDays, businessDate } from "./profit-date-coverage.mjs";

export function shanghaiProfitScheduleState(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const record = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return {
    scheduleDate: `${record.year}-${record.month}-${record.day}`,
    hour: Number(record.hour),
    minute: Number(record.minute),
  };
}

export class ProfitScheduleRunner {
  constructor({
    service,
    enabled = true,
    hour = 9,
    minute = 30,
    pollIntervalMs = 60_000,
    retryIntervalMs = 30 * 60_000,
    now = () => new Date(),
    logger = console,
  } = {}) {
    if (!service) throw new TypeError("Profit service is required");
    this.service = service;
    this.enabled = Boolean(enabled);
    this.hour = Math.max(0, Math.min(23, Number(hour) || 0));
    this.minute = Math.max(0, Math.min(59, Number(minute) || 0));
    this.pollIntervalMs = Math.max(10_000, Number(pollIntervalMs) || 60_000);
    this.retryIntervalMs = Math.max(60_000, Number(retryIntervalMs) || 30 * 60_000);
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.lastAttemptScheduleDate = null;
    this.lastAttemptAt = null;
    this.lastRun = null;
  }

  start() {
    if (!this.enabled || this.timer) return false;
    this.timer = setInterval(() => {
      this.runDue().catch((error) => this.logger.error?.(`Profit incremental sync failed: ${error.message}`));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    queueMicrotask(() => {
      this.runDue().catch((error) => this.logger.error?.(`Profit incremental sync failed: ${error.message}`));
    });
    return true;
  }

  async runDue() {
    if (!this.enabled || this.running) return null;
    const current = this.now();
    const local = shanghaiProfitScheduleState(current);
    if (local.hour < this.hour || (local.hour === this.hour && local.minute < this.minute)) return null;
    if (this.lastAttemptScheduleDate === local.scheduleDate
      && this.lastAttemptAt
      && current.getTime() - this.lastAttemptAt.getTime() < this.retryIntervalMs) return null;
    if (typeof this.service.periods === "function"
      && this.lastRun?.scheduleDate === local.scheduleDate
      && ["COMPLETE", "SKIPPED_ALREADY_SYNCED"].includes(this.lastRun.status)) return null;
    this.lastAttemptScheduleDate = local.scheduleDate;
    this.lastAttemptAt = current;
    const targetDate = addDateDays(businessDate(current), -1);
    this.running = true;
    try {
      if (typeof this.service.periods === "function") {
        const results = await Promise.all([
          this.service.runSync({
            platform: "LAZADA",
            preset: "CURRENT_BILLING_PERIOD",
            triggerType: "scheduled",
          }),
          this.service.runSync({
            platform: "SHOPEE",
            dateFrom: targetDate,
            dateTo: targetDate,
            triggerType: "scheduled",
          }),
        ]);
        const outcomes = results.flatMap((result) => result.outcomes || []);
        this.lastRun = {
          status: outcomes.length && outcomes.every((outcome) => outcome.ok && outcome.result?.status !== "FAILED")
            ? "COMPLETE"
            : "PARTIAL",
          scheduleDate: local.scheduleDate,
          targetDate,
          outcomes,
          completedAt: this.now().toISOString(),
        };
        return this.lastRun;
      }
      const status = await this.service.status({ dateFrom: targetDate, dateTo: targetDate });
      if (status.run && ["COMPLETE", "PARTIAL"].includes(status.run.status) && status.run.currentStage === "COMPLETE") {
        this.lastRun = { status: "SKIPPED_ALREADY_SYNCED", targetDate, runId: status.run.id, completedAt: status.run.completedAt };
        return this.lastRun;
      }
      const run = await this.service.runSync({ dateFrom: targetDate, dateTo: targetDate, triggerType: "scheduled" });
      this.lastRun = { status: run?.status || "UNKNOWN", targetDate, runId: run?.id || null, completedAt: run?.completedAt || null };
      return this.lastRun;
    } finally {
      this.running = false;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      timeZone: "Asia/Shanghai",
      scheduleTime: `${String(this.hour).padStart(2, "0")}:${String(this.minute).padStart(2, "0")}`,
      mode: typeof this.service.periods === "function"
        ? "PLATFORM_DAILY_INCREMENTAL"
        : "PREVIOUS_DAY_MISSING_ONLY",
      running: this.running,
      lastRun: this.lastRun,
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
