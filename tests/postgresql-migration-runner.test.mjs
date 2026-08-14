import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  loadPostgresqlMigrations,
  runPostgresqlMigrations,
} from "../lib/data/postgresql/migration-runner.mjs";
import { migrateSharedPostgresql } from "../scripts/postgresql-migrate.mjs";
import { buildSharedPostgresqlBaseline } from "../scripts/postgresql-build-baseline.mjs";

class FakeMigrationProvider {
  constructor({ identity, applied = [] } = {}) {
    this.identity = identity || { database: "commerce_ops", username: "commerce_migrator", schema: "app" };
    this.applied = applied;
    this.calls = [];
  }

  async transaction(callback) {
    this.calls.push({ kind: "transaction" });
    return callback(this);
  }

  async query(text, values = []) {
    this.calls.push({ kind: "query", text, values });
    if (text.includes("pg_advisory_xact_lock")) return { rows: [{ locked: null }], rowCount: 1 };
    if (text.includes("current_database")) return { rows: [this.identity], rowCount: 1 };
    if (text.includes("SELECT version, checksum")) return { rows: this.applied, rowCount: this.applied.length };
    return { rows: [], rowCount: 0 };
  }

  async execute(text, values = []) {
    this.calls.push({ kind: "execute", text, values });
    return { rows: [], rowCount: 1 };
  }

  async executeScript(text) {
    this.calls.push({ kind: "script", text });
    return { rows: [], rowCount: 0 };
  }
}

function assertOrderedTableDependencies({ migrations, initiallyAvailable = [] }) {
  const available = new Set(initiallyAvailable);
  const unresolved = [];
  for (const migration of migrations) {
    const statements = migration.sql.split(/;\s*(?:\r?\n|$)/);
    for (const statement of statements) {
      const created = statement.match(/CREATE TABLE\s+"app"\."([a-z0-9_]+)"/i)?.[1];
      const references = [...statement.matchAll(/REFERENCES\s+"app"\."([a-z0-9_]+)"/gi)].map((match) => match[1]);
      for (const relation of references) {
        if (!available.has(relation) && relation !== created) {
          unresolved.push({ migration: migration.version, created, relation });
        }
      }
      if (created) available.add(created);
    }
  }
  assert.deepEqual(unresolved, []);
  return available;
}

