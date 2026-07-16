import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function venvExecutables(venvDir) {
  return [
    path.join(venvDir, "Scripts", "python.exe"),
    path.join(venvDir, "bin", "python"),
  ];
}

function probe(executable, modules, spawnSyncImpl) {
  const script = [
    "import importlib.util,json,sys",
    "mods=sys.argv[1:]",
    "print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'missing':[m for m in mods if importlib.util.find_spec(m) is None]}))",
  ].join(";");
  const result = spawnSyncImpl(executable, ["-c", script, ...modules], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout || "").trim());
    return { version: parsed.version, missingModules: parsed.missing || [] };
  } catch {
    return null;
  }
}

export function resolvePythonRuntime({
  appRoot,
  env = process.env,
  requiredModules = [],
  spawnSyncImpl = spawnSync,
  existsSyncImpl = existsSync,
} = {}) {
  const configured = String(env.PYTHON_EXECUTABLE || env.PYTHON_PATH || "").trim();
  const configuredVenv = String(env.PYTHON_VENV_DIR || "").trim();
  const candidates = [];

  if (configured) {
    candidates.push({ executable: configured, source: "configured", explicit: true });
  } else {
    const venvDir = path.resolve(appRoot, configuredVenv || ".venv");
    for (const executable of venvExecutables(venvDir)) {
      if (existsSyncImpl(executable)) candidates.push({ executable, source: "project-venv" });
    }
    candidates.push({ executable: "python", source: "system" });
    candidates.push({ executable: "python3", source: "system" });
  }

  for (const candidate of candidates) {
    if (candidate.explicit && (path.isAbsolute(candidate.executable) || candidate.executable.includes(path.sep))
      && !existsSyncImpl(candidate.executable)) {
      return Object.freeze({ ok: false, source: "configured", errorCode: "PYTHON_EXECUTABLE_NOT_FOUND" });
    }
    const result = probe(candidate.executable, requiredModules, spawnSyncImpl);
    if (!result) {
      if (candidate.explicit) return Object.freeze({ ok: false, source: "configured", errorCode: "PYTHON_UNAVAILABLE" });
      continue;
    }
    if (result.missingModules.length) {
      return Object.freeze({
        ok: false,
        executable: candidate.executable,
        source: candidate.source,
        version: result.version,
        missingModules: Object.freeze(result.missingModules),
        errorCode: "PYTHON_DEPENDENCIES_MISSING",
      });
    }
    return Object.freeze({
      ok: true,
      executable: candidate.executable,
      source: candidate.source,
      version: result.version,
      missingModules: Object.freeze([]),
    });
  }
  return Object.freeze({ ok: false, source: "none", errorCode: "PYTHON_UNAVAILABLE" });
}

export function pythonRuntimeError(runtime, moduleName = "Python module") {
  if (runtime?.errorCode === "PYTHON_DEPENDENCIES_MISSING") {
    return new Error(`${moduleName} dependencies are missing: ${runtime.missingModules.join(", ")}`);
  }
  if (runtime?.errorCode === "PYTHON_EXECUTABLE_NOT_FOUND") {
    return new Error(`${moduleName} Python executable does not exist`);
  }
  return new Error(`${moduleName} Python runtime is unavailable`);
}
