import { normalizeSku, parseMinorUnits } from "./contracts.mjs";

const DEFAULT_ALIASES = {
  sku: ["库存SKU"],
  country: ["国家"],
  category: ["大品类"],
  platform: ["平台"],
  status: ["控价状态"],
  daily: ["日常控价"],
  dailyApprovedAt: ["日常控价批准时间"],
  event: ["活动价"],
  eventApprovedAt: ["活动价批准时间"],
  mega: ["大促价"],
  megaApprovedAt: ["大促价批准时间"],
  watermark: ["数据水位"],
};

function blocked(code, evidence = {}) {
  return { status: "BLOCKED", code, rows: [], warnings: [], evidence };
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between 1 and ${maximum}`);
  }
  return value;
}

function requiredString(value) {
  return typeof value === "string" && value.length > 0;
}

function aliasValue(row, aliases, name) {
  for (const alias of aliases) {
    if (Object.hasOwn(row, alias)) return row[alias];
  }
  throw new TypeError(`response row is missing ${name}`);
}

function normalizeTimestamp(value, name) {
  if (value == null || value === "") return null;
  if (!requiredString(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp or null`);
  }
  return new Date(value).toISOString();
}

function normalizeMoney(value, scale, name) {
  if (value == null || value === "") return null;
  return parseMinorUnits(value, scale).toString();
}

