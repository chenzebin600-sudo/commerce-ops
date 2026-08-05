import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const MABANG_LISTING_SERVICE_ID = "mabang-listing-local";

export function mabangListingChildEnvironment({
  env,
  serviceDir,
  storageRoot,
  host,
  port,
  internalToken,
  aiGatewayUrl,
}) {
  const childEnv = { ...env };
  for (const key of [
    "APP_ROOT",
    "DATA_ROOT",
    "STORAGE_ROOT",
    "UPLOAD_ROOT",
    "EXPORT_ROOT",
    "TEMP_ROOT",
    "DATABASE_PATH",
    "SCHEDULER_DB_PATH",
    "MABANG_WORKER_PATH",
    "CHROME_PROFILE_ROOT",
  ]) delete childEnv[key];

  return {
    ...childEnv,
    PYTHONIOENCODING: "utf-8",
    MABANG_LISTING_HOST: host,
    MABANG_LISTING_PORT: String(port),
    MABANG_LISTING_INTERNAL_TOKEN: internalToken,
    COMMERCE_OPS_AI_GATEWAY_URL: aiGatewayUrl,
    COMMERCE_OPS_AI_GATEWAY_TOKEN: internalToken,
    MABANG_LISTING_STORAGE_ROOT: storageRoot,
    MABANG_LISTING_SERVICE_DIR: serviceDir,
  };
}

export function createMabangListingServiceManager({
  mode,
  serviceDir,
  storageRoot,
  baseUrl,
  host,
  port,
  internalToken,
  aiGatewayUrl,
  pythonExecutable,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  existsSyncImpl = existsSync,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 20,
  intervalMs = 350,
} = {}) {
  let ownedChild = null;

  async function probe() {
    try {
      const response = await fetchImpl(`${baseUrl}/api/health`, {
        headers: { "x-commerce-ops-internal-token": internalToken },
        signal: AbortSignal.timeout(1500),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        // Invalid responses are treated as an occupied, untrusted port.
      }
      if (
        response.ok
        && body?.success === true
        && body?.service === MABANG_LISTING_SERVICE_ID
        && body?.commerce_ops_proxy === true
      ) {
        return { healthy: true, reachable: true, session: body.session || null };
      }
      return {
        healthy: false,
        reachable: true,
        errorCode: "MABANG_LISTING_SERVICE_IDENTITY_MISMATCH",
      };
    } catch {
      return {
        healthy: false,
        reachable: false,
        errorCode: "MABANG_LISTING_SERVICE_UNAVAILABLE",
      };
    }
  }

  async function stop() {
    const child = ownedChild;
    if (!child) return false;
    ownedChild = null;
    if (child.exitCode == null && !child.killed) child.kill();
    return true;
  }

  async function ensure() {
    const current = await probe();
    if (current.healthy) {
      return {
        ok: true,
        started: false,
        owned: Boolean(ownedChild),
        port,
        session: current.session,
      };
    }
    if (current.reachable) {
      return {
        ok: false,
        errorCode: current.errorCode,
        error: "Mabang listing service port is occupied by an incompatible process",
      };
    }
    if (mode === "external") {
      return {
        ok: false,
        errorCode: "MABANG_LISTING_EXTERNAL_UNAVAILABLE",
        error: "External Mabang listing service is not running",
      };
    }

    const entry = path.join(serviceDir, "mabang_listing_service.py");
    if (!existsSyncImpl(entry)) {
      return {
        ok: false,
        errorCode: "MABANG_LISTING_SERVICE_DIR_INVALID",
        error: "Mabang listing integration source is missing",
      };
    }
    if (!pythonExecutable) {
      return {
        ok: false,
        errorCode: "MABANG_LISTING_PYTHON_UNAVAILABLE",
        error: "Mabang listing Python runtime is unavailable",
      };
    }

    if (!ownedChild) {
      const child = spawnImpl(pythonExecutable, [entry], {
        cwd: serviceDir,
        env: mabangListingChildEnvironment({
          env,
          serviceDir,
          storageRoot,
          host,
          port,
          internalToken,
          aiGatewayUrl,
        }),
        stdio: "inherit",
        windowsHide: true,
      });
      ownedChild = child;
      child.once?.("exit", (code) => {
        if (ownedChild !== child) return;
        ownedChild = null;
        if (code && code !== 0) {
          console.warn(`Mabang listing child exited with code ${code}`);
        }
      });
      child.once?.("error", () => {
        if (ownedChild === child) ownedChild = null;
      });
    }

    for (let index = 0; index < attempts; index += 1) {
      await wait(intervalMs);
      const status = await probe();
      if (status.healthy) {
        return {
          ok: true,
          started: true,
          owned: true,
          port,
          session: status.session,
        };
      }
      if (status.reachable) {
        await stop();
        return {
          ok: false,
          errorCode: status.errorCode,
          error: "Mabang listing service identity verification failed",
        };
      }
    }

    await stop();
    return {
      ok: false,
      errorCode: "MABANG_LISTING_START_TIMEOUT",
      error: "Mabang listing service startup timed out",
      port,
    };
  }

  return Object.freeze({
    ensure,
    probe,
    stop,
    ownsChild: () => Boolean(ownedChild),
  });
}
