import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildPostgresqlUpsert,
  buildTargetOnlyReconciliationSql,
  reconcileTargetOnlyRows,
} from "../lib/postgresql/incremental-sync/migration-sync-service.mjs";
import { buildIncrementalSyncManifest } from "../lib/postgresql/incremental-sync/sync-manifest.mjs";
import { runShadowIncrementalSync } from "../lib/postgresql/incremental-sync/shadow-sync-runtime.mjs";
import { resolveDeleteReconciliationPolicy } from "../lib/postgresql/incremental-sync/delete-policy.mjs";
import { SyncControlRepository } from "../lib/postgresql/incremental-sync/sync-control-repository.mjs";

function column(name, logicalType = "text") {
  return { name, logicalType, pk: name === "id" ? 1 : 0 };
}

test("incremental sync manifest closes dependencies and orders parents first", () => {
  const source = {
    tables: [
      {
        name: "parent",
        primaryKey: ["id"],
        columns: [column("id"), column("updated_at", "timestamp")],
        foreignKeys: [],
      },
      {
        name: "child",
        primaryKey: ["id"],
        columns: [column("id"), column("parent_id"), column("created_at", "timestamp")],
        foreignKeys: [{ table: "parent" }],
      },
      {
        name: "scan_only",
        primaryKey: ["id"],
        columns: [column("id"), column("value")],
        foreignKeys: [],
      },
    ],
  };
  const manifest = buildIncrementalSyncManifest(source, {
    domainRoots: { product: ["child", "scan_only"] },
  });
  const byName = new Map(manifest.map((item, index) => [item.name, { ...item, index }]));
  assert.equal(byName.get("parent").domain, "dependency");
  assert.equal(byName.get("parent").watermarkColumn, "updated_at");
  assert.equal(byName.get("child").watermarkColumn, "created_at");
  assert.equal(byName.get("scan_only").captureMode, "FULL_HASH_SCAN");
  assert.ok(byName.get("parent").index < byName.get("child").index);
});

test("incremental sync refuses tables without a primary key", () => {
  const source = {
    tables: [{ name: "unsafe", primaryKey: [], columns: [column("value")], foreignKeys: [] }],
  };
  assert.throws(() => buildIncrementalSyncManifest(source, {
    domainRoots: { audit: ["unsafe"] },
  }), /requires a primary key/);
});

test("PostgreSQL UPSERT keeps the primary key stable and updates mutable fields", () => {
  const table = {
    name: "sample",
    primaryKey: ["id"],
    columns: [column("id"), column("value"), column("updated_at", "timestamp")],
  };
  const statement = buildPostgresqlUpsert(table, [["a", "first", "2026-08-06T00:00:00.000Z"]]);
  assert.match(statement.text, /INSERT INTO "app"\."sample"/);
  assert.match(statement.text, /ON CONFLICT \("id"\) DO UPDATE SET/);
  assert.doesNotMatch(statement.text, /"id"=EXCLUDED\."id"/);
  assert.match(statement.text, /"value"=EXCLUDED\."value"/);
  assert.deepEqual(statement.values, ["a", "first", "2026-08-06T00:00:00.000Z"]);
});

test("hard-delete reconciliation is blocked by default and explicitly gated", () => {
  assert.deepEqual(resolveDeleteReconciliationPolicy(), {
    mode: "BLOCK",
    targetDatabase: "commerce_ops_shadow",
    fullReconcile: false,
    executionRequested: false,
    executesDetection: false,
    executesDeletes: false,
    destructive: false,
    dependencyOrder: "children-before-parents",
    sourceOfTruth: "sqlite-snapshot",
  });
  assert.throws(() => resolveDeleteReconciliationPolicy({
    mode: "DETECT",
    apply: true,
  }), /requires --full-reconcile/);
  assert.throws(() => resolveDeleteReconciliationPolicy({
    mode: "APPLY",
    apply: true,
    fullReconcile: true,
  }), /POSTGRES_SHADOW_DELETE_ENABLED/);
  assert.throws(() => resolveDeleteReconciliationPolicy({
    mode: "APPLY",
    apply: true,
    fullReconcile: true,
    deleteEnabled: true,
  }), /confirm-delete-database=commerce_ops_shadow/);
  const approved = resolveDeleteReconciliationPolicy({
    mode: "APPLY",
    apply: true,
    fullReconcile: true,
    deleteEnabled: "true",
    confirmation: "commerce_ops_shadow",
  });
  assert.equal(approved.executesDetection, true);
  assert.equal(approved.executesDeletes, true);
  assert.equal(approved.destructive, true);
});

