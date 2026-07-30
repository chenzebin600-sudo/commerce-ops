import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";
import { MABANG_NON_PRODUCT_IMAGE_FILENAMES } from "../../mabang-images/extraction.mjs";

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

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function productImageAssetPredicate(alias) {
  const filenames = MABANG_NON_PRODUCT_IMAGE_FILENAMES.map((filename) => `'${filename}'`).join(",");
  return `LOWER(COALESCE(${alias}.original_filename,'')) NOT IN (${filenames})
    AND LOWER(COALESCE(${alias}.source_url,'')) NOT LIKE 'https://global.mabangerp.com/image/icon%'`;
}

function serializeProduct(row) {
  if (!row) return null;
  const lifecycleStatus = row.lifecycle_status || null;
  return {
    id: row.id,
    sku: row.source_sku,
    normalizedSku: row.sku_code_normalized || row.source_sku,
    country: row.country_raw || null,
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
    sourcePeriod: row.source_period || null,
    sourceFilename: row.source_filename || null,
    lastBatchId: row.last_seen_batch_id,
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    deletedBy: row.deleted_by || null,
    deleteReason: row.delete_reason || null,
    restoredAt: row.restored_at || null,
    restoredBy: row.restored_by || null,
    operationalEligible: new Set(["ACTIVE", "NEW", "CLEARANCE"]).has(lifecycleStatus),
    image: {
      status: Number(row.image_count || 0) > 0 ? "available" : "missing",
      count: Number(row.image_count || 0),
      primaryImageId: row.primary_image_id || null,
      mabangCount: Number(row.mabang_image_count || 0),
      mabangAssetId: row.mabang_image_asset_id || null,
    },
    manualOverrideCount: Number(row.manual_override_count || 0),
    aiContentCount: Number(row.ai_content_count || 0),
    aiContentStatus: Number(row.confirmed_ai_count || 0) > 0
      ? "confirmed"
      : Number(row.ai_content_count || 0) > 0 ? "draft" : "not_generated",
    listingReadiness: "not_evaluated",
  };
}

function overrideMap(rows) {
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.sku_id)) result.set(row.sku_id, {});
    result.get(row.sku_id)[row.field_code] = jsonValue(row.value_json, null);
  }
  return result;
}

function applyOverrides(product, values = {}) {
  const mapping = {
    product_name: "productName", main_sku_code: "mainSku", style_code: "styleCode", style_name: "styleName",
    sales_spec: "salesSpec", category_l1: "categoryL1", category_l2: "categoryL2",
  };
  const result = { ...product, manualOverrides: values };
  for (const [field, property] of Object.entries(mapping)) {
    if (Object.hasOwn(values, field)) result[property] = values[field];
  }
  return result;
}

