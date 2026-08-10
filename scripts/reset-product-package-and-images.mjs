import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const resetConfirmation = "CLEAR_PRODUCT_PACKAGE_AND_IMAGES";
const activeImageDirectories = ["product-images", "product-media"];

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function assertDirectChild(root, target) {
  if (path.dirname(path.resolve(target)).toLocaleLowerCase("en-US") !== path.resolve(root).toLocaleLowerCase("en-US")) {
    throw new Error(`Image reset target must be a direct child of STORAGE_ROOT: ${target}`);
  }
}

async function moveImageDirectories(storageRoot) {
  const backupBase = path.resolve(
    process.env.COMMERCE_OPS_PRODUCT_RESET_BACKUP_ROOT || path.join(path.parse(rootDir).root, "CommerceOpsBackups", "product-center-reset"),
    stamp(),
  );
  const moved = [];
  await fs.mkdir(backupBase, { recursive: true });
  for (const name of activeImageDirectories) {
    const source = path.join(storageRoot, name);
    const backup = path.join(backupBase, name);
    assertDirectChild(storageRoot, source);
    const exists = await fs.stat(source).then(() => true).catch(() => false);
    if (exists) {
      await fs.rename(source, backup);
      moved.push({ source, backup });
    }
    await fs.mkdir(source, { recursive: true });
  }
  return { backupBase, moved };
}

async function restoreImageDirectories(moved) {
  for (const entry of [...moved].reverse()) {
    await fs.rmdir(entry.source).catch(() => null);
    await fs.rename(entry.backup, entry.source).catch(() => null);
  }
}

async function tableCounts(provider, names) {
  const rows = await Promise.all(names.map(async (name) => {
    const count = (await provider.query(`SELECT COUNT(*)::integer count FROM app.${name}`)).rows[0].count;
    return [name, Number(count)];
  }));
  return Object.fromEntries(rows);
}

