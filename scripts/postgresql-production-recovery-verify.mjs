import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { POSTGRESQL_STAGING_DATABASE } from "../lib/postgresql/staging-config.mjs";
import { PHASE3D_PRODUCTION_CANDIDATE_DATABASE } from "../lib/postgresql/phase3d-production-candidate.mjs";
import { decryptFile, readEncryptionKey, sha256File } from "../lib/postgresql/infrastructure/encrypted-artifact.mjs";
import { quoteIdentifier } from "../lib/postgresql/sqlite-migration.mjs";
import { resolveProductionOperationalContext } from "../lib/postgresql/production-operational-context.mjs";

const executeFile = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const reportDirectory = path.join(rootDir, "docs", "reports");
const RESTORE_PREFIX = "commerce_ops_restore_verify_";

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || null;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function runtimePaths() {
  const driveRoot = path.parse(rootDir).root;
  const backupRoot = process.env.COMMERCE_OPS_POSTGRES_BACKUP_ROOT || path.join(driveRoot, "PostgreSQLBackups");
  const secretRoot = process.env.COMMERCE_OPS_POSTGRES_SECRET_ROOT
    || path.join(process.env.ProgramData || process.env.ALLUSERSPROFILE || driveRoot, "CommerceOps", "PostgreSQL", "secrets");
  return { backupDirectory: path.join(backupRoot, "logical"), keyFile: path.join(secretRoot, "logical-backup.key") };
}

function provider(config, { database, user, password, readOnly = false }) {
  return new PostgresqlProvider({
    config: Object.freeze({ ...config, schema: "app", statementTimeoutMs: 300_000 }),
    database, user, password, readOnly,
  });
}

async function cli(command, args, password, config, timeout = 1_800_000) {
  const tls = config.ssl ? { PGSSLMODE: "verify-full", PGSSLROOTCERT: config.sslCaFile } : {};
  return executeFile(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...tls, PGPASSWORD: password },
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function latestManifest(directory, database) {
  const prefix = `commerce-ops-${database}-`;
  const names = (await fsp.readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith(".manifest.json")).sort().reverse();
  if (!names.length) throw new Error(`No encrypted backup manifest exists for ${database}`);
  const manifestPath = path.join(directory, names[0]);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.status !== "PASS" || manifest.database !== database || manifest.plaintextRetained !== false) {
    throw new Error("Latest encrypted backup manifest is not eligible for restore verification");
  }
  return { manifest, manifestPath, artifactPath: path.join(directory, manifest.artifact) };
}

async function restoredEvidence(selected) {
  const identity = (await selected.query(`SELECT current_database() database,current_user username,
    current_setting('server_version') server_version,pg_database_size(current_database())::text database_bytes`)).rows[0];
  const schemas = (await selected.query(`SELECT table_schema,COUNT(*)::integer tables
    FROM information_schema.tables WHERE table_schema IN ('app','ai_shadow','shadow_meta')
    GROUP BY table_schema ORDER BY table_schema`)).rows;
  const migrations = (await selected.query("SELECT version,sha256 FROM shadow_meta.schema_migrations ORDER BY version")).rows;
  const counts = (await selected.query(`SELECT
    (SELECT COUNT(*)::text FROM app.product_skus) product_skus,
    (SELECT COUNT(*)::text FROM app.growth_order_headers) order_headers,
    (SELECT COUNT(*)::text FROM app.growth_inventory_snapshots) inventory_snapshots,
    (SELECT COUNT(*)::text FROM app.foundation_tasks) tasks,
    (SELECT COUNT(*)::text FROM app.operation_audit_events) audit_events,
    (SELECT COUNT(*)::text FROM ai_shadow.agent_runs) agent_runs,
    (SELECT COUNT(*)::text FROM ai_shadow.tool_invocations) tool_invocations`)).rows[0];
  const integrity = (await selected.query(`SELECT
    (SELECT COUNT(*)::integer FROM pg_constraint WHERE contype='f' AND NOT convalidated) invalid_foreign_keys,
    (SELECT COUNT(*)::integer FROM pg_index WHERE NOT indisvalid OR NOT indisready) invalid_indexes`)).rows[0];
  return { identity, schemas, migrations, counts, integrity };
}

