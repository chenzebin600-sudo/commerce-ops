import {
  PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
  PHASE3D_PRODUCTION_MODE_SCOPE,
} from "./phase3d-production-candidate.mjs";

function enabled(value) {
  return new Set(["1", "true", "yes", "on"]).has(String(value || "").trim().toLowerCase());
}

export function resolveProductionOperationalContext({ env = process.env, database = null } = {}) {
  const configured = String(env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  const provider = configured === "postgresql" ? "postgres" : configured;
  if (provider === "sqlite") return Object.freeze({ provider, formalCutover: false });
  if (provider !== "postgres") throw new Error("Operational PostgreSQL tooling requires DATABASE_PROVIDER=sqlite or postgres");
  if (database && database !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE) {
    throw new Error(`Post-cutover operational tooling may only target ${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`);
  }
  if (!enabled(env.POSTGRES_PRODUCTION_MODE)
    || String(env.POSTGRES_PRODUCTION_CONFIRM_DATABASE || "").trim() !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE
    || String(env.POSTGRES_PRODUCTION_CONFIRM_SCOPE || "").trim() !== PHASE3D_PRODUCTION_MODE_SCOPE
    || [
      env.POSTGRES_SHADOW_MODE,
      env.POSTGRES_STAGING_MODE,
      env.POSTGRES_CUTOVER_REHEARSAL_MODE,
      env.POSTGRES_PRODUCTION_CANDIDATE_MODE,
    ].some(enabled)) {
    throw new Error("Post-cutover operational tooling requires the exact guarded FORMAL_CUTOVER production context");
  }
  return Object.freeze({ provider, formalCutover: true });
}
