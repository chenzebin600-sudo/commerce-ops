import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { createSqliteMigrationSnapshot } from "../lib/postgresql/sqlite-migration.mjs";
import { SyncControlRepository } from "../lib/postgresql/incremental-sync/sync-control-repository.mjs";
import {
  PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
  PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
  PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
  PHASE3D_PRODUCTION_MODE_SCOPE,
} from "../lib/postgresql/phase3d-production-candidate.mjs";
import {
  applyProductionEnvironment,
  classifyProductionProcesses,
  PHASE3D_PRODUCTION_CUTOVER_CONTRACT,
  productionCutoverApplyCommand,
  resolveProductionWriterState,
  resolveProductionCutoverInvocation,
} from "../lib/postgresql/phase3d-production-cutover.mjs";
import { runProductionCandidateSync } from "./postgresql-phase3d-cutover-rehearsal.mjs";

const executeFile = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const reportDirectory = path.join(rootDir, "docs", "reports");
const backupDirectory = path.join(rootDir, "storage", "backups");
const localEnvFile = path.join(rootDir, ".env.local");
const FINAL_SYNC_ARGS = Object.freeze([
  "--apply",
  "--refresh",
  `--confirm-database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`,
  "--confirm-production-mutation=REFRESH_FULL_SOURCE",
]);

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function safeError(error) {
  return {
    code: String(error?.code || "PRODUCTION_CUTOVER_FAILED").slice(0, 80),
    message: String(error?.message || error).split(/\r?\n/)[0].slice(0, 500),
  };
}

function selectedProvider(config, { readOnly = false, applicationRole = false } = {}) {
  return new PostgresqlProvider({
    config: Object.freeze({ ...config, schema: "app", statementTimeoutMs: 600_000 }),
    database: PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
    user: applicationRole ? config.appUser : config.migratorUser,
    password: applicationRole ? config.appPassword : config.migratorPassword,
    readOnly,
  });
}

async function nodeProcesses() {
  const command = [
    "$items=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine } | ForEach-Object {",
    "[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;commandLine=[string]$_.CommandLine}",
    "}; @($items) | ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: rootDir,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const value = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(value) ? value : value ? [value] : [];
}

async function productionProcesses() {
  return classifyProductionProcesses(await nodeProcesses(), rootDir);
}

function countIfPresent(database, table, where = "1=1") {
  const present = database.prepare("SELECT 1 present FROM sqlite_schema WHERE type='table' AND name=?").get(table);
  if (!present) return 0;
  return Number(database.prepare(`SELECT COUNT(*) count FROM "${table}" WHERE ${where}`).get().count);
}

function sourceActivity(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const activity = {
      scheduledPendingOrRunning: countIfPresent(database, "scheduled_export_runs", "LOWER(status) IN ('pending','running')"),
      priceControlRunning: countIfPresent(database, "price_control_sync_runs", "UPPER(status)='RUNNING'"),
      repricingExecuting: countIfPresent(database, "price_control_repricing_plans", "UPPER(status) IN ('CONFIRMING','EXECUTING','EXECUTION_UNKNOWN')"),
      foundationSourceRunning: countIfPresent(database, "foundation_source_runs", "UPPER(status)='RUNNING'"),
      growthAnalysisRunning: countIfPresent(database, "growth_analysis_runs", "LOWER(status) IN ('running','validating')"),
      imageGenerationRunning: countIfPresent(database, "product_image_generation_tasks", "LOWER(status) IN ('generating_prompt','waiting_generation','generating')"),
      imageBatchRunning: countIfPresent(database, "mabang_sku_image_batches", "LOWER(status) IN ('running','pause_requested')"),
      imageSyncRunning: countIfPresent(database, "mabang_sku_image_sync_runs", "LOWER(status)='running'"),
      lifecycleScanRunning: countIfPresent(database, "file_lifecycle_scans", "LOWER(status)='running'"),
    };
    return { ...activity, totalActive: Object.values(activity).reduce((sum, value) => sum + value, 0) };
  } finally {
    database.close();
  }
}

