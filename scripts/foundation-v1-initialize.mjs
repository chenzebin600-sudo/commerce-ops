import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FoundationRepository } from "../lib/foundation/foundation-repository.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { GrowthRadarV2Repository } from "../lib/growth-radar/v2/growth-radar-v2-repository.mjs";
import { GrowthRadarV2Service } from "../lib/growth-radar/v2/growth-radar-v2-service.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const databasePath = path.resolve(appRoot, options.databasePath || "");
const manifestPath = path.resolve(appRoot, options.manifestPath || "");
const actor = String(options.actor || "foundation-v1-go-live").trim();

if (!options.execute) {
  throw new Error("Pass --execute after the formal migration and backup gates are approved.");
}
if (!options.databasePath || !options.manifestPath || !options.expectedManifestSha256) {
  throw new Error(
    "--database-path, --mapping-manifest, and --expected-manifest-sha256 are required.",
  );
}
if (!actor) throw new Error("--actor must not be empty.");

const manifestBytes = await fs.readFile(manifestPath);
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
if (manifestSha256 !== options.expectedManifestSha256.toLowerCase()) {
  throw new Error(`Mapping manifest SHA-256 mismatch: ${manifestSha256}`);
}
const manifest = JSON.parse(manifestBytes.toString("utf8"));
validateManifest(manifest);

const provider = new SqliteProvider({ databasePath });
const foundationRepository = new FoundationRepository({ provider });
const growthRepository = new GrowthRadarV2Repository({ provider });
const foundation = new FoundationService({ repository: foundationRepository });
const growth = new GrowthRadarV2Service({ repository: growthRepository });
const initializedAt = new Date().toISOString();