async function main() {
  loadLocalEnv(rootDir);
  const config = loadPostgresqlF1Config({ rootDir });
  const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const apply = process.argv.includes("--apply");
  if (!apply) return { status: "PLAN", database: config.database, storageRoot: runtimeConfig.storageRoot };
  if (option("confirm-database") !== config.database || option("confirm-reset") !== resetConfirmation) {
    throw new Error(`Reset requires --confirm-database=${config.database} --confirm-reset=${resetConfirmation}`);
  }
  const provider = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 600_000 }),
    database: config.database,
    user: config.appUser,
    password: config.appPassword,
  });
  const trackedTables = [
    "product_package_rows", "product_import_batches", "product_import_rows", "product_import_field_changes",
    "product_skus", "product_models", "product_categories", "product_images", "product_media_assets", "product_media_links",
    "mabang_sku_image_batches", "mabang_sku_image_checkpoints", "mabang_sku_image_discoveries",
    "mabang_sku_image_discovery_images", "mabang_sku_image_sync_runs",
  ];
  let imageMove = null;
  try {
    const identity = (await provider.query("SELECT current_database() database,current_user username")).rows[0];
    if (identity.database !== config.database || identity.username !== config.appUser) {
      throw new Error("Reset identity does not match the approved production database and application role");
    }
    const before = await tableCounts(provider, trackedTables);
    imageMove = await moveImageDirectories(runtimeConfig.storageRoot);
    const affected = await provider.transaction(async (tx) => {
      await tx.executeScript("SET LOCAL statement_timeout = '10min'");
      await tx.query("SELECT pg_advisory_xact_lock(1557337991)");
      const result = {};
      const execute = async (key, sql, values = []) => {
        result[key] = Number((await tx.execute(sql, values)).rowCount || 0);
      };

      await execute("growth_inventory_unmapped", "UPDATE app.growth_inventory_snapshots SET mapped_product_id=NULL WHERE mapped_product_id IS NOT NULL");
      await execute("growth_order_lines_unmapped", "UPDATE app.growth_order_lines SET mapped_product_id=NULL WHERE mapped_product_id IS NOT NULL");
      await execute("growth_shop_daily_unmapped", "UPDATE app.growth_shop_sku_daily_metrics SET mapped_product_id=NULL WHERE mapped_product_id IS NOT NULL");
      await execute("growth_shop_observations_unmapped", "UPDATE app.growth_shop_sku_observations SET mapped_product_id=NULL WHERE mapped_product_id IS NOT NULL");
      await execute("growth_sku_daily_unmapped", "UPDATE app.growth_sku_daily_metrics SET mapped_product_id=NULL WHERE mapped_product_id IS NOT NULL");
      await execute("growth_sku_warehouse_unmapped", "UPDATE app.growth_sku_warehouse_daily_metrics SET mapped_product_id=NULL WHERE mapped_product_id IS NOT NULL");
      await execute("foundation_tasks_unmapped", "UPDATE app.foundation_tasks SET sku_id=NULL WHERE sku_id IS NOT NULL");
      await execute("growth_coverage_deleted", "DELETE FROM app.growth_shop_sku_coverage_snapshots");
      await execute("identity_mappings_deleted", "DELETE FROM app.product_identity_mappings");

      await execute("image_generation_items_deleted", "DELETE FROM app.product_image_generation_items");
      await execute("image_generation_tasks_deleted", "DELETE FROM app.product_image_generation_tasks");
      await execute("listing_publish_records_deleted", "DELETE FROM app.product_listing_publish_records");
      await execute("ai_contents_deleted", "DELETE FROM app.product_ai_contents");
      await execute("listing_drafts_deleted", "DELETE FROM app.product_listing_drafts");
      await execute("media_links_deleted", "DELETE FROM app.product_media_links");
      await execute("product_images_deleted", "DELETE FROM app.product_images");

      await execute("image_batch_parent_links_cleared", "UPDATE app.mabang_sku_image_batches SET source_batch_id=NULL WHERE source_batch_id IS NOT NULL");
      await execute("image_batches_deleted", "DELETE FROM app.mabang_sku_image_batches");
      await execute("image_sync_runs_deleted", "DELETE FROM app.mabang_sku_image_sync_runs");
      await execute("media_assets_deleted", "DELETE FROM app.product_media_assets");

      await execute("field_override_events_deleted", "DELETE FROM app.product_field_override_events");
      await execute("field_overrides_deleted", "DELETE FROM app.product_field_overrides");
      await execute("lifecycle_events_deleted", "DELETE FROM app.product_sku_lifecycle_events");
      await execute("lifecycle_deleted", "DELETE FROM app.product_sku_lifecycle");
      await execute("packaging_deleted", "DELETE FROM app.product_packaging_profiles");
      await execute("cost_snapshots_deleted", "DELETE FROM app.product_cost_snapshots");
      await execute("inventory_snapshots_deleted", "DELETE FROM app.product_inventory_snapshots");
      await execute("field_changes_deleted", "DELETE FROM app.product_import_field_changes");
      await execute("import_issues_deleted", "DELETE FROM app.product_import_issues");
      await execute("package_rows_deleted", "DELETE FROM app.product_package_rows");
      await execute("products_deleted", "DELETE FROM app.product_skus");
      await execute("models_deleted", "DELETE FROM app.product_models");
      await execute("child_categories_deleted", "DELETE FROM app.product_categories WHERE parent_id IS NOT NULL");
      await execute("categories_deleted", "DELETE FROM app.product_categories");
      await execute("import_rows_deleted", "DELETE FROM app.product_import_rows");
      await execute("import_files_deleted", "DELETE FROM app.product_import_files");
      await execute("sync_runs_deleted", "DELETE FROM app.product_package_sync_runs");
      await execute("import_batches_deleted", "DELETE FROM app.product_import_batches");
      return result;
    });
    const after = await tableCounts(provider, trackedTables);
    const residual = Object.entries(after).filter(([, count]) => count !== 0);
    if (residual.length) throw new Error(`Product reset left residual rows: ${JSON.stringify(residual)}`);
    return {
      status: "APPLIED",
      database: config.database,
      before,
      after,
      affected,
      imageBackupDirectory: imageMove.backupBase,
      activeImageDirectories: activeImageDirectories.map((name) => path.join(runtimeConfig.storageRoot, name)),
    };
  } catch (error) {
    if (imageMove?.moved?.length) await restoreImageDirectories(imageMove.moved);
    throw error;
  } finally {
    await provider.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`Product package reset failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
