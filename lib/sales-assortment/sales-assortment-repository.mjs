import { assertDatabaseProvider } from "../data/database-provider.mjs";
import { createRepositorySql } from "../data/repository-sql.mjs";
import { PRODUCT_PACKAGE_SOURCE_SYSTEM } from "../data-foundation/unified-data-contracts.mjs";

const VALID_ORDER_STATUSES = Object.freeze(["已发货", "待处理", "配货中", "已完成"]);

function legacyTimestamp(value) {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 19).replace("T", " ")
    : String(value);
}

function orderRow(row) {
  const lineAmount = row.line_amount === null || row.line_amount === undefined || row.line_amount === ""
    ? null
    : Number(row.line_amount);
  const orderAmount = row.order_amount === null || row.order_amount === undefined || row.order_amount === ""
    ? null
    : Number(row.order_amount);
  return {
    ...row,
    paid_at: legacyTimestamp(row.paid_at),
    quantity: Number(row.quantity || 0),
    line_amount: Number.isFinite(lineAmount) ? lineAmount : null,
    line_amount_status: String(row.line_amount_status || "unavailable").trim().toLowerCase(),
    order_amount: Number.isFinite(orderAmount) ? orderAmount : null,
    order_currency: String(row.order_currency || "").trim().toUpperCase() || null,
  };
}

function inventoryRow(row) {
  const numeric = [
    "warehouse_stock", "available_quantity", "in_transit_quantity", "unshipped_quantity",
    "predicted_daily_sales", "days_of_supply", "sales_7d", "sales_28d", "sales_42d",
  ];
  const result = { ...row };
  for (const field of numeric) {
    if (result[field] !== null && result[field] !== undefined && result[field] !== "") {
      result[field] = Number(result[field]);
    }
  }
  return result;
}

export class SalesAssortmentRepository {
  constructor({ provider }) {
    assertDatabaseProvider(provider);
    this.provider = provider;
    this.sql = createRepositorySql(provider);
  }

  async sourceStatus() {
    const result = await this.provider.query(`
      SELECT id, source_type, source_filename, row_count, collected_at, imported_at, created_at
      FROM ${this.sql.table("growth_source_batches")}
      WHERE status = 'applied'
      ORDER BY COALESCE(imported_at, created_at) DESC
    `);
    const latest = {};
    for (const row of result.rows) {
      if (!latest[row.source_type]) latest[row.source_type] = row;
    }
    const packages = await this.provider.query(`
      SELECT id, source_period, row_count, applied_at, created_at
      FROM ${this.sql.table("product_import_batches")}
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
      FROM ${this.sql.table("growth_warehouse_country_mappings")}
      WHERE mapping_status = 'confirmed'
      ORDER BY confirmed_at DESC, created_at DESC
    `);
    return result.rows;
  }

  async productPackageRows() {
    const result = await this.provider.query(`
      SELECT source_row_key, country_normalized, sku_normalized, warehouse_normalized,
             normalized_payload_json->>'country_raw' AS country_raw,
             normalized_payload_json->>'sku_code' AS sku_code,
             normalized_payload_json->>'warehouse_raw' AS warehouse_raw,
             normalized_payload_json->>'cost_cny' AS cost_cny,
             normalized_payload_json->>'cost_local' AS cost_local,
             normalized_payload_json->>'exchange_rate' AS exchange_rate,
             normalized_payload_json->>'exchange_direction' AS exchange_direction,
             normalized_payload_json->>'product_name' AS product_name,
             normalized_payload_json->>'category_l1' AS category_l1,
             normalized_payload_json->>'category_l2' AS category_l2,
             normalized_payload_json->>'style_name' AS style_name,
             normalized_payload_json->>'main_sku_code' AS main_sku_code
      FROM ${this.sql.table("product_package_rows")}
      WHERE source_system = ${this.sql.placeholder(1)}
      ORDER BY source_row_key
    `, [PRODUCT_PACKAGE_SOURCE_SYSTEM]);
    return result.rows;
  }

