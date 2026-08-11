import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pythonRuntimeError, resolvePythonRuntime } from "./python-runtime.mjs";

const MABANG_PYTHON_MODULES = Object.freeze(["openpyxl", "pandas", "requests"]);
const SKU_DIAGNOSTIC_STAGES = new Set([
  "mabang_response", "mabang_request_uncertain", "readback", "service_precheck",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maxLength) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength) : "";
}

function boundedStringList(value, maxItems = 30) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").slice(0, maxItems).map((item) => boundedString(item, 80))
    : [];
}

export function normalizeMabangSkuDiagnostic(value) {
  if (!isRecord(value) || value.version !== 1) return null;
  const request = isRecord(value.request) ? value.request : {};
  const response = isRecord(value.response) ? value.response : {};
  const verification = isRecord(value.verification) ? value.verification : {};
  const httpStatus = Number.isInteger(response.httpStatus) && response.httpStatus >= 100 && response.httpStatus <= 599
    ? response.httpStatus
    : null;
  const bodyLength = Number.isInteger(response.bodyLength) && response.bodyLength >= 0
    ? Math.min(response.bodyLength, 10_000_000)
    : 0;
  const success = ["string", "number", "boolean"].includes(typeof response.success) || response.success === null
    ? response.success
    : null;
  const normalized = {
    version: 1,
    capturedAt: boundedString(value.capturedAt, 60),
    stage: SKU_DIAGNOSTIC_STAGES.has(value.stage) ? value.stage : "mabang_response",
    endpoint: "order.doChanegOrderItem",
    request: {
      fieldNames: ["orderItemId", "stockId", "type"],
      orderItemId: boundedString(request.orderItemId, 80),
      stockId: boundedString(request.stockId, 80),
      type: boundedString(request.type, 80),
    },
    response: {
      httpStatus,
      contentType: boundedString(response.contentType, 80),
      success,
      code: boundedString(response.code, 80),
      message: boundedString(response.message, 300),
      fieldNames: boundedStringList(response.fieldNames),
      bodyKind: boundedString(response.bodyKind, 30),
      bodyLength,
    },
    verification: {
      beforeSku: boundedString(verification.beforeSku, 120),
      targetSku: boundedString(verification.targetSku, 120),
      afterSku: boundedString(verification.afterSku, 120),
      result: boundedString(verification.result, 40),
    },
  };
  if (response.bodyKind === "non_json" && typeof response.textPreview === "string") {
    normalized.response.textPreview = boundedString(response.textPreview, 200);
  }
  return normalized;
}

export function workerResultError(result) {
  const message = String(result?.error || "马帮采集失败，请检查账号、密码和网络。").slice(0, 1000);
  const error = new Error(message);
  const explicitCode = typeof result?.code === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(result.code)
    ? result.code
    : "";
  const matched = message.match(/^([A-Z][A-Z0-9_]{2,79}):/);
  if (explicitCode || matched) error.code = explicitCode || matched[1];
  const diagnostic = normalizeMabangSkuDiagnostic(result?.diagnostic);
  if (diagnostic) error.diagnostic = diagnostic;
  return error;
}

export function createMabangWorkerRunner({ rootDir, exportRoot, runtimeConfig = null, env = process.env }) {
  const workerPath = runtimeConfig?.mabangWorkerPath || path.resolve(rootDir, env.MABANG_WORKER_PATH || path.join("scripts", "mabang_worker.py"));
  const python = resolvePythonRuntime({
    appRoot: runtimeConfig?.appRoot || rootDir,
    env: {
      ...env,
      PYTHON_EXECUTABLE: runtimeConfig?.pythonExecutable || env.PYTHON_EXECUTABLE,
      PYTHON_VENV_DIR: runtimeConfig?.pythonVenvDir || env.PYTHON_VENV_DIR,
    },
    requiredModules: MABANG_PYTHON_MODULES,
  });

  return function runMabangWorker(payload, timeoutMs = 20 * 60 * 1000) {
    if (!python.ok) throw pythonRuntimeError(python, "Mabang worker");
    if (!existsSync(workerPath)) {
      throw new Error("马帮采集运行环境未安装完整，请联系管理员。");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(python.executable, [workerPath], {
        cwd: runtimeConfig?.appRoot || rootDir,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          MABANG_EXPORT_DIR: exportRoot,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error("马帮任务执行超时，请缩小日期范围后重试。"));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 100 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 20000) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`无法启动马帮采集程序：${error.message}`));
      });
      child.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let result;
        try {
          result = JSON.parse(stdout.trim());
        } catch {
          reject(new Error(stderr.includes("ModuleNotFoundError")
            ? "马帮采集依赖缺失，请联系管理员。"
            : "马帮采集程序没有返回有效结果。"));
          return;
        }
        if (result.ok === false) {
          reject(workerResultError(result));
          return;
        }
        resolve(result);
      });
      child.stdin.end(JSON.stringify(payload));
    });
  };
}
