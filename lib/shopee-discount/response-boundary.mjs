const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const READ_RATE_CODES = new Set(["error_limit", "error_rate_limit", "rate_limit"]);
export const TECHNICAL_CODES = new Set([
  "error_network", "error_data", "error_server", "error_inner",
  "error_system_busy", "system_busy", "error_busy",
]);

export const AUTH_CODES = new Set([
  "error_auth", "error_sign", "error_api_call_restricted",
  "error_partner_key_expired", "error_api_permission", "error_shop",
  "common.error_shop", "error_ashop_api_permission", "error_kyc_auth",
]);

const ITEM_BUSINESS_CODES = [
  "discount.error_assigned_promo_stock", "discount.error_item_abnormal",
  "discount.error_item_under_block_categories", "discount.error_b2c_item_not_allowed",
  "discount.item_status_abnormal", "discount.fail_model_price_check",
  "discount.discount_is_end", "discount.item_in_promotion_too_many",
  "discount.item_in_promotion_too_many_whitelist", "discount.item_purchase_limit_error",
  "discount.item_need_model_id", "discount.item_status_invalid", "discount.item_id_not_exist",
  "discount.item_id_repeated", "discount.model_in_promotion_too_many",
  "discount.model_id_not_exist", "discount.model_id_repeated", "discount.promotion_price_for_vn",
  "discount.promotoin_price_too_high", "discount.promotion_price_too_low",
  "discount.item_exceed_discount_limit", "discount.exceed_discount_item_batch_size",
  "discount.discount_need_promotion_price", "discount.promotion_price_higher_input_price",
  "common.error_not_found", "discount.error_time",
];

const DEFINITE_BUSINESS_BY_PATH = new Map([
  ["/api/v2/discount/add_discount", new Set([
    "discount.discount_end_time_smaller_than_start_time", "discount.discount_period_too_long",
    "discount.discount_period_too_short", "discount.discount_start_time_smaller_than_now",
    "discount.error_holiday_mode", "discount.exceed_max_discount_count",
  ])],
  ["/api/v2/discount/add_discount_item", new Set([
    ...ITEM_BUSINESS_CODES, "discount.error_item_not_enough_stock",
    "discount.error_stock_less_than_mpq", "discount.item_in_other_promotion",
    "discount.item_in_promotion", "discount.model_in_promotion",
  ])],
  ["/api/v2/discount/update_discount_item", new Set([
    ...ITEM_BUSINESS_CODES, "discount.item_not_in_promotion", "discount.model_not_in_promotion",
    "discount.error_update_admin_discount", "discount.error_update_streaming_discount",
  ])],
]);

export function safeRequestId(value, fallback = null) {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : fallback;
}

export function validHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

export function platformErrorCode(data, payload) {
  const value = typeof data?.error === "string" && data.error ? data.error : payload?.error;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isDefiniteBusinessCode(apiPath, code) {
  return DEFINITE_BUSINESS_BY_PATH.get(apiPath)?.has(code) === true;
}