try {
  await assertDatabaseGate(provider);
  const ownerResult = await initializeStoreOwners(
    provider,
    manifest.ownerMapping.assignments,
    initializedAt,
  );
  const countryResult = await growth.saveCountryMappings({
    description: "Foundation V1 approved warehouse-country mappings",
    mappings: manifest.warehouseMapping.mappings.map((mapping) => ({
      sourceWarehouseName: mapping.sourceWarehouseName,
      normalizedWarehouseName: mapping.normalizedWarehouseName,
      countryCode: mapping.countryCode,
      countryName: mapping.countryName,
      mappingStatus: mapping.mappingStatus,
      exclusionReason: mapping.exclusionReason,
      note: mapping.evidenceType,
    })),
  }, { actorLabel: actor });

  const firstProjection = await foundation.synchronize();
  const warehouseResult = await initializeFoundationWarehouses(
    provider,
    manifest.warehouseMapping.mappings,
    countryResult.set.id,
    actor,
    initializedAt,
  );
  const taskStateBeforeReplay = await taskState(provider);
  const secondProjection = await foundation.synchronize();
  const taskStateAfterReplay = await taskState(provider);
  if (JSON.stringify(taskStateAfterReplay) !== JSON.stringify(taskStateBeforeReplay)) {
    throw new Error("Foundation projection replay changed task count or state versions.");
  }

  const verification = await verifyInitialization(provider, manifest);
  if (!verification.ok) {
    throw new Error(`Foundation initialization verification failed: ${JSON.stringify(verification)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    databasePath,
    manifestPath,
    manifestSha256,
    initializedAt,
    ownerResult,
    countryMapping: {
      id: countryResult.set.id,
      version: countryResult.set.version,
      mappingCount: countryResult.mappings.length,
      reused: countryResult.reused,
    },
    warehouseResult,
    firstProjection,
    secondProjection,
    taskReplayIdempotent: true,
    verification,
  }, null, 2)}\n`);
} finally {
  provider.close();
}

function parseArguments(argumentsList) {
  const result = { execute: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--execute") {
      result.execute = true;
      continue;
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (argument === "--database-path") result.databasePath = value;
    else if (argument === "--mapping-manifest") result.manifestPath = value;
    else if (argument === "--expected-manifest-sha256") result.expectedManifestSha256 = value;
    else if (argument === "--actor") result.actor = value;
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return result;
}

function validateManifest(manifest) {
  if (manifest.contractVersion !== "FOUNDATION-V1-GO-LIVE-MAPPINGS-1.0.0") {
    throw new Error(`Unsupported mapping contract: ${manifest.contractVersion}`);
  }
  const owner = manifest.ownerMapping;
  const warehouse = manifest.warehouseMapping;
  if (
    owner?.assignmentCount !== 107
    || owner?.distinctOwnerCount !== 21
    || owner?.ambiguousCount !== 0
    || owner?.unresolvedCount !== 0
    || owner?.assignments?.length !== 107
  ) {
    throw new Error("Owner mapping manifest does not meet the 107/21/0/0 gate.");
  }
  if (
    warehouse?.warehouseCount !== 29
    || warehouse?.confirmedCount !== 27
    || warehouse?.excludedCount !== 2
    || warehouse?.mappings?.length !== 29
  ) {
    throw new Error("Warehouse mapping manifest does not meet the 29/27/2 gate.");
  }
  if (new Set(owner.assignments.map((item) => item.storeId)).size !== 107) {
    throw new Error("Owner mapping contains duplicate store IDs.");
  }
  if (new Set(warehouse.mappings.map((item) => item.normalizedWarehouseName)).size !== 29) {
    throw new Error("Warehouse mapping contains duplicate normalized names.");
  }
}

async function assertDatabaseGate(provider) {
  const latest = (await provider.query(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
  )).rows[0]?.version;
  if (!["022_commerce_ops_foundation_v1.sql", "023_foundation_operation_plans.sql"].includes(latest)) {
    throw new Error(`Foundation initialization requires migration 022 or 023, found ${latest}`);
  }
  if ((await provider.query("PRAGMA integrity_check")).rows.some(
    (row) => row.integrity_check !== "ok",
  )) {
    throw new Error("Database integrity gate failed.");
  }
  if ((await provider.query("PRAGMA foreign_key_check")).rows.length !== 0) {
    throw new Error("Database foreign-key gate failed.");
  }
}

async function initializeStoreOwners(provider, assignments, at) {
  return provider.transaction(async (client) => {
    let changedCount = 0;
    for (const assignment of assignments) {
      if (assignment.mappingStatus !== "confirmed_from_order_source") {
        throw new Error(`Store ${assignment.storeId} is not confirmed.`);
      }
      const store = (await client.query(
        "SELECT id,internal_shop_code,display_name,owner_user_id FROM growth_shops WHERE id=?",
        [assignment.storeId],
      )).rows[0];
      if (
        !store
        || store.internal_shop_code !== assignment.internalShopCode
        || store.display_name !== assignment.displayName
      ) {
        throw new Error(`Store mapping evidence does not match ${assignment.storeId}.`);
      }
      if (store.owner_user_id !== assignment.ownerExternalKey) {
        await client.execute(
          `UPDATE growth_shops
           SET owner_user_id=?,revision=revision+1,updated_at=?
           WHERE id=?`,
          [assignment.ownerExternalKey, at, assignment.storeId],
        );
        changedCount += 1;
      }
    }
    return {
      assignmentCount: assignments.length,
      changedCount,
      ownerCount: new Set(assignments.map((item) => item.ownerExternalKey)).size,
    };
  });
}

async function initializeFoundationWarehouses(
  provider,
  mappings,
  countryMappingSetId,
  actor,
  at,
) {
  return provider.transaction(async (client) => {
    let confirmedCount = 0;
    let excludedCount = 0;
    for (const mapping of mappings) {
      const warehouse = (await client.query(
        `SELECT * FROM foundation_warehouses
         WHERE normalized_name=LOWER(TRIM(?))`,
        [mapping.normalizedWarehouseName],
      )).rows;
      if (warehouse.length !== 1) {
        throw new Error(
          `Expected one Foundation warehouse for ${mapping.normalizedWarehouseName}, found ${warehouse.length}.`,
        );
      }
      const status = mapping.mappingStatus === "excluded" ? "excluded" : "confirmed";
      const metadata = {
        sourceSystem: "mabang",
        countryMappingSetId,
        mappingStatus: status,
        evidenceType: mapping.evidenceType,
        observationCount: Number(mapping.observationCount || 0),
      };
      await client.execute(
        `UPDATE foundation_warehouses
         SET country_code=?,country_name=?,identity_status=?,metadata_json=?,updated_at=?
         WHERE id=?`,
        [
          status === "confirmed" ? mapping.countryCode : null,
          status === "confirmed" ? mapping.countryName : null,
          status,
          JSON.stringify(metadata),
          at,
          warehouse[0].id,
        ],
      );
      await client.execute(
        `UPDATE foundation_identity_links
         SET match_status=?,evidence_json=?,confirmed_by=?,confirmed_at=?,updated_at=?
         WHERE entity_type='warehouse' AND entity_id=?`,
        [
          status === "confirmed" ? "confirmed" : "rejected",
          JSON.stringify({
            countryMappingSetId,
            mappingStatus: status,
            evidenceType: mapping.evidenceType,
            exclusionReason: mapping.exclusionReason || null,
          }),
          status === "confirmed" ? actor : null,
          status === "confirmed" ? at : null,
          at,
          warehouse[0].id,
        ],
      );
      if (status === "confirmed") confirmedCount += 1;
      else excludedCount += 1;
    }
    return { mappingCount: mappings.length, confirmedCount, excludedCount };
  });
}

async function taskState(provider) {
  const result = await provider.query(
    `SELECT id,state,state_version
     FROM foundation_tasks
     ORDER BY id`,
  );
  return result.rows;
}

async function verifyInitialization(provider, manifest) {
  const ownerCoverage = (await provider.query(
    `SELECT
       COUNT(*) AS store_count,
       SUM(CASE WHEN owner_user_id IS NOT NULL AND TRIM(owner_user_id)<>'' THEN 1 ELSE 0 END)
         AS assigned_count,
       COUNT(DISTINCT owner_user_id) AS owner_count
     FROM growth_shops`,
  )).rows[0];
  const warehouseCoverage = (await provider.query(
    `SELECT
       COUNT(*) AS warehouse_count,
       SUM(CASE WHEN identity_status='confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
       SUM(CASE WHEN identity_status='excluded' THEN 1 ELSE 0 END) AS excluded_count,
       SUM(CASE WHEN identity_status='review_required' THEN 1 ELSE 0 END) AS review_count
     FROM foundation_warehouses`,
  )).rows[0];
  const activeMapping = (await provider.query(
    `SELECT id,version FROM growth_country_mapping_sets
     WHERE status='active'`,
  )).rows[0];
  const activeMappingCount = Number((await provider.query(
    "SELECT COUNT(*) AS count FROM growth_warehouse_country_mappings WHERE mapping_set_id=?",
    [activeMapping?.id || ""],
  )).rows[0]?.count || 0);
  const foundationCounts = Object.fromEntries((await Promise.all([
    "foundation_owners",
    "foundation_warehouses",
    "foundation_identity_links",
    "foundation_source_runs",
    "foundation_tasks",
  ].map(async (table) => [
    table,
    Number((await provider.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count),
  ]))));
  const integrity = (await provider.query("PRAGMA integrity_check")).rows[0]?.integrity_check;
  const foreignKeyViolations = (await provider.query("PRAGMA foreign_key_check")).rows.length;
  const result = {
    storeCount: Number(ownerCoverage.store_count),
    assignedStoreCount: Number(ownerCoverage.assigned_count),
    ownerCount: Number(ownerCoverage.owner_count),
    warehouseCount: Number(warehouseCoverage.warehouse_count),
    confirmedWarehouseCount: Number(warehouseCoverage.confirmed_count),
    excludedWarehouseCount: Number(warehouseCoverage.excluded_count),
    reviewWarehouseCount: Number(warehouseCoverage.review_count),
    activeCountryMappingSetId: activeMapping?.id || null,
    activeCountryMappingVersion: activeMapping?.version || null,
    activeCountryMappingCount: activeMappingCount,
    foundationCounts,
    integrity,
    foreignKeyViolations,
  };
  return {
    ok: (
      result.storeCount === manifest.ownerMapping.assignmentCount
      && result.assignedStoreCount === manifest.ownerMapping.assignmentCount
      && result.ownerCount === manifest.ownerMapping.distinctOwnerCount
      && result.warehouseCount === manifest.warehouseMapping.warehouseCount
      && result.confirmedWarehouseCount === manifest.warehouseMapping.confirmedCount
      && result.excludedWarehouseCount === manifest.warehouseMapping.excludedCount
      && result.reviewWarehouseCount === 0
      && result.activeCountryMappingCount === manifest.warehouseMapping.warehouseCount
      && integrity === "ok"
      && foreignKeyViolations === 0
    ),
    ...result,
  };
}