test("migration loader returns ordered SQL with literal SHA-256 checksums", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgresql-migrations-"));
  try {
    await fs.writeFile(path.join(root, "002_second.sql"), "SELECT 2;\n", "utf8");
    await fs.writeFile(path.join(root, "001_first.sql"), "SELECT 1;\n", "utf8");
    const migrations = await loadPostgresqlMigrations(root);
    assert.deepEqual(migrations.map(({ version }) => version), ["001_first", "002_second"]);
    assert.equal(migrations[0].checksum, crypto.createHash("sha256").update("SELECT 1;\n").digest("hex"));
    assert.equal(migrations[0].sql, "SELECT 1;\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("shared migration set contains the additive bridge for every missing C module table", async () => {
  const migrations = await loadPostgresqlMigrations(path.resolve("migrations", "postgresql"));
  assert.deepEqual(migrations.map(({ version }) => version), [
    "001_shared_baseline",
    "027_shopee_discount",
    "033_shared_development_modules",
    "034_shared_module_text_identifiers",
    "035_shopee_discount_foundation_links",
    "036_shopee_discount_execution",
    "037_shopee_discount_intent_attempts",
    "038_shopee_discount_notification_delivery",
    "039_shopee_discount_notification_coordination",
    "040_shopee_discount_notification_legacy_sending",
    "041_shopee_discount_baseline_lookup",
  ]);
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration.sql]));
  const additive = byVersion.get("033_shared_development_modules");
  for (const table of [
    "advertising_performance_facts",
    "advertising_source_batches",
    "advertising_target_policies",
    "foundation_operation_plan_events",
    "foundation_operation_plans",
    "shopee_health_appeal_events",
    "shopee_health_appeals",
    "shopee_health_issues",
    "shopee_health_notifications",
    "shopee_health_runs",
    "shopee_health_settings",
    "shopee_health_snapshots",
    "shopee_health_thresholds",
  ]) {
    assert.match(additive, new RegExp(`CREATE TABLE "app"\\."${table}"`));
  }
  assert.equal((additive.match(/CREATE TABLE /g) || []).length, 13);
  assert.match(additive, /"task_id" text REFERENCES "app"\."foundation_tasks" \("id"\)/);
  assert.match(additive, /"dingtalk_config_id" text REFERENCES "app"\."dingtalk_robot_configs" \("id"\)/);
  assert.doesNotMatch(additive, /DROP\s|TRUNCATE\s|DELETE\s+FROM|UPDATE\s+"app"/i);
  const identifierFix = byVersion.get("034_shared_module_text_identifiers");
  for (const [table, column] of [
    ["advertising_performance_facts", "product_id"],
    ["advertising_target_policies", "product_id"],
    ["foundation_operation_plan_events", "actor_id"],
    ["shopee_health_issues", "reference_id"],
    ["shopee_health_appeals", "assignee_user_id"],
    ["shopee_health_appeal_events", "actor_user_id"],
  ]) {
    assert.match(identifierFix, new RegExp(`ALTER TABLE "app"\\."${table}" ALTER COLUMN "${column}" TYPE text`));
  }
  assert.doesNotMatch(identifierFix, /DROP\s|TRUNCATE\s|DELETE\s+FROM|UPDATE\s+"app"/i);
  const discountLinks = byVersion.get("035_shopee_discount_foundation_links");
  assert.match(discountLinks, /shopee_discount_plans_foundation_plan_fk/);
  assert.match(discountLinks, /REFERENCES "app"\."foundation_operation_plans" \("id"\)/);
  assert.match(discountLinks, /NOT VALID/);
  assert.match(byVersion.get("036_shopee_discount_execution"), /shopee_discount_execution_items/);
  assert.match(byVersion.get("037_shopee_discount_intent_attempts"), /uq_shopee_discount_intents_active_target/);
  assert.match(byVersion.get("038_shopee_discount_notification_delivery"), /uq_shopee_discount_notifications_dedupe/);
  assert.match(byVersion.get("039_shopee_discount_notification_coordination"), /delivery_lease_until/);
  assert.match(byVersion.get("040_shopee_discount_notification_legacy_sending"), /DINGTALK_DELIVERY_UPGRADE_UNKNOWN/);
  assert.match(byVersion.get("041_shopee_discount_baseline_lookup"), /idx_shopee_discount_events_baseline_scope/);
});

test("migration runner locks, verifies identity, and records each migration", async () => {
  const provider = new FakeMigrationProvider();
  const migrations = [
    { version: "001_first", checksum: "a".repeat(64), sql: "CREATE TABLE app.first(id integer);" },
    { version: "002_second", checksum: "b".repeat(64), sql: "CREATE TABLE app.second(id integer);" },
  ];
  const result = await runPostgresqlMigrations({
    provider,
    migrations,
    expectedDatabase: "commerce_ops",
    expectedUser: "commerce_migrator",
    expectedSchema: "app",
  });
  assert.deepEqual(result, { applied: ["001_first", "002_second"], existing: [] });
  const operations = provider.calls.filter(({ kind }) => kind !== "transaction");
  assert.match(operations[0].text, /pg_advisory_xact_lock/);
  assert.match(operations[1].text, /current_database/);
  assert.deepEqual(operations.filter(({ kind }) => kind === "script").map(({ text }) => text), [
    expectLedgerCreation(),
    "CREATE TABLE app.first(id integer);",
    "CREATE TABLE app.second(id integer);",
  ]);
  assert.deepEqual(operations.filter(({ kind }) => kind === "execute").map(({ values }) => values), [
    ["001_first", "a".repeat(64)],
    ["002_second", "b".repeat(64)],
  ]);
});

