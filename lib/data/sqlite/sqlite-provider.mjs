import { mkdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { constants as SQLITE_CONSTANTS, DatabaseSync } from "node:sqlite";
import { DatabaseProvider, DATABASE_DIALECTS } from "../database-provider.mjs";
import { TransactionManager } from "../transaction-manager.mjs";

const SQLITE_BUSY_PATTERN = /database is (?:locked|busy)|SQLITE_BUSY/i;
const SQLITE_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const SQLITE_TRANSACTION_CONTEXT = new AsyncLocalStorage();
const SQLITE_CONNECTION_STATES = new WeakMap();
const SQLITE_FACADE_TARGETS = new WeakMap();
const SQLITE_PROVIDER_INSTANCES = new WeakSet();
const READ_ONLY_PRAGMAS = new Set([
  "analysis_limit",
  "application_id",
  "auto_vacuum",
  "automatic_index",
  "busy_timeout",
  "cache_size",
  "cache_spill",
  "cell_size_check",
  "checkpoint_fullfsync",
  "collation_list",
  "compile_options",
  "data_version",
  "database_list",
  "defer_foreign_keys",
  "encoding",
  "foreign_key_check",
  "foreign_key_list",
  "foreign_keys",
  "freelist_count",
  "fullfsync",
  "function_list",
  "ignore_check_constraints",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "journal_mode",
  "journal_size_limit",
  "legacy_alter_table",
  "locking_mode",
  "max_page_count",
  "mmap_size",
  "module_list",
  "page_count",
  "page_size",
  "pragma_list",
  "query_only",
  "quick_check",
  "read_uncommitted",
  "recursive_triggers",
  "reverse_unordered_selects",
  "schema_version",
  "secure_delete",
  "soft_heap_limit",
  "synchronous",
  "table_info",
  "table_list",
  "table_xinfo",
  "temp_store",
  "threads",
  "trusted_schema",
  "user_version",
  "wal_autocheckpoint",
  "writable_schema",
]);
const READ_ONLY_PRAGMA_ARGUMENTS = new Set([
  "foreign_key_check",
  "foreign_key_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "quick_check",
  "table_info",
  "table_xinfo",
]);
const SQLITE_MUTATION_ACTIONS = new Set([
  SQLITE_CONSTANTS.SQLITE_ALTER_TABLE,
  SQLITE_CONSTANTS.SQLITE_ANALYZE,
  SQLITE_CONSTANTS.SQLITE_ATTACH,
  SQLITE_CONSTANTS.SQLITE_CREATE_INDEX,
  SQLITE_CONSTANTS.SQLITE_CREATE_TABLE,
  SQLITE_CONSTANTS.SQLITE_CREATE_TEMP_INDEX,
  SQLITE_CONSTANTS.SQLITE_CREATE_TEMP_TABLE,
  SQLITE_CONSTANTS.SQLITE_CREATE_TEMP_TRIGGER,
  SQLITE_CONSTANTS.SQLITE_CREATE_TEMP_VIEW,
  SQLITE_CONSTANTS.SQLITE_CREATE_TRIGGER,
  SQLITE_CONSTANTS.SQLITE_CREATE_VIEW,
  SQLITE_CONSTANTS.SQLITE_CREATE_VTABLE,
  SQLITE_CONSTANTS.SQLITE_DELETE,
  SQLITE_CONSTANTS.SQLITE_DETACH,
  SQLITE_CONSTANTS.SQLITE_DROP_INDEX,
  SQLITE_CONSTANTS.SQLITE_DROP_TABLE,
  SQLITE_CONSTANTS.SQLITE_DROP_TEMP_INDEX,
  SQLITE_CONSTANTS.SQLITE_DROP_TEMP_TABLE,
  SQLITE_CONSTANTS.SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_CONSTANTS.SQLITE_DROP_TEMP_VIEW,
  SQLITE_CONSTANTS.SQLITE_DROP_TRIGGER,
  SQLITE_CONSTANTS.SQLITE_DROP_VIEW,
  SQLITE_CONSTANTS.SQLITE_DROP_VTABLE,
  SQLITE_CONSTANTS.SQLITE_INSERT,
  SQLITE_CONSTANTS.SQLITE_REINDEX,
  SQLITE_CONSTANTS.SQLITE_TRANSACTION,
  SQLITE_CONSTANTS.SQLITE_UPDATE,
  SQLITE_CONSTANTS.SQLITE_SAVEPOINT,
]);

function transactionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function connectionState(connection) {
  let state = SQLITE_CONNECTION_STATES.get(connection);
  if (!state) {
    state = {
      activeToken: null,
      authorizedTransactionToken: null,
      closed: false,
      inFlight: 0,
      pending: 0,
      poisonedError: null,
      publicPreparation: false,
      readPreparationSql: null,
      synchronousToken: null,
      tail: Promise.resolve(),
    };
    connection.setAuthorizer((actionCode) => {
      if (state.readPreparationSql !== null) {
        if (SQLITE_MUTATION_ACTIONS.has(actionCode)) return SQLITE_CONSTANTS.SQLITE_DENY;
        if (actionCode === SQLITE_CONSTANTS.SQLITE_PRAGMA
          && !isReadOnlyPragma(state.readPreparationSql)) return SQLITE_CONSTANTS.SQLITE_DENY;
      }
      if (actionCode !== SQLITE_CONSTANTS.SQLITE_TRANSACTION && actionCode !== SQLITE_CONSTANTS.SQLITE_SAVEPOINT) {
        return SQLITE_CONSTANTS.SQLITE_OK;
      }
      if (state.publicPreparation) return SQLITE_CONSTANTS.SQLITE_DENY;
      const token = state.authorizedTransactionToken;
      if (token && (token === state.activeToken || token === state.synchronousToken)) {
        return SQLITE_CONSTANTS.SQLITE_OK;
      }
      return state.activeToken || state.synchronousToken ? SQLITE_CONSTANTS.SQLITE_DENY : SQLITE_CONSTANTS.SQLITE_OK;
    });
    SQLITE_CONNECTION_STATES.set(connection, state);
  }
  return state;
}

function sharedConnection(value) {
  return SQLITE_FACADE_TARGETS.get(value) || null;
}

function assertHealthyConnection(state) {
  if (state.closed) {
    throw transactionError("SQLITE_CONNECTION_CLOSED", "SQLite connection is closed");
  }
  if (state.poisonedError) throw state.poisonedError;
}

function poisonConnection(state, cause) {
  if (!state.poisonedError) {
    state.poisonedError = transactionError(
      "SQLITE_TRANSACTION_POISONED",
      "SQLite transaction cleanup failed and the connection can no longer be used",
    );
    state.poisonedError.cause = cause;
  }
  state.activeToken = null;
  state.synchronousToken = null;
}

function reserveAsyncOperation(state) {
  assertHealthyConnection(state);
  state.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.inFlight -= 1;
  };
}

