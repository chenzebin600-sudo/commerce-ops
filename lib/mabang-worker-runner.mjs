import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function createMabangWorkerRunner({ rootDir, exportRoot }) {
  const pythonPath = path.join(rootDir, ".venv-mabang", "Scripts", "python.exe");
  const workerPath = path.join(rootDir, "scripts", "mabang_worker.py");

  return function runMabangWorker(payload, timeoutMs = 20 * 60 * 1000) {
    if (!existsSync(pythonPath) || !existsSync(workerPath)) {
      throw new Error("马帮采集运行环境未安装完整，请联系管理员。");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(pythonPath, [workerPath], {
        cwd: rootDir,
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
          reject(new Error(result.error || "马帮采集失败，请检查账号、密码和网络。"));
          return;
        }
        resolve(result);
      });
      child.stdin.end(JSON.stringify(payload));
    });
  };
}
