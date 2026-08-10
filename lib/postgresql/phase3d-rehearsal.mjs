import { buildIncrementalSyncManifest } from "./incremental-sync/sync-manifest.mjs";

export const PHASE3D_REHEARSAL_CONTRACT = "COMMERCE-OPS-PG-PHASE3D-CUTOVER-REHEARSAL-1.0.0";
export const PHASE3D_REHEARSAL_DATABASE = "commerce_ops_cutover_rehearsal";
export const PHASE3D_REHEARSAL_STATE_ID = "sqlite-to-postgresql-cutover-rehearsal";

const CONFIRM_PREFIX = "--confirm-database=";
const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1"]);
const MODES = new Set(["--rebuild", "--refresh"]);

export function assertPhase3dTarget(config, targetDatabase = PHASE3D_REHEARSAL_DATABASE) {
  if (!config?.database || !config?.testDatabase) {
    throw new TypeError("PostgreSQL production and test database identities are required");
  }
  const protectedDatabases = new Set([
    config.database,
    config.testDatabase,
    "commerce_ops_shadow",
    "commerce_ops_staging",
    ...SYSTEM_DATABASES,
  ]);
  if (targetDatabase !== PHASE3D_REHEARSAL_DATABASE || protectedDatabases.has(targetDatabase)) {
    throw Object.assign(
      new Error(`Phase 3D may only rebuild or refresh the independent ${PHASE3D_REHEARSAL_DATABASE} database`),
      { code: "PHASE3D_TARGET_REJECTED" },
    );
  }
  return targetDatabase;
}

export function resolvePhase3dInvocation(argv, config) {
  const values = [...(argv || [])];
  const allowed = new Set(["--apply", ...MODES]);
  const unknown = values.filter((value) => !allowed.has(value) && !value.startsWith(CONFIRM_PREFIX));
  if (unknown.length) throw new TypeError(`Unknown Phase 3D arguments: ${unknown.join(", ")}`);
  if (new Set(values).size !== values.length) throw new TypeError("Phase 3D arguments may only be specified once");
  const selectedModes = values.filter((value) => MODES.has(value));
  if (selectedModes.length > 1) throw new TypeError("Phase 3D rebuild and refresh modes are mutually exclusive");
  const confirmations = values.filter((value) => value.startsWith(CONFIRM_PREFIX));
  if (confirmations.length > 1) throw new TypeError("Phase 3D database confirmation may only be specified once");

  const targetDatabase = assertPhase3dTarget(config);
  const apply = values.includes("--apply");
  const operation = selectedModes[0]?.slice(2).toUpperCase() || "PLAN";
  const confirmation = confirmations[0]?.slice(CONFIRM_PREFIX.length) || null;
  if (!apply && (selectedModes.length || confirmation)) {
    throw new Error("Phase 3D rebuild, refresh, and database confirmation require --apply");
  }
  if (apply && operation === "PLAN") {
    throw new Error("Phase 3D --apply requires exactly one of --rebuild or --refresh");
  }
  if (apply && confirmation !== targetDatabase) {
    throw Object.assign(
      new Error(`Phase 3D apply requires --confirm-database=${targetDatabase}`),
      { code: "PHASE3D_CONFIRMATION_REQUIRED" },
    );
  }
  return Object.freeze({ apply, operation, confirmation, targetDatabase, mode: apply ? operation : "PLAN" });
}

export function buildFullSourceSyncManifest(source) {
  if (!source?.tables?.length) throw new TypeError("SQLite schema inventory is required");
  const names = source.tables.map((table) => table.name).sort();
  const manifest = buildIncrementalSyncManifest(source, { domainRoots: { full_source: names } });
  if (manifest.length !== source.tables.length) {
    throw new Error(`Full-source manifest is incomplete: ${manifest.length}/${source.tables.length}`);
  }
  return manifest;
}

export function schemaCoverage(source, target) {
  const sourceTables = new Map(source.tables.map((table) => [table.name, table]));
  const targetTables = new Map((target.tables || []).map((table) => [table.name, table]));
  const missingTables = [...sourceTables.keys()].filter((name) => !targetTables.has(name)).sort();
  const columnDifferences = [];
  for (const [name, table] of sourceTables) {
    const targetTable = targetTables.get(name);
    if (!targetTable) continue;
    const expected = table.columns.map((column) => column.name);
    const actual = targetTable.columns.map((column) => column.name);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      columnDifferences.push({ table: name, expected, actual });
    }
  }
  const sourceViews = (source.views || []).map((view) => view.name).sort();
  const targetViews = [...(target.views || [])].sort();
  const missingViews = sourceViews.filter((name) => !targetViews.includes(name));
  return Object.freeze({
    ok: missingTables.length === 0 && missingViews.length === 0 && columnDifferences.length === 0,
    sourceTables: sourceTables.size,
    sourceViews: sourceViews.length,
    missingTables,
    missingViews,
    columnDifferences,
  });
}
