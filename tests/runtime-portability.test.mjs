import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advertisingChildEnvironment, createAdServiceManager, AD_SERVICE_ID } from "../lib/ad-service-manager.mjs";
import { resolveChromeRuntime } from "../lib/chrome-runtime.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";
import { openSchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";

const fixtureRoot = () => path.join(os.tmpdir(), "portable-commerce-fixture");
const pythonProbe = ({ version = "3.12.1", missing = [] } = {}) => () => ({
  status: 0,
  stdout: JSON.stringify({ version, missing }),
  stderr: "",
});

test("portable defaults stay inside the project root", () => {
  const appRoot = fixtureRoot();
  const config = resolveRuntimeConfig({ bootstrapRoot: appRoot, env: {} });
  assert.equal(config.appRoot, appRoot);
  assert.equal(config.storageRoot, path.join(appRoot, "storage"));
  assert.equal(config.databasePath, path.join(appRoot, "storage", "commerce-ops.sqlite"));
  assert.equal(config.chromeProfileRoot, path.join(appRoot, "storage", "chrome-user-data"));
});

test("runtime path environment overrides are resolved consistently", () => {
  const appRoot = fixtureRoot();
  const config = resolveRuntimeConfig({ bootstrapRoot: appRoot, env: {
    DATA_ROOT: "runtime-data", STORAGE_ROOT: "runtime-store", UPLOAD_ROOT: "incoming",
    EXPORT_ROOT: "outgoing", TEMP_ROOT: "scratch", DATABASE_PATH: "db/formal.sqlite",
    AD_SERVICE_DIR: "../ads/webapp", MABANG_WORKER_PATH: "workers/run.py",
  } });
  assert.equal(config.dataRoot, path.join(appRoot, "runtime-data"));
  assert.equal(config.databasePath, path.join(appRoot, "db", "formal.sqlite"));
  assert.equal(config.adServiceDir, path.resolve(appRoot, "..", "ads", "webapp"));
  assert.equal(config.mabangWorkerPath, path.join(appRoot, "workers", "run.py"));
});

test("DATABASE_PATH takes priority over the legacy scheduler path", () => {
  const config = resolveRuntimeConfig({ bootstrapRoot: fixtureRoot(), env: { DATABASE_PATH: "new.sqlite", SCHEDULER_DB_PATH: "old.sqlite" } });
  assert.equal(config.databasePath, path.join(fixtureRoot(), "new.sqlite"));
});

test("legacy storage and database names remain compatible", () => {
  const config = resolveRuntimeConfig({ bootstrapRoot: fixtureRoot(), env: { EXPORT_STORAGE_PATH: "legacy-export", SCHEDULER_DB_PATH: "legacy.sqlite" } });
  assert.equal(config.exportRoot, path.join(fixtureRoot(), "legacy-export"));
  assert.equal(config.databasePath, path.join(fixtureRoot(), "legacy.sqlite"));
});

test("a missing override cannot create a second database beside an existing formal database", () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "database-path-guard-"));
  const storage = path.join(appRoot, "storage");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, "commerce-ops.sqlite"), "formal-placeholder");
  const alternate = path.join(appRoot, "alternate", "empty.sqlite");
  try {
    assert.throws(() => openSchedulerDatabase({ rootDir: appRoot, databasePath: alternate }), /default formal database exists/);
    assert.equal(fs.existsSync(alternate), false);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test("runtime environment forwards normalized paths without secrets", () => {
  const values = runtimeEnvironment(resolveRuntimeConfig({ bootstrapRoot: fixtureRoot(), env: {} }));
  assert.ok(values.DATABASE_PATH.endsWith("commerce-ops.sqlite"));
  assert.equal("APP_ACCESS_TOKEN" in values, false);
  assert.equal("AD_SERVICE_INTERNAL_TOKEN" in values, false);
});

test("advertising mode accepts managed and external only", () => {
  assert.equal(resolveRuntimeConfig({ bootstrapRoot: fixtureRoot(), env: { AD_SERVICE_MODE: "external" } }).adServiceMode, "external");
  assert.throws(() => resolveRuntimeConfig({ bootstrapRoot: fixtureRoot(), env: { AD_SERVICE_MODE: "other" } }), /managed or external/);
});

test("managed advertising child does not inherit main storage or database roots", () => {
  const childEnv = advertisingChildEnvironment({
    env: { APP_ROOT: "main", STORAGE_ROOT: "main-store", DATABASE_PATH: "main.sqlite", SAFE_VALUE: "kept" },
    serviceDir: "ads", host: "127.0.0.1", port: 4173, internalToken: "test",
  });
  assert.equal(childEnv.APP_ROOT, "ads");
  assert.equal(childEnv.STORAGE_ROOT, undefined);
  assert.equal(childEnv.DATABASE_PATH, undefined);
  assert.equal(childEnv.SAFE_VALUE, "kept");
});

test("configured Python executable has first priority", () => {
  const runtime = resolvePythonRuntime({ appRoot: fixtureRoot(), env: { PYTHON_EXECUTABLE: "custom-python" }, requiredModules: ["pandas"], spawnSyncImpl: pythonProbe(), existsSyncImpl: () => true });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.source, "configured");
  assert.equal(runtime.executable, "custom-python");
});

