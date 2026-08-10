import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PostgresqlProvider } from "../../data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../f1-config.mjs";
import { createSqliteMigrationSnapshot } from "../sqlite-migration.mjs";
import {
  SHADOW_APP_SCHEMA,
  SHADOW_DATABASE,
  buildShadowSchema,
} from "../shadow/shadow-schema.mjs";
import { resolveRuntimeConfig } from "../../runtime-config.mjs";
import { MigrationSyncService, seedSyncStateFromBaseline } from "./migration-sync-service.mjs";
import { MigrationSyncValidator } from "./migration-sync-validator.mjs";
import { buildIncrementalSyncManifest } from "./sync-manifest.mjs";
import { SyncControlRepository } from "./sync-control-repository.mjs";
import {
  DELETE_RECONCILIATION_MODES,
  resolveDeleteReconciliationPolicy,
} from "./delete-policy.mjs";

const CONTROL_MIGRATION = "004_incremental_sync_control.sql";

function enabled(value) {
  return new Set(["1", "true", "yes", "on"]).has(String(value || "").trim().toLowerCase());
}

async function fileSha256(filePath) {
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(filePath).on("data", (chunk) => digest.update(chunk)).on("end", resolve).on("error", reject);
  });
  return digest.digest("hex");
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function inspectControlMigration({ rootDir, provider }) {
  const migrationPath = path.join(rootDir, "postgresql", "shadow", "migrations", CONTROL_MIGRATION);
  const sql = await fs.readFile(migrationPath, "utf8");
  const sha256 = crypto.createHash("sha256").update(sql).digest("hex");
  const existing = (await provider.query(
    "SELECT sha256 FROM shadow_meta.schema_migrations WHERE version=$1",
    [CONTROL_MIGRATION],
  )).rows[0];
  if (existing) {
    if (existing.sha256 !== sha256) throw new Error(`Applied Shadow migration hash changed: ${CONTROL_MIGRATION}`);
    return { version: CONTROL_MIGRATION, sha256, status: "ALREADY_APPLIED", sql };
  }
  return { version: CONTROL_MIGRATION, sha256, status: "NOT_APPLIED", sql };
}

async function applyControlMigration({ rootDir, provider }) {
  const inspected = await inspectControlMigration({ rootDir, provider });
  if (inspected.status === "ALREADY_APPLIED") {
    return { version: inspected.version, sha256: inspected.sha256, status: inspected.status };
  }
  await provider.transaction(async (tx) => {
    await tx.executeScript(inspected.sql);
    await tx.query(
      "INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)",
      [CONTROL_MIGRATION, inspected.sha256],
    );
  });
  return { version: CONTROL_MIGRATION, sha256: inspected.sha256, status: "APPLIED" };
}

async function assertShadowTarget({ provider, config, writable }) {
  const identity = (await provider.query(`
    SELECT current_database() database,current_user username,current_schema() schema,
      current_setting('default_transaction_read_only') read_only
  `)).rows[0];
  if (identity.database !== SHADOW_DATABASE) throw new Error(`Incremental sync target must be ${SHADOW_DATABASE}`);
  if (identity.username !== config.migratorUser) throw new Error("Incremental sync requires the PostgreSQL migrator role");
  if (identity.schema !== SHADOW_APP_SCHEMA) throw new Error(`Incremental sync schema must be ${SHADOW_APP_SCHEMA}`);
  const expectedReadOnly = writable ? "off" : "on";
  if (identity.read_only !== expectedReadOnly) {
    throw new Error(`Incremental sync transaction mode must be ${writable ? "writable" : "read-only"}`);
  }
  return identity;
}

async function assertBaselineMatchesShadow({ provider, baselineHash }) {
  const result = await provider.query(`
    SELECT DISTINCT source_snapshot_sha256 FROM shadow_meta.table_loads
  `);
  const hashes = result.rows.map((row) => row.source_snapshot_sha256);
  if (hashes.length !== 1 || hashes[0] !== baselineHash) {
    throw new Error("Phase 1 SQLite baseline does not match the loaded PostgreSQL Shadow snapshot");
  }
}

