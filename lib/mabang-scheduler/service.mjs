import { randomUUID } from "node:crypto";
import { nextRunAt } from "./schedule.mjs";
import { removeFileInsideRoot, resolveExistingFile } from "../security/file-policy.mjs";

export class MabangSchedulerService {
  constructor({ db, executor, exportRoot, audit = null, ownerId = randomUUID(), pollIntervalMs = Number(process.env.SCHEDULER_POLL_INTERVAL_MS || 10000), catchUpThresholdMs = Number(process.env.SCHEDULER_CATCH_UP_THRESHOLD_MS || 2 * 60 * 60 * 1000), now = () => new Date() }) {
    this.db = db;
    this.executor = executor;
    this.exportRoot = exportRoot;
    this.audit = audit;
    this.pollIntervalMs = Math.max(1000, pollIntervalMs);
    this.catchUpThresholdMs = Math.max(0, catchUpThresholdMs);
    this.now = now;
    this.ownerId = ownerId;
    this.timer = null;
    this.running = false;
  }

  async initialize() {
    const current = this.now();
    await this.db.recoverStaleRuns(current);
    for (const task of (await this.db.listTasks()).filter((item) => item.enabled && !item.nextRunAt)) {
      await this.db.updateTaskScheduleState(task.id, { nextRunAt: nextRunAt(task, current).toISOString() });
    }
  }

  async cleanupExpiredFiles(current = this.now()) {
    for (const file of await this.db.expiredFiles(current)) {
      try {
        const target = await resolveExistingFile(this.exportRoot, file.relativePath, { allowedExtensions: [".xlsx"] });
        await removeFileInsideRoot(this.exportRoot, target.path);
      } catch {
        // Missing or invalid expired files are never resolved outside the export root.
      }
      await this.db.markFileExpired(file.id);
    }
  }

  async scheduleDueTasks(current = this.now()) {
    for (const task of await this.db.dueTasks(current)) {
      const scheduled = new Date(task.nextRunAt);
      const lag = current.getTime() - scheduled.getTime();
      const shouldRun = lag <= this.catchUpThresholdMs && (task.catchUpEnabled || lag <= this.pollIntervalMs * 2);
      let run;
      try {
        run = await this.db.createRunIfAbsent({
          taskId: task.id,
          triggerType: "scheduled",
          scheduledRunAt: scheduled,
          status: shouldRun ? "pending" : "skipped",
          errorMessage: shouldRun ? null : `服务恢复时已错过计划时间 ${Math.round(lag / 60000)} 分钟，本次不补执行。`,
        });
      } catch (error) {
        if (error?.code !== "TASK_DELETED") throw error;
        this.audit?.recordSafely({
          module: "mabang",
          action: "mabang.task.deleted_scheduler_skipped",
          status: "failed",
          actorType: "scheduler",
          taskId: task.id,
          errorStage: "scheduler",
          errorCode: "TASK_DELETED",
          errorSummary: error,
          metadata: { taskType: task.taskType, triggerType: "scheduled" },
        });
        continue;
      }
      if (run && !shouldRun) {
        await this.db.updateRun(run.id, {
          finishedAt: current.toISOString(),
          errorStage: "scheduler",
          errorCode: "MISSED_SCHEDULE",
        });
      }
      await this.db.updateTaskScheduleState(task.id, { nextRunAt: nextRunAt(task, new Date(scheduled.getTime() + 1000)).toISOString() });
    }
  }

  async tick() {
    if (this.running) return false;
    this.running = true;
    const current = this.now();
    try {
      if (!await this.db.acquireLease("mabang_scheduler", this.ownerId, current, Math.max(30000, this.pollIntervalMs * 3))) return false;
      await this.scheduleDueTasks(current);
      for (const run of await this.db.pendingRuns(10)) await this.executor.executeRun(run.id);
      await this.cleanupExpiredFiles(current);
      return true;
    } finally {
      this.running = false;
    }
  }

  async start({ requireInitialLease = false } = {}) {
    await this.initialize();
    if (requireInitialLease && !await this.db.acquireLease(
      "mabang_scheduler",
      this.ownerId,
      this.now(),
      Math.max(30000, this.pollIntervalMs * 3),
    )) return false;
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        process.stderr.write(`[scheduler] ${new Date().toISOString()} ${error.message}\n`);
      }
    };
    loop();
    this.timer = setInterval(loop, this.pollIntervalMs);
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.db.releaseLease("mabang_scheduler", this.ownerId);
  }
}
