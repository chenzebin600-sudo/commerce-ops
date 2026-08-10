export function shanghaiScheduleState(value = new Date()) {
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
  return Object.freeze({
    scheduleDate: `${record.year}-${record.month}-${record.day}`,
    hour: Number(record.hour),
    minute: Number(record.minute),
  });
}

export class ProductPackageScheduleRunner {
  constructor({ service, enabled = false, pollIntervalMs = 60_000, now = () => new Date(), logger = console }) {
    this.service = service;
    this.enabled = Boolean(enabled);
    this.pollIntervalMs = Math.max(10_000, Number(pollIntervalMs) || 60_000);
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!this.enabled || this.timer) return false;
    this.timer = setInterval(() => {
      this.runDue().catch((error) => this.logger.error?.(`Product package sync failed: ${error.message}`));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    queueMicrotask(() => {
      this.runDue().catch((error) => this.logger.error?.(`Product package sync failed: ${error.message}`));
    });
    return true;
  }

  async runDue() {
    if (!this.enabled || this.running) return null;
    const current = this.now();
    const local = shanghaiScheduleState(current);
    if (local.hour < 9) return null;
    this.running = true;
    try {
      return await this.service.sync({
        triggerType: "scheduled",
        scheduleDate: local.scheduleDate,
        requestedBy: "product-package-scheduler",
      });
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