  async latestInventoryRows() {
    const batch = await this.provider.query(`
      SELECT id, source_filename, collected_at, imported_at, row_count
      FROM ${this.sql.table("growth_source_batches")}
      WHERE source_type = 'mabang_inventory' AND status = 'applied'
      ORDER BY COALESCE(collected_at, imported_at, created_at) DESC
      LIMIT 1
    `);
    const current = batch.rows[0];
    if (!current) return { batch: null, rows: [] };
    const result = await this.provider.query(`
      SELECT i.*, r.raw_values_json
      FROM ${this.sql.table("growth_inventory_snapshots")} i
      LEFT JOIN ${this.sql.table("growth_inventory_raw_rows")} r
        ON r.batch_id = i.batch_id AND r.source_row_number = i.source_row_number
      WHERE i.batch_id = ${this.sql.placeholder(1)}
      ORDER BY i.source_row_number
    `, [current.id]);
    return { batch: current, rows: result.rows.map(inventoryRow) };
  }

  async previousInventoryRows() {
    const batch = await this.provider.query(`
      SELECT id, source_filename, collected_at, imported_at, row_count
      FROM ${this.sql.table("growth_source_batches")}
      WHERE source_type = 'mabang_inventory' AND status = 'applied'
      ORDER BY COALESCE(collected_at, imported_at, created_at) DESC
      LIMIT 1 OFFSET 1
    `);
    const previous = batch.rows[0];
    if (!previous) return { batch: null, rows: [] };
    const result = await this.provider.query(`
      SELECT i.*, r.raw_values_json
      FROM ${this.sql.table("growth_inventory_snapshots")} i
      LEFT JOIN ${this.sql.table("growth_inventory_raw_rows")} r
        ON r.batch_id = i.batch_id AND r.source_row_number = i.source_row_number
      WHERE i.batch_id = ${this.sql.placeholder(1)}
      ORDER BY i.source_row_number
    `, [previous.id]);
    return { batch: previous, rows: result.rows.map(inventoryRow) };
  }

  async latestOrderDay() {
    const placeholders = this.sql.placeholders(VALID_ORDER_STATUSES.length).join(", ");
    const result = await this.provider.query(`
      SELECT MAX(h.paid_at) AS latest_paid_at
      FROM ${this.sql.table("growth_order_lines")} l
      JOIN ${this.sql.table("growth_order_headers")} h ON h.id = l.order_header_id
      WHERE l.is_current = 1
        AND h.order_status IN (${placeholders})
    `, VALID_ORDER_STATUSES);
    return legacyTimestamp(result.rows[0]?.latest_paid_at);
  }

  async salesSummary({ dateFrom = null, dateToExclusive = null } = {}) {
    const statusPlaceholders = this.sql.placeholders(VALID_ORDER_STATUSES.length).join(", ");
    const conditions = [];
    const parameters = [...VALID_ORDER_STATUSES];
    if (dateFrom) {
      conditions.push(`h.paid_at>=${this.sql.placeholder(parameters.length + 1)}`);
      parameters.push(dateFrom);
    }
    if (dateToExclusive) {
      conditions.push(`h.paid_at<${this.sql.placeholder(parameters.length + 1)}`);
      parameters.push(dateToExclusive);
    }
    const result = await this.provider.query(`
      SELECT COUNT(DISTINCT h.source_order_id) AS order_count,
             COUNT(*) AS line_count,
             COALESCE(SUM(l.quantity),0) AS sales_quantity,
             MIN(h.paid_at) AS earliest_paid_at,
             MAX(h.paid_at) AS latest_paid_at
      FROM ${this.sql.table("growth_order_lines")} l
      JOIN ${this.sql.table("growth_order_headers")} h ON h.id=l.order_header_id
      WHERE l.is_current=1 AND h.order_status IN (${statusPlaceholders})
        ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
    `, parameters);
    const row = result.rows[0] || {};
    return {
      orderCount: Number(row.order_count || 0),
      lineCount: Number(row.line_count || 0),
      salesQuantity: Number(row.sales_quantity || 0),
      earliestPaidAt: legacyTimestamp(row.earliest_paid_at),
      latestPaidAt: legacyTimestamp(row.latest_paid_at),
    };
  }

