import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AD_SERVICE_INTERNAL_HEADER } from "./ad-service-proxy.mjs";

export const AD_SERVICE_ID = "lazada-sponsored-max-analyzer";

export function advertisingChildEnvironment({ env, serviceDir, host, port, internalToken }) {
  const childEnv = { ...env };
  for (const key of [
    "APP_ROOT", "DATA_ROOT", "STORAGE_ROOT", "UPLOAD_ROOT", "EXPORT_ROOT", "TEMP_ROOT",
    "DATABASE_PATH", "SCHEDULER_DB_PATH", "MABANG_WORKER_PATH", "PYTHON_VENV_DIR",
    "CHROME_EXECUTABLE", "CHROME_PROFILE_ROOT",
  ]) delete childEnv[key];
  return {
    ...childEnv,
    APP_ROOT: serviceDir,
    AD_SERVICE_HOST: host,
    AD_SERVICE_PORT: String(port),
    AD_SERVICE_INTERNAL_TOKEN: internalToken,
    HOST: host,
    PORT: String(port),
  };
}

export function createAdServiceManager({
  mode,
  serviceDir,
  baseUrl,
  host,
  port,
  internalToken,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  existsSyncImpl = existsSync,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 10,
  intervalMs = 700,
} = {}) {
  let ownedChild = null;

  async function probe() {
    try {
      const response = await fetchImpl(`${baseUrl}/api/service/status`, {
        headers: { [AD_SERVICE_INTERNAL_HEADER]: internalToken },
        signal: AbortSignal.timeout(1500),
      });
      let body = null;
      try { body = await response.json(); } catch { /* bounded invalid response */ }
      if (response.ok && body?.ok === true && body?.service === AD_SERVICE_ID) {
        return { healthy: true, reachable: true };
      }
      return { healthy: false, reachable: true, errorCode: "AD_SERVICE_IDENTITY_MISMATCH" };
    } catch {
      return { healthy: false, reachable: false, errorCode: "AD_SERVICE_UNAVAILABLE" };
    }
  }

  async function ensure() {
    const current = await probe();
    if (current.healthy) return { ok: true, started: false, owned: Boolean(ownedChild), port };
    if (current.reachable) {
      return { ok: false, errorCode: current.errorCode, error: "广告服务端口被其他服务占用" };
    }
    if (mode === "external") {
      return { ok: false, errorCode: "AD_SERVICE_EXTERNAL_UNAVAILABLE", error: "外部广告服务未启动" };
    }

    const entry = path.join(serviceDir, "server.mjs");
    if (!existsSyncImpl(entry)) {
      return { ok: false, errorCode: "AD_SERVICE_DIR_INVALID", error: "广告服务目录无效，请配置 AD_SERVICE_DIR" };
    }
    if (!ownedChild) {
      const child = spawnImpl(process.execPath, ["server.mjs"], {
        cwd: serviceDir,
        env: advertisingChildEnvironment({ env, serviceDir, host, port, internalToken }),
        stdio: "inherit",
        windowsHide: true,
      });
      ownedChild = child;
      child.once?.("exit", (code) => {
        if (ownedChild === child) {
          ownedChild = null;
          if (code && code !== 0) console.warn(`Advertising child exited with code ${code}`);
        }
      });
      child.once?.("error", () => {
        if (ownedChild === child) ownedChild = null;
      });
    }

    for (let index = 0; index < attempts; index += 1) {
      await wait(intervalMs);
      const status = await probe();
      if (status.healthy) return { ok: true, started: true, owned: true, port };
      if (status.reachable) {
        await stop();
        return { ok: false, errorCode: status.errorCode, error: "广告服务身份校验失败" };
      }
    }
    await stop();
    return { ok: false, errorCode: "AD_SERVICE_START_TIMEOUT", error: "广告服务启动超时", port };
  }

  async function stop() {
    const child = ownedChild;
    if (!child) return false;
    ownedChild = null;
    if (child.exitCode == null && !child.killed) child.kill();
    return true;
  }

  return Object.freeze({
    ensure,
    probe,
    stop,
    ownsChild: () => Boolean(ownedChild),
  });
}
