import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { loadLocalEnv } from "../lib/env.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import {
  loadPostgresqlStagingConfig,
  POSTGRESQL_STAGING_DATABASE,
} from "../lib/postgresql/staging-config.mjs";
import { resolvePhase3cStagingInvocation } from "../lib/postgresql/phase3c-staging.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { quoteIdentifier } from "../lib/postgresql/sqlite-migration.mjs";

const executeFile = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const RESTORE_DATABASE = "commerce_ops_staging_restore_20260806";
const MAGIC = Buffer.from("COPSPG3CENC1\n", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

function provider(base, { database, user, password, readOnly = false }) {
  return new PostgresqlProvider({
    config: Object.freeze({ ...base, schema: "app", statementTimeoutMs: 300_000 }),
    database,
    user,
    password,
    readOnly,
  });
}

async function sha256(filePath) {
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).on("data", (chunk) => digest.update(chunk)).on("end", resolve).on("error", reject);
  });
  return digest.digest("hex");
}

async function encryptFile(inputPath, outputPath, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath, { mode: 0o600 });
    const fail = (error) => reject(error);
    input.once("error", fail);
    cipher.once("error", fail);
    output.once("error", fail);
    output.once("finish", resolve);
    output.write(Buffer.concat([MAGIC, iv]));
    cipher.once("end", () => output.end(cipher.getAuthTag()));
    input.pipe(cipher).pipe(output, { end: false });
  });
}

async function decryptFile(inputPath, outputPath, key) {
  const handle = await fsp.open(inputPath, "r");
  try {
    const stat = await handle.stat();
    const header = Buffer.alloc(MAGIC.length + IV_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, stat.size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Encrypted backup magic header is invalid");
    const iv = header.subarray(MAGIC.length);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(inputPath, {
        start: header.length,
        end: stat.size - TAG_BYTES - 1,
      });
      const output = fs.createWriteStream(outputPath, { mode: 0o600 });
      const fail = (error) => reject(error);
      input.once("error", fail);
      decipher.once("error", fail);
      output.once("error", fail);
      output.once("finish", resolve);
      input.pipe(decipher).pipe(output);
    });
  } finally {
    await handle.close();
  }
}

async function cli(command, args, password, timeout = 900_000) {
  const result = await executeFile(command, args, {
    cwd: rootDir,
    env: { ...process.env, PGPASSWORD: password },
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim() };
}

async function relationEvidence(selected) {
  const [schemas, migrations, business, size] = await Promise.all([
    selected.query(`SELECT table_schema,COUNT(*)::integer tables
      FROM information_schema.tables WHERE table_schema IN ('app','ai_shadow','shadow_meta')
      GROUP BY table_schema ORDER BY table_schema`),
    selected.query("SELECT version,sha256 FROM shadow_meta.schema_migrations ORDER BY version"),
    selected.query(`SELECT
      (SELECT COUNT(*)::text FROM app.product_skus) product_skus,
      (SELECT COUNT(*)::text FROM app.growth_order_headers) order_headers,
      (SELECT COUNT(*)::text FROM app.growth_order_lines) order_lines,
      (SELECT COUNT(*)::text FROM app.growth_inventory_snapshots) inventory_snapshots,
      (SELECT COUNT(*)::text FROM app.foundation_tasks) tasks,
      (SELECT COUNT(*)::text FROM app.operation_audit_events) audit_events,
      (SELECT COUNT(*)::text FROM ai_shadow.agent_runs) agent_runs,
      (SELECT COUNT(*)::text FROM ai_shadow.tool_invocations) tool_invocations`),
    selected.query("SELECT pg_database_size(current_database())::text bytes"),
  ]);
  return {
    schemas: schemas.rows,
    migrations: migrations.rows,
    business: business.rows[0],
    bytes: size.rows[0].bytes,
  };
}

async function latencySamples(selected, query, count = 30) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await selected.query(query);
    values.push(Number((performance.now() - started).toFixed(3)));
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
  return {
    samples: count,
    minMs: sorted[0],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
  };
}

