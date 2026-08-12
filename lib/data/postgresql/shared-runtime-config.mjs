import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function identifier(env, name) {
  const value = required(env, name);
  if (!IDENTIFIER.test(value)) throw new Error(`${name} must be a lowercase PostgreSQL identifier`);
  return value;
}

function integer(env, name, fallback, minimum, maximum) {
  const raw = String(env[name] ?? "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function loadPublicCa(rootDir, configuredPath) {
  const rootCertPath = path.resolve(rootDir, configuredPath);
  if (!fs.existsSync(rootCertPath) || !fs.statSync(rootCertPath).isFile()) {
    throw new Error("POSTGRES_SSLROOTCERT file is missing");
  }
  const ca = fs.readFileSync(rootCertPath, "utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----") || !ca.includes("-----END CERTIFICATE-----")) {
    throw new Error("POSTGRES_SSLROOTCERT must contain a PEM certificate");
  }
  if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(ca)) {
    throw new Error("POSTGRES_SSLROOTCERT must not contain a private key");
  }
  return Object.freeze({ rootCertPath, ca });
}

export function loadSharedPostgresqlConfig({ rootDir = process.cwd(), env = process.env } = {}) {
  const sslmode = required(env, "POSTGRES_SSLMODE").toLowerCase();
  if (sslmode !== "verify-full") throw new Error("POSTGRES_SSLMODE must be verify-full");
  const channelBinding = required(env, "POSTGRES_CHANNEL_BINDING").toLowerCase();
  if (channelBinding !== "require") throw new Error("POSTGRES_CHANNEL_BINDING must be require");

  const port = integer(env, "POSTGRES_PORT", 5432, 1, 65_535);
  const certificate = loadPublicCa(rootDir, required(env, "POSTGRES_SSLROOTCERT"));
  return Object.freeze({
    host: required(env, "POSTGRES_HOST"),
    port,
    database: identifier(env, "POSTGRES_DATABASE"),
    schema: identifier(env, "POSTGRES_SCHEMA"),
    appUser: identifier(env, "POSTGRES_APP_USER"),
    sslmode,
    channelBinding,
    rootCertPath: certificate.rootCertPath,
    ssl: Object.freeze({ ca: certificate.ca, rejectUnauthorized: true }),
    poolMax: integer(env, "POSTGRES_POOL_MAX", 5, 1, 50),
    poolIdleTimeoutMs: integer(env, "POSTGRES_POOL_IDLE_TIMEOUT_MS", 30_000, 1_000, 600_000),
    connectionTimeoutMs: integer(env, "POSTGRES_CONNECTION_TIMEOUT_MS", 10_000, 1_000, 120_000),
    statementTimeoutMs: integer(env, "POSTGRES_STATEMENT_TIMEOUT_MS", 30_000, 1_000, 600_000),
  });
}

// node-postgres exposes enableChannelBinding as opportunistic negotiation. This
// guard deliberately pins its internal SASL seam so "require" cannot downgrade.
export class StrictChannelBindingClient extends Client {
  _handleAuthSASL(message) {
    if (!message.mechanisms?.includes("SCRAM-SHA-256-PLUS")) {
      const error = new Error("Required channel binding is unavailable");
      error.code = "PG_CHANNEL_BINDING_REQUIRED";
      this.connection.emit("error", error);
      return;
    }
    return super._handleAuthSASL(message);
  }
}

export function buildPostgresqlPoolOptions(config, {
  database = config?.database,
  user = config?.appUser,
  password,
} = {}) {
  if (!config || !database || !user || !String(password ?? "")) {
    throw new TypeError("PostgreSQL pool credentials are incomplete");
  }
  return {
    Client: StrictChannelBindingClient,
    host: config.host,
    port: config.port,
    database,
    user,
    password,
    ssl: config.ssl,
    enableChannelBinding: true,
    max: config.poolMax,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: "commerce-ops-shared-development",
  };
}