test("legacy adoption plan has no unresolved forward relation dependencies", async () => {
  const migrations = await loadPostgresqlMigrations(path.resolve("migrations", "postgresql"));
  const adoptionPlan = migrations.filter(({ version }) => version !== "001_shared_baseline");
  const available = assertOrderedTableDependencies({
    migrations: adoptionPlan,
    initiallyAvailable: ["foundation_integration_accounts", "foundation_account_capabilities", "foundation_tasks", "dingtalk_robot_configs"],
  });
  assert.equal(available.has("shopee_discount_plans"), true);
  assert.equal(available.has("foundation_operation_plans"), true);
  assert.match(adoptionPlan.find(({ version }) => version === "035_shopee_discount_foundation_links").sql,
    /shopee_discount_plans_foundation_plan_fk/);
});

test("migration runner rejects checksum drift before executing SQL", async () => {
  const provider = new FakeMigrationProvider({ applied: [{ version: "001_first", checksum: "0".repeat(64) }] });
  await assert.rejects(() => runPostgresqlMigrations({
    provider,
    migrations: [{ version: "001_first", checksum: "1".repeat(64), sql: "SELECT 1;" }],
    expectedDatabase: "commerce_ops",
    expectedUser: "commerce_migrator",
    expectedSchema: "app",
  }), { code: "PG_MIGRATION_DRIFT" });
  assert.equal(provider.calls.some(({ kind, text }) => kind === "script" && text === "SELECT 1;"), false);
});

test("existing shared database adopts the bootstrap baseline before additive migrations", async () => {
  const provider = new FakeMigrationProvider({
    applied: [{ version: "032_legacy_feature.sql", checksum: "0".repeat(64) }],
  });
  const migrations = [
    { version: "001_shared_baseline", checksum: "a".repeat(64), sql: "CREATE TABLE app.must_not_run(id integer);" },
    { version: "033_shared_development_modules", checksum: "b".repeat(64), sql: "CREATE TABLE app.additive(id integer);" },
  ];

  const result = await runPostgresqlMigrations({
    provider,
    migrations,
    expectedDatabase: "commerce_ops",
    expectedUser: "commerce_migrator",
    expectedSchema: "app",
    adoptExistingDatabase: true,
  });

  assert.deepEqual(result, {
    applied: ["033_shared_development_modules"],
    adopted: ["001_shared_baseline"],
    existing: ["032_legacy_feature.sql"],
  });
  assert.equal(provider.calls.some(({ kind, text }) => kind === "script" && text.includes("must_not_run")), false);
  assert.equal(provider.calls.some(({ kind, text }) => kind === "script" && text.includes("additive")), true);
  const adoptionUpgrade = provider.calls.find(({ kind, text }) => kind === "script" && text.includes("ADD COLUMN IF NOT EXISTS checksum"));
  assert.ok(adoptionUpgrade);
  assert.match(adoptionUpgrade.text, /UPDATE "app"\."schema_migrations" SET checksum = repeat\('0', 64\)/);
  assert.deepEqual(provider.calls.filter(({ kind }) => kind === "execute").map(({ values }) => values), [
    ["001_shared_baseline", "a".repeat(64)],
    ["033_shared_development_modules", "b".repeat(64)],
  ]);
  for (const call of provider.calls.filter(({ kind }) => kind === "execute")) {
    assert.match(call.text, /version, checksum, applied_at/);
    assert.match(call.text, /clock_timestamp\(\)/);
  }
});

test("bootstrap adoption refuses an empty migration ledger", async () => {
  const provider = new FakeMigrationProvider();
  await assert.rejects(() => runPostgresqlMigrations({
    provider,
    migrations: [{ version: "001_shared_baseline", checksum: "a".repeat(64), sql: "SELECT 1;" }],
    expectedDatabase: "commerce_ops",
    expectedUser: "commerce_migrator",
    expectedSchema: "app",
    adoptExistingDatabase: true,
  }), { code: "PG_MIGRATION_ADOPTION_EMPTY" });
});