async function main() {
  loadLocalEnv(rootDir);
  if (String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase() !== "sqlite") {
    throw new Error("Phase 3C operations rehearsal requires production DATABASE_PROVIDER=sqlite");
  }
  const base = loadPostgresqlF1Config({ rootDir });
  const invocation = resolvePhase3cStagingInvocation(process.argv.slice(2), base);
  if (!invocation.apply) {
    return {
      status: "PLAN",
      target: POSTGRESQL_STAGING_DATABASE,
      restoreTarget: RESTORE_DATABASE,
      applyCommand: `npm run postgres:phase3c:operations -- --apply --confirm-database=${POSTGRESQL_STAGING_DATABASE}`,
    };
  }
  const staging = loadPostgresqlStagingConfig({ rootDir });
  const evidenceRoot = path.join(rootDir, "tmp", "postgresql-phase3c", "operations");
  const backupRoot = path.join(evidenceRoot, "backup");
  await fsp.mkdir(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const plainDump = path.join(backupRoot, `commerce-ops-staging-${stamp}.dump`);
  const encryptedDump = `${plainDump}.aes256gcm`;
  const keyPath = `${plainDump}.key`;
  const decryptedDump = `${plainDump}.restore.tmp`;
  const stagingProvider = provider(base, {
    database: staging.database,
    user: base.migratorUser,
    password: base.migratorPassword,
    readOnly: true,
  });
  const admin = provider(base, {
    database: "postgres",
    user: base.adminUser,
    password: base.adminPassword,
  });
  let restoreProvider = null;
  try {
    const source = await relationEvidence(stagingProvider);
    const backupStarted = performance.now();
    await cli("pg_dump", [
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--file", plainDump,
      "--host", base.host,
      "--port", String(base.port),
      "--username", base.migratorUser,
      "--dbname", staging.database,
    ], base.migratorPassword);
    const plainSha256 = await sha256(plainDump);
    const key = crypto.randomBytes(32);
    await encryptFile(plainDump, encryptedDump, key);
    await fsp.writeFile(keyPath, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600 });
    try { await fsp.chmod(keyPath, 0o600); } catch {}
    const encryptedSha256 = await sha256(encryptedDump);
    const encryptedBytes = (await fsp.stat(encryptedDump)).size;
    await fsp.rm(plainDump, { force: true });
    await decryptFile(encryptedDump, decryptedDump, key);
    assert.equal(await sha256(decryptedDump), plainSha256);

    const restoreExists = Boolean((await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) present",
      [RESTORE_DATABASE],
    )).rows[0].present);
    if (restoreExists) throw new Error(`Restore rehearsal database already exists: ${RESTORE_DATABASE}`);
    await admin.executeScript(`CREATE DATABASE ${quoteIdentifier(RESTORE_DATABASE)} OWNER ${quoteIdentifier(base.migratorUser)}`);
    await admin.executeScript(`REVOKE ALL ON DATABASE ${quoteIdentifier(RESTORE_DATABASE)} FROM PUBLIC`);
    await admin.executeScript(`GRANT CONNECT ON DATABASE ${quoteIdentifier(RESTORE_DATABASE)} TO ${quoteIdentifier(base.migratorUser)}`);
    await cli("pg_restore", [
      "--exit-on-error",
      "--no-owner",
      "--host", base.host,
      "--port", String(base.port),
      "--username", base.migratorUser,
      "--dbname", RESTORE_DATABASE,
      decryptedDump,
    ], base.migratorPassword);
    await fsp.rm(decryptedDump, { force: true });
    restoreProvider = provider(base, {
      database: RESTORE_DATABASE,
      user: base.migratorUser,
      password: base.migratorPassword,
      readOnly: true,
    });
    const restored = await relationEvidence(restoreProvider);
    assert.deepEqual(restored.schemas, source.schemas);
    assert.deepEqual(restored.migrations, source.migrations);
    assert.deepEqual(restored.business, source.business);

    const appProvider = provider(base, {
      database: staging.database,
      user: staging.appUser,
      password: staging.appPassword,
      readOnly: true,
    });
    try {
      const [settings, databaseStats, locks, activity, simpleLatency, businessLatency] = await Promise.all([
        appProvider.query(`SELECT name,setting FROM pg_settings WHERE name=ANY($1::text[]) ORDER BY name`, [[
          "max_connections", "shared_buffers", "work_mem", "effective_cache_size",
          "ssl", "archive_mode", "log_min_duration_statement", "track_io_timing", "shared_preload_libraries",
        ]]),
        appProvider.query(`SELECT numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_files,temp_bytes,deadlocks
          FROM pg_stat_database WHERE datname=current_database()`),
        appProvider.query("SELECT mode,granted,COUNT(*)::integer count FROM pg_locks GROUP BY mode,granted ORDER BY mode,granted"),
        appProvider.query("SELECT state,COUNT(*)::integer count FROM pg_stat_activity WHERE datname=current_database() GROUP BY state ORDER BY state"),
        latencySamples(appProvider, "SELECT 1", 30),
        latencySamples(appProvider, "SELECT COUNT(*) FROM app.product_skus", 20),
      ]);
      const extension = (await appProvider.query(
        "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements') installed",
      )).rows[0].installed;
      const output = {
        status: "SIMULATION_PASS",
        target: staging.database,
        productionProvider: "sqlite",
        productionTouched: false,
        backup: {
          status: "SIMULATION_PASS",
          format: "pg_dump custom",
          encryption: "AES-256-GCM",
          encryptedArtifact: path.relative(rootDir, encryptedDump).split(path.sep).join("/"),
          keyArtifact: path.relative(rootDir, keyPath).split(path.sep).join("/"),
          keyCoLocated: true,
          plaintextRetained: false,
          plainSha256,
          encryptedSha256,
          encryptedBytes,
          durationMs: Math.round(performance.now() - backupStarted),
          retentionDays: 7,
          productionLimitation: "local artifact and key are co-located; production KMS/object-lock evidence remains required",
        },
        restore: {
          status: "SIMULATION_PASS",
          database: RESTORE_DATABASE,
          independent: RESTORE_DATABASE !== staging.database,
          schemaMatch: true,
          migrationLedgerMatch: true,
          businessCountsMatch: true,
          source,
          restored,
        },
        monitoring: {
          status: "SIMULATION_PASS",
          databaseStats: databaseStats.rows[0],
          locks: locks.rows,
          activity: activity.rows,
          settings: Object.fromEntries(settings.rows.map((row) => [row.name, row.setting])),
          pgStatStatementsInstalled: Boolean(extension),
          productionLimitation: "snapshot queries exist, but alert routing, SLOs, and production dashboards are not approved",
        },
        capacity: {
          status: "SIMULATION_PASS",
          databaseBytes: source.bytes,
          simpleLatency,
          productCountLatency: businessLatency,
          productionLimitation: "loopback single-client sample is not a production concurrency or load test",
        },
      };
      await fsp.writeFile(path.join(evidenceRoot, "operations-rehearsal-result.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
      return output;
    } finally {
      await appProvider.close();
    }
  } finally {
    if (restoreProvider) await restoreProvider.close();
    await stagingProvider.close();
    await admin.close();
    await fsp.rm(plainDump, { force: true }).catch(() => {});
    await fsp.rm(decryptedDump, { force: true }).catch(() => {});
  }
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  const code = String(error?.code || "PHASE3C_OPERATIONS_FAILED").slice(0, 80);
  const message = String(error?.message || error).split(/\r?\n/)[0].slice(0, 400);
  process.stderr.write(`PostgreSQL Phase 3C operations rehearsal failed [${code}]: ${message}\n`);
  process.exitCode = 1;
});

