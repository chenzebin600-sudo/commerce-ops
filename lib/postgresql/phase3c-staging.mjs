import { POSTGRESQL_STAGING_DATABASE } from "./staging-config.mjs";
import { SHADOW_DATABASE } from "./shadow/shadow-schema.mjs";

export const PHASE3C_STAGING_CONTRACT = "COMMERCE-OPS-PG-PHASE3C-STAGING-1.0.0";
const CONFIRM_PREFIX = "--confirm-database=";
const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1"]);

export function assertPhase3cStagingTarget(config, targetDatabase = POSTGRESQL_STAGING_DATABASE) {
  if (!config?.database || !config?.testDatabase) {
    throw new TypeError("Phase 3C PostgreSQL database configuration is incomplete");
  }
  if (
    targetDatabase !== POSTGRESQL_STAGING_DATABASE
    || targetDatabase === config.database
    || targetDatabase === config.testDatabase
    || targetDatabase === SHADOW_DATABASE
    || SYSTEM_DATABASES.has(targetDatabase)
  ) {
    throw Object.assign(
      new Error(`Phase 3C may only target the independent database ${POSTGRESQL_STAGING_DATABASE}`),
      { code: "PHASE3C_STAGING_TARGET_NOT_ISOLATED" },
    );
  }
  return targetDatabase;
}

export function resolvePhase3cStagingInvocation(argv, config) {
  const values = [...argv];
  const unknown = values.filter((value) => !new Set(["--apply", "--resume"]).has(value) && !value.startsWith(CONFIRM_PREFIX));
  if (unknown.length) throw new Error(`Unknown Phase 3C staging argument: ${unknown[0]}`);
  const confirmations = values.filter((value) => value.startsWith(CONFIRM_PREFIX));
  if (values.filter((value) => value === "--apply").length > 1
    || values.filter((value) => value === "--resume").length > 1
    || confirmations.length > 1) {
    throw new Error("Phase 3C staging flags may only be specified once");
  }
  const targetDatabase = assertPhase3cStagingTarget(config);
  const apply = values.includes("--apply");
  const resume = values.includes("--resume");
  const confirmation = confirmations[0]?.slice(CONFIRM_PREFIX.length) || null;
  if (!apply && confirmation) throw new Error("Database confirmation is only valid with --apply");
  if (apply && confirmation !== targetDatabase) {
    throw Object.assign(
      new Error(`Phase 3C staging apply requires --confirm-database=${targetDatabase}`),
      { code: "PHASE3C_STAGING_CONFIRMATION_REQUIRED" },
    );
  }
  if (resume && !apply) throw new Error("Phase 3C staging --resume requires --apply");
  return Object.freeze({ apply, resume, confirmation, targetDatabase, mode: resume ? "RESUME" : apply ? "APPLY" : "PLAN" });
}
