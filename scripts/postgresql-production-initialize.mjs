import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { POSTGRESQL_STAGING_DATABASE } from "../lib/postgresql/staging-config.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function provider(config, database) {
  return new PostgresqlProvider({ config, database, user: config.adminUser, password: config.adminPassword });
}

async function main() {
  loadLocalEnv(rootDir);
  if (String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase() !== "sqlite") {
    throw new Error("PostgreSQL infrastructure initialization requires production DATABASE_PROVIDER=sqlite");
  }
  if (!process.argv.includes("--apply")) {
    return { status: "PLAN", databases: ["commerce_ops", POSTGRESQL_STAGING_DATABASE], productionProvider: "sqlite" };
  }
  if (!process.argv.includes("--confirm-infrastructure=commerce_ops_pg18")) {
    throw new Error("Initialization requires --confirm-infrastructure=commerce_ops_pg18");
  }
  const config = loadPostgresqlF1Config({ rootDir });
  const monitorRole = "commerce_monitor";
  const envText = await fsp.readFile(config.envFile, "utf8");
  const existing = envText.match(/^POSTGRES_MONITOR_PASSWORD=(.+)$/m)?.[1]?.trim();
  const monitorPassword = existing || crypto.randomBytes(32).toString("base64url");
  const admin = provider(config, "postgres");
  try {
    const passwordLiteral = `'${monitorPassword.replaceAll("'", "''")}'`;
    const exists = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) present", [monitorRole])).rows[0].present;
    if (exists) {
      await admin.executeScript(`ALTER ROLE ${monitorRole} WITH LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`);
    } else {
      await admin.executeScript(`CREATE ROLE ${monitorRole} LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`);
    }
    await admin.executeScript(`GRANT pg_monitor TO ${monitorRole}`);
    for (const database of [config.database, POSTGRESQL_STAGING_DATABASE]) {
      await admin.executeScript(`GRANT CONNECT ON DATABASE ${database} TO ${monitorRole}`);
      const selected = provider(config, database);
      try {
        await selected.executeScript("CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public");
        await selected.executeScript("ALTER EXTENSION pg_stat_statements SET SCHEMA public");
      } finally { await selected.close(); }
    }
  } finally {
    await admin.close();
  }
  const lines = envText.split(/\r?\n/).filter((line) => line && !line.startsWith("POSTGRES_MONITOR_USER=") && !line.startsWith("POSTGRES_MONITOR_PASSWORD="));
  lines.push(`POSTGRES_MONITOR_USER=${monitorRole}`, `POSTGRES_MONITOR_PASSWORD=${monitorPassword}`);
  await fsp.writeFile(config.envFile, `${lines.join("\r\n")}\r\n`, { encoding: "utf8", mode: 0o600 });
  return {
    status: "APPLIED",
    monitorRole,
    monitorRoleFlags: "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    pgMonitorGranted: true,
    extensionsInstalled: [config.database, POSTGRESQL_STAGING_DATABASE],
    productionProvider: "sqlite",
    sqliteTouched: false,
  };
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`PostgreSQL production infrastructure initialization failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
  process.exitCode = 1;
});
