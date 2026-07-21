import {
  PRODUCT_PACKAGE_FIELDS,
  PRODUCT_PACKAGE_OPTIONAL_FIELDS,
} from "./product-package-contract.mjs";

const GROUP_LABELS = Object.freeze({
  basic: "基础资料",
  classification: "分类信息",
  specification: "规格与包装",
  inventory: "仓库与库存",
  cost: "成本与价格",
});

const FIELD_GROUPS = Object.freeze({
  source_period: "basic", sku_code: "basic", product_name: "basic", main_sku_code: "basic",
  country_raw: "basic", source_created_date: "basic", new_product_month: "basic",
  new_product_age_months: "basic", gift_raw: "basic", source_status: "basic",
  category_l1: "classification", category_l2: "classification", style_code: "classification", style_name: "classification",
  sales_spec: "specification", item_dimensions_raw: "specification", item_net_weight_g: "specification",
  item_gross_weight_g: "specification", carton_length_cm: "specification", carton_width_cm: "specification",
  carton_height_cm: "specification", carton_quantity: "specification", shipping_method: "specification",
  warehouse_raw: "inventory", warehouse_stock: "inventory", planned_warehouse_raw: "inventory",
  cost_cny: "cost", exchange_rate: "cost", cost_local: "cost", price_tier_20: "cost",
  price_tier_25: "cost", price_tier_35: "cost", price_tier_45: "cost", attach_rate: "cost",
  forecast_daily_sales: "specification",
});

const READ_ONLY_FIELDS = new Set([
  "source_period", "sku_code", "country_raw", "source_status",
  "warehouse_raw", "warehouse_stock", "planned_warehouse_raw",
  "cost_cny", "exchange_rate", "cost_local", "price_tier_20", "price_tier_25",
  "price_tier_35", "price_tier_45", "attach_rate",
]);

export const PRODUCT_DETAIL_FIELDS = Object.freeze(
  [...PRODUCT_PACKAGE_FIELDS, ...PRODUCT_PACKAGE_OPTIONAL_FIELDS].map((item) => Object.freeze({
    code: item.systemField,
    label: item.sourceHeader,
    type: item.type,
    group: FIELD_GROUPS[item.systemField] || "basic",
    groupLabel: GROUP_LABELS[FIELD_GROUPS[item.systemField]] || GROUP_LABELS.basic,
    editable: !READ_ONLY_FIELDS.has(item.systemField),
    source: READ_ONLY_FIELDS.has(item.systemField) ? "central" : "central_with_manual_override",
  })),
);

const FIELD_BY_CODE = new Map(PRODUCT_DETAIL_FIELDS.map((item) => [item.code, item]));

function inventoryValue(product, key) {
  return (product.inventories || []).map((item) => item[key]).filter((value) => value !== null && value !== undefined && value !== "");
}

function sourceValues(product) {
  const latestCost = product.costHistory?.[0] || {};
  const values = {
    ...(product.sourceFacts || {}),
    source_period: product.sourcePeriod,
    sku_code: product.sku,
    product_name: product.sourceFacts?.product_name ?? product.productName,
    main_sku_code: product.sourceFacts?.main_sku_code ?? product.mainSku,
    country_raw: product.country,
    category_l1: product.sourceFacts?.category_l1 ?? product.categoryL1,
    category_l2: product.sourceFacts?.category_l2 ?? product.categoryL2,
    style_code: product.sourceFacts?.style_code ?? product.styleCode,
    style_name: product.sourceFacts?.style_name ?? product.styleName,
    sales_spec: product.sourceFacts?.sales_spec ?? product.salesSpec,
    source_status: product.sourceStatus,
    warehouse_raw: inventoryValue(product, "warehouse"),
    warehouse_stock: inventoryValue(product, "stock"),
    planned_warehouse_raw: inventoryValue(product, "plannedWarehouse"),
    cost_cny: latestCost.costCny ?? null,
    exchange_rate: latestCost.exchangeRate ?? null,
    cost_local: latestCost.costLocal ?? null,
    price_tier_20: latestCost.priceTier20 ?? null,
    price_tier_25: latestCost.priceTier25 ?? null,
    price_tier_35: latestCost.priceTier35 ?? null,
    price_tier_45: latestCost.priceTier45 ?? null,
    attach_rate: latestCost.attachRate ?? null,
  };
  return values;
}