async function main() {
  loadLocalEnv(rootDir);
  const current = resolveProductionOperationalContext({ env: process.env });
  const database = option("database") || (current.formalCutover ? PHASE3D_PRODUCTION_CANDIDATE_DATABASE : POSTGRESQL_STAGING_DATABASE);
  const operational = resolveProductionOperationalContext({ env: process.env, database });
  const apply = process.argv.includes("--apply");
  if (!new Set([POSTGRESQL_STAGING_DATABASE, PHASE3D_PRODUCTION_CANDIDATE_DATABASE]).has(database)) {
    throw new Error("Automated readiness restore is restricted to staging or the explicitly confirmed production candidate backup");
  }
  if (!apply) return { status: "PLAN", source: database, productionProvider: operational.provider, productionTouched: false };
  if (option("confirm-database") !== database) throw new Error(`Restore verification requires --confirm-database=${database}`);
  const config = loadPostgresqlF1Config({ rootDir });
  const paths = runtimePaths();
  const { manifest, artifactPath } = await latestManifest(paths.backupDirectory, database);
  assert.equal(await sha256File(artifactPath), manifest.encryptedSha256, "Encrypted backup digest mismatch");
  const key = await readEncryptionKey(paths.keyFile);
  const runStamp = timestamp();
  const restoreDatabase = `${RESTORE_PREFIX}${runStamp}`;
  if (!new RegExp(`^${RESTORE_PREFIX}[0-9]{14}$`).test(restoreDatabase)) throw new Error("Restore verification database name is unsafe");
  const plainPath = path.join(paths.backupDirectory, `${restoreDatabase}.${process.pid}.restore.tmp`);
  const admin = provider(config, { database: "postgres", user: config.adminUser, password: config.adminPassword });
  let restored = null;
  const startedAt = new Date();
  const started = performance.now();
  try {
    const exists = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) present", [restoreDatabase])).rows[0].present;
    if (exists) throw new Error(`Restore verification target already exists: ${restoreDatabase}`);
    await decryptFile(artifactPath, plainPath, key);
    assert.equal(await sha256File(plainPath), manifest.plaintextSha256, "Decrypted backup digest mismatch");
    await admin.executeScript(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)} OWNER ${quoteIdentifier(config.migratorUser)}`);
    await admin.executeScript(`REVOKE ALL ON DATABASE ${quoteIdentifier(restoreDatabase)} FROM PUBLIC`);
    await admin.executeScript(`GRANT CONNECT ON DATABASE ${quoteIdentifier(restoreDatabase)} TO ${quoteIdentifier(config.migratorUser)}`);
    const restoreAdmin = provider(config, { database: restoreDatabase, user: config.adminUser, password: config.adminPassword });
    try {
      await restoreAdmin.executeScript("CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public");
    } finally {
      await restoreAdmin.close();
    }
    await cli("pg_restore", [
      "--exit-on-error", "--no-owner", "--no-privileges",
      "--host", config.host, "--port", String(config.port), "--username", config.migratorUser,
      "--dbname", restoreDatabase, plainPath,
    ], config.migratorPassword, config);
    restored = provider(config, { database: restoreDatabase, user: config.migratorUser, password: config.migratorPassword, readOnly: true });
    const evidence = await restoredEvidence(restored);
    assert.equal(evidence.identity.database, restoreDatabase);
    if (JSON.stringify(evidence.schemas) !== JSON.stringify(manifest.evidence.schemas)) {
      throw new Error(`Schema evidence mismatch: expected=${JSON.stringify(manifest.evidence.schemas)} actual=${JSON.stringify(evidence.schemas)}`);
    }
    if (JSON.stringify(evidence.migrations) !== JSON.stringify(manifest.evidence.migrations)) {
      throw new Error(`Migration evidence mismatch: expected=${JSON.stringify(manifest.evidence.migrations)} actual=${JSON.stringify(evidence.migrations)}`);
    }
    if (JSON.stringify(evidence.counts) !== JSON.stringify(manifest.evidence.counts)) {
      throw new Error(`Business count mismatch: expected=${JSON.stringify(manifest.evidence.counts)} actual=${JSON.stringify(evidence.counts)}`);
    }
    assert.equal(evidence.integrity.invalid_foreign_keys, 0);
    assert.equal(evidence.integrity.invalid_indexes, 0);
    const durationSeconds = Number(((performance.now() - started) / 1_000).toFixed(3));
    const status = durationSeconds <= 3_600 ? "PASS" : "FAIL";
    const report = {
      contract: "COMMERCE-OPS-POSTGRESQL-AUTOMATED-RESTORE-1.0.0",
      status,
      sourceDatabase: database,
      restoreDatabase,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds,
      recoveryTimeObjectiveSeconds: 3_600,
      encryptedDigestVerified: true,
      decryptedDigestVerified: true,
      schemaMatch: true,
      migrationLedgerMatch: true,
      businessCountsMatch: true,
      invalidForeignKeys: 0,
      invalidIndexes: 0,
      sourceEvidence: manifest.evidence,
      restoredEvidence: evidence,
      cleanupPolicy: "automatic exact-prefix database removal",
      productionProvider: operational.provider,
      sqliteTouched: false,
      providerSwitched: false,
    };
    await fsp.mkdir(reportDirectory, { recursive: true });
    const reportName = `COMMERCE-OPS-POSTGRESQL-RESTORE-REHEARSAL-${runStamp}.json`;
    await fsp.writeFile(path.join(reportDirectory, reportName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ...report, report: reportName };
  } finally {
    if (restored) await restored.close();
    await fsp.rm(plainPath, { force: true }).catch(() => {});
    const present = await admin.query("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) present", [restoreDatabase]).then((result) => result.rows[0].present).catch(() => false);
    if (present) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [restoreDatabase]);
      await admin.executeScript(`DROP DATABASE ${quoteIdentifier(restoreDatabase)}`);
    }
    await admin.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  const detail = String(error?.stderr || error?.message || error).split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ").slice(0, 800);
  process.stderr.write(`PostgreSQL automated recovery verification failed: ${detail}\n`);
  process.exitCode = 1;
});
