import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { decryptFile, isEncryptedArtifact, readEncryptionKey, sha256File } from "../lib/postgresql/infrastructure/encrypted-artifact.mjs";
import { resolveProductionOperationalContext } from "../lib/postgresql/production-operational-context.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function provider(config, database, user, password) {
  return new PostgresqlProvider({ config: Object.freeze({ ...config, statementTimeoutMs: 300_000 }), database, user, password });
}

function runtimePaths(dataDirectory) {
  const driveRoot = path.parse(rootDir).root;
  const backupRoot = process.env.COMMERCE_OPS_POSTGRES_BACKUP_ROOT || path.join(driveRoot, "PostgreSQLBackups");
  const secretRoot = process.env.COMMERCE_OPS_POSTGRES_SECRET_ROOT
    || path.join(process.env.ProgramData || process.env.ALLUSERSPROFILE || driveRoot, "CommerceOps", "PostgreSQL", "secrets");
  return {
    dataDirectory,
    archiveDirectory: path.join(backupRoot, "wal"),
    archiveKeyFile: path.join(secretRoot, "wal-archive.key"),
  };
}

async function waitForArchive(admin, expectedWal) {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const row = (await admin.query("SELECT archived_count,failed_count,last_archived_wal,last_archived_time,last_failed_wal,last_failed_time FROM pg_stat_archiver")).rows[0];
    if (row.last_archived_wal === expectedWal) return row;
    await delay(1_000);
  }
  throw new Error(`WAL archive did not complete within 60 seconds: ${expectedWal}`);
}

async function waitForSlowLog(logDirectory, marker) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const names = (await fsp.readdir(logDirectory).catch(() => [])).filter((name) => name.endsWith(".log")).sort().reverse();
    for (const name of names.slice(0, 2)) {
      const text = await fsp.readFile(path.join(logDirectory, name), "utf8").catch(() => "");
      if (text.includes(marker) && /duration:\s+[5-9][0-9]{2}\./i.test(text)) return name;
    }
    await delay(500);
  }
  throw new Error("Slow-query statement was not found in the PostgreSQL log");
}

