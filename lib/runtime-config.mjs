import path from "node:path";

const VALID_AD_SERVICE_MODES = new Set(["managed", "external"]);

function value(env, ...names) {
  for (const name of names) {
    const candidate = String(env[name] ?? "").trim();
    if (candidate) return candidate;
  }
  return "";
}

function configuredPath(baseDir, configuredValue, fallback) {
  return path.resolve(baseDir, configuredValue || fallback);
}

function configuredPort(rawValue, fallback, name) {
  const port = Number(String(rawValue ?? "").trim() || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function resolveRuntimeConfig({ bootstrapRoot, env = process.env } = {}) {
  if (!bootstrapRoot) throw new Error("bootstrapRoot is required");

  const appRoot = configuredPath(bootstrapRoot, value(env, "APP_ROOT"), ".");
  const dataRoot = configuredPath(appRoot, value(env, "DATA_ROOT"), "storage");
  const storageRoot = configuredPath(appRoot, value(env, "STORAGE_ROOT"), dataRoot);
  const uploadRoot = configuredPath(appRoot, value(env, "UPLOAD_ROOT"), path.join(storageRoot, "uploads"));
  const exportRoot = configuredPath(
    appRoot,
    value(env, "EXPORT_ROOT", "EXPORT_STORAGE_PATH"),
    path.join(storageRoot, "exports", "mabang"),
  );
  const tempRoot = configuredPath(appRoot, value(env, "TEMP_ROOT"), path.join(storageRoot, "temp"));
  const databasePath = configuredPath(
    appRoot,
    value(env, "DATABASE_PATH", "SCHEDULER_DB_PATH"),
    path.join(storageRoot, "commerce-ops.sqlite"),
  );

  const adServiceMode = value(env, "AD_SERVICE_MODE") || "managed";
  if (!VALID_AD_SERVICE_MODES.has(adServiceMode)) {
    throw new Error("AD_SERVICE_MODE must be managed or external");
  }
  const adServiceDir = configuredPath(
    appRoot,
    value(env, "AD_SERVICE_DIR", "AD_ANALYZER_DIR"),
    path.join(appRoot, "..", "lazada-ads", "webapp"),
  );

  const pythonVenvDir = configuredPath(appRoot, value(env, "PYTHON_VENV_DIR"), ".venv");
  const mabangWorkerPath = configuredPath(
    appRoot,
    value(env, "MABANG_WORKER_PATH"),
    path.join("scripts", "mabang_worker.py"),
  );

  return Object.freeze({
    appRoot,
    dataRoot,
    storageRoot,
    uploadRoot,
    exportRoot,
    tempRoot,
    databasePath,
    adServiceMode,
    adServiceDir,
    adServiceHost: value(env, "AD_SERVICE_HOST") || "127.0.0.1",
    adServicePort: configuredPort(value(env, "AD_SERVICE_PORT", "AD_ANALYZER_PORT"), 4173, "AD_SERVICE_PORT"),
    adServiceBaseUrl: value(env, "AD_SERVICE_BASE_URL"),
    adServiceTokenFile: configuredPath(
      appRoot,
      value(env, "AD_SERVICE_INTERNAL_TOKEN_FILE"),
      path.join(storageRoot, ".ad-service-internal-token"),
    ),
    pythonExecutable: value(env, "PYTHON_EXECUTABLE", "PYTHON_PATH"),
    pythonVenvDir,
    mabangWorkerPath,
    chromeExecutable: value(env, "CHROME_EXECUTABLE", "CHROME_PATH"),
    chromeDebugPort: configuredPort(value(env, "CHROME_DEBUG_PORT"), 9222, "CHROME_DEBUG_PORT"),
    chromeProfileRoot: configuredPath(
      appRoot,
      value(env, "CHROME_PROFILE_ROOT"),
      path.join(dataRoot, "chrome-user-data"),
    ),
  });
}

export function runtimeEnvironment(config) {
  return Object.freeze({
    APP_ROOT: config.appRoot,
    DATA_ROOT: config.dataRoot,
    STORAGE_ROOT: config.storageRoot,
    UPLOAD_ROOT: config.uploadRoot,
    EXPORT_ROOT: config.exportRoot,
    TEMP_ROOT: config.tempRoot,
    DATABASE_PATH: config.databasePath,
    AD_SERVICE_MODE: config.adServiceMode,
    AD_SERVICE_DIR: config.adServiceDir,
    AD_SERVICE_HOST: config.adServiceHost,
    AD_SERVICE_PORT: String(config.adServicePort),
    PYTHON_VENV_DIR: config.pythonVenvDir,
    MABANG_WORKER_PATH: config.mabangWorkerPath,
    CHROME_DEBUG_PORT: String(config.chromeDebugPort),
  });
}
