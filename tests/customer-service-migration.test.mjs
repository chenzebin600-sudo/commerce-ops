import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  CUSTOMER_SERVICE_INDEXES,
  EMPTY_REHEARSAL_REPLACE_CONFIRMATION,
  CUSTOMER_SERVICE_MIGRATION_CONFIRMATION,
  CUSTOMER_SERVICE_MIGRATION_VERSION,
  CUSTOMER_SERVICE_TABLES,
  resolveCustomerServiceMigrationInvocation,
  validateCustomerServiceSchema,
} from "../scripts/apply-customer-service-migration.mjs";

const CONFIG = Object.freeze({
  database: "commerce_ops",
  testDatabase: "commerce_ops_migration_test",
});

test("customer-service migration defaults to a read-only rehearsal plan", () => {
  const invocation = resolveCustomerServiceMigrationInvocation(CONFIG, []);
  assert.deepEqual(invocation, {
    database: "commerce_ops_migration_test",
    apply: false,
    confirmedDatabase: null,
    confirmedMigration: null,
    replaceEmptyRehearsal: false,
    confirmedEmptyReplace: null,
  });
});

test("customer-service migration only accepts the configured rehearsal or production database", () => {
  assert.throws(
    () => resolveCustomerServiceMigrationInvocation(CONFIG, ["--database=postgres"]),
    /target is not allowed/,
  );
  assert.throws(
    () => resolveCustomerServiceMigrationInvocation(CONFIG, [
      "--apply",
      "--database=commerce_ops",
      "--confirm-database=commerce_ops",
      "--confirm-migration=WRONG",
    ]),
    new RegExp(CUSTOMER_SERVICE_MIGRATION_CONFIRMATION),
  );
  assert.equal(resolveCustomerServiceMigrationInvocation(CONFIG, [
    "--apply",
    "--database=commerce_ops_migration_test",
    "--confirm-database=commerce_ops_migration_test",
    `--confirm-migration=${CUSTOMER_SERVICE_MIGRATION_CONFIRMATION}`,
  ]).apply, true);
  assert.throws(
    () => resolveCustomerServiceMigrationInvocation(CONFIG, [
      "--apply",
      "--database=commerce_ops",
      "--confirm-database=commerce_ops",
      `--confirm-migration=${CUSTOMER_SERVICE_MIGRATION_CONFIRMATION}`,
      "--replace-empty-rehearsal",
      `--confirm-empty-replace=${EMPTY_REHEARSAL_REPLACE_CONFIRMATION}`,
    ]),
    /configured test database/,
  );
  assert.equal(resolveCustomerServiceMigrationInvocation(CONFIG, [
    "--apply",
    "--database=commerce_ops_migration_test",
    "--confirm-database=commerce_ops_migration_test",
    `--confirm-migration=${CUSTOMER_SERVICE_MIGRATION_CONFIRMATION}`,
    "--replace-empty-rehearsal",
    `--confirm-empty-replace=${EMPTY_REHEARSAL_REPLACE_CONFIRMATION}`,
  ]).replaceEmptyRehearsal, true);
});

test("migration 016 contains the complete frozen Customer Service schema", async () => {
  const sql = await fs.readFile(
    new URL(`../postgresql/shadow/migrations/${CUSTOMER_SERVICE_MIGRATION_VERSION}`, import.meta.url),
    "utf8",
  );
  const tables = [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS app\.([a-z0-9_]+)/gm)].map((match) => match[1]);
  const indexes = [...sql.matchAll(/^CREATE INDEX IF NOT EXISTS ([a-z0-9_]+)/gm)].map((match) => match[1]);
  assert.deepEqual(tables, CUSTOMER_SERVICE_TABLES);
  assert.deepEqual(indexes, CUSTOMER_SERVICE_INDEXES);
  assert.equal((sql.match(/\bREFERENCES app\./g) || []).length, 31);
  assert.equal((sql.match(/\bUNIQUE \(/g) || []).length, 6);
});

test("post-apply validation rejects an incomplete schema", async () => {
  const provider = {
    calls: 0,
    async query() {
      this.calls += 1;
      if (this.calls === 1) return { rows: CUSTOMER_SERVICE_TABLES.slice(1).map((table_name) => ({ table_name })) };
      if (this.calls === 2) return { rows: CUSTOMER_SERVICE_INDEXES.map((index_name) => ({ index_name, indisvalid: true })) };
      if (this.calls === 3) return { rows: [
        { constraint_type: "FOREIGN KEY", count: 31 },
        { constraint_type: "CHECK", count: 15 },
        { constraint_type: "UNIQUE", count: 6 },
      ] };
      return { rows: [{ sha256: "abc", applied_at: "2026-08-08T00:00:00Z" }] };
    },
  };
  await assert.rejects(
    validateCustomerServiceSchema(provider, { version: CUSTOMER_SERVICE_MIGRATION_VERSION, sha256: "abc" }),
    /missing tables/,
  );
});
