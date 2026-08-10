export const COUNTRIES = Object.freeze(["TH", "PH", "ID", "MY", "VN", "SG", "TW"]);
export const PLATFORMS = Object.freeze(["SHOPEE", "SHOPEE_MALL", "LAZADA", "LAZADA_MALL", "TIKTOK"]);
export const PRODUCTS = Object.freeze({
  日销: freezeSchema(["开始", "结束"], ["店编", "国家", "大品类"]),
  库存: freezeSchema([], ["国家", "大品类", "SKU", "款号", "只看有货"]),
  产品包: freezeSchema([], ["国家", "大品类", "SKU", "款号"]),
  控价: freezeSchema([], ["平台", "国家", "大品类", "SKU"]),
});

const API_FIELDS = new Set(["产品", "参数", "页大小", "游标"]);
const INPUT_FIELDS = new Set(["product", "params", "pageSize", "cursor"]);

export function validateKey(value) {
  return typeof value === "string" && /^zndr_[^\s]+$/.test(value)
    ? { ok: true }
    : { ok: false, errors: ["数据密钥格式无效"] };
}

export function buildQueryRequest(input) {
  if (!isPlainObject(input)) return invalid("查询必须是对象");

  const errors = unknownFieldErrors(input, INPUT_FIELDS, "查询字段");
  const value = normalizeQuery({
    product: input.product,
    params: input.params,
    pageSize: input.pageSize,
    cursor: input.cursor,
  }, errors);

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateQueryPayload(payload) {
  if (!isPlainObject(payload)) return invalid("请求体必须是对象");

  const errors = unknownFieldErrors(payload, API_FIELDS, "顶层字段");
  const value = normalizeQuery({
    product: payload.产品,
    params: payload.参数,
    pageSize: payload.页大小,
    cursor: payload.游标,
  }, errors);

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function emptyResultState() {
  return { rows: [], cursor: null, hasMore: false, meta: {} };
}

export function mergeResultPage(state, response) {
  const previousRows = Array.isArray(state?.rows) ? state.rows : [];
  const pageRows = Array.isArray(response?.rows) ? response.rows : [];
  return {
    rows: [...previousRows, ...pageRows],
    cursor: response?.游标 ?? null,
    hasMore: response?.还有更多 === true,
    meta: {
      product: response?.产品,
      role: response?.角色,
      rowCount: response?.行数,
      durationMs: response?.耗时ms,
      scopeVersion: response?.范围版本,
      watermark: response?.水位,
    },
  };
}

function normalizeQuery({ product, params, pageSize, cursor }, errors) {
  const normalizedProduct = normalizeString(product);
  const schema = Object.hasOwn(PRODUCTS, normalizedProduct) ? PRODUCTS[normalizedProduct] : undefined;
  if (!schema) {
    errors.push("产品无效");
    return undefined;
  }

  const normalizedPageSize = normalizePageSize(pageSize, errors);
  const normalizedParams = normalizeParams(normalizedProduct, params, schema, errors);
  const value = { 产品: normalizedProduct, 参数: normalizedParams, 页大小: normalizedPageSize };
  const normalizedCursor = normalizeString(cursor);
  if (normalizedCursor) value.游标 = normalizedCursor;
  return value;
}

function normalizePageSize(value, errors) {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    errors.push("页大小必须是 1 到 500 的整数");
    return value;
  }
  return value;
}

function normalizeParams(product, params, schema, errors) {
  if (!isPlainObject(params)) {
    errors.push("参数必须是对象");
    return {};
  }

  const allowed = new Set([...schema.required, ...schema.optional]);
  unknownFieldErrors(params, allowed, "参数").forEach((error) => errors.push(error));
  const normalized = {};

  for (const name of schema.required) {
    const value = normalizeString(params[name]);
    if (!value) errors.push(`参数 ${name} 为必填项`);
    else normalized[name] = value;
  }
  for (const name of schema.optional) {
    const rawValue = params[name];
    if (name === "只看有货" && typeof rawValue === "boolean") {
      normalized[name] = rawValue;
      continue;
    }
    const value = normalizeString(rawValue);
    if (value) normalized[name] = value;
  }
  if (product === "控价" && !normalized.平台) normalized.平台 = "SHOPEE";

  validateEnums(normalized, errors);
  if (product === "日销") validateDailySalesDates(normalized, errors);
  return normalized;
}

function validateEnums(params, errors) {
  if (params.国家 && !COUNTRIES.includes(params.国家)) errors.push("国家无效");
  if (params.平台 && !PLATFORMS.includes(params.平台)) errors.push("平台无效");
}

function validateDailySalesDates(params, errors) {
  const start = parseUtcDate(params.开始);
  const end = parseUtcDate(params.结束);
  if (!start || !end) {
    errors.push("开始和结束必须是有效的 YYYY-MM-DD 日期");
    return;
  }
  const inclusiveDays = Math.floor((end - start) / 86_400_000) + 1;
  if (inclusiveDays < 1) errors.push("结束日期不能早于开始日期");
  if (inclusiveDays > 92) errors.push("日销查询日期范围不能超过 92 天");
}

function parseUtcDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? timestamp
    : null;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unknownFieldErrors(value, allowed, label) {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label}不允许 ${key}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(error) {
  return { ok: false, errors: [error] };
}

function freezeSchema(required, optional) {
  return Object.freeze({ required: Object.freeze(required), optional: Object.freeze(optional) });
}
