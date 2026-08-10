import { createDatabaseProvider } from "../lib/data/database-provider-factory.mjs";
import { ProviderFulfillmentRepository } from "./provider-repository.mjs";

export async function createFulfillmentRepository({
  rootDir = process.cwd(),
  databasePath,
  env = process.env,
  postgresqlConfig = null,
  postgresqlPool = null,
} = {}) {
  const selected = createDatabaseProvider({
    rootDir,
    databasePath,
    env,
    postgresqlConfig,
    postgresqlPool,
  });
  const repository = await ProviderFulfillmentRepository.open({
    provider: selected.provider,
    initializeSqliteSchema: selected.name === "sqlite",
  });
  repository.databaseProviderName = selected.name;
  repository.databaseMode = selected.mode;
  repository.databaseTarget = selected.target;
  repository.readOnly = Boolean(selected.provider.readOnly);
  return repository;
}

