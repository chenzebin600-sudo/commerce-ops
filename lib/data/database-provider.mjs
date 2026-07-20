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

  async query(_text, _parameters = []) {
    throw new Error("database provider query is not implemented");
  }

  async execute(_text, _parameters = []) {
    throw new Error("database provider execute is not implemented");
  }

  async executeScript(_text) {
    throw new Error("database provider script execution is not implemented");
  }

  placeholder(_index) {
    throw new Error("database provider placeholder is not implemented");
  }

  async transaction(_callback) {
    throw new Error("database provider transaction is not implemented");
  }

  async withTransaction(callback) {
    return this.transaction(callback);
  }

  async migrate(migrations) {
    if (!Array.isArray(migrations)) throw new TypeError("Database migrations must be an array");
    const applied = [];
    for (const migration of migrations) {
      if (!migration || typeof migration.id !== "string" || !migration.id.trim()
        || typeof migration.up !== "string" || !migration.up.trim()) {
        throw new TypeError("Each database migration requires an id and SQL up script");
      }
      await this.transaction((transaction) => transaction.executeScript(migration.up));
      applied.push(migration.id);
    }
    return applied;
  }

  close() {
    throw new Error("database provider close is not implemented");
  }
}

export function assertDatabaseProvider(provider) {
  if (!provider || typeof provider !== "object" || !provider.dialect) {
    throw new TypeError("A database provider is required");
  }
  if (!provider.connection || typeof provider.transactionManager?.run !== "function"
    || typeof provider.query !== "function" || typeof provider.execute !== "function"
    || typeof provider.executeScript !== "function" || typeof provider.placeholder !== "function"
    || typeof provider.transaction !== "function" || typeof provider.migrate !== "function") {
    throw new TypeError("Database provider capabilities are incomplete");
  }
  return provider;
}
