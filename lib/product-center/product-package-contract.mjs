import crypto from "node:crypto";
import {
  normalizeCanonicalSku,
  normalizeCanonicalWarehouse,
} from "../data-foundation/unified-normalizers.mjs";

const field = (sourceHeader, systemField, type = "text", options = {}) => Object.freeze({
  sourceHeader,
  systemField,
  type,
  requiredHeader: Boolean(options.requiredHeader),
  requiredValue: Boolean(options.requiredValue),
});

export const PRODUCT_PACKAGE_FIELDS = Object.freeze([
  field("周期", "source_period"),
  field("SKU", "sku_code", "text", { requiredHeader: true, requiredValue: true }),
  field("商品名称", "product_name", "text", { requiredHeader: true, requiredValue: true }),
  field("主SKU", "main_sku_code"),
  field("国家", "country_raw", "text", { requiredHeader: true, requiredValue: true }),
  field("一级品类", "category_l1", "text", { requiredHeader: true, requiredValue: true }),
  field("二级品类", "category_l2", "text", { requiredHeader: true, requiredValue: true }),
  field("创建日期", "source_created_date", "date"),
  field("新款年月", "new_product_month"),
  field("新款月龄", "new_product_age_months", "number"),
  field("赠品", "gift_raw"),
  field("SKU状态", "source_status", "text", { requiredHeader: true, requiredValue: true }),
  field("款号", "style_code"),
  field("款名", "style_name"),
  field("销售规格", "sales_spec"),
  field("单品尺寸", "item_dimensions_raw"),
  field("单品净重g", "item_net_weight_g", "number"),
  field("单品毛重g", "item_gross_weight_g", "number"),
  field("外箱长cm", "carton_length_cm", "number"),
  field("外箱宽cm", "carton_width_cm", "number"),
  field("外箱高cm", "carton_height_cm", "number"),
  field("每箱数量", "carton_quantity", "integer"),
  field("出货方式", "shipping_method"),
  field("仓库", "warehouse_raw"),
  field("仓存", "warehouse_stock", "number"),
  field("规划仓", "planned_warehouse_raw"),
  field("销售成本人民币", "cost_cny", "number"),
  field("国家汇率", "exchange_rate", "number"),
  field("销售成本国家币", "cost_local", "number"),
  field("1档价(20%)", "price_tier_20", "number"),
  field("2档价(25%)", "price_tier_25", "number"),
  field("3档价(35%)", "price_tier_35", "number"),
  field("4档价(45%)", "price_tier_45", "number"),
  field("连带率", "attach_rate", "number"),
]);

export const PRODUCT_PACKAGE_OPTIONAL_FIELDS = Object.freeze([
  field("预测日销量", "forecast_daily_sales", "number", { requiredHeader: false }),
]);

export const ALL_PRODUCT_PACKAGE_FIELDS = Object.freeze([
  ...PRODUCT_PACKAGE_FIELDS,
  ...PRODUCT_PACKAGE_OPTIONAL_FIELDS,
]);

export const PRODUCT_PACKAGE_FIELD_COUNT = PRODUCT_PACKAGE_FIELDS.length;
export const PRODUCT_PACKAGE_HEADERS = Object.freeze(PRODUCT_PACKAGE_FIELDS.map((item) => item.sourceHeader));
export const PRODUCT_PACKAGE_FIELD_BY_HEADER = new Map(
  ALL_PRODUCT_PACKAGE_FIELDS.map((item) => [item.sourceHeader, item]),
);

export function normalizeHeader(value) {
  return String(value ?? "").replace(/[\uFEFF\u200B]/g, "").trim();
}
export function normalizeSku(value) {
  return normalizeCanonicalSku(value);
}

