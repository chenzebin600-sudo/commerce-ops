import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { openConfiguredCommerceDataAccess } from "../lib/data/data-access.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";

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
    const active = provider.transaction(async () => { entered(); await hold; });
    await opened;
    assert.throws(() => shared.transactionManager.run(() => {}), { code: "SQLITE_TRANSACTION_BUSY" });
    release();
    await active;
  } finally { shared.close(); await context.close(); }
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
