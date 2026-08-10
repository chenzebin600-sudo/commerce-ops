import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { runPsql } from "../lib/postgresql/psql-client.mjs";
import { buildDatabaseSql, buildRoleSql, buildSchemaSql } from "../scripts/postgresql-f1-init.mjs";

async function writeConfig(root, overrides = {}) {
  const values = {
    POSTGRES_ADMIN_USER: "postgres",
    POSTGRES_ADMIN_PASSWORD: "admin-only",
    POSTGRES_HOST: "127.0.0.1",
    POSTGRES_PORT: "5432",
    POSTGRES_DATABASE: "commerce_ops",
    POSTGRES_TEST_DATABASE: "commerce_ops_migration_test",
    POSTGRES_SCHEMA: "app",
    POSTGRES_MIGRATOR_USER: "commerce_migrator",
    POSTGRES_MIGRATOR_PASSWORD: "migrator-password-123",
    POSTGRES_APP_USER: "commerce_app",
    POSTGRES_APP_PASSWORD: "application-password-123",
    POSTGRES_SSL: "false",
    ...overrides,
  };
  await fs.writeFile(path.join(root, ".env.postgres.local"), Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"));
  return values;
}

test("F1 config loads local credentials without exposing passwords in its public view", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgres-f1-config-"));
  await writeConfig(root);
  const config = loadPostgresqlF1Config({ rootDir: root, env: {} });
  assert.equal(config.database, "commerce_ops");
  assert.equal(config.testDatabase, "commerce_ops_migration_test");
  const publicConfig = publicPostgresqlF1Config(config);
  assert.equal(JSON.stringify(publicConfig).includes("password"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("F1 config rejects weak, shared and unsafe role settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgres-f1-invalid-"));
  await writeConfig(root, { POSTGRES_APP_PASSWORD: "short" });
  assert.throws(() => loadPostgresqlF1Config({ rootDir: root, env: {} }), /at least 16/);
  await writeConfig(root, { POSTGRES_APP_PASSWORD: "migrator-password-123" });
  assert.throws(() => loadPostgresqlF1Config({ rootDir: root, env: {} }), /passwords must differ/);
  await writeConfig(root, { POSTGRES_SCHEMA: "app;drop" });
  assert.throws(() => loadPostgresqlF1Config({ rootDir: root, env: {} }), /identifier/);
  await fs.rm(root, { recursive: true, force: true });
});

test("F1 config requires a readable CA when TLS is enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgres-f1-tls-"));
  await writeConfig(root, { POSTGRES_SSL: "true" });
  assert.throws(() => loadPostgresqlF1Config({ rootDir: root, env: {} }), /POSTGRES_SSL_CA_FILE is required/);
  const caFile = path.join(root, "root.crt");
  await fs.writeFile(caFile, "test-ca");
  await writeConfig(root, { POSTGRES_SSL: "true", POSTGRES_SSL_CA_FILE: caFile });
  const config = loadPostgresqlF1Config({ rootDir: root, env: {} });
  assert.equal(config.ssl, true);
  assert.equal(config.sslCaFile, caFile);
  await fs.rm(root, { recursive: true, force: true });
});

test("F1 SQL grants only the required roles, schema and default privileges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgres-f1-sql-"));
  const secrets = await writeConfig(root);
  const config = loadPostgresqlF1Config({ rootDir: root, env: {} });
  const sql = [buildRoleSql(config), buildDatabaseSql(config), buildSchemaSql(config, { production: true })].join("\n");
  assert.match(sql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE/);
  assert.match(sql, /REVOKE ALL ON SCHEMA "app" FROM "commerce_app"/);
  assert.doesNotMatch(sql, new RegExp(secrets.POSTGRES_ADMIN_PASSWORD));
  assert.doesNotMatch(sql, new RegExp(secrets.POSTGRES_MIGRATOR_PASSWORD));
  assert.doesNotMatch(sql, new RegExp(secrets.POSTGRES_APP_PASSWORD));
  await fs.rm(root, { recursive: true, force: true });
});

test("psql invocation keeps credentials out of arguments and redacts failures", () => {
  const config = {
    host: "127.0.0.1", port: 5432, ssl: false,
    adminPassword: "admin-secret", migratorPassword: "migrator-secret", appPassword: "app-secret",
  };
  const runner = (_command, args, options) => {
    assert.equal(args.join(" ").includes("admin-secret"), false);
    assert.equal(options.input.includes("admin-secret"), false);
    assert.equal(options.env.PGPASSWORD, "admin-secret");
    return { status: 1, stdout: "", stderr: "password=admin-secret was rejected" };
  };
  assert.throws(() => runPsql({ config, database: "postgres", user: "postgres", password: "admin-secret", sql: "SELECT 1", runner }), (error) => {
    assert.equal(error.message.includes("admin-secret"), false);
    assert.match(error.message, /REDACTED/);
    return true;
  });
});
