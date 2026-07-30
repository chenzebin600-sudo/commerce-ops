import { assertDatabaseProvider } from "../data/database-provider.mjs";

const VALID_ORDER_STATUSES = Object.freeze(["已发货", "待处理", "配货中", "已完成"]);

export class SalesAssortmentRepository {
  constructor({ provider }) {
    assertDatabaseProvider(provider);
    this.provider = provider;
  }

  async sourceStatus() {
    const result = await this.provider.query(`
      SELECT source_type, source_filename, row_count, collected_at, imported_at, created_at
      FROM growth_source_batches
      WHERE status = 'applied'
      ORDER BY COALESCE(imported_at, created_at) DESC
    `);
    const latest = {};
    for (const row of result.rows) {
      if (!latest[row.source_type]) latest[row.source_type] = row;
    }
    const packages = await this.provider.query(`
      SELECT id, source_period, row_count, applied_at, created_at
      FROM product_import_batches
      WHERE status = 'applied'
      ORDER BY COALESCE(applied_at, created_at) DESC
      LIMIT 1
    `);
    return {
      order: latest.mabang_order || null,
      inventory: latest.mabang_inventory || null,
      productPackage: packages.rows[0] || null,
    };
  }

  async warehouseMappings() {
    const result = await this.provider.query(`
      SELECT normalized_warehouse_name, source_warehouse_name, country_code, country_name
      FROM growth_warehouse_country_mappings
      WHERE mapping_status = 'confirmed'
      ORDER BY confirmed_at DESC, created_at DESC
    `);
    return result.rows;
  }

  async productPackageRows() {
    const result = await this.provider.query(`
      SELECT source_row_key, country_normalized, sku_normalized, warehouse_normalized,
             normalized_payload_json
      FROM product_package_rows
      WHERE source_system = 'company_product_center'
      ORDER BY source_row_key
    `);
    return result.rows;
  }

  async latestInventoryRows() {
    const batch = await this.provider.query(`
      SELECT id, source_filename, collected_at, imported_at, row_count
      FROM growth_source_batches
      WHERE source_type = 'mabang_inventory' AND status = 'applied'
      ORDER BY COALESCE(collected_at, imported_at, created_at) DESC
      LIMIT 1
    `);
    const current = batch.rows[0];
    if (!current) return { batch: null, rows: [] };
    const result = await this.provider.query(`
      SELECT i.*, r.raw_values_json
      FROM growth_inventory_snapshots i
      LEFT JOIN growth_inventory_raw_rows r
        ON r.batch_id = i.batch_id AND r.source_row_number = i.source_row_number
      WHERE i.batch_id = ?
      ORDER BY i.source_row_number
    `, [current.id]);
    return { batch: current, rows: result.rows };
  }

  async currentOrderRows() {
    const placeholders = VALID_ORDER_STATUSES.map(() => "?").join(", ");
    const result = await this.provider.query(`
      SELECT l.source_sku, l.normalized_source_sku, l.quantity, l.product_name,
             l.source_warehouse_name, l.normalized_source_warehouse_name,
             h.source_order_id, h.order_status, h.paid_at, h.platform,
             h.source_shop_name, r.raw_values_json
      FROM growth_order_lines l
      JOIN growth_order_headers h ON h.id = l.order_header_id
      LEFT JOIN growth_order_raw_rows r
        ON r.batch_id = l.source_batch_id AND r.source_row_number = l.source_row_number
      WHERE l.is_current = 1
        AND h.order_status IN (${placeholders})
      ORDER BY h.paid_at, h.source_order_id, l.source_row_number
    `, VALID_ORDER_STATUSES);
    return result.rows;
  }
}