test("an adopted baseline permits later normal migrations alongside legacy history", async () => {
  const provider = new FakeMigrationProvider({ applied: [
    { version: "001_legacy.sql", checksum: "0".repeat(64) },
    { version: "001_shared_baseline", checksum: "a".repeat(64) },
  ] });
  const result = await runPostgresqlMigrations({
    provider,
    migrations: [
      { version: "001_shared_baseline", checksum: "a".repeat(64), sql: "SELECT 1;" },
      { version: "035_next", checksum: "b".repeat(64), sql: "SELECT 35;" },
    ],
    expectedDatabase: "commerce_ops",
    expectedUser: "commerce_migrator",
    expectedSchema: "app",
  });
  assert.deepEqual(result, {
    applied: ["035_next"],
    existing: ["001_legacy.sql", "001_shared_baseline"],
  });
});

test("migration runner rejects the wrong target without exposing its identity", async () => {
  const provider = new FakeMigrationProvider({ identity: { database: "production_secret", username: "commerce_migrator", schema: "app" } });
  await assert.rejects(() => runPostgresqlMigrations({
    provider,
    migrations: [],
    expectedDatabase: "commerce_ops",
    expectedUser: "commerce_migrator",
    expectedSchema: "app",
  }), (error) => {
    assert.equal(error.code, "PG_MIGRATION_TARGET_MISMATCH");
    assert.equal(error.message.includes("production_secret"), false);
    return true;
  });
});

function expectLedgerCreation() {
  return `CREATE TABLE IF NOT EXISTS "app"."schema_migrations" (
  version text PRIMARY KEY,
  checksum text NOT NULL CHECK (length(checksum) = 64),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
)`;
}

test("migration command defaults to a redacted plan without credentials or connections", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "postgresql-migration-plan-"));
  try {
    const migrationDir = path.join(rootDir, "migrations", "postgresql");
    const certificatePath = path.join(rootDir, "public-ca.crt");
    await fs.mkdir(migrationDir, { recursive: true });
    await fs.writeFile(path.join(migrationDir, "001_baseline.sql"), "SELECT 1;\n", "utf8");
    await fs.writeFile(certificatePath, "-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----\n", "utf8");
    const result = await migrateSharedPostgresql({
      rootDir,
      env: {
        POSTGRES_HOST: "10.110.80.117",
        POSTGRES_PORT: "5432",
        POSTGRES_DATABASE: "commerce_ops",
        POSTGRES_SCHEMA: "app",
        POSTGRES_APP_USER: "commerce_app",
        POSTGRES_SSLMODE: "verify-full",
        POSTGRES_SSLROOTCERT: certificatePath,
        POSTGRES_CHANNEL_BINDING: "require",
      },
    });
    assert.deepEqual(result, {
      status: "PLAN",
      database: "commerce_ops",
      schema: "app",
      migrationCount: 1,
      versions: ["001_baseline"],
      apply: false,
    });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("baseline builder uses a consistent snapshot and excludes the legacy ledger", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "postgresql-baseline-builder-"));
  const sourcePath = path.join(rootDir, "source.sqlite");
  const outputPath = path.join(rootDir, "migrations", "postgresql", "001_shared_baseline.sql");
  const database = new DatabaseSync(sourcePath);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE shared_records(id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO schema_migrations(version,applied_at) VALUES ('001','2026-08-12T00:00:00Z');
    INSERT INTO shared_records(id,name) VALUES ('record-1','must-not-appear-in-ddl');
  `);
  database.close();
  try {
    const result = await buildSharedPostgresqlBaseline({ sourcePath, outputPath });
    const sql = await fs.readFile(outputPath, "utf8");
    assert.equal(result.tableCount, 1);
    assert.equal(result.columnCount, 2);
    assert.match(sql, /CREATE TABLE "app"\."shared_records"/);
    assert.match(sql, /Tables: 1; columns: 2; source rows inspected: 1\./);
    assert.doesNotMatch(sql, /CREATE TABLE "app"\."schema_migrations"/);
    assert.doesNotMatch(sql, /must-not-appear-in-ddl/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
