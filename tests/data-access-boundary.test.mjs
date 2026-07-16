import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";

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
