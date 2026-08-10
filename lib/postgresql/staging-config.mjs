import fs from "node:fs";
import path from "node:path";

export const POSTGRESQL_STAGING_DATABASE = "commerce_ops_staging";
export const POSTGRESQL_STAGING_APP_USER = "commerce_staging_app";
export const POSTGRESQL_STAGING_ENV_FILENAME = ".env.postgres.staging.local";

function parseEnv(content) {
  const result = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}

function required(values, name) {
  const value = String(values[name] ?? "").trim();
  if (!value) throw new Error(`${name} must be configured in ${POSTGRESQL_STAGING_ENV_FILENAME}`);
  return value;
}

export function loadPostgresqlStagingConfig({ rootDir = process.cwd(), env = process.env } = {}) {
  const envFile = path.resolve(rootDir, POSTGRESQL_STAGING_ENV_FILENAME);
  if (!fs.existsSync(envFile)) throw new Error(`${POSTGRESQL_STAGING_ENV_FILENAME} is missing`);
  const fileValues = parseEnv(fs.readFileSync(envFile, "utf8"));
  const values = { ...fileValues };
  for (const key of Object.keys(fileValues)) {
    if (String(env[key] ?? "").trim()) values[key] = env[key];
  }
  const database = required(values, "POSTGRES_STAGING_DATABASE");
  const appUser = required(values, "POSTGRES_STAGING_APP_USER");
  const appPassword = required(values, "POSTGRES_STAGING_APP_PASSWORD");
  if (database !== POSTGRESQL_STAGING_DATABASE) {
    throw new Error(`Staging database must be ${POSTGRESQL_STAGING_DATABASE}`);
  }
  if (appUser !== POSTGRESQL_STAGING_APP_USER) {
    throw new Error(`Staging application role must be ${POSTGRESQL_STAGING_APP_USER}`);
  }
  if (appPassword.length < 24) throw new Error("POSTGRES_STAGING_APP_PASSWORD must contain at least 24 characters");
  return Object.freeze({ database, appUser, appPassword, envFile });
}

