import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildLazadaAuthorizationUrl as connectorAuthorizationUrl,
  exchangeLazadaAuthorizationCode,
} from "../../connectors/lazada/auth.mjs";
import { signLazadaRequest as connectorSignLazadaRequest } from "../../connectors/lazada/signing.mjs";
import { SqlitePlatformRepository } from "../../connectors/persistence/sqlite-platform-repository.mjs";

const DEFAULT_APP_COUNT = 3;
const DEFAULT_APP_ID = "app-1";

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw Object.assign(new Error(`${name} is not configured`), { status: 503 });
  return normalized;
}

function integer(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeAppId(value, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(normalized)) {
    throw new Error(`Invalid Lazada app id: ${normalized}`);
  }
  return normalized;
}

function callbackOrigin(callbackUrl) {
  try {
    return new URL(callbackUrl).origin;
  } catch {
    return "";
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readBody(req, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim();
  if (contentType === "application/json") return JSON.parse(raw);
  if (contentType === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(raw));
  return {};
}

function encryptionKeyBuffer(value) {
  const normalized = required(value, "LAZADA_TOKEN_ENCRYPTION_KEY");
  let key;
  try {
    key = Buffer.from(normalized, "base64url");
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32) {
    throw Object.assign(new Error("LAZADA_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value"), { status: 503 });
  }
  return key;
}

function encryptSecret(value, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKeyBuffer(encryptionKey), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptSecret(value, encryptionKey) {
  const [version, iv, tag, encrypted] = String(value || "").split(":");
  if (version !== "v1" || !iv || !tag || encrypted === undefined) throw new Error("Unsupported encrypted token format");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKeyBuffer(encryptionKey),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function envTokenPrefix(appId, shopId) {
  const safe = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `LAZADA_STORE_${safe(appId)}_${safe(shopId)}`;
}

function isLocalManagerRequest(req) {
  const host = String(req.headers.host || "").toLowerCase();
  return host === "localhost" || host.startsWith("localhost:")
    || host === "127.0.0.1" || host.startsWith("127.0.0.1:")
    || host === "[::1]" || host.startsWith("[::1]:");
}

export function signLazadaRequest({ apiPath, parameters, appSecret }) {
  return connectorSignLazadaRequest({ apiPath, parameters, appSecret });
}

export function buildLazadaAuthorizationUrl(config, state) {
  return connectorAuthorizationUrl(config, state);
}

export function resolveLazadaOAuthConfig({ env = process.env, rootDir = process.cwd() } = {}) {
  const host = String(env.LAZADA_OAUTH_HOST || "127.0.0.1").trim();
  const port = integer(env.LAZADA_OAUTH_PORT, 8977, { max: 65_535 });
  const authBaseUrl = String(env.LAZADA_AUTH_BASE_URL || "https://auth.lazada.com").replace(/\/$/, "");
  const apiBaseUrl = String(env.LAZADA_API_BASE_URL || "https://auth.lazada.com/rest").replace(/\/$/, "");
  const legacyCallbackUrl = String(env.LAZADA_CALLBACK_URL || "").trim();
  const callbackBaseUrl = String(
    env.LAZADA_CALLBACK_BASE_URL
      || callbackOrigin(legacyCallbackUrl)
      || env.CLOUDFLARE_QUICK_TUNNEL_URL,
  ).replace(/\/$/, "");
  const appCount = integer(env.LAZADA_APP_COUNT, DEFAULT_APP_COUNT, { min: 1, max: 20 });
  const appIds = new Set();
  const apps = [];

  for (let index = 1; index <= appCount; index += 1) {
    const prefix = `LAZADA_APP_${index}`;
    const id = normalizeAppId(env[`${prefix}_ID`], `app-${index}`);
    if (appIds.has(id)) throw new Error(`Duplicate Lazada app id: ${id}`);
    appIds.add(id);
    const callbackUrl = String(
      env[`${prefix}_CALLBACK_URL`]
        || (index === 1 ? legacyCallbackUrl : callbackBaseUrl ? `${callbackBaseUrl}/lazada/apps/${id}/callback` : ""),
    ).trim();
    apps.push(Object.freeze({
      id,
      index,
      name: String(env[`${prefix}_NAME`] || `Lazada App ${index}`).trim(),
      appKey: String(env[`${prefix}_KEY`] || (index === 1 ? env.LAZADA_APP_KEY : "") || "").trim(),
      appSecret: String(env[`${prefix}_SECRET`] || (index === 1 ? env.LAZADA_APP_SECRET : "") || "").trim(),
      callbackUrl,
      authBaseUrl,
      apiBaseUrl,
    }));
  }

  const requestedDefaultAppId = normalizeAppId(env.LAZADA_DEFAULT_APP_ID, apps[0]?.id || DEFAULT_APP_ID);
  const defaultApp = apps.find((app) => app.id === requestedDefaultAppId) || apps[0];
  return Object.freeze({
    host,
    port,
    apps: Object.freeze(apps),
    defaultAppId: defaultApp.id,
    appKey: defaultApp.appKey,
    appSecret: defaultApp.appSecret,
    callbackUrl: defaultApp.callbackUrl,
    authBaseUrl,
    apiBaseUrl,
    databasePath: path.resolve(rootDir, env.LAZADA_OAUTH_DB_PATH || "storage/lazada-oauth.sqlite"),
    envPath: path.resolve(rootDir, env.LAZADA_ENV_PATH || ".env"),
    tokenEncryptionKey: String(env.LAZADA_TOKEN_ENCRYPTION_KEY || "").trim(),
    stateTtlSeconds: integer(env.LAZADA_OAUTH_STATE_TTL_SECONDS, 900, { min: 60, max: 3600 }),
    requestTimeoutMs: integer(env.LAZADA_API_TIMEOUT_MS, 20_000, { min: 1000, max: 120_000 }),
  });
}

export class LazadaOAuthRepository {
  constructor(databasePath, { defaultAppId = DEFAULT_APP_ID, encryptionKey = "" } = {}) {
    this.databasePath = databasePath;
    this.defaultAppId = normalizeAppId(defaultAppId, DEFAULT_APP_ID);
    this.encryptionKey = encryptionKey;
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lazada_oauth_states (
        state_hash TEXT PRIMARY KEY,
        app_id TEXT NOT NULL DEFAULT 'app-1',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS lazada_oauth_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL DEFAULT 'app-1',
        status TEXT NOT NULL,
        state_hash TEXT,
        code_hash TEXT,
        shop_id TEXT,
        error TEXT,
        error_description TEXT,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lazada_oauth_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        shop_id TEXT NOT NULL,
        account_id TEXT,
        country TEXT,
        account_platform TEXT,
        account TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expire_time TEXT NOT NULL,
        refresh_expire_time TEXT,
        country_user_info_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lazada_store_tokens (
        app_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        account_id TEXT,
        country TEXT,
        account_platform TEXT,
        account TEXT,
        access_token_encrypted TEXT NOT NULL,
        refresh_token_encrypted TEXT NOT NULL,
        expire_time TEXT NOT NULL,
        refresh_expire_time TEXT,
        country_user_info_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, shop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lazada_store_tokens_shop ON lazada_store_tokens(shop_id);
    `);
    this.ensureColumn("lazada_oauth_states", "app_id", "TEXT NOT NULL DEFAULT 'app-1'");
    this.ensureColumn("lazada_oauth_events", "app_id", "TEXT NOT NULL DEFAULT 'app-1'");
    this.ensureColumn("lazada_oauth_events", "shop_id", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_lazada_oauth_events_app ON lazada_oauth_events(app_id, id DESC)");
    this.migrateLegacyToken();
    this.platformRepository = new SqlitePlatformRepository({
      connection: this.db,
      encryptionKey: this.encryptionKey,
    });
    this.platformRepository.migrateLegacyLazadaTokens();
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  migrateLegacyToken() {
    const legacy = this.db.prepare("SELECT * FROM lazada_oauth_tokens WHERE id = 1").get();
    if (!legacy || !this.encryptionKey) return;
    this.saveToken(this.defaultAppId, {
      shopId: legacy.shop_id,
      accountId: legacy.account_id || "",
      country: legacy.country || "",
      accountPlatform: legacy.account_platform || "",
      account: legacy.account || "",
      accessToken: legacy.access_token,
      refreshToken: legacy.refresh_token,
      expireTime: legacy.expire_time,
      refreshExpireTime: legacy.refresh_expire_time || "",
      countryUserInfo: JSON.parse(legacy.country_user_info_json || "[]"),
    });
    this.db.prepare("DELETE FROM lazada_oauth_tokens WHERE id = 1").run();
  }

  createState(appId, state, ttlSeconds) {
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO lazada_oauth_states (state_hash, app_id, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(sha256(state), appId, createdAt, expiresAt);
    this.db.prepare("DELETE FROM lazada_oauth_states WHERE expires_at < ? OR consumed_at IS NOT NULL").run(createdAt);
  }

  consumeState(appId, state) {
    const stateHash = sha256(state);
    const current = this.db.prepare(`
      SELECT state_hash, expires_at, consumed_at
      FROM lazada_oauth_states
      WHERE state_hash = ? AND app_id = ?
    `).get(stateHash, appId);
    if (!current || current.consumed_at || Date.parse(current.expires_at) <= Date.now()) return false;
    this.db.prepare("UPDATE lazada_oauth_states SET consumed_at = ? WHERE state_hash = ?").run(nowIso(), stateHash);
    return true;
  }

  recordEvent({ appId = this.defaultAppId, status, state = "", code = "", shopId = "", error = "", errorDescription = "" }) {
    this.db.prepare(`
      INSERT INTO lazada_oauth_events (
        app_id, status, state_hash, code_hash, shop_id, error, error_description, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      appId,
      status,
      state ? sha256(state) : null,
      code ? sha256(code) : null,
      shopId || null,
      error || null,
      errorDescription || null,
      nowIso(),
    );
  }

  saveToken(appId, token) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO lazada_store_tokens (
        app_id, shop_id, account_id, country, account_platform, account,
        access_token_encrypted, refresh_token_encrypted, expire_time, refresh_expire_time,
        country_user_info_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, shop_id) DO UPDATE SET
        account_id = excluded.account_id,
        country = excluded.country,
        account_platform = excluded.account_platform,
        account = excluded.account,
        access_token_encrypted = excluded.access_token_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        expire_time = excluded.expire_time,
        refresh_expire_time = excluded.refresh_expire_time,
        country_user_info_json = excluded.country_user_info_json,
        updated_at = excluded.updated_at
    `).run(
      appId,
      token.shopId,
      token.accountId || null,
      token.country || null,
      token.accountPlatform || null,
      token.account || null,
      encryptSecret(token.accessToken, this.encryptionKey),
      encryptSecret(token.refreshToken, this.encryptionKey),
      token.expireTime,
      token.refreshExpireTime || null,
      JSON.stringify(token.countryUserInfo || []),
      timestamp,
      timestamp,
    );
    this.platformRepository?.upsertLazadaAuthorization(appId, token);
  }

  tokenCredentials(appId, shopId) {
    const token = this.db.prepare(`
      SELECT * FROM lazada_store_tokens WHERE app_id = ? AND shop_id = ?
    `).get(appId, shopId);
    if (!token) return null;
    return {
      ...token,
      access_token: decryptSecret(token.access_token_encrypted, this.encryptionKey),
      refresh_token: decryptSecret(token.refresh_token_encrypted, this.encryptionKey),
    };
  }

  listTokens({ appId } = {}) {
    const rows = appId
      ? this.db.prepare(`
          SELECT app_id, shop_id, account_id, country, account_platform, expire_time,
                 refresh_expire_time, created_at, updated_at
          FROM lazada_store_tokens WHERE app_id = ? ORDER BY updated_at DESC
        `).all(appId)
      : this.db.prepare(`
          SELECT app_id, shop_id, account_id, country, account_platform, expire_time,
                 refresh_expire_time, created_at, updated_at
          FROM lazada_store_tokens ORDER BY app_id, updated_at DESC
        `).all();
    const currentTime = Date.now();
    return rows.map((row) => ({
      ...row,
      token_status: Date.parse(row.expire_time) > currentTime ? "active" : "expired",
    }));
  }

  tokenCounts() {
    return Object.fromEntries(this.db.prepare(`
      SELECT app_id, COUNT(*) AS store_count FROM lazada_store_tokens GROUP BY app_id
    `).all().map((row) => [row.app_id, Number(row.store_count)]));
  }

  status(appId = this.defaultAppId) {
    const token = this.db.prepare(`
      SELECT app_id, shop_id, account_id, country, account_platform, expire_time,
             refresh_expire_time, updated_at
      FROM lazada_store_tokens WHERE app_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(appId);
    const latestEvent = this.db.prepare(`
      SELECT app_id, status, shop_id, error, received_at
      FROM lazada_oauth_events WHERE app_id = ? ORDER BY id DESC LIMIT 1
    `).get(appId);
    return { token: token || null, latestEvent: latestEvent || null };
  }

  close() {
    this.platformRepository?.close();
    this.db.close();
  }
}

export async function updateEnvValues(envPath, values) {
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content ? content.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const remaining = new Map(Object.entries(values).map(([key, value]) => [key, String(value ?? "")]));
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]).replace(/[\r\n]/g, "");
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (remaining.size) {
    if (updated.length && updated.at(-1) !== "") updated.push("");
    updated.push("# Lazada OAuth values are managed by the local OAuth service.");
    for (const [key, value] of remaining) updated.push(`${key}=${value.replace(/[\r\n]/g, "")}`);
  }
  await fs.writeFile(envPath, `${updated.join(newline)}${newline}`, { encoding: "utf8", mode: 0o600 });
}

export async function ensureTokenEncryptionKey(config) {
  if (config.tokenEncryptionKey) {
    encryptionKeyBuffer(config.tokenEncryptionKey);
    return config.tokenEncryptionKey;
  }
  const generated = crypto.randomBytes(32).toString("base64url");
  await updateEnvValues(config.envPath, { LAZADA_TOKEN_ENCRYPTION_KEY: generated });
  process.env.LAZADA_TOKEN_ENCRYPTION_KEY = generated;
  return generated;
}

export async function exchangeAuthorizationCode({ code, config, fetchImpl = fetch }) {
  return exchangeLazadaAuthorizationCode({
    code,
    app: config,
    fetchImpl,
    timeoutMs: integer(config.requestTimeoutMs, 20_000, { min: 1000, max: 120_000 }),
  });
}

function handlerApps(config) {
  if (Array.isArray(config.apps) && config.apps.length) return config.apps;
  return [{
    id: config.defaultAppId || DEFAULT_APP_ID,
    index: 1,
    name: "Lazada App 1",
    appKey: config.appKey,
    appSecret: config.appSecret,
    callbackUrl: config.callbackUrl,
    authBaseUrl: config.authBaseUrl,
    apiBaseUrl: config.apiBaseUrl,
  }];
}

function managerHtml({ apps, stores }) {
  const appCards = apps.map((app) => `
    <section>
      <h2>${escapeHtml(app.name)}</h2>
      <p><strong>ID:</strong> <code>${escapeHtml(app.id)}</code></p>
      <p><strong>Callback:</strong> <code>${escapeHtml(app.callback_url || "not configured")}</code></p>
      <p><strong>Stores:</strong> ${app.store_count} · <strong>Status:</strong> ${app.configured ? "configured" : "missing key/secret"}</p>
      ${app.configured ? `<p><a href="/lazada/apps/${encodeURIComponent(app.id)}/auth">Authorize a store</a></p>` : ""}
    </section>
  `).join("");
  const rows = stores.map((store) => `
    <tr><td>${escapeHtml(store.app_id)}</td><td>${escapeHtml(store.shop_id)}</td><td>${escapeHtml(store.country || "-")}</td><td>${escapeHtml(store.token_status)}</td><td>${escapeHtml(store.expire_time)}</td></tr>
  `).join("") || "<tr><td colspan=\"5\">No stores authorized yet.</td></tr>";
  return `<!doctype html>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Lazada token manager</title>
    <style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172033;background:#f7f8fb}h1{margin-bottom:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}section{background:#fff;border:1px solid #e3e7ef;border-radius:12px;padding:18px}code{word-break:break-all;background:#f1f3f7;padding:2px 5px;border-radius:4px}a{color:#d94f00;font-weight:700}table{width:100%;border-collapse:collapse;background:#fff;margin-top:20px}th,td{text-align:left;padding:11px;border-bottom:1px solid #e3e7ef}</style>
    <h1>Lazada centralized token manager</h1>
    <p>Token values are never displayed. SQLite stores encrypted credentials; this page exposes metadata only.</p>
    <div class="grid">${appCards}</div>
    <h2>Authorized stores (${stores.length})</h2>
    <table><thead><tr><th>App</th><th>Shop ID</th><th>Country</th><th>Token</th><th>Expires</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function createLazadaOAuthHandler({ config, repository, fetchImpl = fetch }) {
  const apps = handlerApps(config);
  const appById = new Map(apps.map((app) => [app.id, app]));
  const defaultAppId = config.defaultAppId || apps[0].id;
  const pendingAuthorizations = new Map();
  const latestPendingByApp = new Map();

  const appStatuses = () => {
    const counts = repository.tokenCounts();
    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      configured: Boolean(app.appKey && app.appSecret && app.callbackUrl),
      callback_url: app.callbackUrl || null,
      store_count: counts[app.id] || 0,
      pending_code_count: [...pendingAuthorizations.values()].filter((item) => item.appId === app.id).length,
    }));
  };

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${config.host}:${config.port}`}`);
    let activeAppId = defaultAppId;
    try {
      if (url.pathname === "/health") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
        return json(res, 200, { ok: true, service: "lazada-oauth", port: config.port, app_count: apps.length });
      }

      if (url.pathname === "/lazada/status") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
        const defaultApp = appById.get(defaultAppId);
        const status = repository.status(defaultAppId);
        return json(res, 200, {
          ok: true,
          configured: Boolean(defaultApp?.appKey && defaultApp?.appSecret && defaultApp?.callbackUrl),
          callback_url: defaultApp?.callbackUrl || null,
          pending_code: [...pendingAuthorizations.values()].some((item) => item.appId === defaultAppId),
          apps: appStatuses(),
          store_count: repository.listTokens().length,
          ...status,
        });
      }

      if (url.pathname === "/lazada/apps") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
        return json(res, 200, { ok: true, apps: appStatuses() });
      }

      if (url.pathname === "/lazada/stores") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
        if (!isLocalManagerRequest(req)) return json(res, 403, { ok: false, error: "Store metadata is available from localhost only" });
        return json(res, 200, { ok: true, stores: repository.listTokens() });
      }

      if (url.pathname === "/lazada/manager") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
        if (!isLocalManagerRequest(req)) return json(res, 403, { ok: false, error: "Token manager is available from localhost only" });
        return html(res, 200, managerHtml({ apps: appStatuses(), stores: repository.listTokens() }));
      }

      let routeType = "";
      let routeAppId = "";
      let legacyRoute = false;
      if (url.pathname === "/lazada/auth" || url.pathname === "/lazada/callback" || url.pathname === "/lazada/token") {
        routeType = url.pathname.split("/").at(-1);
        routeAppId = defaultAppId;
        legacyRoute = true;
      } else {
        const match = url.pathname.match(/^\/lazada\/apps\/([a-z0-9-]+)\/(auth|callback|token)$/);
        if (match) [, routeAppId, routeType] = match;
      }

      if (routeType) {
        activeAppId = routeAppId;
        const app = appById.get(routeAppId);
        if (!app) return json(res, 404, { ok: false, error: "Unknown Lazada app" });

        if (routeType === "auth") {
          if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
          const state = crypto.randomBytes(32).toString("base64url");
          repository.createState(app.id, state, config.stateTtlSeconds);
          const authorizationUrl = buildLazadaAuthorizationUrl(app, state);
          if (url.searchParams.get("format") === "json") {
            return json(res, 200, { ok: true, app_id: app.id, authorization_url: authorizationUrl, callback_url: app.callbackUrl });
          }
          res.writeHead(302, { location: authorizationUrl, "cache-control": "no-store" });
          return res.end();
        }

        if (routeType === "callback") {
          if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
          const state = String(url.searchParams.get("state") || "");
          const code = String(url.searchParams.get("code") || "");
          const oauthError = String(url.searchParams.get("error") || "");
          const errorDescription = String(url.searchParams.get("error_description") || "");
          if (oauthError) {
            repository.recordEvent({ appId: app.id, status: "REJECTED", state, error: oauthError, errorDescription });
            return html(res, 400, `<!doctype html><meta charset="utf-8"><title>Lazada authorization failed</title><h1>Authorization failed</h1><p>${escapeHtml(errorDescription || oauthError)}</p>`);
          }
          if (!state || !repository.consumeState(app.id, state)) {
            repository.recordEvent({ appId: app.id, status: "INVALID_STATE", state, code });
            return html(res, 400, `<!doctype html><meta charset="utf-8"><title>Invalid OAuth state</title><h1>Invalid or expired OAuth state</h1><p>Restart from <code>/lazada/apps/${escapeHtml(app.id)}/auth</code>.</p>`);
          }
          if (!code) {
            repository.recordEvent({ appId: app.id, status: "MISSING_CODE", state });
            return html(res, 400, "<!doctype html><meta charset=\"utf-8\"><title>Missing code</title><h1>Lazada did not return an authorization code</h1>");
          }
          const ticket = crypto.randomBytes(24).toString("base64url");
          pendingAuthorizations.set(ticket, { appId: app.id, code, receivedAt: nowIso() });
          latestPendingByApp.set(app.id, ticket);
          repository.recordEvent({ appId: app.id, status: "CODE_RECEIVED", state, code });
          const tokenAction = legacyRoute ? "/lazada/token" : `/lazada/apps/${encodeURIComponent(app.id)}/token`;
          return html(res, 200, `<!doctype html>
            <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Lazada authorization received</title>
            <style>body{font:16px system-ui;max-width:680px;margin:64px auto;padding:0 24px;color:#172033}button{font:inherit;padding:12px 18px;border:0;border-radius:8px;background:#ff6200;color:white;cursor:pointer}code{background:#f2f4f7;padding:2px 5px;border-radius:4px}</style>
            <h1>Lazada callback received</h1>
            <p>App <code>${escapeHtml(app.id)}</code> authorization code was received without printing the credential.</p>
            <form method="post" action="${escapeHtml(tokenAction)}"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}"><button type="submit">Exchange and save token</button></form>
          `);
        }

        if (routeType === "token") {
          if (req.method !== "POST") return json(res, 405, { ok: false, error: "Use POST for token exchange" });
          const body = await readBody(req);
          const ticket = String(body.ticket || latestPendingByApp.get(app.id) || "");
          const pending = ticket ? pendingAuthorizations.get(ticket) : null;
          if (pending && pending.appId !== app.id) throw Object.assign(new Error("Authorization code belongs to a different Lazada app"), { status: 400 });
          const code = String(body.code || pending?.code || "");
          const token = await exchangeAuthorizationCode({ code, config: app, fetchImpl });
          repository.saveToken(app.id, token);
          const prefix = envTokenPrefix(app.id, token.shopId);
          const envValues = {
            [`${prefix}_ACCESS_TOKEN`]: token.accessToken,
            [`${prefix}_REFRESH_TOKEN`]: token.refreshToken,
            [`${prefix}_EXPIRE_TIME`]: token.expireTime,
            [`${prefix}_REFRESH_EXPIRE_TIME`]: token.refreshExpireTime,
          };
          if (app.id === defaultAppId) {
            Object.assign(envValues, {
              LAZADA_SHOP_ID: token.shopId,
              LAZADA_ACCESS_TOKEN: token.accessToken,
              LAZADA_REFRESH_TOKEN: token.refreshToken,
              LAZADA_TOKEN_EXPIRE_TIME: token.expireTime,
            });
          }
          await updateEnvValues(config.envPath, envValues);
          if (pending) pendingAuthorizations.delete(ticket);
          if (latestPendingByApp.get(app.id) === ticket) latestPendingByApp.delete(app.id);
          repository.recordEvent({ appId: app.id, status: "TOKEN_SAVED", shopId: token.shopId });
          return json(res, 200, {
            ok: true,
            app_id: app.id,
            shop_id: token.shopId,
            country: token.country || null,
            expire_time: token.expireTime,
            saved_to: [".env", path.basename(config.databasePath)],
          });
        }
      }

      return json(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const status = Number(error.status) || (error.name === "AbortError" ? 504 : 500);
      repository.recordEvent({ appId: activeAppId, status: "ERROR", error: error.lazadaCode || error.name, errorDescription: error.message });
      return json(res, status, {
        ok: false,
        error: error.message,
        lazada_code: error.lazadaCode || undefined,
        request_id: error.requestId || undefined,
      });
    }
  };
}