export function normalizeCountry(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeWarehouse(value) {
  return normalizeCanonicalWarehouse(value);
}

export function buildProductKey(country, sku) {
  const normalizedCountry = normalizeCountry(country).toLocaleUpperCase("zh-CN");
  const normalizedSku = normalizeSku(sku);
  return normalizedCountry && normalizedSku ? `${normalizedCountry}|${normalizedSku}` : "";
}

export function buildSourceRowBaseKey(country, sku, warehouse) {
  const productKey = buildProductKey(country, sku);
  if (!productKey) return "";
  const normalizedWarehouse = normalizeWarehouse(warehouse).toLocaleUpperCase("zh-CN") || "__NO_WAREHOUSE__";
  return `${productKey}|${normalizedWarehouse}`;
}

export function normalizeCategory(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

export function buildFieldMapping(headers) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const counts = new Map();
  for (const header of normalizedHeaders) counts.set(header, (counts.get(header) || 0) + 1);
  const mapping = normalizedHeaders.map((header, index) => {
    const contract = PRODUCT_PACKAGE_FIELD_BY_HEADER.get(header);
    return {
      sourceIndex: index,
      sourceHeader: header,
      systemField: contract?.systemField || null,
      type: contract?.type || null,
      status: !header ? "empty" : counts.get(header) > 1 ? "duplicate" : contract ? "mapped" : "unknown",
    };
  });
  const present = new Set(normalizedHeaders);
  for (const contract of PRODUCT_PACKAGE_FIELDS) {
    if (contract.requiredHeader && !present.has(contract.sourceHeader)) {
      mapping.push({
        sourceIndex: null,
        sourceHeader: contract.sourceHeader,
        systemField: contract.systemField,
        type: contract.type,
        status: "missing",
      });
    }
  }
  return Object.freeze({
    mapping,
    unknownFields: mapping.filter((item) => item.status === "unknown").map((item) => item.sourceHeader),
    duplicateFields: mapping.filter((item) => item.status === "duplicate").map((item) => item.sourceHeader),
    missingFields: mapping.filter((item) => item.status === "missing").map((item) => item.sourceHeader),
    headerFingerprint: sha256(stableJson(normalizedHeaders)),
  });
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).trim().replaceAll(",", "").replace(/%$/, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

export function normalizeFieldValue(contract, value) {
  if (contract.type === "number" || contract.type === "integer") {
    const parsed = numberValue(value);
    if (parsed === null) return null;
    return contract.type === "integer" && Number.isInteger(parsed) ? parsed : parsed;
  }
  if (contract.type === "date") {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string") return value.trim() || null;
    return String(value);
  }
  return textValue(value);
}

export function mapLifecycleStatus(sourceStatus, { missingMainSku = false } = {}) {
  const status = String(sourceStatus || "").replace(/\s+/g, "").trim().toLowerCase();
  if (["正常", "正常销售", "active", "在售", "销售中"].includes(status)) return { status: "ACTIVE", reasonCode: "CENTRAL_STATUS_ACTIVE" };
  if (["待开发", "新品", "new"].includes(status)) return { status: "NEW", reasonCode: "CENTRAL_STATUS_NEW" };
  if (["清仓", "清仓商品", "clearance"].includes(status)) return { status: "CLEARANCE", reasonCode: "CENTRAL_STATUS_CLEARANCE" };
  if (["灭款", "停售", "停产", "discontinued"].includes(status)) return {
    status: "DISCONTINUED",
    reasonCode: missingMainSku ? "CENTRAL_DISCONTINUED_WITHOUT_MAIN_SKU" : "CENTRAL_STATUS_DISCONTINUED",
  };
  if (["归档", "archived"].includes(status)) return { status: "ARCHIVED", reasonCode: "CENTRAL_STATUS_ARCHIVED" };
  return null;
}

export function resolveExchangeDirection({ costCny, exchangeRate, costLocal }) {
  if (![costCny, exchangeRate, costLocal].every((value) => Number.isFinite(value)) || costCny < 0 || exchangeRate <= 0 || costLocal < 0) {
    return null;
  }
  const tolerance = Math.max(0.05, Math.abs(costLocal) * 0.01);
  const multiplyDifference = Math.abs(costCny * exchangeRate - costLocal);
  const divideDifference = Math.abs(costCny / exchangeRate - costLocal);
  if (Math.abs(exchangeRate - 1) <= 1e-12 && Math.min(multiplyDifference, divideDifference) <= tolerance) return "equivalent";
  if (multiplyDifference <= tolerance && multiplyDifference <= divideDifference) return "local_per_cny";
  if (divideDifference <= tolerance) return "cny_per_local";
  return null;
}