async function candidateState(config) {
  const provider = selectedProvider(config, { readOnly: true });
  try {
    const control = new SyncControlRepository({
      provider,
      stateId: PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
      targetProvider: PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
    });
    const status = await control.status();
    const runningBatches = Number((await provider.query(`
      SELECT COUNT(*)::integer count FROM shadow_meta.migration_sync_batches
      WHERE migration_state_id=$1 AND status='RUNNING'
    `, [PHASE3D_PRODUCTION_CANDIDATE_STATE_ID])).rows[0].count);
    const unsuccessfulTables = Number((await provider.query(`
      SELECT COUNT(*)::integer count FROM shadow_meta.migration_sync_table_state
      WHERE migration_state_id=$1 AND last_status<>'SUCCEEDED'
    `, [PHASE3D_PRODUCTION_CANDIDATE_STATE_ID])).rows[0].count);
    return {
      state: status.state,
      tables: status.tableStates.length,
      latestValidation: status.validations[0] || null,
      runningBatches,
      unsuccessfulTables,
    };
  } finally {
    await provider.close();
  }
}

async function sourceFootprint(databasePath) {
  const files = [];
  for (const suffix of ["", "-wal"]) {
    const filePath = `${databasePath}${suffix}`;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat) files.push({ file: path.basename(filePath), bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

async function preflight(runtime, config) {
  const [processes, activity, candidate, sourceFiles, filesystem] = await Promise.all([
    productionProcesses(),
    Promise.resolve(sourceActivity(runtime.databasePath)),
    candidateState(config),
    sourceFootprint(runtime.databasePath),
    fsp.statfs(path.dirname(runtime.databasePath)),
  ]);
  const writers = resolveProductionWriterState(processes);
  const sourceBytes = sourceFiles.reduce((sum, file) => sum + file.bytes, 0);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredFreeBytes = sourceBytes * 2 + 2 * 1024 ** 3;
  const checks = [
    { name: "Persistent provider is SQLite", status: String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase() === "sqlite" ? "PASS" : "FAIL" },
    { name: "Exact main writer state", status: writers.safe ? "PASS" : "FAIL", evidence: { state: writers.state, pids: writers.main.map((item) => item.pid) } },
    { name: "Exact scheduler writer state", status: writers.safe ? "PASS" : "FAIL", evidence: { state: writers.state, pids: writers.scheduler.map((item) => item.pid) } },
    { name: "No active source work", status: activity.totalActive === 0 ? "PASS" : "FAIL", evidence: activity },
    { name: "Candidate state READY/PASS", status: candidate.state?.stage === "READY" && candidate.state?.last_validation_status === "PASS" && candidate.state?.paused === false ? "PASS" : "FAIL" },
    { name: "Candidate not prematurely switch-ready", status: candidate.state?.is_switch_ready === false ? "PASS" : "FAIL" },
    { name: "No candidate batch/table failures", status: candidate.runningBatches === 0 && candidate.unsuccessfulTables === 0 ? "PASS" : "FAIL" },
    { name: "Final snapshot disk capacity", status: freeBytes >= requiredFreeBytes ? "PASS" : "FAIL", evidence: { freeBytes, requiredFreeBytes } },
  ];
  return { status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL", checks, writerState: writers.state, processes, activity, candidate, sourceFiles, freeBytes, requiredFreeBytes };
}

async function stopProductionWriters(expected) {
  const writerState = resolveProductionWriterState(expected);
  if (writerState.state === "FROZEN") {
    if ((await productionProcesses()).length !== 0) throw new Error("SQLite writer state changed after frozen preflight");
    return;
  }
  const roles = new Set(expected.map((process) => process.role));
  if (!roles.has("main") || !roles.has("scheduler")) throw new Error("Exact SQLite main and scheduler processes were not both identified");
  for (const item of [...expected].sort((left, right) => (left.role === "supervisor" ? -1 : right.role === "supervisor" ? 1 : 0))) {
    try { process.kill(item.pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await productionProcesses()).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const remaining = await productionProcesses();
  for (const item of remaining) {
    try { process.kill(item.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const residual = await productionProcesses();
  if (residual.length) throw new Error(`SQLite writer freeze failed for exact PIDs: ${residual.map((item) => item.pid).join(",")}`);
}

async function retainedSqliteBackup(runtime, runStamp) {
  await fsp.mkdir(backupDirectory, { recursive: true });
  const destinationPath = path.join(backupDirectory, `commerce-ops-pre-postgresql-cutover-${runStamp}.sqlite`);
  const info = await createSqliteMigrationSnapshot({
    sourcePath: runtime.databasePath,
    destinationPath,
    backupRatePages: 4096,
    pinReadSnapshot: true,
  });
  if (info.integrity !== "ok" || info.foreignKeyViolations !== 0) throw new Error("Final retained SQLite backup failed integrity gates");
  return { ...info, path: destinationPath, relativePath: path.relative(rootDir, destinationPath).split(path.sep).join("/") };
}

async function runJsonScript(relativeScript, args, env = process.env) {
  const { stdout } = await executeFile(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, relativeScript), ...args], {
    cwd: rootDir,
    env,
    windowsHide: true,
    timeout: 1_800_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

async function markSwitchReady(config, snapshotSha256) {
  const provider = selectedProvider(config);
  try {
    const control = new SyncControlRepository({
      provider,
      stateId: PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
      targetProvider: PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
    });
    return await control.markSwitchReady({ expectedSourceSnapshotSha256: snapshotSha256 });
  } finally {
    await provider.close();
  }
}

async function markSwitchNotReady(config) {
  const provider = selectedProvider(config);
  try {
    const control = new SyncControlRepository({
      provider,
      stateId: PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
      targetProvider: PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
    });
    return await control.markSwitchNotReady();
  } finally {
    await provider.close();
  }
}

async function atomicWriteProductionEnv(originalContent) {
  const content = applyProductionEnvironment(originalContent);
  const temporary = `${localEnvFile}.${process.pid}.cutover.tmp`;
  await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    await fsp.rename(temporary, localEnvFile);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return { file: path.basename(localEnvFile), keysUpdated: 8, databaseProvider: "postgres", productionMode: true };
}

function providerEnv(provider) {
  const production = provider === "postgres";
  return {
    ...process.env,
    DATABASE_PROVIDER: provider,
    POSTGRES_SHADOW_MODE: "false",
    POSTGRES_STAGING_MODE: "false",
    POSTGRES_CUTOVER_REHEARSAL_MODE: "false",
    POSTGRES_PRODUCTION_CANDIDATE_MODE: "false",
    POSTGRES_PRODUCTION_MODE: production ? "true" : "false",
    POSTGRES_PRODUCTION_CONFIRM_DATABASE: production ? PHASE3D_PRODUCTION_CANDIDATE_DATABASE : "",
    POSTGRES_PRODUCTION_CONFIRM_SCOPE: production ? PHASE3D_PRODUCTION_MODE_SCOPE : "",
  };
}

async function startProductionSupervisor(provider, runStamp) {
  await fsp.mkdir(path.join(rootDir, "logs"), { recursive: true });
  const logPath = path.join(rootDir, "logs", `postgresql-cutover-${provider}-${runStamp}.log`);
  const descriptor = fs.openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, "scripts", "start-all.mjs")], {
      cwd: rootDir,
      env: providerEnv(provider),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
    });
    child.unref();
  } finally {
    fs.closeSync(descriptor);
  }
  return { pid: child.pid, logPath, provider };
}

function healthRequest(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error("Health request timed out")));
    request.on("error", reject);
  });
}

async function verifyPostCutover(runtime, config) {
  let health = null;
  let processes = [];
  let identity = null;
  let lease = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    processes = await productionProcesses();
    try { health = await healthRequest(runtime.appPort); } catch {}
    const provider = selectedProvider(config, { readOnly: true, applicationRole: true });
    try {
      identity = (await provider.query("SELECT current_database() database,current_user username,current_setting('default_transaction_read_only') read_only")).rows[0];
      lease = (await provider.query("SELECT owner_id,lease_until,updated_at FROM app.scheduler_leases WHERE name='mabang_scheduler'")).rows[0] || null;
    } catch {} finally { await provider.close().catch(() => {}); }
    if (health?.statusCode === 200
      && processes.some((process) => process.role === "main")
      && processes.some((process) => process.role === "scheduler")
      && identity?.database === PHASE3D_PRODUCTION_CANDIDATE_DATABASE
      && identity?.username === config.appUser
      && lease && new Date(lease.lease_until).getTime() > Date.now()) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const result = {
    healthStatus: health?.statusCode || null,
    processRoles: [...new Set(processes.map((process) => process.role))].sort(),
    processIds: processes.map((process) => process.pid),
    identity,
    schedulerLeaseActive: Boolean(lease && new Date(lease.lease_until).getTime() > Date.now()),
  };
  result.status = result.healthStatus === 200
    && result.processRoles.includes("main")
    && result.processRoles.includes("scheduler")
    && result.identity?.database === PHASE3D_PRODUCTION_CANDIDATE_DATABASE
    && result.identity?.username === config.appUser
    && result.schedulerLeaseActive ? "PASS" : "FAIL";
  if (result.status !== "PASS") throw Object.assign(new Error(`Post-cutover service validation failed: ${JSON.stringify(result)}`), { evidence: result });
  return result;
}

async function writeReport(report) {
  await fsp.mkdir(reportDirectory, { recursive: true });
  const runStamp = report.runStamp || stamp();
  const filename = `COMMERCE-OPS-POSTGRESQL-PRODUCTION-CUTOVER-${runStamp}.json`;
  const reportPath = path.join(reportDirectory, filename);
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

export async function runProductionCutover(argv = process.argv.slice(2)) {
  loadLocalEnv(rootDir);
  const persistentProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (persistentProvider !== "sqlite") throw new Error("Production cutover may only begin while the persistent provider is SQLite");
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const config = loadPostgresqlF1Config({ rootDir });
  const invocation = resolveProductionCutoverInvocation(argv, config);
  const initial = await preflight(runtime, config);
  if (!invocation.apply) {
    return {
      status: initial.status === "PASS" ? "AWAITING_FINAL_CONFIRMATION" : "BLOCKED",
      contract: PHASE3D_PRODUCTION_CUTOVER_CONTRACT,
      target: invocation.targetDatabase,
      sourceProvider: "sqlite",
      preflight: initial,
      applyCommand: productionCutoverApplyCommand(),
      sequence: ["freeze exact SQLite writers", "retained SQLite backup", "final full-source refresh", "zero-difference validation", "encrypted PostgreSQL backup", "mark switch-ready", "persistent provider switch", "main/scheduler health validation"],
      irreversibleBoundary: "After PostgreSQL-only business writes, no automatic reverse synchronization to SQLite exists.",
      productionChanged: false,
      isSwitchReady: false,
    };
  }
  if (initial.status !== "PASS") throw Object.assign(new Error("Production cutover preflight is blocked"), { code: "PRODUCTION_CUTOVER_PREFLIGHT_BLOCKED", evidence: initial });

  const runStamp = stamp();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const originalEnvContent = await fsp.readFile(localEnvFile, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error));
  let writersFrozen = false;
  let switchReadyMarked = false;
  let persistentConfigChanged = false;
  let retainedBackup = null;
  let finalSync = null;
  let encryptedBackup = null;
  let service = null;
  try {
    await stopProductionWriters(initial.processes);
    writersFrozen = true;
    assert.equal((await productionProcesses()).length, 0, "Exact SQLite writers must remain stopped");
    assert.equal(sourceActivity(runtime.databasePath).totalActive, 0, "Source work became active during writer freeze");
    const frozenFootprint = await sourceFootprint(runtime.databasePath);
    retainedBackup = await retainedSqliteBackup(runtime, runStamp);
    finalSync = await runProductionCandidateSync(FINAL_SYNC_ARGS);
    if (finalSync.status !== "PASS" || finalSync.validation?.status !== "PASS" || finalSync.gates?.some((gate) => gate.status !== "PASS")) {
      throw new Error("Final production candidate synchronization did not pass every gate");
    }
    assert.deepEqual(await sourceFootprint(runtime.databasePath), frozenFootprint, "SQLite source files changed during final synchronization");
    assert.equal((await productionProcesses()).length, 0, "SQLite writers restarted during final synchronization");
    encryptedBackup = await runJsonScript("scripts/postgresql-production-backup.mjs", [
      "--apply",
      `--database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`,
      `--confirm-database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`,
    ], providerEnv("sqlite"));
    if (encryptedBackup.status !== "PASS" || encryptedBackup.plaintextRetained !== false) throw new Error("Final encrypted PostgreSQL backup failed");
    const readyState = await markSwitchReady(config, finalSync.snapshot.sha256);
    assert.equal(readyState.is_switch_ready, true);
    switchReadyMarked = true;
    const configChange = await atomicWriteProductionEnv(originalEnvContent);
    persistentConfigChanged = true;
    const supervisor = await startProductionSupervisor("postgres", runStamp);
    service = await verifyPostCutover(runtime, config);
    const report = {
      status: "PASS",
      contract: PHASE3D_PRODUCTION_CUTOVER_CONTRACT,
      runStamp,
      startedAt,
      completedAt: new Date().toISOString(),
      sourceProviderBefore: "sqlite",
      productionProviderAfter: "postgres",
      target: PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
      config: publicPostgresqlF1Config(config),
      preflight: initial,
      writerFreeze: { status: "PASS", exactProcessesStopped: initial.processes.map(({ pid, role }) => ({ pid, role })) },
      retainedSqliteBackup: retainedBackup,
      finalSynchronization: {
        status: finalSync.status,
        snapshotSha256: finalSync.snapshot.sha256,
        source: finalSync.source,
        synchronization: finalSync.synchronization,
        validation: {
          status: finalSync.validation.status,
          tables: finalSync.validation.tables.length,
          failures: finalSync.validation.failures,
          foreignKeys: finalSync.validation.foreignKeys,
          indexes: finalSync.validation.indexes,
          samples: finalSync.validation.samples,
        },
        gates: finalSync.gates,
        report: finalSync.report,
      },
      encryptedPostgresqlBackup: {
        status: encryptedBackup.status,
        artifact: encryptedBackup.artifact,
        encryptedSha256: encryptedBackup.encryptedSha256,
        encryptedBytes: encryptedBackup.encryptedBytes,
        encryption: encryptedBackup.encryption,
        plaintextRetained: encryptedBackup.plaintextRetained,
      },
      switchReady: true,
      persistentConfig: configChange,
      supervisor,
      service,
      sqliteProductionModified: false,
      externalCallsDuringMigration: 0,
      durationMs: Math.round(performance.now() - started),
      rollbackBoundary: "SQLite retained backup is the pre-cutover rollback point. PostgreSQL-only writes are not automatically reverse-synchronized.",
    };
    report.report = await writeReport(report);
    return report;
  } catch (error) {
    const detail = safeError(error);
    if (!persistentConfigChanged) {
      if (switchReadyMarked) await markSwitchNotReady(config).catch(() => {});
      if (writersFrozen && (await productionProcesses().catch(() => [])).length === 0) {
        await startProductionSupervisor("sqlite", `${runStamp}-recovery`).catch(() => {});
      }
    }
    const failure = {
      status: "FAIL",
      contract: PHASE3D_PRODUCTION_CUTOVER_CONTRACT,
      runStamp,
      startedAt,
      failedAt: new Date().toISOString(),
      stage: persistentConfigChanged ? "POST_PROVIDER_SWITCH" : writersFrozen ? "FROZEN_PRE_SWITCH" : "PREFLIGHT",
      error: detail,
      writersFrozen,
      switchReadyMarked,
      persistentConfigChanged,
      retainedSqliteBackup: retainedBackup,
      finalSynchronizationReport: finalSync?.report || null,
      encryptedPostgresqlBackup: encryptedBackup?.artifact || null,
      postCutoverEvidence: error?.evidence || service,
      automaticRecovery: persistentConfigChanged ? "BLOCKED_NO_REVERSE_SYNC" : "SQLITE_SUPERVISOR_RESTART_REQUESTED",
    };
    failure.report = await writeReport(failure).catch(() => null);
    throw Object.assign(new Error(`${detail.message}${failure.report ? `; report=${failure.report}` : ""}`), { code: detail.code, evidence: failure });
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  runProductionCutover().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    const detail = safeError(error);
    process.stderr.write(`PostgreSQL production cutover failed [${detail.code}]: ${detail.message}\n`);
    process.exitCode = 1;
  });
}
