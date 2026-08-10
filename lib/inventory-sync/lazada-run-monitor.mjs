import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const LAZADA_RUN_STATUS_FILE = "lazada-run-status.json";

const STAGE_LABELS = {
  INITIALIZING: "初始化",
  SERVICE_STARTING: "启动刊登服务",
  LOGGING_IN: "登录马帮",
  READING_SOURCE_INVENTORY: "读取来源库存",
  VALIDATING_MAPPINGS: "校验店铺与仓库",
  READING_LISTINGS: "读取 Lazada 在线商品",
  REFRESHING_SOURCE_INVENTORY: "执行前刷新来源库存",
  BUILDING_PLAN: "生成同步计划",
  EXECUTING: "写入并回读库存",
  NO_CHANGES: "无需变更",
  SUCCEEDED: "同步完成",
  PARTIAL: "部分完成",
  FAILED: "同步失败",
  STALLED: "任务无响应",
  UNKNOWN: "等待状态",
};

function iso() { return new Date().toISOString(); }
function statusPath(storageRoot) { return path.join(storageRoot, "inventory-sync", LAZADA_RUN_STATUS_FILE); }

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function readTail(file, maxBytes = 32_768) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8").trim();
  } catch { return ""; }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function inferLegacyStage(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1) || "";
  if (/同步完成/.test(last)) return { stage: "SUCCEEDED", message: last };
  if (/没有需要写入/.test(last)) return { stage: "NO_CHANGES", message: last };
  if (/第 \d+\/\d+ 批/.test(last) || /正在预检第/.test(last)) return { stage: "EXECUTING", message: last };
  if (/计划完成/.test(last)) return { stage: "BUILDING_PLAN", message: last };
  if (/重新读取一次来源库存/.test(last)) return { stage: "REFRESHING_SOURCE_INVENTORY", message: last };
  if (/在线商品/.test(last)) return { stage: "READING_LISTINGS", message: last };
  if (/正在读取 \d+ 家 Lazada/.test(last)) return { stage: "READING_SOURCE_INVENTORY", message: last };
  return { stage: "UNKNOWN", message: last || "任务已启动，等待首条进度。" };
}

function publicStatus(status) {
  return {
    ...status,
    stageLabel: STAGE_LABELS[status.stage] || status.stage || "未知阶段",
    terminal: ["SUCCEEDED", "PARTIAL", "FAILED", "NO_CHANGES"].includes(status.state),
  };
}

export function createLazadaRunStatusWriter({ storageRoot, pid = process.pid, mode = "execute", heartbeatMs = 15_000 }) {
  const file = statusPath(storageRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let status = {
    runId: randomUUID(), platform: "lazada", mode, pid, state: "RUNNING", stage: "INITIALIZING",
    message: "Lazada 库存同步正在初始化。", startedAt: iso(), updatedAt: iso(), heartbeatAt: iso(),
    finishedAt: null, reportPath: null, counts: {}, problem: null,
  };
  const persist = () => fs.writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  const update = (next = {}) => {
    status = {
      ...status, ...next,
      counts: { ...(status.counts || {}), ...(next.counts || {}) },
      updatedAt: iso(), heartbeatAt: iso(),
    };
    persist();
    return publicStatus(status);
  };
  persist();
  const heartbeat = setInterval(() => update(), heartbeatMs);
  const close = (next) => { clearInterval(heartbeat); return update({ ...next, finishedAt: iso() }); };
  return {
    get value() { return publicStatus(status); },
    update,
    succeed(next = {}) { return close({ state: "SUCCEEDED", stage: "SUCCEEDED", message: "Lazada 库存同步已完成。", problem: null, ...next }); },
    partial(error, next = {}) {
      return close({ state: "PARTIAL", stage: "PARTIAL", message: String(error?.message || "Lazada 库存同步部分完成。"), problem: { code: String(error?.code || "LAZADA_INVENTORY_PARTIAL_FAILURE"), message: String(error?.message || "部分商品同步失败。"), details: Array.isArray(error?.details) ? error.details.slice(0, 100) : [] }, ...next });
    },
    noChanges(next = {}) { return close({ state: "NO_CHANGES", stage: "NO_CHANGES", message: "在线库存已一致，没有需要写入的变更。", problem: null, ...next }); },
    fail(error, next = {}) {
      const details = Array.isArray(error?.details) ? error.details.slice(0, 100) : [];
      return close({
        state: "FAILED", stage: "FAILED", message: String(error?.message || error || "Lazada 库存同步失败。"),
        problem: { code: String(error?.code || "LAZADA_INVENTORY_SYNC_FAILED"), message: String(error?.message || error || "同步失败。"), details },
        ...next,
      });
    },
  };
}

let reportCache = null;
function latestReport(storageRoot) {
  try {
    const dir = path.join(storageRoot, "inventory-sync", "lazada-reports");
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
      const file = path.join(dir, name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    }).sort((left, right) => right.mtimeMs - left.mtimeMs);
    const latest = files[0];
    if (!latest) return null;
    if (reportCache?.file === latest.file && reportCache.mtimeMs === latest.mtimeMs) return reportCache.value;
    const report = safeReadJson(latest.file);
    if (!report) return null;
    const value = { file: latest.file, report };
    reportCache = { file: latest.file, mtimeMs: latest.mtimeMs, value };
    return value;
  } catch { return null; }
}

