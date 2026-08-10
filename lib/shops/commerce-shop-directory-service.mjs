import { createHash } from "node:crypto";
import { normalizeCanonicalShopName } from "../data-foundation/unified-normalizers.mjs";

const PLATFORM_MAP = Object.freeze({
  lazada: "LAZADA",
  shopee: "SHOPEE",
  tiktok: "TIKTOK",
  tiktokshop: "TIKTOK",
  "tiktok-shop": "TIKTOK",
  tiktok_shop: "TIKTOK",
  "tiktok shop": "TIKTOK",
});

const COUNTRY_MAP = Object.freeze({
  新加坡: "SG",
  马来: "MY",
  马来西亚: "MY",
  泰国: "TH",
  越南: "VN",
  菲律宾: "PH",
  印尼: "ID",
  印度尼西亚: "ID",
  台湾: "TW",
});

const SHOP_TYPE_MAP = Object.freeze({
  c: "STANDARD",
  "c店": "STANDARD",
  standard: "STANDARD",
  mall: "MALL",
  "mall店": "MALL",
  all: "ALL",
  unknown: "UNKNOWN",
  未获取: "UNKNOWN",
});

const DIRECTORY_SOURCES = new Set(["MANUAL", "SYSTEM", "SPREADSHEET", "API"]);
const PLACEHOLDERS = new Set(["", "-", "—", "未获取", "未知", "null", "undefined"]);
export const SHOP_SITE_DEFAULT_CURRENCY_VERSION = "SHOP_SITE_DEFAULT_CURRENCY_V1";
const SITE_DEFAULT_CURRENCIES = Object.freeze({
  MY: "MYR",
  TH: "THB",
  PH: "PHP",
  SG: "SGD",
  VN: "VND",
  ID: "IDR",
  TW: "TWD",
});

function text(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function optional(value, maxLength = 500) {
  const normalized = text(value, maxLength);
  return PLACEHOLDERS.has(normalized.toLowerCase()) ? null : normalized;
}

function normalizedName(value) {
  return normalizeCanonicalShopName(value);
}

function stableId(platform, shopCode) {
  return `shop:${createHash("sha256").update(`${platform}\u001f${shopCode}`).digest("hex").slice(0, 32)}`;
}

function compactHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16).toUpperCase();
}

function platformValue(value) {
  const raw = text(value, 40);
  const platform = PLATFORM_MAP[raw.toLowerCase()] || raw.toUpperCase();
  if (!new Set(Object.values(PLATFORM_MAP)).has(platform)) throw new TypeError(`Unsupported platform: ${raw || "empty"}`);
  return platform;
}

function countryValue(value) {
  const raw = text(value, 40);
  const country = COUNTRY_MAP[raw] || raw.toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || ["ZZ", "XX"].includes(country)) {
    throw new TypeError(`Invalid shop country: ${raw || "empty"}`);
  }
  return country;
}

function shopTypeValue(value) {
  const raw = text(value, 40).toLowerCase();
  return SHOP_TYPE_MAP[raw] || "UNKNOWN";
}

function siteDefaultCurrency(countryCode) {
  return SITE_DEFAULT_CURRENCIES[countryCode] || null;
}

function normalizeShop(raw, source) {
  const shopCode = text(raw?.shopCode ?? raw?.shop_code ?? raw?.storeCode ?? raw?.店编, 64);
  const shopName = text(raw?.shopName ?? raw?.shop_name ?? raw?.name ?? raw?.店名, 240);
  if (!shopCode) throw new TypeError("shop_code is required");
  if (!shopName) throw new TypeError(`shop_name is required for ${shopCode}`);
  const platform = platformValue(raw?.platform ?? raw?.平台);
  const countryCode = countryValue(raw?.countryCode ?? raw?.country ?? raw?.国家);
  const status = text(raw?.status || "ACTIVE", 20).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  return {
    id: stableId(platform, shopCode),
    platform,
    providerShopId: `directory:${shopCode}`,
    shopCode,
    shopName,
    normalizedShopName: normalizedName(shopName),
    countryCode,
    siteCode: countryCode,
    currency: optional(raw?.currency, 12),
    controlShopType: shopTypeValue(raw?.shopType ?? raw?.shop_type ?? raw?.店铺类型),
    managerName: optional(raw?.managerName ?? raw?.manager ?? raw?.店长, 100),
    seniorManagerName: optional(raw?.seniorManagerName ?? raw?.seniorManager ?? raw?.高级, 100),
    categoryName: optional(raw?.categoryName ?? raw?.category ?? raw?.品类, 120),
    platformShortCode: optional(raw?.platformShortCode ?? raw?.shortCode ?? raw?.店铺短码, 120),
    platformShopId: optional(raw?.platformShopId ?? raw?.sellerId ?? raw?.shopId ?? raw?.店铺id, 160),
    identityStatus: text(raw?.identityStatus, 30).toUpperCase() === "REVIEW_REQUIRED"
      ? "REVIEW_REQUIRED"
      : "CONFIRMED",
    status,
    source,
  };
}

