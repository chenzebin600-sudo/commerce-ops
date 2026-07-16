import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decryptSecret } from "./crypto.mjs";
import { filtersForWorker } from "./fields.mjs";
import { paymentDateRange, retentionExpiresAt } from "./schedule.mjs";
import { buildFailureNotification, buildSuccessNotification, canExposeDownloadLink, sendDingtalkMessage } from "./dingtalk.mjs";
import {
  atomicMoveFile,
  createTemporaryFilePath,
  hashFileBuffer,
  removeFileInsideRoot,
  sanitizeFilename,
} from "../security/file-policy.mjs";
import { normalizedSanitizationCounts } from "../security/excel-cell-policy.mjs";

const RETRYABLE = /timeout|timed out|超时|ECONN|ENET|EAI_AGAIN|network|网络|临时|session|会话失效|502|503|504/i;
const NON_RETRYABLE = /账号|密码|验证码|验证不通过|筛选.*无效|字段.*无效|权限|磁盘|写入权限|APP_ENCRYPTION_KEY/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilenamePart(value) {
  return String(value || "task").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "task";
}

function timestampParts(date = new Date(), timeZone = "Asia/Shanghai") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

export function scheduledExportFilename(taskName, startDate, endDate, executionTime = new Date(), timeZone = "Asia/Shanghai", taskType = "order_export") {
  if (taskType === "inventory_export") {
    return `马帮库存_${sanitizeFilenamePart(taskName)}_${timestampParts(executionTime, timeZone)}.xlsx`;
  }
  return `马帮订单_${sanitizeFilenamePart(taskName)}_${startDate.replaceAll("-", "")}_${endDate.replaceAll("-", "")}_${timestampParts(executionTime, timeZone)}.xlsx`;
}