test("project virtual environment is detected on Windows layout", () => {
  const appRoot = fixtureRoot();
  const expected = path.join(appRoot, ".venv", "Scripts", "python.exe");
  const runtime = resolvePythonRuntime({ appRoot, env: {}, spawnSyncImpl: pythonProbe(), existsSyncImpl: (candidate) => candidate === expected });
  assert.equal(runtime.source, "project-venv");
  assert.equal(runtime.executable, expected);
});

test("system Python is used after a missing project environment", () => {
  const calls = [];
  const runtime = resolvePythonRuntime({ appRoot: fixtureRoot(), env: {}, existsSyncImpl: () => false, spawnSyncImpl: (command) => {
    calls.push(command);
    return command === "python" ? { status: 0, stdout: JSON.stringify({ version: "3.11.0", missing: [] }) } : { status: 1 };
  } });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.source, "system");
  assert.deepEqual(calls, ["python"]);
});

test("missing Python returns a bounded module error", () => {
  const runtime = resolvePythonRuntime({ appRoot: fixtureRoot(), env: {}, existsSyncImpl: () => false, spawnSyncImpl: () => ({ status: 1 }) });
  assert.deepEqual({ ok: runtime.ok, code: runtime.errorCode }, { ok: false, code: "PYTHON_UNAVAILABLE" });
});

test("missing Python dependencies are reported without installing them", () => {
  const runtime = resolvePythonRuntime({ appRoot: fixtureRoot(), env: { PYTHON_EXECUTABLE: "python" }, requiredModules: ["pandas"], spawnSyncImpl: pythonProbe({ missing: ["pandas"] }), existsSyncImpl: () => true });
  assert.equal(runtime.errorCode, "PYTHON_DEPENDENCIES_MISSING");
  assert.deepEqual(runtime.missingModules, ["pandas"]);
});

test("configured Chrome executable is honored", () => {
  const runtime = resolveChromeRuntime({ env: { CHROME_EXECUTABLE: "browser-command" }, existsSyncImpl: () => true });
  assert.deepEqual(runtime, { ok: true, executable: "browser-command", source: "configured" });
});

test("Windows Chrome discovery is built from operating-system folders", () => {
  const base = path.join(fixtureRoot(), "programs");
  const expected = path.join(base, "Google", "Chrome", "Application", "chrome.exe");
  const runtime = resolveChromeRuntime({ platform: "win32", env: { ProgramFiles: base }, existsSyncImpl: (candidate) => candidate === expected });
  assert.equal(runtime.executable, expected);
});

test("Linux Chrome discovery uses common commands", () => {
  const runtime = resolveChromeRuntime({ platform: "linux", env: {}, spawnSyncImpl: (command) => ({ status: command === "chromium" ? 0 : 1 }) });
  assert.equal(runtime.executable, "chromium");
});

test("unavailable Chrome is isolated to browser workflows", () => {
  const runtime = resolveChromeRuntime({ platform: "linux", env: {}, spawnSyncImpl: () => ({ status: 1 }) });
  assert.equal(runtime.errorCode, "CHROME_UNAVAILABLE");
});