function serializeImage(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.sku_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size || 0),
    isPrimary: Boolean(Number(row.is_primary || 0)),
    sortOrder: Number(row.sort_order || 0),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
      s.id,s.source_sku,s.normalized_sku,s.sku_code_normalized,s.country_raw,s.source_product_name,s.source_main_sku,
      s.source_style_code,s.source_style_name,s.source_sales_spec,s.source_status_raw,s.last_seen_batch_id,s.revision,s.updated_at,
      s.deleted_at,s.deleted_by,s.delete_reason,s.restored_at,s.restored_by,
      c2.source_name category_l2,c1.source_name category_l1,
      l.status_code lifecycle_status,l.reason_code lifecycle_reason_code,b.source_period,
      (SELECT ef.original_filename FROM ${this.table("product_import_files")} pf
        JOIN ${this.table("export_files")} ef ON ef.id=pf.export_file_id
        WHERE pf.batch_id=s.last_seen_batch_id AND pf.file_role='source' LIMIT 1) source_filename,
      ((SELECT count(*) FROM ${this.table("product_images")} pi WHERE pi.sku_id=s.id AND pi.status='available')
        + (SELECT count(*) FROM ${this.table("product_media_links")} pml JOIN ${this.table("product_media_assets")} pma ON pma.id=pml.asset_id
          WHERE pml.product_id=s.id AND pml.mapping_status IN ('suggested','confirmed') AND pma.status='available'
            AND ${productImageAssetPredicate("pma")})) image_count,
      (SELECT count(*) FROM ${this.table("product_media_links")} pml JOIN ${this.table("product_media_assets")} pma ON pma.id=pml.asset_id
        WHERE pml.product_id=s.id AND pml.mapping_status IN ('suggested','confirmed') AND pma.status='available'
          AND ${productImageAssetPredicate("pma")}) mabang_image_count,
      (SELECT pi.id FROM ${this.table("product_images")} pi WHERE pi.sku_id=s.id AND pi.status='available'
        ORDER BY pi.is_primary DESC,pi.sort_order,pi.created_at LIMIT 1) primary_image_id,
      (SELECT pml.asset_id FROM ${this.table("product_media_links")} pml
        JOIN ${this.table("product_media_assets")} pma ON pma.id=pml.asset_id
        WHERE pml.product_id=s.id AND pml.mapping_status IN ('suggested','confirmed') AND pma.status='available'
          AND ${productImageAssetPredicate("pma")}
        ORDER BY CASE pml.mapping_status WHEN 'confirmed' THEN 0 ELSE 1 END,
          CASE pml.media_role WHEN 'primary' THEN 0 WHEN 'suggested_primary' THEN 1 ELSE 2 END,pml.linked_at
        LIMIT 1) mabang_image_asset_id,
      (SELECT count(*) FROM ${this.table("product_field_overrides")} po
        WHERE po.sku_id=s.id AND po.deleted_at IS NULL) manual_override_count,
      (SELECT count(*) FROM ${this.table("product_ai_contents")} pac WHERE pac.product_sku_id=s.id) ai_content_count,
      (SELECT count(*) FROM ${this.table("product_ai_contents")} pac
        WHERE pac.product_sku_id=s.id AND pac.status='confirmed') confirmed_ai_count
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
        "s.sku_code_normalized", "COALESCE(s.source_main_sku,'')", "COALESCE(s.source_style_code,'')",
        "COALESCE(s.source_style_name,'')", "s.source_product_name",
      ];
      const keywordClauses = fields.map((field) => {
        values.push(value);
        return `LOWER(${field}) LIKE ${this.provider.placeholder(values.length)}`;
      });
      values.push(value);
      keywordClauses.push(`EXISTS (SELECT 1 FROM ${this.table("product_field_overrides")} po
        WHERE po.sku_id=s.id AND po.deleted_at IS NULL AND LOWER(CAST(po.value_json AS TEXT)) LIKE ${this.provider.placeholder(values.length)})`);
      clauses.push(`(${keywordClauses.join(" OR ")})`);
    }
    if (input.country) add("s.country_raw=$P", String(input.country));
    if (input.categoryL1) add("c1.source_name=$P", String(input.categoryL1));
    if (input.categoryL2) add("c2.source_name=$P", String(input.categoryL2));
    if (input.lifecycleStatus) add("l.status_code=$P", String(input.lifecycleStatus).toUpperCase());
    if (input.warehouse) {
      values.push(String(input.warehouse));
      clauses.push(`EXISTS (SELECT 1 FROM ${this.table("product_inventory_snapshots")} iw
        WHERE iw.sku_id=s.id AND iw.batch_id=s.last_seen_batch_id AND iw.warehouse_raw=${this.provider.placeholder(values.length)})`);
    }
    const deleted = String(input.deleted || "active").toLowerCase();
    if (deleted === "deleted") clauses.push("s.deleted_at IS NOT NULL");
    else if (deleted !== "all") clauses.push("s.deleted_at IS NULL");

    const addScope = (column, scopedValues) => {
      const allowed = [...new Set((scopedValues || []).map((item) => String(item).trim()).filter(Boolean))];
      if (!allowed.length) return;
      const placeholders = allowed.map((value) => {
        values.push(value);
        return this.provider.placeholder(values.length);
      });
      clauses.push(`${column} IN (${placeholders.join(",")})`);
    };
    addScope("s.country_raw", input.accessScope?.countries);
    addScope("c1.source_name", input.accessScope?.categoryL1);
    addScope("c2.source_name", input.accessScope?.categoryL2);
    return { where: clauses.join(" AND "), values };
  }

  async loadOverrides(productIds) {
    const ids = [...new Set(productIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const result = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const p = this.placeholders(this.provider, chunk.length);
      const rows = await this.provider.query(`SELECT sku_id,field_code,value_json FROM ${this.table("product_field_overrides")}
        WHERE deleted_at IS NULL AND sku_id IN (${p.join(",")})`, chunk);
      result.push(...rows.rows);
    }
    return overrideMap(result);
  }

  async list(input = {}) {
    const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(Number.parseInt(input.pageSize, 10) || 30, 100));
    const { where, values } = this.buildFilters(input);
    const totalResult = await this.provider.query(`SELECT count(*) total
      FROM ${this.table("product_skus")} s
      JOIN ${this.table("product_categories")} c2 ON c2.id=s.category_id
      LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
      LEFT JOIN ${this.table("product_sku_lifecycle")} l ON l.sku_id=s.id WHERE ${where}`, values);
    const sortColumns = Object.freeze({ sku: "s.sku_code_normalized", name: "s.source_product_name", updated_at: "s.updated_at" });
    const sortColumn = sortColumns[input.sortBy] || sortColumns.updated_at;
    const sortDirection = String(input.sortDirection || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const p = this.placeholders(this.provider, 2, values.length);
    const result = await this.provider.query(`${this.baseSelect()} WHERE ${where}
      ORDER BY ${sortColumn} ${sortDirection},s.id ${sortDirection} LIMIT ${p[0]} OFFSET ${p[1]}`,
    [...values, pageSize, (page - 1) * pageSize]);
    const products = result.rows.map(serializeProduct);
    const overrides = await this.loadOverrides(products.map((item) => item.id));
    const total = Number(totalResult.rows[0]?.total || 0);
    return {
      products: products.map((item) => applyOverrides(item, overrides.get(item.id))),
      total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async listModels(input = {}) {
    const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(Number.parseInt(input.pageSize, 10) || 12, 30));
    const clauses = [
      "s.archived_at IS NULL",
      "s.deleted_at IS NULL",
      "s.model_id IS NOT NULL",
    ];
    const values = [];
    const add = (sql, value) => {
      values.push(value);
      clauses.push(sql.replace("$P", this.provider.placeholder(values.length)));
    };
    const keyword = String(input.keyword || "").trim();
    if (keyword) {
      const pattern = `%${keyword.toLocaleLowerCase("zh-CN")}%`;
      const fields = [
        "s.sku_code_normalized",
        "COALESCE(s.source_main_sku,'')",
        "COALESCE(s.source_style_code,'')",
        "COALESCE(s.source_style_name,'')",
        "s.source_product_name",
        "COALESCE(m.canonical_name,'')",
      ];
      clauses.push(`(${fields.map((field) => {
        values.push(pattern);
        return `LOWER(${field}) LIKE ${this.provider.placeholder(values.length)}`;
      }).join(" OR ")})`);
    }
    if (input.country) add("s.country_raw=$P", String(input.country));
    const addScope = (column, scopedValues) => {
      const allowed = [...new Set((scopedValues || []).map(String).map((item) => item.trim()).filter(Boolean))];
      if (!allowed.length) return;
      const placeholders = allowed.map((value) => {
        values.push(value);
        return this.provider.placeholder(values.length);
      });
      clauses.push(`${column} IN (${placeholders.join(",")})`);
    };
    addScope("s.country_raw", input.accessScope?.countries);
    addScope("c1.source_name", input.accessScope?.categoryL1);
    addScope("c2.source_name", input.accessScope?.categoryL2);
    const where = clauses.join(" AND ");
    const totalResult = await this.provider.query(`SELECT count(DISTINCT s.model_id) total
      FROM ${this.table("product_skus")} s
      JOIN ${this.table("product_models")} m ON m.id=s.model_id
      JOIN ${this.table("product_categories")} c2 ON c2.id=s.category_id
      LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
      WHERE ${where}`, values);
    const paging = this.placeholders(this.provider, 2, values.length);
    const modelResult = await this.provider.query(`SELECT
        m.id,m.source_main_sku,m.canonical_name,
        MIN(COALESCE(s.source_style_name,s.source_product_name)) display_name,
        MIN(c1.source_name) category_l1,MIN(c2.source_name) category_l2,
        count(*) variant_count,count(DISTINCT s.country_raw) country_count,
        MAX(s.updated_at) updated_at
      FROM ${this.table("product_skus")} s
      JOIN ${this.table("product_models")} m ON m.id=s.model_id
      JOIN ${this.table("product_categories")} c2 ON c2.id=s.category_id
      LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
      WHERE ${where}
      GROUP BY m.id,m.source_main_sku,m.canonical_name
      ORDER BY MAX(s.updated_at) DESC,m.id
      LIMIT ${paging[0]} OFFSET ${paging[1]}`,
    [...values, pageSize, (page - 1) * pageSize]);
    const modelIds = modelResult.rows.map((row) => row.id);
    if (!modelIds.length) {
      return {
        models: [],
        total: Number(totalResult.rows[0]?.total || 0),
        page,
        pageSize,
        totalPages: 1,
      };
    }
    const modelPlaceholders = this.placeholders(this.provider, modelIds.length);
    const variantsResult = await this.provider.query(`SELECT
        s.id,s.model_id,s.source_sku,s.sku_code_normalized,s.country_raw,
        s.source_product_name,s.source_main_sku,s.source_style_code,
        s.source_style_name,s.source_sales_spec,s.source_status_raw,s.updated_at,
        c1.source_name category_l1,c2.source_name category_l2,
        lifecycle.status_code lifecycle_status,
        packaging.item_dimensions_raw,packaging.item_net_weight_g,
        packaging.item_gross_weight_g,packaging.carton_length_cm,
        packaging.carton_width_cm,packaging.carton_height_cm,
        (SELECT cost.price_tier_20 FROM ${this.table("product_cost_snapshots")} cost
          WHERE cost.sku_id=s.id ORDER BY cost.created_at DESC LIMIT 1) price_tier_20,
        (SELECT cost.price_tier_25 FROM ${this.table("product_cost_snapshots")} cost
          WHERE cost.sku_id=s.id ORDER BY cost.created_at DESC LIMIT 1) price_tier_25,
        (SELECT cost.price_tier_35 FROM ${this.table("product_cost_snapshots")} cost
          WHERE cost.sku_id=s.id ORDER BY cost.created_at DESC LIMIT 1) price_tier_35,
        (SELECT COALESCE(SUM(inv.warehouse_stock),0) FROM ${this.table("product_inventory_snapshots")} inv
          WHERE inv.sku_id=s.id AND inv.batch_id=s.last_seen_batch_id) stock,
        (SELECT pi.id FROM ${this.table("product_images")} pi
          WHERE pi.sku_id=s.id AND pi.status='available'
          ORDER BY pi.is_primary DESC,pi.sort_order,pi.created_at LIMIT 1) product_image_id,
        (SELECT pma.source_url FROM ${this.table("product_media_links")} pml
          JOIN ${this.table("product_media_assets")} pma ON pma.id=pml.asset_id
          WHERE pml.product_id=s.id AND pml.mapping_status IN ('suggested','confirmed')
            AND pma.status='available' AND ${productImageAssetPredicate("pma")}
            AND COALESCE(pma.source_url,'')<>''
          ORDER BY CASE pml.mapping_status WHEN 'confirmed' THEN 0 ELSE 1 END,
            CASE pml.media_role WHEN 'primary' THEN 0 WHEN 'suggested_primary' THEN 1 ELSE 2 END,
            pml.linked_at LIMIT 1) external_image_url
      FROM ${this.table("product_skus")} s
      JOIN ${this.table("product_categories")} c2 ON c2.id=s.category_id
      LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
      LEFT JOIN ${this.table("product_sku_lifecycle")} lifecycle ON lifecycle.sku_id=s.id
      LEFT JOIN ${this.table("product_packaging_profiles")} packaging ON packaging.sku_id=s.id
      WHERE s.model_id IN (${modelPlaceholders.join(",")})
        AND s.archived_at IS NULL AND s.deleted_at IS NULL
      ORDER BY s.model_id,s.country_raw,s.source_sales_spec,s.source_sku`, modelIds);
    const overrides = await this.loadOverrides(variantsResult.rows.map((row) => row.id));
    const variantsByModel = new Map(modelIds.map((id) => [id, []]));
    for (const row of variantsResult.rows) {
      const product = applyOverrides(serializeProduct({
        ...row,
        image_count: row.product_image_id || row.external_image_url ? 1 : 0,
        primary_image_id: row.product_image_id,
        mabang_image_count: row.external_image_url ? 1 : 0,
        mabang_image_asset_id: null,
        manual_override_count: 0,
        ai_content_count: 0,
        confirmed_ai_count: 0,
      }), overrides.get(row.id));
      variantsByModel.get(row.model_id)?.push({
        productSkuId: row.id,
        sku: product.sku,
        normalizedSku: product.normalizedSku,
        productName: product.productName,
        mainSku: product.mainSku,
        styleCode: product.styleCode,
        styleName: product.styleName,
        salesSpec: product.salesSpec,
        country: product.country,
        categoryL1: product.categoryL1,
        categoryL2: product.categoryL2,
        sourceStatus: product.sourceStatus,
        lifecycleStatus: product.lifecycleStatus,
        stock: numberOrNull(row.stock) || 0,
        priceTier20: numberOrNull(row.price_tier_20),
        priceTier25: numberOrNull(row.price_tier_25),
        priceTier35: numberOrNull(row.price_tier_35),
        weightG: numberOrNull(row.item_gross_weight_g) ?? numberOrNull(row.item_net_weight_g),
        itemDimensions: row.item_dimensions_raw || null,
        packageLengthCm: numberOrNull(row.carton_length_cm),
        packageWidthCm: numberOrNull(row.carton_width_cm),
        packageHeightCm: numberOrNull(row.carton_height_cm),
        productImageId: row.product_image_id || null,
        externalImageUrl: row.external_image_url || null,
        updatedAt: row.updated_at,
      });
    }
    const total = Number(totalResult.rows[0]?.total || 0);
    return {
      models: modelResult.rows.map((row) => ({
        id: row.id,
        mainSku: row.source_main_sku,
        name: row.canonical_name || row.display_name || row.source_main_sku,
        categoryL1: row.category_l1 || null,
        categoryL2: row.category_l2 || null,
        variantCount: Number(row.variant_count || 0),
        countryCount: Number(row.country_count || 0),
        updatedAt: row.updated_at,
        variants: variantsByModel.get(row.id) || [],
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async get(id) {
    const p = this.provider.placeholder(1);
    const result = await this.provider.query(`${this.baseSelect()} WHERE s.id=${p} LIMIT 1`, [id]);
    const base = serializeProduct(result.rows[0]);
    if (!base) return null;
    const [source, packaging, costs, inventories, lifecycleEvents, images, mabangImages, overrides, overrideEvents] = await Promise.all([
      this.provider.query(`SELECT source_row_number,raw_payload_json,normalized_payload_json FROM ${this.table("product_import_rows")}
        WHERE id=(SELECT current_source_row_id FROM ${this.table("product_skus")} WHERE id=${p})`, [id]),
      this.provider.query(`SELECT * FROM ${this.table("product_packaging_profiles")} WHERE sku_id=${p}`, [id]),
      this.provider.query(`SELECT country_raw,cost_cny,exchange_rate,exchange_direction,cost_local,
        price_tier_20,price_tier_25,price_tier_35,price_tier_45,attach_rate,created_at,batch_id
        FROM ${this.table("product_cost_snapshots")} WHERE sku_id=${p} ORDER BY created_at DESC`, [id]),
      this.provider.query(`SELECT warehouse_raw,warehouse_stock,planned_warehouse_raw,captured_at,batch_id
        FROM ${this.table("product_inventory_snapshots")} WHERE sku_id=${p} ORDER BY captured_at DESC,warehouse_raw`, [id]),
      this.provider.query(`SELECT from_status_code,to_status_code,decision_source,reason_code,occurred_at,source_batch_id
        FROM ${this.table("product_sku_lifecycle_events")} WHERE sku_id=${p} ORDER BY occurred_at DESC`, [id]),
      this.provider.query(`SELECT * FROM ${this.table("product_images")} WHERE sku_id=${p} AND status='available'
        ORDER BY is_primary DESC,sort_order,created_at`, [id]),
      this.provider.query(`SELECT l.id link_id,l.asset_id,l.source_sku,l.country_code,l.media_role,l.mapping_status,l.linked_at,
        a.original_filename,a.mime_type,a.width,a.height,a.file_size,a.sha256,a.source_system
        FROM ${this.table("product_media_links")} l JOIN ${this.table("product_media_assets")} a ON a.id=l.asset_id
        WHERE l.product_id=${p} AND l.mapping_status IN ('suggested','confirmed') AND a.status='available'
          AND ${productImageAssetPredicate("a")}
        ORDER BY CASE l.media_role WHEN 'primary' THEN 0 WHEN 'suggested_primary' THEN 1 ELSE 2 END,l.linked_at`, [id]),
      this.provider.query(`SELECT sku_id,field_code,value_json FROM ${this.table("product_field_overrides")}
        WHERE sku_id=${p} AND deleted_at IS NULL`, [id]),
      this.provider.query(`SELECT field_code,previous_value_json,next_value_json,operator_label,occurred_at
        FROM ${this.table("product_field_override_events")} WHERE sku_id=${p} ORDER BY occurred_at DESC LIMIT 100`, [id]),
    ]);
    const manualOverrides = overrideMap(overrides.rows).get(id) || {};
    const product = applyOverrides(base, manualOverrides);
    return {
      ...product,
      sourceRowNumber: source.rows[0] ? Number(source.rows[0].source_row_number) : null,
      sourceFacts: jsonValue(source.rows[0]?.normalized_payload_json, {}),
      sourceUnknownFields: jsonValue(source.rows[0]?.raw_payload_json, {}),
      manualOverrides,
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
        batchId: row.batch_id, country: row.country_raw || null, costCny: numberOrNull(row.cost_cny),
        exchangeRate: numberOrNull(row.exchange_rate), exchangeDirection: row.exchange_direction,
        costLocal: numberOrNull(row.cost_local), priceTier20: numberOrNull(row.price_tier_20),
        priceTier25: numberOrNull(row.price_tier_25), priceTier35: numberOrNull(row.price_tier_35),
        priceTier45: numberOrNull(row.price_tier_45), attachRate: numberOrNull(row.attach_rate), createdAt: row.created_at,
      })),
      inventories: inventories.rows.map((row) => ({
        batchId: row.batch_id, warehouse: row.warehouse_raw, stock: numberOrNull(row.warehouse_stock),
        plannedWarehouse: row.planned_warehouse_raw || null, capturedAt: row.captured_at,
      })),
      lifecycleEvents: lifecycleEvents.rows.map((row) => ({
        fromStatus: row.from_status_code || null, toStatus: row.to_status_code, decisionSource: row.decision_source,
        reasonCode: row.reason_code, batchId: row.source_batch_id, occurredAt: row.occurred_at,
      })),
      images: images.rows.map(serializeImage),
      mabangImages: mabangImages.rows.map((row) => ({
        linkId: row.link_id, assetId: row.asset_id, sourceSku: row.source_sku, countryCode: row.country_code || null,
        sourceSystem: row.source_system, originalFilename: row.original_filename, mimeType: row.mime_type,
        width: Number(row.width), height: Number(row.height), fileSize: Number(row.file_size), sha256: row.sha256,
        mediaRole: row.media_role, mappingStatus: row.mapping_status, linkedAt: row.linked_at,
        isPrimary: row.media_role === "primary" && row.mapping_status === "confirmed",
      })),
      overrideEvents: overrideEvents.rows.map((row) => ({
        fieldCode: row.field_code, previousValue: jsonValue(row.previous_value_json, null),
        nextValue: jsonValue(row.next_value_json, null), operatorLabel: row.operator_label, occurredAt: row.occurred_at,
      })),
    };
  }

  async filters(accessScope = {}) {
    const scoped = (column, values = []) => {
      const allowed = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
      if (!allowed.length) return { sql: "", values: [] };
      const placeholders = allowed.map((_, index) => this.provider.placeholder(index + 1));
      return { sql: ` AND ${column} IN (${placeholders.join(",")})`, values: allowed };
    };
    const countryScope = scoped("country_raw", accessScope.countries);
    const categoryL1Scope = scoped("c1.source_name", accessScope.categoryL1);
    const categoryL2Scope = scoped("c2.source_name", accessScope.categoryL2);
    const categoryWhere = `${categoryL1Scope.sql}${categoryL2Scope.sql}`;
    const categoryValues = [...categoryL1Scope.values, ...categoryL2Scope.values];
    // PostgreSQL placeholders need a shared sequence when both category scopes are present.
    let normalizedCategoryWhere = categoryWhere;
    if (this.provider.dialect === DATABASE_DIALECTS.POSTGRESQL && categoryL1Scope.values.length) {
      const offset = categoryL1Scope.values.length;
      normalizedCategoryWhere = categoryL1Scope.sql + categoryL2Scope.sql.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + offset}`);
    }
    const [categories, lifecycle, warehouses, countries] = await Promise.all([
      this.provider.query(`SELECT c1.source_name category_l1,c2.source_name category_l2 FROM ${this.table("product_categories")} c2
        LEFT JOIN ${this.table("product_categories")} c1 ON c1.id=c2.parent_id
        WHERE c2.level=2 AND c2.status='active'${normalizedCategoryWhere} ORDER BY c1.source_name,c2.source_name`, categoryValues),
      this.provider.query(`SELECT DISTINCT status_code FROM ${this.table("product_sku_lifecycle")} ORDER BY status_code`),
      this.provider.query(`SELECT DISTINCT warehouse_raw FROM ${this.table("product_inventory_snapshots")}
        WHERE warehouse_raw IS NOT NULL AND warehouse_raw<>'' ORDER BY warehouse_raw`),
      this.provider.query(`SELECT DISTINCT country_raw FROM ${this.table("product_skus")}
        WHERE country_raw IS NOT NULL AND country_raw<>''${countryScope.sql} ORDER BY country_raw`, countryScope.values),
    ]);
    return {
      categories: categories.rows.map((row) => ({ categoryL1: row.category_l1, categoryL2: row.category_l2 })),
      lifecycleStatuses: lifecycle.rows.map((row) => row.status_code),
      warehouses: warehouses.rows.map((row) => row.warehouse_raw),
      countries: countries.rows.map((row) => row.country_raw),
    };
  }

  async mappedFieldCodes() {
    const rows = await this.provider.query(`SELECT mapping_json FROM ${this.table("product_import_batches")}
      WHERE status='applied' ORDER BY applied_at DESC,id DESC LIMIT 20`);
    const result = new Set();
    for (const row of rows.rows) {
      for (const item of jsonValue(row.mapping_json, [])) if (item.status === "mapped" && item.systemField) result.add(item.systemField);
    }
    return [...result];
  }

  async getPreference(scopeKey = "global_product_detail") {
    const p = this.provider.placeholder(1);
    const row = (await this.provider.query(`SELECT * FROM ${this.table("product_detail_preferences")} WHERE scope_key=${p}`, [scopeKey])).rows[0];
    return row ? { scopeKey: row.scope_key, visibleFields: jsonValue(row.visible_fields_json, []), revision: Number(row.revision || 1), updatedAt: row.updated_at } : null;
  }

  async savePreference({ scopeKey = "global_product_detail", visibleFields, operatorLabel, requestId }) {
    const now = iso();
    const existing = await this.getPreference(scopeKey);
    if (existing) {
      const p = this.placeholders(this.provider, 5);
      await this.provider.execute(`UPDATE ${this.table("product_detail_preferences")} SET visible_fields_json=${p[0]},revision=revision+1,
        operator_label=${p[1]},request_id=${p[2]},updated_at=${p[3]} WHERE scope_key=${p[4]}`, [JSON.stringify(visibleFields), operatorLabel, requestId, now, scopeKey]);
    } else {
      const p = this.placeholders(this.provider, 7);
      await this.provider.execute(`INSERT INTO ${this.table("product_detail_preferences")} (
        scope_key,visible_fields_json,revision,operator_label,request_id,created_at,updated_at
      ) VALUES (${p.join(",")})`, [scopeKey, JSON.stringify(visibleFields), 1, operatorLabel, requestId, now, now]);
    }
    return this.getPreference(scopeKey);
  }

  async saveOverrides(productId, values, { operatorLabel, requestId } = {}) {
    return this.saveOverrideChanges(productId, { values }, { operatorLabel, requestId });
  }

  async saveOverrideChanges(productId, { values = {}, clearFields = [] } = {}, { operatorLabel, requestId } = {}) {
    const product = await this.get(productId);
    if (!product) return null;
    const now = iso();
    await this.provider.transaction(async (tx) => {
      for (const [fieldCode, value] of Object.entries(values)) {
        const current = product.manualOverrides[fieldCode];
        const existing = await tx.query(`SELECT sku_id FROM ${this.table("product_field_overrides")}
          WHERE sku_id=${tx.placeholder(1)} AND field_code=${tx.placeholder(2)}`, [productId, fieldCode]);
        if (existing.rows[0]) {
          await tx.execute(`UPDATE ${this.table("product_field_overrides")} SET value_json=${tx.placeholder(1)},operator_label=${tx.placeholder(2)},
            request_id=${tx.placeholder(3)},revision=revision+1,updated_at=${tx.placeholder(4)},deleted_at=NULL
            WHERE sku_id=${tx.placeholder(5)} AND field_code=${tx.placeholder(6)}`,
          [JSON.stringify(value), operatorLabel, requestId, now, productId, fieldCode]);
        } else {
          const p = this.placeholders(tx, 9);
          await tx.execute(`INSERT INTO ${this.table("product_field_overrides")} (
            sku_id,field_code,value_json,operator_label,request_id,revision,created_at,updated_at,deleted_at
          ) VALUES (${p.join(",")})`, [productId, fieldCode, JSON.stringify(value), operatorLabel, requestId, 1, now, now, null]);
        }
        const event = this.placeholders(tx, 8);
        await tx.execute(`INSERT INTO ${this.table("product_field_override_events")} (
          id,sku_id,field_code,previous_value_json,next_value_json,operator_label,request_id,occurred_at
        ) VALUES (${event.join(",")})`, [randomUUID(), productId, fieldCode, JSON.stringify(current ?? null), JSON.stringify(value), operatorLabel, requestId, now]);
      }
      for (const fieldCode of clearFields) {
        if (!Object.hasOwn(product.manualOverrides, fieldCode)) continue;
        const current = product.manualOverrides[fieldCode];
        await tx.execute(`UPDATE ${this.table("product_field_overrides")} SET deleted_at=${tx.placeholder(1)},
          operator_label=${tx.placeholder(2)},request_id=${tx.placeholder(3)},revision=revision+1,updated_at=${tx.placeholder(4)}
          WHERE sku_id=${tx.placeholder(5)} AND field_code=${tx.placeholder(6)} AND deleted_at IS NULL`,
        [now, operatorLabel, requestId, now, productId, fieldCode]);
        const event = this.placeholders(tx, 8);
        await tx.execute(`INSERT INTO ${this.table("product_field_override_events")} (
          id,sku_id,field_code,previous_value_json,next_value_json,operator_label,request_id,occurred_at
        ) VALUES (${event.join(",")})`, [randomUUID(), productId, fieldCode, JSON.stringify(current), null, operatorLabel, requestId, now]);
      }
    });
    return this.get(productId);
  }

  async softDelete(productId, { reason, operatorLabel } = {}) {
    const product = await this.get(productId);
    if (!product) return null;
    if (product.deletedAt) return product;
    const now = iso();
    const p = this.placeholders(this.provider, 5);
    await this.provider.execute(`UPDATE ${this.table("product_skus")} SET
      deleted_at=${p[0]},deleted_by=${p[1]},delete_reason=${p[2]},updated_at=${p[3]},revision=revision+1
      WHERE id=${p[4]} AND deleted_at IS NULL`, [now, operatorLabel || "local_session", reason || null, now, productId]);
    return this.get(productId);
  }

  async restore(productId, { operatorLabel } = {}) {
    const product = await this.get(productId);
    if (!product) return null;
    if (!product.deletedAt) return product;
    const now = iso();
    const p = this.placeholders(this.provider, 4);
    await this.provider.execute(`UPDATE ${this.table("product_skus")} SET
      deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,restored_at=${p[0]},restored_by=${p[1]},updated_at=${p[2]},revision=revision+1
      WHERE id=${p[3]} AND deleted_at IS NOT NULL`, [now, operatorLabel || "local_session", now, productId]);
    return this.get(productId);
  }

  async createImage(input) {
    const id = input.id || randomUUID();
    const now = iso();
    const count = Number((await this.provider.query(`SELECT count(*) total FROM ${this.table("product_images")}
      WHERE sku_id=${this.provider.placeholder(1)} AND status='available'`, [input.productId])).rows[0]?.total || 0);
    const p = this.placeholders(this.provider, 15);
    await this.provider.execute(`INSERT INTO ${this.table("product_images")} (
      id,sku_id,original_filename,storage_filename,relative_path,mime_type,file_size,file_hash,is_primary,sort_order,
      status,operator_label,request_id,created_at,updated_at
    ) VALUES (${p.join(",")})`, [
      id, input.productId, input.originalFilename, input.storageFilename, input.relativePath, input.mimeType,
      input.fileSize, input.fileHash, count === 0 ? 1 : Number(Boolean(input.isPrimary)), input.sortOrder || count,
      "available", input.operatorLabel, input.requestId || null, now, now,
    ]);
    return this.getImage(id);
  }

  async getImage(id) {
    const p = this.provider.placeholder(1);
    const row = (await this.provider.query(`SELECT * FROM ${this.table("product_images")} WHERE id=${p}`, [id])).rows[0];
    return row ? { ...serializeImage(row), storageFilename: row.storage_filename, relativePath: row.relative_path, fileHash: row.file_hash } : null;
  }

  async deleteImage(productId, imageId) {
    const now = iso();
    const p = this.placeholders(this.provider, 4);
    const result = await this.provider.execute(`UPDATE ${this.table("product_images")} SET status='deleted',deleted_at=${p[0]},updated_at=${p[1]}
      WHERE id=${p[2]} AND sku_id=${p[3]} AND status='available'`, [now, now, imageId, productId]);
    return result.rowCount > 0;
  }
}
