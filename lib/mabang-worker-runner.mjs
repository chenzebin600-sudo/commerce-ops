import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pythonRuntimeError, resolvePythonRuntime } from "./python-runtime.mjs";

const MABANG_PYTHON_MODULES = Object.freeze(["openpyxl", "pandas", "requests"]);

export function workerResultError(result) {
  const message = String(result?.error || "马帮采集失败，请检查账号、密码和网络。").slice(0, 1000);
  const error = new Error(message);
  const matched = message.match(/^([A-Z][A-Z0-9_]{2,79}):/);
  if (matched) error.code = matched[1];
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
