import { createHash } from "node:crypto";
import { PRODUCT_PACKAGE_SOURCE_SYSTEM } from "../data-foundation/unified-data-contracts.mjs";
import {
  buildProductKey,
  normalizeCountry,
  normalizeSku,
  normalizeWarehouse,
  resolveExchangeDirection,
  sha256,
  stableJson,
} from "../product-center/product-package-contract.mjs";

const field = (column, label, normalizedField = null, type = "text") => Object.freeze({
  column,
  label,
  normalizedField,
  type,
});

export const PRODUCT_PACKAGE_SOURCE_FIELDS = Object.freeze([
  field("period", "周期", "source_period"),
  field("stock_sku", "库存 SKU", "sku_code"),
  field("warehouse_id", "仓库 ID", "warehouse_id"),
  field("warehouse_name", "仓库名称", "warehouse_raw"),
  field("sales_sku", "销售 SKU", "main_sku_code"),
  field("country", "国家", "country_raw"),
  field("country_category", "国家类目", "country_category"),
  field("sku_name_cn", "商品中文名", "product_name"),
  field("sku_name_en", "商品英文名", "product_name_en"),
  field("developer_id", "开发人员 ID", "developer_id"),
  field("developer_name", "开发人员", "developer_name"),
  field("parent_category_name", "一级品类", "category_l1"),
  field("category_name", "二级品类", "category_l2"),
  field("third_category_name", "三级品类", "category_l3"),
  field("time_created", "创建日期", "source_created_date", "date"),
  field("period_created", "新品日期", "new_product_month", "date"),
  field("color", "颜色", "color"),
  field("model_number", "型号", "model_number"),
  field("specification", "产品规格", "specification"),
  field("delivery_day", "交付天数", "delivery_day", "integer"),
  field("brand_name", "品牌", "brand_name"),
  field("picture", "源图片地址", "source_picture_url"),
  field("has_battery", "电池属性", "has_battery"),
  field("whether_ci", "是否商检", "whether_ci"),
  field("destcus_style", "报关方式", "destcus_style"),
  field("commodity_material", "商品材质", "material"),
  field("commodity_use", "商品用途", "commodity_use"),
  field("declare_name", "申报中文名", "declare_name"),
  field("declare_ename", "申报英文名", "declare_name_en"),
  field("declare_code", "申报码", "declare_code"),
  field("is_gift", "是否赠品", "gift_raw"),
  field("length", "外箱长 cm", "carton_length_cm", "number"),
  field("width", "外箱宽 cm", "carton_width_cm", "number"),
  field("height", "外箱高 cm", "carton_height_cm", "number"),
  field("case_size", "单品尺寸", "item_dimensions_raw"),
  field("net_weight", "单品净重 g", "item_net_weight_g", "number"),
  field("weight", "单品毛重 g", "item_gross_weight_g", "number"),
  field("packaging_length", "包装长 cm", "packaging_length_cm", "number"),
  field("packaging_width", "包装宽 cm", "packaging_width_cm", "number"),
  field("packaging_height", "包装高 cm", "packaging_height_cm", "number"),
  field("carton_size", "每箱数量", "carton_quantity", "integer"),
  field("volume", "体积", "volume", "number"),
  field("special_volume", "特殊体积", "special_volume", "number"),
  field("delivery_mode", "出货方式", "shipping_method"),
  field("packages", "包装材料", "packages"),
  field("sales_cost", "销售成本人民币", "cost_cny", "number"),
  field("exchange_rate", "国家汇率", "exchange_rate", "number"),
  field("sales_cost_ori", "销售成本国家币", "cost_local", "number"),
  field("update_time", "源更新时间", "source_updated_at", "datetime"),
  field("stock_status", "SKU 状态", "source_status"),
  field("warehouse_type", "仓库类型", "warehouse_type", "integer"),
  field("style_name", "款名", "style_name"),
  field("style_number", "款号", "style_code"),
  field("saleSpec", "销售规格", "sales_spec"),
  field("storage", "仓存", "warehouse_stock", "number"),
  field("isPlan", "是否规划", "is_plan"),
  field("jointRate", "连带率", "attach_rate", "number"),
  field("recentlyTime", "最近时间", "recently_time", "datetime"),
  field("earliestTime", "最早时间", "earliest_time", "datetime"),
  field("is_purchase", "是否采购", "is_purchase"),
  field("monthNum", "新品月龄", "new_product_age_months", "integer"),
  field("is_hw_purchase", "是否海外仓采购", "is_hw_purchase"),
]);

export const PRODUCT_PACKAGE_SOURCE_COLUMNS = Object.freeze(PRODUCT_PACKAGE_SOURCE_FIELDS.map((item) => item.column));
export const PRODUCT_PACKAGE_SOURCE_FIELD_BY_COLUMN = new Map(PRODUCT_PACKAGE_SOURCE_FIELDS.map((item) => [item.column, item]));
export { PRODUCT_PACKAGE_SOURCE_SYSTEM };

export const TARGET_LIST_PRICE_PROFIT_RATE = 0.5;

export function targetListPrice50FromCost(cost) {
  if (cost === null || cost === undefined || cost === "") return null;
  const normalizedCost = Number(String(cost).replaceAll(",", "").trim());
  if (!Number.isFinite(normalizedCost) || normalizedCost <= 0) return null;
  return normalizedCost / (1 - TARGET_LIST_PRICE_PROFIT_RATE);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  return String(value).trim() || null;
}

function rawValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizedValue(definition, value) {
  if (definition.type === "number" || definition.type === "integer") return number(value);
  if (definition.type === "date" || definition.type === "datetime") return dateValue(value);
  return text(value);
}