function executeManagedTransactionControl(connection, state, token, sql) {
  state.authorizedTransactionToken = token;
  try {
    return connection.exec(sql);
  } finally {
    if (state.authorizedTransactionToken === token) state.authorizedTransactionToken = null;
  }
}

function ownsActiveTransaction(state, capability) {
  const owner = SQLITE_TRANSACTION_CONTEXT.getStore();
  return Boolean(state.activeToken && owner?.state === state && owner.token === state.activeToken
    && owner.capability === capability);
}

function assertAsyncTransactionOwner(state, token, capability) {
  assertHealthyConnection(state);
  const owner = SQLITE_TRANSACTION_CONTEXT.getStore();
  if (state.activeToken !== token || owner?.state !== state || owner.token !== token
    || owner.capability !== capability) {
    throw transactionError("SQLITE_TRANSACTION_OWNERSHIP", "SQLite async transaction ownership was lost");
  }
  if (state.synchronousToken) {
    throw transactionError("SQLITE_TRANSACTION_BUSY", "SQLite connection has an active synchronous transaction");
  }
}

function assertSynchronousTransactionOwner(state, token) {
  assertHealthyConnection(state);
  if (!token || state.synchronousToken !== token) {
    throw transactionError("SQLITE_TRANSACTION_OWNERSHIP", "SQLite synchronous transaction ownership was lost");
  }
  if (state.activeToken || state.pending) {
    throw transactionError("SQLITE_TRANSACTION_BUSY", "SQLite connection has an active or queued async transaction");
  }
}

