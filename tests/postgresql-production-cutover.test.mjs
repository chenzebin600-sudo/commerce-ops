import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  applyProductionEnvironment,
  classifyProductionProcesses,
  PHASE3D_PRODUCTION_CUTOVER_CONFIRMATION,
  PHASE3D_PRODUCTION_FREEZE_CONFIRMATION,
  PHASE3D_PRODUCTION_ROLLBACK_LIMIT_CONFIRMATION,
  productionCutoverApplyCommand,
  resolveProductionCutoverInvocation,
  resolveProductionWriterState,
} from "../lib/postgresql/phase3d-production-cutover.mjs";

const CONFIG = Object.freeze({ database: "commerce_ops" });

test("production cutover defaults to a non-mutating plan", () => {
  assert.deepEqual(resolveProductionCutoverInvocation([], CONFIG), {
    apply: false,
    targetDatabase: "commerce_ops",
    confirmedDatabase: null,
    confirmedCutover: null,
    confirmedFreeze: null,
    confirmedRollbackLimit: null,
  });
});

test("production cutover requires every exact irreversible confirmation", () => {
  const base = [
    "--apply",
    "--confirm-database=commerce_ops",
    `--confirm-freeze=${PHASE3D_PRODUCTION_FREEZE_CONFIRMATION}`,
    `--confirm-cutover=${PHASE3D_PRODUCTION_CUTOVER_CONFIRMATION}`,
  ];
  assert.throws(() => resolveProductionCutoverInvocation(base, CONFIG), /NO_REVERSE_SYNC_AFTER_POSTGRES_WRITES/);
  const approved = resolveProductionCutoverInvocation([
    ...base,
    `--confirm-rollback-limit=${PHASE3D_PRODUCTION_ROLLBACK_LIMIT_CONFIRMATION}`,
  ], CONFIG);
  assert.equal(approved.apply, true);
  assert.match(productionCutoverApplyCommand(), /STOP_SQLITE_MAIN_AND_SCHEDULER_WRITERS/);
  assert.match(productionCutoverApplyCommand(), /FINAL_SQLITE_FREEZE_SYNC_AND_POSTGRES_SWITCH/);
});

test("production cutover rejects protected or aliased database targets", () => {
  assert.throws(() => resolveProductionCutoverInvocation([], { database: "commerce_ops_staging" }), /requires configured database commerce_ops/);
  assert.throws(() => resolveProductionCutoverInvocation([], { database: "commerce_ops_shadow" }), /requires configured database commerce_ops/);
});

test("production process classification only selects exact workspace scripts and their supervisor", () => {
  const root = path.resolve("D:/Projects/commerce-ops");
  const selected = classifyProductionProcesses([
    { pid: 10, parentPid: 1, commandLine: `node ${path.join(root, "server.mjs")}` },
    { pid: 11, parentPid: 20, commandLine: `node ${path.join(root, "scheduler.mjs")}` },
    { pid: 20, parentPid: 1, commandLine: "node scripts/start-all.mjs" },
    { pid: 30, parentPid: 1, commandLine: "node server.mjs" },
    { pid: 40, parentPid: 1, commandLine: "node D:/Projects/another/server.mjs" },
  ], root);
  assert.deepEqual(selected.map(({ pid, role }) => ({ pid, role })), [
    { pid: 10, role: "main" },
    { pid: 11, role: "scheduler" },
    { pid: 20, role: "supervisor" },
  ]);
});

test("production writer state accepts fully running or fully frozen but rejects partial state", () => {
  assert.equal(resolveProductionWriterState([
    { role: "main", pid: 1 },
    { role: "scheduler", pid: 2 },
  ]).state, "RUNNING");
  assert.equal(resolveProductionWriterState([]).state, "FROZEN");
  assert.deepEqual(resolveProductionWriterState([{ role: "main", pid: 1 }]), {
    state: "INCONSISTENT",
    main: [{ role: "main", pid: 1 }],
    scheduler: [],
    safe: false,
  });
});

test("production environment update is idempotent and preserves unrelated entries", () => {
  const original = "CUSTOM_VALUE=keep\nDATABASE_PROVIDER=sqlite\nPOSTGRES_PRODUCTION_MODE=false\n";
  const once = applyProductionEnvironment(original);
  const twice = applyProductionEnvironment(once);
  assert.equal(once, twice);
  assert.match(once, /^CUSTOM_VALUE=keep/m);
  assert.match(once, /^DATABASE_PROVIDER=postgres/m);
  assert.match(once, /^POSTGRES_PRODUCTION_MODE=true/m);
  assert.match(once, /^POSTGRES_PRODUCTION_CONFIRM_SCOPE=FORMAL_CUTOVER/m);
  assert.equal((once.match(/^DATABASE_PROVIDER=/gm) || []).length, 1);
});
