import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const VALID_AD_SERVICE_MODES = new Set(["managed", "external"]);
const VALID_MABANG_LISTING_SERVICE_MODES = new Set(["managed", "external"]);
const VALID_DATABASE_PROVIDERS = new Set(["sqlite", "postgres"]);
export const RUNTIME_PROFILES = Object.freeze({
  DEFAULT: "default",
  GROWTH_RADAR_G1B: "growth-radar-g1b",
  TEST: "test",
});

export class RuntimeIsolationError extends Error {
  constructor(checks) {
    const failed = checks.filter((check) => !check.ok);
    super(`Runtime isolation rejected: ${failed.map((check) => check.id).join(", ")}`);
    this.name = "RuntimeIsolationError";
    this.code = "RUNTIME_ISOLATION_REJECTED";
    this.checks = checks;
  }
}

function value(env, ...names) {
  for (const name of names) {
    const candidate = String(env[name] ?? "").trim();
    if (candidate) return candidate;
  }
  return "";
}

function databaseProvider(rawValue) {
  const configured = String(rawValue || "sqlite").trim().toLowerCase();
  const normalized = configured === "postgresql" ? "postgres" : configured;
  if (!VALID_DATABASE_PROVIDERS.has(normalized)) {
    throw new Error("DATABASE_PROVIDER must be sqlite or postgres");
  }
  return normalized;
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

function explicitlyConfigured(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) && String(env[name] ?? "").trim() !== "";
}

