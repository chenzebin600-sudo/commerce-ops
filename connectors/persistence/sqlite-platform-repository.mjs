import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ConnectorTokenCipher } from "../security/token-cipher.mjs";

const DEFAULT_PLATFORMS = Object.freeze([
  { id: "lazada", name: "Lazada", type: "lazada", apiVersion: "2.0", status: "active" },
  { id: "shopee", name: "Shopee", type: "shopee", apiVersion: "2.0", status: "planned" },
  { id: "tiktok-shop", name: "TikTok Shop", type: "tiktok_shop", apiVersion: "202309", status: "planned" },
  { id: "mabang", name: "Mabang ERP", type: "mabang", apiVersion: "local", status: "planned" },
]);

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Repository clock returned an invalid date");
  return date.toISOString();
}

function json(value, fallback = {}) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parsed(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function publicPlatform(row) {
  return row ? {
    id: row.id,
    name: row.name,
    type: row.type,
    apiVersion: row.api_version,
    status: row.status,
  } : null;
}

function publicShop(row) {
  return row ? {
    id: row.id,
    platformId: row.platform_id,
    shopName: row.shop_name,
    sellerId: row.seller_id,
    country: row.country,
    region: row.region,
    status: row.status,
    metadata: parsed(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function tokenStatus(expiresAt, currentTime = Date.now()) {
  return expiresAt && Date.parse(expiresAt) > currentTime ? "active" : "expired";
}

export class SqlitePlatformRepository {
  constructor({ databasePath = null, connection = null, encryptionKey, clock = () => new Date() } = {}) {
    if (!connection && !databasePath) throw new TypeError("Connector database path is required");
    if (databasePath && !connection) mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = connection || new DatabaseSync(databasePath);
    this.ownsConnection = !connection;
    this.clock = clock;
    this.cipher = new ConnectorTokenCipher(encryptionKey);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    if (this.ownsConnection) this.db.exec("PRAGMA journal_mode = WAL");
    this.initializeSchema();
    this.seedPlatforms();
  }

  initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connector_platforms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL UNIQUE,
        api_version TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_shops (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL REFERENCES connector_platforms(id),
        shop_name TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        country TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform_id, seller_id, country)
      );
      CREATE INDEX IF NOT EXISTS idx_connector_shops_platform_status
        ON connector_shops(platform_id, status, country);
      CREATE INDEX IF NOT EXISTS idx_connector_shops_seller
        ON connector_shops(seller_id);
      CREATE TABLE IF NOT EXISTS connector_shop_authorizations (
        shop_id TEXT PRIMARY KEY REFERENCES connector_shops(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL,
        credential_group_id TEXT NOT NULL DEFAULT '',
        access_token_encrypted TEXT NOT NULL,
        refresh_token_encrypted TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        refresh_expires_at TEXT,
        token_status TEXT NOT NULL,
        last_refresh_time TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_connector_authorizations_status_expiry
        ON connector_shop_authorizations(token_status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_connector_authorizations_group
        ON connector_shop_authorizations(credential_group_id);
      CREATE TABLE IF NOT EXISTS connector_api_request_logs (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        platform TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        api_name TEXT NOT NULL,
        request_time TEXT NOT NULL,
        response_status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        provider_request_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_connector_api_logs_shop_time
        ON connector_api_request_logs(platform, shop_id, request_time DESC);
      CREATE INDEX IF NOT EXISTS idx_connector_api_logs_status_time
        ON connector_api_request_logs(response_status, request_time DESC);
    `);
    const authorizationColumns = this.db.prepare("PRAGMA table_info('connector_shop_authorizations')").all();
    if (!authorizationColumns.some((column) => column.name === "credential_group_id")) {
      this.db.exec("ALTER TABLE connector_shop_authorizations ADD COLUMN credential_group_id TEXT NOT NULL DEFAULT ''");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_connector_authorizations_group ON connector_shop_authorizations(credential_group_id)");
    }
  }

  seedPlatforms(platforms = DEFAULT_PLATFORMS) {
    const timestamp = nowIso(this.clock);
    const statement = this.db.prepare(`
      INSERT INTO connector_platforms (id, name, type, api_version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        type=excluded.type,
        api_version=excluded.api_version,
        status=CASE WHEN connector_platforms.status='disabled' THEN connector_platforms.status ELSE excluded.status END,
        updated_at=excluded.updated_at
    `);
    for (const item of platforms) {
      statement.run(item.id, item.name, item.type, item.apiVersion, item.status, timestamp, timestamp);
    }
  }

  listPlatforms() {
    return this.db.prepare("SELECT * FROM connector_platforms ORDER BY name").all().map(publicPlatform);
  }

  getPlatform(identifier) {
    const value = String(identifier || "").trim().toLowerCase();
    return publicPlatform(this.db.prepare(`
      SELECT * FROM connector_platforms WHERE lower(id)=? OR lower(type)=? LIMIT 1
    `).get(value, value));
  }

  upsertShop({ platformId, id = null, shopName, sellerId, country, region = "", status = "active", metadata = {} }) {
    const platform = this.getPlatform(platformId);
    if (!platform) throw new Error(`Unknown platform: ${platformId}`);
    const normalizedSeller = String(sellerId || "").trim();
    if (!normalizedSeller) throw new TypeError("Shop seller_id is required");
    const normalizedCountry = String(country || "").trim().toUpperCase();
    const existing = this.db.prepare(`
      SELECT * FROM connector_shops WHERE platform_id=? AND seller_id=? AND country=?
    `).get(platform.id, normalizedSeller, normalizedCountry);
    const shopId = existing?.id || id || crypto.randomUUID();
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO connector_shops (
        id, platform_id, shop_name, seller_id, country, region, status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shop_name=excluded.shop_name,
        seller_id=excluded.seller_id,
        country=excluded.country,
        region=excluded.region,
        status=excluded.status,
        metadata_json=excluded.metadata_json,
        updated_at=excluded.updated_at
    `).run(
      shopId,
      platform.id,
      String(shopName || `${platform.name} ${normalizedCountry} ${normalizedSeller}`).trim(),
      normalizedSeller,
      normalizedCountry,
      String(region || "").trim(),
      String(status || "active").trim().toLowerCase(),
      json(metadata),
      existing?.created_at || timestamp,
      timestamp,
    );
    return this.findShop({ platformId: platform.id, identifier: shopId });
  }

  updateShop(shopId, changes = {}) {
    const current = this.findShop({ identifier: shopId });
    if (!current) return null;
    return this.upsertShop({
      platformId: current.platformId,
      id: current.id,
      shopName: changes.shopName ?? current.shopName,
      sellerId: current.sellerId,
      country: current.country,
      region: changes.region ?? current.region,
      status: changes.status ?? current.status,
      metadata: { ...current.metadata, ...(changes.metadata || {}) },
    });
  }

  findShop({ platformId = null, identifier } = {}) {
    const value = String(identifier || "").trim();
    if (!value) return null;
    const platform = platformId ? this.getPlatform(platformId) : null;
    const row = platform
      ? this.db.prepare(`
          SELECT * FROM connector_shops
          WHERE platform_id=? AND (id=? OR seller_id=?)
          ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1
        `).get(platform.id, value, value, value)
      : this.db.prepare(`
          SELECT * FROM connector_shops WHERE id=? OR seller_id=?
          ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1
        `).get(value, value, value);
    return publicShop(row);
  }

  listShops({ platformId = null, country = null, status = null } = {}) {
    const conditions = [];
    const parameters = [];
    if (platformId) {
      const platform = this.getPlatform(platformId);
      if (!platform) return [];
      conditions.push("platform_id=?");
      parameters.push(platform.id);
    }
    if (country) { conditions.push("country=?"); parameters.push(String(country).toUpperCase()); }
    if (status) { conditions.push("status=?"); parameters.push(String(status).toLowerCase()); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM connector_shops ${where} ORDER BY platform_id, country, shop_name`).all(...parameters).map(publicShop);
  }

  saveAuthorization({
    shopId,
    applicationId,
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt = null,
    tokenStatus: explicitStatus = null,
    lastRefreshTime = null,
    credentialGroupId = null,
  }) {
    return this.saveEncryptedAuthorization({
      shopId,
      applicationId,
      accessTokenEncrypted: this.cipher.encrypt(accessToken),
      refreshTokenEncrypted: this.cipher.encrypt(refreshToken),
      expiresAt,
      refreshExpiresAt,
      tokenStatus: explicitStatus,
      lastRefreshTime,
      credentialGroupId,
    });
  }

  saveEncryptedAuthorization({
    shopId,
    applicationId,
    accessTokenEncrypted,
    refreshTokenEncrypted,
    expiresAt,
    refreshExpiresAt = null,
    tokenStatus: explicitStatus = null,
    lastRefreshTime = null,
    credentialGroupId = null,
  }) {
    if (!this.findShop({ identifier: shopId })) throw new TypeError("Authorization shop does not exist");
    const timestamp = nowIso(this.clock);
    const current = this.db.prepare("SELECT created_at, version FROM connector_shop_authorizations WHERE shop_id=?").get(shopId);
    this.db.prepare(`
      INSERT INTO connector_shop_authorizations (
        shop_id, application_id, credential_group_id, access_token_encrypted, refresh_token_encrypted,
        expires_at, refresh_expires_at, token_status, last_refresh_time, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id) DO UPDATE SET
        application_id=excluded.application_id,
        credential_group_id=excluded.credential_group_id,
        access_token_encrypted=excluded.access_token_encrypted,
        refresh_token_encrypted=excluded.refresh_token_encrypted,
        expires_at=excluded.expires_at,
        refresh_expires_at=excluded.refresh_expires_at,
        token_status=excluded.token_status,
        last_refresh_time=excluded.last_refresh_time,
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(
      shopId,
      String(applicationId || "").trim(),
      String(credentialGroupId || shopId),
      String(accessTokenEncrypted || ""),
      String(refreshTokenEncrypted || ""),
      String(expiresAt || ""),
      refreshExpiresAt || null,
      explicitStatus || tokenStatus(expiresAt),
      lastRefreshTime || null,
      Number(current?.version || 0) + 1,
      current?.created_at || timestamp,
      timestamp,
    );
    return this.getAuthorizationMetadata(shopId);
  }

  getAuthorizationMetadata(shopId) {
    const row = this.db.prepare(`
      SELECT shop_id, application_id, expires_at, refresh_expires_at, token_status,
             credential_group_id, last_refresh_time, version, created_at, updated_at
      FROM connector_shop_authorizations WHERE shop_id=?
    `).get(shopId);
    if (!row) return null;
    return {
      shopId: row.shop_id,
      applicationId: row.application_id,
      credentialGroupId: row.credential_group_id || row.shop_id,
      expiresAt: row.expires_at,
      refreshExpiresAt: row.refresh_expires_at,
      tokenStatus: tokenStatus(row.expires_at) === "expired" ? "expired" : row.token_status,
      lastRefreshTime: row.last_refresh_time,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAuthorization(shopId) {
    const row = this.db.prepare("SELECT * FROM connector_shop_authorizations WHERE shop_id=?").get(shopId);
    if (!row) return null;
    return {
      ...this.getAuthorizationMetadata(shopId),
      accessToken: this.cipher.decrypt(row.access_token_encrypted),
      refreshToken: this.cipher.decrypt(row.refresh_token_encrypted),
    };
  }

  markAuthorizationStatus(shopId, status) {
    this.db.prepare(`
      UPDATE connector_shop_authorizations SET token_status=?, updated_at=? WHERE shop_id=?
    `).run(String(status), nowIso(this.clock), shopId);
    return this.getAuthorizationMetadata(shopId);
  }

  saveAuthorizationGroup(shopId, token) {
    const source = this.db.prepare("SELECT * FROM connector_shop_authorizations WHERE shop_id=?").get(shopId);
    if (!source) throw new TypeError("Authorization does not exist");
    const groupId = source.credential_group_id || source.shop_id;
    const rows = this.db.prepare(`
      SELECT shop_id, application_id FROM connector_shop_authorizations
      WHERE credential_group_id=? OR shop_id=?
    `).all(groupId, shopId);
    const updated = [];
    for (const row of rows) {
      updated.push(this.saveAuthorization({
        shopId: row.shop_id,
        applicationId: row.application_id,
        credentialGroupId: groupId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expireTime,
        refreshExpiresAt: token.refreshExpireTime || null,
        tokenStatus: "active",
        lastRefreshTime: nowIso(this.clock),
      }));
    }
    return updated;
  }

  upsertLazadaAuthorization(appId, token) {
    const info = Array.isArray(token.countryUserInfo) && token.countryUserInfo.length
      ? token.countryUserInfo
      : [{ country: token.country, seller_id: token.shopId }];
    const shops = [];
    const credentialGroupId = `lazada:${appId}:${String(token.accountId || token.shopId)}`;
    for (const item of info) {
      const sellerId = String(item.seller_id || token.shopId || "").trim();
      if (!sellerId) continue;
      const country = String(item.country || token.country || "").toUpperCase();
      const shortCode = String(item.short_code || "").trim();
      const existingShop = this.findShop({ platformId: "lazada", identifier: sellerId });
      const shop = this.upsertShop({
        platformId: "lazada",
        shopName: existingShop?.shopName && existingShop.shopName !== shortCode
          ? existingShop.shopName
          : shortCode || `Lazada ${country} ${sellerId}`,
        sellerId,
        country,
        status: "active",
        metadata: {
          ...(existingShop?.metadata || {}),
          shortCode: shortCode || null,
          userId: item.user_id ? String(item.user_id) : null,
          accountId: token.accountId || null,
          accountPlatform: token.accountPlatform || null,
        },
      });
      this.saveAuthorization({
        shopId: shop.id,
        applicationId: appId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expireTime,
        refreshExpiresAt: token.refreshExpireTime || null,
        tokenStatus: "active",
        credentialGroupId,
      });
      shops.push(shop);
    }
    return shops;
  }

  migrateLegacyLazadaTokens() {
    const exists = this.db.prepare(`
      SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='lazada_store_tokens'
    `).get();
    if (!exists) return { migrated: 0, shops: 0 };
    const rows = this.db.prepare("SELECT * FROM lazada_store_tokens").all();
    let migrated = 0;
    const shopIds = new Set();
    for (const row of rows) {
      const info = parsed(row.country_user_info_json, []);
      const stores = Array.isArray(info) && info.length ? info : [{ country: row.country, seller_id: row.shop_id }];
      const credentialGroupId = `lazada:${row.app_id}:${String(row.account_id || row.shop_id)}`;
      for (const item of stores) {
        const sellerId = String(item.seller_id || row.shop_id || "").trim();
        if (!sellerId) continue;
        const country = String(item.country || row.country || "").toUpperCase();
        const shortCode = String(item.short_code || "").trim();
        const existingShop = this.findShop({ platformId: "lazada", identifier: sellerId });
        const shop = this.upsertShop({
          platformId: "lazada",
          shopName: existingShop?.shopName && existingShop.shopName !== shortCode
            ? existingShop.shopName
            : shortCode || `Lazada ${country} ${sellerId}`,
          sellerId,
          country,
          status: "active",
          metadata: {
            ...(existingShop?.metadata || {}),
            shortCode: shortCode || null,
            userId: item.user_id ? String(item.user_id) : null,
            accountId: row.account_id || null,
            accountPlatform: row.account_platform || null,
            legacySource: "lazada_store_tokens",
          },
        });
        const currentAuthorization = this.getAuthorizationMetadata(shop.id);
        if (currentAuthorization?.applicationId === row.app_id
          && Date.parse(currentAuthorization.updatedAt) >= Date.parse(row.updated_at)) {
          shopIds.add(shop.id);
          continue;
        }
        this.saveEncryptedAuthorization({
          shopId: shop.id,
          applicationId: row.app_id,
          accessTokenEncrypted: row.access_token_encrypted,
          refreshTokenEncrypted: row.refresh_token_encrypted,
          expiresAt: row.expire_time,
          refreshExpiresAt: row.refresh_expire_time || null,
          tokenStatus: tokenStatus(row.expire_time),
          credentialGroupId,
        });
        migrated += 1;
        shopIds.add(shop.id);
      }
    }
    return { migrated, shops: shopIds.size };
  }

  recordApiRequest({
    id = crypto.randomUUID(),
    requestId = null,
    platform,
    shopId,
    apiName,
    requestTime,
    responseStatus,
    durationMs,
    errorCode = null,
    errorMessage = null,
    providerRequestId = null,
  }) {
    const createdAt = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO connector_api_request_logs (
        id, request_id, platform, shop_id, api_name, request_time, response_status,
        duration_ms, error_code, error_message, provider_request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      requestId || null,
      String(platform),
      String(shopId),
      String(apiName),
      String(requestTime || createdAt),
      String(responseStatus),
      Math.max(0, Math.round(Number(durationMs || 0))),
      errorCode || null,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
      providerRequestId || null,
      createdAt,
    );
    return id;
  }

  listApiRequestLogs({ platform = null, shopId = null, status = null, limit = 100 } = {}) {
    const conditions = [];
    const parameters = [];
    if (platform) { conditions.push("platform=?"); parameters.push(String(platform)); }
    if (shopId) { conditions.push("shop_id=?"); parameters.push(String(shopId)); }
    if (status) { conditions.push("response_status=?"); parameters.push(String(status)); }
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    parameters.push(safeLimit);
    return this.db.prepare(`
      SELECT id, request_id, platform, shop_id, api_name, request_time, response_status,
             duration_ms, error_code, error_message, provider_request_id
      FROM connector_api_request_logs
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY request_time DESC LIMIT ?
    `).all(...parameters).map((row) => ({
      id: row.id,
      requestId: row.request_id,
      platform: row.platform,
      shopId: row.shop_id,
      apiName: row.api_name,
      requestTime: row.request_time,
      responseStatus: row.response_status,
      durationMs: Number(row.duration_ms),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      providerRequestId: row.provider_request_id,
    }));
  }

  close() {
    if (this.ownsConnection) this.db.close();
  }
}

export { DEFAULT_PLATFORMS };
