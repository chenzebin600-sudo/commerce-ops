import { randomUUID } from "node:crypto";
import { nextRunAt } from "./schedule.mjs";
import { removeFileInsideRoot, resolveExistingFile } from "../security/file-policy.mjs";

export class MabangSchedulerService {
  constructor({
    db,
    executor,
    exportRoot,
    audit = null,
    pollIntervalMs = Number(process.env.SCHEDULER_POLL_INTERVAL_MS || 10000),
    catchUpThresholdMs = Number(process.env.SCHEDULER_CATCH_UP_THRESHOLD_MS || 2 * 60 * 60 * 1000),
    schedulerLeaseMs = null,
    staleRunThresholdMs = Number(process.env.SCHEDULER_STALE_RUN_THRESHOLD_MS || 5 * 60 * 1000),
    now = () => new Date(),
  }) {
    this.db = db;
    this.executor = executor;
    this.exportRoot = exportRoot;
    this.audit = audit;
    this.pollIntervalMs = Math.max(1000, pollIntervalMs);
    this.catchUpThresholdMs = Math.max(0, catchUpThresholdMs);
    this.schedulerLeaseMs = schedulerLeaseMs === null
      ? Math.max(30000, this.pollIntervalMs * 3)
      : Math.max(90, Number(schedulerLeaseMs) || 30000);
    this.staleRunThresholdMs = Math.max(1000, Number(staleRunThresholdMs) || 5 * 60 * 1000);
    this.now = now;
    this.ownerId = randomUUID();
    this.timer = null;
    this.leaseHeartbeatTimer = null;
    this.leaseHeartbeatRunning = false;
    this.leaseLost = false;
    this.running = false;
  }

  startLeaseHeartbeat() {
    this.stopLeaseHeartbeat();
    this.leaseLost = false;
    const intervalMs = Math.max(30, Math.floor(this.schedulerLeaseMs / 3));
    this.leaseHeartbeatTimer = setInterval(async () => {
      if (this.leaseHeartbeatRunning) return;
      this.leaseHeartbeatRunning = true;
      try {
        const renewed = await this.db.acquireLease(
          "mabang_scheduler",
          this.ownerId,
          this.now(),
          this.schedulerLeaseMs,
        );
        if (!renewed) this.leaseLost = true;
      } catch (error) {
        process.stderr.write(`[scheduler] ${new Date().toISOString()} lease renewal failed: ${error.message}\n`);
      } finally {
        this.leaseHeartbeatRunning = false;
      }
    }, intervalMs);
    this.leaseHeartbeatTimer.unref?.();
  }

  stopLeaseHeartbeat() {
    if (this.leaseHeartbeatTimer) clearInterval(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = null;
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
        await this.audit?.recordSafely({
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
      if (!await this.db.acquireLease("mabang_scheduler", this.ownerId, current, this.schedulerLeaseMs)) return false;
      this.startLeaseHeartbeat();
      await this.db.recoverStaleRuns(current, this.staleRunThresholdMs);
      await this.scheduleDueTasks(current);
      for (const run of await this.db.pendingRuns(10)) {
        if (this.leaseLost) break;
        await this.executor.executeRun(run.id);
      }
      if (!this.leaseLost) await this.cleanupExpiredFiles(current);
      return !this.leaseLost;
    } finally {
      this.stopLeaseHeartbeat();
      this.running = false;
    }
  }

  async start() {
    await this.initialize();
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

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopLeaseHeartbeat();
    await this.db.releaseLease("mabang_scheduler", this.ownerId);
  }
}
