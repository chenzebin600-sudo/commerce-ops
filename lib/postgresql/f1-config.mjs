import fs from "node:fs";
import path from "node:path";

export const F1_ENV_FILENAME = ".env.postgres.local";

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function parseEnv(content) {
  const result = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}

function required(values, name) {
  const value = String(values[name] ?? "").trim();
  if (!value) throw new Error(`${name} must be configured in ${F1_ENV_FILENAME}`);
  return value;
}

function identifier(values, name) {
  const value = required(values, name);
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`${name} must be a lowercase PostgreSQL identifier`);
  return value;
}

function password(values, name, { minimumLength = 1 } = {}) {
  const value = required(values, name);
  if (value.length < minimumLength) throw new Error(`${name} must contain at least ${minimumLength} characters`);
  return value;
}

export function loadPostgresqlF1Config({ rootDir = process.cwd(), env = process.env, envFile } = {}) {
  const filePath = path.resolve(rootDir, envFile || F1_ENV_FILENAME);
  if (!fs.existsSync(filePath)) throw new Error(`${F1_ENV_FILENAME} is missing`);
  const fileValues = parseEnv(fs.readFileSync(filePath, "utf8"));
  const values = { ...fileValues };
  for (const key of Object.keys(fileValues)) {
    if (String(env[key] ?? "").trim()) values[key] = env[key];
  }

  const port = Number(required(values, "POSTGRES_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("POSTGRES_PORT is invalid");
  const ssl = String(values.POSTGRES_SSL || "false").trim().toLowerCase();
  if (!new Set(["true", "false"]).has(ssl)) throw new Error("POSTGRES_SSL must be true or false");

  const config = {
    host: required(values, "POSTGRES_HOST"),
    port,
    database: identifier(values, "POSTGRES_DATABASE"),
    testDatabase: identifier(values, "POSTGRES_TEST_DATABASE"),
    schema: identifier(values, "POSTGRES_SCHEMA"),
    adminUser: identifier(values, "POSTGRES_ADMIN_USER"),
    adminPassword: password(values, "POSTGRES_ADMIN_PASSWORD"),
    migratorUser: identifier(values, "POSTGRES_MIGRATOR_USER"),
    migratorPassword: password(values, "POSTGRES_MIGRATOR_PASSWORD", { minimumLength: 16 }),
    appUser: identifier(values, "POSTGRES_APP_USER"),
    appPassword: password(values, "POSTGRES_APP_PASSWORD", { minimumLength: 16 }),
    ssl: ssl === "true",
    envFile: filePath,
  };
  if (config.database === config.testDatabase) throw new Error("POSTGRES_DATABASE and POSTGRES_TEST_DATABASE must differ");
  if (config.migratorUser === config.appUser) throw new Error("PostgreSQL application roles must differ");
  if (config.migratorPassword === config.appPassword) throw new Error("PostgreSQL application role passwords must differ");
  return Object.freeze(config);
}

export function publicPostgresqlF1Config(config) {
  return Object.freeze({
    host: config.host,
    port: config.port,
    database: config.database,
    testDatabase: config.testDatabase,
    schema: config.schema,
    adminUser: config.adminUser,
    migratorUser: config.migratorUser,
    appUser: config.appUser,
    ssl: config.ssl,
  });
}
