import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const rootDir = process.cwd();
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const dataAccess = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: process.env,
});
const rows = async (sql, parameters = []) => (await dataAccess.provider.query(sql, parameters)).rows;

try {
  const report = {
    shops: await rows(`SELECT platform,source_country_code AS country,status,COUNT(*) AS count
      FROM commerce_shop_registry
      GROUP BY platform,source_country_code,status
      ORDER BY platform,country`),
    totals: (await rows(`SELECT COUNT(*) AS shops,
      SUM(CASE WHEN growth_shop_id IS NOT NULL THEN 1 ELSE 0 END) AS growth_links,
      SUM(CASE WHEN control_shop_type='UNKNOWN' THEN 1 ELSE 0 END) AS unknown_shop_types,
      SUM(CASE WHEN execution_provider='MABANG_LISTING' THEN 1 ELSE 0 END) AS mabang_executors
      FROM commerce_shop_registry`))[0],
    bindings: await rows(`SELECT source_system,status,COUNT(*) AS count
      FROM commerce_shop_account_bindings GROUP BY source_system,status`),
    audit: (await rows(`SELECT action,status,metadata_json,occurred_at
      FROM operation_audit_events
      WHERE action='product.price_control.shops.synchronized'
      ORDER BY occurred_at DESC LIMIT 1`))[0] || null,
    quickCheck: await rows("PRAGMA quick_check"),
    foreignKeyCheck: await rows("PRAGMA foreign_key_check"),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await dataAccess.close();
}