function connectorShortCode(shop) {
  return optional(shop?.metadata?.providerShortCode || shop?.metadata?.shortCode || shop?.metadata?.shopCode, 120);
}

function publicConnectorMetadata(value) {
  const metadata = value && typeof value === "object" ? value : {};
  return {
    ...(optional(metadata.providerShortCode, 120) ? { providerShortCode: optional(metadata.providerShortCode, 120) } : {}),
    ...(optional(metadata.shortCode, 120) ? { shortCode: optional(metadata.shortCode, 120) } : {}),
    ...(optional(metadata.shopCode, 120) ? { shopCode: optional(metadata.shopCode, 120) } : {}),
    ...(optional(metadata.providerStatus, 80) ? { providerStatus: optional(metadata.providerStatus, 80) } : {}),
    ...(optional(metadata.providerLastSyncedAt, 80) ? { providerLastSyncedAt: optional(metadata.providerLastSyncedAt, 80) } : {}),
    ...(metadata.providerVerified === true ? { providerVerified: true } : {}),
    ...(metadata.tokenAvailable === true ? { tokenAvailable: true } : {}),
  };
}

function publicConnectorAuthorization(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [key, maxLength] of [
    ["shopId", 160], ["applicationId", 160], ["credentialGroupId", 160],
    ["expiresAt", 80], ["refreshExpiresAt", 80], ["tokenStatus", 40],
    ["lastRefreshTime", 80], ["createdAt", 80], ["updatedAt", 80],
  ]) {
    const normalized = optional(value[key], maxLength);
    if (normalized) result[key] = normalized;
  }
  if (Number.isInteger(Number(value.version))) result.version = Number(value.version);
  return Object.keys(result).length ? result : null;
}

function publicConnectorShop(value) {
  return {
    id: optional(value?.id, 160),
    platformId: optional(value?.platformId, 80),
    shopName: optional(value?.shopName, 240),
    sellerId: optional(value?.sellerId, 160),
    country: optional(value?.country, 40),
    region: optional(value?.region, 120),
    status: optional(value?.status, 40),
    metadata: publicConnectorMetadata(value?.metadata),
    authorization: publicConnectorAuthorization(value?.authorization),
    createdAt: optional(value?.createdAt, 80),
    updatedAt: optional(value?.updatedAt, 80),
  };
}

function normalizePlatformGatewayShop(raw) {
  const connector = publicConnectorShop(raw);
  if (!connector.id) throw new TypeError("Connector shop id is required");
  if (!connector.sellerId) throw new TypeError(`Connector seller_id is required for ${connector.id}`);
  if (!connector.shopName) throw new TypeError(`Connector shop_name is required for ${connector.id}`);
  const platform = platformValue(connector.platformId);
  const countryCode = countryValue(connector.country);
  const providerCode = connectorShortCode(connector);
  // Keep the persisted API projection key independent from a human/business
  // shop code. Provider codes remain display evidence and cannot become an
  // identity key or collide with the registry's global shop_code index.
  const shopCode = `API-${platform}-${compactHash(connector.id)}`;
  const currency = siteDefaultCurrency(countryCode);
  return {
    id: stableId(platform, `connector:${connector.id}`),
    platform,
    providerShopId: `connector:${connector.id}`,
    shopCode,
    shopName: connector.shopName,
    normalizedShopName: normalizedName(connector.shopName),
    countryCode,
    siteCode: countryCode,
    currency,
    currencySource: currency ? "SITE_DEFAULT" : "UNKNOWN",
    currencySourceVersion: SHOP_SITE_DEFAULT_CURRENCY_VERSION,
    currencyIsOrderSettlementCurrency: false,
    controlShopType: "UNKNOWN",
    managerName: null,
    seniorManagerName: null,
    categoryName: null,
    platformShortCode: providerCode,
    platformShopId: connector.sellerId,
    platformConnectorShopId: connector.id,
    identityStatus: "CONFIRMED",
    status: String(connector.status || "").toLowerCase() === "active" ? "ACTIVE" : "INACTIVE",
    source: "API",
  };
}