function assertRawMutationAllowed(state, capability) {
  assertHealthyConnection(state);
  if (state.synchronousToken && state.synchronousToken.capability !== capability) {
    throw transactionError("SQLITE_RAW_WRITE_BLOCKED", "Raw SQLite writes cannot enter another provider's synchronous transaction");
  }
  if (state.activeToken && !ownsActiveTransaction(state, capability)) {
    throw transactionError("SQLITE_RAW_WRITE_BLOCKED", "Raw SQLite writes cannot enter another operation's async transaction");
  }
  if (state.pending && !ownsActiveTransaction(state, capability)) {
    throw transactionError("SQLITE_RAW_WRITE_BLOCKED", "Raw SQLite writes cannot bypass queued async transactions");
  }
}

function isReadOnlyPragma(sql) {
  const match = sqlWithoutLeadingComments(sql).match(/^PRAGMA\s+(?:(?:[A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/i);
  if (!match) return false;
  const [, name, suffixText] = match;
  const normalizedName = name.toLowerCase();
  const suffix = suffixText.trim().replace(/;\s*$/, "").trim();
  if (!suffix) return READ_ONLY_PRAGMAS.has(normalizedName);
  if (suffix.startsWith("=")) return false;
  return READ_ONLY_PRAGMA_ARGUMENTS.has(normalizedName) && /^\([\s\S]*\)$/.test(suffix);
}

function isReadOnlyStatement(sql) {
  return /^(?:SELECT|EXPLAIN)\b/i.test(sqlWithoutLeadingComments(sql)) || isReadOnlyPragma(sql);
}

function isTransactionControlStatement(sql) {
  return /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sqlWithoutLeadingComments(sql));
}

function sqlWithoutLeadingComments(sql) {
  let value = String(sql).trimStart();
  while (value.startsWith("--") || value.startsWith("/*")) {
    if (value.startsWith("--")) {
      const newline = value.indexOf("\n");
      if (newline < 0) return "";
      value = value.slice(newline + 1).trimStart();
      continue;
    }
    const end = value.indexOf("*/", 2);
    if (end < 0) return "";
    value = value.slice(end + 2).trimStart();
  }
  return value;
}

function prepareReadOnlyStatement(connection, state, sql) {
  assertHealthyConnection(state);
  if (!isReadOnlyStatement(sql)) {
    throw transactionError("SQLITE_QUERY_NOT_READ_ONLY", "SQLite query accepts read-only SQL only");
  }
  state.readPreparationSql = String(sql);
  try {
    return connection.prepare(sql);
  } catch (cause) {
    if (/not authorized/i.test(String(cause?.message || cause))) {
      throw transactionError("SQLITE_QUERY_NOT_READ_ONLY", "SQLite query accepts read-only SQL only");
    }
    throw cause;
  } finally {
    state.readPreparationSql = null;
  }
}

function guardedStatement(statement, state, capability, sql) {
  const readOnly = isReadOnlyStatement(sql);
  const read = (method) => (...parameters) => {
    assertHealthyConnection(state);
    if (!readOnly) assertRawMutationAllowed(state, capability);
    return statement[method](...parameters);
  };
  return Object.freeze({
    all: read("all"),
    get: read("get"),
    iterate: read("iterate"),
    run: (...parameters) => {
      assertHealthyConnection(state);
      assertRawMutationAllowed(state, capability);
      return statement.run(...parameters);
    },
  });
}

function guardedConnection(connection, state, capability) {
  const facade = Object.freeze({
    prepare: (sql) => {
      assertHealthyConnection(state);
      if (isTransactionControlStatement(sql)) {
        throw transactionError("SQLITE_RAW_WRITE_BLOCKED", "Prepared SQLite transaction control is not exposed publicly");
      }
      state.publicPreparation = true;
      try {
        return guardedStatement(connection.prepare(sql), state, capability, sql);
      } catch (cause) {
        if (/not authorized/i.test(String(cause?.message || cause))) {
          throw transactionError("SQLITE_RAW_WRITE_BLOCKED", "Prepared SQLite transaction control is not exposed publicly");
        }
        throw cause;
      } finally {
        state.publicPreparation = false;
      }
    },
    exec: (sql) => {
      assertRawMutationAllowed(state, capability);
      return connection.exec(sql);
    },
  });
  SQLITE_FACADE_TARGETS.set(facade, connection);
  return facade;
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
  #capability;
  #connection;
  #guardedConnection;
  #ownsConnection;
  #transactionManager;
  #transactionState;

  constructor({ databasePath, connection = null }) {
    super({ dialect: DATABASE_DIALECTS.SQLITE });
    if (!connection && !databasePath) throw new TypeError("SQLite database path is required");
    if (connection && !sharedConnection(connection)) {
      throw new TypeError("A provider-owned SQLite connection facade is required");
    }
    if (databasePath) mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath || null;
    this.#capability = {};
    this.#connection = sharedConnection(connection) || new DatabaseSync(databasePath);
    this.#transactionState = connectionState(this.#connection);
    assertRawMutationAllowed(this.#transactionState, this.#capability);
    this.#guardedConnection = guardedConnection(this.#connection, this.#transactionState, this.#capability);
    Object.defineProperty(this, "connection", {
      configurable: false,
      enumerable: false,
      get: () => {
        assertHealthyConnection(this.#transactionState);
        return this.#guardedConnection;
      },
    });
    this.#ownsConnection = !connection;
    this.#connection.exec("PRAGMA busy_timeout = 5000");
    this.#connection.exec("PRAGMA foreign_keys = ON");
    if (this.#ownsConnection) withSqliteBusyRetry(() => this.#connection.exec("PRAGMA journal_mode = WAL"));
    this.#transactionManager = new TransactionManager({
      begin: () => {
        const state = this.#transactionState;
        if (state.activeToken || state.pending || state.synchronousToken) {
          throw transactionError("SQLITE_TRANSACTION_BUSY", "SQLite connection already has an active or queued transaction");
        }
        const token = { capability: this.#capability };
        state.synchronousToken = token;
        try {
          assertSynchronousTransactionOwner(state, token);
          withSqliteBusyRetry(() => executeManagedTransactionControl(this.#connection, state, token, "BEGIN IMMEDIATE"));
          return token;
        } catch (cause) {
          if (state.synchronousToken === token) state.synchronousToken = null;
          throw cause;
        }
      },
      commit: (token) => {
        const state = this.#transactionState;
        assertSynchronousTransactionOwner(state, token);
        executeManagedTransactionControl(this.#connection, state, token, "COMMIT");
        if (state.synchronousToken === token) state.synchronousToken = null;
      },
      rollback: (token) => {
        const state = this.#transactionState;
        assertSynchronousTransactionOwner(state, token);
        try {
          executeManagedTransactionControl(this.#connection, state, token, "ROLLBACK");
          if (state.synchronousToken === token) state.synchronousToken = null;
        } catch (cause) {
          poisonConnection(state, cause);
          throw cause;
        }
      },
    });
    if (new.target === SqliteProvider) SQLITE_PROVIDER_INSTANCES.add(this);
  }

  get connection() {
    assertHealthyConnection(this.#transactionState);
    // Raw reads remain synchronous and may observe this connection's current
    // transaction. Raw mutations are guarded; provider executors are preferred.
    return this.#guardedConnection;
  }

  get transactionManager() {
    assertHealthyConnection(this.#transactionState);
    return this.#transactionManager;
  }

  withBusyRetry(callback, options) {
    return withSqliteBusyRetry(callback, options);
  }

  hasColumn(tableName, columnName) {
    assertHealthyConnection(this.#transactionState);
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!identifier.test(tableName) || !identifier.test(columnName)) {
      throw new TypeError("SQLite schema identifier is invalid");
    }
    return this.#connection.prepare(`PRAGMA table_info('${tableName}')`).all()
      .some((column) => column.name === columnName);
  }

  async query(text, parameters = []) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL query text is required");
    if (!Array.isArray(parameters)) throw new TypeError("SQL query parameters must be an array");
    const state = this.#transactionState;
    const release = reserveAsyncOperation(state);
    try {
      const statement = prepareReadOnlyStatement(this.#connection, state, text);
      await this.#waitForTransactionAccess();
      assertHealthyConnection(state);
      const rows = statement.all(...parameters);
      return { rows, rowCount: rows.length };
    } finally {
      release();
    }
  }

  async execute(text, parameters = []) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL statement text is required");
    if (!Array.isArray(parameters)) throw new TypeError("SQL statement parameters must be an array");
    const state = this.#transactionState;
    const release = reserveAsyncOperation(state);
    try {
      await this.#waitForTransactionAccess({ mutation: true });
      assertHealthyConnection(state);
      const result = withSqliteBusyRetry(() => this.#connection.prepare(text).run(...parameters));
      return { rows: [], rowCount: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid };
    } finally {
      release();
    }
  }

  async executeScript(text) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("SQL script text is required");
    const state = this.#transactionState;
    const release = reserveAsyncOperation(state);
    try {
      await this.#waitForTransactionAccess({ mutation: true });
      assertHealthyConnection(state);
      withSqliteBusyRetry(() => this.#connection.exec(text));
      return { rows: [], rowCount: 0 };
    } finally {
      release();
    }
  }

  placeholder(index) {
    if (!Number.isInteger(index) || index < 1) throw new TypeError("SQL placeholder index must be a positive integer");
    return "?";
  }

  async transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("Transaction callback is required");
    const state = this.#transactionState;
    assertHealthyConnection(state);
    const owner = SQLITE_TRANSACTION_CONTEXT.getStore();
    if (state.activeToken && owner?.state === state && owner.token === state.activeToken) {
      throw transactionError("SQLITE_TRANSACTION_REENTRANT", "Nested SQLite transactions must reuse the supplied transaction executor");
    }
    if (state.synchronousToken) throw transactionError("SQLITE_TRANSACTION_BUSY", "SQLite connection has an active synchronous transaction");
    state.pending += 1;
    const previous = state.tail;
    const run = previous.then(async () => {
      state.pending -= 1;
      assertHealthyConnection(state);
      const token = {};
      state.activeToken = token;
      return SQLITE_TRANSACTION_CONTEXT.run({ state, token, capability: this.#capability }, async () => {
        let begun = false;
        try {
          assertAsyncTransactionOwner(state, token, this.#capability);
          withSqliteBusyRetry(() => executeManagedTransactionControl(this.#connection, state, token, "BEGIN IMMEDIATE"));
          begun = true;
          try {
            const result = await callback(this);
            assertAsyncTransactionOwner(state, token, this.#capability);
            executeManagedTransactionControl(this.#connection, state, token, "COMMIT");
            begun = false;
            return result;
          } catch (error) {
            if (begun) try {
              assertAsyncTransactionOwner(state, token, this.#capability);
              executeManagedTransactionControl(this.#connection, state, token, "ROLLBACK");
              begun = false;
            } catch (cause) {
              poisonConnection(state, cause);
            }
            throw error;
          }
        } finally {
          if (!begun && state.activeToken === token) state.activeToken = null;
        }
      });
    });
    state.tail = run.catch(() => {});
    return run;
  }

  async #waitForTransactionAccess({ mutation = false } = {}) {
    const state = this.#transactionState;
    assertHealthyConnection(state);
    if (mutation && state.synchronousToken) {
      throw transactionError(
        "SQLITE_TRANSACTION_BUSY",
        "Async SQLite mutations cannot enter an active synchronous transaction",
      );
    }
    const owner = SQLITE_TRANSACTION_CONTEXT.getStore();
    if (owner?.state === state && owner.token === state.activeToken) {
      if (owner.capability === this.#capability) return;
      throw transactionError(
        mutation ? "SQLITE_RAW_WRITE_BLOCKED" : "SQLITE_TRANSACTION_BUSY",
        "A foreign SQLite provider cannot enter the active transaction context",
      );
    }
    while (state.activeToken || state.pending) {
      await state.tail;
      assertHealthyConnection(state);
    }
  }

  async withTransaction(callback) {
    return this.transaction(callback);
  }

  close() {
    if (!this.#ownsConnection) return;
    const state = this.#transactionState;
    if (state.closed) return;
    if (state.activeToken || state.inFlight || state.pending || state.synchronousToken) {
      throw transactionError("SQLITE_TRANSACTION_BUSY", "SQLite connection has active or queued transaction work");
    }
    this.#connection.close();
    state.closed = true;
  }
}

export function resolveSqliteProvider(value) {
  if (SQLITE_PROVIDER_INSTANCES.has(value)) return value;
  if (SQLITE_PROVIDER_INSTANCES.has(value?.provider)) return value.provider;
  const connection = value?.db?.prepare ? value.db : value;
  if (sharedConnection(connection)) return new SqliteProvider({ connection });
  throw new TypeError("A SQLite provider or provider-owned connection facade is required");
}
