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
  return { rows: [], cursor: null, hasMore: false, meta: null };
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

export function readCatalog(catalog) {
  const invalid = invalidCatalog();
  const records = catalogRecords(catalog);
  if (!records || records.length === 0) return invalid;

  const normalized = [];
  for (const record of records) {
    const product = normalizeCatalogProduct(record);
    if (!product) return invalid;
    normalized.push(product);
  }

  const enabledProducts = [];
  const mismatches = new Set();
  for (const record of normalized) {
    if (!Object.hasOwn(PRODUCTS, record.name) || !record.enabled) continue;
    enabledProducts.push(record.name);
    if (!catalogParametersMatch(record, PRODUCTS[record.name])) mismatches.add(record.name);
  }
  return { valid: true, enabledProducts: [...new Set(enabledProducts)], mismatches };
}

export function validateResultPage(value, activeKey) {
  if (!isPlainObject(value) || !Array.isArray(value.rows)
      || !value.rows.every((row) => isPlainObject(row))
      || (value.还有更多 === true && (typeof value.游标 !== "string" || value.游标.length === 0))) {
    throw new Error("返回数据格式不正确");
  }
  if (activeKey && value.rows.some((row) => containsExactKey(row, activeKey))) {
    throw new Error("返回数据包含不允许的敏感内容");
  }
  return value;
}

export function productSwitch(currentProduct, nextProduct, result, currentQuery) {
  return currentProduct === nextProduct
    ? { product: currentProduct, result, currentQuery }
    : { product: nextProduct, result: emptyResultState(), currentQuery: null };
}

export function completeSuccessfulExport(state, render) {
  state.error = null;
  render();
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
  const normalizedCursor = normalizeCursor(cursor, errors);
  if (normalizedCursor !== undefined) value.游标 = normalizedCursor;
  return value;
}

function normalizePageSize(value, errors) {
  if (!Number.isInteger(value) || value < 1 || value > 2000) {
    errors.push("页大小必须是 1 到 2000 的整数");
    return value;
  }
  return value;
}

function normalizeCursor(value, errors) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push("游标必须是非空字符串");
    return undefined;
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

function invalidCatalog() {
  return { valid: false, enabledProducts: Object.keys(PRODUCTS), mismatches: new Set(Object.keys(PRODUCTS)) };
}

function catalogRecords(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (!isPlainObject(catalog)) return null;
  const candidate = firstDefined(catalog, ["产品", "产品列表", "products"]);
  if (Array.isArray(candidate)) return candidate;
  if (isPlainObject(candidate)) return Object.entries(candidate).map(([name, value]) => ({
    ...(isPlainObject(value) ? value : {}),
    __catalogName: name,
  }));
  return null;
}

function normalizeCatalogProduct(record) {
  if (!isPlainObject(record)) return null;
  const name = firstDefined(record, ["__catalogName", "产品", "名称", "name", "product"]);
  if (typeof name !== "string" || !name.trim()) return null;
  const enablement = readEnablement(record);
  if (!enablement.ok) return null;
  return { name: name.trim(), enabled: enablement.value, record };
}

function readEnablement(record) {
  const keys = ["启用", "可用", "开放", "enabled", "available", "open"];
  const values = keys.filter((key) => Object.hasOwn(record, key)).map((key) => record[key]);
  if (values.length === 0) return { ok: true, value: true };
  if (values.some((value) => typeof value !== "boolean")) return { ok: false };
  if (values.some((value) => value !== values[0])) return { ok: false };
  return { ok: true, value: values[0] };
}

function catalogParametersMatch(product, schema) {
  const declared = declaredParameters(product.record);
  if (!declared) return false;
  const expectedRequired = new Set(schema.required);
  const expectedOptional = new Set(schema.optional);
  const expectedAll = new Set([...schema.required, ...schema.optional]);
  if (!sameSet(declared.all, expectedAll)) return false;
  if (declared.required && !sameSet(declared.required, expectedRequired)) return false;
  if (declared.optional && !sameSet(declared.optional, expectedOptional)) return false;
  return true;
}

function declaredParameters(record) {
  const required = firstDefined(record, ["必填参数", "required"]);
  const optional = firstDefined(record, ["可选参数", "optional"]);
  if (Array.isArray(required) || Array.isArray(optional)) {
    return parameterGroups(required, optional);
  }

  const params = firstDefined(record, ["参数", "parameters", "params"]);
  if (Array.isArray(params)) {
    const names = parameterNames(params);
    if (!names) return null;
    const hasRequiredFlags = params.some((item) => isPlainObject(item)
      && (Object.hasOwn(item, "必填") || Object.hasOwn(item, "required")));
    if (!hasRequiredFlags) return { all: new Set(names), required: null, optional: null };
    const requiredNames = [];
    const optionalNames = [];
    params.forEach((item, index) => {
      (item.必填 === true || item.required === true ? requiredNames : optionalNames).push(names[index]);
    });
    return parameterSets(requiredNames, optionalNames);
  }
  if (isPlainObject(params)) {
    const nestedRequired = firstDefined(params, ["必填", "required"]);
    const nestedOptional = firstDefined(params, ["可选", "optional"]);
    if (Array.isArray(nestedRequired) || Array.isArray(nestedOptional)) {
      return parameterGroups(nestedRequired, nestedOptional);
    }
    return { all: new Set(Object.keys(params)), required: null, optional: null };
  }
  return null;
}

function parameterGroups(required, optional) {
  const requiredNames = parameterNames(Array.isArray(required) ? required : []);
  const optionalNames = parameterNames(Array.isArray(optional) ? optional : []);
  return requiredNames && optionalNames ? parameterSets(requiredNames, optionalNames) : null;
}

function parameterSets(required, optional) {
  return {
    all: new Set([...required, ...optional]),
    required: new Set(required),
    optional: new Set(optional),
  };
}

function parameterNames(items) {
  const names = [];
  for (const item of items) {
    const name = typeof item === "string" ? item : firstDefined(item, ["名称", "参数", "name"]);
    if (typeof name !== "string" || !name.trim()) return null;
    names.push(name.trim());
  }
  return names;
}

function containsExactKey(value, activeKey) {
  if (typeof value === "string") return value.includes(activeKey);
  if (Array.isArray(value)) return value.some((item) => containsExactKey(item, activeKey));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => key.includes(activeKey) || containsExactKey(item, activeKey));
}

function firstDefined(value, keys) {
  if (!isPlainObject(value)) return undefined;
  for (const key of keys) if (Object.hasOwn(value, key)) return value[key];
  return undefined;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function freezeSchema(required, optional) {
  return Object.freeze({ required: Object.freeze(required), optional: Object.freeze(optional) });
}