export function productPackageLifecycle(stockStatus) {
  const status = String(stockStatus ?? "").trim();
  if (status === "3") return Object.freeze({ status: "ACTIVE", reasonCode: "AI_PROJECT_A_STATUS_3" });
  if (status === "4") return Object.freeze({ status: "CLEARANCE", reasonCode: "AI_PROJECT_A_STATUS_4" });
  if (status === "2") return Object.freeze({ status: "DISCONTINUED", reasonCode: "AI_PROJECT_A_STATUS_2" });
  return Object.freeze({ status: "ARCHIVED", reasonCode: "AI_PROJECT_A_STATUS_UNKNOWN" });
}

export function deterministicProductPackageId(namespace, value) {
  const digest = createHash("sha256").update(`${namespace}\u0000${value}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function buildProductPackageSourceRowKey(row) {
  return sha256(stableJson([
    normalizeCountry(row?.country).toUpperCase(),
    normalizeSku(row?.stock_sku),
    text(row?.warehouse_id) || "",
    normalizeSku(row?.sales_sku),
  ]));
}

export function normalizeProductPackageSourceRow(source, sourceRowNumber) {
  const rawPayload = Object.fromEntries(PRODUCT_PACKAGE_SOURCE_FIELDS.map((definition) => [
    definition.column,
    rawValue(source?.[definition.column]),
  ]));
  const rawTypes = Object.fromEntries(PRODUCT_PACKAGE_SOURCE_FIELDS.map((definition) => [
    definition.column,
    rawPayload[definition.column] === null ? "null" : typeof rawPayload[definition.column],
  ]));
  const normalizedFields = Object.fromEntries(PRODUCT_PACKAGE_SOURCE_FIELDS
    .filter((definition) => definition.normalizedField)
    .map((definition) => [definition.normalizedField, normalizedValue(definition, rawPayload[definition.column])]));
  const country = normalizeCountry(rawPayload.country).toUpperCase();
  const sku = normalizeSku(rawPayload.stock_sku);
  const warehouse = normalizeWarehouse(rawPayload.warehouse_name);
  const productKey = buildProductKey(country, sku);
  const sourceRowKey = buildProductPackageSourceRowKey(rawPayload);
  const lifecycle = productPackageLifecycle(rawPayload.stock_status);
  const exchangeDirection = resolveExchangeDirection({
    costCny: normalizedFields.cost_cny,
    exchangeRate: normalizedFields.exchange_rate,
    costLocal: normalizedFields.cost_local,
  });
  const normalizedPayload = {
    ...normalizedFields,
    country_raw: country,
    sku_code: sku,
    warehouse_raw: warehouse,
    main_sku_code: normalizeSku(rawPayload.sales_sku) || null,
    product_key: productKey,
    source_row_key: sourceRowKey,
    lifecycle_status: lifecycle.status,
    lifecycle_reason_code: lifecycle.reasonCode,
    exchange_direction: exchangeDirection,
    price_tier_20: null,
    price_tier_25: null,
    price_tier_35: null,
    price_tier_45: null,
    target_price_50: targetListPrice50FromCost(normalizedFields.cost_local),
    forecast_daily_sales: null,
    planned_warehouse_raw: null,
    inventories: [{
      source_row_number: sourceRowNumber,
      warehouse_id: text(rawPayload.warehouse_id),
      warehouse_raw: warehouse || "未指定",
      warehouse_stock: normalizedFields.warehouse_stock,
      planned_warehouse_raw: null,
    }],
  };
  const categoryL1 = normalizedPayload.category_l1 || "未分类";
  const categoryL2 = normalizedPayload.category_l2 || normalizedPayload.category_l3 || "未分类";
  return Object.freeze({
    sourceRowNumber,
    sourceRowKey,
    productKey,
    countryCode: country,
    stockSku: sku,
    warehouseId: text(rawPayload.warehouse_id) || "",
    warehouseName: warehouse || "未指定",
    salesSku: normalizeSku(rawPayload.sales_sku) || null,
    productName: text(rawPayload.sku_name_cn) || sku,
    categoryL1,
    categoryL2,
    categoryL3: text(rawPayload.third_category_name),
    sourcePeriod: text(rawPayload.period),
    sourceStatus: text(rawPayload.stock_status) || "",
    lifecycleStatus: lifecycle.status,
    lifecycleReasonCode: lifecycle.reasonCode,
    sourceUpdatedAt: dateValue(rawPayload.update_time),
    rawPayload,
    rawTypes,
    normalizedPayload,
    rowSha256: sha256(stableJson({ rawPayload, rawTypes })),
    categoryL1Id: deterministicProductPackageId("category-l1", categoryL1.toLocaleLowerCase("zh-CN")),
    categoryL2Id: deterministicProductPackageId("category-l2", `${categoryL1}\u0000${categoryL2}`.toLocaleLowerCase("zh-CN")),
    modelId: normalizedPayload.main_sku_code
      ? deterministicProductPackageId("model", normalizedPayload.main_sku_code)
      : null,
    productId: deterministicProductPackageId("product", productKey),
  });
}

export function createProductPackageSnapshotHasher() {
  const hash = createHash("sha256");
  let count = 0;
  return Object.freeze({
    update(row) {
      hash.update(String(row.sourceRowKey));
      hash.update(":");
      hash.update(String(row.rowSha256));
      hash.update("\n");
      count += 1;
    },
    digest() {
      return Object.freeze({ sha256: hash.digest("hex"), rowCount: count });
    },
  });
}

export function publicProductPackageSourceFields() {
  return PRODUCT_PACKAGE_SOURCE_FIELDS.map(({ column, label, normalizedField, type }) => ({ column, label, normalizedField, type }));
}
