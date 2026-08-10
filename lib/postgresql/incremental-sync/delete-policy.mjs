import { SHADOW_DATABASE } from "../shadow/shadow-schema.mjs";

export const DELETE_RECONCILIATION_MODES = Object.freeze({
  BLOCK: "BLOCK",
  DETECT: "DETECT",
  APPLY: "APPLY",
});

function enabled(value) {
  return new Set(["1", "true", "yes", "on"]).has(String(value || "").trim().toLowerCase());
}

export function resolveDeleteReconciliationPolicy({
  mode = "BLOCK",
  apply = false,
  fullReconcile = false,
  confirmation = null,
  targetDatabase = SHADOW_DATABASE,
  deleteEnabled = false,
} = {}) {
  const normalizedMode = String(mode || "BLOCK").trim().toUpperCase();
  if (!Object.values(DELETE_RECONCILIATION_MODES).includes(normalizedMode)) {
    throw new TypeError("Delete reconciliation mode must be BLOCK, DETECT, or APPLY");
  }
  if (targetDatabase !== SHADOW_DATABASE) {
    throw new Error(`Delete reconciliation target must be ${SHADOW_DATABASE}`);
  }
  if (apply && normalizedMode !== DELETE_RECONCILIATION_MODES.BLOCK && !fullReconcile) {
    throw new Error("DELETE detection or application requires --full-reconcile");
  }
  if (apply && normalizedMode === DELETE_RECONCILIATION_MODES.APPLY) {
    if (!enabled(deleteEnabled)) {
      throw new Error("Set POSTGRES_SHADOW_DELETE_ENABLED=true before applying Shadow deletes");
    }
    if (confirmation !== targetDatabase) {
      throw Object.assign(
        new Error(`Shadow DELETE apply requires --confirm-delete-database=${targetDatabase}`),
        { code: "SHADOW_DELETE_CONFIRMATION_REQUIRED" },
      );
    }
  }
  return Object.freeze({
    mode: normalizedMode,
    targetDatabase,
    fullReconcile: Boolean(fullReconcile),
    executionRequested: Boolean(apply),
    executesDetection: Boolean(apply && normalizedMode !== DELETE_RECONCILIATION_MODES.BLOCK),
    executesDeletes: Boolean(apply && normalizedMode === DELETE_RECONCILIATION_MODES.APPLY),
    destructive: normalizedMode === DELETE_RECONCILIATION_MODES.APPLY,
    dependencyOrder: "children-before-parents",
    sourceOfTruth: "sqlite-snapshot",
  });
}
