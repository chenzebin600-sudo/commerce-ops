import fsp from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { POSTGRESQL_STAGING_DATABASE } from "../lib/postgresql/staging-config.mjs";
import { resolveProductionOperationalContext } from "../lib/postgresql/production-operational-context.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || null;
}

function envValue(text, name) {
  return text.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() || null;
}

async function newestAge(directory, predicate) {
  const files = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  let newest = null;
  for (const entry of files) {
    if (!entry.isFile() || !predicate(entry.name)) continue;
    const stat = await fsp.stat(path.join(directory, entry.name));
    newest = newest === null ? stat.mtimeMs : Math.max(newest, stat.mtimeMs);
  }
  return newest === null ? null : Number(((Date.now() - newest) / 3_600_000).toFixed(3));
}

async function main() {
  loadLocalEnv(rootDir);
  const current = resolveProductionOperationalContext({ env: process.env });
  const database = option("database") || (current.formalCutover ? "commerce_ops" : POSTGRESQL_STAGING_DATABASE);
  if (database !== POSTGRESQL_STAGING_DATABASE && database !== "commerce_ops") throw new Error("Monitoring database is not allowed");
  const operational = resolveProductionOperationalContext({ env: process.env, database });
  const monitoring = JSON.parse(await fsp.readFile(path.join(rootDir, "config", "postgresql-monitoring.json"), "utf8"));
  const config = loadPostgresqlF1Config({ rootDir });
  const envText = await fsp.readFile(config.envFile, "utf8");
  const user = envValue(envText, "POSTGRES_MONITOR_USER");
  const password = envValue(envText, "POSTGRES_MONITOR_PASSWORD");
  if (!user || !password) throw new Error("PostgreSQL monitor role is not initialized");
  const selected = new PostgresqlProvider({ config, database, user, password, readOnly: true });
  try {
    const [settings, connections, activity, locks, databaseStats, archiver, backgroundWriter, statements, size] = await Promise.all([
      selected.query(`SELECT name,setting FROM pg_settings WHERE name=ANY($1::text[]) ORDER BY name`, [[
        "max_connections", "ssl", "archive_mode", "track_io_timing", "shared_preload_libraries", "log_min_duration_statement",
      ]]),
      selected.query(`SELECT COUNT(*)::integer used,(SELECT setting::integer FROM pg_settings WHERE name='max_connections') maximum
        FROM pg_stat_activity WHERE backend_type='client backend'`),
      selected.query(`SELECT
        COUNT(*) FILTER (WHERE wait_event_type='Lock')::integer blocked_sessions,
        COUNT(*) FILTER (WHERE xact_start IS NOT NULL AND now()-xact_start>interval '5 minutes')::integer long_transactions
        FROM pg_stat_activity WHERE datname=current_database()`),
      selected.query("SELECT COUNT(*) FILTER (WHERE NOT granted)::integer waiting_locks FROM pg_locks"),
      selected.query(`SELECT numbackends,xact_commit,xact_rollback,blks_read,blks_hit,blk_read_time,blk_write_time,
        temp_files,temp_bytes,deadlocks FROM pg_stat_database WHERE datname=current_database()`),
      selected.query("SELECT archived_count,failed_count,last_archived_wal,last_archived_time,last_failed_wal,last_failed_time FROM pg_stat_archiver"),
      selected.query("SELECT num_timed,num_requested,restartpoints_timed,restartpoints_req,write_time,sync_time,buffers_written FROM pg_stat_checkpointer"),
      selected.query(`SELECT queryid,calls,total_exec_time,mean_exec_time,rows,left(query,160) query
        FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        ORDER BY total_exec_time DESC LIMIT 10`).catch((error) => ({ rows: [], unavailable: String(error?.code || "QUERY_FAILED") })),
      selected.query("SELECT pg_database_size(current_database())::text database_bytes"),
    ]);
    const driveRoot = path.parse(rootDir).root;
    const backupRoot = process.env.COMMERCE_OPS_POSTGRES_BACKUP_ROOT || path.join(driveRoot, "PostgreSQLBackups");
    const disk = await fsp.statfs(driveRoot);
    const totalBytes = Number(disk.blocks) * Number(disk.bsize);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const diskFreePercent = Number((freeBytes / totalBytes * 100).toFixed(3));
    const backupAgeHours = await newestAge(path.join(backupRoot, "logical"), (name) => name.startsWith(`commerce-ops-${database}-`) && name.endsWith(".manifest.json"));
    const restoreAgeHours = await newestAge(path.join(rootDir, "docs", "reports"), (name) => name.startsWith("COMMERCE-OPS-POSTGRESQL-RESTORE-REHEARSAL-") && name.endsWith(".json"));
    const connection = connections.rows[0];
    const connectionUtilizationPercent = Number((Number(connection.used) / Number(connection.maximum) * 100).toFixed(3));
    const thresholds = monitoring.thresholds;
    const settingsMap = Object.fromEntries(settings.rows.map((row) => [row.name, row.setting]));
    const alerts = [];
    if (connectionUtilizationPercent >= thresholds.connectionUtilizationCriticalPercent) alerts.push({ severity: "CRITICAL", id: "connection_saturation" });
    if (activity.rows[0].blocked_sessions >= thresholds.blockedSessionsCritical) alerts.push({ severity: "CRITICAL", id: "blocked_sessions" });
    if (Number(archiver.rows[0].failed_count) >= thresholds.archiveFailureCritical) alerts.push({ severity: "CRITICAL", id: "archive_failures" });
    if (diskFreePercent < thresholds.diskFreeCriticalPercent) alerts.push({ severity: "CRITICAL", id: "disk_headroom" });
    if (backupAgeHours === null || backupAgeHours > thresholds.backupAgeWarningHours) alerts.push({ severity: "WARNING", id: "backup_freshness" });
    if (restoreAgeHours === null || restoreAgeHours > thresholds.restoreVerificationAgeWarningDays * 24) alerts.push({ severity: "WARNING", id: "restore_freshness" });
    if (settingsMap.ssl !== "on") alerts.push({ severity: "CRITICAL", id: "tls_disabled" });
    if (!new Set(["on", "always"]).has(settingsMap.archive_mode)) alerts.push({ severity: "CRITICAL", id: "wal_archiving_disabled" });
    if (settingsMap.track_io_timing !== "on") alerts.push({ severity: "CRITICAL", id: "io_timing_disabled" });
    if (!String(settingsMap.shared_preload_libraries || "").split(",").map((item) => item.trim()).includes("pg_stat_statements")) alerts.push({ severity: "CRITICAL", id: "pg_stat_statements_not_preloaded" });
    const slowThreshold = Number(settingsMap.log_min_duration_statement);
    if (!Number.isFinite(slowThreshold) || slowThreshold < 0 || slowThreshold > 1_000) alerts.push({ severity: "CRITICAL", id: "slow_query_logging_disabled" });
    if (statements.unavailable) alerts.push({ severity: "CRITICAL", id: "slow_query_statistics_unavailable" });
    if (new Set(["on", "always"]).has(settingsMap.archive_mode) && Number(archiver.rows[0].archived_count) < 1) alerts.push({ severity: "CRITICAL", id: "wal_archive_never_succeeded" });
    const result = {
      contract: "COMMERCE-OPS-POSTGRESQL-MONITOR-SNAPSHOT-1.0.0",
      status: alerts.some((item) => item.severity === "CRITICAL") ? "ALERT" : "PASS",
      collectedAt: new Date().toISOString(), database, role: user,
      coverage: {
        connectionPool: true, locks: true, replicationAndArchiver: true, disk: true,
        slowQueries: true, backupFreshness: true, restoreFreshness: true, ioTiming: true, checkpoints: true,
      },
      settings: settingsMap,
      connections: { ...connection, utilizationPercent: connectionUtilizationPercent },
      activity: activity.rows[0], locks: locks.rows[0], databaseStats: databaseStats.rows[0],
      archiver: archiver.rows[0], backgroundWriter: backgroundWriter.rows[0],
      slowQueries: statements.rows, slowQueriesUnavailable: statements.unavailable || null,
      storage: { databaseBytes: size.rows[0].database_bytes, diskTotalBytes: totalBytes, diskFreeBytes: freeBytes, diskFreePercent },
      freshness: { backupAgeHours, restoreVerificationAgeHours: restoreAgeHours },
      alerts,
      productionProvider: operational.provider, sqliteTouched: false, providerSwitched: false,
    };
    const outputDirectory = path.join(rootDir, "tmp", "postgresql-production-monitor");
    await fsp.mkdir(outputDirectory, { recursive: true });
    await fsp.writeFile(path.join(outputDirectory, "latest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } finally {
    await selected.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`PostgreSQL production monitoring failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
  process.exitCode = 1;
});
