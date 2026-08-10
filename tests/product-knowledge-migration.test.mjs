import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import {
  PRODUCT_KNOWLEDGE_APP_PRIVILEGES,
  PRODUCT_KNOWLEDGE_CONSTRAINT_COUNTS,
  PRODUCT_KNOWLEDGE_EMPTY_REPLACE_CONFIRMATION,
  PRODUCT_KNOWLEDGE_INDEXES,
  PRODUCT_KNOWLEDGE_LEGACY_DROP_SQL,
  PRODUCT_KNOWLEDGE_LEGACY_INDEXES,
  PRODUCT_KNOWLEDGE_LEGACY_TABLES,
  PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION,
  PRODUCT_KNOWLEDGE_MIGRATION_SHA256,
  PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
  PRODUCT_KNOWLEDGE_TABLES,
  assertCleanProductKnowledgePrestate,
  assertLegacyEmptyProductKnowledgePrestate,
  resolveProductKnowledgeMigrationInvocation,
  validateProductKnowledgeSchema,
} from "../scripts/apply-product-knowledge-migration.mjs";

const CONFIG = Object.freeze({
  database: "commerce_ops",
  testDatabase: "commerce_ops_migration_test",
});

function inventoryProvider({
  tables = PRODUCT_KNOWLEDGE_TABLES,
  indexes = PRODUCT_KNOWLEDGE_INDEXES,
  invalidIndexes = [],
  constraints = PRODUCT_KNOWLEDGE_CONSTRAINT_COUNTS,
  sha256 = PRODUCT_KNOWLEDGE_MIGRATION_SHA256,
  omitGrant = null,
} = {}) {
  return {
    async query(sql) {
      if (sql.includes("FROM pg_class c") && sql.includes("c.relkind IN")) {
        return { rows: tables.map((object_name) => ({ object_name, relkind: "r" })) };
      }
      if (sql.includes("JOIN pg_index")) {
        return {
          rows: indexes.map((index_name) => ({
            index_name,
            indisvalid: !invalidIndexes.includes(index_name),
          })),
        };
      }
      if (sql.includes("JOIN pg_class relation") && sql.includes("constraint_row.contype IN")) {
        return { rows: Object.entries(constraints).map(([constraint_type, count]) => ({ constraint_type, count })) };
      }
      if (sql.includes("shadow_meta.schema_migrations")) {
        return { rows: [{ sha256, applied_at: "2026-08-08T00:00:00.000Z" }] };
      }
      if (sql.includes("information_schema.role_table_grants")) {
        return {
          rows: PRODUCT_KNOWLEDGE_TABLES.flatMap((table_name) =>
            PRODUCT_KNOWLEDGE_APP_PRIVILEGES
              .filter((privilege_type) => `${table_name}:${privilege_type}` !== omitGrant)
              .map((privilege_type) => ({ table_name, privilege_type }))),
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("product-knowledge migration defaults to a read-only test-database plan", () => {
  assert.deepEqual(resolveProductKnowledgeMigrationInvocation(CONFIG, []), {
    database: "commerce_ops_migration_test",
    apply: false,
    confirmedDatabase: null,
    confirmedMigration: null,
    replaceEmptyRehearsal: false,
    confirmedEmptyReplace: null,
  });
});

test("product-knowledge migration enforces allowed targets and both apply confirmations", () => {
  assert.throws(
    () => resolveProductKnowledgeMigrationInvocation(CONFIG, ["--database=postgres"]),
    /target is not allowed/,
  );
  assert.throws(
    () => resolveProductKnowledgeMigrationInvocation(CONFIG, [
      "--apply",
      "--database=commerce_ops",
      "--confirm-database=commerce_ops",
      "--confirm-migration=WRONG",
    ]),
    new RegExp(PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION),
  );
  assert.equal(resolveProductKnowledgeMigrationInvocation(CONFIG, [
    "--apply",
    "--database=commerce_ops",
    "--confirm-database=commerce_ops",
    `--confirm-migration=${PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION}`,
  ]).apply, true);
});

test("empty legacy replacement is test-only and requires its independent confirmation", () => {
  assert.throws(
    () => resolveProductKnowledgeMigrationInvocation(CONFIG, [
      "--apply",
      "--database=commerce_ops",
      "--confirm-database=commerce_ops",
      `--confirm-migration=${PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION}`,
      "--replace-empty-rehearsal",
      `--confirm-empty-replace=${PRODUCT_KNOWLEDGE_EMPTY_REPLACE_CONFIRMATION}`,
    ]),
    /configured test database/,
  );
  assert.throws(
    () => resolveProductKnowledgeMigrationInvocation(CONFIG, [
      "--apply",
      "--database=commerce_ops_migration_test",
      "--confirm-database=commerce_ops_migration_test",
      `--confirm-migration=${PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION}`,
      "--replace-empty-rehearsal",
    ]),
    new RegExp(PRODUCT_KNOWLEDGE_EMPTY_REPLACE_CONFIRMATION),
  );
  assert.equal(resolveProductKnowledgeMigrationInvocation(CONFIG, [
    "--apply",
    "--database=commerce_ops_migration_test",
    "--confirm-database=commerce_ops_migration_test",
    `--confirm-migration=${PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION}`,
    "--replace-empty-rehearsal",
    `--confirm-empty-replace=${PRODUCT_KNOWLEDGE_EMPTY_REPLACE_CONFIRMATION}`,
  ]).replaceEmptyRehearsal, true);
});

test("migration 018 is frozen at the exact schema shape and digest", async () => {
  const sql = await fs.readFile(
    new URL(`../postgresql/shadow/migrations/${PRODUCT_KNOWLEDGE_MIGRATION_VERSION}`, import.meta.url),
    "utf8",
  );
  const tables = [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS app\.([a-z0-9_]+)/gm)].map((match) => match[1]);
  const indexes = [...sql.matchAll(/^CREATE INDEX IF NOT EXISTS ([a-z0-9_]+)/gm)].map((match) => match[1]);
  assert.deepEqual(tables, PRODUCT_KNOWLEDGE_TABLES);
  assert.deepEqual(indexes, PRODUCT_KNOWLEDGE_INDEXES);
  assert.equal((sql.match(/\bREFERENCES app\./g) || []).length, 24);
  assert.equal((sql.match(/\bPRIMARY KEY\b/g) || []).length, 13);
  assert.equal((sql.match(/\bUNIQUE\b/g) || []).length, 16);
  assert.equal((sql.match(/\bCHECK\s*\(/g) || []).length, 22);
  assert.equal(crypto.createHash("sha256").update(sql).digest("hex"), PRODUCT_KNOWLEDGE_MIGRATION_SHA256);
  assert.doesNotMatch(sql, /\bCASCADE\b/i);
});

test("the only replaceable legacy rehearsal shape is the known empty 10-table and 6-index schema", async () => {
  const scripts = [];
  const provider = {
    async query(sql) {
      if (sql.includes("FROM pg_class c") && sql.includes("c.relkind IN")) {
        return { rows: PRODUCT_KNOWLEDGE_LEGACY_TABLES.map((object_name) => ({ object_name, relkind: "r" })) };
      }
      if (sql.includes("JOIN pg_index")) {
        return { rows: PRODUCT_KNOWLEDGE_LEGACY_INDEXES.map((index_name) => ({ index_name, indisvalid: true })) };
      }
      if (sql.includes("SELECT COUNT(*)")) return { rows: [{ count: 0 }] };
      if (sql.includes("FROM pg_constraint")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async executeScript(sql) { scripts.push(sql); },
  };
  const result = await assertLegacyEmptyProductKnowledgePrestate(provider);
  assert.equal(result.tables, 10);
  assert.equal(result.externalForeignKeys, 0);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^LOCK TABLE /);
  assert.doesNotMatch(scripts[0], /CASCADE/i);
  assert.match(PRODUCT_KNOWLEDGE_LEGACY_DROP_SQL, /^DROP TABLE /);
  assert.match(PRODUCT_KNOWLEDGE_LEGACY_DROP_SQL, / RESTRICT$/);
  assert.doesNotMatch(PRODUCT_KNOWLEDGE_LEGACY_DROP_SQL, /CASCADE/i);
});

test("legacy replacement refuses non-empty tables and external foreign keys", async () => {
  let countQuery = 0;
  const nonEmptyProvider = {
    async query(sql) {
      if (sql.includes("FROM pg_class c") && sql.includes("c.relkind IN")) {
        return { rows: PRODUCT_KNOWLEDGE_LEGACY_TABLES.map((object_name) => ({ object_name, relkind: "r" })) };
      }
      if (sql.includes("JOIN pg_index")) {
        return { rows: PRODUCT_KNOWLEDGE_LEGACY_INDEXES.map((index_name) => ({ index_name, indisvalid: true })) };
      }
      if (sql.includes("SELECT COUNT(*)")) {
        countQuery += 1;
        return { rows: [{ count: countQuery === 1 ? 1 : 0 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async executeScript() {},
  };
  await assert.rejects(assertLegacyEmptyProductKnowledgePrestate(nonEmptyProvider), /refused non-empty tables/);

  const externalFkProvider = {
    async query(sql) {
      if (sql.includes("FROM pg_class c") && sql.includes("c.relkind IN")) {
        return { rows: PRODUCT_KNOWLEDGE_LEGACY_TABLES.map((object_name) => ({ object_name, relkind: "r" })) };
      }
      if (sql.includes("JOIN pg_index")) {
        return { rows: PRODUCT_KNOWLEDGE_LEGACY_INDEXES.map((index_name) => ({ index_name, indisvalid: true })) };
      }
      if (sql.includes("SELECT COUNT(*)")) return { rows: [{ count: 0 }] };
      if (sql.includes("FROM pg_constraint")) return { rows: [{ conname: "external_fk" }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async executeScript() {},
  };
  await assert.rejects(
    assertLegacyEmptyProductKnowledgePrestate(externalFkProvider),
    /external foreign-key dependencies/,
  );
});

test("production clean-prestate check refuses every partial Product Knowledge object", async () => {
  await assert.rejects(
    assertCleanProductKnowledgePrestate(inventoryProvider({
      tables: [PRODUCT_KNOWLEDGE_TABLES[0]],
      indexes: [],
    })),
    /requires a clean prestate/,
  );
});

test("post-apply validation requires exact schema, constraints, ledger SHA, and app CRUD", async () => {
  const valid = await validateProductKnowledgeSchema(inventoryProvider(), {
    version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
    sha256: PRODUCT_KNOWLEDGE_MIGRATION_SHA256,
    appUser: "commerce_app",
  });
  assert.equal(valid.tables, 13);
  assert.equal(valid.indexes, 9);
  assert.equal(valid.constraints["FOREIGN KEY"], 24);
  assert.equal(valid.constraints["PRIMARY KEY"], 13);
  assert.equal(valid.constraints.UNIQUE, 16);
  assert.equal(valid.constraints.CHECK, 22);
  assert.equal(valid.appCrudGrants, 52);

  await assert.rejects(
    validateProductKnowledgeSchema(inventoryProvider({
      constraints: { ...PRODUCT_KNOWLEDGE_CONSTRAINT_COUNTS, "FOREIGN KEY": 23 },
    }), {
      version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
      sha256: PRODUCT_KNOWLEDGE_MIGRATION_SHA256,
      appUser: "commerce_app",
    }),
    /FOREIGN KEY constraint count mismatch/,
  );
  await assert.rejects(
    validateProductKnowledgeSchema(inventoryProvider({
      omitGrant: `${PRODUCT_KNOWLEDGE_TABLES[0]}:DELETE`,
    }), {
      version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
      sha256: PRODUCT_KNOWLEDGE_MIGRATION_SHA256,
      appUser: "commerce_app",
    }),
    /CRUD grants are incomplete/,
  );
});
