export const DATABASE_DIALECTS = Object.freeze({
  SQLITE: "sqlite",
  POSTGRESQL: "postgresql",
});

export class DatabaseProvider {
  constructor({ dialect }) {
    if (!Object.values(DATABASE_DIALECTS).includes(dialect)) {
      throw new TypeError("database provider dialect is invalid");
    }
    this.dialect = dialect;
  }

  get connection() {
    throw new Error("database provider connection is not implemented");
  }

  get transactionManager() {
    throw new Error("database provider transaction manager is not implemented");
  }

  close() {
    throw new Error("database provider close is not implemented");
  }
}

export function assertDatabaseProvider(provider) {
  if (!provider || typeof provider !== "object" || !provider.dialect) {
    throw new TypeError("A database provider is required");
  }
  if (!provider.connection || typeof provider.transactionManager?.run !== "function") {
    throw new TypeError("Database provider capabilities are incomplete");
  }
  return provider;
}
