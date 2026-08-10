import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProductionCandidateTarget,
  PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
  productionCandidateApplyCommand,
  resolveProductionCandidateInvocation,
} from "../lib/postgresql/phase3d-production-candidate.mjs";

const CONFIG = Object.freeze({ database: PHASE3D_PRODUCTION_CANDIDATE_DATABASE, testDatabase: "commerce_ops_migration_test" });

test("production candidate defaults to a non-mutating plan", () => {
  assert.deepEqual(resolveProductionCandidateInvocation([], CONFIG), {
    apply: false,
    operation: "PLAN",
    targetDatabase: PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
    confirmedDatabase: null,
    confirmedMutation: null,
  });
});

test("production candidate initialize requires both exact confirmations", () => {
  assert.throws(() => resolveProductionCandidateInvocation(["--apply", "--initialize"], CONFIG), /confirm-database/);
  assert.throws(() => resolveProductionCandidateInvocation([
    "--apply", "--initialize", "--confirm-database=commerce_ops",
  ], CONFIG), /INITIALIZE_AND_FULL_SYNC/);
  assert.equal(resolveProductionCandidateInvocation([
    "--apply", "--initialize", "--confirm-database=commerce_ops",
    "--confirm-production-mutation=INITIALIZE_AND_FULL_SYNC",
  ], CONFIG).operation, "INITIALIZE");
});

test("production candidate refresh uses a different explicit mutation confirmation", () => {
  assert.throws(() => resolveProductionCandidateInvocation([
    "--apply", "--refresh", "--confirm-database=commerce_ops",
    "--confirm-production-mutation=INITIALIZE_AND_FULL_SYNC",
  ], CONFIG), /REFRESH_FULL_SOURCE/);
  assert.match(productionCandidateApplyCommand("refresh"), /REFRESH_FULL_SOURCE/);
});

test("production candidate target rejects aliases and protected identities", () => {
  assert.throws(() => assertProductionCandidateTarget({ database: "commerce_ops_shadow", testDatabase: "commerce_ops_migration_test" }), /requires configured database/);
  assert.throws(() => assertProductionCandidateTarget({ database: "commerce_ops_staging", testDatabase: "commerce_ops_migration_test" }), /requires configured database/);
});
