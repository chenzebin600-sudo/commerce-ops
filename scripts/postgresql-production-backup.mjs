import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { POSTGRESQL_STAGING_DATABASE } from "../lib/postgresql/staging-config.mjs";
import { encryptFile, readEncryptionKey, sha256File } from "../lib/postgresql/infrastructure/encrypted-artifact.mjs";
import { resolveProductionOperationalContext } from "../lib/postgresql/production-operational-context.mjs";

const executeFile = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const policyFile = path.join(rootDir, "config", "postgresql-backup-policy.json");
const allowedDatabases = new Set(["commerce_ops", POSTGRESQL_STAGING_DATABASE]);

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || null;
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function runtimePaths() {
  const driveRoot = path.parse(rootDir).root;
  const backupRoot = process.env.COMMERCE_OPS_POSTGRES_BACKUP_ROOT || path.join(driveRoot, "PostgreSQLBackups");
  const secretRoot = process.env.COMMERCE_OPS_POSTGRES_SECRET_ROOT
    || path.join(process.env.ProgramData || process.env.ALLUSERSPROFILE || driveRoot, "CommerceOps", "PostgreSQL", "secrets");
  return {
    backupDirectory: path.join(backupRoot, "logical"),
    keyFile: path.join(secretRoot, "logical-backup.key"),
  };
}

async function cli(command, args, password, config, timeout = 1_800_000) {
  const tls = config.ssl ? {
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: config.sslCaFile,
  } : {};
  return executeFile(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...tls, PGPASSWORD: password },
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function sourceEvidence(provider) {
  const identity = (await provider.query(`SELECT current_database() database,current_user username,
    current_setting('server_version') server_version,pg_database_size(current_database())::text database_bytes`)).rows[0];
  const schemas = (await provider.query(`SELECT table_schema,COUNT(*)::integer tables
    FROM information_schema.tables WHERE table_schema IN ('app','ai_shadow','shadow_meta')
    GROUP BY table_schema ORDER BY table_schema`)).rows;
  const migrationTable = (await provider.query("SELECT to_regclass('shadow_meta.schema_migrations')::text relation")).rows[0].relation;
  const migrations = migrationTable
    ? (await provider.query("SELECT version,sha256 FROM shadow_meta.schema_migrations ORDER BY version")).rows
    : [];
  const relations = {
    product_skus: "app.product_skus",
    order_headers: "app.growth_order_headers",
    inventory_snapshots: "app.growth_inventory_snapshots",
    tasks: "app.foundation_tasks",
    audit_events: "app.operation_audit_events",
    agent_runs: "ai_shadow.agent_runs",
    tool_invocations: "ai_shadow.tool_invocations",
  };
  const counts = {};
  for (const [name, relation] of Object.entries(relations)) {
    const present = (await provider.query("SELECT to_regclass($1)::text relation", [relation])).rows[0].relation;
    counts[name] = present ? (await provider.query(`SELECT COUNT(*)::text count FROM ${relation}`)).rows[0].count : "0";
  }
  return { identity, schemas, migrations, counts };
}

async function enforceRetention(directory, database, retentionDays) {
  const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
  const prefix = `commerce-ops-${database}-`;
  const removed = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".dump.aes256gcm")) continue;
    const fullPath = path.join(directory, entry.name);
    const stat = await fsp.stat(fullPath);
    if (stat.mtimeMs >= threshold) continue;
    await fsp.rm(fullPath, { force: true });
    await fsp.rm(`${fullPath}.manifest.json`, { force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function main() {
  loadLocalEnv(rootDir);
  const current = resolveProductionOperationalContext({ env: process.env });
  const database = option("database") || (current.formalCutover ? "commerce_ops" : POSTGRESQL_STAGING_DATABASE);
  const operational = resolveProductionOperationalContext({ env: process.env, database });
  const confirmation = option("confirm-database");
  const apply = process.argv.includes("--apply");
  if (!allowedDatabases.has(database)) throw new Error(`Backup target is not allowed: ${database}`);
  if (!apply) return { status: "PLAN", database, productionProvider: operational.provider, productionTouched: false };
  if (confirmation !== database) throw new Error(`Backup apply requires --confirm-database=${database}`);
  const policy = JSON.parse(await fsp.readFile(policyFile, "utf8"));
  if (!policy.encryptionEnabled || Number(policy.retentionDays) <= 0) throw new Error("Backup policy is not approved");
  const config = loadPostgresqlF1Config({ rootDir });
  const paths = runtimePaths();
  await fsp.mkdir(paths.backupDirectory, { recursive: true });
  const key = await readEncryptionKey(paths.keyFile);
  const artifactName = `commerce-ops-${database}-${stamp()}.dump.aes256gcm`;
  const encryptedPath = path.join(paths.backupDirectory, artifactName);
  const plainPath = `${encryptedPath}.${process.pid}.plain.tmp`;
  const manifestPath = `${encryptedPath}.manifest.json`;
  const provider = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 300_000 }),
    database,
    user: config.migratorUser,
    password: config.migratorPassword,
    readOnly: true,
  });
  const startedAt = new Date();
  try {
    const evidence = await sourceEvidence(provider);
    await cli("pg_dump", [
      "--format=custom", "--compress=zstd:6", "--no-owner", "--no-privileges",
      "--exclude-extension=pg_stat_statements",
      "--file", plainPath, "--host", config.host, "--port", String(config.port),
      "--username", config.migratorUser, "--dbname", database,
    ], config.migratorPassword, config);
    const plaintextSha256 = await sha256File(plainPath);
    await encryptFile(plainPath, encryptedPath, key);
    await fsp.rm(plainPath, { force: true });
    const encryptedSha256 = await sha256File(encryptedPath);
    const encryptedBytes = (await fsp.stat(encryptedPath)).size;
    const removedByRetention = await enforceRetention(paths.backupDirectory, database, Number(policy.retentionDays));
    const manifest = {
      contract: "COMMERCE-OPS-POSTGRESQL-ENCRYPTED-BACKUP-1.0.0",
      status: "PASS",
      database,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      format: "pg_dump custom zstd:6",
      encryption: "AES-256-GCM",
      plaintextRetained: false,
      keyCoLocated: false,
      artifact: artifactName,
      plaintextSha256,
      encryptedSha256,
      encryptedBytes,
      retentionDays: Number(policy.retentionDays),
      removedByRetention,
      evidence,
      productionProvider: operational.provider,
      sqliteTouched: false,
      providerSwitched: false,
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return manifest;
  } finally {
    await provider.close();
    await fsp.rm(plainPath, { force: true }).catch(() => {});
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`PostgreSQL production backup failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
  process.exitCode = 1;
});