const response = (body, ok = true) => ({ ok, async json() { return body; } });
function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test("external advertising mode never starts a child", async () => {
  let spawned = 0;
  const manager = createAdServiceManager({ mode: "external", serviceDir: fixtureRoot(), baseUrl: "http://127.0.0.1:4173", host: "127.0.0.1", port: 4173, internalToken: "test", fetchImpl: async () => { throw new Error("offline"); }, spawnImpl: () => { spawned += 1; }, attempts: 1, wait: async () => {} });
  assert.equal((await manager.ensure()).errorCode, "AD_SERVICE_EXTERNAL_UNAVAILABLE");
  assert.equal(spawned, 0);
});

test("managed advertising mode starts and stops its own verified child", async () => {
  let probes = 0;
  const child = fakeChild();
  const manager = createAdServiceManager({ mode: "managed", serviceDir: fixtureRoot(), baseUrl: "http://127.0.0.1:4173", host: "127.0.0.1", port: 4173, internalToken: "test", existsSyncImpl: () => true, spawnImpl: () => child, fetchImpl: async () => {
    probes += 1;
    if (probes === 1) throw new Error("offline");
    return response({ ok: true, service: AD_SERVICE_ID });
  }, attempts: 1, wait: async () => {} });
  assert.equal((await manager.ensure()).ok, true);
  assert.equal(manager.ownsChild(), true);
  await manager.stop();
  assert.equal(child.killed, true);
});

test("an occupied port with the wrong service is rejected without spawning", async () => {
  let spawned = 0;
  const manager = createAdServiceManager({ mode: "managed", serviceDir: fixtureRoot(), baseUrl: "http://127.0.0.1:4173", host: "127.0.0.1", port: 4173, internalToken: "test", fetchImpl: async () => response({ ok: true, service: "wrong" }), spawnImpl: () => { spawned += 1; } });
  assert.equal((await manager.ensure()).errorCode, "AD_SERVICE_IDENTITY_MISMATCH");
  assert.equal(spawned, 0);
});

test("a managed advertising child is stopped after a bounded startup timeout", async () => {
  const child = fakeChild();
  const manager = createAdServiceManager({ mode: "managed", serviceDir: fixtureRoot(), baseUrl: "http://127.0.0.1:4173", host: "127.0.0.1", port: 4173, internalToken: "test", existsSyncImpl: () => true, spawnImpl: () => child, fetchImpl: async () => { throw new Error("offline"); }, attempts: 1, wait: async () => {} });
  assert.equal((await manager.ensure()).errorCode, "AD_SERVICE_START_TIMEOUT");
  assert.equal(child.killed, true);
  assert.equal(manager.ownsChild(), false);
});

test("a healthy externally-started service is never claimed or stopped", async () => {
  const manager = createAdServiceManager({ mode: "managed", serviceDir: fixtureRoot(), baseUrl: "http://127.0.0.1:4173", host: "127.0.0.1", port: 4173, internalToken: "test", fetchImpl: async () => response({ ok: true, service: AD_SERVICE_ID }) });
  assert.equal((await manager.ensure()).started, false);
  assert.equal(await manager.stop(), false);
});

test("portable path scanner has one centralized and narrowly scoped exception registry", () => {
  const exceptions = JSON.parse(fs.readFileSync(new URL("../config/portable-path-exceptions.json", import.meta.url), "utf8"));
  assert.deepEqual(exceptions.map((item) => item.prefix).sort(), [
    "docs/growth-radar-g1b-three-stash-audit.md",
    "docs/product-query-center-DESIGN.md",
    "docs/product-query-center-production-analysis.md",
    "memory/daily/",
    "tests/",
  ]);
  assert.equal(exceptions.some((item) => item.prefix === "docs/"), false);
  assert.equal(exceptions.every((item) => typeof item.reason === "string" && item.reason.length >= 20), true);
});

test("unified package commands expose main scheduler ads and doctor", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["start", "start:all", "start:main", "start:scheduler", "start:ads", "doctor", "check:paths"]) assert.ok(pkg.scripts[name]);
});

test("doctor source does not print access or internal token values", () => {
  const source = fs.readFileSync(new URL("../scripts/doctor.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.log\([^\n]*(APP_ACCESS_TOKEN|AD_SERVICE_INTERNAL_TOKEN)/);
});
