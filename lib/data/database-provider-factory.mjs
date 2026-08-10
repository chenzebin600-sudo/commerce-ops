import { PostgresqlProvider } from "./postgresql/postgresql-provider.mjs";
import { SqliteProvider } from "./sqlite/sqlite-provider.mjs";
import { loadPostgresqlF1Config } from "../postgresql/f1-config.mjs";
import {
  loadPostgresqlStagingConfig,
  POSTGRESQL_STAGING_DATABASE,
} from "../postgresql/staging-config.mjs";
import { PHASE3D_REHEARSAL_DATABASE } from "../postgresql/phase3d-rehearsal.mjs";
import {
  PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
  PHASE3D_PRODUCTION_CANDIDATE_SCOPE,
  PHASE3D_PRODUCTION_MODE_SCOPE,
} from "../postgresql/phase3d-production-candidate.mjs";

export const DATABASE_PROVIDER_NAMES = Object.freeze({
  SQLITE: "sqlite",
  POSTGRES: "postgres",
});

export const POSTGRESQL_SHADOW_DATABASE = "commerce_ops_shadow";
export const POSTGRESQL_SHADOW_SCHEMA = "app";

function enabled(value) {
  return new Set(["1", "true", "yes", "on"]).has(String(value || "").trim().toLowerCase());
}

export function resolveDatabaseProviderName(env = process.env) {
  const configured = String(env.DATABASE_PROVIDER || DATABASE_PROVIDER_NAMES.SQLITE).trim().toLowerCase();
  if (configured === "postgresql") return DATABASE_PROVIDER_NAMES.POSTGRES;
  if (!Object.values(DATABASE_PROVIDER_NAMES).includes(configured)) {
    throw new TypeError("DATABASE_PROVIDER must be sqlite or postgres");
  }
  return configured;
}

function shadowDatabase(env) {
  const database = String(env.POSTGRES_SHADOW_DATABASE || POSTGRESQL_SHADOW_DATABASE).trim();
  if (database !== POSTGRESQL_SHADOW_DATABASE) {
    throw new Error(`Phase 2 PostgreSQL target must be ${POSTGRESQL_SHADOW_DATABASE}`);
  }
  return database;
}

function stagingEnabled(env) {
  return enabled(env.POSTGRES_STAGING_MODE);
}

function cutoverRehearsalEnabled(env) {
  return enabled(env.POSTGRES_CUTOVER_REHEARSAL_MODE);
}

function productionCandidateEnabled(env) {
  return enabled(env.POSTGRES_PRODUCTION_CANDIDATE_MODE);
}

function productionEnabled(env) {
  return enabled(env.POSTGRES_PRODUCTION_MODE);
}

