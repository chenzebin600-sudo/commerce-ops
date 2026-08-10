import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDatabaseProvider,
  POSTGRESQL_SHADOW_DATABASE,
  resolveDatabaseProviderName,
} from "../lib/data/database-provider-factory.mjs";
import {
  POSTGRESQL_STAGING_APP_USER,
  POSTGRESQL_STAGING_DATABASE,
  POSTGRESQL_STAGING_ENV_FILENAME,
} from "../lib/postgresql/staging-config.mjs";
import { PHASE3D_REHEARSAL_DATABASE } from "../lib/postgresql/phase3d-rehearsal.mjs";
import {
  PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
  PHASE3D_PRODUCTION_CANDIDATE_SCOPE,
  PHASE3D_PRODUCTION_MODE_SCOPE,
} from "../lib/postgresql/phase3d-production-candidate.mjs";

class FakeSqliteProvider {
  constructor({ databasePath, readOnly }) {
    this.databasePath = databasePath;
    this.readOnly = readOnly;
  }
}

class FakePostgresqlProvider {
  constructor(options) {
    this.options = options;
  }
}

const POSTGRES_CONFIG = Object.freeze({
  host: "127.0.0.1",
  port: 5432,
  database: "commerce_ops",
  testDatabase: "commerce_ops_test",
  schema: "commerce_ops",
  appUser: "commerce_app",
  appPassword: "test-only-app-password",
  poolMax: 2,
  poolIdleTimeoutMs: 1000,
  connectionTimeoutMs: 1000,
  statementTimeoutMs: 1000,
  ssl: false,
});

test("database provider factory defaults to SQLite", () => {
  assert.equal(resolveDatabaseProviderName({}), "sqlite");
  const selected = createDatabaseProvider({
    databasePath: "C:/isolated/commerce.sqlite",
    env: {},
    SqliteProviderClass: FakeSqliteProvider,
  });
  assert.equal(selected.name, "sqlite");
  assert.equal(selected.mode, "production-compatible");
  assert.equal(selected.provider.databasePath, "C:/isolated/commerce.sqlite");
  assert.equal(selected.provider.readOnly, false);
});

test("database provider factory normalizes the PostgreSQL alias", () => {
  assert.equal(resolveDatabaseProviderName({ DATABASE_PROVIDER: "postgresql" }), "postgres");
});

test("database provider factory fails closed without explicit Shadow mode", () => {
  assert.throws(() => createDatabaseProvider({
    env: { DATABASE_PROVIDER: "postgres" },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), /Shadow-only/);
});

test("database provider factory rejects non-Shadow PostgreSQL targets", () => {
  assert.throws(() => createDatabaseProvider({
    env: {
      DATABASE_PROVIDER: "postgres",
      POSTGRES_SHADOW_MODE: "true",
      POSTGRES_SHADOW_DATABASE: "commerce_ops",
    },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), new RegExp(POSTGRESQL_SHADOW_DATABASE));
});

test("database provider factory creates only the guarded Shadow provider", () => {
  const pool = { name: "fake-pool" };
  const selected = createDatabaseProvider({
    env: { DATABASE_PROVIDER: "postgres", POSTGRES_SHADOW_MODE: "true" },
    postgresqlConfig: POSTGRES_CONFIG,
    postgresqlPool: pool,
    PostgresqlProviderClass: FakePostgresqlProvider,
  });
  assert.equal(selected.name, "postgres");
  assert.equal(selected.mode, "shadow-read-validation");
  assert.equal(selected.target, POSTGRESQL_SHADOW_DATABASE);
  assert.equal(selected.provider.options.database, POSTGRESQL_SHADOW_DATABASE);
  assert.equal(selected.provider.options.config.schema, "app");
  assert.equal(selected.provider.options.user, POSTGRES_CONFIG.appUser);
  assert.equal(selected.provider.options.pool, pool);
  assert.equal(selected.provider.options.readOnly, true);
});

test("database provider factory creates only the exactly confirmed writable staging provider", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "commerce-ops-staging-factory-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rootDir, POSTGRESQL_STAGING_ENV_FILENAME), [
    `POSTGRES_STAGING_DATABASE=${POSTGRESQL_STAGING_DATABASE}`,
    `POSTGRES_STAGING_APP_USER=${POSTGRESQL_STAGING_APP_USER}`,
    "POSTGRES_STAGING_APP_PASSWORD=staging-test-password-123456",
    "",
  ].join("\n"));
  const env = {
    DATABASE_PROVIDER: "postgres",
    POSTGRES_STAGING_MODE: "true",
    POSTGRES_STAGING_CONFIRM_DATABASE: POSTGRESQL_STAGING_DATABASE,
  };
  const selected = createDatabaseProvider({
    rootDir,
    env,
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  });
  assert.equal(selected.mode, "staging-dry-run");
  assert.equal(selected.target, POSTGRESQL_STAGING_DATABASE);
  assert.equal(selected.provider.options.database, POSTGRESQL_STAGING_DATABASE);
  assert.equal(selected.provider.options.user, POSTGRESQL_STAGING_APP_USER);
  assert.equal(selected.provider.options.readOnly, false);

  assert.throws(() => createDatabaseProvider({
    rootDir,
    env: { ...env, POSTGRES_STAGING_CONFIRM_DATABASE: "commerce_ops" },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), new RegExp(POSTGRESQL_STAGING_DATABASE));
});

