export const MODULE_IDS = Object.freeze({
  COMPETITOR_LINK: "competitor_link",
  COMPETITOR_KEYWORD: "competitor_keyword",
  ADVERTISING: "advertising",
  MABANG_ORDERS: "mabang_orders",
  MABANG_INVENTORY: "mabang_inventory",
  MABANG_LISTING: "mabang_listing",
  SCHEDULED_EXPORTS: "scheduled_exports",
  FILE_MANAGEMENT: "file_management",
  OPERATION_AUDIT: "operation_audit",
  PRODUCT_CENTER: "product_center",
  SALES_ASSORTMENT: "sales_assortment",
  PROFIT: "profit",
  PRICE_CONTROL: "price_control",
  FULFILLMENT_AGENT: "fulfillment_agent",
  CUSTOMER_SERVICE: "customer_service",
  PRODUCT_KNOWLEDGE: "product_knowledge",
});

export const MODULE_ID_VALUES = Object.freeze(Object.values(MODULE_IDS));

export const FUTURE_MODULE_IDS = Object.freeze({
  OPERATION_TASKS: "operation_tasks",
  OPPORTUNITY_PRODUCTS: "opportunity_products",
  LISTING_TASKS: "listing_tasks",
});

export function assertModuleId(value) {
  if (!MODULE_ID_VALUES.includes(value)) throw new TypeError("module_id is invalid");
  return value;
}