  async salesIdentitySet() {
    const [headers, lines] = await Promise.all([
      this.provider.query(`
        SELECT id,source_order_id
        FROM ${this.sql.table("growth_order_headers")}
        ORDER BY id
      `),
      this.provider.query(`
        SELECT id,order_header_id,source_line_key
        FROM ${this.sql.table("growth_order_lines")}
        ORDER BY id
      `),
    ]);
    return { headers: headers.rows, lines: lines.rows };
  }

  async inventorySnapshotSummary() {
    const batch = await this.provider.query(`
      SELECT id,source_filename,collected_at,imported_at,row_count
      FROM ${this.sql.table("growth_source_batches")}
      WHERE source_type='mabang_inventory' AND status='applied'
      ORDER BY COALESCE(collected_at,imported_at,created_at) DESC LIMIT 1
    `);
    const current = batch.rows[0];
    if (!current) return { batch: null, rowCount: 0, skuCount: 0, availableQuantity: 0, inTransitQuantity: 0 };
    const result = await this.provider.query(`
      SELECT COUNT(*) AS row_count,
             COUNT(DISTINCT normalized_source_sku) AS sku_count,
             COALESCE(SUM(available_quantity),0) AS available_quantity,
             COALESCE(SUM(in_transit_quantity),0) AS in_transit_quantity
      FROM ${this.sql.table("growth_inventory_snapshots")}
      WHERE batch_id=${this.sql.placeholder(1)}
    `, [current.id]);
    const row = result.rows[0] || {};
    return {
      batch: {
        ...current,
        collected_at: current.collected_at instanceof Date ? current.collected_at.toISOString() : current.collected_at,
        imported_at: current.imported_at instanceof Date ? current.imported_at.toISOString() : current.imported_at,
      },
      rowCount: Number(row.row_count || 0),
      skuCount: Number(row.sku_count || 0),
      availableQuantity: Number(row.available_quantity || 0),
      inTransitQuantity: Number(row.in_transit_quantity || 0),
    };
  }

  async currentOrderRows({ dateFrom = null, dateToExclusive = null } = {}) {
    const placeholders = this.sql.placeholders(VALID_ORDER_STATUSES.length).join(", ");
    const conditions = [];
    const params = [...VALID_ORDER_STATUSES];
    if (dateFrom) {
      conditions.push(`h.paid_at >= ${this.sql.placeholder(params.length + 1)}`);
      params.push(dateFrom);
    }
    if (dateToExclusive) {
      conditions.push(`h.paid_at < ${this.sql.placeholder(params.length + 1)}`);
      params.push(dateToExclusive);
    }
    const result = await this.provider.query(`
      SELECT l.id AS order_line_id, l.source_sku, l.normalized_source_sku, l.quantity, l.line_amount,
             l.line_amount_status, l.product_name,
             l.source_warehouse_name, l.normalized_source_warehouse_name,
             h.id AS order_header_id, h.source_order_id, h.order_status, h.paid_at, h.platform,
             h.source_shop_name, h.order_currency, h.order_amount,
             h.order_amount_source_field, r.raw_values_json
      FROM ${this.sql.table("growth_order_lines")} l
      JOIN ${this.sql.table("growth_order_headers")} h ON h.id = l.order_header_id
      LEFT JOIN ${this.sql.table("growth_order_raw_rows")} r
        ON r.batch_id = l.source_batch_id AND r.source_row_number = l.source_row_number
      WHERE l.is_current = 1
        AND h.order_status IN (${placeholders})
        ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
      ORDER BY h.paid_at, h.source_order_id, l.source_row_number
    `, params);
    return result.rows.map(orderRow);
  }