export function createDatabaseProvider({
  rootDir = process.cwd(),
  databasePath,
  env = process.env,
  postgresqlConfig = null,
  postgresqlPool = null,
  sqliteReadOnly = false,
  PostgresqlProviderClass = PostgresqlProvider,
  SqliteProviderClass = SqliteProvider,
} = {}) {
  const name = resolveDatabaseProviderName(env);
  if (name === DATABASE_PROVIDER_NAMES.SQLITE) {
    if (!databasePath) throw new TypeError("SQLite database path is required");
    return Object.freeze({
      name,
      mode: "production-compatible",
      target: databasePath,
      provider: new SqliteProviderClass({ databasePath, readOnly: sqliteReadOnly }),
    });
  }

  const shadowMode = enabled(env.POSTGRES_SHADOW_MODE);
  const stagingMode = stagingEnabled(env);
  const cutoverRehearsalMode = cutoverRehearsalEnabled(env);
  const productionCandidateMode = productionCandidateEnabled(env);
  const productionMode = productionEnabled(env);
  if ([shadowMode, stagingMode, cutoverRehearsalMode, productionCandidateMode, productionMode].filter(Boolean).length > 1) {
    throw new Error("PostgreSQL Shadow, staging, cutover rehearsal, production candidate, and production modes are mutually exclusive");
  }
  if (productionMode) {
    const loaded = postgresqlConfig || loadPostgresqlF1Config({ rootDir, env });
    if (loaded.database !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE
      || String(env.POSTGRES_PRODUCTION_CONFIRM_DATABASE || "").trim() !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE
      || String(env.POSTGRES_PRODUCTION_CONFIRM_SCOPE || "").trim() !== PHASE3D_PRODUCTION_MODE_SCOPE) {
      throw new Error(`Production mode requires exact ${PHASE3D_PRODUCTION_CANDIDATE_DATABASE} database and ${PHASE3D_PRODUCTION_MODE_SCOPE} scope confirmations`);
    }
    const config = Object.freeze({ ...loaded, schema: POSTGRESQL_SHADOW_SCHEMA });
    return Object.freeze({
      name,
      mode: "production",
      target: config.database,
      provider: new PostgresqlProviderClass({
        config,
        database: config.database,
        user: config.appUser,
        password: config.appPassword,
        pool: postgresqlPool,
        readOnly: false,
      }),
    });
  }
  if (productionCandidateMode) {
    const loaded = postgresqlConfig || loadPostgresqlF1Config({ rootDir, env });
    if (loaded.database !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE
      || String(env.POSTGRES_PRODUCTION_CANDIDATE_CONFIRM_DATABASE || "").trim() !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE
      || String(env.POSTGRES_PRODUCTION_CANDIDATE_CONFIRM_SCOPE || "").trim() !== PHASE3D_PRODUCTION_CANDIDATE_SCOPE) {
      throw new Error(`Production candidate mode requires exact ${PHASE3D_PRODUCTION_CANDIDATE_DATABASE} database and ${PHASE3D_PRODUCTION_CANDIDATE_SCOPE} scope confirmations`);
    }
    const config = Object.freeze({ ...loaded, schema: POSTGRESQL_SHADOW_SCHEMA });
    return Object.freeze({
      name,
      mode: "production-candidate-validation",
      target: config.database,
      provider: new PostgresqlProviderClass({
        config,
        database: config.database,
        user: config.appUser,
        password: config.appPassword,
        pool: postgresqlPool,
        readOnly: false,
      }),
    });
  }
  if (cutoverRehearsalMode) {
    if (String(env.POSTGRES_CUTOVER_REHEARSAL_CONFIRM_DATABASE || "").trim() !== PHASE3D_REHEARSAL_DATABASE) {
      throw new Error(`Cutover rehearsal mode requires POSTGRES_CUTOVER_REHEARSAL_CONFIRM_DATABASE=${PHASE3D_REHEARSAL_DATABASE}`);
    }
    const loaded = postgresqlConfig || loadPostgresqlF1Config({ rootDir, env });
    const config = Object.freeze({ ...loaded, schema: POSTGRESQL_SHADOW_SCHEMA });
    return Object.freeze({
      name,
      mode: "cutover-rehearsal",
      target: PHASE3D_REHEARSAL_DATABASE,
      provider: new PostgresqlProviderClass({
        config,
        database: PHASE3D_REHEARSAL_DATABASE,
        user: config.appUser,
        password: config.appPassword,
        pool: postgresqlPool,
        readOnly: false,
      }),
    });
  }
  if (stagingMode) {
    if (String(env.POSTGRES_STAGING_CONFIRM_DATABASE || "").trim() !== POSTGRESQL_STAGING_DATABASE) {
      throw new Error(`Staging mode requires POSTGRES_STAGING_CONFIRM_DATABASE=${POSTGRESQL_STAGING_DATABASE}`);
    }
    const loaded = postgresqlConfig || loadPostgresqlF1Config({ rootDir, env });
    const staging = loadPostgresqlStagingConfig({ rootDir, env });
    const config = Object.freeze({ ...loaded, schema: POSTGRESQL_SHADOW_SCHEMA });
    return Object.freeze({
      name,
      mode: "staging-dry-run",
      target: staging.database,
      provider: new PostgresqlProviderClass({
        config,
        database: staging.database,
        user: staging.appUser,
        password: staging.appPassword,
        pool: postgresqlPool,
        readOnly: false,
      }),
    });
  }

  if (!shadowMode) {
    throw new Error("PostgreSQL is Shadow-only in Phase 2; set POSTGRES_SHADOW_MODE=true explicitly");
  }

  const loaded = postgresqlConfig || loadPostgresqlF1Config({ rootDir, env });
  const database = shadowDatabase(env);
  const config = Object.freeze({ ...loaded, schema: POSTGRESQL_SHADOW_SCHEMA });
  return Object.freeze({
    name,
    mode: "shadow-read-validation",
    target: database,
    provider: new PostgresqlProviderClass({
      config,
      database,
      user: config.appUser,
      password: config.appPassword,
      pool: postgresqlPool,
      readOnly: true,
    }),
  });
}