async function createCurrentSnapshot({ rootDir, sourcePath, existingSnapshotPath = null }) {
  const directory = path.join(rootDir, "tmp", "postgresql-incremental-sync");
  await fs.mkdir(directory, { recursive: true });
  if (existingSnapshotPath) {
    const selected = path.resolve(existingSnapshotPath);
    if (path.dirname(selected) !== directory || !path.basename(selected).startsWith("commerce-ops-incremental-")) {
      throw new Error("Reusable incremental snapshot must stay inside tmp/postgresql-incremental-sync");
    }
    const database = new DatabaseSync(selected, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
      const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
      if (integrity !== "ok" || foreignKeyViolations !== 0) throw new Error("Reusable SQLite snapshot failed integrity gates");
      const stat = await fs.stat(selected);
      const snapshotHash = await fileSha256(selected);
      return {
        path: selected,
        time: stat.mtime.toISOString(),
        sha256: snapshotHash,
        sourceBytes: (await fs.stat(sourcePath)).size,
        snapshotBytes: stat.size,
        snapshotHash,
        integrity,
        foreignKeyViolations,
        readOnly: true,
        reused: true,
      };
    } finally {
      database.close();
    }
  }
  const snapshotPath = path.join(directory, `commerce-ops-incremental-${timestampId()}-${crypto.randomUUID().slice(0, 8)}.sqlite`);
  const info = await createSqliteMigrationSnapshot({
    sourcePath,
    destinationPath: snapshotPath,
    backupRatePages: 4096,
    pinReadSnapshot: true,
  });
  if (info.integrity !== "ok" || info.foreignKeyViolations !== 0) {
    throw new Error("Current SQLite snapshot failed integrity gates");
  }
  return {
    path: snapshotPath,
    time: (await fs.stat(snapshotPath)).mtime.toISOString(),
    sha256: info.snapshotHash,
    ...info,
  };
}

function markdownReport({ result, status, migration, snapshot, baseline }) {
  const sync = result.sync;
  const validation = result.validation;
  const rows = sync?.tables?.map((table) => `| \`${table.table}\` | ${table.domain} | ${table.examined} | ${table.inserted} | ${table.updated} | ${table.skipped} |`).join("\n") || "| - | - | - | - | - | - |";
  const differences = validation?.tables?.filter((table) => !table.countMatch) || [];
  return `# Commerce Ops PostgreSQL Incremental Sync Report

Status: **${status}**  
Direction: \`SQLite -> PostgreSQL Shadow\`  
Production provider: \`sqlite\`

## Safety

- Formal SQLite was opened read-only and copied with the SQLite online backup API.
- The only write target was \`${SHADOW_DATABASE}\` through the migrator role.
- No reverse synchronization, production provider switch, business-Agent development, or file migration occurred.
- Hard-delete reconciliation mode: \`${result.deletePolicy?.mode || "BLOCK"}\`; rows deleted: ${sync?.rowsDeleted || 0}.
- \`is_switch_ready\` remains false even when validation passes.

## Baseline

- Phase 1 snapshot: \`${baseline.path}\`
- Phase 1 snapshot time: \`${baseline.time}\`
- Phase 1 SHA-256: \`${baseline.sha256}\`
- Control migration: \`${migration.version}\` (${migration.status})

## Current snapshot

- Path: \`${snapshot.path}\`
- Snapshot time: \`${snapshot.time}\`
- SHA-256: \`${snapshot.sha256}\`
- Integrity: \`${snapshot.integrity}\`
- Foreign-key violations: ${snapshot.foreignKeyViolations}

## Synchronization

- Batch: \`${sync?.batchId || "none"}\`
- Tables: ${sync?.tables?.length || 0}
- Rows examined: ${sync?.rowsExamined || 0}
- INSERT: ${sync?.rowsInserted || 0}
- UPDATE: ${sync?.rowsUpdated || 0}
- DELETE candidates: ${sync?.deleteCandidates || 0}
- DELETE applied: ${sync?.rowsDeleted || 0}
- Skipped by full-table digest: ${sync?.rowsSkipped || 0}

| Table | Domain | Examined | Inserted | Updated | Skipped |
|---|---|---:|---:|---:|---:|
${rows}

## Validation

- Result: **${validation?.status || "NOT_RUN"}**
- Tables checked: ${validation?.tables?.length || 0}
- Count differences: ${validation?.countFailures ?? "n/a"}
- Deterministic random samples: ${validation?.sampleCount ?? "n/a"}
- Sample failures: ${validation?.sampleFailures ?? "n/a"}
- Business counts: ${validation ? JSON.stringify(validation.business) : "not run"}
- Differences: ${differences.length ? differences.map((item) => `\`${item.table}\` (${item.source}/${item.target})`).join(", ") : "none"}

