const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const READ_RATE_CODES = new Set(["error_limit", "error_rate_limit", "rate_limit"]);
export const TECHNICAL_CODES = new Set([
  "error_network", "error_data", "error_server", "error_inner",
  "error_system_busy", "system_busy", "error_busy",
]);

const DEFINITE_DISCOUNT_BUSINESS_CODES = new Set([
  "discount.error_time",
  "discount.error_param",
  "discount.error_item",
  "discount.error_model",
  "discount.error_price",
  "discount.error_stock",
  "discount.error_purchase_limit",
  "discount.error_status",
  "discount.error_conflict",
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

export function isDefiniteBusinessCode(code) {
  return DEFINITE_DISCOUNT_BUSINESS_CODES.has(code);
}
