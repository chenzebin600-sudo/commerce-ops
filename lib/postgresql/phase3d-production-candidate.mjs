export const PHASE3D_PRODUCTION_CANDIDATE_CONTRACT = "COMMERCE-OPS-PG-PHASE3D-PRODUCTION-CANDIDATE-1.0.0";
export const PHASE3D_PRODUCTION_CANDIDATE_DATABASE = "commerce_ops";
export const PHASE3D_PRODUCTION_CANDIDATE_STATE_ID = "sqlite-to-postgresql-production-candidate";
export const PHASE3D_PRODUCTION_CANDIDATE_PROVIDER = "postgresql_production_candidate";
export const PHASE3D_PRODUCTION_CANDIDATE_SCOPE = "PROCESS_SCOPED_VALIDATION_ONLY";
export const PHASE3D_PRODUCTION_MODE_SCOPE = "FORMAL_CUTOVER";

const CONFIRM_DATABASE_PREFIX = "--confirm-database=";
const CONFIRM_MUTATION_PREFIX = "--confirm-production-mutation=";
const OPERATIONS = new Map([
  ["--initialize", "INITIALIZE"],
  ["--refresh", "REFRESH"],
]);
const MUTATION_CONFIRMATIONS = Object.freeze({
  INITIALIZE: "INITIALIZE_AND_FULL_SYNC",
  REFRESH: "REFRESH_FULL_SOURCE",
});

export function assertProductionCandidateTarget(config) {
  if (!config?.database || config.database !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE) {
    throw Object.assign(
      new Error(`Production candidate workflow requires configured database ${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`),
      { code: "PRODUCTION_CANDIDATE_TARGET_REJECTED" },
    );
  }
  if ([config.testDatabase, "commerce_ops_shadow", "commerce_ops_staging", "commerce_ops_cutover_rehearsal", "postgres", "template0", "template1"].includes(config.database)) {
    throw Object.assign(new Error("Production candidate identity overlaps a protected database"), { code: "PRODUCTION_CANDIDATE_TARGET_REJECTED" });
  }
  return config.database;
}

export function resolveProductionCandidateInvocation(argv, config) {
  const values = [...(argv || [])];
  const allowed = new Set(["--apply", ...OPERATIONS.keys()]);
  const unknown = values.filter((value) => !allowed.has(value)
    && !value.startsWith(CONFIRM_DATABASE_PREFIX)
    && !value.startsWith(CONFIRM_MUTATION_PREFIX));
  if (unknown.length) throw new TypeError(`Unknown production candidate arguments: ${unknown.join(", ")}`);
  if (new Set(values).size !== values.length) throw new TypeError("Production candidate arguments may only be specified once");

  const operationArguments = values.filter((value) => OPERATIONS.has(value));
  if (operationArguments.length > 1) throw new TypeError("Production candidate initialize and refresh are mutually exclusive");
  const databaseConfirmations = values.filter((value) => value.startsWith(CONFIRM_DATABASE_PREFIX));
  const mutationConfirmations = values.filter((value) => value.startsWith(CONFIRM_MUTATION_PREFIX));
  if (databaseConfirmations.length > 1 || mutationConfirmations.length > 1) {
    throw new TypeError("Production candidate confirmations may only be specified once");
  }

  const targetDatabase = assertProductionCandidateTarget(config);
  const apply = values.includes("--apply");
  const operation = operationArguments.length ? OPERATIONS.get(operationArguments[0]) : "PLAN";
  const confirmedDatabase = databaseConfirmations[0]?.slice(CONFIRM_DATABASE_PREFIX.length) || null;
  const confirmedMutation = mutationConfirmations[0]?.slice(CONFIRM_MUTATION_PREFIX.length) || null;
  if (!apply && (operation !== "PLAN" || confirmedDatabase || confirmedMutation)) {
    throw new Error("Production candidate operation and confirmations require --apply");
  }
  if (apply && operation === "PLAN") throw new Error("Production candidate --apply requires exactly one operation");
  if (apply && confirmedDatabase !== targetDatabase) {
    throw Object.assign(new Error(`Production candidate apply requires --confirm-database=${targetDatabase}`), { code: "PRODUCTION_CANDIDATE_CONFIRMATION_REQUIRED" });
  }
  if (apply && confirmedMutation !== MUTATION_CONFIRMATIONS[operation]) {
    throw Object.assign(
      new Error(`Production candidate ${operation.toLowerCase()} requires --confirm-production-mutation=${MUTATION_CONFIRMATIONS[operation]}`),
      { code: "PRODUCTION_CANDIDATE_CONFIRMATION_REQUIRED" },
    );
  }
  return Object.freeze({ apply, operation, targetDatabase, confirmedDatabase, confirmedMutation });
}

export function productionCandidateApplyCommand(operation) {
  const normalized = String(operation || "").trim().toUpperCase();
  if (!MUTATION_CONFIRMATIONS[normalized]) throw new TypeError("Unknown production candidate operation");
  return `node scripts/postgresql-production-candidate-sync.mjs --apply --${normalized.toLowerCase()} --confirm-database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE} --confirm-production-mutation=${MUTATION_CONFIRMATIONS[normalized]}`;
}