function durationText(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function errorCode(error, fallback = "TASK_FAILED") {
  return String(error?.code || fallback).slice(0, 80);
}

function retryDelaysFromEnv() {
  const configured = String(process.env.SCHEDULER_RETRY_DELAYS_MS || "").trim();
  if (!configured) return [30000, 120000, 300000];
  return configured.split(",").map(Number).filter((value) => Number.isFinite(value) && value >= 0).slice(0, 3);
}

export function createTaskExecutor({ db, runWorker, exportRoot, tempRoot = path.join(exportRoot, ".temp"), notify = sendDingtalkMessage, retryDelays = retryDelaysFromEnv(), now = () => new Date(), audit = null }) {
  async function runStep(runId, stage, callback, { attempt = 1, message = "" } = {}) {
    const startedAt = now();
    db.addRunEvent({ runId, stage, status: "running", attempt, startedAt, message });
    try {
      const result = await callback();
      const finishedAt = now();
      db.addRunEvent({ runId, stage, status: "success", attempt, startedAt, finishedAt, durationMs: finishedAt - startedAt, message });
      return result;
    } catch (error) {
      const finishedAt = now();
      db.addRunEvent({ runId, stage, status: "failed", attempt, startedAt, finishedAt, durationMs: finishedAt - startedAt, message: error.message, errorCode: errorCode(error) });
      throw error;
    }
  }

  async function withRetry(runId, stage, callback) {
    let retries = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return { value: await runStep(runId, stage, callback, { attempt }), retries };
      } catch (error) {
        const canRetry = !NON_RETRYABLE.test(error.message) && RETRYABLE.test(error.message) && retries < retryDelays.length;
        if (!canRetry) {
          error.retryCount = retries;
          throw error;
        }
        const waitMs = retryDelays[retries];
        retries += 1;
        db.addRunEvent({ runId, stage, status: "retrying", attempt, startedAt: now(), message: `将在 ${waitMs}ms 后进行第 ${retries} 次重试。` });
        db.updateRun(runId, { retryCount: retries });
        await delay(waitMs);
      }
    }
  }

  async function loadRobot(task) {
    if (!task.notifyEnabled || !task.dingtalkConfigId) return null;
    const robot = db.getDingtalkConfig(task.dingtalkConfigId, { includeSecret: true });
    if (!robot?.enabled) return null;
    return {
      ...robot,
      webhookUrl: decryptSecret(robot.encryptedWebhookUrl),
      secret: robot.encryptedSecret ? decryptSecret(robot.encryptedSecret) : "",
    };
  }

  async function sendFailure(task, run, stage, error, retries) {
    try {
      const robot = await loadRobot(task);
      if (!robot?.notifyOnFailure) return "disabled";
      const notification = buildFailureNotification({ task, run, errorStage: stage, errorMessage: error.message, retryCount: retries });
      await notify({ ...notification, webhookUrl: robot.webhookUrl, secret: robot.secret, atAll: robot.atAll, atMobiles: robot.atMobiles });
      return "success";
    } catch {
      return "failed";
    }
  }

  async function executeRun(runId) {
    const claim = db.claimRun(runId);
    if (!claim.claimed) return db.getRun(runId);
    let run = claim.run;
    const task = db.getTask(run.taskId);
    const inventoryTask = task.taskType === "inventory_export";
    const executionStarted = now();
    let stage = inventoryTask ? "prepare_inventory_snapshot" : "calculate_date_range";
    let retryCount = 0;
    let temporaryFile = null;
    let pendingFinalFile = null;
    let actorIdentifier = null;
    try {
      const range = await runStep(runId, stage, async () => inventoryTask
        ? { startDate: null, endDate: null, snapshotAt: executionStarted.toISOString() }
        : paymentDateRange(task.paymentDateMode, task.paymentDateConfig, executionStarted, task.timezone));
      if (!inventoryTask) db.updateRun(runId, { paymentStartDate: range.startDate, paymentEndDate: range.endDate });

      stage = "load_credentials";
      const account = await runStep(runId, stage, async () => {
        const profile = db.getAccountProfile(task.accountProfileId, { includeSecret: true });
        if (!profile?.enabled) throw new Error("马帮账号配置不存在或已停用。");
        return { username: profile.username, password: decryptSecret(profile.encryptedPassword) };
      });
      actorIdentifier = account.username;

      stage = "mabang_login";
      db.addRunEvent({ runId, stage, status: "running", startedAt: now(), message: `登录由现有马帮${inventoryTask ? "库存" : "订单"}采集器执行。` });
      stage = inventoryTask ? "fetch_inventory" : "fetch_orders";
      const collected = await withRetry(runId, stage, () => runWorker(inventoryTask ? {
        action: "inventory",
        username: account.username,
        password: account.password,
      } : {
        action: "orders",
        username: account.username,
        password: account.password,
        startDate: range.startDate,
        endDate: range.endDate,
        orderFilters: { mode: "all", conditions: filtersForWorker(task.filters) },
      }));
      retryCount = collected.retries;
      db.addRunEvent({ runId, stage: "mabang_login", status: "success", startedAt: executionStarted, finishedAt: now(), durationMs: now() - executionStarted, message: `马帮登录及${inventoryTask ? "库存" : "订单"}读取成功。` });
      const result = collected.value;
      if (!inventoryTask) db.cacheFilterOptions(task.accountProfileId, result.records);

      stage = inventoryTask ? "prepare_inventory_rows" : "apply_filters";
      await runStep(runId, stage, async () => result.records, {
        message: inventoryTask ? "已获取当前账号可见的完整库存快照。" : `已应用 ${task.filters.length} 项任务筛选条件。`,
      });
      const rawOrderCount = inventoryTask
        ? Number(result.summary?.reportedRows ?? result.records?.length ?? 0)
        : Number(result.summary?.collectedOrders ?? result.summary?.orders ?? 0);
      const filteredOrderCount = inventoryTask ? Number(result.records?.length || 0) : Number(result.summary?.orders ?? 0);
      const detailRowCount = Number(result.records?.length || 0);
      db.updateRun(runId, { rawOrderCount, filteredOrderCount, detailRowCount, retryCount });

      stage = "generate_excel";
      const filename = scheduledExportFilename(task.name, range.startDate, range.endDate, executionStarted, task.timezone, task.taskType);
      const localTimestamp = timestampParts(executionStarted, task.timezone);
      const monthFolder = inventoryTask ? `${localTimestamp.slice(0, 4)}-${localTimestamp.slice(4, 6)}` : range.endDate.slice(0, 7);
      const storageFilename = sanitizeFilename(`${runId}-${randomUUID()}-${filename}`, { fallback: `${runId}.xlsx` });
      const relativePath = `${task.id}/${monthFolder}/${storageFilename}`;
      temporaryFile = await createTemporaryFilePath(tempRoot, { prefix: `mabang-${runId}`, extension: ".xlsx" });
      const writeResult = await runStep(runId, stage, () => runWorker({
        action: "write-xlsx", outputPath: temporaryFile.path, kind: inventoryTask ? "inventory" : "orders", columns: result.columns, records: result.records,
        metadataSheetName: "任务信息",
        summary: inventoryTask ? {
          ...result.summary,
          taskName: task.name, scheduledRunAt: run.scheduledRunAt, actualRunAt: executionStarted.toISOString(),
          sourceRows: rawOrderCount, exportedRows: detailRowCount, accountUsername: account.username,
        } : {
          taskName: task.name, scheduledRunAt: run.scheduledRunAt, actualRunAt: executionStarted.toISOString(),
          startDate: range.startDate, endDate: range.endDate, orderFilterDescription: result.summary?.orderFilterDescription || "无",
          collectedOrders: rawOrderCount, orders: filteredOrderCount, rows: detailRowCount, accountUsername: account.username,
        },
      }), { message: filename });
      for (const item of normalizedSanitizationCounts(writeResult.sanitizedCells)) {
        console.info(`Excel cell sanitization: runId=${runId} sheet=${item.sheet} count=${item.count}`);
      }

      stage = "save_file";
      const fileRecord = await runStep(runId, stage, async () => {
        pendingFinalFile = await atomicMoveFile({
          sourceRoot: tempRoot,
          sourcePath: temporaryFile.path,
          destinationRoot: exportRoot,
          destinationRelativePath: relativePath,
        });
        temporaryFile = null;
        const content = await fs.readFile(pendingFinalFile.path);
        const created = db.createExportFile({
          taskId: task.id, runId, originalFilename: filename, storageFilename, relativePath,
          fileSize: content.length, fileHash: hashFileBuffer(content),
          expiresAt: retentionExpiresAt(task.fileRetentionDays, executionStarted),
        });
        pendingFinalFile = null;
        return created;
      });
      db.updateRun(runId, { exportFileId: fileRecord.id });

      stage = "send_dingtalk";
      let notificationStatus = "disabled";
      let notificationError = null;
      try {
        const robot = await loadRobot(task);
        const shouldNotifyEmpty = detailRowCount > 0 || robot?.notifyOnEmpty;
        if (robot && robot.notifyOnSuccess && shouldNotifyEmpty) {
          const refreshedRun = db.getRun(runId);
          const baseUrl = canExposeDownloadLink(process.env.APP_BASE_URL) ? String(process.env.APP_BASE_URL).replace(/\/$/, "") : "";
          const notification = buildSuccessNotification({
            task, run: refreshedRun, filename, durationText: durationText(now() - executionStarted),
            dataSummary: result.summary || {},
            downloadUrl: baseUrl ? `${baseUrl}/api/mabang/export-files/${fileRecord.id}/download` : "",
          });
          const sent = await withRetry(runId, stage, () => notify({
            ...notification, webhookUrl: robot.webhookUrl, secret: robot.secret, atAll: robot.atAll, atMobiles: robot.atMobiles,
          }));
          retryCount += sent.retries;
          notificationStatus = "success";
        } else if (robot && detailRowCount === 0 && !robot.notifyOnEmpty) {
          notificationStatus = "skipped_empty";
        }
      } catch (error) {
        notificationStatus = "failed";
        notificationError = error;
      }

      const status = notificationError ? "partial_success" : "success";
      const finishedAt = now();
      run = db.updateRun(runId, {
        status, finishedAt: finishedAt.toISOString(), notificationStatus, retryCount,
        errorStage: notificationError ? "send_dingtalk" : null,
        errorCode: notificationError ? errorCode(notificationError, "DINGTALK_FAILED") : null,
        errorMessage: notificationError ? notificationError.message : null,
        logSummary: { durationMs: finishedAt - executionStarted, filename, taskType: task.taskType },
      });
      db.addRunEvent({ runId, stage: "complete", status, startedAt: executionStarted, finishedAt, durationMs: finishedAt - executionStarted, message: status === "success" ? "任务执行完成。" : "Excel 已生成，钉钉通知失败。" });
      db.updateTaskScheduleState(task.id, { lastRunAt: finishedAt.toISOString(), lastRunStatus: status });
      audit?.recordSafely({
        module: "mabang",
        action: "mabang.task.execution.success",
        status: "success",
        durationMs: finishedAt - executionStarted,
        actorType: "scheduler",
        actorIdentifier,
        taskId: task.id,
        runId,
        fileId: fileRecord.id,
        metadata: { taskType: task.taskType, triggerType: run.triggerType, result: status },
      });
      if (notificationStatus === "success" || notificationStatus === "failed") {
        audit?.recordSafely({
          module: "mabang",
          action: notificationStatus === "success" ? "mabang.dingtalk.notify.success" : "mabang.dingtalk.notify.failed",
          status: notificationStatus === "success" ? "success" : "failed",
          actorType: "scheduler",
          actorIdentifier,
          taskId: task.id,
          runId,
          fileId: fileRecord.id,
          errorStage: notificationStatus === "failed" ? "send_dingtalk" : null,
          errorCode: notificationStatus === "failed" ? "DINGTALK_FAILED" : null,
          errorSummary: notificationError,
        });
      }
      return run;
    } catch (error) {
      if (temporaryFile?.path) await removeFileInsideRoot(tempRoot, temporaryFile.path);
      if (pendingFinalFile?.path) await removeFileInsideRoot(exportRoot, pendingFinalFile.path);
      retryCount = Number(error.retryCount || retryCount || 0);
      if (["fetch_orders", "fetch_inventory"].includes(stage) && /账号|密码|登录|验证/.test(error.message)) stage = "mabang_login";
      const notificationStatus = await sendFailure(task, db.getRun(runId), stage, error, retryCount);
      const finishedAt = now();
      run = db.updateRun(runId, {
        status: "failed", finishedAt: finishedAt.toISOString(), notificationStatus, retryCount,
        errorStage: stage, errorCode: errorCode(error), errorMessage: error.message,
        logSummary: { durationMs: finishedAt - executionStarted },
      });
      db.addRunEvent({ runId, stage: "complete", status: "failed", startedAt: executionStarted, finishedAt, durationMs: finishedAt - executionStarted, message: error.message, errorCode: errorCode(error) });
      db.updateTaskScheduleState(task.id, { lastRunAt: finishedAt.toISOString(), lastRunStatus: "failed" });
      audit?.recordSafely({
        module: "mabang",
        action: "mabang.task.execution.failed",
        status: "failed",
        durationMs: finishedAt - executionStarted,
        actorType: "scheduler",
        actorIdentifier,
        taskId: task.id,
        runId,
        errorStage: stage,
        errorCode: errorCode(error),
        errorSummary: error,
        metadata: { taskType: task.taskType, triggerType: run.triggerType },
      });
      if (notificationStatus === "success" || notificationStatus === "failed") {
        audit?.recordSafely({
          module: "mabang",
          action: notificationStatus === "success" ? "mabang.dingtalk.notify.success" : "mabang.dingtalk.notify.failed",
          status: notificationStatus === "success" ? "success" : "failed",
          actorType: "scheduler",
          actorIdentifier,
          taskId: task.id,
          runId,
          errorStage: notificationStatus === "failed" ? "send_dingtalk" : null,
          errorCode: notificationStatus === "failed" ? "DINGTALK_FAILED" : null,
        });
      }
      return run;
    }
  }

  return { executeRun };
}

export { sanitizeFilenamePart };