function connectorIdentity(value) {
  const connector = publicConnectorShop(value);
  const platform = platformValue(connector.platformId);
  const countryCode = countryValue(connector.country);
  if (!connector.id || !connector.sellerId || !connector.shopName) {
    throw new TypeError("Platform Gateway shop identity is incomplete");
  }
  return { connector, platform, countryCode };
}

function strongRegistryOverlay({ connector, platform, countryCode }, registryShops, duplicateConnectorKeys) {
  const connectorKey = `${platform}\u001f${countryCode}\u001f${connector.sellerId}`;
  const bound = registryShops.filter((shop) => shop.platformConnectorShopId === connector.id);
  const byIdentity = registryShops.filter((shop) =>
    shop.platform === platform
      && shop.countryCode === countryCode
      && String(shop.platformShopId || "") === connector.sellerId);
  const candidates = [...new Map([...bound, ...byIdentity].map((shop) => [shop.id, shop])).values()];
  let reason = duplicateConnectorKeys.has(connectorKey) ? "DUPLICATE_CONNECTOR_STRONG_IDENTITY" : null;
  if (!reason && candidates.length > 1) reason = "STRONG_CONNECTOR_ID_CONFLICT";
  const shop = candidates.length === 1 ? candidates[0] : null;
  if (!reason && shop && (
    shop.platform !== platform
      || shop.countryCode !== countryCode
      || (shop.platformShopId && String(shop.platformShopId) !== connector.sellerId)
      || (shop.platformConnectorShopId && shop.platformConnectorShopId !== connector.id)
  )) reason = "STRONG_CONNECTOR_ID_CONFLICT";
  if (!reason && shop?.identityStatus === "REVIEW_REQUIRED") {
    reason = shop.sourceMetadata?.identityReview?.reason || "PERSISTED_IDENTITY_REVIEW_REQUIRED";
  }
  return {
    shop,
    matchedBy: shop
      ? bound.some((candidate) => candidate.id === shop.id) ? "connector_shop_id" : "platform_country_seller_id"
      : null,
    reviewRequired: Boolean(reason),
    reason,
  };
}

function connectorMap(connectorShops) {
  const byPlatform = new Map();
  for (const raw of connectorShops) {
    const shop = publicConnectorShop(raw);
    let platform;
    try { platform = platformValue(shop.platformId); } catch { continue; }
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform).push(shop);
  }
  return byPlatform;
}

function exactOne(items) {
  return items.length === 1 ? items[0] : null;
}

