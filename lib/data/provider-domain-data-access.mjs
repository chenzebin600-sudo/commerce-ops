import { createDatabaseProvider } from "./database-provider-factory.mjs";
import { createProviderDomainRepositories } from "./provider-domain-repositories.mjs";

export function openProviderDomainDataAccess({
  rootDir = process.cwd(),
  databasePath,
  env = process.env,
  postgresqlConfig = null,
  postgresqlPool = null,
  sqliteReadOnly = false,
} = {}) {
  const selection = createDatabaseProvider({
    rootDir,
    databasePath,
    env,
    postgresqlConfig,
    postgresqlPool,
    sqliteReadOnly,
  });
  const repositories = createProviderDomainRepositories({ provider: selection.provider });
  let closed = false;

  return Object.freeze({
    name: selection.name,
    mode: selection.mode,
    target: selection.target,
    provider: selection.provider,
    transactionManager: selection.provider.transactionManager,
    repositories,
    async close() {
      if (closed) return;
      closed = true;
      await selection.provider.close();
    },
  });
}