test("target-only reconciliation uses exact composite keys and separates detect from delete", () => {
  const table = {
    name: "sample_links",
    primaryKey: ["parent_id", "child_id"],
  };
  const detect = buildTargetOnlyReconciliationSql(table);
  assert.match(detect, /^SELECT COUNT\(\*\)::text total/);
  assert.match(detect, /SELECT "parent_id","child_id" FROM "app"\."sample_links" EXCEPT/);
  assert.match(detect, /SELECT "parent_id","child_id" FROM "migration_source_keys"/);
  assert.doesNotMatch(detect, /DELETE FROM/);
  const remove = buildTargetOnlyReconciliationSql(table, { applyDeletes: true });
  assert.match(remove, /DELETE FROM "app"\."sample_links" AS target/);
  assert.match(remove, /target\."parent_id" IS NOT DISTINCT FROM source\."parent_id"/);
  assert.match(remove, /target\."child_id" IS NOT DISTINCT FROM source\."child_id"/);
  assert.match(remove, /RETURNING 1/);
});

test("delete reconciliation scans the immutable keyset in child-first order", () => {
  const source = fs.readFileSync(path.resolve("lib/postgresql/incremental-sync/migration-sync-service.mjs"), "utf8");
  assert.match(source, /for \(const spec of \[\.\.\.manifest\]\.reverse\(\)\)/);
  assert.match(source, /CREATE TEMP TABLE/);
  assert.match(source, /CREATE UNIQUE INDEX/);
  assert.match(source, /ON COMMIT DROP/);
  assert.match(source, /LOCK TABLE .* SHARE ROW EXCLUSIVE MODE/);
  assert.match(source, /sourcePrimaryKeyBatches/);
  assert.match(source, /readCandidateBatches/);
  assert.match(source, /statement\.iterate/);
  assert.doesNotMatch(source, /function readCandidates[\s\S]*?\.all\(/);
});

test("target-only reconciliation executes detect and apply in child-first transactions", async () => {
  const manifest = ["parent_rows", "child_rows"].map((name, order) => ({
    name,
    domain: "test",
    order,
    primaryKey: ["id"],
    table: { name, primaryKey: ["id"], columns: [column("id")] },
  }));
  const sourceRows = {
    parent_rows: [{ id: "parent-source" }],
    child_rows: [{ id: "child-source" }],
  };
  const database = {
    prepare(sql) {
      const table = String(sql).match(/FROM\s+"([a-z_]+)"/i)?.[1];
      return { iterate: () => sourceRows[table][Symbol.iterator]() };
    },
  };
  const calls = [];
  const provider = {
    async transaction(callback) {
      return callback({
        async executeScript(sql) { calls.push({ type: "script", sql }); },
        async query(sql) {
          calls.push({ type: "query", sql });
          if (/WITH deleted AS/.test(sql)) return { rows: [{ total: "1" }] };
          if (/COUNT\(\*\)::text/.test(sql)) return { rows: [{ total: "1" }] };
          if (/SELECT count\(\*\) total/.test(sql)) return { rows: [{ total: "1" }] };
          return { rows: [] };
        },
      });
    },
  };
  const updates = [];
  const control = {
    async tableState(table) { return { table, last_watermark_value: null, last_watermark_pk_json: [] }; },
    async updateTableState(value) { updates.push(value.spec.name); },
    async failTable() { throw new Error("unexpected reconciliation failure"); },
  };

  const detected = await reconcileTargetOnlyRows({
    database,
    provider,
    control,
    manifest,
    batchId: "batch-detect",
    deletePolicy: resolveDeleteReconciliationPolicy({
      mode: "DETECT",
      apply: true,
      fullReconcile: true,
    }),
  });
  assert.deepEqual(detected.tables.map((table) => table.table), ["child_rows", "parent_rows"]);
  assert.equal(detected.candidates, 2);
  assert.equal(detected.deleted, 0);
  assert.equal(calls.some((call) => /WITH deleted AS/.test(call.sql)), false);

  calls.length = 0;
  const applied = await reconcileTargetOnlyRows({
    database,
    provider,
    control,
    manifest,
    batchId: "batch-apply",
    deletePolicy: resolveDeleteReconciliationPolicy({
      mode: "APPLY",
      apply: true,
      fullReconcile: true,
      deleteEnabled: true,
      confirmation: "commerce_ops_shadow",
    }),
  });
  assert.deepEqual(applied.tables.map((table) => table.table), ["child_rows", "parent_rows"]);
  assert.equal(applied.candidates, 2);
  assert.equal(applied.deleted, 2);
  assert.deepEqual(updates, ["child_rows", "parent_rows"]);
  assert.equal(calls.filter((call) => /WITH deleted AS/.test(call.sql)).length, 2);
});

test("Shadow control migration contains state, batch, table and validation ledgers", () => {
  const sql = fs.readFileSync(path.resolve("postgresql/shadow/migrations/004_incremental_sync_control.sql"), "utf8");
  for (const table of [
    "migration_state",
    "migration_sync_batches",
    "migration_sync_table_state",
    "migration_validation_runs",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS shadow_meta\\.${table}`));
  assert.match(sql, /is_switch_ready boolean NOT NULL DEFAULT false/);
});

test("incremental sync runtime cannot run while production provider is PostgreSQL", async () => {
  await assert.rejects(
    runShadowIncrementalSync({ rootDir: process.cwd(), env: { DATABASE_PROVIDER: "postgres" } }),
    /must remain sqlite/,
  );
});

test("switch readiness requires the exact latest passing final snapshot", async () => {
  const expected = "a".repeat(64);
  const calls = [];
  const provider = {
    async query() { return { rows: [] }; },
    async transaction(callback) {
      return callback({
        async query(sql) {
          calls.push(sql);
          if (/FOR UPDATE/.test(sql)) return { rows: [{ stage: "READY", last_validation_status: "PASS", paused: false }] };
          if (/migration_sync_batches/.test(sql)) return { rows: [{ count: 0 }] };
          if (/migration_sync_table_state/.test(sql)) return { rows: [{ count: 0 }] };
          if (/migration_validation_runs/.test(sql)) return { rows: [{
            status: "PASS",
            source_snapshot_time: "2026-08-06T15:00:00.000Z",
            source_snapshot_sha256: expected,
            tables_with_differences: 0,
            sample_failures: 0,
          }] };
          if (/^\s*UPDATE/.test(sql)) return { rows: [] };
          if (/SELECT \* FROM shadow_meta\.migration_state/.test(sql)) return { rows: [{ is_switch_ready: true }] };
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      });
    },
  };
  const repository = new SyncControlRepository({
    provider,
    stateId: "sqlite-to-postgresql-production-candidate",
    targetProvider: "postgresql_production_candidate",
  });
  assert.equal((await repository.markSwitchReady({ expectedSourceSnapshotSha256: expected })).is_switch_ready, true);
  assert.ok(calls.some((sql) => /is_switch_ready=true/.test(sql)));
  await assert.rejects(repository.markSwitchReady({ expectedSourceSnapshotSha256: "b".repeat(64) }), /does not match/);
});
