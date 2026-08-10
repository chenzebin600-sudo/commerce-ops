import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPhase3cStagingTarget,
  resolvePhase3cStagingInvocation,
} from "../lib/postgresql/phase3c-staging.mjs";

const config = Object.freeze({
  database: "commerce_ops",
  testDatabase: "commerce_ops_migration_test",
});

test("Phase 3C staging accepts only the independent fixed target", () => {
  assert.equal(assertPhase3cStagingTarget(config), "commerce_ops_staging");
  for (const target of ["commerce_ops", "commerce_ops_migration_test", "commerce_ops_shadow", "postgres"]) {
    assert.throws(() => assertPhase3cStagingTarget(config, target), /independent database/);
  }
});

test("Phase 3C staging apply requires exact database confirmation", () => {
  assert.equal(resolvePhase3cStagingInvocation([], config).mode, "PLAN");
  assert.throws(() => resolvePhase3cStagingInvocation(["--apply"], config), /confirm-database=commerce_ops_staging/);
  assert.throws(() => resolvePhase3cStagingInvocation([
    "--apply",
    "--confirm-database=commerce_ops_shadow",
  ], config), /confirm-database=commerce_ops_staging/);
  assert.deepEqual(resolvePhase3cStagingInvocation([
    "--apply",
    "--confirm-database=commerce_ops_staging",
  ], config), {
    apply: true,
    resume: false,
    confirmation: "commerce_ops_staging",
    targetDatabase: "commerce_ops_staging",
    mode: "APPLY",
  });
  assert.throws(() => resolvePhase3cStagingInvocation(["--resume"], config), /requires --apply/);
  assert.equal(resolvePhase3cStagingInvocation([
    "--apply",
    "--resume",
    "--confirm-database=commerce_ops_staging",
  ], config).mode, "RESUME");
});
