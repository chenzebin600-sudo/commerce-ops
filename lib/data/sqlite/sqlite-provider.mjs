import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DatabaseProvider, DATABASE_DIALECTS } from "../database-provider.mjs";
import { TransactionManager } from "../transaction-manager.mjs";

const SQLITE_BUSY_PATTERN = /database is (?:locked|busy)|SQLITE_BUSY/i;
const SQLITE_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function withSqliteBusyRetry(callback, { attempts = 20, delayMs = 100 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return callback();
    } catch (error) {
      lastError = error;
      if (!SQLITE_BUSY_PATTERN.test(String(error?.message || error)) || attempt === attempts) throw error;
      Atomics.wait(SQLITE_RETRY_BUFFER, 0, 0, delayMs);
    }
  }
  throw lastError;
}

export class SqliteProvider extends DatabaseProvider {
  constructor({ databasePath, connection = null }) {
    super({ dialect: DATABASE_DIALECTS.SQLITE });
    if (!connection && !databasePath) throw new TypeError("SQLite database path is required");
    if (databasePath) mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath || null;
    this._connection = connection || new DatabaseSync(databasePath);
    this.ownsConnection = !connection;
    this._connection.exec("PRAGMA busy_timeout = 5000");
    this._connection.exec("PRAGMA foreign_keys = ON");
    if (this.ownsConnection) withSqliteBusyRetry(() => this._connection.exec("PRAGMA journal_mode = WAL"));
    this._transactionManager = new TransactionManager({
      begin: () => withSqliteBusyRetry(() => this._connection.exec("BEGIN IMMEDIATE")),
      commit: () => this._connection.exec("COMMIT"),
      rollback: () => this._connection.exec("ROLLBACK"),
    });
  }

  get connection() {
    return this._connection;
  }

  get transactionManager() {
    return this._transactionManager;
  }

  withBusyRetry(callback, options) {
    return withSqliteBusyRetry(callback, options);
  }

  hasColumn(tableName, columnName) {
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!identifier.test(tableName) || !identifier.test(columnName)) {
      throw new TypeError("SQLite schema identifier is invalid");
    }
    return this._connection.prepare(`PRAGMA table_info('${tableName}')`).all()
      .some((column) => column.name === columnName);
  }

  async query(text, parameters = []) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL query text is required");
    if (!Array.isArray(parameters)) throw new TypeError("SQL query parameters must be an array");
    const rows = this._connection.prepare(text).all(...parameters);
    return { rows, rowCount: rows.length };
  }

  async execute(text, parameters = []) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL statement text is required");
    if (!Array.isArray(parameters)) throw new TypeError("SQL statement parameters must be an array");
    const result = withSqliteBusyRetry(() => this._connection.prepare(text).run(...parameters));
    return { rows: [], rowCount: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid };
  }

  async executeScript(text) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL script text is required");
    withSqliteBusyRetry(() => this._connection.exec(text));
    return { rows: [], rowCount: 0 };
  }

  placeholder(index) {
    if (!Number.isInteger(index) || index < 1) throw new TypeError("SQL placeholder index must be a positive integer");
    return "?";
  }

  async transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("Transaction callback is required");
    withSqliteBusyRetry(() => this._connection.exec("BEGIN IMMEDIATE"));
    try {
      const result = await callback(this);
      this._connection.exec("COMMIT");
      return result;
    } catch (error) {
      try { this._connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  async withTransaction(callback) {
    return this.transaction(callback);
  }

  close() {
    if (this.ownsConnection) this._connection.close();
  }
}

export function resolveSqliteProvider(value) {
  if (value?.dialect === DATABASE_DIALECTS.SQLITE && value.connection?.prepare) return value;
  if (value?.provider?.dialect === DATABASE_DIALECTS.SQLITE) return value.provider;
  const connection = value?.db?.prepare ? value.db : value;
  if (connection?.prepare && connection?.exec) return new SqliteProvider({ connection });
  throw new TypeError("A SQLite provider or compatible connection is required");
}
