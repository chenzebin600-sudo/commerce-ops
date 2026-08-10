export class CustomerServiceReplyRunner {
  constructor({
    orchestrator,
    enabled = false,
    concurrency = 4,
    batchSize = 20,
    pollIntervalMs = 2_000,
    logger = console,
  } = {}) {
    if (!orchestrator || typeof orchestrator.processNext !== "function") {
      throw new TypeError("Customer-service Reply orchestrator is required");
    }
    this.orchestrator = orchestrator;
    this.enabled = Boolean(enabled);
    this.concurrency = Math.max(1, Math.min(20, Number(concurrency) || 4));
    this.batchSize = Math.max(this.concurrency, Math.min(200, Number(batchSize) || 20));
    this.pollIntervalMs = Math.max(500, Number(pollIntervalMs) || 2_000);
    this.logger = logger;
    this.timer = null;
    this.cycle = null;
  }

  async runCycle() {
    if (!this.enabled || this.cycle) return null;
    this.cycle = (async () => {
      let processed = 0;
      const perWorker = Math.ceil(this.batchSize / this.concurrency);
      await Promise.all(Array.from({ length: this.concurrency }, async () => {
        for (let index = 0; index < perWorker; index += 1) {
          const result = await this.orchestrator.processNext();
          if (!result) break;
          processed += 1;
        }
      }));
      return processed;
    })();
    try {
      return await this.cycle;
    } finally {
      this.cycle = null;
    }
  }

  start() {
    if (!this.enabled || this.timer) return false;
    this.timer = setInterval(() => {
      this.runCycle().catch((error) => this.logger.error?.(`Customer-service reply cycle failed: ${error.message}`));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    queueMicrotask(() => {
      this.runCycle().catch((error) => this.logger.error?.(`Customer-service reply cycle failed: ${error.message}`));
    });
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cycle) await this.cycle.catch(() => null);
  }
}