function comparablePath(input) {
  const normalized = path.normalize(input);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function insidePath(root, target, { allowRoot = true } = {}) {
  const relative = path.relative(comparablePath(root), comparablePath(target));
  if (relative === "") return allowRoot;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== ".." && !path.isAbsolute(relative);
}

function realTarget(target, { requireExisting = false } = {}) {
  const resolved = path.resolve(target);
  if (existsSync(resolved)) return realpathSync.native(resolved);
  if (requireExisting) throw new Error("configured path does not exist");
  const parent = path.dirname(resolved);
  if (!existsSync(parent)) throw new Error("configured path parent does not exist");
  return path.join(realpathSync.native(parent), path.basename(resolved));
}

function safeRealTarget(target, options) {
  try {
    return { ok: true, path: realTarget(target, options) };
  } catch (error) {
    return { ok: false, path: null, error: String(error.message || "path cannot be resolved") };
  }
}

function check(id, ok, detail) {
  return Object.freeze({ id, ok: Boolean(ok), detail });
}

export function inspectRuntimeIsolation({ bootstrapRoot, env = process.env } = {}) {
  if (!bootstrapRoot) throw new Error("bootstrapRoot is required");
  const profile = value(env, "COMMERCE_OPS_RUNTIME_PROFILE") || RUNTIME_PROFILES.DEFAULT;
  const checks = [check("runtime_profile", true, profile)];
  if (![RUNTIME_PROFILES.GROWTH_RADAR_G1B, RUNTIME_PROFILES.TEST].includes(profile)) {
    checks.push(check("profile_gate", true, "A2/test isolation gate is not active"));
    return Object.freeze({ profile, checks: Object.freeze(checks) });
  }

  const appRoot = configuredPath(bootstrapRoot, value(env, "APP_ROOT"), ".");
  const storageRoot = configuredPath(appRoot, value(env, "STORAGE_ROOT"), "storage");
  const databasePath = configuredPath(appRoot, value(env, "DATABASE_PATH", "SCHEDULER_DB_PATH"), path.join(storageRoot, "commerce-ops.sqlite"));
  const rawPort = value(env, "APP_PORT");
  const port = Number(rawPort || 0);
  const realBootstrap = safeRealTarget(bootstrapRoot, { requireExisting: true });
  const realApp = safeRealTarget(appRoot, { requireExisting: true });
  const realStorage = safeRealTarget(storageRoot, { requireExisting: true });
  const realDatabase = safeRealTarget(databasePath);
  const defaultDatabasePath = path.join(appRoot, "storage", "commerce-ops.sqlite");

  checks.push(
    check("database_path_explicit", explicitlyConfigured(env, "DATABASE_PATH"), "DATABASE_PATH must be explicitly configured"),
    check("storage_root_explicit", explicitlyConfigured(env, "STORAGE_ROOT"), "STORAGE_ROOT must be explicitly configured"),
    check("app_port_explicit", explicitlyConfigured(env, "APP_PORT"), "APP_PORT must be explicitly configured"),
    check("database_parent_confirmed", realDatabase.ok, realDatabase.ok ? "database parent resolved" : realDatabase.error),
    check("storage_root_confirmed", realStorage.ok, realStorage.ok ? "storage root resolved" : realStorage.error),
    check("default_database_rejected", !samePath(databasePath, defaultDatabasePath), "default storage/commerce-ops.sqlite is forbidden"),
  );

  if (profile === RUNTIME_PROFILES.GROWTH_RADAR_G1B) {
    const expectedStorage = path.join(appRoot, "storage", "development");
    const realExpectedStorage = safeRealTarget(expectedStorage, { requireExisting: true });
    checks.push(
      check("app_root_is_worktree", realBootstrap.ok && realApp.ok && samePath(realBootstrap.path, realApp.path), "APP_ROOT must resolve to this worktree"),
      check("database_name", comparablePath(path.basename(databasePath)) === comparablePath("growth-radar-g1b.sqlite"), "database filename must be growth-radar-g1b.sqlite"),
      check("storage_inside_worktree", realApp.ok && realStorage.ok && insidePath(realApp.path, realStorage.path), "STORAGE_ROOT must stay inside this worktree"),
      check("database_inside_worktree", realApp.ok && realDatabase.ok && insidePath(realApp.path, realDatabase.path), "DATABASE_PATH must stay inside this worktree"),
      check("database_inside_storage", realStorage.ok && realDatabase.ok && insidePath(realStorage.path, realDatabase.path), "DATABASE_PATH must stay inside STORAGE_ROOT"),
      check("development_storage_root", realStorage.ok && realExpectedStorage.ok && samePath(realStorage.path, realExpectedStorage.path), "STORAGE_ROOT must resolve to storage/development"),
      check("growth_radar_port", Number.isInteger(port) && port === 3193, "growth-radar-g1b must use APP_PORT=3193"),
      check("formal_port_rejected", port !== 3101, "APP_PORT=3101 is forbidden"),
      check("advertising_is_external", value(env, "AD_SERVICE_MODE") === "external", "AD_SERVICE_MODE=external is required"),
    );
  } else {
    const realTemp = safeRealTarget(os.tmpdir(), { requireExisting: true });
    checks.push(
      check("test_storage_is_temporary", realTemp.ok && realStorage.ok && insidePath(realTemp.path, realStorage.path), "test STORAGE_ROOT must stay under the system temporary directory"),
      check("test_database_is_temporary", realTemp.ok && realDatabase.ok && insidePath(realTemp.path, realDatabase.path), "test DATABASE_PATH must stay under the system temporary directory"),
      check("test_database_inside_storage", realStorage.ok && realDatabase.ok && insidePath(realStorage.path, realDatabase.path), "test DATABASE_PATH must stay inside test STORAGE_ROOT"),
      check("test_port", Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3101, "test APP_PORT must be explicit and must not use 3101"),
    );
  }

  return Object.freeze({ profile, checks: Object.freeze(checks) });
}

function assertRuntimeIsolation(input) {
  const inspection = inspectRuntimeIsolation(input);
  if (inspection.checks.some((item) => !item.ok)) throw new RuntimeIsolationError(inspection.checks);
  return inspection;
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
  const configuredDatabaseProvider = databaseProvider(value(env, "DATABASE_PROVIDER"));
  const isolation = assertRuntimeIsolation({ bootstrapRoot, env });

  const adServiceMode = value(env, "AD_SERVICE_MODE") || "managed";
  if (!VALID_AD_SERVICE_MODES.has(adServiceMode)) {
    throw new Error("AD_SERVICE_MODE must be managed or external");
  }
  const adServiceDir = configuredPath(
    appRoot,
    value(env, "AD_SERVICE_DIR", "AD_ANALYZER_DIR"),
    path.join(appRoot, "..", "lazada-ads", "webapp"),
  );
  const mabangListingServiceMode =
    value(env, "MABANG_LISTING_SERVICE_MODE") || "managed";
  if (!VALID_MABANG_LISTING_SERVICE_MODES.has(mabangListingServiceMode)) {
    throw new Error(
      "MABANG_LISTING_SERVICE_MODE must be managed or external",
    );
  }
  const mabangListingServiceDir = configuredPath(
    appRoot,
    value(env, "MABANG_LISTING_SERVICE_DIR"),
    path.join("integrations", "mabang-getdata"),
  );
  const mabangListingStorageRoot = configuredPath(
    appRoot,
    value(env, "MABANG_LISTING_STORAGE_ROOT"),
    path.join(storageRoot, "integrations", "mabang-listing"),
  );

  const pythonVenvDir = configuredPath(appRoot, value(env, "PYTHON_VENV_DIR"), ".venv");
  const mabangWorkerPath = configuredPath(
    appRoot,
    value(env, "MABANG_WORKER_PATH"),
    path.join("scripts", "mabang_worker.py"),
  );

  return Object.freeze({
    runtimeProfile: isolation.profile,
    appRoot,
    dataRoot,
    storageRoot,
    uploadRoot,
    exportRoot,
    tempRoot,
    databasePath,
    databaseProvider: configuredDatabaseProvider,
    appHost: value(env, "APP_HOST", "HOST") || "127.0.0.1",
    appPort: configuredPort(value(env, "APP_PORT", "PORT"), 3101, "APP_PORT"),
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
    mabangListingServiceMode,
    mabangListingServiceDir,
    mabangListingStorageRoot,
    mabangListingHost:
      value(env, "MABANG_LISTING_HOST") || "127.0.0.1",
    mabangListingPort: configuredPort(
      value(env, "MABANG_LISTING_PORT"),
      8877,
      "MABANG_LISTING_PORT",
    ),
    mabangListingBaseUrl: value(env, "MABANG_LISTING_BASE_URL"),
    mabangListingTokenFile: configuredPath(
      appRoot,
      value(env, "MABANG_LISTING_INTERNAL_TOKEN_FILE"),
      path.join(storageRoot, ".mabang-listing-internal-token"),
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
    COMMERCE_OPS_RUNTIME_PROFILE: config.runtimeProfile,
    APP_ROOT: config.appRoot,
    APP_HOST: config.appHost,
    APP_PORT: String(config.appPort),
    DATA_ROOT: config.dataRoot,
    STORAGE_ROOT: config.storageRoot,
    UPLOAD_ROOT: config.uploadRoot,
    EXPORT_ROOT: config.exportRoot,
    TEMP_ROOT: config.tempRoot,
    DATABASE_PATH: config.databasePath,
    DATABASE_PROVIDER: config.databaseProvider,
    AD_SERVICE_MODE: config.adServiceMode,
    AD_SERVICE_DIR: config.adServiceDir,
    AD_SERVICE_HOST: config.adServiceHost,
    AD_SERVICE_PORT: String(config.adServicePort),
    MABANG_LISTING_SERVICE_MODE: config.mabangListingServiceMode,
    MABANG_LISTING_SERVICE_DIR: config.mabangListingServiceDir,
    MABANG_LISTING_STORAGE_ROOT: config.mabangListingStorageRoot,
    MABANG_LISTING_HOST: config.mabangListingHost,
    MABANG_LISTING_PORT: String(config.mabangListingPort),
    MABANG_LISTING_BASE_URL: config.mabangListingBaseUrl,
    PYTHON_VENV_DIR: config.pythonVenvDir,
    MABANG_WORKER_PATH: config.mabangWorkerPath,
    CHROME_DEBUG_PORT: String(config.chromeDebugPort),
  });
}
