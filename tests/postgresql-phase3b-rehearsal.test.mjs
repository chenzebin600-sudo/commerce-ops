import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertPhase3bTarget,
  loadPhase3bMigrations,
  planPhase3bMigrations,
  resolvePhase3bInvocation,
} from "../lib/postgresql/phase3b-rehearsal.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG = Object.freeze({
  database: "commerce_ops",
  testDatabase: "commerce_ops_migration_test",
});

test("Phase 3B defaults to a non-mutating plan", () => {
  assert.deepEqual(resolvePhase3bInvocation([], CONFIG), {
    apply: false,
    confirmation: null,
    targetDatabase: CONFIG.testDatabase,
    mode: "PLAN",
  });
});

test("Phase 3B apply requires the exact isolated database confirmation", () => {
  assert.throws(
    () => resolvePhase3bInvocation(["--apply"], CONFIG),
    /--confirm-database=commerce_ops_migration_test/,
  );
  assert.throws(
    () => resolvePhase3bInvocation(["--apply", "--confirm-database=commerce_ops"], CONFIG),
    /--confirm-database=commerce_ops_migration_test/,
  );
  assert.deepEqual(
    resolvePhase3bInvocation([
      "--apply",
      "--confirm-database=commerce_ops_migration_test",
    ], CONFIG),
    {
      apply: true,
      confirmation: "commerce_ops_migration_test",
      targetDatabase: CONFIG.testDatabase,
      mode: "APPLY",
    },
  );
});

test("Phase 3B target guard rejects production, Shadow, shared, and system databases", () => {
  assert.equal(assertPhase3bTarget(CONFIG), CONFIG.testDatabase);
  assert.throws(() => assertPhase3bTarget(CONFIG, CONFIG.database), /only rebuild/);
  assert.throws(
    () => assertPhase3bTarget({ database: "same", testDatabase: "same" }),
    /only rebuild/,
  );
  assert.throws(
    () => assertPhase3bTarget({ database: "commerce_ops", testDatabase: "commerce_ops_shadow" }),
    /only rebuild/,
  );
  assert.throws(
    () => assertPhase3bTarget({ database: "commerce_ops", testDatabase: "postgres" }),
    /only rebuild/,
  );
});

test("Phase 3B migration plan covers the complete ordered Shadow contract", async () => {
  const migrations = await loadPhase3bMigrations(ROOT);
  assert.deepEqual(migrations.map((item) => item.version), [
    "001_legacy_tables.sql",
    "002_ai_observability.sql",
    "003_legacy_constraints_indexes_views.sql",
    "004_incremental_sync_control.sql",
    "005_fulfillment_provider.sql",
    "006_price_control_provider.sql",
    "007_commerce_shop_registry.sql",
    "008_price_control_repricing_workflow.sql",
    "009_product_package_database_sync.sql",
    "010_product_catalog_reference_indexes.sql",
    "011_product_package_sync_workspace.sql",
    "012_product_center_selectable_columns.sql",
    "013_commerce_shop_directory.sql",
    "014_commerce_shop_directory_identity_conflicts.sql",
    "015_growth_inventory_transfer_pending_shipment.sql",
    "016_customer_service_control_plane.sql",
    "017_profit_module.sql",
    "018_shared_product_knowledge.sql",
    "019_profit_expense_module.sql",
  ]);
  assert.equal(migrations.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)), true);
  assert.equal(planPhase3bMigrations(migrations).every((item) => item.status === "PENDING"), true);
  const applied = migrations.map((item) => ({ version: item.version, sha256: item.sha256 }));
  assert.equal(planPhase3bMigrations(migrations, applied).every((item) => item.status === "ALREADY_APPLIED"), true);
  const changed = applied.map((item, index) => index === 0 ? { ...item, sha256: "0".repeat(64) } : item);
  assert.equal(planPhase3bMigrations(migrations, changed)[0].status, "CHECKSUM_MISMATCH");
});

test("Phase 3B runner returns its plan before the guarded schema reset", async () => {
  const source = await readFile(path.join(ROOT, "scripts", "postgresql-phase3b-rehearsal.mjs"), "utf8");
  const planBranch = source.indexOf("if (!invocation.apply)");
  const resetCall = source.lastIndexOf("await resetTestSchemas(provider");
  assert.ok(planBranch > 0);
  assert.ok(resetCall > planBranch);
  assert.match(source, /resolvePhase3bInvocation\(process\.argv\.slice\(2\), config\)/);
  assert.doesNotMatch(source, /database:\s*config\.database/);
  assert.match(source, /postgresql-phase3a-write-contract-check\.mjs", \["--target=test"\]/);
  assert.match(source, /GRANT CREATE ON DATABASE/);
  assert.match(source, /REVOKE CREATE ON DATABASE/);
  assert.match(source, /assert\.equal\(identity\.database, config\.testDatabase\)/);
  assert.match(source, /assert\.equal\(after, privilege\.before\)/);
});
