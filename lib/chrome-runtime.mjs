import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function firstExisting(paths, existsSyncImpl) {
  return paths.find((candidate) => candidate && existsSyncImpl(candidate)) || "";
}

function commandAvailable(command, spawnSyncImpl) {
  const result = spawnSyncImpl(command, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return !result.error && result.status === 0;
}

export function resolveChromeRuntime({ env = process.env, platform = process.platform, existsSyncImpl = existsSync, spawnSyncImpl = spawnSync } = {}) {
  const configured = String(env.CHROME_EXECUTABLE || env.CHROME_PATH || "").trim();
  if (configured) {
    if ((path.isAbsolute(configured) || configured.includes(path.sep)) && !existsSyncImpl(configured)) {
      return Object.freeze({ ok: false, source: "configured", errorCode: "CHROME_EXECUTABLE_NOT_FOUND" });
    }
    return Object.freeze({ ok: true, executable: configured, source: "configured" });
  }

  if (platform === "win32") {
    const programFiles = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
    const candidates = [];
    for (const root of programFiles) {
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    const executable = firstExisting(candidates, existsSyncImpl);
    return executable
      ? Object.freeze({ ok: true, executable, source: "system-install" })
      : Object.freeze({ ok: false, source: "none", errorCode: "CHROME_UNAVAILABLE" });
  }

  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    if (commandAvailable(command, spawnSyncImpl)) return Object.freeze({ ok: true, executable: command, source: "system-command" });
  }
  return Object.freeze({ ok: false, source: "none", errorCode: "CHROME_UNAVAILABLE" });
}