function matchConnector(shop, candidates) {
  const byBoundId = shop.platformConnectorShopId
    ? candidates.filter((candidate) => candidate.id === shop.platformConnectorShopId)
    : [];
  const bySellerId = shop.platformShopId
    ? candidates.filter((candidate) =>
        text(candidate.sellerId) === shop.platformShopId
          && text(candidate.country).toUpperCase() === shop.countryCode)
    : [];
  const strongCandidateIds = new Set([...byBoundId, ...bySellerId].map((candidate) => candidate.id));
  if (strongCandidateIds.size > 1 || byBoundId.length > 1 || bySellerId.length > 1) {
    return { connector: null, matchedBy: null, reviewRequired: true, reason: "STRONG_CONNECTOR_ID_CONFLICT" };
  }
  let connector = exactOne(byBoundId) || exactOne(bySellerId);
  let matchedBy = connector ? (byBoundId.includes(connector) ? "binding" : "platform_country_seller_id") : null;

  // A single matching strong key is not enough when another persisted strong
  // key explicitly disagrees with the selected Connector row. Fail closed so a
  // stale binding cannot silently override seller/shop identity evidence.
  if (connector && (
    (shop.platformConnectorShopId && connector.id !== shop.platformConnectorShopId)
      || (shop.platformShopId && (
        text(connector.sellerId) !== shop.platformShopId
          || text(connector.country).toUpperCase() !== shop.countryCode
      ))
  )) {
    return { connector: null, matchedBy: null, reviewRequired: true, reason: "STRONG_CONNECTOR_ID_CONFLICT" };
  }

  const sameNameCountry = candidates.filter((candidate) =>
    text(candidate.country).toUpperCase() === shop.countryCode
      && normalizedName(candidate.shopName) === shop.normalizedShopName);
  if (!connector && !shop.platformShopId && !shop.platformConnectorShopId) {
    connector = exactOne(sameNameCountry);
    if (connector) matchedBy = "name_country";
  }

  if (connector && matchedBy === "name_country") {
    return { connector, matchedBy, reviewRequired: true, reason: "NAME_COUNTRY_REQUIRES_CONFIRMATION" };
  }

  if (connector && text(connector.country).toUpperCase() !== shop.countryCode) {
    return { connector, matchedBy, reviewRequired: true, reason: "COUNTRY_MISMATCH" };
  }
  if (!connector && (shop.platformShopId || shop.platformConnectorShopId) && sameNameCountry.length) {
    return { connector: null, matchedBy: null, reviewRequired: true, reason: "PLATFORM_ID_MISMATCH" };
  }
  if (!connector && (bySellerId.length > 1 || sameNameCountry.length > 1)) {
    return { connector: null, matchedBy: null, reviewRequired: true, reason: "AMBIGUOUS_CONNECTOR_MATCH" };
  }
  return { connector, matchedBy, reviewRequired: false, reason: connector ? null : "NOT_CONNECTED" };
}

function authorizationState(match, nowMs, platform, delegatedStatus = null) {
  if (match.reviewRequired) return { code: "REVIEW_REQUIRED", label: "待核对", callable: false };
  if (!match.connector) return { code: "NOT_AUTHORIZED", label: "未授权", callable: false };
  if (platform?.type === "shopee") {
    const tokenAvailable = delegatedStatus?.available
      ? delegatedStatus.shop?.hasToken === true
      : match.connector.metadata?.tokenAvailable === true;
    if (tokenAvailable) {
      const callable = platform?.connectorRegistered === true && platform?.status === "active" && match.connector.status === "active";
      return { code: "AUTHORIZED", label: "已授权", callable, delegated: true };
    }
    return { code: "NOT_AUTHORIZED", label: "未授权", callable: false, delegated: true };
  }
  const authorization = match.connector.authorization;
  if (!authorization) return { code: "NOT_AUTHORIZED", label: "未授权", callable: false };
  const expiresAt = Date.parse(authorization.expiresAt || "");
  if (authorization.tokenStatus === "active" && Number.isFinite(expiresAt) && expiresAt > nowMs) {
    const callable = platform?.connectorRegistered === true && platform?.status === "active" && match.connector.status === "active";
    return { code: "AUTHORIZED", label: "已授权", callable };
  }
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    return { code: "EXPIRED", label: "授权已过期", callable: false };
  }
  return { code: "AUTHORIZATION_ERROR", label: "授权异常", callable: false };
}

function shopTypeLabel(value) {
  return value === "STANDARD" ? "C店" : value === "MALL" ? "Mall店" : value === "ALL" ? "全部" : "未获取";
}

export class CommerceShopDirectoryService {
  constructor({ repository, platformGatewayService, authorizationStatusProviders = new Map(), now = () => new Date() } = {}) {
    if (!repository) throw new TypeError("Commerce shop repository is required");
    if (!platformGatewayService) throw new TypeError("Platform Gateway service is required");
    this.repository = repository;
    this.platformGatewayService = platformGatewayService;
    this.authorizationStatusProviders = authorizationStatusProviders;
    this.now = now;
  }

