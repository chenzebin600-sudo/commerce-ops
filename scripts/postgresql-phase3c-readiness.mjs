import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { evaluatePhase3cReadiness } from "../lib/postgresql/phase3c-readiness.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function toolVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const version = String(result.stdout || result.stderr || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  return Object.freeze({
    available: !result.error && result.status === 0,
    version: version?.slice(0, 160) || null,
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function envValue(content, name) {
  return String(content || "").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() || null;
}

async function evidence() {
  const backup = await readJson(path.join(rootDir, "config", "postgresql-backup-policy.json"));
  const monitoring = await readJson(path.join(rootDir, "config", "postgresql-monitoring.json"));
  const reportDir = path.join(rootDir, "docs", "reports");
  const names = await fs.readdir(reportDir).catch(() => []);
  async function passing(prefix) {
    const candidates = names.filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort().reverse();
    for (const name of candidates) {
      const value = await readJson(path.join(reportDir, name));
      if (value?.status === "PASS") return { status: "PASS", report: name };
    }
    return false;
  }
  return Object.freeze({
    encryptedBackup: backup?.encryptionEnabled === true && Number(backup?.retentionDays) > 0
      ? { encryptionEnabled: true, retentionDays: Number(backup.retentionDays) }
      : false,
    restoreRehearsal: await passing("COMMERCE-OPS-POSTGRESQL-RESTORE-REHEARSAL-"),
    monitoring: monitoring?.connectionPool === true
      && monitoring?.locks === true
      && monitoring?.replication === true
      && monitoring?.disk === true
      && monitoring?.slowQueries === true
      ? { configured: true }
      : false,
    capacityBaseline: await passing("COMMERCE-OPS-POSTGRESQL-CAPACITY-BASELINE-"),
  });
}

async function run() {
  const productionProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  const config = loadPostgresqlF1Config({ rootDir });
  const provider = new PostgresqlProvider({
    config,
    database: config.database,
    user: config.migratorUser,
    password: config.migratorPassword,
    readOnly: true,
  });
  let monitoringProvider = null;
  try {
    const envText = await fs.readFile(config.envFile, "utf8");
    const monitorUser = envValue(envText, "POSTGRES_MONITOR_USER");
    const monitorPassword = envValue(envText, "POSTGRES_MONITOR_PASSWORD");
    if (!monitorUser || !monitorPassword) throw new Error("PostgreSQL monitor role is not initialized");
    monitoringProvider = new PostgresqlProvider({
      config,
      database: config.database,
      user: monitorUser,
      password: monitorPassword,
      readOnly: true,
    });
    const identity = (await provider.query(`
      SELECT current_database() database,current_user username,
        current_setting('default_transaction_read_only') read_only,
        current_setting('server_version') server_version
    `)).rows[0];
    const roleRows = (await provider.query(`
      SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname
    `, [[config.migratorUser, config.appUser]])).rows;
    const role = (name) => {
      const row = roleRows.find((item) => item.rolname === name);
      return row ? {
        name: row.rolname,
        superuser: row.rolsuper,
        createDatabase: row.rolcreatedb,
        createRole: row.rolcreaterole,
        replication: row.rolreplication,
        bypassRowSecurity: row.rolbypassrls,
      } : null;
    };
    const privileges = (await provider.query(`
      SELECT
        has_database_privilege($1,current_database(),'CONNECT') migrator_connect,
        has_database_privilege($2,current_database(),'CONNECT') application_connect
    `, [config.migratorUser, config.appUser])).rows[0];
    const schema = (await provider.query(`
      SELECT
        n.nspowner::regrole::text owner,
        has_schema_privilege($1,$3,'USAGE') migrator_usage,
        has_schema_privilege($1,$3,'CREATE') migrator_create,
        has_schema_privilege($2,$3,'USAGE') application_usage,
        has_schema_privilege($2,$3,'CREATE') application_create,
        (SELECT COUNT(*)::integer FROM information_schema.tables WHERE table_schema=$3) table_count
      FROM pg_namespace n WHERE n.nspname=$3
    `, [config.migratorUser, config.appUser, config.schema])).rows[0] || null;
    const settingsRows = (await monitoringProvider.query(`
      SELECT name,setting FROM pg_settings WHERE name=ANY($1::text[])
    `, [[
      "ssl",
      "wal_level",
      "archive_mode",
      "archive_command",
      "data_checksums",
      "log_min_duration_statement",
      "track_io_timing",
      "shared_preload_libraries",
    ]])).rows;
    const setting = (name) => settingsRows.find((item) => item.name === name)?.setting ?? null;
    const archiveCommand = String(setting("archive_command") || "").trim();
    const preloaded = String(setting("shared_preload_libraries") || "").split(",").map((item) => item.trim());
    const pgStatStatementsInstalled = (await provider.query(
      "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements') installed",
    )).rows[0].installed;
    const tools = Object.freeze({
      pgDump: toolVersion("pg_dump"),
      pgRestore: toolVersion("pg_restore"),
      pgBasebackup: toolVersion("pg_basebackup"),
    });
    const collected = {
      productionProvider,
      expectedDatabase: config.database,
      expectedMigrator: config.migratorUser,
      clientSsl: config.ssl,
      identity: {
        database: identity.database,
        username: identity.username,
        readOnly: identity.read_only,
        serverVersion: identity.server_version,
      },
      roles: { migrator: role(config.migratorUser), application: role(config.appUser) },
      privileges: {
        migratorConnect: privileges.migrator_connect,
        applicationConnect: privileges.application_connect,
      },
      schema: schema ? {
        owner: schema.owner,
        migratorUsage: schema.migrator_usage,
        migratorCreate: schema.migrator_create,
        applicationUsage: schema.application_usage,
        applicationCreate: schema.application_create,
        tableCount: schema.table_count,
      } : null,
      settings: {
        ssl: setting("ssl"),
        walLevel: setting("wal_level"),
        archiveMode: setting("archive_mode"),
        archiveCommandConfigured: Boolean(archiveCommand && archiveCommand !== "(disabled)" && archiveCommand !== "/bin/true"),
        dataChecksums: setting("data_checksums"),
        logMinDurationStatement: setting("log_min_duration_statement"),
        trackIoTiming: setting("track_io_timing"),
      },
      extensions: {
        pgStatStatementsInstalled: Boolean(pgStatStatementsInstalled),
        pgStatStatementsPreloaded: preloaded.includes("pg_stat_statements"),
      },
      tools,
      evidence: await evidence(),
    };
    return {
      ...evaluatePhase3cReadiness(collected),
      target: `${config.database}.${config.schema}`,
      role: config.migratorUser,
      readOnly: true,
      productionTouched: false,
      externalCalls: 0,
    };
  } finally {
    if (monitoringProvider) await monitoringProvider.close();
    await provider.close();
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  const code = String(error?.code || "PHASE3C_READINESS_FAILED").slice(0, 80);
  const message = String(error?.message || error).split(/\r?\n/)[0].slice(0, 400);
  process.stderr.write(`PostgreSQL Phase 3C readiness failed [${code}]: ${message}\n`);
  process.exitCode = 1;
});
