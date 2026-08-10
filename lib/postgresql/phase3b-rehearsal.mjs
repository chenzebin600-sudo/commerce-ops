import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SHADOW_DATABASE } from "./shadow/shadow-schema.mjs";

export const PHASE3B_REHEARSAL_CONTRACT = "COMMERCE-OPS-PG-PHASE3B-REHEARSAL-1.0.0";

const CONFIRM_PREFIX = "--confirm-database=";
const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function assertPhase3bTarget(config, targetDatabase = config?.testDatabase, {
  shadowDatabase = SHADOW_DATABASE,
} = {}) {
  if (!config?.database || !config?.testDatabase) {
    throw new TypeError("Phase 3B PostgreSQL database configuration is incomplete");
  }
  if (
    config.database === config.testDatabase
    || targetDatabase !== config.testDatabase
    || targetDatabase === config.database
    || targetDatabase === shadowDatabase
    || SYSTEM_DATABASES.has(targetDatabase)
  ) {
    throw Object.assign(
      new Error("Phase 3B may only rebuild the isolated PostgreSQL migration test database"),
      { code: "PHASE3B_TARGET_NOT_ISOLATED" },
    );
  }
  return targetDatabase;
}

export function resolvePhase3bInvocation(argv, config, options = {}) {
  const argumentsList = [...argv];
  const unknown = argumentsList.filter((value) => value !== "--apply" && !value.startsWith(CONFIRM_PREFIX));
  if (unknown.length) throw new Error(`Unknown Phase 3B argument: ${unknown[0]}`);
  if (argumentsList.filter((value) => value === "--apply").length > 1) {
    throw new Error("Phase 3B --apply may only be specified once");
  }
  const confirmations = argumentsList.filter((value) => value.startsWith(CONFIRM_PREFIX));
  if (confirmations.length > 1) throw new Error("Phase 3B database confirmation may only be specified once");

  const targetDatabase = assertPhase3bTarget(config, config.testDatabase, options);
  const apply = argumentsList.includes("--apply");
  const confirmation = confirmations[0]?.slice(CONFIRM_PREFIX.length) || null;
  if (!apply && confirmation) {
    throw new Error("Phase 3B database confirmation is only valid together with --apply");
  }
  if (apply && confirmation !== targetDatabase) {
    throw Object.assign(
      new Error(`Phase 3B apply requires --confirm-database=${targetDatabase}`),
      { code: "PHASE3B_CONFIRMATION_REQUIRED" },
    );
  }
  return Object.freeze({
    apply,
    confirmation,
    targetDatabase,
    mode: apply ? "APPLY" : "PLAN",
  });
}

export async function loadPhase3bMigrations(rootDir) {
  const migrationDir = path.join(rootDir, "postgresql", "shadow", "migrations");
  const names = (await fs.readdir(migrationDir))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (!names.length) throw new Error("Phase 3B migration set is empty");
  return Promise.all(names.map(async (version) => {
    const sql = await fs.readFile(path.join(migrationDir, version), "utf8");
    return Object.freeze({ version, sql, sha256: sha256(sql) });
  }));
}

export function planPhase3bMigrations(files, appliedRows = []) {
  const applied = new Map(appliedRows.map((row) => [String(row.version), String(row.sha256)]));
  return files.map((file) => {
    const recorded = applied.get(file.version);
    const status = !recorded
      ? "PENDING"
      : recorded === file.sha256
        ? "ALREADY_APPLIED"
        : "CHECKSUM_MISMATCH";
    return Object.freeze({
      version: file.version,
      sha256: file.sha256,
      status,
      recordedSha256: recorded || null,
    });
  });
}