  async #assertReady() {
    if (!await this.repository.isDirectoryReady()) {
      const error = new Error("Commerce shop directory migration is required.");
      error.code = "COMMERCE_SHOP_DIRECTORY_MIGRATION_REQUIRED";
      error.status = 503;
      throw error;
    }
  }

  async #synchronizeConnectorProjection(registryShops, observedAt) {
    const connectors = connectorMap(this.platformGatewayService.listShops());
    const matches = registryShops.map((shop) => {
      const match = matchConnector(shop, connectors.get(shop.platform) || []);
      return {
        shop,
        match: shop.identityStatus === "REVIEW_REQUIRED"
          ? { ...match, reviewRequired: true, reason: match.reason || "PERSISTED_IDENTITY_REVIEW_REQUIRED" }
          : match,
      };
    });
    const result = await this.repository.synchronizeConnectorProjection({
      observedAt,
      bindings: matches.map(({ shop, match }) => ({
        id: shop.id,
        connectorShopId: match.connector?.id || null,
        platformShopId: match.connector?.sellerId || null,
        platformShortCode: connectorShortCode(match.connector),
        reviewRequired: match.reviewRequired,
        clearBinding: !match.connector && !match.reviewRequired,
      })),
    });
    return { ...result, matches };
  }

  async synchronizeFromPlatformGateway() {
    await this.#assertReady();
    const connectorShops = this.platformGatewayService.listShops();
    if (!Array.isArray(connectorShops) || connectorShops.length > 1000) {
      throw new TypeError("Platform Gateway shops must be an array with at most 1000 rows");
    }
    const normalized = [];
    const rejected = [];
    for (const [index, raw] of connectorShops.entries()) {
      try { normalized.push(normalizePlatformGatewayShop(raw)); }
      catch (error) { rejected.push({ index, connectorShopId: optional(raw?.id, 160), reason: error.message }); }
    }
    const observedAt = this.now().toISOString();
    const result = await this.repository.upsertDirectoryShops({ shops: normalized, source: "API", observedAt });
    const synchronizedIds = new Set([
      ...normalized.map((shop) => shop.id),
      ...(result.results || []).map((item) => item.id),
    ]);
    const registryShops = (await this.repository.list({})).filter((shop) => synchronizedIds.has(shop.id));
    const connectorProjection = await this.#synchronizeConnectorProjection(registryShops, observedAt);
    return {
      ...result,
      source: "API",
      observed: connectorShops.length,
      connectorProjectionUpdated: connectorProjection.updated,
      rejected,
      observedAt,
    };
  }

  async synchronize({ source = "SYSTEM", shops } = {}) {
    // An explicit sync without an uploaded row set adopts the registered
    // Platform Gateway shop catalog. Manual/spreadsheet callers continue to
    // pass an array and retain their existing import behavior.
    if (shops === undefined) return this.synchronizeFromPlatformGateway();
    await this.#assertReady();
    const normalizedSource = text(source, 40).toUpperCase();
    if (!DIRECTORY_SOURCES.has(normalizedSource)) throw new TypeError("Unsupported shop directory source");
    if (!Array.isArray(shops) || shops.length > 1000) throw new TypeError("shops must be an array with at most 1000 rows");
    const normalized = [];
    const rejected = [];
    for (const [index, raw] of shops.entries()) {
      try { normalized.push(normalizeShop(raw, normalizedSource)); }
      catch (error) { rejected.push({ index, shopCode: text(raw?.shopCode ?? raw?.店编, 64) || null, reason: error.message }); }
    }
    const observedAt = this.now().toISOString();
    const result = await this.repository.upsertDirectoryShops({ shops: normalized, source: normalizedSource, observedAt });
    const synchronizedIds = new Set([
      ...normalized.map((shop) => shop.id),
      ...(result.results || []).map((item) => item.id),
    ]);
    const registryShops = (await this.repository.list({})).filter((shop) => synchronizedIds.has(shop.id));
    const connectorProjection = await this.#synchronizeConnectorProjection(registryShops, observedAt);
    return { ...result, connectorProjectionUpdated: connectorProjection.updated, rejected, observedAt };
  }

  createManual(shop) {
    return this.synchronize({ source: "MANUAL", shops: [shop] });
  }

  async list(filters = {}) {
    await this.#assertReady();
    const registryShops = await this.repository.list({});
    const connectorIdentities = [];
    for (const raw of this.platformGatewayService.listShops()) {
      try { connectorIdentities.push(connectorIdentity(raw)); } catch { /* invalid API identity is not publishable */ }
    }
    const connectorIdentityCounts = new Map();
    for (const item of connectorIdentities) {
      const key = `${item.platform}\u001f${item.countryCode}\u001f${item.connector.sellerId}`;
      connectorIdentityCounts.set(key, (connectorIdentityCounts.get(key) || 0) + 1);
    }
    const duplicateConnectorKeys = new Set([...connectorIdentityCounts]
      .filter(([, count]) => count > 1).map(([key]) => key));
    const platforms = new Map();
    for (const platform of this.platformGatewayService.listPlatforms()) {
      try { platforms.set(platformValue(platform.type || platform.id), platform); } catch { /* planned non-shop providers */ }
    }
    const delegatedStatuses = new Map();
    for (const [platform, provider] of this.authorizationStatusProviders) {
      try {
        const result = await provider.listShops();
        delegatedStatuses.set(platform, {
          available: true,
          shops: new Map((result.shops || []).map((shop) => [text(shop.shopId), shop])),
        });
      } catch (error) {
        delegatedStatuses.set(platform, { available: false, errorCode: error?.code || "STATUS_PROVIDER_UNAVAILABLE", shops: new Map() });
      }
    }
    const observedAt = this.now().toISOString();
    const nowMs = Date.parse(observedAt);
    const rows = connectorIdentities.map((identity) => {
      const { connector, platform: canonicalPlatform, countryCode } = identity;
      const overlay = strongRegistryOverlay(identity, registryShops, duplicateConnectorKeys);
      const shop = overlay.shop;
      const match = { connector, ...overlay };
      const platformId = canonicalPlatform === "TIKTOK" ? "tiktok-shop" : canonicalPlatform.toLowerCase();
      const platform = platforms.get(canonicalPlatform);
      const delegatedBucket = delegatedStatuses.get(canonicalPlatform);
      const delegatedStatus = delegatedBucket
        ? { available: delegatedBucket.available, shop: delegatedBucket.shops.get(text(connector.sellerId)) }
        : null;
      const state = authorizationState(match, nowMs, platform, delegatedStatus);
      const defaultCurrency = siteDefaultCurrency(countryCode);
      const providerCode = optional(connectorShortCode(connector), 64);
      const currency = defaultCurrency;
      const currencySource = defaultCurrency ? "SITE_DEFAULT" : "UNKNOWN";
      return {
        id: connector.id,
        directoryShopId: shop?.id || null,
        platformId,
        shopCode: providerCode || `API-${canonicalPlatform}-${compactHash(connector.id)}`,
        shopName: connector.shopName,
        sellerId: connector.sellerId,
        country: countryCode,
        region: connector.region || "",
        status: String(connector.status || "inactive").toLowerCase(),
        currency,
        siteDefaultCurrency: defaultCurrency,
        currencySource,
        currencySourceVersion: SHOP_SITE_DEFAULT_CURRENCY_VERSION,
        currencyIsOrderSettlementCurrency: false,
        managerName: shop?.managerName || null,
        seniorManagerName: shop?.seniorManagerName || null,
        categoryName: shop?.categoryName || null,
        shopType: shop?.controlShopType || "UNKNOWN",
        shopTypeLabel: shopTypeLabel(shop?.controlShopType || "UNKNOWN"),
        platformShortCode: connectorShortCode(connector),
        platformConnectorShopId: connector.id,
        identityStatus: match.reviewRequired ? "REVIEW_REQUIRED" : "CONFIRMED",
        identityIssue: match.reason || null,
        authorizationStatus: state.code,
        authorizationLabel: state.label,
        callable: state.callable,
        authorizationDelegated: state.delegated === true,
        authorization: publicConnectorAuthorization(connector.authorization),
        metadata: {
          ...connector.metadata,
          directorySource: shop?.directorySource || null,
          matchedBy: match.matchedBy,
        },
        createdAt: connector.createdAt || shop?.createdAt || null,
        updatedAt: connector.updatedAt || shop?.updatedAt || null,
        authorizationSyncedAt: observedAt,
      };
    }).filter((row) => {
      if (filters.platform && row.platformId !== String(filters.platform).trim().toLowerCase().replace("_", "-")) return false;
      if (filters.country && row.country !== countryValue(filters.country)) return false;
      if (filters.status && row.status !== text(filters.status).toLowerCase()) return false;
      return true;
    });
    const search = normalizedName(filters.search || "");
    return search ? rows.filter((row) => [row.shopCode, row.shopName, row.sellerId, row.platformShortCode]
      .some((value) => normalizedName(value).includes(search))) : rows;
  }
}

export { normalizeShop };
