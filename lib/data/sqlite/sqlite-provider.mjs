import { mkdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DatabaseProvider, DATABASE_DIALECTS } from "../database-provider.mjs";
import { TransactionManager } from "../transaction-manager.mjs";

const SQLITE_BUSY_PATTERN = /database is (?:locked|busy)|SQLITE_BUSY/i;
const SQLITE_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const SQLITE_TRANSACTION_CONTEXT = new AsyncLocalStorage();
const SQLITE_CONNECTION_STATES = new WeakMap();
const SQLITE_RAW_TARGETS = new WeakMap();

function transactionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function connectionState(connection) {
  let state = SQLITE_CONNECTION_STATES.get(connection);
  if (!state) {
    state = { activeToken: null, pending: 0, synchronousActive: false, tail: Promise.resolve() };
    SQLITE_CONNECTION_STATES.set(connection, state);
  }
  return state;
}

function rawConnection(value) {
  return SQLITE_RAW_TARGETS.get(value) || value;
}

function ownsActiveTransaction(state) {
  const owner = SQLITE_TRANSACTION_CONTEXT.getStore();
  return Boolean(state.activeToken && owner?.state === state && owner.token === state.activeToken);
}

function assertRawMutationAllowed(state) {
  if (state.activeToken && !ownsActiveTransaction(state)) {
    throw transactionError("SQLITE_RAW_WRITE_BLOCKED", "Raw SQLite writes cannot enter another operation's async transaction");
  }
  if (state.pending && !ownsActiveTransaction(state)) {
    throw transactionError("SQLITE_RAW_WRITE_BLOCKED", "Raw SQLite writes cannot bypass queued async transactions");
  }
}

function guardedConnection(connection, state) {
  if (state.guardedConnection) return state.guardedConnection;
  state.guardedConnection = new Proxy(connection, {
    get(target, property) {
      if (property === "prepare") return (sql) => {
        const statement = target.prepare(sql);
        const readOnly = /^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(String(sql));
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            if (statementProperty === "run" || (!readOnly && new Set(["get", "all", "iterate"]).has(statementProperty))) return (...parameters) => {
              assertRawMutationAllowed(state);
              return statementTarget[statementProperty](...parameters);
            };
            const value = statementTarget[statementProperty];
            return typeof value === "function" ? value.bind(statementTarget) : value;
          },
        });
      };
      if (property === "exec") return (sql) => {
        assertRawMutationAllowed(state);
        return target.exec(sql);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  SQLITE_RAW_TARGETS.set(state.guardedConnection, connection);
  return state.guardedConnection;
}

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
    this._connection = rawConnection(connection) || new DatabaseSync(databasePath);
    this._transactionState = connectionState(this._connection);
    this._guardedConnection = guardedConnection(this._connection, this._transactionState);
    this.ownsConnection = !connection;
    this._connection.exec("PRAGMA busy_timeout = 5000");
    this._connection.exec("PRAGMA foreign_keys = ON");
    if (this.ownsConnection) withSqliteBusyRetry(() => this._connection.exec("PRAGMA journal_mode = WAL"));
    this._transactionManager = new TransactionManager({
      begin: () => {
        if (this._transactionState.activeToken || this._transactionState.pending || this._transactionState.synchronousActive) {
          throw transactionError("SQLITE_TRANSACTION_BUSY", "SQLite connection already has an active or queued transaction");
        }
        this._transactionState.synchronousActive = true;
        try { withSqliteBusyRetry(() => this._connection.exec("BEGIN IMMEDIATE")); }
        catch (cause) { this._transactionState.synchronousActive = false; throw cause; }
      },
      commit: () => { try { this._connection.exec("COMMIT"); } finally { this._transactionState.synchronousActive = false; } },
      rollback: () => { try { this._connection.exec("ROLLBACK"); } finally { this._transactionState.synchronousActive = false; } },
    });
  }

  get connection() {
    // Raw reads remain synchronous and may observe this connection's current
    // transaction. Raw mutations are guarded; provider executors are preferred.
    return this._guardedConnection;
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
    await this.#waitForTransactionAccess();
    const rows = this._connection.prepare(text).all(...parameters);
    return { rows, rowCount: rows.length };
  }

  async execute(text, parameters = []) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL statement text is required");
    if (!Array.isArray(parameters)) throw new TypeError("SQL statement parameters must be an array");
    await this.#waitForTransactionAccess();
    const result = withSqliteBusyRetry(() => this._connection.prepare(text).run(...parameters));
    return { rows: [], rowCount: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid };
  }

  async executeScript(text) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL script text is required");
    await this.#waitForTransactionAccess();
    withSqliteBusyRetry(() => this._connection.exec(text));
    return { rows: [], rowCount: 0 };
  }

  placeholder(index) {
    if (!Number.isInteger(index) || index < 1) throw new TypeError("SQL placeholder index must be a positive integer");
    return "?";
  }

  async transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("Transaction callback is required");
    const state = this._transactionState;
    const owner = SQLITE_TRANSACTION_CONTEXT.getStore();
    if (state.activeToken && owner?.state === state && owner.token === state.activeToken) {
      throw transactionError("SQLITE_TRANSACTION_REENTRANT", "Nested SQLite transactions must reuse the supplied transaction executor");
    }
    if (state.synchronousActive) throw transactionError("SQLITE_TRANSACTION_BUSY", "SQLite connection has an active synchronous transaction");
    state.pending += 1;
    const previous = state.tail;
    const run = previous.then(async () => {
      state.pending -= 1;
      const token = {};
      state.activeToken = token;
      return SQLITE_TRANSACTION_CONTEXT.run({ state, token }, async () => {
        let begun = false;
        try {
          withSqliteBusyRetry(() => this._connection.exec("BEGIN IMMEDIATE"));
          begun = true;
          try {
            const result = await callback(this);
            this._connection.exec("COMMIT");
            return result;
          } catch (error) {
            if (begun) try { this._connection.exec("ROLLBACK"); } catch {}
            throw error;
          }
        } finally {
          state.activeToken = null;
        }
      });
    });
    state.tail = run.catch(() => {});
    return run;
  }

  async #waitForTransactionAccess() {
    const state = this._transactionState;
    const owner = SQLITE_TRANSACTION_CONTEXT.getStore();
    if (owner?.state === state && owner.token === state.activeToken) return;
    while (state.activeToken || state.pending) await state.tail;
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
