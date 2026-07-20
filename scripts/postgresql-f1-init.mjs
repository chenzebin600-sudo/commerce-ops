import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { parseSingleJson, runPsql } from "../lib/postgresql/psql-client.mjs";

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function buildRoleSql(config) {
  const migrator = literal(config.migratorUser);
  const app = literal(config.appUser);
  return String.raw`\getenv migrator_password POSTGRES_MIGRATOR_PASSWORD
\getenv app_password POSTGRES_APP_PASSWORD
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', ${migrator}, :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${migrator}) \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', ${migrator}, :'migrator_password') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', ${app}, :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${app}) \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', ${app}, :'app_password') \gexec
`;
}

export function buildDatabaseSql(config) {
  const production = literal(config.database);
  const test = literal(config.testDatabase);
  const migrator = identifier(config.migratorUser);
  const app = identifier(config.appUser);
  return String.raw`SELECT format('CREATE DATABASE %I WITH ENCODING %L TEMPLATE template0', ${production}, 'UTF8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=${production}) \gexec
SELECT format('CREATE DATABASE %I WITH ENCODING %L TEMPLATE template0', ${test}, 'UTF8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=${test}) \gexec
REVOKE ALL PRIVILEGES ON DATABASE ${identifier(config.database)} FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE ${identifier(config.testDatabase)} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${identifier(config.database)} TO ${migrator};
GRANT CONNECT ON DATABASE ${identifier(config.testDatabase)} TO ${migrator};
GRANT CONNECT ON DATABASE ${identifier(config.database)} TO ${app};
`;
}

export function buildSchemaSql(config, { production }) {
  const schema = identifier(config.schema);
  const migrator = identifier(config.migratorUser);
  const app = identifier(config.appUser);
  const database = identifier(production ? config.database : config.testDatabase);
  return String.raw`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${migrator};
ALTER SCHEMA ${schema} OWNER TO ${migrator};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
REVOKE ALL ON SCHEMA ${schema} FROM ${app};
GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${migrator};
GRANT USAGE ON SCHEMA ${schema} TO ${app};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM ${app};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${app};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${app};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
  GRANT USAGE, SELECT ON SEQUENCES TO ${app};
ALTER ROLE ${migrator} IN DATABASE ${database} SET search_path TO ${schema}, public;
ALTER ROLE ${app} IN DATABASE ${database} SET search_path TO ${schema}, public;
`;
}

export function initializePostgresqlF1(config, { runner } = {}) {
  const base = { config, user: config.adminUser, password: config.adminPassword, runner };
  runPsql({
    ...base,
    database: "postgres",
    sql: buildRoleSql(config),
    secretEnvironment: {
      POSTGRES_MIGRATOR_PASSWORD: config.migratorPassword,
      POSTGRES_APP_PASSWORD: config.appPassword,
    },
  });
  runPsql({ ...base, database: "postgres", sql: buildDatabaseSql(config) });
  runPsql({ ...base, database: config.database, sql: buildSchemaSql(config, { production: true }) });
  runPsql({ ...base, database: config.testDatabase, sql: buildSchemaSql(config, { production: false }) });
  const server = parseSingleJson(runPsql({
    ...base,
    database: "postgres",
    sql: `SELECT json_build_object(
      'version', current_setting('server_version'),
      'listenAddresses', current_setting('listen_addresses'),
      'port', current_setting('port'),
      'timezone', current_setting('TimeZone'),
      'serverEncoding', current_setting('server_encoding')
    );`,
  }), "PostgreSQL server check");
  return { config: publicPostgresqlF1Config(config), server };
}

async function main() {
  if (!process.argv.includes("--apply")) throw new Error("Initialization requires the explicit --apply flag");
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = loadPostgresqlF1Config({ rootDir });
  const result = initializePostgresqlF1(config);
  process.stdout.write(`${JSON.stringify({ status: "INITIALIZED", ...result }, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL F1 initialization failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
    process.exitCode = 1;
  });
}
