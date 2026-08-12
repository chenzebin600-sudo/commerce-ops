import pg from "pg";
import { DatabaseProvider, DATABASE_DIALECTS } from "../database-provider.mjs";
import { buildPostgresqlPoolOptions } from "./shared-runtime-config.mjs";

const { Pool } = pg;

function parameters(values) {
  if (!Array.isArray(values)) throw new TypeError("SQL query parameters must be an array");
  return values;
}

function sqlText(value) {
  const text = String(value || "");
  if (!text.trim()) throw new TypeError("SQL query text is required");
  return text;
}

class PostgresqlTransactionClient {
  constructor(client) {
    this.client = client;
  }

  async query(text, values = []) {
    return this.client.query({ text: sqlText(text), values: parameters(values) });
  }

  async execute(text, values = []) {
    return this.query(text, values);
  }

  async executeScript(text) {
    return this.client.query(sqlText(text));
  }

  placeholder(index) {
    if (!Number.isInteger(index) || index < 1) throw new TypeError("SQL placeholder index must be a positive integer");
    return `$${index}`;
  }
}

export class PostgresqlTransactionManager {
  constructor({ acquire }) {
    if (typeof acquire !== "function") throw new TypeError("PostgreSQL client acquisition is required");
    this.acquire = acquire;
  }

  async run(callback) {
    if (typeof callback !== "function") throw new TypeError("Transaction callback is required");
    const client = await this.acquire();
    try {
      await client.query("BEGIN");
      const result = await callback(new PostgresqlTransactionClient(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresqlProvider extends DatabaseProvider {
  constructor({ config, database, user, password, pool = null, PoolClass = Pool, onPoolError = null }) {
    super({ dialect: DATABASE_DIALECTS.POSTGRESQL });
    if (!config || !database || !user || !password) throw new TypeError("PostgreSQL provider configuration is incomplete");
    this.config = config;
    this.database = database;
    this.user = user;
    this.ownsPool = !pool;
    const poolOptions = config.sslmode === "verify-full"
      ? buildPostgresqlPoolOptions(config, { database, user, password })
      : {
          host: config.host,
          port: config.port,
          database,
          user,
          password,
          ssl: config.ssl ? { rejectUnauthorized: true } : false,
          max: config.poolMax,
          idleTimeoutMillis: config.poolIdleTimeoutMs,
          connectionTimeoutMillis: config.connectionTimeoutMs,
          statement_timeout: config.statementTimeoutMs,
          application_name: "commerce-ops-f2",
        };
    this._pool = pool || new PoolClass(poolOptions);
    this._initializedClients = new WeakSet();
    this.lastIdleErrorCode = null;
    this._pool.on?.("error", (error) => {
      this.lastIdleErrorCode = String(error?.code || "PG_POOL_IDLE_ERROR").slice(0, 80);
      onPoolError?.({ code: this.lastIdleErrorCode });
    });
    this._transactionManager = new PostgresqlTransactionManager({ acquire: () => this.acquire() });
  }

  get connection() {
    return this._pool;
  }

  get transactionManager() {
    return this._transactionManager;
  }

  async acquire() {
    const client = await this._pool.connect();
    try {
      if (!this._initializedClients.has(client)) {
        await client.query("SELECT set_config('search_path', $1, false), set_config('TimeZone', 'UTC', false), set_config('statement_timeout', $2, false)", [
          `${this.config.schema},public`,
          String(this.config.statementTimeoutMs),
        ]);
        this._initializedClients.add(client);
      }
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async query(text, values = []) {
    const client = await this.acquire();
    try {
      return await client.query({ text: sqlText(text), values: parameters(values) });
    } finally {
      client.release();
    }
  }

  async verifyIdentity({ database, user, schema }) {
    const result = await this.query(`SELECT current_database() AS database,
      current_user AS username,
      current_schema() AS schema`);
    const identity = result.rows[0] || {};
    if (identity.database !== database || identity.username !== user || identity.schema !== schema) {
      const error = new Error("PostgreSQL connection identity does not match the configured shared database");
      error.code = "PG_IDENTITY_MISMATCH";
      throw error;
    }
  }

  async execute(text, values = []) {
    return this.query(text, values);
  }

  async executeScript(text) {
    const client = await this.acquire();
    try {
      return await client.query(sqlText(text));
    } finally {
      client.release();
    }
  }

  placeholder(index) {
    if (!Number.isInteger(index) || index < 1) throw new TypeError("SQL placeholder index must be a positive integer");
    return `$${index}`;
  }

  async transaction(callback) {
    return this._transactionManager.run(callback);
  }

  async withTransaction(callback) {
    return this.transaction(callback);
  }

  async close() {
    if (this.ownsPool) await this._pool.end();
  }
}

export function createPostgresqlProvider(config, { database = "production", role = "app", pool = null, PoolClass = Pool } = {}) {
  const selectedDatabase = database === "test" ? config.testDatabase : config.database;
  const migrator = role === "migrator";
  if (!new Set(["production", "test"]).has(database)) throw new TypeError("PostgreSQL database selection is invalid");
  if (!new Set(["app", "migrator"]).has(role)) throw new TypeError("PostgreSQL role selection is invalid");
  return new PostgresqlProvider({
    config,
    database: selectedDatabase,
    user: migrator ? config.migratorUser : config.appUser,
    password: migrator ? config.migratorPassword : config.appPassword,
    pool,
    PoolClass,
  });
}
