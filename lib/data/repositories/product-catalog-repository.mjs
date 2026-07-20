import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonValue(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function serializeProduct(row) {
  if (!row) return null;
  const lifecycleStatus = row.lifecycle_status || null;
  return {
    id: row.id,
    sku: row.source_sku,
    normalizedSku: row.normalized_sku,
    productName: row.source_product_name,
    mainSku: row.source_main_sku || null,
    styleCode: row.source_style_code || null,
    styleName: row.source_style_name || null,
    salesSpec: row.source_sales_spec || null,
    sourceStatus: row.source_status_raw,
    lifecycleStatus,
    lifecycleReasonCode: row.lifecycle_reason_code || null,
    categoryL1: row.category_l1 || null,
    categoryL2: row.category_l2 || null,
    warehouse: row.warehouse_raw || null,
    stock: numberOrNull(row.warehouse_stock),
    country: row.country_raw || null,
    costCny: numberOrNull(row.cost_cny),
    exchangeRate: numberOrNull(row.exchange_rate),
    costLocal: numberOrNull(row.cost_local),
    sourcePeriod: row.source_period || null,
    sourceFilename: row.source_filename || null,
    lastBatchId: row.last_seen_batch_id,
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at,
    operationalEligible: Boolean(row.source_main_sku)
      && new Set(["ACTIVE", "NEW", "CLEARANCE"]).has(lifecycleStatus),
    image: { status: "not_integrated", count: null },
    aiContentStatus: "not_integrated",
    listingReadiness: "not_evaluated",
  };
}

export class ProductCatalogRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) {
    return `${this.prefix}${name}`;
  }

  placeholders(client, count, offset = 0) {
    return Array.from({ length: count }, (_, index) => client.placeholder(offset + index + 1));
  }

  baseSelect() {
    return `SELECT
      s.id,s.source_sku,s.normalized_sku,s.source_product_name,s.source_main_sku,s.source_style_code,
      s.source_style_name,s.source_sales_spec,s.source_status_raw,s.last_seen_batch_id,s.revision,s.updated_at,
      c2.source_name category_l2,c1.source_name category_l1,
      l.status_code lifecycle_status,l.reason_code lifecycle_reason_code,
      b.source_period,
      (SELECT ef.original_filename FROM ${this.table("product_import_files")} pf
        JOIN ${this.table("export_files")} ef ON ef.id=pf.export_file_id
        WHERE pf.batch_id=s.last_seen_batch_id AND pf.file_role='source' LIMIT 1) source_filename,
      (SELECT i.warehouse_raw FROM ${this.table("product_inventory_snapshots")} i
        WHERE i.sku_id=s.id ORDER BY i.captured_at DESC,i.id DESC LIMIT 1) warehouse_raw,
      (SELECT i.warehouse_stock FROM ${this.table("product_inventory_snapshots")} i
        WHERE i.sku_id=s.id ORDER BY i.captured_at DESC,i.id DESC LIMIT 1) warehouse_stock,
      (SELECT c.country_raw FROM ${this.table("product_cost_snapshots")} c
        WHERE c.sku_id=s.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) country_raw,
      (SELECT c.cost_cny FROM ${this.table("product_cost_snapshots")} c
        WHERE c.sku_id=s.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) cost_cny,
      (SELECT c.exchange_rate FROM ${this.table("product_cost_snapshots")} c
        WHERE c.sku_id=s.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) exchange_rate,
      (SELECT c.cost_local FROM ${this.table("product_cost_snapshots")} c
        WHERE c.sku_id=s.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) cost_local
      FROM ${this.table("product_skus")} s
      JOIN ${this.table("product_categories")} c2 ON c2.id=s.category_id
      LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
      LEFT JOIN ${this.table("product_sku_lifecycle")} l ON l.sku_id=s.id
      LEFT JOIN ${this.table("product_import_batches")} b ON b.id=s.last_seen_batch_id`;
  }

  buildFilters(input = {}) {
    const clauses = ["s.archived_at IS NULL"];
    const values = [];
    const add = (sql, value) => {
      values.push(value);
      clauses.push(sql.replace("$P", this.provider.placeholder(values.length)));
    };
    const keyword = String(input.keyword || "").trim();
    if (keyword) {
      const value = `%${keyword.toLocaleLowerCase("zh-CN")}%`;
      const fields = [
        "s.normalized_sku",
        "COALESCE(s.source_main_sku,'')",
        "COALESCE(s.source_style_code,'')",
        "COALESCE(s.source_style_name,'')",
        "s.source_product_name",
      ];
      const keywordClauses = fields.map((field) => {
        values.push(value);
        return `LOWER(${field}) LIKE ${this.provider.placeholder(values.length)}`;
      });
      clauses.push(`(${keywordClauses.join(" OR ")})`);
    }
    if (input.categoryL1) add("c1.source_name=$P", String(input.categoryL1));
    if (input.categoryL2) add("c2.source_name=$P", String(input.categoryL2));
    if (input.lifecycleStatus) add("l.status_code=$P", String(input.lifecycleStatus).toUpperCase());
    if (input.warehouse) {
      values.push(String(input.warehouse));
      const p = this.provider.placeholder(values.length);
      clauses.push(`EXISTS (SELECT 1 FROM ${this.table("product_inventory_snapshots")} iw
        WHERE iw.sku_id=s.id AND iw.batch_id=s.last_seen_batch_id AND iw.warehouse_raw=${p})`);
    }
    return { where: clauses.join(" AND "), values };
  }

  async list(input = {}) {
    const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(Number.parseInt(input.pageSize, 10) || 30, 100));
    const { where, values } = this.buildFilters(input);
    const totalResult = await this.provider.query(`SELECT count(*) total
      FROM ${this.table("product_skus")} s
      JOIN ${this.table("product_categories")} c2 ON c2.id=s.category_id
      LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
      LEFT JOIN ${this.table("product_sku_lifecycle")} l ON l.sku_id=s.id
      WHERE ${where}`, values);
    const sortColumns = Object.freeze({
      sku: "s.normalized_sku",
      name: "s.source_product_name",
      updated_at: "s.updated_at",
    });
    const sortColumn = sortColumns[input.sortBy] || sortColumns.updated_at;
    const sortDirection = String(input.sortDirection || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const p = this.placeholders(this.provider, 2, values.length);
    const result = await this.provider.query(`${this.baseSelect()}
      WHERE ${where} ORDER BY ${sortColumn} ${sortDirection},s.id ${sortDirection}
      LIMIT ${p[0]} OFFSET ${p[1]}`, [...values, pageSize, (page - 1) * pageSize]);
    const total = Number(totalResult.rows[0]?.total || 0);
    return {
      products: result.rows.map(serializeProduct),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async get(id) {
    const p = this.provider.placeholder(1);
    const result = await this.provider.query(`${this.baseSelect()} WHERE s.id=${p} LIMIT 1`, [id]);
    const product = serializeProduct(result.rows[0]);
    if (!product) return null;
    const [source, packaging, costs, inventories, lifecycleEvents] = await Promise.all([
      this.provider.query(`SELECT source_row_number,normalized_payload_json FROM ${this.table("product_import_rows")}
        WHERE id=(SELECT current_source_row_id FROM ${this.table("product_skus")} WHERE id=${p})`, [id]),
      this.provider.query(`SELECT * FROM ${this.table("product_packaging_profiles")} WHERE sku_id=${p}`, [id]),
      this.provider.query(`SELECT country_raw,cost_cny,exchange_rate,exchange_direction,cost_local,
        price_tier_20,price_tier_25,price_tier_35,price_tier_45,attach_rate,created_at,batch_id
        FROM ${this.table("product_cost_snapshots")} WHERE sku_id=${p} ORDER BY created_at DESC`, [id]),
      this.provider.query(`SELECT warehouse_raw,warehouse_stock,planned_warehouse_raw,captured_at,batch_id
        FROM ${this.table("product_inventory_snapshots")} WHERE sku_id=${p} ORDER BY captured_at DESC`, [id]),
      this.provider.query(`SELECT from_status_code,to_status_code,decision_source,reason_code,occurred_at,source_batch_id
        FROM ${this.table("product_sku_lifecycle_events")} WHERE sku_id=${p} ORDER BY occurred_at DESC`, [id]),
    ]);
    return {
      ...product,
      sourceRowNumber: source.rows[0] ? Number(source.rows[0].source_row_number) : null,
      sourceFacts: jsonValue(source.rows[0]?.normalized_payload_json, {}),
      packaging: packaging.rows[0] ? {
        itemDimensions: packaging.rows[0].item_dimensions_raw || null,
        itemNetWeightG: numberOrNull(packaging.rows[0].item_net_weight_g),
        itemGrossWeightG: numberOrNull(packaging.rows[0].item_gross_weight_g),
        cartonLengthCm: numberOrNull(packaging.rows[0].carton_length_cm),
        cartonWidthCm: numberOrNull(packaging.rows[0].carton_width_cm),
        cartonHeightCm: numberOrNull(packaging.rows[0].carton_height_cm),
        cartonQuantity: numberOrNull(packaging.rows[0].carton_quantity),
        shippingMethod: packaging.rows[0].shipping_method || null,
      } : null,
      costHistory: costs.rows.map((row) => ({
        batchId: row.batch_id,
        country: row.country_raw || null,
        costCny: numberOrNull(row.cost_cny),
        exchangeRate: numberOrNull(row.exchange_rate),
        exchangeDirection: row.exchange_direction,
        costLocal: numberOrNull(row.cost_local),
        priceTier20: numberOrNull(row.price_tier_20),
        priceTier25: numberOrNull(row.price_tier_25),
        priceTier35: numberOrNull(row.price_tier_35),
        priceTier45: numberOrNull(row.price_tier_45),
        attachRate: numberOrNull(row.attach_rate),
        createdAt: row.created_at,
      })),
      inventories: inventories.rows.map((row) => ({
        batchId: row.batch_id,
        warehouse: row.warehouse_raw,
        stock: numberOrNull(row.warehouse_stock),
        plannedWarehouse: row.planned_warehouse_raw || null,
        capturedAt: row.captured_at,
      })),
      lifecycleEvents: lifecycleEvents.rows.map((row) => ({
        fromStatus: row.from_status_code || null,
        toStatus: row.to_status_code,
        decisionSource: row.decision_source,
        reasonCode: row.reason_code,
        batchId: row.source_batch_id,
        occurredAt: row.occurred_at,
      })),
    };
  }

  async filters() {
    const [categories, lifecycle, warehouses] = await Promise.all([
      this.provider.query(`SELECT c1.source_name category_l1,c2.source_name category_l2
        FROM ${this.table("product_categories")} c2
        LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
        WHERE c2.level=2 AND c2.status='active' ORDER BY c1.source_name,c2.source_name`),
      this.provider.query(`SELECT DISTINCT status_code FROM ${this.table("product_sku_lifecycle")} ORDER BY status_code`),
      this.provider.query(`SELECT DISTINCT warehouse_raw FROM ${this.table("product_inventory_snapshots")}
        WHERE warehouse_raw IS NOT NULL AND warehouse_raw<>'' ORDER BY warehouse_raw`),
    ]);
    return {
      categories: categories.rows.map((row) => ({ categoryL1: row.category_l1, categoryL2: row.category_l2 })),
      lifecycleStatuses: lifecycle.rows.map((row) => row.status_code),
      warehouses: warehouses.rows.map((row) => row.warehouse_raw),
    };
  }
}
