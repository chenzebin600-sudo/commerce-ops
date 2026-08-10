import { PRODUCT_PACKAGE_SOURCE_FIELDS } from "../product-package-sync/product-package-source-contract.mjs";
import { PRICE_CONTROL_SOURCE_COLUMNS } from "../price-control/mysql-price-control-source.mjs";
import { PRICE_FIELDS } from "../price-control/price-control-contracts.mjs";
import { DATASET_CODES, DATA_SOURCE_CODES } from "./unified-data-contracts.mjs";

export const FIELD_MAPPING_MODE = Object.freeze({
  DIRECT: "DIRECT",
  NORMALIZE: "NORMALIZE",
  DERIVE: "DERIVE",
  EXPAND: "EXPAND",
  RETAIN: "RETAIN",
  REDACT: "REDACT",
  IDENTITY_LOOKUP: "IDENTITY_LOOKUP",
});

export const FIELD_SENSITIVITY = Object.freeze({
  INTERNAL: "INTERNAL",
  CONFIDENTIAL: "CONFIDENTIAL",
  RESTRICTED: "RESTRICTED",
});

const ORDER_SOURCE_FIELDS = Object.freeze([
  "订单编号", "交易编号", "交运时间", "物流渠道", "店铺名", "平台", "店长", "订单状态", "仓库",
  "SKU总数量", "所属地区（省/州）", "所属城市", "SKU", "商品数量", "商品库存", "商品中文名称",
  "货运单号", "付款方式", "SKU明细", "客户账号", "客户姓名", "邮寄地址1(按逗号分隔导出2列)",
  "商品销售单价", "原始商品销售单价", "商品总金额", "原始运费金额", "运费收入", "原始商品总金额",
  "订单原始总金额", "订单总金额", "优惠金额（人民币）", "优惠金额（原始货币）", "订单核算金额（人民币）",
  "订单核算金额（原始货币）", "汇率（原始货币）", "订单商品名称", "采购在途量", "付款时间", "平台SKU",
  "买家自选物流方式", "最后发货期限", "订单自定义分类", "发货时间", "是否转WMS发货", "退货原因",
  "退货备注", "作废时间", "作废前状态", "电话1", "电话2", "订单备注", "平台订单仓库", "是否测评",
  "测评费用", "邮政编码", "tiktok样品订单", "签收时间", "实付金额",
]);

const INVENTORY_SOURCE_FIELDS = Object.freeze([
  "库存SKU编号", "商品状态", "活跃度", "是否新款", "一级目录", "二级目录", "三级目录", "一级品牌",
  "二级品牌", "采购员", "中文名称", "英文名称", "父级仓库", "仓库", "仓位", "销量(7/28/42)",
  "预测日销量(个)", "仓位库存", "当前可售天数", "在途量", "海外仓预调入量", "分仓调拨预调入量",
  "警戒量", "警戒天数", "未发货量", "分仓调拨未发货量", "可用库存量", "最后出库时间",
  "最后入库时间", "商品备注",
]);

const SHOP_MASTER_FIELDS = Object.freeze([
  "id", "platform", "provider_shop_id", "shop_code", "shop_name", "normalized_shop_name", "source_country_code", "site_code",
  "currency", "provider_shop_type", "control_shop_type", "growth_shop_id", "execution_provider",
  "platform_connector_shop_id", "identity_status", "status", "source_metadata_json", "first_seen_at", "last_seen_at",
  "manager_name", "senior_manager_name", "category_name", "platform_short_code", "platform_shop_id", "directory_source",
  "directory_synced_at", "connector_synced_at", "created_at", "updated_at",
]);

const API_APPLICATION_FIELDS = Object.freeze([
  "account_id", "platform", "connector_application_id", "environment", "authorization_mode", "api_version",
  "capacity_limit", "credential_reference", "status", "metadata_json", "last_verified_at", "created_at", "updated_at",
]);

const CONNECTOR_SHOP_FIELDS = Object.freeze([
  "id", "platform_id", "shop_name", "seller_id", "country", "region", "status", "metadata_json", "created_at", "updated_at",
]);

