import { randomUUID } from "node:crypto";

export class OperationDrainController {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.draining = false;
    this.active = new Map();
    this.waiters = new Set();
  }

  assertAccepting() {
    if (!this.draining) return;
    const error = new Error("履约服务正在等待现有任务结束，暂不接受新任务");
    error.code = "FULFILLMENT_DRAINING";
    throw error;
  }

  async run(kind, { write = false } = {}, operation) {
    this.assertAccepting();
    const id = randomUUID();
    this.active.set(id, { id, kind, write, startedAt: this.now().toISOString() });
    try { return await operation(); }
    finally {
      this.active.delete(id);
      if (!this.active.size) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      }
    }
  }

  beginDrain() { this.draining = true; return this.status(); }

  status() {
    const operations = [...this.active.values()];
    return { draining: this.draining, activeOperations: operations.length,
      activeWriteOperations: operations.filter((item) => item.write).length,
      operationKinds: [...new Set(operations.map((item) => item.kind))].sort() };
  }

  async waitForIdle(timeoutMs = 30 * 60 * 1000) {
    if (!this.active.size) return true;
    let timer;
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(true); };
      this.waiters.add(done);
      timer = setTimeout(() => { this.waiters.delete(done); resolve(false); }, timeoutMs);
      timer.unref?.();
    });
  }
}
