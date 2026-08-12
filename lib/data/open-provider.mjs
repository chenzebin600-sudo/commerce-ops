import { PostgresqlProvider } from "./postgresql/postgresql-provider.mjs";
import { SqliteProvider } from "./sqlite/sqlite-provider.mjs";

export function normalizeDatabaseProvider(value) {
  const configured = String(value || "sqlite").trim().toLowerCase();
  if (configured === "postgresql") return "postgres";
  if (configured === "sqlite" || configured === "postgres") return configured;
  throw new Error("DATABASE_PROVIDER must be sqlite or postgres");
}

export async function openProvider({
  providerName,
  databasePath,
  postgresqlConfig,
  credentials = {},
  PoolClass,
} = {}) {
  const selected = normalizeDatabaseProvider(providerName);
  if (selected === "sqlite") return new SqliteProvider({ databasePath });
  if (!postgresqlConfig) throw new TypeError("Shared PostgreSQL configuration is required");

  const provider = new PostgresqlProvider({
    config: postgresqlConfig,
    database: postgresqlConfig.database,
    user: postgresqlConfig.appUser,
    password: credentials.password,
    ...(PoolClass ? { PoolClass } : {}),
  });
  try {
    await provider.verifyIdentity({
      database: postgresqlConfig.database,
      user: postgresqlConfig.appUser,
      schema: postgresqlConfig.schema,
    });
    return provider;
  } catch (error) {
    await provider.close().catch(() => {});
    throw error;
  }
}
