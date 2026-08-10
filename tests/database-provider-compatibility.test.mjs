import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCompatibilityDataAccess, COMPATIBILITY_REPOSITORY_TABLES } from "../lib/data/compatibility/compatibility-data-access.mjs";
import { DatabaseProvider, DATABASE_DIALECTS } from "../lib/data/database-provider.mjs";
import {
  ProviderRecordRepository,
  resolveCompatibilityProviderName,
} from "../lib/data/compatibility/provider-record-repository.mjs";
import { runRepositoryCompatibilityContract } from "../lib/data/compatibility/repository-compatibility-contract.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { inspectSqliteSchema } from "../lib/postgresql/sqlite-migration.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

class IntegerBooleanPostgresqlStub extends DatabaseProvider {
  constructor() {
    super({ dialect: DATABASE_DIALECTS.POSTGRESQL });
    this.insertValues = null;
    this.row = null;
    this._transactionManager = { run() {} };
  }
  get connection() { return {}; }
  get transactionManager() { return this._transactionManager; }
  async execute(_text, values) {
    this.insertValues = values;
    this.row = { id: values[0], enabled: values[1] };
    return { rows: [], rowCount: 1 };
  }
  async query() { return { rows: this.row ? [this.row] : [] }; }
  placeholder(index) { return `$${index}`; }
  transaction(callback) { return callback(this); }
  close() {}
}

async function temporaryContext() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f4-repository-test-"));
  const databasePath = path.join(root, "test.sqlite");
  const provider = new SqliteProvider({ databasePath });
  const scheduler = new SchedulerDatabase({
    databasePath,
    migrationsDir: path.join(rootDir, "migrations"),
    provider,
  });
  scheduler.migrate();
  const schema = inspectSqliteSchema(provider.connection);
  return {
    provider,
    schema,
    async close() {
      provider.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("F4 provider selection accepts explicit SQLite and PostgreSQL test configurations", () => {
  assert.equal(resolveCompatibilityProviderName({ DATABASE_PROVIDER: "sqlite" }), "sqlite");
  assert.equal(resolveCompatibilityProviderName({ DATABASE_PROVIDER: "postgres" }), "postgres");
  assert.equal(resolveCompatibilityProviderName({ DATABASE_PROVIDER: "postgresql" }), "postgres");
  assert.equal(resolveCompatibilityProviderName({}), "sqlite");
  assert.throws(() => resolveCompatibilityProviderName({ DATABASE_PROVIDER: "mysql" }), /sqlite or postgres/);
});

test("the shared Repository contract covers CRUD, transactions, errors and normalized values", async () => {
  const context = await temporaryContext();
  try {
    const dataAccess = openCompatibilityDataAccess({ provider: context.provider, schema: context.schema });
    const result = await runRepositoryCompatibilityContract(dataAccess);
    assert.deepEqual(result.operations, {
      query: true,
      insert: true,
      update: true,
      delete: true,
      transactionCommit: true,
      transactionRollback: true,
      uniqueError: "UNIQUE_CONSTRAINT",
      foreignKeyError: "FOREIGN_KEY_CONSTRAINT",
    });
    assert.equal(result.values.account.enabled, false);
    assert.equal(result.values.account.last_verify_message, null);
    assert.deepEqual(result.values.task.schedule_config_json, { hour: 8, minute: 30 });
    assert.equal(result.values.task.next_run_at, null);
    assert.equal(result.values.run.payment_start_date, "2026-07-19");
    assert.equal(result.values.exportFile.file_size, "128");
    assert.equal(result.types.task.schedule_config_json, "object");
    assert.equal(result.types.task.enabled, "boolean");
    assert.equal(result.types.file.file_size, "string");
  } finally {
    await context.close();
  }
});

test("compatibility data access exposes repositories for current F4 business tables", async () => {
  const context = await temporaryContext();
  try {
    const dataAccess = openCompatibilityDataAccess({ provider: context.provider, schema: context.schema });
    assert.deepEqual(Object.keys(dataAccess.repositories), Object.keys(COMPATIBILITY_REPOSITORY_TABLES));
    for (const repository of Object.values(dataAccess.repositories)) {
      assert.equal(repository instanceof ProviderRecordRepository, true);
      assert.equal(repository.provider, context.provider);
    }
  } finally {
    await context.close();
  }
});

test("F4 preserves boolean semantics for integer-backed PostgreSQL compatibility columns", async () => {
  const provider = new IntegerBooleanPostgresqlStub();
  const repository = new ProviderRecordRepository({
    provider,
    table: {
      name: "compatibility_flags",
      primaryKey: ["id"],
      columns: [
        { name: "id", logicalType: "text", pk: true },
        { name: "enabled", logicalType: "boolean", postgresqlStorageType: "integer", pk: false },
      ],
    },
  });
  const row = await repository.insert({ id: "flag-1", enabled: true });
  assert.deepEqual(provider.insertValues, ["flag-1", 1]);
  assert.deepEqual(row, { id: "flag-1", enabled: true });
});

test("F4 compatibility layer remains driver-neutral and the runner cannot select production PostgreSQL", async () => {
  const compatibilitySource = await fs.readFile(path.join(rootDir, "lib", "data", "compatibility", "compatibility-data-access.mjs"), "utf8");
  const repositorySource = await fs.readFile(path.join(rootDir, "lib", "data", "compatibility", "provider-record-repository.mjs"), "utf8");
  const runnerSource = await fs.readFile(path.join(rootDir, "scripts", "postgresql-f4-compatibility-check.mjs"), "utf8");
  assert.doesNotMatch(compatibilitySource, /from\s+["'](?:pg|node:sqlite)["']/);
  assert.doesNotMatch(repositorySource, /from\s+["'](?:pg|node:sqlite)["']/);
  assert.match(runnerSource, /database:\s*["']test["']/);
  assert.doesNotMatch(runnerSource, /database:\s*["']production["']/);
  assert.match(runnerSource, /active production provider to remain sqlite/);
});
