import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { loadPostgresqlStagingConfig, POSTGRESQL_STAGING_DATABASE } from "../lib/postgresql/staging-config.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const TABLE = "phase3c_capacity_probe";

function option(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  return raw === undefined ? fallback : raw;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function stats(provider) {
  const [database, activity, locks, wal, migrations] = await Promise.all([
    provider.query(`SELECT pg_database_size(current_database())::text database_bytes,
      numbackends,xact_commit,xact_rollback,blks_read,blks_hit,blk_read_time,blk_write_time,temp_files,temp_bytes,deadlocks
      FROM pg_stat_database WHERE datname=current_database()`),
    provider.query(`SELECT COUNT(*)::integer connections,
      COUNT(*) FILTER (WHERE wait_event_type='Lock')::integer lock_waiters,
      (SELECT setting::integer FROM pg_settings WHERE name='max_connections') max_connections
      FROM pg_stat_activity WHERE backend_type='client backend'`),
    provider.query("SELECT COUNT(*) FILTER (WHERE NOT granted)::integer waiting_locks FROM pg_locks"),
    provider.query("SELECT pg_current_wal_lsn()::text lsn"),
    provider.query("SELECT version,sha256 FROM shadow_meta.schema_migrations ORDER BY version"),
  ]);
  return { database: database.rows[0], activity: activity.rows[0], locks: locks.rows[0], walLsn: wal.rows[0].lsn, migrations: migrations.rows };
}

async function main() {
  loadLocalEnv(rootDir);
  if (String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase() !== "sqlite") {
    throw new Error("Capacity baseline requires production DATABASE_PROVIDER=sqlite");
  }
  const apply = process.argv.includes("--apply");
  const database = option("database", POSTGRESQL_STAGING_DATABASE);
  const concurrency = Number(option("concurrency", "8"));
  const durationSeconds = Number(option("duration-seconds", "20"));
  if (database !== POSTGRESQL_STAGING_DATABASE) throw new Error("Capacity baseline is restricted to commerce_ops_staging");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 24) throw new Error("Capacity concurrency must be 1..24");
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 300) throw new Error("Capacity duration must be 5..300 seconds");
  if (!apply) return { status: "PLAN", database, concurrency, durationSeconds, productionProvider: "sqlite" };
  if (option("confirm-database", "") !== database) throw new Error(`Capacity baseline requires --confirm-database=${database}`);
  const config = loadPostgresqlF1Config({ rootDir });
  const staging = loadPostgresqlStagingConfig({ rootDir });
  const migrator = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 300_000, poolMax: 3 }),
    database, user: config.migratorUser, password: config.migratorPassword,
  });
  const application = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 30_000, poolMax: Math.max(concurrency + 2, 10) }),
    database, user: staging.appUser, password: staging.appPassword,
  });
  let created = false;
  try {
    const present = (await migrator.query(`SELECT to_regclass('app.${TABLE}') IS NOT NULL present`)).rows[0].present;
    if (present) throw new Error(`Capacity fixture already exists: app.${TABLE}`);
    await migrator.executeScript(`CREATE TABLE app.${TABLE} (
      id uuid PRIMARY KEY,
      worker_id integer NOT NULL,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    created = true;
    await migrator.executeScript(`GRANT SELECT,INSERT,UPDATE,DELETE ON app.${TABLE} TO ${staging.appUser}`);
    const applicationCanCreate = (await application.query("SELECT has_schema_privilege(current_user,'app','CREATE') allowed")).rows[0].allowed;
    if (applicationCanCreate) throw new Error("Capacity test application role unexpectedly has schema CREATE");
    const before = await stats(migrator);
    const samples = [];
    const errors = [];
    let transactions = 0;
    let operations = 0;
    const deadline = performance.now() + durationSeconds * 1_000;
    const started = performance.now();
    async function worker(workerId) {
      while (performance.now() < deadline) {
        const id = crypto.randomUUID();
        const transactionStarted = performance.now();
        try {
          await application.transaction(async (tx) => {
            await tx.query(`INSERT INTO app.${TABLE}(id,worker_id,payload) VALUES($1,$2,$3::jsonb)`, [id, workerId, JSON.stringify({ source: "phase3c-capacity", sequence: transactions })]);
            await tx.query(`SELECT payload FROM app.${TABLE} WHERE id=$1`, [id]);
            await tx.query(`UPDATE app.${TABLE} SET payload=payload||$2::jsonb,updated_at=now() WHERE id=$1`, [id, JSON.stringify({ verified: true })]);
            await tx.query(`DELETE FROM app.${TABLE} WHERE id=$1`, [id]);
          });
          samples.push(performance.now() - transactionStarted);
          transactions += 1;
          operations += 4;
        } catch (error) {
          errors.push(String(error?.code || error?.message || "WORKLOAD_ERROR").slice(0, 120));
          if (errors.length >= 10) return;
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1)));
    const elapsedSeconds = (performance.now() - started) / 1_000;
    const after = await stats(migrator);
    const wal = await migrator.query("SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::text bytes", [after.walLsn, before.walLsn]);
    const disk = await fsp.statfs(path.parse(rootDir).root);
    const totalBytes = Number(disk.blocks) * Number(disk.bsize);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const diskFreePercent = Number((freeBytes / totalBytes * 100).toFixed(3));
    const sorted = samples.map((value) => Number(value.toFixed(3))).sort((left, right) => left - right);
    const throughput = Number((operations / elapsedSeconds).toFixed(3));
    const p95Ms = percentile(sorted, 0.95);
    const peakConnectionUtilizationPercent = Number((Number(after.activity.connections) / Number(after.activity.max_connections) * 100).toFixed(3));
    const thresholds = { minimumOperationsPerSecond: 100, maximumP95TransactionMs: 100, maximumErrors: 0, maximumLockWaiters: 0, minimumDiskFreePercent: 25, maximumConnectionUtilizationPercent: 70 };
    const gates = {
      throughput: throughput >= thresholds.minimumOperationsPerSecond,
      latency: p95Ms <= thresholds.maximumP95TransactionMs,
      errors: errors.length <= thresholds.maximumErrors,
      locks: Number(after.activity.lock_waiters) <= thresholds.maximumLockWaiters && Number(after.locks.waiting_locks) <= thresholds.maximumLockWaiters,
      disk: diskFreePercent >= thresholds.minimumDiskFreePercent,
      connections: peakConnectionUtilizationPercent <= thresholds.maximumConnectionUtilizationPercent,
    };
    const runStamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const report = {
      contract: "COMMERCE-OPS-POSTGRESQL-CAPACITY-BASELINE-1.0.0",
      status: Object.values(gates).every(Boolean) ? "PASS" : "FAIL",
      measuredAt: new Date().toISOString(), database, workloadVersion: "isolated-app-dml-1.0.0",
      dataset: { databaseBytes: before.database.database_bytes, schemaChecksum: crypto.createHash("sha256").update(JSON.stringify(before.migrations)).digest("hex"), migrationCount: before.migrations.length },
      workload: { concurrency, durationSeconds: Number(elapsedSeconds.toFixed(3)), transactions, operations, operationsPerSecond: throughput, errors },
      latencyMs: { samples: sorted.length, p50: percentile(sorted, 0.5), p95: p95Ms, p99: percentile(sorted, 0.99), maximum: sorted.at(-1) || null },
      resources: {
        cpuModel: os.cpus()[0]?.model || "unknown", cpuLogicalCount: os.cpus().length, memoryBytes: os.totalmem(),
        diskTotalBytes: totalBytes, diskFreeBytes: freeBytes, diskFreePercent,
        peakConnectionUtilizationPercent, walBytes: wal.rows[0].bytes,
        databaseGrowthBytes: String(BigInt(after.database.database_bytes) - BigInt(before.database.database_bytes)),
        io: { before: before.database, after: after.database },
      },
      thresholds, gates,
      applicationRole: staging.appUser, applicationDdlAllowed: false,
      fixtureCleanup: `DROP TABLE app.${TABLE}`,
      approval: { status: Object.values(gates).every(Boolean) ? "APPROVED" : "REJECTED", owner: "Commerce Ops infrastructure operator" },
      productionProvider: "sqlite", sqliteTouched: false, providerSwitched: false,
    };
    const reportName = `COMMERCE-OPS-POSTGRESQL-CAPACITY-BASELINE-${runStamp}.json`;
    await fsp.writeFile(path.join(rootDir, "docs", "reports", reportName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ...report, report: reportName };
  } finally {
    await application.close();
    if (created) await migrator.executeScript(`DROP TABLE IF EXISTS app.${TABLE}`).catch(() => {});
    await migrator.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`PostgreSQL capacity baseline failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
  process.exitCode = 1;
});