export function readLazadaRunStatus({ rootDir, storageRoot, staleAfterMs = 20 * 60_000 }) {
  const pidFile = path.join(rootDir, ".lazada-inventory-sync.execute.pid.json");
  const pidInfo = safeReadJson(pidFile) || {};
  const structured = safeReadJson(statusPath(storageRoot));
  const pid = Number(pidInfo.pid || structured?.pid || 0);
  const alive = processAlive(pid);
  if (structured && (!pidInfo.pid || Number(structured.pid) === Number(pidInfo.pid))) {
    const heartbeatAgeMs = Date.now() - new Date(structured.heartbeatAt || structured.updatedAt || 0).getTime();
    if (structured.state === "RUNNING" && !alive) {
      return publicStatus({ ...structured, state: "FAILED", stage: "FAILED", message: "同步进程已经退出，但没有写入完成状态。", problem: { code: "PROCESS_EXITED", message: "后台同步进程异常退出，请查看错误日志。", details: [] } });
    }
    if (structured.state === "RUNNING" && heartbeatAgeMs > staleAfterMs) {
      return publicStatus({ ...structured, state: "STALLED", stage: "STALLED", message: `超过 ${Math.round(heartbeatAgeMs / 60_000)} 分钟没有心跳。`, problem: { code: "HEARTBEAT_STALE", message: "同步进程长时间没有更新状态，可能卡在网络请求或马帮导出。", details: [] } });
    }
    return publicStatus({ ...structured, alive, heartbeatAgeMs: Math.max(0, heartbeatAgeMs) });
  }

  const stdoutPath = pidInfo.stdoutPath || path.join(rootDir, ".lazada-inventory-sync.execute.out.log");
  const stderrPath = pidInfo.stderrPath || path.join(rootDir, ".lazada-inventory-sync.execute.err.log");
  const stdout = readTail(stdoutPath);
  const stderr = readTail(stderrPath);
  const inferred = inferLegacyStage(stdout);
  const updatedMs = Math.max(mtime(stdoutPath), mtime(stderrPath), mtime(pidFile));
  const ageMs = updatedMs ? Date.now() - updatedMs : 0;
  const completedReport = !alive ? latestReport(storageRoot) : null;
  const reportPlan = completedReport?.report?.plan?.summary || {};
  const reportExecution = completedReport?.report?.execution || {};
  const reportFailureCount = Number(reportExecution.failureCount || reportExecution.failedProducts || 0);
  const reportSuccessCount = Number(reportExecution.successfulProducts || 0);
  const reportAllFailed = reportFailureCount > 0 && reportSuccessCount === 0;
  const reportPartial = reportFailureCount > 0 && reportSuccessCount > 0;
  const inferredTerminalSuccess = ["SUCCEEDED", "NO_CHANGES"].includes(inferred.stage) && !reportAllFailed && !reportPartial;
  const failed = Boolean(stderr) || reportAllFailed || (!alive && Boolean(pid) && !inferredTerminalSuccess && !reportPartial);
  const stalled = alive && ageMs > staleAfterMs;
  const state = failed ? "FAILED" : reportPartial ? "PARTIAL" : stalled ? "STALLED" : alive ? "RUNNING" : inferredTerminalSuccess ? inferred.stage : "IDLE";
  const reportFailureMessage = reportFailureCount ? `${reportFailureCount} 个商品同步失败，成功 ${reportSuccessCount} 个；首个原因：${reportExecution.failures?.[0]?.message || "未知错误"}` : "";
  const problem = failed
    ? { code: reportAllFailed ? "ALL_PRODUCTS_FAILED" : (stderr ? "PROCESS_ERROR" : "PROCESS_EXITED"), message: (reportFailureMessage || stderr.split(/\r?\n/).filter(Boolean).at(-1) || "后台同步进程已经退出。").slice(0, 1000), details: (reportExecution.failures || []).slice(0, 20) }
    : reportPartial ? { code: "PARTIAL_PRODUCT_FAILURE", message: reportFailureMessage, details: (reportExecution.failures || []).slice(0, 20) }
    : stalled ? { code: "PROGRESS_STALE", message: "日志长时间没有变化，可能仍在等待马帮库存导出；超过 20 分钟会标记为无响应。", details: [] } : null;
  return publicStatus({
    runId: pidInfo.startedAt || "legacy", platform: "lazada", mode: "execute", pid: pid || null, alive,
    state, stage: stalled ? "STALLED" : failed ? "FAILED" : inferred.stage,
    message: problem?.message || inferred.message || "当前没有 Lazada 后台库存同步任务。",
    startedAt: pidInfo.startedAt || null, updatedAt: updatedMs ? new Date(updatedMs).toISOString() : null,
    heartbeatAt: null, finishedAt: alive ? null : (updatedMs ? new Date(updatedMs).toISOString() : null),
    reportPath: completedReport?.file || null,
    counts: completedReport ? {
      shops: Number(reportPlan.shopCount || 0), listingsTotal: Number(reportPlan.listingCount || 0), variants: Number(reportPlan.variantCount || 0),
      ready: Number(reportPlan.readyCount || 0), unchanged: Number(reportPlan.unchangedCount || 0), blocked: Number(reportPlan.blockedCount || 0),
      batch: Number(reportExecution.plannedBatchCount || 0), batchCount: Number(reportExecution.plannedBatchCount || 0),
      successfulProducts: reportSuccessCount, failedProducts: reportFailureCount,
    } : {}, problem,
  });
}
