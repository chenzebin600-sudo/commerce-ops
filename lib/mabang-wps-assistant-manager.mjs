import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function createMabangWpsAssistantManager({
  serviceDir,
  pythonExecutable,
  env = process.env,
  existsSyncImpl = existsSync,
  spawnImpl = spawn,
} = {}) {
  let ownedChild = null;

  function status() {
    return Object.freeze({
      available: Boolean(
        pythonExecutable
        && existsSyncImpl(path.join(serviceDir, "mabang_assistant_app.py")),
      ),
      running: Boolean(ownedChild),
    });
  }

  function launch() {
    const current = status();
    if (!current.available) {
      return {
        ok: false,
        errorCode: "MABANG_WPS_ASSISTANT_UNAVAILABLE",
        error: "Mabang WPS assistant runtime is unavailable",
      };
    }
    if (ownedChild) return { ok: true, started: false, running: true };

    const entry = path.join(serviceDir, "mabang_assistant_app.py");
    const child = spawnImpl(pythonExecutable, [entry], {
      cwd: serviceDir,
      env: { ...env, PYTHONIOENCODING: "utf-8" },
      stdio: "ignore",
      windowsHide: false,
    });
    ownedChild = child;
    child.once?.("exit", () => {
      if (ownedChild === child) ownedChild = null;
    });
    child.once?.("error", () => {
      if (ownedChild === child) ownedChild = null;
    });
    return { ok: true, started: true, running: true };
  }

  async function stop() {
    const child = ownedChild;
    if (!child) return false;
    ownedChild = null;
    if (child.exitCode == null && !child.killed) child.kill();
    return true;
  }

  return Object.freeze({ launch, status, stop });
}
