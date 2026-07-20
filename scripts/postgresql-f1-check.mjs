import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { parseSingleJson, runPsql } from "../lib/postgresql/psql-client.mjs";

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function roleCheckSql(config) {
  return `SELECT json_build_object(
    'database', current_database(),
    'user', current_user,
    'canConnect', has_database_privilege(current_user, current_database(), 'CONNECT'),
    'schemaUsage', has_schema_privilege(current_user, ${literal(config.schema)}, 'USAGE'),
    'schemaCreate', has_schema_privilege(current_user, ${literal(config.schema)}, 'CREATE'),
    'superuser', rolsuper,
    'createDatabase', rolcreatedb,
    'createRole', rolcreaterole,
    'replication', rolreplication
  ) FROM pg_roles WHERE rolname=current_user;`;
}

function defaultPrivilegesSql(config) {
  return `WITH grants AS (
    SELECT d.defaclobjtype, x.privilege_type, grantee.rolname grantee_name
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) x
    JOIN pg_roles owner_role ON owner_role.oid=d.defaclrole
    JOIN pg_roles grantee ON grantee.oid=x.grantee
    WHERE n.nspname=${literal(config.schema)}
      AND owner_role.rolname=${literal(config.migratorUser)}
      AND grantee.rolname=${literal(config.appUser)}
  ) SELECT json_build_object(
    'tableDml', (SELECT count(DISTINCT privilege_type)=4 FROM grants WHERE defaclobjtype='r' AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')),
    'sequenceUse', (SELECT count(DISTINCT privilege_type)=2 FROM grants WHERE defaclobjtype='S' AND privilege_type IN ('USAGE','SELECT'))
  );`;
}

function assertRole(report, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (report[key] !== value) throw new Error(`PostgreSQL permission boundary failed: ${key}`);
  }
}

export function checkPostgresqlF1(config, { runner } = {}) {
  const migratorBase = { config, user: config.migratorUser, password: config.migratorPassword, runner };
  const appBase = { config, user: config.appUser, password: config.appPassword, runner };
  const productionMigrator = parseSingleJson(runPsql({ ...migratorBase, database: config.database, sql: roleCheckSql(config) }), "production migrator check");
  const testMigrator = parseSingleJson(runPsql({ ...migratorBase, database: config.testDatabase, sql: roleCheckSql(config) }), "test migrator check");
  const app = parseSingleJson(runPsql({ ...appBase, database: config.database, sql: roleCheckSql(config) }), "application role check");

  assertRole(productionMigrator, { canConnect: true, schemaUsage: true, schemaCreate: true, superuser: false, createDatabase: false, createRole: false, replication: false });
  assertRole(testMigrator, { canConnect: true, schemaUsage: true, schemaCreate: true, superuser: false, createDatabase: false, createRole: false, replication: false });
  assertRole(app, { canConnect: true, schemaUsage: true, schemaCreate: false, superuser: false, createDatabase: false, createRole: false, replication: false });
  let applicationCanConnectTestDatabase = true;
  try {
    runPsql({ ...appBase, database: config.testDatabase, sql: "SELECT 1;" });
  } catch {
    applicationCanConnectTestDatabase = false;
  }
  if (applicationCanConnectTestDatabase) throw new Error("Application role must not connect to the migration test database");

  const probe = parseSingleJson(runPsql({
    ...migratorBase,
    database: config.testDatabase,
    sql: `DROP TABLE IF EXISTS ${config.schema}.f1_connectivity_probe;
      CREATE TABLE ${config.schema}.f1_connectivity_probe (id integer PRIMARY KEY, value text NOT NULL);
      INSERT INTO ${config.schema}.f1_connectivity_probe (id,value) VALUES (1,'f1');
      SELECT json_build_object('rows', count(*), 'value', min(value)) FROM ${config.schema}.f1_connectivity_probe;
      DROP TABLE ${config.schema}.f1_connectivity_probe;`,
  }), "migration test write check");
  if (Number(probe.rows) !== 1 || probe.value !== "f1") throw new Error("Migration test write check failed");
  const probeCleanup = parseSingleJson(runPsql({
    ...migratorBase,
    database: config.testDatabase,
    sql: `SELECT json_build_object('removed', to_regclass(${literal(`${config.schema}.f1_connectivity_probe`)}) IS NULL);`,
  }), "migration test cleanup check");
  if (!probeCleanup.removed) throw new Error("Migration test probe cleanup failed");

  const defaults = parseSingleJson(runPsql({ ...migratorBase, database: config.database, sql: defaultPrivilegesSql(config) }), "default privilege check");
  if (!defaults.tableDml || !defaults.sequenceUse) throw new Error("PostgreSQL default privileges are incomplete");

  return {
    status: "CONNECTED",
    config: publicPostgresqlF1Config(config),
    migrator: { production: productionMigrator, test: testMigrator, testWrite: true, probeRemoved: probeCleanup.removed },
    application: { ...app, testDatabaseConnect: applicationCanConnectTestDatabase },
    defaultPrivileges: defaults,
  };
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = loadPostgresqlF1Config({ rootDir });
  process.stdout.write(`${JSON.stringify(checkPostgresqlF1(config), null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL F1 connectivity failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
    process.exitCode = 1;
  });
}
