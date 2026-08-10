import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductionOperationalContext } from "../lib/postgresql/production-operational-context.mjs";

test("production operational context permits pre-cutover SQLite readiness tooling", () => {
  assert.deepEqual(resolveProductionOperationalContext({ env: {}, database: "commerce_ops_staging" }), {
    provider: "sqlite",
    formalCutover: false,
  });
});

test("production operational context requires the exact formal cutover guard", () => {
  const env = {
    DATABASE_PROVIDER: "postgres",
    POSTGRES_PRODUCTION_MODE: "true",
    POSTGRES_PRODUCTION_CONFIRM_DATABASE: "commerce_ops",
    POSTGRES_PRODUCTION_CONFIRM_SCOPE: "FORMAL_CUTOVER",
    POSTGRES_SHADOW_MODE: "false",
    POSTGRES_STAGING_MODE: "false",
    POSTGRES_CUTOVER_REHEARSAL_MODE: "false",
    POSTGRES_PRODUCTION_CANDIDATE_MODE: "false",
  };
  assert.deepEqual(resolveProductionOperationalContext({ env, database: "commerce_ops" }), {
    provider: "postgres",
    formalCutover: true,
  });
  assert.throws(() => resolveProductionOperationalContext({ env: { ...env, POSTGRES_PRODUCTION_CONFIRM_SCOPE: "WRONG" }, database: "commerce_ops" }), /FORMAL_CUTOVER/);
  assert.throws(() => resolveProductionOperationalContext({ env: { ...env, POSTGRES_SHADOW_MODE: "true" }, database: "commerce_ops" }), /FORMAL_CUTOVER/);
  assert.throws(() => resolveProductionOperationalContext({ env, database: "commerce_ops_staging" }), /only target commerce_ops/);
});