Hard deletes are blocked by default. Exact target-only primary keys are detected only during an explicitly requested full reconcile; deletion additionally requires the dedicated environment gate and exact Shadow database confirmation. Domain soft-delete/status rows continue to synchronize as ordinary updates.
`;
}

async function writeRunReport({ rootDir, result, migration, snapshot, baseline }) {
  const reportDir = path.join(rootDir, "docs", "reports");
  await fs.mkdir(reportDir, { recursive: true });
  const suffix = result.sync?.batchId?.slice(0, 8) || timestampId();
  const basename = `COMMERCE-OPS-POSTGRESQL-INCREMENTAL-SYNC-20260806-${suffix}`;
  const jsonPath = path.join(reportDir, `${basename}.json`);
  const markdownPath = path.join(reportDir, `${basename}.md`);
  const portablePath = (value) => path.relative(rootDir, value).split(path.sep).join("/");
  const portableBaseline = { ...baseline, path: portablePath(baseline.path) };
  const portableSnapshot = { ...snapshot, path: portablePath(snapshot.path) };
  const payload = {
    status: result.validation?.status || "UNKNOWN",
    productionProvider: "sqlite",
    target: SHADOW_DATABASE,
    migration,
    baseline: portableBaseline,
    snapshot: portableSnapshot,
    ...result,
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, markdownReport({
    result,
    status: payload.status,
    migration,
    snapshot: portableSnapshot,
    baseline: portableBaseline,
  }), "utf8");
  return { jsonPath, markdownPath };
}

export async function runShadowIncrementalSync({
  rootDir = process.cwd(),
  command = "sync",
  apply = false,
  fullReconcile = false,
  pauseReason = "paused by operator",
  deleteMode = DELETE_RECONCILIATION_MODES.BLOCK,
  deleteConfirmation = null,
  env = process.env,
} = {}) {
  const productionProvider = String(env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (productionProvider !== "sqlite") throw new Error("Production DATABASE_PROVIDER must remain sqlite");
  if (command !== "status" && apply && !enabled(env.POSTGRES_SHADOW_SYNC_ENABLED)) {
    throw new Error("Set POSTGRES_SHADOW_SYNC_ENABLED=true for explicit Shadow writes");
  }
  const deletePolicy = resolveDeleteReconciliationPolicy({
    mode: deleteMode,
    apply,
    fullReconcile,
    confirmation: deleteConfirmation,
    targetDatabase: SHADOW_DATABASE,
    deleteEnabled: env.POSTGRES_SHADOW_DELETE_ENABLED,
  });
  if (deletePolicy.mode !== DELETE_RECONCILIATION_MODES.BLOCK && command !== "sync") {
    throw new Error("DELETE reconciliation is only available with --command=sync");
  }

  const config = loadPostgresqlF1Config({ rootDir, env });
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env });
  const baselinePath = path.join(rootDir, "tmp", "postgresql-shadow-phase1", "commerce-ops-shadow-source.sqlite");
  const baselineStat = await fs.stat(baselinePath);
  const baseline = { path: baselinePath, time: baselineStat.mtime.toISOString(), sha256: await fileSha256(baselinePath) };
  const provider = new PostgresqlProvider({
    config: Object.freeze({ ...config, schema: SHADOW_APP_SCHEMA }),
    database: SHADOW_DATABASE,
    user: config.migratorUser,
    password: config.migratorPassword,
    readOnly: !apply,
  });
  let baselineDatabase;
  let sourceDatabase;
  try {
    const identity = await assertShadowTarget({ provider, config, writable: apply });
    await assertBaselineMatchesShadow({ provider, baselineHash: baseline.sha256 });
    if (command === "status") {
      const migration = await inspectControlMigration({ rootDir, provider });
      if (migration.status === "NOT_APPLIED") {
        return { status: "STATUS", identity, migration: { ...migration, sql: undefined }, state: null, tableStates: [], batches: [], validations: [] };
      }
      const control = new SyncControlRepository({ provider });
      return { status: "STATUS", identity, migration: { ...migration, sql: undefined }, ...(await control.status()) };
    }
    if (!apply) {
      const baselineRead = new DatabaseSync(baselinePath, { readOnly: true });
      try {
        const manifest = buildIncrementalSyncManifest(buildShadowSchema(baselineRead).source);
        return {
          status: "PLAN",
          command,
          productionProvider,
          identity,
          baseline,
          deletePolicy,
          tableCount: manifest.length,
          tables: manifest.map((spec) => ({ table: spec.name, domain: spec.domain, captureMode: spec.captureMode, watermark: spec.watermarkColumn })),
        };
      } finally {
        baselineRead.close();
      }
    }

    const migration = await applyControlMigration({ rootDir, provider });
    const control = new SyncControlRepository({ provider });
    if (command === "pause") return { status: "PAUSED", identity, migration, state: await control.pause(pauseReason) };
    if (command === "resume") return { status: "RESUMED", identity, migration, state: await control.resume() };

    const snapshot = await createCurrentSnapshot({
      rootDir,
      sourcePath: runtime.databasePath,
      existingSnapshotPath: env.POSTGRES_INCREMENTAL_SOURCE_SNAPSHOT || null,
    });
    baselineDatabase = new DatabaseSync(baselinePath, { readOnly: true });
    sourceDatabase = new DatabaseSync(snapshot.path, { readOnly: true });
    baselineDatabase.exec("PRAGMA query_only=ON");
    sourceDatabase.exec("PRAGMA query_only=ON");
    const baselineSchema = buildShadowSchema(baselineDatabase).source;
    const currentSchema = buildShadowSchema(sourceDatabase).source;
    const manifest = buildIncrementalSyncManifest(currentSchema);
    const baselineManifest = buildIncrementalSyncManifest(baselineSchema);
    if (manifest.map((spec) => spec.name).join("\n") !== baselineManifest.map((spec) => spec.name).join("\n")) {
      throw new Error("Incremental sync table scope changed since the Phase 1 baseline");
    }
    await control.ensureState({ migrationSnapshotTime: baseline.time, sourceSnapshotSha256: baseline.sha256 });
    await seedSyncStateFromBaseline({ baselineDatabase, provider, control, manifest: baselineManifest });

    let sync = null;
    if (command !== "validate") {
      sync = await new MigrationSyncService({ sourceDatabase, provider, control, manifest, deletePolicy }).run({
        sourceSnapshotTime: snapshot.time,
        sourceSnapshotSha256: snapshot.sha256,
        fullReconcile,
      });
    }
    const validation = await new MigrationSyncValidator({ sourceDatabase, provider, manifest, deletePolicy }).validate({
      sourceSnapshotTime: snapshot.time,
      sourceSnapshotSha256: snapshot.sha256,
    });
    const validationId = await control.recordValidation({ syncBatchId: sync?.batchId || null, validation });
    const state = await control.getState();
    const result = { sync, validation, validationId, state, identity, deletePolicy };
    const report = await writeRunReport({ rootDir, result, migration, snapshot, baseline });
    return { status: validation.status, migration, snapshot, baseline, report, ...result };
  } finally {
    baselineDatabase?.close();
    sourceDatabase?.close();
    await provider.close();
  }
}
