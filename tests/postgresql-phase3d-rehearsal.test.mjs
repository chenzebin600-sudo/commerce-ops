import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPhase3dTarget,
  buildFullSourceSyncManifest,
  PHASE3D_REHEARSAL_DATABASE,
  resolvePhase3dInvocation,
  schemaCoverage,
} from "../lib/postgresql/phase3d-rehearsal.mjs";

const CONFIG = Object.freeze({ database: "commerce_ops", testDatabase: "commerce_ops_migration_test" });

test("Phase 3D defaults to a non-mutating plan", () => {
  assert.deepEqual(resolvePhase3dInvocation([], CONFIG), {
    apply: false,
    operation: "PLAN",
    confirmation: null,
    targetDatabase: PHASE3D_REHEARSAL_DATABASE,
    mode: "PLAN",
  });
});

test("Phase 3D apply requires one operation and the exact isolated database confirmation", () => {
  assert.throws(() => resolvePhase3dInvocation(["--apply"], CONFIG), /rebuild or --refresh/);
  assert.throws(() => resolvePhase3dInvocation(["--apply", "--rebuild"], CONFIG), /confirm-database/);
  assert.throws(() => resolvePhase3dInvocation([
    "--apply", "--rebuild", "--refresh", `--confirm-database=${PHASE3D_REHEARSAL_DATABASE}`,
  ], CONFIG), /mutually exclusive/);
  assert.deepEqual(resolvePhase3dInvocation([
    "--apply", "--rebuild", `--confirm-database=${PHASE3D_REHEARSAL_DATABASE}`,
  ], CONFIG), {
    apply: true,
    operation: "REBUILD",
    confirmation: PHASE3D_REHEARSAL_DATABASE,
    targetDatabase: PHASE3D_REHEARSAL_DATABASE,
    mode: "REBUILD",
  });
});

test("Phase 3D rejects production, test, Shadow, staging, and system targets", () => {
  assert.equal(assertPhase3dTarget(CONFIG), PHASE3D_REHEARSAL_DATABASE);
  for (const database of ["commerce_ops", "commerce_ops_migration_test", "commerce_ops_shadow", "commerce_ops_staging", "postgres"] ) {
    assert.throws(() => assertPhase3dTarget(CONFIG, database), /independent/);
  }
});

test("full-source manifest includes every primary-key table in dependency order", () => {
  const source = {
    tables: [
      { name: "child", primaryKey: ["id"], foreignKeys: [{ table: "parent" }], columns: [{ name: "id" }] },
      { name: "parent", primaryKey: ["id"], foreignKeys: [], columns: [{ name: "id" }] },
    ],
  };
  assert.deepEqual(buildFullSourceSyncManifest(source).map((item) => item.name), ["parent", "child"]);
});

test("schema coverage reports missing source relations and ordered column drift", () => {
  const source = {
    tables: [{ name: "one", columns: [{ name: "id" }, { name: "name" }] }, { name: "two", columns: [] }],
    views: [{ name: "one_v" }],
  };
  assert.deepEqual(schemaCoverage(source, {
    tables: [{ name: "one", columns: [{ name: "name" }, { name: "id" }] }],
    views: [],
  }), {
    ok: false,
    sourceTables: 2,
    sourceViews: 1,
    missingTables: ["two"],
    missingViews: ["one_v"],
    columnDifferences: [{ table: "one", expected: ["id", "name"], actual: ["name", "id"] }],
  });
});
