const DOMAIN_ROOTS = Object.freeze({
  product: Object.freeze([
    "product_ai_contents",
    "product_categories",
    "product_cost_snapshots",
    "product_detail_preferences",
    "product_field_override_events",
    "product_field_overrides",
    "product_images",
    "product_import_batches",
    "product_import_files",
    "product_import_rows",
    "product_inventory_snapshots",
    "product_media_assets",
    "product_media_links",
    "product_models",
    "product_package_rows",
    "product_packaging_profiles",
    "product_sku_lifecycle",
    "product_sku_lifecycle_events",
    "product_skus",
  ]),
  sales: Object.freeze([
    "growth_order_headers",
    "growth_order_inventory_links",
    "growth_order_lines",
    "growth_order_raw_rows",
    "growth_shop_source_mappings",
    "growth_shops",
    "growth_source_batches",
    "growth_warehouse_country_mappings",
  ]),
  inventory: Object.freeze([
    "growth_inventory_raw_rows",
    "growth_inventory_snapshots",
    "growth_sku_warehouse_sales_metrics",
  ]),
  task: Object.freeze([
    "foundation_account_capabilities",
    "foundation_identity_links",
    "foundation_integration_accounts",
    "foundation_owners",
    "foundation_source_runs",
    "foundation_source_systems",
    "foundation_task_events",
    "foundation_task_leases",
    "foundation_tasks",
    "foundation_warehouses",
  ]),
  audit: Object.freeze(["operation_audit_events"]),
});

const WATERMARK_PRIORITY = Object.freeze([
  "updated_at",
  "renewed_at",
  "occurred_at",
  "last_seen_at",
  "created_at",
  "snapshot_at",
  "captured_at",
  "imported_at",
]);

function rootDomains() {
  const result = new Map();
  for (const [domain, tables] of Object.entries(DOMAIN_ROOTS)) {
    for (const table of tables) {
      const existing = result.get(table) || [];
      result.set(table, [...existing, domain]);
    }
  }
  return result;
}

function dependencyClosure(source, roots) {
  const byName = new Map(source.tables.map((table) => [table.name, table]));
  const selected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...selected]) {
      const table = byName.get(name);
      if (!table) throw new Error(`Incremental sync table is missing from SQLite: ${name}`);
      for (const foreignKey of table.foreignKeys) {
        if (!selected.has(foreignKey.table)) {
          selected.add(foreignKey.table);
          changed = true;
        }
      }
    }
  }
  return { byName, selected };
}

function dependencyOrder(byName, selected) {
  const pending = new Set(selected);
  const resolved = new Set();
  const order = [];
  while (pending.size) {
    const available = [...pending].filter((name) => byName.get(name).foreignKeys
      .filter((foreignKey) => foreignKey.table !== name && selected.has(foreignKey.table))
      .every((foreignKey) => resolved.has(foreignKey.table)))
      .sort();
    if (!available.length) {
      throw new Error(`Incremental sync foreign-key cycle: ${[...pending].sort().join(", ")}`);
    }
    for (const name of available) {
      pending.delete(name);
      resolved.add(name);
      order.push(name);
    }
  }
  return order;
}

function watermarkColumn(table) {
  const columns = new Set(table.columns.map((column) => column.name));
  return WATERMARK_PRIORITY.find((column) => columns.has(column)) || null;
}

export function buildIncrementalSyncManifest(source, { domainRoots = DOMAIN_ROOTS } = {}) {
  if (!source?.tables?.length) throw new TypeError("SQLite schema inventory is required");
  const domains = domainRoots === DOMAIN_ROOTS ? rootDomains() : (() => {
    const map = new Map();
    for (const [domain, tables] of Object.entries(domainRoots)) {
      for (const table of tables) map.set(table, [...(map.get(table) || []), domain]);
    }
    return map;
  })();
  const roots = [...domains.keys()];
  const { byName, selected } = dependencyClosure(source, roots);
  const order = dependencyOrder(byName, selected);
  return Object.freeze(order.map((name, orderIndex) => {
    const table = byName.get(name);
    if (!table.primaryKey?.length) throw new Error(`Incremental sync requires a primary key: ${name}`);
    const watermark = watermarkColumn(table);
    return Object.freeze({
      name,
      domain: domains.has(name) ? domains.get(name).sort().join("+") : "dependency",
      order: orderIndex,
      captureMode: watermark ? "WATERMARK" : "FULL_HASH_SCAN",
      watermarkColumn: watermark,
      primaryKey: Object.freeze([...table.primaryKey]),
      table,
    });
  }));
}

export function incrementalSyncDomains() {
  return DOMAIN_ROOTS;
}

