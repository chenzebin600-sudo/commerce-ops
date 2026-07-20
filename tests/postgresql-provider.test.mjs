import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DATABASE_DIALECTS } from "../lib/data/database-provider.mjs";
import { DATABASE_VALUE_TYPES, encodeDatabaseValue, normalizeDatabaseValue } from "../lib/data/database-compatibility.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { runProviderContract } from "../lib/data/provider-contract.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";

const fakeConfig = Object.freeze({
  host: "127.0.0.1",
  port: 5432,
  schema: "app",
  ssl: false,
  poolMax: 3,
  poolIdleTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
});

class FakeClient {
  constructor() {
    this.calls = [];
    this.releases = 0;
  }

  async query(query) {
    this.calls.push(query);
    if (typeof query === "object" && query.text === "SELECT $1::text AS value") {
      return { rows: [{ value: query.values[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.releases += 1;
  }
}

class FakePool {
  constructor(config) {
    this.config = config;
    this.client = new FakeClient();
    this.handlers = new Map();
    this.ended = false;
  }

  on(event, callback) {
    this.handlers.set(event, callback);
  }

  async connect() {
    return this.client;
  }

  async end() {
    this.ended = true;
  }
}

function fakePostgresqlProvider() {
  return new PostgresqlProvider({
    config: fakeConfig,
    database: "commerce_ops_migration_test",
    user: "commerce_migrator",
    password: "temporary-test-password",
    PoolClass: FakePool,
  });
}

test("database compatibility normalizes SQLite and PostgreSQL values", () => {
  assert.equal(encodeDatabaseValue(true, DATABASE_VALUE_TYPES.BOOLEAN, DATABASE_DIALECTS.SQLITE), 1);
  assert.equal(encodeDatabaseValue(true, DATABASE_VALUE_TYPES.BOOLEAN, DATABASE_DIALECTS.POSTGRESQL), true);
  assert.equal(encodeDatabaseValue({ ok: true }, DATABASE_VALUE_TYPES.JSON, DATABASE_DIALECTS.SQLITE), '{"ok":true}');
  assert.deepEqual(normalizeDatabaseValue('{"ok":true}', DATABASE_VALUE_TYPES.JSON), { ok: true });
  assert.equal(normalizeDatabaseValue(new Date("2026-07-20T08:09:10Z"), DATABASE_VALUE_TYPES.TIMESTAMP), "2026-07-20T08:09:10.000Z");
  assert.equal(normalizeDatabaseValue(9007199254740991n, DATABASE_VALUE_TYPES.BIGINT), "9007199254740991");
  assert.throws(() => normalizeDatabaseValue("yes", DATABASE_VALUE_TYPES.BOOLEAN), /boolean is invalid/);
  assert.throws(() => normalizeDatabaseValue("not-a-uuid", DATABASE_VALUE_TYPES.UUID), /UUID is invalid/);
});

test("SQLite provider passes the shared provider contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-provider-contract-"));
  const provider = new SqliteProvider({ databasePath: path.join(root, "contract.sqlite") });
  try {
    const result = await runProviderContract(provider);
    assert.equal(result.dialect, DATABASE_DIALECTS.SQLITE);
    assert.equal(result.rollback, true);
    assert.equal(result.foreignKeys, true);
    assert.equal(result.indexes, true);
    assert.equal(result.parameterizedQueries, true);
    const removed = provider.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='f2_provider_contract'").get();
    assert.equal(removed, undefined);
  } finally {
    provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL provider uses a bounded pool and parameterized queries", async () => {
  const provider = fakePostgresqlProvider();
  try {
    assert.equal(provider.connection.config.host, "127.0.0.1");
    assert.equal(provider.connection.config.max, 3);
    const result = await provider.query("SELECT $1::text AS value", ["separate-value"]);
    assert.equal(result.rows[0].value, "separate-value");
    const query = provider.connection.client.calls.at(-1);
    assert.equal(query.text, "SELECT $1::text AS value");
    assert.deepEqual(query.values, ["separate-value"]);
    assert.equal(provider.placeholder(2), "$2");
  } finally {
    await provider.close();
  }
  assert.equal(provider.connection.ended, true);
});

test("PostgreSQL provider commits and releases one transaction client", async () => {
  const provider = fakePostgresqlProvider();
  try {
    await provider.transaction(async (transaction) => {
      await transaction.execute("UPDATE example SET value=$1", ["committed"]);
    });
    const calls = provider.connection.client.calls.map((call) => typeof call === "string" ? call : call.text);
    assert.deepEqual(calls.slice(-3), ["BEGIN", "UPDATE example SET value=$1", "COMMIT"]);
    assert.equal(provider.connection.client.releases, 1);
  } finally {
    await provider.close();
  }
});

test("PostgreSQL provider rolls back and releases failed transactions", async () => {
  const provider = fakePostgresqlProvider();
  try {
    await assert.rejects(provider.transaction(async (transaction) => {
      await transaction.execute("UPDATE example SET value=$1", ["rolled-back"]);
      throw new Error("expected rollback");
    }), /expected rollback/);
    const calls = provider.connection.client.calls.map((call) => typeof call === "string" ? call : call.text);
    assert.deepEqual(calls.slice(-3), ["BEGIN", "UPDATE example SET value=$1", "ROLLBACK"]);
    assert.equal(provider.connection.client.releases, 1);
  } finally {
    await provider.close();
  }
});

test("provider migration scripts run inside transactions", async () => {
  const provider = fakePostgresqlProvider();
  try {
    const applied = await provider.migrate([{ id: "001-test", up: "CREATE TABLE provider_test (id integer)" }]);
    assert.deepEqual(applied, ["001-test"]);
    const calls = provider.connection.client.calls.map((call) => typeof call === "string" ? call : call.text);
    assert.deepEqual(calls.slice(-3), ["BEGIN", "CREATE TABLE provider_test (id integer)", "COMMIT"]);
  } finally {
    await provider.close();
  }
});
