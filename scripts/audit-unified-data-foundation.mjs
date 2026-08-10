import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { auditUnifiedDataFoundation } from "../lib/data-foundation/unified-data-audit.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function hasTable(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName));
}

function connectorAudit(databasePath) {
  if (!fs.existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const shops = database.prepare(`
      SELECT count(*) AS shops,
             sum(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_shops
      FROM connector_shops
    `).get();
    const authorization = database.prepare(`
      SELECT count(*) AS authorizations,
             sum(CASE WHEN datetime(expires_at) <= datetime('now') AND token_status='active' THEN 1 ELSE 0 END) AS expired_marked_active
      FROM connector_shop_authorizations
    `).get();
    const missing = database.prepare(`
      SELECT count(*) AS total
      FROM connector_shops shop
      LEFT JOIN connector_shop_authorizations authorization ON authorization.shop_id = shop.id
      WHERE shop.status = 'active' AND authorization.shop_id IS NULL
    `).get();
    const legacyDuplicates = hasTable(database, "lazada_store_tokens")
      ? database.prepare(`
          SELECT count(*) AS total
          FROM lazada_store_tokens legacy
          JOIN connector_shops shop ON lower(shop.platform_id)='lazada' AND shop.seller_id=legacy.shop_id
          JOIN connector_shop_authorizations authorization ON authorization.shop_id=shop.id
        `).get().total
      : 0;
    return {
      shops: Number(shops.shops || 0),
      active_shops: Number(shops.active_shops || 0),
      authorizations: Number(authorization.authorizations || 0),
      active_without_authorization: Number(missing.total || 0),
      expired_marked_active: Number(authorization.expired_marked_active || 0),
      application_table_present: hasTable(database, "connector_applications"),
      legacy_lazada_token_duplicates: Number(legacyDuplicates || 0),
    };
  } finally {
    database.close();
  }
}

async function main() {
  loadLocalEnv(rootDir);
  const config = loadPostgresqlF1Config({ rootDir, env: process.env });
  if (config.database !== "commerce_ops") throw new Error("Unified data audit is restricted to commerce_ops");
  const provider = new PostgresqlProvider({
    config: { ...config, schema: "app" },
    database: config.database,
    user: config.appUser,
    password: config.appPassword,
    readOnly: true,
  });
  try {
    const connector = connectorAudit(path.join(rootDir, "storage", "lazada-oauth.sqlite"));
    return await auditUnifiedDataFoundation({ provider, connector });
  } finally {
    await provider.close();
  }
}

main()
  .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`Unified data audit failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
    process.exitCode = 1;
  });
