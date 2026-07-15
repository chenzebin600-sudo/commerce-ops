import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nextRunAt } from "./schedule.mjs";

export class MabangSchedulerService {
  constructor({ db, executor, exportRoot, pollIntervalMs = Number(process.env.SCHEDULER_POLL_INTERVAL_MS || 10000), catchUpThresholdMs = Number(process.env.SCHEDULER_CATCH_UP_THRESHOLD_MS || 2 * 60 * 60 * 1000), now = () => new Date() }) {
    this.db = db;
    this.executor = executor;
    this.exportRoot = exportRoot;
    this.pollIntervalMs = Math.max(1000, pollIntervalMs);
    this.catchUpThresholdMs = Math.max(0, catchUpThresholdMs);
    this.now = now;
    this.ownerId = randomUUID();
    this.timer = null;
    this.running = false;
  }

  initialize() {
    const current = this.now();
    this.db.recoverStaleRuns(current);
    for (const task of this.db.listTasks().filter((item) => item.enabled && !item.nextRunAt)) {
      this.db.updateTaskScheduleState(task.id, { nextRunAt: nextRunAt(task, current).toISOString() });
    }
  }

  async cleanupExpiredFiles(current = this.now()) {
    for (const file of this.db.expiredFiles(current)) {
      const target = path.resolve(this.exportRoot, file.relative_path);
      const relative = path.relative(this.exportRoot, target);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) await fs.unlink(target).catch(() => {});
      this.db.markFileExpired(file.id);
    }
  }

  scheduleDueTasks(current = this.now()) {
    for (const task of this.db.dueTasks(current)) {
      const scheduled = new Date(task.nextRunAt);
      const lag = current.getTime() - scheduled.getTime();
      const shouldRun = lag <= this.catchUpThresholdMs && (task.catchUpEnabled || lag <= this.pollIntervalMs * 2);
      const run = this.db.createRunIfAbsent({
        taskId: task.id,
        triggerType: "scheduled",
        scheduledRunAt: scheduled,
        status: shouldRun ? "pending" : "skipped",
        errorMessage: shouldRun ? null : `服务恢复时已错过计划时间 ${Math.round(lag / 60000)} 分钟，本次不补执行。`,
      });
      if (run && !shouldRun) {
        this.db.updateRun(run.id, {
          finishedAt: current.toISOString(),
          errorStage: "scheduler",
          errorCode: "MISSED_SCHEDULE",
        });
      }
      this.db.updateTaskScheduleState(task.id, { nextRunAt: nextRunAt(task, new Date(scheduled.getTime() + 1000)).toISOString() });
    }
  }

  async tick() {
    if (this.running) return false;
    this.running = true;
    const current = this.now();
    try {
      if (!this.db.acquireLease("mabang_scheduler", this.ownerId, current, Math.max(30000, this.pollIntervalMs * 3))) return false;
      this.scheduleDueTasks(current);
      for (const run of this.db.pendingRuns(10)) await this.executor.executeRun(run.id);
      await this.cleanupExpiredFiles(current);
      return true;
    } finally {
      this.running = false;
    }
  }

  start() {
    this.initialize();
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        process.stderr.write(`[scheduler] ${new Date().toISOString()} ${error.message}\n`);
      }
    };
    loop();
    this.timer = setInterval(loop, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db.releaseLease("mabang_scheduler", this.ownerId);
  }
}