async function main() {
  loadLocalEnv(rootDir);
  const operational = resolveProductionOperationalContext({ env: process.env, database: "commerce_ops" });
  if (!process.argv.includes("--apply") || !process.argv.includes("--confirm-infrastructure=commerce_ops_pg18")) {
    return { status: "PLAN", productionProvider: operational.provider, productionTouched: false };
  }
  const config = loadPostgresqlF1Config({ rootDir });
  assert.equal(config.ssl, true, "POSTGRES_SSL must be true after hardening restart");
  const admin = provider(config, "postgres", config.adminUser, config.adminPassword);
  const candidate = provider(config, config.database, config.migratorUser, config.migratorPassword);
  let temporaryWal = null;
  try {
    const ssl = (await candidate.query("SELECT ssl,version,cipher,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
    assert.equal(ssl.ssl, true);
    const settingsRows = (await admin.query(`SELECT name,setting,pending_restart FROM pg_settings WHERE name=ANY($1::text[]) ORDER BY name`, [[
      "ssl", "ssl_min_protocol_version", "wal_level", "archive_mode", "archive_command", "logging_collector",
      "log_min_duration_statement", "track_io_timing", "shared_preload_libraries", "compute_query_id",
    ]])).rows;
    const settings = Object.fromEntries(settingsRows.map((row) => [row.name, { setting: row.setting, pendingRestart: row.pending_restart }]));
    assert.equal(settings.ssl.setting, "on");
    assert.equal(settings.archive_mode.setting, "on");
    assert.equal(settings.wal_level.setting, "replica");
    assert.equal(settings.track_io_timing.setting, "on");
    assert.equal(settings.log_min_duration_statement.setting, "500");
    assert.equal(settings.compute_query_id.setting, "on");
    assert.equal(settings.shared_preload_libraries.setting.split(",").map((item) => item.trim()).includes("pg_stat_statements"), true);
    assert.equal(settingsRows.some((row) => row.pending_restart), false, "PostgreSQL still has pending restart settings");
    const hba = (await admin.query(`SELECT type,address,auth_method,error FROM pg_hba_file_rules
      WHERE address IN ('127.0.0.1','::1') ORDER BY line_number`)).rows;
    assert.equal(hba.length >= 4, true);
    assert.equal(hba.every((row) => row.type === "hostssl" && row.auth_method === "scram-sha-256" && !row.error), true);
    const extensions = {};
    for (const database of [config.database, "commerce_ops_staging"]) {
      const selected = provider(config, database, config.adminUser, config.adminPassword);
      try {
        extensions[database] = (await selected.query(`SELECT e.extname,n.nspname schema
          FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_stat_statements'`)).rows[0] || null;
      } finally { await selected.close(); }
      assert.deepEqual(extensions[database], { extname: "pg_stat_statements", schema: "public" });
    }
    await candidate.query("SELECT current_database(),COUNT(*) FROM pg_catalog.pg_class");
    const statementRows = (await candidate.query("SELECT COUNT(*)::integer tracked FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0];
    assert.equal(statementRows.tracked > 0, true);
    const identity = (await admin.query("SELECT current_setting('data_directory') data_directory,pg_walfile_name(pg_current_wal_lsn()) wal_name")).rows[0];
    const paths = runtimePaths(identity.data_directory);
    await admin.query("SELECT pg_switch_wal()");
    const archiver = await waitForArchive(admin, identity.wal_name);
    const encryptedWal = path.join(paths.archiveDirectory, `${identity.wal_name}.aes256gcm`);
    assert.equal(await isEncryptedArtifact(encryptedWal), true);
    const sourceWal = path.join(paths.dataDirectory, "pg_wal", identity.wal_name);
    temporaryWal = path.join(paths.archiveDirectory, `${identity.wal_name}.${process.pid}.verify.tmp`);
    const key = await readEncryptionKey(paths.archiveKeyFile);
    await decryptFile(encryptedWal, temporaryWal, key);
    const walDigest = await sha256File(temporaryWal);
    const sourcePresent = await fsp.stat(sourceWal).then(() => true).catch(() => false);
    if (sourcePresent) assert.equal(walDigest, await sha256File(sourceWal));
    const slowMarker = `commerce_ops_slow_query_${Date.now()}`;
    await admin.query(`SELECT pg_sleep(0.55),$1::text marker`, [slowMarker]);
    const slowLog = await waitForSlowLog(path.join(paths.dataDirectory, "log"), slowMarker);
    const rootCertificate = new crypto.X509Certificate(await fsp.readFile(config.sslCaFile));
    const report = {
      contract: "COMMERCE-OPS-POSTGRESQL-HARDENING-VERIFICATION-1.0.0",
      status: "PASS",
      verifiedAt: new Date().toISOString(),
      tls: { connected: true, version: ssl.version, cipher: ssl.cipher, bits: ssl.bits, caSubject: rootCertificate.subject, caValidTo: rootCertificate.validTo, hostsslEnforced: true },
      walArchive: { archived: true, wal: identity.wal_name, encrypted: true, decryptedDigestVerified: true, sourceDigestCompared: sourcePresent, archivedCount: archiver.archived_count, failedCount: archiver.failed_count },
      slowQuery: { thresholdMs: 500, logEvidence: slowLog, markerObserved: true },
      trackIoTiming: true,
      pgStatStatements: { preloaded: true, installed: extensions, trackedStatements: statementRows.tracked },
      pendingRestart: false,
      productionProvider: operational.provider, sqliteTouched: false, providerSwitched: false,
    };
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const name = `COMMERCE-OPS-POSTGRESQL-HARDENING-VERIFICATION-${stamp}.json`;
    await fsp.writeFile(path.join(rootDir, "docs", "reports", name), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ...report, report: name };
  } finally {
    if (temporaryWal) await fsp.rm(temporaryWal, { force: true }).catch(() => {});
    await candidate.close();
    await admin.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`PostgreSQL production hardening verification failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