test("database provider factory rejects simultaneous Shadow and staging modes", () => {
  assert.throws(() => createDatabaseProvider({
    env: {
      DATABASE_PROVIDER: "postgres",
      POSTGRES_SHADOW_MODE: "true",
      POSTGRES_STAGING_MODE: "true",
    },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), /mutually exclusive/);
});

test("database provider factory creates only the exactly confirmed cutover rehearsal provider", () => {
  const env = {
    DATABASE_PROVIDER: "postgres",
    POSTGRES_CUTOVER_REHEARSAL_MODE: "true",
    POSTGRES_CUTOVER_REHEARSAL_CONFIRM_DATABASE: PHASE3D_REHEARSAL_DATABASE,
  };
  const selected = createDatabaseProvider({
    env,
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  });
  assert.equal(selected.mode, "cutover-rehearsal");
  assert.equal(selected.target, PHASE3D_REHEARSAL_DATABASE);
  assert.equal(selected.provider.options.database, PHASE3D_REHEARSAL_DATABASE);
  assert.equal(selected.provider.options.user, POSTGRES_CONFIG.appUser);
  assert.equal(selected.provider.options.readOnly, false);
  assert.throws(() => createDatabaseProvider({
    env: { ...env, POSTGRES_CUTOVER_REHEARSAL_CONFIRM_DATABASE: "commerce_ops" },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), new RegExp(PHASE3D_REHEARSAL_DATABASE));
});

test("database provider factory rejects simultaneous cutover rehearsal and staging modes", () => {
  assert.throws(() => createDatabaseProvider({
    env: {
      DATABASE_PROVIDER: "postgres",
      POSTGRES_STAGING_MODE: "true",
      POSTGRES_CUTOVER_REHEARSAL_MODE: "true",
    },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), /mutually exclusive/);
});

test("database provider factory creates only the exactly confirmed process-scoped production candidate provider", () => {
  const env = {
    DATABASE_PROVIDER: "postgres",
    POSTGRES_PRODUCTION_CANDIDATE_MODE: "true",
    POSTGRES_PRODUCTION_CANDIDATE_CONFIRM_DATABASE: PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
    POSTGRES_PRODUCTION_CANDIDATE_CONFIRM_SCOPE: PHASE3D_PRODUCTION_CANDIDATE_SCOPE,
  };
  const selected = createDatabaseProvider({
    env,
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  });
  assert.equal(selected.mode, "production-candidate-validation");
  assert.equal(selected.target, PHASE3D_PRODUCTION_CANDIDATE_DATABASE);
  assert.equal(selected.provider.options.user, POSTGRES_CONFIG.appUser);
  assert.equal(selected.provider.options.readOnly, false);
  assert.throws(() => createDatabaseProvider({
    env: { ...env, POSTGRES_PRODUCTION_CANDIDATE_CONFIRM_SCOPE: "CUTOVER" },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), /PROCESS_SCOPED_VALIDATION_ONLY/);
});

test("database provider factory rejects simultaneous production candidate and rehearsal modes", () => {
  assert.throws(() => createDatabaseProvider({
    env: {
      DATABASE_PROVIDER: "postgres",
      POSTGRES_PRODUCTION_CANDIDATE_MODE: "true",
      POSTGRES_CUTOVER_REHEARSAL_MODE: "true",
    },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), /mutually exclusive/);
});

test("database provider factory requires explicit formal cutover scope for production mode", () => {
  const env = {
    DATABASE_PROVIDER: "postgres",
    POSTGRES_PRODUCTION_MODE: "true",
    POSTGRES_PRODUCTION_CONFIRM_DATABASE: PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
    POSTGRES_PRODUCTION_CONFIRM_SCOPE: PHASE3D_PRODUCTION_MODE_SCOPE,
  };
  const selected = createDatabaseProvider({
    env,
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  });
  assert.equal(selected.mode, "production");
  assert.equal(selected.target, PHASE3D_PRODUCTION_CANDIDATE_DATABASE);
  assert.equal(selected.provider.options.user, POSTGRES_CONFIG.appUser);
  assert.throws(() => createDatabaseProvider({
    env: { ...env, POSTGRES_PRODUCTION_CONFIRM_SCOPE: "PROCESS_SCOPED_VALIDATION_ONLY" },
    postgresqlConfig: POSTGRES_CONFIG,
    PostgresqlProviderClass: FakePostgresqlProvider,
  }), /FORMAL_CUTOVER/);
});
