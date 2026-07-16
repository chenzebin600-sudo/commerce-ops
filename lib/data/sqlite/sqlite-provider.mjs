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