function effectiveValues(product) {
  return { ...sourceValues(product), ...(product.manualOverrides || {}) };
}

function normalizeEditableValue(field, value) {
  if (value === null || value === undefined || value === "") return null;
  if (field.type === "number" || field.type === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw Object.assign(new Error(`${field.label}必须是有效数字。`), { code: "PRODUCT_FIELD_INVALID", status: 400 });
    if (field.type === "integer" && !Number.isInteger(number)) {
      throw Object.assign(new Error(`${field.label}必须是整数。`), { code: "PRODUCT_FIELD_INVALID", status: 400 });
    }
    return number;
  }
  const text = String(value).trim();
  if (text.length > 2000) throw Object.assign(new Error(`${field.label}内容过长。`), { code: "PRODUCT_FIELD_INVALID", status: 400 });
  return text || null;
}

export class ProductCatalogService {
  constructor({ repository }) {
    this.repository = repository;
  }

  list(options) {
    return this.repository.list(options);
  }

  filters(accessScope) {
    return this.repository.filters(accessScope);
  }

  async fields() {
    const preference = await this.repository.getPreference();
    const visibleFields = preference?.visibleFields?.filter((code) => FIELD_BY_CODE.has(code)) || PRODUCT_DETAIL_FIELDS.map((item) => item.code);
    return { fields: PRODUCT_DETAIL_FIELDS, visibleFields, preferenceRevision: preference?.revision || 0 };
  }

  async detail(id) {
    const product = await this.repository.get(id);
    if (!product) return null;
    const fieldConfig = await this.fields();
    return {
      ...product,
      sourceFieldValues: sourceValues(product),
      fieldValues: effectiveValues(product),
      ...fieldConfig,
    };
  }

  async saveFieldPreference(visibleFields, audit = {}) {
    const normalized = [...new Set(Array.isArray(visibleFields) ? visibleFields.map(String) : [])].filter((code) => FIELD_BY_CODE.has(code));
    if (!normalized.length) throw Object.assign(new Error("至少保留一个详情字段。"), { code: "PRODUCT_FIELD_PREFERENCE_INVALID", status: 400 });
    return this.repository.savePreference({
      visibleFields: normalized,
      operatorLabel: audit.operatorLabel || "local_session",
      requestId: audit.requestId || null,
    });
  }

  async update(id, values, audit = {}, clearFields = []) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw Object.assign(new Error("产品修改内容无效。"), { code: "PRODUCT_FIELD_INVALID", status: 400 });
    }
    const normalized = {};
    for (const [code, value] of Object.entries(values)) {
      const field = FIELD_BY_CODE.get(code);
      if (!field || !field.editable) {
        throw Object.assign(new Error(`字段 ${code} 不允许人工修改。`), { code: "PRODUCT_FIELD_READ_ONLY", status: 400 });
      }
      normalized[code] = normalizeEditableValue(field, value);
    }
    const normalizedClearFields = [...new Set((Array.isArray(clearFields) ? clearFields : []).map(String))];
    for (const code of normalizedClearFields) {
      const field = FIELD_BY_CODE.get(code);
      if (!field || !field.editable) {
        throw Object.assign(new Error(`字段 ${code} 不允许清除人工覆盖。`), { code: "PRODUCT_FIELD_READ_ONLY", status: 400 });
      }
      delete normalized[code];
    }
    if (!Object.keys(normalized).length && !normalizedClearFields.length) {
      throw Object.assign(new Error("没有可保存的修改。"), { code: "PRODUCT_FIELD_INVALID", status: 400 });
    }
    return this.repository.saveOverrideChanges(id, { values: normalized, clearFields: normalizedClearFields }, {
      operatorLabel: audit.operatorLabel || "local_session",
      requestId: audit.requestId || null,
    });
  }

  async softDelete(id, reason, audit = {}) {
    const normalizedReason = String(reason || "").trim();
    if (normalizedReason.length > 500) {
      throw Object.assign(new Error("删除原因不能超过500个字符。"), { code: "PRODUCT_DELETE_REASON_INVALID", status: 400 });
    }
    return this.repository.softDelete(id, {
      reason: normalizedReason || null,
      operatorLabel: audit.operatorLabel || "local_session",
    });
  }

  restore(id, audit = {}) {
    return this.repository.restore(id, { operatorLabel: audit.operatorLabel || "local_session" });
  }
}