  async sourceRows(source, { page = 1, pageSize = 50 } = {}) {
    const limit = Math.max(1, Math.min(Number(pageSize) || 50, 100));
    const offset = (Math.max(1, Number(page) || 1) - 1) * limit;

    if (source === "orders") {
      const placeholders = this.sql.placeholders(VALID_ORDER_STATUSES.length).join(", ");
      const count = await this.provider.query(`
        SELECT COUNT(*) AS total
        FROM ${this.sql.table("growth_order_lines")} l
        JOIN ${this.sql.table("growth_order_headers")} h ON h.id = l.order_header_id
        WHERE l.is_current = 1 AND h.order_status IN (${placeholders})
      `, VALID_ORDER_STATUSES);
      const result = await this.provider.query(`
        SELECT h.source_order_id, h.paid_at, h.source_shop_name, h.platform, h.order_status,
               h.order_currency, l.source_sku, l.quantity, l.line_amount,
               l.line_amount_status, l.product_name, l.source_warehouse_name,
               r.raw_values_json
        FROM ${this.sql.table("growth_order_lines")} l
        JOIN ${this.sql.table("growth_order_headers")} h ON h.id = l.order_header_id
        LEFT JOIN ${this.sql.table("growth_order_raw_rows")} r
          ON r.batch_id = l.source_batch_id AND r.source_row_number = l.source_row_number
        WHERE l.is_current = 1 AND h.order_status IN (${placeholders})
        ORDER BY (h.paid_at IS NULL),h.paid_at DESC,h.source_order_id,l.source_row_number
        LIMIT ${this.sql.placeholder(VALID_ORDER_STATUSES.length + 1)}
        OFFSET ${this.sql.placeholder(VALID_ORDER_STATUSES.length + 2)}
      `, [...VALID_ORDER_STATUSES, limit, offset]);
      return { total: Number(count.rows[0]?.total || 0), rows: result.rows.map(orderRow) };
    }

    if (source === "inventory") {
      const batch = await this.provider.query(`
        SELECT id FROM ${this.sql.table("growth_source_batches")}
        WHERE source_type = 'mabang_inventory' AND status = 'applied'
        ORDER BY COALESCE(collected_at, imported_at, created_at) DESC
        LIMIT 1
      `);
      const batchId = batch.rows[0]?.id;
      if (!batchId) return { total: 0, rows: [] };
      const count = await this.provider.query(
        `SELECT COUNT(*) AS total FROM ${this.sql.table("growth_inventory_snapshots")}
         WHERE batch_id = ${this.sql.placeholder(1)}`,
        [batchId],
      );
      const result = await this.provider.query(`
        SELECT i.*, r.raw_values_json
        FROM ${this.sql.table("growth_inventory_snapshots")} i
        LEFT JOIN ${this.sql.table("growth_inventory_raw_rows")} r
          ON r.batch_id = i.batch_id AND r.source_row_number = i.source_row_number
        WHERE i.batch_id = ${this.sql.placeholder(1)}
        ORDER BY i.source_row_number
        LIMIT ${this.sql.placeholder(2)} OFFSET ${this.sql.placeholder(3)}
      `, [batchId, limit, offset]);
      return { total: Number(count.rows[0]?.total || 0), rows: result.rows.map(inventoryRow) };
    }

    const count = await this.provider.query(`
      SELECT COUNT(*) AS total FROM ${this.sql.table("product_package_rows")}
      WHERE source_system = ${this.sql.placeholder(1)}
    `, [PRODUCT_PACKAGE_SOURCE_SYSTEM]);
    const result = await this.provider.query(`
      SELECT source_row_key, country_normalized, sku_normalized, warehouse_normalized,
             normalized_payload_json
      FROM ${this.sql.table("product_package_rows")}
      WHERE source_system = ${this.sql.placeholder(1)}
      ORDER BY source_row_key
      LIMIT ${this.sql.placeholder(2)} OFFSET ${this.sql.placeholder(3)}
    `, [PRODUCT_PACKAGE_SOURCE_SYSTEM, limit, offset]);
    return { total: Number(count.rows[0]?.total || 0), rows: result.rows };
  }
}
