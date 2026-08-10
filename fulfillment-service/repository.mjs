import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { FULFILLMENT_SQLITE_SCHEMA, ProviderFulfillmentRepository } from "./provider-repository.mjs";

// Compatibility constructor for existing tests and local tools. Production runtime
// uses repository-factory.mjs and never imports a SQLite connection directly.
export class FulfillmentRepository {
  constructor(databasePath = ":memory:") {
    this.provider = new SqliteProvider({ databasePath });
    this.provider.connection.exec(FULFILLMENT_SQLITE_SCHEMA);
    this.db = this.provider.connection;
    this.repository = new ProviderFulfillmentRepository({
      provider: this.provider,
      initializeSqliteSchema: false,
    });
    this.ready = this.repository.initialize();

    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        const value = target.repository[property];
        if (typeof value !== "function") return value;
        return async (...args) => {
          await target.ready;
          return value.apply(target.repository, args);
        };
      },
    });
  }

  async close() {
    await this.ready;
    await this.repository.close();
  }
}

export { ProviderFulfillmentRepository };
