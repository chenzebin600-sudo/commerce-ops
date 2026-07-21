export const MODULE_IDS = Object.freeze({
  COMPETITOR_LINK: "competitor_link",
  COMPETITOR_KEYWORD: "competitor_keyword",
  ADVERTISING: "advertising",
  MABANG_ORDERS: "mabang_orders",
  MABANG_INVENTORY: "mabang_inventory",
  SCHEDULED_EXPORTS: "scheduled_exports",
  FILE_MANAGEMENT: "file_management",
  OPERATION_AUDIT: "operation_audit",
  PRODUCT_CENTER: "product_center",
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
