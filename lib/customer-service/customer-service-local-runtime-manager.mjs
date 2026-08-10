import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isLoopbackBindHost } from "../app-access.mjs";

const ACTIVE_STATES = new Set([
  "STARTING",
  "WAITING_FOR_LOGIN",
  "MONITOR_STARTING",
  "MONITORING",
  "STOPPING",
]);

const CHILD_ENV_ALLOWLIST = Object.freeze([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "Path",
  "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

function runtimeError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requiredAccountId(value) {
  const accountId = String(value || "").trim();
  if (!accountId || accountId.length > 120) {
    throw runtimeError("CS_LOCAL_ACCOUNT_ID_INVALID", "Customer-service account ID is invalid");
  }
  return accountId;
}

function comparablePath(value) {
  const normalized = path.normalize(String(value || ""));
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isInside(root, target) {
  const relative = path.relative(comparablePath(root), comparablePath(target));
  if (!relative) return true;
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function normalizedNow(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function boundedMaxMonitors(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(12, Math.max(1, parsed)) : 4;
}

function copyAllowedEnvironment(env) {
  const result = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (env[key] !== undefined) result[key] = String(env[key]);
  }
  return result;
}

export function customerServiceLocalRuntimeChildEnvironment({
  env = process.env,
  accountId,
  workerId,
  databasePath,
  sessionPath,
  logDir,
  centralApiUrl,
  workerToken,
  loginTimeoutSeconds = 900,
} = {}) {
  return {
    ...copyAllowedEnvironment(env),
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    COMMERCE_OPS_API_URL: centralApiUrl,
    CUSTOMER_SERVICE_WORKER_TOKEN: String(workerToken || ""),
    LIAOLIAO_CENTRAL_ACCOUNT_ID: accountId,
    LIAOLIAO_WORKER_ID: workerId,
    LIAOLIAO_DATABASE_PATH: databasePath,
    LIAOLIAO_SESSION_PATH: sessionPath,
    LIAOLIAO_LOG_DIR: logDir,
    LIAOLIAO_BROWSER_CHANNEL: "chrome",
    LIAOLIAO_HEADLESS: "false",
    LIAOLIAO_LOGIN_TIMEOUT_SECONDS: String(Math.max(30, Math.ceil(Number(loginTimeoutSeconds) || 900))),
    LIAOLIAO_HUMAN_SEND_ENABLED: "false",
    LIAOLIAO_QUALITY_REVIEW_ENABLED: "false",
    LIAOLIAO_SKIP_ROOT_ENV: "true",
    LIAOLIAO_ACCOUNT: "",
    LIAOLIAO_PASSWORD: "",
    LIAOLIAO_LLM_API_KEY: "",
    LIAOLIAO_LLM_MODEL: "",
    LIAOLIAO_LLM_REVIEW_MODEL: "",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
    DEEPSEEK_MODEL: "",
  };
}

export function createCustomerServiceLocalRuntimeManager({
  integrationDir,
  storageRoot,
  pythonExecutable,
  centralApiUrl,
  workerToken,
  maxMonitors = 4,
  env = process.env,
  audit = null,
  spawnImpl = spawn,
  existsSyncImpl = existsSync,
  mkdirSyncImpl = mkdirSync,
  realpathSyncImpl = (value) => realpathSync.native(value),
  now = () => new Date(),
  loginTimeoutMs = 15 * 60_000,
  stopGraceMs = 2_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const resolvedIntegrationDir = path.resolve(String(integrationDir || ""));
  const resolvedStorageRoot = path.resolve(String(storageRoot || ""));
  const resolvedRuntimeRoot = path.join(
    resolvedStorageRoot,
    "integrations",
    "liaoliao-ai-assistant",
    "accounts",
  );
  const resolvedPython = String(pythonExecutable || "").trim();
  const resolvedWorkerToken = String(workerToken || "").trim();
  const monitorLimit = boundedMaxMonitors(maxMonitors);
  const records = new Map();
  let activeLogin = null;
  let shuttingDown = false;

  let normalizedCentralApiUrl = "";
  try {
    const parsed = new URL(String(centralApiUrl || ""));
    if (parsed.protocol !== "http:" || !isLoopbackBindHost(parsed.hostname) || parsed.username || parsed.password) {
      throw new Error("Central API URL must be an unauthenticated loopback HTTP URL");
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    normalizedCentralApiUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    throw new TypeError("Customer-service local runtime requires a loopback central API URL");
  }

  function accountPaths(accountId, { create = false } = {}) {
    const digest = createHash("sha256").update(accountId, "utf8").digest("hex");
    const runtimeDir = path.join(resolvedRuntimeRoot, digest);
    const paths = {
      runtimeDir,
      databasePath: path.join(runtimeDir, "data", "liaoliao.db"),
      sessionPath: path.join(runtimeDir, "browser", "storage-state.json"),
      logDir: path.join(runtimeDir, "logs"),
      workerId: `cs-local-${digest.slice(0, 24)}`,
    };
    if (!create) return paths;

    mkdirSyncImpl(path.dirname(paths.databasePath), { recursive: true });
    mkdirSyncImpl(path.dirname(paths.sessionPath), { recursive: true });
    mkdirSyncImpl(paths.logDir, { recursive: true });
    const realStorageRoot = realpathSyncImpl(resolvedStorageRoot);
    const realRuntimeDir = realpathSyncImpl(runtimeDir);
    if (!isInside(realStorageRoot, realRuntimeDir)) {
      throw runtimeError(
        "CS_LOCAL_RUNTIME_PATH_REJECTED",
        "Customer-service local runtime path is outside the configured storage root",
        500,
      );
    }
    return paths;
  }

  function configurationError() {
    if (!resolvedPython) {
      return { code: "CS_LOCAL_RUNTIME_PYTHON_UNAVAILABLE", message: "LiaoLiao Python runtime is unavailable" };
    }
    if ((path.isAbsolute(resolvedPython) || resolvedPython.includes(path.sep)) && !existsSyncImpl(resolvedPython)) {
      return { code: "CS_LOCAL_RUNTIME_PYTHON_UNAVAILABLE", message: "LiaoLiao Python runtime is unavailable" };
    }
    if (!existsSyncImpl(path.join(resolvedIntegrationDir, "app", "cli.py"))) {
      return { code: "CS_LOCAL_RUNTIME_INTEGRATION_UNAVAILABLE", message: "LiaoLiao integration is unavailable" };
    }
    if (!resolvedWorkerToken) {
      return {
        code: "CS_LOCAL_RUNTIME_WORKER_AUTH_NOT_CONFIGURED",
        message: "Customer-service worker authentication is not configured",
      };
    }
    if (shuttingDown) {
      return { code: "CS_LOCAL_RUNTIME_SHUTTING_DOWN", message: "Customer-service local runtime is shutting down" };
    }
    return null;
  }

  function recordAudit(action, record, { failed = false, errorCode = null, errorSummary = null } = {}) {
    if (!audit || typeof audit.recordSafely !== "function") return;
    const result = audit.recordSafely({
      requestId: record.requestId || undefined,
      module: "customer_service",
      action,
      status: failed ? "failed" : "success",
      errorStage: failed ? "local_runtime" : null,
      errorCode,
      errorSummary,
      metadata: { accountId: record.accountId, mode: record.state },
    });
    if (result && typeof result.catch === "function") result.catch(() => {});
  }

  function setUpdated(record) {
    record.updatedAt = normalizedNow(now);
  }

  function clearLoginTimer(record) {
    if (record.loginTimer) clearTimer(record.loginTimer);
    record.loginTimer = null;
  }

  function releaseLogin(record, child) {
    if (activeLogin?.accountId === record.accountId
      && activeLogin?.generation === record.generation
      && (!child || activeLogin.child === child)) {
      activeLogin = null;
    }
  }

  function fail(record, code, summary) {
    clearLoginTimer(record);
    record.child = null;
    record.phase = null;
    record.stopReason = null;
    record.state = "FAILED";
    record.lastError = { code, retryable: true, at: normalizedNow(now) };
    setUpdated(record);
    recordAudit("customer_service.local_runtime.failed", record, {
      failed: true,
      errorCode: code,
      errorSummary: summary,
    });
  }

  function exposedStatus(accountId) {
    const configError = configurationError();
    const paths = accountPaths(accountId);
    const record = records.get(accountId);
    if (!record) {
      const state = configError ? "FAILED" : existsSyncImpl(paths.sessionPath) ? "SESSION_READY" : "IDLE";
      const sessionReady = existsSyncImpl(paths.sessionPath);
      return Object.freeze({
        accountId,
        available: !configError,
        state,
        status: state,
        workerId: paths.workerId,
        attempt: 0,
        startedAt: null,
        updatedAt: null,
        sessionReady,
        monitoring: false,
        workerOnline: false,
        leaseActive: false,
        canStop: false,
        canRetry: false,
        retryable: false,
        errorCode: configError?.code || null,
        errorMessage: null,
        message: null,
        pollAfterMs: null,
        lastError: configError ? {
          code: configError.code,
          retryable: false,
          at: null,
        } : null,
      });
    }
    return Object.freeze({
      accountId,
      available: !configError,
      state: record.state,
      status: record.state,
      workerId: paths.workerId,
      attempt: record.attempt,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      sessionReady: Boolean(record.sessionReady),
      monitoring: record.state === "MONITORING",
      workerOnline: false,
      leaseActive: false,
      canStop: ACTIVE_STATES.has(record.state) && record.state !== "STOPPING",
      canRetry: record.state === "FAILED" || record.state === "STOPPED",
      retryable: record.state === "FAILED" || record.state === "STOPPED",
      errorCode: record.lastError?.code || null,
      errorMessage: null,
      message: null,
      pollAfterMs: ACTIVE_STATES.has(record.state) ? 1_200 : null,
      lastError: record.lastError ? Object.freeze({ ...record.lastError }) : null,
    });
  }

  function activeMonitorCount() {
    return [...records.values()].filter((record) => (
      record.phase === "assist" && record.child && ACTIVE_STATES.has(record.state)
    )).length;
  }

  function spawnCommand(record, command, paths) {
    if (command === "assist" && activeMonitorCount() >= monitorLimit) {
      fail(
        record,
        "CS_LOCAL_MONITOR_CAPACITY_REACHED",
        "Customer-service local monitor capacity was reached",
      );
      return false;
    }

    record.phase = command;
    record.state = command === "login" ? "STARTING" : "MONITOR_STARTING";
    setUpdated(record);
    const childEnv = customerServiceLocalRuntimeChildEnvironment({
      env,
      accountId: record.accountId,
      workerId: paths.workerId,
      databasePath: paths.databasePath,
      sessionPath: paths.sessionPath,
      logDir: paths.logDir,
      centralApiUrl: normalizedCentralApiUrl,
      workerToken: resolvedWorkerToken,
      loginTimeoutSeconds: Math.ceil(Math.max(30_000, Number(loginTimeoutMs) || 15 * 60_000) / 1_000),
    });

    let child;
    try {
      child = spawnImpl(resolvedPython, ["-m", "app.cli", command], {
        cwd: resolvedIntegrationDir,
        env: childEnv,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
        detached: false,
      });
    } catch {
      fail(
        record,
        command === "login" ? "CS_LOCAL_LOGIN_START_FAILED" : "CS_LOCAL_MONITOR_START_FAILED",
        command === "login" ? "LiaoLiao login process failed to start" : "LiaoLiao monitor process failed to start",
      );
      return false;
    }

    const generation = record.generation;
    let settled = false;
    record.child = child;
    record.state = command === "login" ? "WAITING_FOR_LOGIN" : "MONITORING";
    setUpdated(record);
    if (command === "login") {
      activeLogin = { accountId: record.accountId, generation, child };
      record.loginTimer = setTimer(() => {
        void stopOwnedChild(record, {
          child,
          generation,
          reason: "timeout",
          finalState: "FAILED",
          errorCode: "CS_LOCAL_LOGIN_TIMEOUT",
        });
      }, Math.max(1_000, Number(loginTimeoutMs) || 15 * 60_000));
      record.loginTimer.unref?.();
    } else {
      recordAudit("customer_service.local_runtime.monitor_started", record);
    }

    const complete = (kind, value) => {
      if (settled) return;
      settled = true;
      if (records.get(record.accountId) !== record
        || record.generation !== generation
        || record.child !== child) return;
      const phase = record.phase;
      const stopReason = record.stopReason;
      clearLoginTimer(record);
      releaseLogin(record, child);
      record.child = null;
      record.phase = null;

      if (stopReason) {
        if (stopReason === "timeout") {
          fail(record, "CS_LOCAL_LOGIN_TIMEOUT", "LiaoLiao login timed out");
        } else {
          record.state = "STOPPED";
          record.stopReason = null;
          record.lastError = null;
          record.sessionReady = existsSyncImpl(paths.sessionPath);
          setUpdated(record);
          recordAudit("customer_service.local_runtime.stopped", record);
        }
        return;
      }

      if (kind === "error") {
        fail(
          record,
          phase === "login" ? "CS_LOCAL_LOGIN_PROCESS_ERROR" : "CS_LOCAL_MONITOR_PROCESS_ERROR",
          phase === "login" ? "LiaoLiao login process failed" : "LiaoLiao monitor process failed",
        );
        return;
      }

      const exitCode = Number.isInteger(value) ? value : null;
      if (phase === "login") {
        if (exitCode !== 0) {
          fail(record, "CS_LOCAL_LOGIN_EXITED", "LiaoLiao login process exited before login completed");
          return;
        }
        if (!existsSyncImpl(paths.sessionPath)) {
          fail(record, "CS_LOCAL_SESSION_MISSING", "LiaoLiao login completed without a local Session");
          return;
        }
        record.sessionReady = true;
        record.state = "SESSION_READY";
        record.lastError = null;
        setUpdated(record);
        recordAudit("customer_service.local_runtime.login_succeeded", record);
        spawnCommand(record, "assist", paths);
        return;
      }

      record.sessionReady = existsSyncImpl(paths.sessionPath);
      if (exitCode === 0) {
        record.state = "STOPPED";
        record.lastError = null;
        setUpdated(record);
        recordAudit("customer_service.local_runtime.stopped", record);
      } else {
        fail(record, "CS_LOCAL_MONITOR_EXITED", "LiaoLiao monitor process exited unexpectedly");
      }
    };

    child.once?.("error", () => complete("error", null));
    child.once?.("exit", (code) => complete("exit", code));
    return true;
  }

  async function waitForExit(child, timeoutMs) {
    if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimer(timer);
        resolve();
      };
      const timer = setTimer(done, Math.max(1, timeoutMs));
      timer.unref?.();
      child.once?.("exit", done);
      child.once?.("error", done);
    });
  }

  async function stopOwnedChild(record, {
    child = record.child,
    generation = record.generation,
    reason = "user",
    finalState = "STOPPED",
    errorCode = null,
  } = {}) {
    if (!child || records.get(record.accountId) !== record || record.generation !== generation) return;
    clearLoginTimer(record);
    record.stopReason = reason;
    record.state = "STOPPING";
    setUpdated(record);
    try { child.kill?.("SIGTERM"); } catch { /* bounded owned-child stop */ }
    await waitForExit(child, stopGraceMs);
    if (record.child === child && child.exitCode == null) {
      try { child.kill?.("SIGKILL"); } catch { /* bounded owned-child force stop */ }
      await waitForExit(child, Math.min(250, stopGraceMs));
    }
    if (records.get(record.accountId) !== record || record.generation !== generation || record.child !== child) return;
    releaseLogin(record, child);
    record.child = null;
    record.phase = null;
    record.stopReason = null;
    record.sessionReady = existsSyncImpl(accountPaths(record.accountId).sessionPath);
    if (finalState === "FAILED") {
      fail(record, errorCode || "CS_LOCAL_RUNTIME_STOPPED", "LiaoLiao local runtime stopped unexpectedly");
    } else {
      record.state = "STOPPED";
      record.lastError = null;
      setUpdated(record);
      recordAudit("customer_service.local_runtime.stopped", record);
    }
  }

  function beginLogin(accountId, requestId, { retry = false } = {}) {
    const normalizedAccountId = requiredAccountId(accountId);
    const configError = configurationError();
    if (configError) throw runtimeError(configError.code, configError.message, 503);

    const current = records.get(normalizedAccountId);
    if (current && ACTIVE_STATES.has(current.state)) {
      return { started: false, runtime: exposedStatus(normalizedAccountId) };
    }
    if (!retry && current?.state === "FAILED") {
      throw runtimeError("CS_LOCAL_RETRY_REQUIRED", "Retry is required after a failed local login", 409);
    }
    if (retry && !current) {
      throw runtimeError("CS_LOCAL_RETRY_NOT_ALLOWED", "Local login has not failed or stopped", 409);
    }
    if (retry && current && current.state !== "FAILED" && current.state !== "STOPPED") {
      throw runtimeError("CS_LOCAL_RETRY_NOT_ALLOWED", "Local login is not ready to retry", 409);
    }
    const paths = accountPaths(normalizedAccountId, { create: true });
    const initialCommand = retry || !existsSyncImpl(paths.sessionPath) ? "login" : "assist";
    if (initialCommand === "login" && activeLogin && activeLogin.accountId !== normalizedAccountId) {
      throw runtimeError(
        "CS_LOCAL_LOGIN_BUSY",
        "Another LiaoLiao login window is already open on this computer; retry after it finishes",
        409,
      );
    }

    const timestamp = normalizedNow(now);
    const record = current || {
      accountId: normalizedAccountId,
      attempt: 0,
      generation: 0,
      state: "IDLE",
      child: null,
      phase: null,
      stopReason: null,
      loginTimer: null,
      startedAt: null,
      updatedAt: null,
      sessionReady: false,
      lastError: null,
      requestId: null,
    };
    record.attempt += 1;
    record.generation += 1;
    record.startedAt = timestamp;
    record.updatedAt = timestamp;
    record.state = "STARTING";
    record.sessionReady = existsSyncImpl(paths.sessionPath);
    record.lastError = null;
    record.stopReason = null;
    record.requestId = String(requestId || "").trim() || null;
    records.set(normalizedAccountId, record);

    if (!spawnCommand(record, initialCommand, paths)) {
      const code = record.lastError?.code
        || (initialCommand === "login" ? "CS_LOCAL_LOGIN_START_FAILED" : "CS_LOCAL_MONITOR_START_FAILED");
      throw runtimeError(
        code,
        initialCommand === "login"
          ? "LiaoLiao login process failed to start"
          : "LiaoLiao monitor process failed to start",
        code === "CS_LOCAL_MONITOR_CAPACITY_REACHED" ? 409 : 503,
      );
    }
    return { started: true, runtime: exposedStatus(normalizedAccountId) };
  }

  return Object.freeze({
    maxMonitors: monitorLimit,
    status(accountId) {
      return exposedStatus(requiredAccountId(accountId));
    },
    async start(accountId, { requestId = null } = {}) {
      return beginLogin(accountId, requestId);
    },
    async retry(accountId, { requestId = null } = {}) {
      return beginLogin(accountId, requestId, { retry: true });
    },
    async stop(accountId) {
      const normalizedAccountId = requiredAccountId(accountId);
      const record = records.get(normalizedAccountId);
      if (!record) return { stopped: false, runtime: exposedStatus(normalizedAccountId) };
      if (!record.child) {
        record.state = "STOPPED";
        record.lastError = null;
        record.sessionReady = existsSyncImpl(accountPaths(normalizedAccountId).sessionPath);
        setUpdated(record);
        return { stopped: false, runtime: exposedStatus(normalizedAccountId) };
      }
      await stopOwnedChild(record, { reason: "user", finalState: "STOPPED" });
      return { stopped: true, runtime: exposedStatus(normalizedAccountId) };
    },
    async stopAll() {
      shuttingDown = true;
      const active = [...records.values()].filter((record) => record.child);
      await Promise.all(active.map((record) => stopOwnedChild(record, {
        reason: "shutdown",
        finalState: "STOPPED",
      })));
      return active.length;
    },
  });
}
