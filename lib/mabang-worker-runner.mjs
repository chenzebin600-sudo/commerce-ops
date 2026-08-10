import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { pythonRuntimeError, resolvePythonRuntime } from "./python-runtime.mjs";

const MABANG_PYTHON_MODULES = Object.freeze(["openpyxl", "pandas", "requests"]);
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const MAX_COMPRESSED_TRANSPORT_BYTES = 128 * 1024 * 1024;

function workerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function responseByteLimit(value) {
  const parsed = Number(value || DEFAULT_MAX_RESPONSE_BYTES);
  if (!Number.isInteger(parsed) || parsed < 1024 * 1024 || parsed > DEFAULT_MAX_RESPONSE_BYTES) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }
  return parsed;
}

export function parseMabangWorkerResponse(output, {
  encoding = "identity",
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const transport = Buffer.isBuffer(output) ? output : Buffer.from(output || "");
  let payload;
  try {
    payload = encoding === "gzip"
      ? gunzipSync(transport, { maxOutputLength: maxResponseBytes })
      : transport;
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/i.test(error?.message || "")) {
      throw workerError("马帮采集结果超过系统安全上限，请联系管理员拆分采集范围。", "MABANG_WORKER_OUTPUT_TOO_LARGE");
    }
    throw workerError("马帮采集程序返回的数据压缩包损坏。", "MABANG_WORKER_INVALID_RESPONSE");
  }
  if (payload.length > maxResponseBytes) {
    throw workerError("马帮采集结果超过系统安全上限，请联系管理员拆分采集范围。", "MABANG_WORKER_OUTPUT_TOO_LARGE");
  }
  try {
    return JSON.parse(payload.toString("utf8").trim());
  } catch {
    throw workerError("马帮采集程序没有返回有效结果。", "MABANG_WORKER_INVALID_RESPONSE");
  }
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
  const maxResponseBytes = responseByteLimit(env.MABANG_WORKER_MAX_RESPONSE_BYTES);
  const responseEncoding = "gzip";

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
          ...env,
          PYTHONIOENCODING: "utf-8",
          MABANG_EXPORT_DIR: exportRoot,
          MABANG_WORKER_RESPONSE_ENCODING: responseEncoding,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks = [];
      let stdoutBytes = 0;
      let transportLimitExceeded = false;
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(workerError("马帮任务执行超时，请缩小日期范围后重试。", "MABANG_WORKER_TIMEOUT"));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_COMPRESSED_TRANSPORT_BYTES) {
          transportLimitExceeded = true;
          child.kill();
          return;
        }
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 20000) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(workerError(`无法启动马帮采集程序：${error.message}`, "MABANG_WORKER_SPAWN_FAILED"));
      });
      child.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (transportLimitExceeded) {
          reject(workerError(
            "马帮采集结果的压缩传输数据超过系统安全上限，请联系管理员拆分采集范围。",
            "MABANG_WORKER_OUTPUT_TOO_LARGE",
          ));
          return;
        }
        let result;
        try {
          result = parseMabangWorkerResponse(Buffer.concat(stdoutChunks), {
            encoding: responseEncoding,
            maxResponseBytes,
          });
        } catch (error) {
          reject(stderr.includes("ModuleNotFoundError")
            ? workerError("马帮采集依赖缺失，请联系管理员。", "MABANG_WORKER_DEPENDENCY_MISSING")
            : error);
          return;
        }
        if (result.ok === false) {
          reject(workerError(
            result.error || "马帮采集失败，请检查账号、密码和网络。",
            result.code || "MABANG_WORKER_FAILED",
          ));
          return;
        }
        resolve(result);
      });
      child.stdin.end(JSON.stringify(payload));
    });
  };
}
