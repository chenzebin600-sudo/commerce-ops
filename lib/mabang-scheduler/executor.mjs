import path from "node:path";
import { randomUUID } from "node:crypto";
import { decryptSecret } from "./crypto.mjs";
import { filtersForWorker } from "./fields.mjs";
import { paymentDateRange, retentionExpiresAt } from "./schedule.mjs";
import { buildFailureNotification, buildSuccessNotification, canExposeDownloadLink, sendDingtalkMessage } from "./dingtalk.mjs";
import {
  createTemporaryFilePath,
  removeFileInsideRoot,
  sanitizeFilename,
} from "../security/file-policy.mjs";
import { normalizedSanitizationCounts } from "../security/excel-cell-policy.mjs";
import { createExportFileService } from "../files/export-file-service.mjs";

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

export function createTaskExecutor({
  db,
  runWorker,
  exportRoot,
  tempRoot = path.join(exportRoot, ".temp"),
  notify = sendDingtalkMessage,
  retryDelays = retryDelaysFromEnv(),
  now = () => new Date(),
  audit = null,
  fileService = null,
  persistCollectedData = null,
  generateDailyReport = null,
}) {
  const exportFiles = fileService || createExportFileService({ db, exportRoot, tempRoot, audit });
  async function runStep(runId, stage, callback, { attempt = 1, message = "" } = {}) {
    const startedAt = now();
    await db.addRunEvent({ runId, stage, status: "running", attempt, startedAt, message });
    try {
      const result = await callback();
      const finishedAt = now();
      await db.addRunEvent({ runId, stage, status: "success", attempt, startedAt, finishedAt, durationMs: finishedAt - startedAt, message });
      return result;
    } catch (error) {
      const finishedAt = now();
      await db.addRunEvent({ runId, stage, status: "failed", attempt, startedAt, finishedAt, durationMs: finishedAt - startedAt, message: error.message, errorCode: errorCode(error) });
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
        await db.addRunEvent({ runId, stage, status: "retrying", attempt, startedAt: now(), message: `将在 ${waitMs}ms 后进行第 ${retries} 次重试。` });
        await db.updateRun(runId, { retryCount: retries });
        await delay(waitMs);
      }
    }
  }

  async function loadRobot(task) {
    if (!task.notifyEnabled || !task.dingtalkConfigId) return null;
    const robot = await db.getDingtalkConfig(task.dingtalkConfigId, { includeSecret: true });
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
    const claim = await db.claimRun(runId);
    if (!claim.claimed) {
      const rejectedRun = claim.run || await db.getRun(runId);
      if (claim.reason === "task_deleted" && rejectedRun) {
        const rejectedTask = await db.getTask(rejectedRun.taskId);
        audit?.recordSafely({
          module: "mabang",
          action: rejectedRun.triggerType === "scheduled"
            ? "mabang.task.deleted_scheduler_skipped"
            : "mabang.task.deleted_execution_rejected",
          status: "failed",
          actorType: "scheduler",
          actorIdentifier: rejectedTask?.accountUsernameMasked,
          taskId: rejectedRun.taskId,
          runId,
          errorStage: "task_state",
          errorCode: "TASK_DELETED",
          errorSummary: rejectedRun.errorMessage,
          metadata: { taskType: rejectedTask?.taskType, triggerType: rejectedRun.triggerType },
        });
      }
      return rejectedRun;
    }
    let run = claim.run;
    const task = await db.getTask(run.taskId);
    const inventoryTask = task.taskType === "inventory_export";
    const reportTask = task.taskType === "daily_report";
    const executionOptions = !inventoryTask && !reportTask ? run.logSummary?.executionOptions || null : null;
    const effectivePaymentDateMode = executionOptions?.paymentDateMode || task.paymentDateMode;
    const effectivePaymentDateConfig = executionOptions?.paymentDateConfig || task.paymentDateConfig;
    const effectiveFilters = executionOptions?.filters || task.filters;
    const executionStarted = now();
    let stage = reportTask ? "generate_daily_report" : inventoryTask ? "prepare_inventory_snapshot" : "calculate_date_range";
    let retryCount = 0;
    let temporaryFile = null;
    let actorIdentifier = null;
    let dataPersistence = null;
    try {
      if (reportTask) {
        if (typeof generateDailyReport !== "function") {
          const error = new Error("经营日报生成器尚未配置。");
          error.code = "DAILY_REPORT_NOT_CONFIGURED";
          throw error;
        }
        actorIdentifier = "sales_assortment_daily_report";
        const report = await runStep(runId, stage, () => generateDailyReport({ task, run, generatedAt: executionStarted }));
        const itemCount = Number(report.itemCount || 0);
        await db.updateRun(runId, {
          rawOrderCount: Number(report.orderCount || 0),
          filteredOrderCount: Number(report.orderCount || 0),
          detailRowCount: itemCount,
        });
        stage = "send_dingtalk";
        const robot = await loadRobot(task);
        if (!robot) {
          const error = new Error("经营日报任务必须配置并启用钉钉机器人。");
          error.code = "DINGTALK_NOT_CONFIGURED";
          throw error;
        }
        await runStep(runId, stage, () => notify({
          title: report.title || "销售与货盘经营日报",
          markdown: report.markdown,
          webhookUrl: robot.webhookUrl,
          secret: robot.secret,
          atAll: robot.atAll,
          atMobiles: robot.atMobiles,
        }));
        const finishedAt = now();
        run = await db.updateRun(runId, {
          status: "success",
          finishedAt: finishedAt.toISOString(),
          notificationStatus: "success",
          detailRowCount: itemCount,
          logSummary: {
            durationMs: finishedAt - executionStarted,
            taskType: task.taskType,
            reportVersion: report.version || null,
            aiIncluded: Boolean(report.aiIncluded),
          },
        });
        await db.addRunEvent({ runId, stage: "complete", status: "success", startedAt: executionStarted, finishedAt, durationMs: finishedAt - executionStarted, message: "经营日报已生成并推送钉钉。" });
        await db.updateTaskScheduleState(task.id, { lastRunAt: finishedAt.toISOString(), lastRunStatus: "success" });
        audit?.recordSafely({
          module: "sales_assortment",
          action: "sales_assortment.daily_report.sent",
          status: "success",
          durationMs: finishedAt - executionStarted,
          actorType: "scheduler",
          actorIdentifier,
          taskId: task.id,
          runId,
          metadata: { itemCount, aiIncluded: Boolean(report.aiIncluded), reportVersion: report.version || null },
        });
        return run;
      }
      const range = await runStep(runId, stage, async () => inventoryTask
        ? { startDate: null, endDate: null, snapshotAt: executionStarted.toISOString() }
        : paymentDateRange(effectivePaymentDateMode, effectivePaymentDateConfig, executionStarted, task.timezone));
      if (!inventoryTask) await db.updateRun(runId, { paymentStartDate: range.startDate, paymentEndDate: range.endDate });

      stage = "load_credentials";
      const account = await runStep(runId, stage, async () => {
        const profile = await db.getAccountProfile(task.accountProfileId, { includeSecret: true });
        if (!profile?.enabled) throw new Error("马帮账号配置不存在或已停用。");
        return { username: profile.username, password: decryptSecret(profile.encryptedPassword) };
      });
      actorIdentifier = account.username;

      stage = "mabang_login";
      await db.addRunEvent({ runId, stage, status: "running", startedAt: now(), message: `登录由现有马帮${inventoryTask ? "库存" : "订单"}采集器执行。` });
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
        orderFilters: { mode: "all", conditions: filtersForWorker(effectiveFilters) },
      }));
      retryCount = collected.retries;
      await db.addRunEvent({ runId, stage: "mabang_login", status: "success", startedAt: executionStarted, finishedAt: now(), durationMs: now() - executionStarted, message: `马帮登录及${inventoryTask ? "库存" : "订单"}读取成功。` });
      const result = collected.value;
      if (!inventoryTask) await db.cacheFilterOptions(task.accountProfileId, result.records);

      stage = inventoryTask ? "prepare_inventory_rows" : "apply_filters";
      await runStep(runId, stage, async () => result.records, {
        message: inventoryTask ? "已获取当前账号可见的完整库存快照。" : `已应用 ${effectiveFilters.length} 项任务筛选条件。`,
      });
      const rawOrderCount = inventoryTask
        ? Number(result.summary?.reportedRows ?? result.records?.length ?? 0)
        : Number(result.summary?.collectedOrders ?? result.summary?.orders ?? 0);
      const filteredOrderCount = inventoryTask ? Number(result.records?.length || 0) : Number(result.summary?.orders ?? 0);
      const detailRowCount = Number(result.records?.length || 0);
      await db.updateRun(runId, { rawOrderCount, filteredOrderCount, detailRowCount, retryCount });

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
        const { file } = await exportFiles.persistTemporaryExport({
          temporaryPath: temporaryFile.path,
          sourceType: inventoryTask ? "mabang_scheduled_inventory" : "mabang_scheduled_order",
          taskId: task.id,
          runId,
          originalFilename: filename,
          storageFilename,
          relativePath,
          expiresAt: retentionExpiresAt(task.fileRetentionDays, executionStarted),
          metadata: {
            taskType: task.taskType,
            sourceRows: rawOrderCount,
            exportedRows: detailRowCount,
            generatedBy: "scheduler",
          },
        });
        temporaryFile = null;
        return file;
      });
      await db.updateRun(runId, { exportFileId: fileRecord.id });

      stage = "persist_collected_data";
      dataPersistence = await runStep(runId, stage, async () => {
        if (detailRowCount === 0) {
          return {
            status: "empty",
            batchId: null,
            rowCount: 0,
          };
        }
        if (typeof persistCollectedData !== "function") {
          return {
            status: "not_configured",
            batchId: null,
            rowCount: 0,
          };
        }
        const verified = await exportFiles.verifyAvailableFile(fileRecord.id);
        return persistCollectedData({
          kind: inventoryTask ? "inventory" : "orders",
          filename: verified.target.path,
          sourceFilename: filename,
          sourceSha256: fileRecord.fileHash,
          sourceFileId: fileRecord.id,
          sourceAccountId: task.accountProfileId,
          columns: result.columns,
          records: result.records,
          sourceScope: inventoryTask
            ? {
                queryType: "scheduled_export",
                taskId: task.id,
                runId,
                snapshotAt: result.summary?.cacheUpdateTime || range.snapshotAt,
              }
            : {
                queryType: "scheduled_export",
                taskId: task.id,
                runId,
                dateFrom: range.startDate,
                dateTo: range.endDate,
              },
          collectedAt: executionStarted.toISOString(),
          actorLabel: "mabang_scheduler",
        });
      }, { message: `${inventoryTask ? "inventory" : "orders"}:${detailRowCount}` });

      stage = "send_dingtalk";
      let notificationStatus = "disabled";
      let notificationError = null;
      try {
        const robot = await loadRobot(task);
        const shouldNotifyEmpty = detailRowCount > 0 || robot?.notifyOnEmpty;
        if (robot && robot.notifyOnSuccess && shouldNotifyEmpty) {
          const refreshedRun = await db.getRun(runId);
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
      run = await db.updateRun(runId, {
        status, finishedAt: finishedAt.toISOString(), notificationStatus, retryCount,
        errorStage: notificationError ? "send_dingtalk" : null,
        errorCode: notificationError ? errorCode(notificationError, "DINGTALK_FAILED") : null,
        errorMessage: notificationError ? notificationError.message : null,
        logSummary: {
          durationMs: finishedAt - executionStarted,
          filename,
          taskType: task.taskType,
          dataPersistence,
          executionOptions,
        },
      });
      await db.addRunEvent({ runId, stage: "complete", status, startedAt: executionStarted, finishedAt, durationMs: finishedAt - executionStarted, message: status === "success" ? "任务执行完成。" : "Excel 已生成，钉钉通知失败。" });
      const deletedDuringExecution = Boolean((await db.getTask(task.id))?.deletedAt);
      if (deletedDuringExecution) {
        await db.addRunEvent({
          runId,
          stage: "task_state",
          status: "skipped",
          startedAt: finishedAt,
          finishedAt,
          durationMs: 0,
          message: "任务在本次执行期间被删除；当前执行已完成，后续调度保持取消。",
          errorCode: "TASK_DELETED_DURING_EXECUTION",
        });
      }
      await db.updateTaskScheduleState(task.id, { lastRunAt: finishedAt.toISOString(), lastRunStatus: status });
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
        metadata: {
          taskType: task.taskType,
          triggerType: run.triggerType,
          result: deletedDuringExecution ? `${status}_task_deleted` : status,
          persistenceStatus: dataPersistence?.status || null,
          sourceBatchId: dataPersistence?.batchId || null,
          persistedRows: dataPersistence?.rowCount || 0,
        },
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
      retryCount = Number(error.retryCount || retryCount || 0);
      if (["fetch_orders", "fetch_inventory"].includes(stage) && /账号|密码|登录|验证/.test(error.message)) stage = "mabang_login";
      const notificationStatus = await sendFailure(task, await db.getRun(runId), stage, error, retryCount);
      const finishedAt = now();
      run = await db.updateRun(runId, {
        status: "failed", finishedAt: finishedAt.toISOString(), notificationStatus, retryCount,
        errorStage: stage, errorCode: errorCode(error), errorMessage: error.message,
        logSummary: { durationMs: finishedAt - executionStarted, executionOptions },
      });
      await db.addRunEvent({ runId, stage: "complete", status: "failed", startedAt: executionStarted, finishedAt, durationMs: finishedAt - executionStarted, message: error.message, errorCode: errorCode(error) });
      const deletedDuringExecution = Boolean((await db.getTask(task.id))?.deletedAt);
      if (deletedDuringExecution) {
        await db.addRunEvent({
          runId,
          stage: "task_state",
          status: "skipped",
          startedAt: finishedAt,
          finishedAt,
          durationMs: 0,
          message: "任务在本次执行期间被删除；当前执行已结束，后续调度保持取消。",
          errorCode: "TASK_DELETED_DURING_EXECUTION",
        });
      }
      await db.updateTaskScheduleState(task.id, { lastRunAt: finishedAt.toISOString(), lastRunStatus: "failed" });
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
        metadata: { taskType: task.taskType, triggerType: run.triggerType, result: deletedDuringExecution ? "failed_task_deleted" : "failed" },
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
