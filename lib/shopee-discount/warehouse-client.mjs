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
const PRIVATE_RELAY_ORIGIN = "http://10.110.80.95:8788";
const DEFAULT_SCALES_BY_COUNTRY = Object.freeze({ TH: 2, PH: 2, MY: 2, SG: 2, TW: 0, VN: 0, ID: 0 });

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
  return parseMinorUnits(String(value), scale).toString();
}

function path(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, "")}${suffix}`;
}

export function isAllowedWarehouseBaseUrl(value) {
  if (!requiredString(value)) return false;
  try {
    const parsed = new URL(value);
    const normalized = parsed.href.replace(/\/$/, "");
    return (parsed.protocol === "https:" && !parsed.username && !parsed.password)
      || normalized === PRIVATE_RELAY_ORIGIN;
  } catch {
    return false;
  }
}

export function createUnavailableWarehouseControlPriceClient() {
  return Object.freeze({
    async verifyKey() {
      throw Object.assign(new Error("未配置数仓控价接口地址"), {
        code: "SHOPEE_DISCOUNT_WAREHOUSE_ENDPOINT_UNCONFIGURED",
      });
    },
    async scanPrices() {
      return blocked("WAREHOUSE_UNAVAILABLE");
    },
  });
}

export class WarehouseControlPriceClient {
  constructor({
    fetchImpl,
    baseUrl,
    getKey,
    timeoutMs = 60_000,
    pageSize = 2_000,
    maxPages = 100,
    scale = 2,
    scalesByCountry = DEFAULT_SCALES_BY_COUNTRY,
    fieldAliases = {},
    apiKeyHeader = "X-Data-Key",
    maxBodyBytes = 1_000_000,
    retryDelaysMs = [10_000],
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (!isAllowedWarehouseBaseUrl(baseUrl)) throw new TypeError("baseUrl must be an approved HTTPS or private relay URL");
    if (typeof getKey !== "function") throw new TypeError("getKey is required");
    positiveInteger(timeoutMs, "timeoutMs", 120_000);
    positiveInteger(pageSize, "pageSize", 2_000);
    positiveInteger(maxPages, "maxPages", 1_000);
    positiveInteger(maxBodyBytes, "maxBodyBytes", 10_000_000);
    if (!Number.isSafeInteger(scale) || scale < 0) throw new TypeError("scale must be a non-negative safe integer");
    if (!scalesByCountry || typeof scalesByCountry !== "object" || Array.isArray(scalesByCountry)
      || Object.entries(scalesByCountry).some(([country, countryScale]) => !requiredString(country)
        || !Number.isSafeInteger(countryScale) || countryScale < 0 || countryScale > 8)) {
      throw new TypeError("scalesByCountry must map countries to non-negative safe integer scales");
    }
    if (!requiredString(apiKeyHeader)) throw new TypeError("apiKeyHeader is required");
    if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length > 3
      || retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 120_000)) {
      throw new TypeError("retryDelaysMs must contain at most three bounded delays");
    }
    if (typeof sleep !== "function") throw new TypeError("sleep is required");

    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.getKey = getKey;
    this.timeoutMs = timeoutMs;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.scale = scale;
    this.scalesByCountry = Object.freeze({ ...scalesByCountry });
    this.apiKeyHeader = apiKeyHeader;
    this.maxBodyBytes = maxBodyBytes;
    this.retryDelaysMs = [...retryDelaysMs];
    this.sleep = sleep;
    this.snapshotCache = new Map();
    this.inFlightScans = new Map();
    this.queryTail = Promise.resolve();
    this.aliases = Object.fromEntries(Object.entries(DEFAULT_ALIASES).map(([name, aliases]) => {
      const configured = fieldAliases[name];
      const values = configured == null ? aliases : (Array.isArray(configured) ? configured : [configured]);
      if (!values.every(requiredString)) throw new TypeError(`fieldAliases.${name} must contain non-empty strings`);
      return [name, values];
    }));
  }

  async verifyKey({ requestId } = {}) {
    if (!requiredString(requestId)) return blocked("WAREHOUSE_UNAVAILABLE");
    const response = await this.#request(path(this.baseUrl, "/api/data/me"), requestId);
    if (!response.ok) return response;
    if (!response.payload || typeof response.payload !== "object" || Array.isArray(response.payload)) {
      return blocked("WAREHOUSE_SCHEMA_INVALID", { requestId });
    }
    return { status: "READY", rows: [], warnings: [], evidence: { requestId } };
  }

  async scanPrices(input = {}) {
    const key = this.#scanKey(input);
    if (key == null) return this.#scanPricesUncoordinated(input);
    let shared = this.inFlightScans.get(key);
    if (!shared) {
      shared = this.#scanPricesUncoordinated(input);
      this.inFlightScans.set(key, shared);
      shared.finally(() => {
        if (this.inFlightScans.get(key) === shared) this.inFlightScans.delete(key);
      }).catch(() => {});
    }
    const result = await shared;
    return {
      ...result,
      rows: [...(result.rows || [])],
      warnings: [...(result.warnings || [])],
      evidence: { ...(result.evidence || {}), requestId: input.requestId },
    };
  }

  #scanKey({ country, category, skus, watermark, requestId } = {}) {
    if (!requiredString(country) || !requiredString(requestId) || !Array.isArray(skus) || skus.length === 0
      || (category != null && !requiredString(category))) return null;
    try {
      return JSON.stringify([country, category ?? null, skus.map(normalizeSku), watermark == null ? null : new Date(watermark).toISOString()]);
    } catch { return null; }
  }

  async #scanPricesUncoordinated({ country, category, skus, watermark, requestId } = {}) {
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
    if (requestedSkus.length > 1) {
      const combinedRows = [];
      const warnings = [];
      let pinnedWatermark = watermark == null ? null : new Date(watermark).toISOString();
      let pageCount = 0;
      for (const sku of requestedSkus) {
        const result = await this.scanPrices({ country, category, skus: [sku], watermark: pinnedWatermark, requestId });
        if (result.status !== "READY") return { ...result, evidence: { ...(result.evidence || {}), scope } };
        pinnedWatermark ||= result.evidence.watermark;
        pageCount += result.evidence.pageCount;
        combinedRows.push(...result.rows);
        warnings.push(...result.warnings);
      }
      return {
        status: "READY", rows: combinedRows, warnings,
        evidence: { requestId, scope, pageCount, watermark: pinnedWatermark, totalCount: combinedRows.length },
      };
    }
    const cacheKey = `${requestId}\u001f${country}\u001f${category ?? ""}\u001f${requestedSkus[0]}`;
    const cached = cacheKey ? this.snapshotCache.get(cacheKey) : null;
    if (cached) {
      if (watermark != null && cached.evidence.watermark !== new Date(watermark).toISOString()) {
        return blocked("WAREHOUSE_WATERMARK_CHANGED", { requestId, scope, pageCount: cached.evidence.pageCount });
      }
      const filtered = cached.rows.filter((row) => requestedSkus.includes(row.sku));
      return { status: "READY", rows: filtered, warnings: [], evidence: { ...cached.evidence, scope, totalCount: filtered.length } };
    }
    let cursor = null;
    let expectedTotal = null;
    let scanWatermark = null;
    const rows = [];
    const cursors = new Set();

    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const parameters = { 平台: "SHOPEE", 国家: country };
      if (category != null) parameters.大品类 = category;
      if (requestedSkus.length === 1) parameters.SKU = requestedSkus[0];
      const body = { 产品: "控价", 参数: parameters, 页大小: this.pageSize };
      if (cursor != null) body.游标 = cursor;
      const response = await this.#request(path(this.baseUrl, "/api/data/query"), requestId, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
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
      if (parsed.hasMore && parsed.rows.length !== this.pageSize) {
        return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (parsed.totalCount != null && expectedTotal == null) expectedTotal = parsed.totalCount;
      if (parsed.totalCount != null && expectedTotal !== parsed.totalCount) {
        return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (scanWatermark == null) scanWatermark = parsed.watermark;
      if (scanWatermark !== parsed.watermark) {
        return blocked("WAREHOUSE_WATERMARK_CHANGED", { requestId, scope, pageCount: pageIndex + 1 });
      }

      const normalized = [];
      const countryScale = this.scalesByCountry[country] ?? this.scale;
      for (const row of parsed.rows) {
        try {
          normalized.push(this.#normalizeRow(row, parsed.watermark, countryScale));
        } catch {
          let malformedSku = null;
          try { malformedSku = normalizeSku(aliasValue(row, this.aliases.sku, "sku")); } catch { /* unrelated malformed row */ }
          if (malformedSku && requestedSkus.includes(malformedSku)) {
            return blocked("WAREHOUSE_SCHEMA_INVALID", { requestId, scope, pageCount: pageIndex + 1 });
          }
        }
      }
      if (normalized.some((row) => row.watermark !== scanWatermark)) {
        return blocked("WAREHOUSE_WATERMARK_CHANGED", { requestId, scope, pageCount: pageIndex + 1 });
      }
      if (normalized.some((row) => requestedSkus.includes(row.sku)
        && (row.platform !== "SHOPEE" || row.country !== country
          || (category != null && row.category !== category)))) {
        return blocked("WAREHOUSE_SCOPE_MISMATCH", { requestId, scope, pageCount: pageIndex + 1 });
      }
      rows.push(...normalized.filter((row) => row.platform === "SHOPEE" && row.country === country
        && (category == null || row.category === category)));

      if (!parsed.hasMore) {
        if (expectedTotal != null && rows.length !== expectedTotal) {
          return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: pageIndex + 1 });
        }
        const filtered = rows.filter((row) => requestedSkus.includes(row.sku));
        const result = {
          status: "READY",
          rows: filtered,
          warnings: [],
          evidence: { requestId, scope, pageCount: pageIndex + 1, watermark: scanWatermark, totalCount: filtered.length },
        };
        if (cacheKey) {
          if (this.snapshotCache.size >= 32) this.snapshotCache.delete(this.snapshotCache.keys().next().value);
          this.snapshotCache.set(cacheKey, { rows: [...rows], evidence: { ...result.evidence, totalCount: rows.length } });
        }
        return result;
      }
      if (!parsed.nextCursor || cursors.has(parsed.nextCursor)) {
        return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: pageIndex + 1 });
      }
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    return blocked("WAREHOUSE_PAGINATION_INCOMPLETE", { requestId, scope, pageCount: this.maxPages });
  }

  async #request(url, requestId, options = {}) {
    if (!url.endsWith("/api/data/query")) return this.#requestNow(url, requestId, options);
    const previous = this.queryTail;
    let release;
    this.queryTail = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await this.#requestNow(url, requestId, options); }
    finally { release(); }
  }

  async #requestNow(url, requestId, options = {}) {
    try {
      const key = await this.getKey();
      if (!requiredString(key)) throw new TypeError("missing key");
      for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await this.fetchImpl(url, {
            method: options.method || "GET",
            headers: { [this.apiKeyHeader]: key, "x-request-id": requestId, ...(options.headers || {}) },
            ...(options.body == null ? {} : { body: options.body }),
            signal: controller.signal,
          });
          if (response?.status === 429 && attempt < this.retryDelaysMs.length) {
            await response.body?.cancel?.().catch(() => {});
            await this.sleep(this.retryDelaysMs[attempt]);
            continue;
          }
          if (!response || !response.ok) return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
          const contentLength = response.headers?.get?.("content-length");
          if (contentLength != null && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(this.maxBodyBytes)) {
            await response.body?.cancel?.().catch(() => {});
            return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
          }
          if (!response.body || typeof response.body.getReader !== "function") return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let bytesRead = 0;
          let text = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!(value instanceof Uint8Array)) throw new TypeError("response body chunk must be bytes");
              bytesRead += value.byteLength;
              if (bytesRead > this.maxBodyBytes) {
                await reader.cancel().catch(() => {});
                return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
              }
              text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
          } finally {
            reader.releaseLock?.();
          }
          try {
            return { ok: true, payload: JSON.parse(text) };
          } catch {
            return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
          }
        } finally {
          clearTimeout(timer);
        }
      }
      return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
    } catch {
      return blocked("WAREHOUSE_UNAVAILABLE", { requestId });
    }
  }

  #parsePage(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.rows)) {
      throw new TypeError("invalid scan page");
    }
    const relay = Object.hasOwn(payload, "还有更多") || Object.hasOwn(payload, "源最新");
    const hasMore = relay ? payload.还有更多 : payload.hasMore;
    const nextCursor = relay ? payload.游标 : payload.nextCursor;
    const watermark = relay ? payload.源最新 : payload.watermark;
    const totalCount = relay ? null : payload.totalCount;
    const rowCount = relay ? payload.行数 : payload.rows.length;
    if (typeof hasMore !== "boolean" || !requiredString(watermark) || Number.isNaN(Date.parse(watermark))
      || !(nextCursor == null || requiredString(nextCursor))
      || !Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount !== payload.rows.length
      || (totalCount != null && (!Number.isSafeInteger(totalCount) || totalCount < 0))) {
      throw new TypeError("invalid scan page");
    }
    return {
      rows: payload.rows,
      hasMore,
      nextCursor: nextCursor ?? null,
      watermark: new Date(watermark).toISOString(),
      totalCount,
    };
  }

  #normalizeRow(source, sourceWatermark, scale) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("row must be an object");
    const sku = normalizeSku(aliasValue(source, this.aliases.sku, "sku"));
    const country = aliasValue(source, this.aliases.country, "country");
    const category = aliasValue(source, this.aliases.category, "category");
    const platform = aliasValue(source, this.aliases.platform, "platform");
    const status = aliasValue(source, this.aliases.status, "status");
    const watermark = sourceWatermark;
    if (!sku || ![country, category, platform, status, watermark].every(requiredString) || Number.isNaN(Date.parse(watermark))) {
      throw new TypeError("invalid row identity");
    }
    return {
      sku,
      country,
      category,
      platform,
      status,
      dailyMinor: normalizeMoney(aliasValue(source, this.aliases.daily, "daily price"), scale, "daily price"),
      eventMinor: normalizeMoney(aliasValue(source, this.aliases.event, "event price"), scale, "event price"),
      megaMinor: normalizeMoney(aliasValue(source, this.aliases.mega, "mega price"), scale, "mega price"),
      dailyApprovedAt: normalizeTimestamp(aliasValue(source, this.aliases.dailyApprovedAt, "daily approval"), "daily approval"),
      eventApprovedAt: normalizeTimestamp(aliasValue(source, this.aliases.eventApprovedAt, "event approval"), "event approval"),
      megaApprovedAt: normalizeTimestamp(aliasValue(source, this.aliases.megaApprovedAt, "mega approval"), "mega approval"),
      watermark: new Date(watermark).toISOString(),
    };
  }
}