const CONNECTOR_AUTH_FIELDS = Object.freeze([
  "shop_id", "application_id", "credential_group_id", "access_token_encrypted", "refresh_token_encrypted", "expires_at",
  "refresh_expires_at", "token_status", "last_refresh_time", "version", "created_at", "updated_at",
]);

const restrictedOrderFields = new Set([
  "所属地区（省/州）", "所属城市", "货运单号", "客户账号", "客户姓名", "邮寄地址1(按逗号分隔导出2列)",
  "退货备注", "电话1", "电话2", "订单备注", "邮政编码",
]);

const orderProjection = Object.freeze({
  订单编号: ["order.source_order_id", "DIRECT", "text_trim_v1", "BUSINESS_KEY", "REQUIRED"],
  交易编号: ["order.source_transaction_id", "DIRECT", "text_trim_v1"],
  交运时间: ["order.handover_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  物流渠道: ["order.logistics_channel", "DIRECT", "text_trim_v1"],
  店铺名: ["shop.source_shop_name", "NORMALIZE", "shop_name_nfkc_lower_v1", "FOREIGN_KEY", "REQUIRED"],
  平台: ["shop.platform", "NORMALIZE", "platform_code_v1", "FOREIGN_KEY", "REQUIRED"],
  店长: ["order.shop_manager", "DIRECT", "text_trim_v1"],
  订单状态: ["order.order_status", "NORMALIZE", "mabang_order_status_v1", "NONE", "REQUIRED"],
  仓库: ["warehouse.source_warehouse_name", "NORMALIZE", "warehouse_nfkc_upper_v1", "FOREIGN_KEY"],
  SKU总数量: ["order.sku_total_quantity", "NORMALIZE", "decimal_v1"],
  SKU: ["product.source_sku", "NORMALIZE", "sku_nfkc_upper_v1", "FOREIGN_KEY", "REQUIRED"],
  商品数量: ["order_line.quantity", "NORMALIZE", "decimal_v1", "NONE", "REQUIRED"],
  商品库存: ["order_line.source_inventory_quantity", "NORMALIZE", "decimal_v1"],
  商品中文名称: ["order_line.product_name", "DIRECT", "text_trim_v1"],
  付款方式: ["order.payment_method", "DIRECT", "text_trim_v1"],
  SKU明细: ["order_line.sku_detail", "DIRECT", "text_trim_v1"],
  商品销售单价: ["order_line.unit_sale_price", "NORMALIZE", "decimal_v1"],
  原始商品销售单价: ["order_line.original_unit_sale_price", "NORMALIZE", "decimal_v1"],
  商品总金额: ["order_line.line_amount", "NORMALIZE", "decimal_v1"],
  原始运费金额: ["order.original_shipping_amount", "NORMALIZE", "decimal_v1"],
  运费收入: ["order.shipping_income", "NORMALIZE", "decimal_v1"],
  原始商品总金额: ["order.original_product_amount", "NORMALIZE", "decimal_v1"],
  订单原始总金额: ["order.original_total_amount", "NORMALIZE", "decimal_v1"],
  订单总金额: ["order.total_amount", "NORMALIZE", "decimal_v1"],
  "优惠金额（人民币）": ["order.discount_cny", "NORMALIZE", "decimal_v1"],
  "优惠金额（原始货币）": ["order.discount_original", "NORMALIZE", "decimal_v1"],
  "订单核算金额（人民币）": ["order.accounting_amount_cny", "NORMALIZE", "decimal_v1"],
  "订单核算金额（原始货币）": ["order.accounting_amount_original", "NORMALIZE", "decimal_v1"],
  "汇率（原始货币）": ["order.exchange_rate", "NORMALIZE", "decimal_v1"],
  订单商品名称: ["order_line.platform_product_name", "DIRECT", "text_trim_v1"],
  采购在途量: ["order_line.purchase_in_transit_quantity", "NORMALIZE", "decimal_v1"],
  付款时间: ["order.paid_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  平台SKU: ["product.platform_sku", "NORMALIZE", "text_trim_v1"],
  买家自选物流方式: ["order.buyer_logistics_method", "DIRECT", "text_trim_v1"],
  最后发货期限: ["order.ship_by_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  订单自定义分类: ["order.custom_category", "DIRECT", "text_trim_v1"],
  发货时间: ["order.shipped_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  是否转WMS发货: ["order.wms_fulfillment_flag", "NORMALIZE", "boolean_code_v1"],
  退货原因: ["order.return_reason", "DIRECT", "text_trim_v1"],
  作废时间: ["order.cancelled_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  作废前状态: ["order.pre_cancel_status", "DIRECT", "text_trim_v1"],
  平台订单仓库: ["warehouse.platform_warehouse_name", "NORMALIZE", "warehouse_nfkc_upper_v1"],
  是否测评: ["order.review_order_flag", "NORMALIZE", "boolean_code_v1"],
  测评费用: ["order.review_cost", "NORMALIZE", "decimal_v1"],
  tiktok样品订单: ["order.tiktok_sample_order_flag", "NORMALIZE", "boolean_code_v1"],
  签收时间: ["order.delivered_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  实付金额: ["order.paid_amount", "NORMALIZE", "decimal_v1"],
});

const inventoryProjection = Object.freeze({
  库存SKU编号: ["product.source_sku", "NORMALIZE", "sku_nfkc_upper_v1", "FOREIGN_KEY", "REQUIRED"],
  商品状态: ["inventory.product_status", "DIRECT", "text_trim_v1"],
  活跃度: ["inventory.activity_level", "DIRECT", "text_trim_v1"],
  是否新款: ["inventory.is_new", "NORMALIZE", "boolean_code_v1"],
  一级目录: ["product.category_l1", "DIRECT", "text_trim_v1"],
  二级目录: ["product.category_l2", "DIRECT", "text_trim_v1"],
  三级目录: ["product.category_l3", "DIRECT", "text_trim_v1"],
  一级品牌: ["product.brand_l1", "DIRECT", "text_trim_v1"],
  二级品牌: ["product.brand_l2", "DIRECT", "text_trim_v1"],
  采购员: ["product.buyer_name", "DIRECT", "text_trim_v1"],
  中文名称: ["product.name_cn", "DIRECT", "text_trim_v1"],
  英文名称: ["product.name_en", "DIRECT", "text_trim_v1"],
  父级仓库: ["warehouse.parent_source_name", "NORMALIZE", "warehouse_nfkc_upper_v1"],
  仓库: ["warehouse.source_warehouse_name", "NORMALIZE", "warehouse_nfkc_upper_v1", "FOREIGN_KEY", "REQUIRED"],
  仓位: ["inventory.bin_location", "DIRECT", "text_trim_v1"],
  "销量(7/28/42)": ["inventory.source_visible_sales", "EXPAND", "sales_7_28_42_v1"],
  "预测日销量(个)": ["inventory.source_predicted_daily_sales", "NORMALIZE", "decimal_v1"],
  仓位库存: ["inventory.physical_quantity", "NORMALIZE", "decimal_v1"],
  当前可售天数: ["inventory.days_of_supply", "NORMALIZE", "decimal_v1"],
  在途量: ["inventory.in_transit_quantity", "NORMALIZE", "decimal_v1"],
  海外仓预调入量: ["inventory.overseas_planned_inbound_quantity", "NORMALIZE", "decimal_v1"],
  分仓调拨预调入量: ["inventory.transfer_planned_inbound_quantity", "NORMALIZE", "decimal_v1"],
  警戒量: ["inventory.safety_stock_quantity", "NORMALIZE", "decimal_v1"],
  警戒天数: ["inventory.safety_stock_days", "NORMALIZE", "decimal_v1"],
  未发货量: ["inventory.pending_shipment_quantity", "NORMALIZE", "decimal_v1"],
  分仓调拨未发货量: ["inventory.transfer_pending_shipment_quantity", "NORMALIZE", "decimal_v1"],
  可用库存量: ["inventory.available_quantity", "NORMALIZE", "decimal_v1"],
  最后出库时间: ["inventory.last_outbound_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  最后入库时间: ["inventory.last_inbound_at", "NORMALIZE", "source_datetime_to_utc_v1"],
  商品备注: ["inventory.product_note", "DIRECT", "text_trim_v1"],
});

const shopProjection = Object.freeze({
  id: "shop.canonical_shop_id", platform: "shop.platform", provider_shop_id: "shop.provider_shop_id",
  shop_code: "shop.shop_code", shop_name: "shop.shop_name", normalized_shop_name: "shop.normalized_shop_name", source_country_code: "shop.country_code",
  site_code: "shop.site_code", currency: "shop.currency", provider_shop_type: "shop.provider_shop_type",
  control_shop_type: "shop.control_shop_type", growth_shop_id: "shop.legacy_growth_shop_id",
  execution_provider: "shop.execution_provider", platform_connector_shop_id: "shop.deprecated_connector_candidate_id",
  identity_status: "shop.identity_status", status: "shop.status", source_metadata_json: "shop.source_metadata",
  manager_name: "shop.manager_name", senior_manager_name: "shop.senior_manager_name", category_name: "shop.category_name",
  platform_short_code: "shop.platform_short_code", platform_shop_id: "shop.platform_shop_id",
  directory_source: "shop.directory_source", directory_synced_at: "shop.directory_synced_at",
  connector_synced_at: "shop.connector_synced_at", first_seen_at: "shop.first_seen_at", last_seen_at: "shop.last_seen_at",
  created_at: "shop.created_at", updated_at: "shop.updated_at",
});

const priceProjection = Object.freeze({
  id: "price.source_row_id", apply_no: "price.source_apply_no", country_code: "price.country_code",
  categrory: "price.category_name", sku: "product.source_sku", sku_status: "price.sku_status", seq: "price.source_sequence",
  apply_date: "price.apply_date", curr_approve_status: "price.approval_status", apply_create_time: "price.apply_created_at",
  approve_time: "price.approved_at", submit_time: "price.submitted_at",
});

function mapping(input) {
  const sourceField = String(input.sourceField || "").trim();
  const canonicalField = String(input.canonicalField || "").trim();
  if (!sourceField || !canonicalField) throw new TypeError("sourceField and canonicalField are required");
  const id = `${input.sourceCode}:${input.datasetCode}:${sourceField}:${canonicalField}`;
  return Object.freeze({
    id,
    sourceCode: input.sourceCode,
    datasetCode: input.datasetCode,
    sourceRelation: input.sourceRelation,
    sourceField,
    rawTarget: input.rawTarget || null,
    canonicalField,
    targetRelation: input.targetRelation || null,
    targetColumn: input.targetColumn || null,
    mode: input.mode || FIELD_MAPPING_MODE.RETAIN,
    transformCode: input.transformCode || "identity_v1",
    requiredLevel: input.requiredLevel || "OPTIONAL",
    nullSemantics: input.nullSemantics || "UNKNOWN",
    identityRole: input.identityRole || "NONE",
    sensitivity: input.sensitivity || FIELD_SENSITIVITY.INTERNAL,
    publicationScope: input.publicationScope || "GLOBAL",
    cardinality: input.cardinality || "ONE_TO_ONE",
    description: input.description || "",
  });
}

function orderMappings() {
  return ORDER_SOURCE_FIELDS.map((sourceField) => {
    if (restrictedOrderFields.has(sourceField)) return mapping({
      sourceCode: DATA_SOURCE_CODES.MABANG_ORDERS,
      datasetCode: DATASET_CODES.MABANG_ORDER_FACTS,
      sourceRelation: "mabang.order_export",
      sourceField,
      canonicalField: `restricted.order.${sourceField}`,
      mode: FIELD_MAPPING_MODE.REDACT,
      transformCode: "pii_header_redaction_v1",
      sensitivity: FIELD_SENSITIVITY.RESTRICTED,
      publicationScope: "NONE",
      nullSemantics: "NOT_APPLICABLE",
      description: "源文件接收边界即删除，不进入全局数据集。",
    });
    const [canonicalField, mode = "RETAIN", transformCode = "identity_v1", identityRole = "NONE", requiredLevel = "OPTIONAL"] =
      orderProjection[sourceField] || [`order.raw.${sourceField}`];
    return mapping({
      sourceCode: DATA_SOURCE_CODES.MABANG_ORDERS,
      datasetCode: DATASET_CODES.MABANG_ORDER_FACTS,
      sourceRelation: "mabang.order_export",
      sourceField,
      rawTarget: `app.growth_order_raw_rows.raw_values_json.${sourceField}`,
      canonicalField,
      mode: FIELD_MAPPING_MODE[mode],
      transformCode,
      identityRole,
      requiredLevel,
    });
  });
}

function inventoryMappings() {
  return INVENTORY_SOURCE_FIELDS.map((sourceField) => {
    const [canonicalField, mode = "RETAIN", transformCode = "identity_v1", identityRole = "NONE", requiredLevel = "OPTIONAL"] =
      inventoryProjection[sourceField] || [`inventory.raw.${sourceField}`];
    return mapping({
      sourceCode: DATA_SOURCE_CODES.MABANG_INVENTORY,
      datasetCode: DATASET_CODES.MABANG_INVENTORY_CURRENT,
      sourceRelation: "mabang.inventory_export",
      sourceField,
      rawTarget: `app.growth_inventory_raw_rows.raw_values_json.${sourceField}`,
      canonicalField,
      mode: FIELD_MAPPING_MODE[mode],
      transformCode,
      identityRole,
      requiredLevel,
    });
  });
}

function productPackageMappings() {
  return PRODUCT_PACKAGE_SOURCE_FIELDS.map((field) => mapping({
    sourceCode: DATA_SOURCE_CODES.PRODUCT_PACKAGE_DB,
    datasetCode: DATASET_CODES.PRODUCT_PACKAGE_CURRENT,
    sourceRelation: "ai_project_a.product_package",
    sourceField: field.column,
    rawTarget: `app.product_package_rows.raw_payload_json.${field.column}`,
    canonicalField: `product.${field.normalizedField || `raw.${field.column}`}`,
    mode: field.normalizedField ? FIELD_MAPPING_MODE.NORMALIZE : FIELD_MAPPING_MODE.RETAIN,
    transformCode: field.type === "number" || field.type === "integer" ? `${field.type}_v1`
      : field.type === "date" || field.type === "datetime" ? `${field.type}_source_timezone_v1` : "text_trim_v1",
    requiredLevel: ["stock_sku", "country", "warehouse_id"].includes(field.column) ? "REQUIRED" : "OPTIONAL",
    identityRole: field.column === "stock_sku" || field.column === "warehouse_id" ? "BUSINESS_KEY"
      : field.column === "country" || field.column === "warehouse_name" ? "FOREIGN_KEY" : "NONE",
  }));
}

function priceMappings() {
  const priceBySource = new Map(PRICE_FIELDS.map((field) => [field.source, field]));
  return PRICE_CONTROL_SOURCE_COLUMNS.map((sourceField) => {
    const price = priceBySource.get(sourceField);
    if (price) return mapping({
      sourceCode: DATA_SOURCE_CODES.PRICE_CONTROL_DB,
      datasetCode: DATASET_CODES.PRICE_CONTROL_CURRENT,
      sourceRelation: "ai_project_a.price_control",
      sourceField,
      canonicalField: "price.price_value",
      targetRelation: "app.product_sku_current_prices",
      targetColumn: "price_value",
      mode: FIELD_MAPPING_MODE.EXPAND,
      transformCode: `price_wide_to_long_v1:${price.platform}:${price.shopType}:${price.priceType}`,
      cardinality: "ONE_SOURCE_COLUMN_TO_MANY_PRICE_ROWS",
    });
    return mapping({
      sourceCode: DATA_SOURCE_CODES.PRICE_CONTROL_DB,
      datasetCode: DATASET_CODES.PRICE_CONTROL_CURRENT,
      sourceRelation: "ai_project_a.price_control",
      sourceField,
      canonicalField: priceProjection[sourceField] || `price.raw.${sourceField}`,
      mode: FIELD_MAPPING_MODE.NORMALIZE,
    transformCode: sourceField === "country_code" ? "country_trim_upper_v1" : sourceField === "sku" ? "sku_trim_upper_v1" : "text_trim_v1",
      requiredLevel: ["apply_no", "country_code", "sku"].includes(sourceField) ? "REQUIRED" : "OPTIONAL",
      identityRole: sourceField === "sku" || sourceField === "country_code" ? "FOREIGN_KEY" : "NONE",
    });
  });
}

function shopMappings() {
  return SHOP_MASTER_FIELDS.map((sourceField) => mapping({
    sourceCode: DATA_SOURCE_CODES.SHOP_MASTER,
    datasetCode: DATASET_CODES.SHOP_MASTER_CURRENT,
    sourceRelation: "app.commerce_shop_registry",
    sourceField,
    canonicalField: shopProjection[sourceField],
    mode: sourceField === "normalized_shop_name" ? FIELD_MAPPING_MODE.NORMALIZE : FIELD_MAPPING_MODE.DIRECT,
    transformCode: sourceField === "normalized_shop_name" ? "shop_name_nfkc_lower_v1" : "identity_v1",
    requiredLevel: ["id", "platform", "provider_shop_id", "shop_name", "source_country_code"].includes(sourceField) ? "REQUIRED" : "OPTIONAL",
    identityRole: sourceField === "id" ? "CANONICAL_ID" : ["platform", "provider_shop_id"].includes(sourceField) ? "BUSINESS_KEY" : "NONE",
  }));
}

function platformApiMappings() {
  const application = API_APPLICATION_FIELDS.map((sourceField) => mapping({
    sourceCode: DATA_SOURCE_CODES.PLATFORM_CONNECTOR,
    datasetCode: DATASET_CODES.PLATFORM_API_CONTROL,
    sourceRelation: "app.platform_api_application_profiles",
    sourceField,
    canonicalField: `api_application.${sourceField}`,
    mode: FIELD_MAPPING_MODE.DIRECT,
    publicationScope: sourceField.endsWith("_encrypted") ? "NONE" : "MODULE_LOCAL",
    sensitivity: sourceField === "credential_reference" ? FIELD_SENSITIVITY.CONFIDENTIAL : FIELD_SENSITIVITY.INTERNAL,
    identityRole: sourceField === "account_id" ? "CANONICAL_ID" : "NONE",
  }));
  const shops = CONNECTOR_SHOP_FIELDS.map((sourceField) => mapping({
    sourceCode: DATA_SOURCE_CODES.PLATFORM_CONNECTOR,
    datasetCode: DATASET_CODES.PLATFORM_API_CONTROL,
    sourceRelation: "connector.connector_shops",
    sourceField,
    canonicalField: `connector_shop.${sourceField}`,
    mode: FIELD_MAPPING_MODE.NORMALIZE,
    transformCode: sourceField === "shop_name" ? "shop_name_nfkc_lower_v1" : "identity_v1",
    publicationScope: sourceField.endsWith("_encrypted") ? "NONE" : "MODULE_LOCAL",
    identityRole: sourceField === "id" || sourceField === "seller_id" ? "BUSINESS_KEY" : "NONE",
  }));
  const authorization = CONNECTOR_AUTH_FIELDS.map((sourceField) => mapping({
    sourceCode: DATA_SOURCE_CODES.PLATFORM_CONNECTOR,
    datasetCode: DATASET_CODES.PLATFORM_API_CONTROL,
    sourceRelation: "connector.connector_shop_authorizations",
    sourceField,
    canonicalField: sourceField.endsWith("_encrypted") ? `restricted.connector_authorization.${sourceField}` : `connector_authorization.${sourceField}`,
    mode: sourceField.endsWith("_encrypted") ? FIELD_MAPPING_MODE.REDACT : FIELD_MAPPING_MODE.DIRECT,
    publicationScope: sourceField.endsWith("_encrypted") ? "NONE" : "MODULE_LOCAL",
    sensitivity: sourceField.endsWith("_encrypted") ? FIELD_SENSITIVITY.RESTRICTED : FIELD_SENSITIVITY.CONFIDENTIAL,
    identityRole: sourceField === "shop_id" || sourceField === "application_id" ? "FOREIGN_KEY" : "NONE",
    description: sourceField.endsWith("_encrypted") ? "密文仍只留在 Connector 控制面，业务库不复制。" : "",
  }));
  return [...application, ...shops, ...authorization];
}

export const UNIFIED_SOURCE_FIELD_MAPPINGS = Object.freeze([
  ...orderMappings(),
  ...inventoryMappings(),
  ...productPackageMappings(),
  ...priceMappings(),
  ...shopMappings(),
  ...platformApiMappings(),
]);

export const UNIFIED_IDENTITY_RULES = Object.freeze([
  Object.freeze({
    code: "SHOP_MABANG_TO_CANONICAL_V1",
    ruleKind: "IDENTITY",
    canonicalEntityType: "SHOP",
    sourceKeyVersion: "shop_platform_name_v1",
    allowedMatchMethods: ["PLATFORM_COUNTRY_NAME", "MANUAL"],
    sourceDatasetCode: DATASET_CODES.MABANG_ORDER_FACTS,
    targetDatasetCode: DATASET_CODES.SHOP_MASTER_CURRENT,
    sourceKeys: ["shop.platform", "shop.source_shop_name"],
    targetKeys: ["shop.platform", "shop.normalized_shop_name"],
    cardinality: "MANY_ORDERS_TO_ONE_SHOP",
    acceptance: "AUTO_ONLY_WHEN_TARGET_IS_UNIQUE",
    conflict: "REVIEW_REQUIRED",
  }),
  Object.freeze({
    code: "WAREHOUSE_MABANG_TO_CANONICAL_V1",
    ruleKind: "IDENTITY",
    canonicalEntityType: "WAREHOUSE",
    sourceKeyVersion: "warehouse_name_v1",
    allowedMatchMethods: ["WAREHOUSE_NAME", "MANUAL"],
    sourceDatasetCode: DATASET_CODES.MABANG_INVENTORY_CURRENT,
    targetDatasetCode: DATASET_CODES.PRODUCT_PACKAGE_CURRENT,
    sourceKeys: ["warehouse.source_warehouse_name"],
    targetKeys: ["product.warehouse_raw"],
    cardinality: "MANY_INVENTORY_ROWS_TO_ONE_WAREHOUSE",
    acceptance: "CONFIRMED_ACTIVE_WAREHOUSE_MAPPING_ONLY",
    conflict: "BLOCK_COUNTRY_DERIVATION",
  }),
  Object.freeze({
    code: "INVENTORY_PACKAGE_WAREHOUSE_SKU_V1",
    ruleKind: "IDENTITY",
    canonicalEntityType: "PRODUCT_SKU",
    sourceKeyVersion: "inventory_warehouse_sku_v1",
    allowedMatchMethods: ["WAREHOUSE_SKU", "MANUAL"],
    sourceDatasetCode: DATASET_CODES.MABANG_INVENTORY_CURRENT,
    targetDatasetCode: DATASET_CODES.PRODUCT_PACKAGE_CURRENT,
    sourceKeys: ["warehouse.source_warehouse_name", "product.source_sku"],
    targetKeys: ["product.warehouse_raw", "product.sku_code"],
    cardinality: "MANY_INVENTORY_ROWS_TO_ONE_COUNTRY_PRODUCT",
    acceptance: "AUTO_ONLY_WHEN_COUNTRY_AND_PRODUCT_ARE_UNIQUE",
    conflict: "AMBIGUOUS_OR_UNMATCHED_QUEUE",
  }),
  Object.freeze({
    code: "PRODUCT_COUNTRY_SKU_V1",
    ruleKind: "IDENTITY",
    canonicalEntityType: "PRODUCT_SKU",
    sourceKeyVersion: "product_country_sku_v1",
    allowedMatchMethods: ["COUNTRY_SKU", "MANUAL"],
    sourceDatasetCode: DATASET_CODES.PRODUCT_PACKAGE_CURRENT,
    targetDatasetCode: DATASET_CODES.PRODUCT_MASTER_CURRENT,
    sourceKeys: ["product.country_raw", "product.sku_code"],
    targetKeys: ["product.country_code", "product.sku_code_normalized"],
    cardinality: "MANY_FACT_ROWS_TO_ONE_PRODUCT",
    acceptance: "AUTO_ONLY_WHEN_TARGET_IS_UNIQUE",
    conflict: "AMBIGUOUS_OR_UNMATCHED_QUEUE",
  }),
  Object.freeze({
    code: "PRICE_TO_SHOP_SCOPE_V1",
    ruleKind: "RELATIONSHIP",
    canonicalEntityType: "SHOP",
    sourceKeyVersion: "price_platform_country_shop_type_v1",
    allowedMatchMethods: ["PLATFORM_COUNTRY_SHOP_TYPE"],
    sourceDatasetCode: DATASET_CODES.PRICE_CONTROL_CURRENT,
    targetDatasetCode: DATASET_CODES.SHOP_MASTER_CURRENT,
    sourceKeys: ["price.platform", "price.country_code", "price.shop_type"],
    targetKeys: ["shop.platform", "shop.country_code", "shop.control_shop_type"],
    cardinality: "ONE_PRICE_SCOPE_TO_MANY_SHOPS",
    acceptance: "INTENTIONAL_ONE_TO_MANY",
    conflict: "ZERO_SHOP_IS_ISSUE",
  }),
  Object.freeze({
    code: "CONNECTOR_SHOP_EXTERNAL_ID_V1",
    ruleKind: "IDENTITY",
    canonicalEntityType: "SHOP",
    sourceKeyVersion: "connector_platform_country_seller_id_v1",
    allowedMatchMethods: ["EXTERNAL_ID", "PLATFORM_COUNTRY_NAME", "MANUAL"],
    sourceDatasetCode: DATASET_CODES.PLATFORM_API_CONTROL,
    targetDatasetCode: DATASET_CODES.SHOP_MASTER_CURRENT,
    sourceKeys: ["connector_shop.platform_id", "connector_shop.country", "connector_shop.seller_id"],
    targetKeys: ["shop.platform", "shop.country_code", "shop.platform_shop_id"],
    cardinality: "ONE_CONNECTOR_SHOP_TO_ONE_CANONICAL_SHOP",
    acceptance: "EXTERNAL_ID_OR_MANUAL_CONFIRMATION",
    conflict: "NEVER_AUTHORIZE_FROM_NAME_ONLY",
  }),
]);

export function unifiedFieldMappingSummary(mappings = UNIFIED_SOURCE_FIELD_MAPPINGS) {
  const bySource = {};
  const modes = {};
  const uniqueFields = new Set();
  for (const item of mappings) {
    bySource[item.sourceCode] = (bySource[item.sourceCode] || 0) + 1;
    modes[item.mode] = (modes[item.mode] || 0) + 1;
    uniqueFields.add(`${item.sourceCode}\u0000${item.sourceRelation}\u0000${item.sourceField}`);
  }
  return Object.freeze({
    mappingCount: mappings.length,
    sourceFieldCount: uniqueFields.size,
    bySource: Object.freeze(bySource),
    modes: Object.freeze(modes),
    identityRuleCount: UNIFIED_IDENTITY_RULES.length,
  });
}

export function validateUnifiedFieldMappings(mappings = UNIFIED_SOURCE_FIELD_MAPPINGS) {
  const ids = new Set();
  for (const item of mappings) {
    if (ids.has(item.id)) throw new TypeError(`duplicate field mapping: ${item.id}`);
    ids.add(item.id);
    if (!Object.values(FIELD_MAPPING_MODE).includes(item.mode)) throw new TypeError(`invalid mapping mode: ${item.mode}`);
    if (item.mode === FIELD_MAPPING_MODE.REDACT && item.publicationScope !== "NONE" && item.sensitivity === FIELD_SENSITIVITY.RESTRICTED) {
      throw new TypeError(`restricted redaction mapping cannot be published: ${item.id}`);
    }
  }
  return unifiedFieldMappingSummary(mappings);
}

validateUnifiedFieldMappings();

export const SOURCE_FIELD_CONTRACTS = Object.freeze({
  [DATA_SOURCE_CODES.MABANG_ORDERS]: ORDER_SOURCE_FIELDS,
  [DATA_SOURCE_CODES.MABANG_INVENTORY]: INVENTORY_SOURCE_FIELDS,
  [DATA_SOURCE_CODES.PRODUCT_PACKAGE_DB]: Object.freeze(PRODUCT_PACKAGE_SOURCE_FIELDS.map((item) => item.column)),
  [DATA_SOURCE_CODES.PRICE_CONTROL_DB]: PRICE_CONTROL_SOURCE_COLUMNS,
  [DATA_SOURCE_CODES.SHOP_MASTER]: SHOP_MASTER_FIELDS,
  [DATA_SOURCE_CODES.PLATFORM_CONNECTOR]: Object.freeze([...API_APPLICATION_FIELDS, ...CONNECTOR_SHOP_FIELDS, ...CONNECTOR_AUTH_FIELDS]),
});
