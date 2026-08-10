import { nextAlignedAutomationRunAt } from "./price-control-contracts.mjs";

export class PriceControlScheduleRunner {
  constructor({
    service,
    notifier = null,
    enabled = false,
    intervalMs = 60 * 60 * 1000,
    pollIntervalMs = 60_000,
    now = () => new Date(),
    logger = console,
  }) {
    this.service = service;
    this.notifier = notifier;
    this.legacyEnabled = Boolean(enabled);
    this.intervalMs = Math.max(60_000, Number(intervalMs) || 60 * 60 * 1000);
    this.pollIntervalMs = Math.max(10_000, Number(pollIntervalMs) || 60_000);
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.legacyNextRunAt = null;
  }

  start() {
    if (this.timer) return false;
    this.legacyNextRunAt = this.legacyEnabled
      ? nextAlignedAutomationRunAt(this.now(), this.intervalMs / 60_000)
      : null;
    this.timer = setInterval(() => {
      this.runDue().catch((error) => this.logger.error?.(`Price control sync failed: ${error.message}`));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    queueMicrotask(() => {
      this.runDue().catch((error) => this.logger.error?.(`Price control sync failed: ${error.message}`));
    });
    return true;
  }

  async dueSettings() {
    const current = this.now();
    const persisted = await this.service.claimDueAutomation(current);
    if (persisted) return persisted;
    if (!this.legacyEnabled || !this.legacyNextRunAt || current < this.legacyNextRunAt) return null;
    this.legacyNextRunAt = nextAlignedAutomationRunAt(current, this.intervalMs / 60_000);
    return {
      enabled: true,
      intervalMinutes: Math.round(this.intervalMs / 60_000),
      dingtalkConfigId: null,
      notifyOnChange: false,
      notifyOnFailure: false,
      legacy: true,
    };
  }

  async runDue() {
    if (this.running) return null;
    await this.service.recoverStaleRun({ requestedBy: "price-control-scheduler" });
    const settings = await this.dueSettings();
    if (!settings) return null;
    return this.runOnce(settings);
  }

  async runOnce(settings) {
    if (this.running || !settings?.enabled) return null;
    this.running = true;
    try {
      const result = await this.service.sync({
        mode: "incremental",
        triggerType: "scheduled",
        requestedBy: "price-control-scheduler",
      });
      let notificationStatus = "SKIPPED";
      let notificationAt = null;
      if (result.changes.length && settings.notifyOnChange) {
        if (!this.notifier) {
          notificationStatus = "NOT_CONFIGURED";
        } else {
          try {
            await this.notifier.sendChanges({ settings, result });
            notificationStatus = "SENT";
            notificationAt = this.now().toISOString();
          } catch (error) {
            notificationStatus = "FAILED";
            await this.service.recordNotification(result.run.id, {
              status: notificationStatus,
              errorCode: error?.code || "PRICE_CONTROL_DINGTALK_FAILED",
            }, this.now());
            await this.service.completeAutomation({
              status: "PARTIAL_SUCCESS",
              notificationStatus,
              errorCode: error?.code || "PRICE_CONTROL_DINGTALK_FAILED",
              errorMessage: error?.message,
            }, this.now());
            return { ...result, notificationStatus, notificationError: error?.code || "PRICE_CONTROL_DINGTALK_FAILED" };
          }
        }
      }
      await this.service.recordNotification(result.run.id, {
        status: notificationStatus,
        notifiedAt: notificationAt,
      }, this.now());
      await this.service.completeAutomation({
        status: "SUCCEEDED",
        notificationStatus,
        notificationAt,
      }, this.now());
      return { ...result, notificationStatus };
    } catch (error) {
      let notificationStatus = "SKIPPED";
      let notificationAt = null;
      if (settings.notifyOnFailure && this.notifier) {
        try {
          await this.notifier.sendFailure({ settings, error, now: this.now() });
          notificationStatus = "SENT";
          notificationAt = this.now().toISOString();
        } catch {
          notificationStatus = "FAILED";
        }
      }
      await this.service.completeAutomation({
        status: "FAILED",
        notificationStatus,
        notificationAt,
        errorCode: error?.code || "PRICE_CONTROL_SYNC_FAILED",
        errorMessage: error?.message,
      }, this.now()).catch(() => null);
      throw error;
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