function path(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, "")}${suffix}`;
}

export class WarehouseControlPriceClient {
  constructor({
    fetchImpl,
    baseUrl,
    getKey,
    timeoutMs = 5_000,
    pageSize = 100,
    maxPages = 100,
    scale = 2,
    fieldAliases = {},
    apiKeyHeader = "x-api-key",
    maxBodyBytes = 1_000_000,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (!requiredString(baseUrl) || !/^https:\/\//.test(baseUrl)) throw new TypeError("baseUrl must be an HTTPS URL");
    if (typeof getKey !== "function") throw new TypeError("getKey is required");
    positiveInteger(timeoutMs, "timeoutMs", 120_000);
    positiveInteger(pageSize, "pageSize", 1_000);
    positiveInteger(maxPages, "maxPages", 1_000);
    positiveInteger(maxBodyBytes, "maxBodyBytes", 10_000_000);
    if (!Number.isSafeInteger(scale) || scale < 0) throw new TypeError("scale must be a non-negative safe integer");
    if (!requiredString(apiKeyHeader)) throw new TypeError("apiKeyHeader is required");

    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.getKey = getKey;
    this.timeoutMs = timeoutMs;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.scale = scale;
    this.apiKeyHeader = apiKeyHeader;
    this.maxBodyBytes = maxBodyBytes;
    this.aliases = Object.fromEntries(Object.entries(DEFAULT_ALIASES).map(([name, aliases]) => {
      const configured = fieldAliases[name];
      const values = configured == null ? aliases : (Array.isArray(configured) ? configured : [configured]);
      if (!values.every(requiredString)) throw new TypeError(`fieldAliases.${name} must contain non-empty strings`);
      return [name, values];
    }));
  }

  async verifyKey({ requestId } = {}) {
    if (!requiredString(requestId)) return blocked("WAREHOUSE_UNAVAILABLE");
    const response = await this.#request(path(this.baseUrl, "/control-prices/verify-key"), requestId);
    if (!response.ok) return response;
    if (!response.payload || response.payload.ok !== true) return blocked("WAREHOUSE_SCHEMA_INVALID", { requestId });
    return { status: "READY", rows: [], warnings: [], evidence: { requestId } };
  }

  async scanPrices({ country, category, skus, watermark, requestId } = {}) {
    if (!requiredString(country) || !Array.isArray(skus) || skus.length === 0 || !requiredString(requestId)) {
      return blocked("WAREHOUSE_SCHEMA_INVALID");
    }
    if (category != null && !requiredString(category)) return blocked("WAREHOUSE_SCHEMA_INVALID");
    if (watermark != null && (!requiredString(watermark) || Number.isNaN(Date.parse(watermark)))) {
      return blocked("WAREHOUSE_SCHEMA_INVALID");
    }

    let requestedSkus;
    try {
      requestedSkus = skus.map(normalizeSku);
    } catch {
      return blocked("WAREHOUSE_SCHEMA_INVALID");
    }
    if (requestedSkus.some((sku) => sku.length === 0)) return blocked("WAREHOUSE_SCHEMA_INVALID");

    const scope = { country, category: category ?? null, skus: requestedSkus };
    let cursor = null;
    let expectedTotal = null;
    let scanWatermark = null;
    const rows = [];
    const cursors = new Set();

    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const query = new URLSearchParams({ platform: "SHOPEE", country });
      if (category != null) query.set("category", category);
      query.set("skus", requestedSkus.join(","));
      if (watermark != null) query.set("watermark", watermark);
      query.set("limit", String(this.pageSize));
      if (cursor != null) query.set("cursor", cursor);
      const response = await this.#request(`${path(this.baseUrl, "/control-prices/scan")}?${query.toString()}`, requestId);
      if (!response.ok) return response;

      let parsed;
      try {
        parsed = this.#parsePage(response.payload);
      } catch {
        return blocked("WAREHOUSE_SCHEMA_INVALID", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (parsed.rows.length > this.pageSize) {
        return blocked("WAREHOUSE_SCHEMA_INVALID", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (expectedTotal == null) expectedTotal = parsed.totalCount;
      if (expectedTotal !== parsed.totalCount) {
        return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (scanWatermark == null) scanWatermark = parsed.watermark;
      if (scanWatermark !== parsed.watermark) {
        return blocked("WAREHOUSE_WATERMARK_CHANGED", { requestId, scope, pageCount: pageIndex + 1 });
      }

      let normalized;
      try {
        normalized = parsed.rows.map((row) => this.#normalizeRow(row));
      } catch {
        return blocked("WAREHOUSE_SCHEMA_INVALID", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (normalized.some((row) => row.watermark !== scanWatermark)) {
        return blocked("WAREHOUSE_WATERMARK_CHANGED", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (normalized.some((row) => row.platform !== "SHOPEE" || row.country !== country
        || (category != null && row.category !== category) || !requestedSkus.includes(row.sku))) {
        return blocked("WAREHOUSE_SCOPE_MISMATCH", { requestId, scope, pageCount: pageIndex + 1 });
      }
      rows.push(...normalized);

      if (!parsed.hasMore) {
        if (rows.length !== expectedTotal) {
          return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: pageIndex + 1 });
        }
        return {
          status: "READY",
          rows,
          warnings: [],
          evidence: { requestId, scope, pageCount: pageIndex + 1, watermark: scanWatermark, totalCount: expectedTotal },
        };
      }
      if (!parsed.nextCursor || cursors.has(parsed.nextCursor)) {
        return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: pageIndex + 1 });
      }
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: this.maxPages });
  }

  async #request(url, requestId) {
    let key;
    try {
      key = await this.getKey();
      if (!requiredString(key)) throw new TypeError("missing key");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { [this.apiKeyHeader]: key, "x-request-id": requestId },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response || !response.ok) return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
      const text = await response.text();
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > this.maxBodyBytes) {
        return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
      }
      try {
        return { ok: true, payload: JSON.parse(text) };
      } catch {
        return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
      }
    } catch {
      return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
    }
  }

  #parsePage(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !Array.isArray(payload.rows) || typeof payload.hasMore !== "boolean"
      || !requiredString(payload.watermark) || Number.isNaN(Date.parse(payload.watermark))
      || !Number.isSafeInteger(payload.totalCount) || payload.totalCount < 0
      || !(payload.nextCursor == null || requiredString(payload.nextCursor))) {
      throw new TypeError("invalid scan page");
    }
    return {
      rows: payload.rows,
      hasMore: payload.hasMore,
      nextCursor: payload.nextCursor ?? null,
      watermark: new Date(payload.watermark).toISOString(),
      totalCount: payload.totalCount,
    };
  }

  #normalizeRow(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("row must be an object");
    const sku = normalizeSku(aliasValue(source, this.aliases.sku, "sku"));
    const country = aliasValue(source, this.aliases.country, "country");
    const category = aliasValue(source, this.aliases.category, "category");
    const platform = aliasValue(source, this.aliases.platform, "platform");
    const status = aliasValue(source, this.aliases.status, "status");
    const watermark = aliasValue(source, this.aliases.watermark, "watermark");
    if (!sku || ![country, category, platform, status, watermark].every(requiredString) || Number.isNaN(Date.parse(watermark))) {
      throw new TypeError("invalid row identity");
    }
    return {
      sku,
      country,
      category,
      platform,
      status,
      dailyMinor: normalizeMoney(aliasValue(source, this.aliases.daily, "daily price"), this.scale, "daily price"),
      eventMinor: normalizeMoney(aliasValue(source, this.aliases.event, "event price"), this.scale, "event price"),
      megaMinor: normalizeMoney(aliasValue(source, this.aliases.mega, "mega price"), this.scale, "mega price"),
      dailyApprovedAt: normalizeTimestamp(aliasValue(source, this.aliases.dailyApprovedAt, "daily approval"), "daily approval"),
      eventApprovedAt: normalizeTimestamp(aliasValue(source, this.aliases.eventApprovedAt, "event approval"), "event approval"),
      megaApprovedAt: normalizeTimestamp(aliasValue(source, this.aliases.megaApprovedAt, "mega approval"), "mega approval"),
      watermark: new Date(watermark).toISOString(),
    };
  }
}
