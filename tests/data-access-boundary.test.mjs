import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { openConfiguredCommerceDataAccess } from "../lib/data/data-access.mjs";
import { resolveSqliteProvider, SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-data-access-"));
  const dataAccess = openCommerceDataAccess({
    rootDir: path.resolve("."),
    databasePath: path.join(root, "commerce.sqlite"),
    migrationsDir: path.resolve("migrations"),
  });
  return {
    root,
    dataAccess,
    close: async () => {
      dataAccess.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

class IdentityClient {
  async query(query) {
    const text = typeof query === "string" ? query : query.text;
    if (text.includes("set_config")) return { rows: [{}], rowCount: 1 };
    if (text.includes("current_database")) return { rows: [{ database: "commerce_ops", username: "commerce_app", schema: "app" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  release() {}
}
class IdentityPool {
  on() {}
  async connect() { return new IdentityClient(); }
  async end() {}
}

test("explicit PostgreSQL data access selects shared adapters without touching SQLite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-data-access-postgres-"));
  const databasePath = path.join(root, "must-not-exist.sqlite");
  const dataAccess = await openCommerceDataAccess({
    rootDir: path.resolve("."), databasePath, providerName: "postgres",
    postgresqlConfig: {
      host: "10.110.80.117", port: 5432, database: "commerce_ops", schema: "app", appUser: "commerce_app",
      sslmode: "verify-full", channelBinding: "require", ssl: { ca: "PUBLIC", rejectUnauthorized: true },
      poolMax: 2, poolIdleTimeoutMs: 1000, connectionTimeoutMs: 1000, statementTimeoutMs: 1000,
    },
    credentials: { password: "local-only" }, PoolClass: IdentityPool,
  });
  try {
    assert.equal(dataAccess.provider.dialect, "postgresql");
    assert.equal(dataAccess.repositories.scheduler.constructor.name, "PostgresqlSchedulerRepository");
    assert.equal(dataAccess.repositories.fileLifecycle.constructor.name, "PostgresqlFileLifecycleRepository");
    assert.equal(dataAccess.repositories.fileReview.constructor.name, "PostgresqlFileReviewRepository");
    assert.equal(dataAccess.repositories.shopeeHealth.constructor.name, "PostgresqlShopeeHealthRepository");
    assert.equal(dataAccess.repositories.shopeeAdvertising.constructor.name, "PostgresqlShopeeAdvertisingRepository");
    assert.equal(dataAccess.repositories.shopeeDiscount.constructor.name, "PostgresqlShopeeDiscountRepository");
    await assert.rejects(() => fs.stat(databasePath), { code: "ENOENT" });
  } finally { await dataAccess.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("configured PostgreSQL startup rejects a missing local password", async () => {
  await assert.rejects(() => openConfiguredCommerceDataAccess({
    runtimeConfig: { databaseProvider: "postgres", appRoot: path.resolve("."), databasePath: "ignored.sqlite" },
    env: {},
  }), /POSTGRES_APP_PASSWORD is required/);
});

test("all repositories share the provider-owned SQLite connection", async () => {
  const context = await fixture();
  try {
    const { provider, repositories } = context.dataAccess;
    assert.equal(repositories.scheduler.provider, provider);
    assert.equal(repositories.exportFiles.provider.connection, provider.connection);
    assert.equal(repositories.audit.provider.connection, provider.connection);
    assert.equal(repositories.fileLifecycle.provider.connection, provider.connection);
    assert.equal(repositories.fileReview.provider.connection, provider.connection);
  } finally {
    await context.close();
  }
});

test("transaction manager commits successful work", async () => {
  const context = await fixture();
  try {
    const { provider, transactionManager } = context.dataAccess;
    provider.connection.exec("CREATE TABLE e2_transaction_test (value TEXT NOT NULL)");
    transactionManager.run(() => provider.connection.prepare("INSERT INTO e2_transaction_test(value) VALUES (?)").run("committed"));
    const row = provider.connection.prepare("SELECT value FROM e2_transaction_test").get();
    assert.equal(row.value, "committed");
  } finally {
    await context.close();
  }
});

test("transaction manager rolls failed work back", async () => {
  const context = await fixture();
  try {
    const { provider, transactionManager } = context.dataAccess;
    provider.connection.exec("CREATE TABLE e2_transaction_test (value TEXT NOT NULL)");
    assert.throws(() => transactionManager.run(() => {
      provider.connection.prepare("INSERT INTO e2_transaction_test(value) VALUES (?)").run("rolled-back");
      throw new Error("expected test rollback");
    }), /expected test rollback/);
    const row = provider.connection.prepare("SELECT COUNT(*) count FROM e2_transaction_test").get();
    assert.equal(row.count, 0);
  } finally {
    await context.close();
  }
});

test("transaction manager exposes only the run capability", async () => {
  const context = await fixture();
  try {
    const { transactionManager } = context.dataAccess;
    assert.equal(typeof transactionManager.run, "function");
    assert.equal(transactionManager.begin, undefined);
    assert.equal(transactionManager.commit, undefined);
    assert.equal(transactionManager.rollback, undefined);
  } finally {
    await context.close();
  }
});

test("SQLite provider hides the native connection behind a minimal compatibility facade", async () => {
  const context = await fixture();
  try {
    const { provider } = context.dataAccess;
    assert.equal(provider._connection, undefined);
    assert.deepEqual(Object.getOwnPropertySymbols(provider), []);
    assert.equal(typeof provider.connection.prepare, "function");
    assert.equal(typeof provider.connection.exec, "function");
    assert.deepEqual(Object.keys(provider.connection).sort(), ["exec", "prepare"]);
    for (const capability of ["applyChangeset", "createSession", "close", "function", "loadExtension"]) {
      assert.equal(provider.connection[capability], undefined, capability);
    }
    const statement = provider.connection.prepare("SELECT 1 AS value");
    assert.equal(statement.get().value, 1);
    assert.deepEqual(Object.keys(statement).sort(), ["all", "get", "iterate", "run"]);
    for (const capability of ["columns", "setAllowBareNamedParameters", "setReadBigInts", "setReturnArrays"]) {
      assert.equal(statement[capability], undefined, capability);
    }
  } finally {
    await context.close();
  }
});

test("SQLite provider rejects externally retained native connections", () => {
  const native = new DatabaseSync(":memory:");
  const forgedProvider = Object.create(SqliteProvider.prototype);
  Object.defineProperty(forgedProvider, "connection", { value: native });
  class OverridingProvider extends SqliteProvider {
    get connection() { return native; }
  }
  const overridingProvider = new OverridingProvider({ databasePath: ":memory:" });
  const genuineProvider = new SqliteProvider({ databasePath: ":memory:" });
  try {
    assert.throws(
      () => new SqliteProvider({ connection: native }),
      /provider-owned SQLite connection facade is required/,
    );
    assert.throws(
      () => resolveSqliteProvider(native),
      /SQLite provider or provider-owned connection facade is required/,
    );
    assert.throws(
      () => resolveSqliteProvider({ dialect: "sqlite", connection: native }),
      /SQLite provider or provider-owned connection facade is required/,
    );
    assert.throws(
      () => resolveSqliteProvider({ provider: { dialect: "sqlite", connection: native } }),
      /SQLite provider or provider-owned connection facade is required/,
    );
    assert.throws(
      () => resolveSqliteProvider(forgedProvider),
      /SQLite provider or provider-owned connection facade is required/,
    );
    assert.throws(
      () => resolveSqliteProvider({ provider: forgedProvider }),
      /SQLite provider or provider-owned connection facade is required/,
    );
    assert.throws(
      () => resolveSqliteProvider(overridingProvider),
      /SQLite provider or provider-owned connection facade is required/,
    );
    assert.throws(
      () => Object.defineProperty(genuineProvider, "connection", { value: native }),
      TypeError,
    );
    assert.equal(resolveSqliteProvider(genuineProvider), genuineProvider);
    assert.equal(resolveSqliteProvider({ provider: genuineProvider }), genuineProvider);
    assert.notEqual(genuineProvider.connection, native);
    assert.throws(
      () => resolveSqliteProvider({ prepare() {}, exec() {} }),
      /SQLite provider or provider-owned connection facade is required/,
    );
  } finally {
    genuineProvider.close();
    overridingProvider.close();
    native.close();
  }
});

test("SQLite provider serializes async transactions across provider instances sharing one connection", async () => {
  const context = await fixture();
  const shared = new SqliteProvider({ connection: context.dataAccess.provider.connection });
  try {
    const provider = context.dataAccess.provider;
    await provider.execute("CREATE TABLE e2_async_transaction_test (value TEXT NOT NULL)");
    const order = [];
    let releaseFirst;
    const firstOpen = new Promise((resolve) => { releaseFirst = resolve; });
    let enteredFirst;
    const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
    const first = provider.transaction(async (tx) => {
      order.push("first:begin");
      await tx.execute("INSERT INTO e2_async_transaction_test(value) VALUES (?)", ["first"]);
      enteredFirst();
      await firstOpen;
      order.push("first:end");
    });
    await firstEntered;
    const second = shared.transaction(async (tx) => {
      order.push("second:begin");
      await tx.execute("INSERT INTO e2_async_transaction_test(value) VALUES (?)", ["second"]);
      order.push("second:end");
    });
    await Promise.resolve();
    assert.deepEqual(order, ["first:begin"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:begin", "first:end", "second:begin", "second:end"]);
    assert.deepEqual((await provider.query("SELECT value FROM e2_async_transaction_test ORDER BY rowid")).rows.map(({ value }) => value), ["first", "second"]);
  } finally { shared.close(); await context.close(); }
});

test("a provider cannot inherit another provider's active async transaction authority", async () => {
  const context = await fixture();
  const shared = new SqliteProvider({ connection: context.dataAccess.provider.connection });
  try {
    const provider = context.dataAccess.provider;
    await provider.execute("CREATE TABLE e2_async_capability_test (value TEXT NOT NULL)");
    await provider.transaction(async (tx) => {
      await tx.execute("INSERT INTO e2_async_capability_test(value) VALUES (?)", ["owner-before"]);
      assert.throws(
        () => shared.connection.prepare("INSERT INTO e2_async_capability_test(value) VALUES (?)").run("foreign-raw"),
        { code: "SQLITE_RAW_WRITE_BLOCKED" },
      );
      await assert.rejects(
        shared.execute("INSERT INTO e2_async_capability_test(value) VALUES (?)", ["foreign-executor"]),
        { code: "SQLITE_RAW_WRITE_BLOCKED" },
      );
      assert.throws(() => shared.transactionManager.run(() => {}), { code: "SQLITE_TRANSACTION_BUSY" });
      assert.throws(() => tx.connection.exec("COMMIT"));
      assert.throws(() => tx.connection.prepare("ROLLBACK"));
      await tx.execute("INSERT INTO e2_async_capability_test(value) VALUES (?)", ["owner-after"]);
    });
    assert.deepEqual(
      (await provider.query("SELECT value FROM e2_async_capability_test ORDER BY rowid")).rows.map(({ value }) => value),
      ["owner-before", "owner-after"],
    );
  } finally {
    shared.close();
    await context.close();
  }
});

test("cached SQLite writes and mutating PRAGMAs cannot enter queued or active async transactions", async () => {
  const context = await fixture();
  let release;
  let active;
  try {
    const { provider } = context.dataAccess;
    await provider.execute("CREATE TABLE e2_guarded_mutation_test (value TEXT NOT NULL)");
    const insert = provider.connection.prepare("INSERT INTO e2_guarded_mutation_test(value) VALUES (?)");
    const exec = provider.connection.exec;
    const pragmaGet = provider.connection.prepare("PRAGMA user_version = 7");
    const pragmaAll = provider.connection.prepare("PRAGMA user_version = 8");
    const pragmaIterate = provider.connection.prepare("PRAGMA user_version = 9");
    const pragmaRun = provider.connection.prepare("PRAGMA user_version = 10");
    const pragmaAction = provider.connection.prepare("PRAGMA optimize");
    const blockedMutations = [
      () => insert.run("foreign"),
      () => exec("INSERT INTO e2_guarded_mutation_test(value) VALUES ('foreign')"),
      () => pragmaGet.get(),
      () => pragmaAll.all(),
      () => [...pragmaIterate.iterate()],
      () => pragmaRun.run(),
      () => pragmaAction.get(),
      () => exec("PRAGMA user_version = 11"),
    ];
    const assertBlocked = () => {
      for (const mutate of blockedMutations) {
        assert.throws(mutate, { code: "SQLITE_RAW_WRITE_BLOCKED" });
      }
    };

    const hold = new Promise((resolve) => { release = resolve; });
    let entered;
    const opened = new Promise((resolve) => { entered = resolve; });
    active = provider.transaction(async () => {
      entered();
      await hold;
    });
    assertBlocked();
    await opened;
    assertBlocked();
    release();
    await active;
    assert.equal((await provider.query("SELECT COUNT(*) count FROM e2_guarded_mutation_test")).rows[0].count, 0);
    assert.equal((await provider.query("PRAGMA user_version")).rows[0].user_version, 0);
  } finally {
    release?.();
    await active?.catch(() => {});
    await context.close();
  }
});

test("synchronous transaction run rejects queued async ownership and works again when idle", async () => {
  const context = await fixture();
  try {
    const { provider, transactionManager } = context.dataAccess;
    await provider.execute("CREATE TABLE e2_sync_queue_test (value TEXT NOT NULL)");
    const queued = provider.transaction(async (tx) => {
      await tx.execute("INSERT INTO e2_sync_queue_test(value) VALUES (?)", ["async"]);
    });
    assert.throws(() => transactionManager.run(() => {}), { code: "SQLITE_TRANSACTION_BUSY" });
    await queued;
    transactionManager.run(() => {
      provider.connection.prepare("INSERT INTO e2_sync_queue_test(value) VALUES (?)").run("sync");
    });
    assert.deepEqual(
      (await provider.query("SELECT value FROM e2_sync_queue_test ORDER BY rowid")).rows.map(({ value }) => value),
      ["async", "sync"],
    );
  } finally {
    await context.close();
  }
});

test("a provider cannot finish or mutate another provider's synchronous transaction", async () => {
  const context = await fixture();
  const shared = new SqliteProvider({ connection: context.dataAccess.provider.connection });
  try {
    const { provider, transactionManager } = context.dataAccess;
    await provider.execute("CREATE TABLE e2_sync_capability_test (value TEXT NOT NULL)");
    transactionManager.run(() => {
      provider.connection.prepare("INSERT INTO e2_sync_capability_test(value) VALUES (?)").run("owner-before");
      assert.throws(
        () => shared.connection.prepare("INSERT INTO e2_sync_capability_test(value) VALUES (?)").run("foreign"),
        { code: "SQLITE_RAW_WRITE_BLOCKED" },
      );
      for (const sql of ["COMMIT", "ROLLBACK", "SAVEPOINT escaped"]) {
        assert.throws(() => provider.connection.exec(sql));
        assert.throws(() => shared.connection.exec(sql));
      }
      provider.connection.prepare("INSERT INTO e2_sync_capability_test(value) VALUES (?)").run("owner-after");
    });
    assert.deepEqual(
      (await provider.query("SELECT value FROM e2_sync_capability_test ORDER BY rowid")).rows.map(({ value }) => value),
      ["owner-before", "owner-after"],
    );
  } finally {
    shared.close();
    await context.close();
  }
});

test("cached public statements cannot finish a later managed transaction", async () => {
  const context = await fixture();
  try {
    const { provider } = context.dataAccess;
    for (const sql of [
      "COMMIT",
      "ROLLBACK",
      "SAVEPOINT escaped",
      "RELEASE escaped",
      "/* cached */ COMMIT",
      "-- cached\nROLLBACK",
      "/* cached */ SAVEPOINT escaped",
      "-- cached\nRELEASE escaped",
    ]) {
      assert.throws(
        () => provider.connection.prepare(sql),
        { code: "SQLITE_RAW_WRITE_BLOCKED" },
      );
    }
  } finally {
    await context.close();
  }
});

test("async provider mutations started during synchronous run never escape its rollback", async () => {
  const context = await fixture();
  try {
    const { provider, transactionManager } = context.dataAccess;
    await provider.execute("CREATE TABLE e2_sync_async_escape_test (value TEXT NOT NULL)");
    let mutation;
    assert.throws(() => transactionManager.run(() => {
      provider.connection.prepare("INSERT INTO e2_sync_async_escape_test(value) VALUES (?)").run("sync");
      mutation = provider.execute("INSERT INTO e2_sync_async_escape_test(value) VALUES (?)", ["async"]);
      return mutation;
    }), /does not accept async callbacks/);
    await assert.rejects(mutation, { code: "SQLITE_TRANSACTION_BUSY" });
    assert.equal((await provider.query("SELECT COUNT(*) count FROM e2_sync_async_escape_test")).rows[0].count, 0);
  } finally {
    await context.close();
  }
});

test("query rejects mutations before they can escape a synchronous rollback", async () => {
  const context = await fixture();
  try {
    const { provider, transactionManager } = context.dataAccess;
    await provider.execute("CREATE TABLE e2_query_read_only_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await provider.execute("INSERT INTO e2_query_read_only_test(id,value) VALUES (?,?)", [1, "baseline"]);
    const attempts = [];
    assert.throws(() => transactionManager.run(() => {
      attempts.push(provider.query("INSERT INTO e2_query_read_only_test(id,value) VALUES (2,'inserted') RETURNING id"));
      attempts.push(provider.query("UPDATE e2_query_read_only_test SET value='updated' WHERE id=1 RETURNING id"));
      attempts.push(provider.query("DELETE FROM e2_query_read_only_test WHERE id=1 RETURNING id"));
      attempts.push(provider.query("PRAGMA user_version = 42"));
      throw new Error("rollback owner");
    }), /rollback owner/);
    for (const attempt of attempts) {
      await assert.rejects(attempt, { code: "SQLITE_QUERY_NOT_READ_ONLY" });
    }
    assert.deepEqual(
      (await provider.query("SELECT id,value FROM e2_query_read_only_test ORDER BY id")).rows.map(({ id, value }) => ({ id, value })),
      [{ id: 1, value: "baseline" }],
    );
    assert.equal((await provider.query("PRAGMA user_version")).rows[0].user_version, 0);
  } finally {
    await context.close();
  }
});

test("rollback cleanup failure poisons every public database surface", async () => {
  const context = await fixture();
  try {
    const { provider } = context.dataAccess;
    await provider.execute("CREATE TABLE e2_poison_test (id INTEGER PRIMARY KEY)");
    const facade = provider.connection;
    const transactionManager = provider.transactionManager;
    const cachedRead = facade.prepare("SELECT COUNT(*) count FROM e2_poison_test");
    const cachedWrite = facade.prepare("INSERT INTO e2_poison_test(id) VALUES (?)");
    await assert.rejects(provider.transaction(async (tx) => {
      await tx.execute("INSERT INTO e2_poison_test(id) VALUES (?)", [1]);
      await tx.execute("INSERT OR ROLLBACK INTO e2_poison_test(id) VALUES (?)", [1]);
    }));

    const poisoned = { code: "SQLITE_TRANSACTION_POISONED" };
    assert.throws(() => provider.connection, poisoned);
    assert.throws(() => provider.transactionManager, poisoned);
    assert.throws(() => facade.prepare("SELECT 1"), poisoned);
    assert.throws(() => cachedRead.get(), poisoned);
    assert.throws(() => cachedRead.all(), poisoned);
    assert.throws(() => [...cachedRead.iterate()], poisoned);
    assert.throws(() => cachedWrite.run(2), poisoned);
    assert.throws(() => facade.exec("SELECT 1"), poisoned);
    assert.throws(() => provider.hasColumn("e2_poison_test", "id"), poisoned);
    assert.throws(() => transactionManager.run(() => {}), poisoned);
    await assert.rejects(provider.query("SELECT 1"), poisoned);
    await assert.rejects(provider.execute("INSERT INTO e2_poison_test(id) VALUES (?)", [2]), poisoned);
    await assert.rejects(provider.executeScript("SELECT 1"), poisoned);
    await assert.rejects(provider.transaction(async () => {}), poisoned);
    await assert.rejects(provider.withTransaction(async () => {}), poisoned);
  } finally {
    await context.close();
  }
});

test("SQLite owner close rejects managed work while non-owner close has no effect", async () => {
  const context = await fixture();
  const { provider, transactionManager } = context.dataAccess;
  const shared = new SqliteProvider({ connection: provider.connection });
  let release;
  let first;
  try {
    shared.close();
    assert.equal((await shared.query("SELECT 1 value")).rows[0].value, 1);
    transactionManager.run(() => {
      assert.throws(() => provider.close(), { code: "SQLITE_TRANSACTION_BUSY" });
    });

    const hold = new Promise((resolve) => { release = resolve; });
    let entered;
    const opened = new Promise((resolve) => { entered = resolve; });
    first = provider.transaction(async () => {
      entered();
      await hold;
    });
    await opened;
    const second = shared.transaction(async () => {});
    assert.throws(() => provider.close(), { code: "SQLITE_TRANSACTION_BUSY" });
    release();
    await Promise.all([first, second]);
  } finally {
    release?.();
    await first?.catch(() => {});
    shared.close();
    await context.close();
  }
});

test("SQLite owner close cannot overtake reserved async database operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-provider-inflight-close-"));
  const provider = new SqliteProvider({ databasePath: path.join(root, "close.sqlite") });
  try {
    await provider.execute("CREATE TABLE e2_inflight_close_test (id INTEGER PRIMARY KEY)");
    const operations = [
      provider.execute("INSERT INTO e2_inflight_close_test(id) VALUES (?)", [1]),
      provider.executeScript("INSERT INTO e2_inflight_close_test(id) VALUES (2)"),
      provider.query("SELECT COUNT(*) count FROM e2_inflight_close_test"),
    ];
    assert.throws(() => provider.close(), { code: "SQLITE_TRANSACTION_BUSY" });
    await Promise.all(operations);
    assert.equal((await provider.query("SELECT COUNT(*) count FROM e2_inflight_close_test")).rows[0].count, 2);
  } finally {
    provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("already-started async database operations fail closed across poison transition", async () => {
  const context = await fixture();
  try {
    const { provider, transactionManager } = context.dataAccess;
    await provider.execute("CREATE TABLE e2_inflight_poison_test (id INTEGER PRIMARY KEY)");
    const operations = [
      provider.execute("INSERT INTO e2_inflight_poison_test(id) VALUES (?)", [2]),
      provider.executeScript("INSERT INTO e2_inflight_poison_test(id) VALUES (3)"),
      provider.query("SELECT COUNT(*) count FROM e2_inflight_poison_test"),
    ];
    assert.throws(() => transactionManager.run(() => {
      provider.connection.prepare("INSERT INTO e2_inflight_poison_test(id) VALUES (?)").run(1);
      provider.connection.prepare("INSERT OR ROLLBACK INTO e2_inflight_poison_test(id) VALUES (?)").run(1);
    }));
    assert.throws(() => provider.close(), { code: "SQLITE_TRANSACTION_BUSY" });
    for (const operation of operations) {
      await assert.rejects(operation, { code: "SQLITE_TRANSACTION_POISONED" });
    }
    assert.doesNotThrow(() => provider.close());
  } finally {
    await context.close();
  }
});

test("SQLite owner close is idempotent and use after close has a stable error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-provider-close-"));
  const provider = new SqliteProvider({ databasePath: path.join(root, "close.sqlite") });
  const facade = provider.connection;
  const cachedRead = facade.prepare("SELECT 1 value");
  provider.close();
  assert.doesNotThrow(() => provider.close());
  const closed = { code: "SQLITE_CONNECTION_CLOSED" };
  assert.throws(() => provider.connection, closed);
  assert.throws(() => provider.transactionManager, closed);
  assert.throws(() => facade.prepare("SELECT 1"), closed);
  assert.throws(() => cachedRead.get(), closed);
  assert.throws(() => provider.hasColumn("anything", "id"), closed);
  await assert.rejects(provider.query("SELECT 1"), closed);
  await assert.rejects(provider.execute("CREATE TABLE escaped(id INTEGER)"), closed);
  await assert.rejects(provider.executeScript("SELECT 1"), closed);
  await assert.rejects(provider.transaction(async () => {}), closed);
  await fs.rm(root, { recursive: true, force: true });
});

test("SQLite provider rejects nested and synchronous foreign transactions deterministically without foreign commit", async () => {
  const context = await fixture();
  const shared = new SqliteProvider({ connection: context.dataAccess.provider.connection });
  try {
    const provider = context.dataAccess.provider;
    await provider.execute("CREATE TABLE e2_nested_transaction_test (value TEXT NOT NULL)");
    await assert.rejects(provider.transaction(async (tx) => {
      await tx.execute("INSERT INTO e2_nested_transaction_test(value) VALUES (?)", ["outer"]);
      await shared.transaction(async () => {});
    }), { code: "SQLITE_TRANSACTION_REENTRANT" });
    assert.equal((await provider.query("SELECT COUNT(*) count FROM e2_nested_transaction_test")).rows[0].count, 0);

    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    let entered;
    const opened = new Promise((resolve) => { entered = resolve; });
    const active = provider.transaction(async (tx) => {
      await tx.execute("INSERT INTO e2_nested_transaction_test(value) VALUES (?)", ["owned"]);
      entered();
      await hold;
    });
    await opened;
    assert.equal(shared.transactionManager.begin, undefined);
    assert.equal(shared.transactionManager.commit, undefined);
    assert.equal(shared.transactionManager.rollback, undefined);
    assert.throws(() => shared.transactionManager.run(() => {}), { code: "SQLITE_TRANSACTION_BUSY" });
    for (const sql of [
      "BEGIN IMMEDIATE",
      "COMMIT",
      "ROLLBACK",
      "INSERT INTO e2_nested_transaction_test(value) VALUES ('foreign')",
    ]) assert.throws(() => shared.connection.exec(sql), { code: "SQLITE_RAW_WRITE_BLOCKED" });
    release();
    await active;
    assert.deepEqual((await provider.query("SELECT value FROM e2_nested_transaction_test")).rows.map(({ value }) => value), ["owned"]);
  } finally { shared.close(); await context.close(); }
});

test("detached async context created inside a SQLite transaction is not stale ownership after commit", async () => {
  const context = await fixture();
  try {
    const provider = context.dataAccess.provider;
    await provider.execute("CREATE TABLE e2_detached_transaction_test (value TEXT NOT NULL)");
    let detached;
    await provider.transaction(async (tx) => {
      await tx.execute("INSERT INTO e2_detached_transaction_test(value) VALUES (?)", ["outer"]);
      detached = () => provider.transaction(async (nested) => {
        await nested.execute("INSERT INTO e2_detached_transaction_test(value) VALUES (?)", ["detached"]);
      });
      await assert.rejects(provider.transaction(async () => {}), { code: "SQLITE_TRANSACTION_REENTRANT" });
    });
    await detached();
    assert.deepEqual((await provider.query("SELECT value FROM e2_detached_transaction_test ORDER BY rowid")).rows.map(({ value }) => value),
      ["outer", "detached"]);
  } finally { await context.close(); }
});

test("account repository facade preserves existing CRUD behavior", async () => {
  const context = await fixture();
  try {
    const account = context.dataAccess.repositories.accounts.save({
      name: "E2 test account",
      username: "test@example.com",
      encryptedPassword: "test-ciphertext",
      enabled: true,
    });
    assert.match(account.id, /^[0-9a-f-]{36}$/i);
    assert.equal(context.dataAccess.repositories.accounts.get(account.id).username, "test@example.com");
    assert.equal(context.dataAccess.repositories.accounts.list().length, 1);
    assert.equal(context.dataAccess.repositories.accounts.delete(account.id), 1);
  } finally {
    await context.close();
  }
});

test("business services and HTTP route modules do not execute SQLite statements", async () => {
  const files = [
    "lib/security/audit-service.mjs",
    "lib/mabang-scheduler/api.mjs",
    "lib/security/audit-api.mjs",
    "lib/files/file-api.mjs",
    "lib/files/file-lifecycle-api.mjs",
    "lib/files/file-review-api.mjs",
  ];
  for (const file of files) {
    const source = await fs.readFile(path.resolve(file), "utf8");
    assert.doesNotMatch(source, /node:sqlite|\.prepare\s*\(|BEGIN IMMEDIATE|PRAGMA\s/i, file);
  }
});
