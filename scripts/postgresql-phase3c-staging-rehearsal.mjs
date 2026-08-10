import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import {
  POSTGRESQL_STAGING_APP_USER,
  POSTGRESQL_STAGING_DATABASE,
  POSTGRESQL_STAGING_ENV_FILENAME,
  loadPostgresqlStagingConfig,
} from "../lib/postgresql/staging-config.mjs";
import {
  PHASE3C_STAGING_CONTRACT,
  resolvePhase3cStagingInvocation,
} from "../lib/postgresql/phase3c-staging.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { quoteIdentifier, createSqliteMigrationSnapshot } from "../lib/postgresql/sqlite-migration.mjs";
import { buildShadowSchema } from "../lib/postgresql/shadow/shadow-schema.mjs";
import { buildIncrementalSyncManifest } from "../lib/postgresql/incremental-sync/sync-manifest.mjs";
import { SyncControlRepository } from "../lib/postgresql/incremental-sync/sync-control-repository.mjs";
import {
  MigrationSyncService,
  projectAgentObservability,
  reconcileTargetOnlyRows,
} from "../lib/postgresql/incremental-sync/migration-sync-service.mjs";
import { MigrationSyncValidator } from "../lib/postgresql/incremental-sync/migration-sync-validator.mjs";
import { ProductCatalogRepository } from "../lib/data/repositories/product-catalog-repository.mjs";
import { ProviderAuditRepository } from "../lib/data/provider-audit-repository.mjs";
import { FoundationRepository } from "../lib/foundation/foundation-repository.mjs";
import { FoundationTaskService } from "../lib/foundation/foundation-task-service.mjs";
import { ProviderSchedulerRepository } from "../lib/data/provider-scheduler-repository.mjs";
import { ProviderExportFileRepository } from "../lib/files/provider-export-file-repository.mjs";
import { AgentObservabilityRepository } from "../lib/ai/observability/agent-observability-repository.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const STATE_ID = "sqlite-to-postgresql-staging";
const BLOCK_DELETE_POLICY = Object.freeze({
  mode: "BLOCK",
  fullReconcile: false,
  executesDetection: false,
  executesDeletes: false,
});

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeError(error) {
  return {
    code: String(error?.code || "PHASE3C_STAGING_FAILED").slice(0, 80),
    message: String(error?.message || error).split(/\r?\n/)[0].slice(0, 400),
  };
}

function createProvider(base, { database, user, password, readOnly = false }) {
  return new PostgresqlProvider({
    config: Object.freeze({ ...base, schema: "app" }),
    database,
    user,
    password,
    readOnly,
  });
}

async function databaseEvidence(provider, names) {
  return (await provider.query(`
    SELECT datname,oid::text oid,pg_database_size(datname)::text bytes
    FROM pg_database WHERE datname=ANY($1::text[]) ORDER BY datname
  `, [names])).rows;
}

async function writeStagingEnv(password) {
  const envPath = path.join(rootDir, POSTGRESQL_STAGING_ENV_FILENAME);
  await fs.writeFile(envPath, [
    `POSTGRES_STAGING_DATABASE=${POSTGRESQL_STAGING_DATABASE}`,
    `POSTGRES_STAGING_APP_USER=${POSTGRESQL_STAGING_APP_USER}`,
    `POSTGRES_STAGING_APP_PASSWORD=${password}`,
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  try { await fs.chmod(envPath, 0o600); } catch {}
  return envPath;
}

async function provisionStaging(base, invocation) {
  const admin = createProvider(base, {
    database: "postgres",
    user: base.adminUser,
    password: base.adminPassword,
  });
  const protectedDatabases = [base.database, base.testDatabase, "commerce_ops_shadow"];
  const password = crypto.randomBytes(36).toString("base64url");
  try {
    const before = await databaseEvidence(admin, [...protectedDatabases, invocation.targetDatabase]);
    if (before.some((row) => row.datname === invocation.targetDatabase)) {
      throw Object.assign(new Error("The independent staging database already exists; this runner will not rebuild it implicitly"), {
        code: "PHASE3C_STAGING_ALREADY_EXISTS",
      });
    }
    const template = before.find((row) => row.datname === base.testDatabase);
    if (!template) throw new Error("The completed Phase 3B migration-test database is missing");
    const membership = (await admin.query(`
      SELECT parent.rolname parent_role
      FROM pg_auth_members membership
      JOIN pg_roles child ON child.oid=membership.member
      JOIN pg_roles parent ON parent.oid=membership.roleid
      WHERE child.rolname=$1
    `, [POSTGRESQL_STAGING_APP_USER])).rows;
    if (membership.length) throw new Error("Existing staging application role has unexpected role memberships");
    const roleExists = Boolean((await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) present",
      [POSTGRESQL_STAGING_APP_USER],
    )).rows[0].present);
    if (roleExists) {
      await admin.executeScript(`ALTER ROLE ${quoteIdentifier(POSTGRESQL_STAGING_APP_USER)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`);
    } else {
      await admin.executeScript(`CREATE ROLE ${quoteIdentifier(POSTGRESQL_STAGING_APP_USER)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`);
    }
    await admin.executeScript(`CREATE DATABASE ${quoteIdentifier(invocation.targetDatabase)} WITH TEMPLATE ${quoteIdentifier(base.testDatabase)} OWNER ${quoteIdentifier(base.migratorUser)}`);
    await admin.executeScript(`REVOKE ALL ON DATABASE ${quoteIdentifier(invocation.targetDatabase)} FROM PUBLIC`);
    await admin.executeScript(`REVOKE CREATE,TEMPORARY ON DATABASE ${quoteIdentifier(invocation.targetDatabase)} FROM ${quoteIdentifier(POSTGRESQL_STAGING_APP_USER)}`);
    await admin.executeScript(`GRANT CONNECT ON DATABASE ${quoteIdentifier(invocation.targetDatabase)} TO ${quoteIdentifier(base.migratorUser)},${quoteIdentifier(POSTGRESQL_STAGING_APP_USER)}`);
    const after = await databaseEvidence(admin, [...protectedDatabases, invocation.targetDatabase]);
    for (const name of protectedDatabases) {
      assert.deepEqual(
        after.find((row) => row.datname === name),
        before.find((row) => row.datname === name),
        `Protected database identity changed: ${name}`,
      );
    }
    await writeStagingEnv(password);
    return {
      template: { database: template.datname, oid: template.oid },
      staging: after.find((row) => row.datname === invocation.targetDatabase),
      protectedDatabases: protectedDatabases.map((name) => {
        const row = after.find((item) => item.datname === name);
        return row ? { database: name, oid: row.oid } : { database: name, oid: null };
      }),
      separateDatabaseOid: after.find((row) => row.datname === invocation.targetDatabase)?.oid !== template.oid,
      secretFile: POSTGRESQL_STAGING_ENV_FILENAME,
      secretPrinted: false,
    };
  } finally {
    await admin.close();
  }
}

async function resetStagingAndGrant(base, password) {
  const migrator = createProvider(base, {
    database: POSTGRESQL_STAGING_DATABASE,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const identity = (await migrator.query("SELECT current_database() database,current_user username")).rows[0];
    assert.deepEqual(identity, { database: POSTGRESQL_STAGING_DATABASE, username: base.migratorUser });
    const appTables = (await migrator.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_type='BASE TABLE' ORDER BY table_name",
    )).rows.map((row) => `app.${quoteIdentifier(row.table_name)}`);
    if (!appTables.length) throw new Error("Phase 3B staging template contains no application tables");
    await migrator.executeScript(`TRUNCATE TABLE ${appTables.join(",")} RESTART IDENTITY CASCADE`);
    const aiTables = (await migrator.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='ai_shadow' AND table_type='BASE TABLE' ORDER BY table_name",
    )).rows.map((row) => `ai_shadow.${quoteIdentifier(row.table_name)}`);
    if (aiTables.length) await migrator.executeScript(`TRUNCATE TABLE ${aiTables.join(",")} CASCADE`);
    await migrator.executeScript("TRUNCATE TABLE shadow_meta.migration_state CASCADE");
    await migrator.executeScript("TRUNCATE TABLE shadow_meta.table_loads");
    const targetConstraint = (await migrator.query(`
      SELECT conname,pg_get_constraintdef(oid) definition
      FROM pg_constraint
      WHERE conrelid='shadow_meta.migration_state'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) ILIKE '%target_provider%'
    `)).rows[0];
    if (targetConstraint && !targetConstraint.definition.includes("postgresql_staging")) {
      await migrator.executeScript(`ALTER TABLE shadow_meta.migration_state DROP CONSTRAINT ${quoteIdentifier(targetConstraint.conname)}`);
      await migrator.executeScript("ALTER TABLE shadow_meta.migration_state ADD CONSTRAINT migration_state_target_provider_check CHECK (target_provider IN ('postgresql_shadow','postgresql_staging'))");
    }
    const app = quoteIdentifier(POSTGRESQL_STAGING_APP_USER);
    await migrator.executeScript(`
      REVOKE ALL ON SCHEMA app,ai_shadow,shadow_meta FROM PUBLIC;
      REVOKE ALL ON SCHEMA app,ai_shadow,shadow_meta FROM ${app};
      REVOKE CREATE ON SCHEMA public FROM PUBLIC,${app};
      GRANT USAGE ON SCHEMA app,ai_shadow TO ${app};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app,ai_shadow TO ${app};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app,ai_shadow TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(base.migratorUser)} IN SCHEMA app
        GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(base.migratorUser)} IN SCHEMA ai_shadow
        GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(base.migratorUser)} IN SCHEMA app
        GRANT USAGE,SELECT ON SEQUENCES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(base.migratorUser)} IN SCHEMA ai_shadow
        GRANT USAGE,SELECT ON SEQUENCES TO ${app};
    `);
    return { appTables: appTables.length, aiTables: aiTables.length, passwordRetainedInProcessOnly: Boolean(password) };
  } finally {
    await migrator.close();
  }
}

async function createSnapshot(runtime, label) {
  const directory = path.join(rootDir, "tmp", "postgresql-phase3c");
  await fs.mkdir(directory, { recursive: true });
  const snapshotPath = path.join(directory, `${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.sqlite`);
  const info = await createSqliteMigrationSnapshot({
    sourcePath: runtime.databasePath,
    destinationPath: snapshotPath,
    backupRatePages: 4096,
    pinReadSnapshot: true,
  });
  if (info.integrity !== "ok" || info.foreignKeyViolations !== 0) {
    throw new Error(`${label} SQLite snapshot failed integrity gates`);
  }
  return {
    path: snapshotPath,
    relativePath: path.relative(rootDir, snapshotPath).split(path.sep).join("/"),
    time: (await fs.stat(snapshotPath)).mtime.toISOString(),
    sha256: info.snapshotHash,
    integrity: info.integrity,
    foreignKeyViolations: info.foreignKeyViolations,
    sourceBytes: info.sourceBytes,
    snapshotBytes: info.snapshotBytes,
  };
}

function openSnapshot(snapshot) {
  const database = new DatabaseSync(snapshot.path, { readOnly: true });
  database.exec("PRAGMA query_only=ON");
  return database;
}

function compactValidation(validation) {
  return {
    status: validation.status,
    tables: validation.tables.length,
    countFailures: validation.countFailures,
    sampleCount: validation.sampleCount,
    sampleFailures: validation.sampleFailures,
    businessFailures: validation.businessFailures,
    business: validation.business,
  };
}

function compactSync(sync) {
  return {
    batchId: sync.batchId,
    tables: sync.tables.length,
    rowsExamined: sync.rowsExamined,
    rowsInserted: sync.rowsInserted,
    rowsUpdated: sync.rowsUpdated,
    rowsSkipped: sync.rowsSkipped,
    deleteCandidates: sync.deleteCandidates,
    rowsDeleted: sync.rowsDeleted,
  };
}

async function initialSync({ base, runtime }) {
  const snapshot = await createSnapshot(runtime, "initial-sync");
  const source = openSnapshot(snapshot);
  const provider = createProvider(base, {
    database: POSTGRESQL_STAGING_DATABASE,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const manifest = buildIncrementalSyncManifest(buildShadowSchema(source).source);
    const control = new SyncControlRepository({
      provider,
      stateId: STATE_ID,
      targetProvider: "postgresql_staging",
    });
    await control.ensureState({ migrationSnapshotTime: snapshot.time, sourceSnapshotSha256: snapshot.sha256 });
    for (const spec of manifest) await control.seedTableState({ spec });
    const sync = await new MigrationSyncService({
      sourceDatabase: source,
      provider,
      control,
      manifest,
      batchRows: 250,
      deletePolicy: BLOCK_DELETE_POLICY,
    }).run({
      sourceSnapshotTime: snapshot.time,
      sourceSnapshotSha256: snapshot.sha256,
      fullReconcile: true,
    });
    const validation = await new MigrationSyncValidator({
      sourceDatabase: source,
      provider,
      manifest,
      deletePolicy: BLOCK_DELETE_POLICY,
    }).validate({ sourceSnapshotTime: snapshot.time, sourceSnapshotSha256: snapshot.sha256 });
    if (validation.status !== "PASS") throw new Error("Initial staging sync validation failed");
    await control.recordValidation({ syncBatchId: sync.batchId, validation });
    const projection = await projectAgentObservability(provider);
    return {
      snapshot: { ...snapshot, path: undefined },
      manifestTables: manifest.length,
      sync: compactSync(sync),
      validation: compactValidation(validation),
      projection,
    };
  } finally {
    source.close();
    await provider.close();
  }
}

async function resumeEvidence(base) {
  const provider = createProvider(base, {
    database: POSTGRESQL_STAGING_DATABASE,
    user: base.migratorUser,
    password: base.migratorPassword,
    readOnly: true,
  });
  try {
    const identity = (await provider.query("SELECT current_database() database,current_user username")).rows[0];
    const state = (await provider.query(`SELECT stage,last_validation_status,is_switch_ready,last_successful_batch_id
      FROM shadow_meta.migration_state WHERE id=$1`, [STATE_ID])).rows[0];
    if (!state || state.last_validation_status !== "PASS" || !new Set(["READY", "INCREMENTAL"]).has(state.stage)) {
      throw new Error("Phase 3C staging cannot resume without a successful initial sync validation");
    }
    const counts = (await provider.query(`SELECT
      (SELECT COUNT(*)::text FROM app.product_skus) product_skus,
      (SELECT COUNT(*)::text FROM app.growth_order_headers) order_headers,
      (SELECT COUNT(*)::text FROM app.growth_inventory_snapshots) inventory_snapshots,
      (SELECT COUNT(*)::text FROM app.foundation_tasks) tasks,
      (SELECT COUNT(*)::text FROM app.operation_audit_events) audit_events
    `)).rows[0];
    return { resumed: true, identity, state, counts };
  } finally {
    await provider.close();
  }
}

async function assertDdlDenied(provider, sql, label) {
  try {
    await provider.transaction(async (transaction) => {
      await transaction.executeScript(sql);
      throw Object.assign(new Error(`${label} unexpectedly succeeded`), { code: "DDL_UNEXPECTEDLY_ALLOWED" });
    });
  } catch (error) {
    if (error?.code === "42501") return { operation: label, status: "DENIED", sqlState: error.code };
    throw error;
  }
  throw new Error(`${label} denial was not observed`);
}

async function verifyApplicationRole(base, password) {
  const provider = createProvider(base, {
    database: POSTGRESQL_STAGING_DATABASE,
    user: POSTGRESQL_STAGING_APP_USER,
    password,
  });
  try {
    const identity = (await provider.query(`
      SELECT current_database() database,current_user username,current_schema() schema,
        current_setting('default_transaction_read_only') read_only
    `)).rows[0];
    assert.deepEqual(identity, {
      database: POSTGRESQL_STAGING_DATABASE,
      username: POSTGRESQL_STAGING_APP_USER,
      schema: "app",
      read_only: "off",
    });
    const capabilities = (await provider.query(`
      SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
        has_database_privilege(current_user,current_database(),'CREATE') database_create,
        has_database_privilege(current_user,current_database(),'TEMPORARY') database_temporary,
        has_schema_privilege(current_user,'app','CREATE') app_schema_create,
        has_schema_privilege(current_user,'public','CREATE') public_schema_create,
        (SELECT COUNT(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('app','ai_shadow') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) owned_relations,
        (SELECT COUNT(*)::integer FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) memberships
      FROM pg_roles r WHERE r.rolname=current_user
    `)).rows[0];
    assert.deepEqual(capabilities, {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      database_create: false,
      database_temporary: false,
      app_schema_create: false,
      public_schema_create: false,
      owned_relations: 0,
      memberships: 0,
    });
    const denied = [];
    denied.push(await assertDdlDenied(provider, "CREATE TABLE app.phase3c_forbidden(id integer)", "CREATE"));
    denied.push(await assertDdlDenied(provider, "ALTER TABLE app.operation_audit_events ADD COLUMN phase3c_forbidden integer", "ALTER"));
    denied.push(await assertDdlDenied(provider, "DROP TABLE app.operation_audit_events", "DROP"));
    return { identity, capabilities, denied };
  } finally {
    await provider.close();
  }
}

function auditEvent({ id, requestId, action, timestamp, runId = null, metadata = {}, module = "phase3c" }) {
  return {
    id,
    requestId,
    occurredAt: timestamp,
    module,
    action,
    httpMethod: null,
    requestPath: null,
    status: "success",
    httpStatus: null,
    durationMs: 1,
    sourceIp: null,
    actorType: "system",
    actorIdentifier: null,
    taskId: null,
    runId,
    fileId: null,
    errorStage: null,
    errorCode: null,
    errorSummary: null,
    metadataJson: JSON.stringify(metadata),
    createdAt: timestamp,
  };
}

async function runWriteAndDeleteContracts(base, password) {
  const provider = createProvider(base, {
    database: POSTGRESQL_STAGING_DATABASE,
    user: POSTGRESQL_STAGING_APP_USER,
    password,
  });
  const prefix = `phase3c-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  const ids = {
    productPreference: `${prefix}-product`,
    salesBatch: `${prefix}-sales-batch`,
    inventoryBatch: `${prefix}-inventory-batch`,
    sales: `${prefix}-sales`,
    inventory: `${prefix}-inventory`,
    task: `${prefix}-task`,
    audit: `${prefix}-audit`,
    agentRun: `${prefix}-agent-run`,
    agentStart: `${prefix}-agent-start`,
    agentTool: `${prefix}-agent-tool`,
    agentComplete: `${prefix}-agent-complete`,
    schedulerAccount: `${prefix}-scheduler-account`,
    schedulerRobot: `${prefix}-scheduler-robot`,
    schedulerTask: `${prefix}-scheduler-task`,
  };
  const written = [];
  const deletes = [];
  let productOriginal = null;
  async function cleanup() {
    await provider.execute("DELETE FROM ai_shadow.agent_runs WHERE id=$1", [ids.agentRun]);
    await provider.execute("DELETE FROM operation_audit_events WHERE id=ANY($1::text[])", [[ids.audit, ids.agentStart, ids.agentTool, ids.agentComplete]]);
    await provider.execute("DELETE FROM foundation_task_events WHERE task_id=$1", [ids.task]);
    await provider.execute("DELETE FROM foundation_task_leases WHERE task_id=$1", [ids.task]);
    await provider.execute("DELETE FROM foundation_tasks WHERE id=$1", [ids.task]);
    await provider.execute("DELETE FROM scheduled_export_tasks WHERE id=$1", [ids.schedulerTask]);
    await provider.execute("DELETE FROM dingtalk_robot_configs WHERE id=$1", [ids.schedulerRobot]);
    await provider.execute("DELETE FROM mabang_account_profiles WHERE id=$1", [ids.schedulerAccount]);
    await provider.execute("DELETE FROM growth_inventory_snapshots WHERE id=$1", [ids.inventory]);
    await provider.execute("DELETE FROM growth_order_headers WHERE id=$1", [ids.sales]);
    await provider.execute("DELETE FROM growth_source_batches WHERE id=ANY($1::text[])", [[ids.salesBatch, ids.inventoryBatch]]);
    await provider.execute("DELETE FROM product_detail_preferences WHERE scope_key=$1", [ids.productPreference]);
    if (productOriginal) {
      await provider.execute(`UPDATE product_skus SET
        deleted_at=$1,deleted_by=$2,delete_reason=$3,restored_at=$4,restored_by=$5,updated_at=$6,revision=$7
        WHERE id=$8`, [
        productOriginal.deleted_at,
        productOriginal.deleted_by,
        productOriginal.delete_reason,
        productOriginal.restored_at,
        productOriginal.restored_by,
        productOriginal.updated_at,
        productOriginal.revision,
        productOriginal.id,
      ]);
    }
  }
  try {
    await cleanup();
    const productCatalog = new ProductCatalogRepository({ provider });
    const preference = await productCatalog.savePreference({
      scopeKey: ids.productPreference,
      visibleFields: ["sourceSku", "sourceProductName"],
      operatorLabel: "phase3c-staging",
      requestId: prefix,
    });
    assert.equal(preference.scopeKey, ids.productPreference);
    written.push({ domain: "Product", relation: "app.product_detail_preferences", status: "PASS" });

    for (const [id, sourceType] of [[ids.salesBatch, "mabang_order"], [ids.inventoryBatch, "mabang_inventory"]]) {
      await provider.execute(`INSERT INTO growth_source_batches(
        id,source_type,source_module,source_sha256,idempotency_key,row_count,status,created_by,created_at,updated_at
      ) VALUES ($1,$2,'phase3c',$3,$4,1,'applied','phase3c-staging',$5,$5)`, [
        id, sourceType, crypto.createHash("sha256").update(id).digest("hex"), id, timestamp,
      ]);
    }
    await provider.execute(`INSERT INTO growth_order_headers(
      id,business_key,business_key_version,platform,source_shop_name,normalized_source_shop_name,
      source_order_id,order_status,effective_status,first_source_batch_id,source_batch_id,
      source_quality_status,first_seen_at,last_seen_at,created_at,updated_at
    ) VALUES ($1,$2,'phase3c-v1','TEST','Phase3C Shop','phase3c shop',$3,'paid','valid',$4,$4,
      'confirmed',$5,$5,$5,$5)`, [ids.sales, ids.sales, ids.sales, ids.salesBatch, timestamp]);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM growth_order_headers WHERE id=$1", [ids.sales])).rows[0].count), 1);
    written.push({ domain: "Sales", relation: "app.growth_order_headers", status: "PASS" });

    await provider.execute(`INSERT INTO growth_inventory_snapshots(
      id,batch_id,source_row_number,source_sku,normalized_source_sku,warehouse_name,
      available_quantity,snapshot_at,mapping_status,quality_status,created_at,normalized_warehouse_name
    ) VALUES ($1,$2,2,$3,$3,'Phase3C Warehouse',10,$4,'unmatched','confirmed',$4,'phase3c warehouse')`, [
      ids.inventory, ids.inventoryBatch, prefix, timestamp,
    ]);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM growth_inventory_snapshots WHERE id=$1", [ids.inventory])).rows[0].count), 1);
    written.push({ domain: "Inventory", relation: "app.growth_inventory_snapshots", status: "PASS" });

    const foundation = new FoundationRepository({ provider });
    const tasks = new FoundationTaskService({ repository: foundation, now: () => new Date(timestamp) });
    await tasks.create({
      id: ids.task,
      domain: "growth",
      taskKind: "phase3c_staging_contract",
      executionMode: "system",
      domainRefType: "readiness",
      domainRefId: ids.task,
      state: "PENDING",
      priority: "P3",
      idempotencyKey: ids.task,
      input: { staging: true },
      evidence: { externalCalls: 0 },
      createdBy: "phase3c-staging",
    });
    assert.equal((await foundation.getTask(ids.task))?.id, ids.task);
    written.push({ domain: "Task", relation: "app.foundation_tasks", status: "PASS" });

    const audit = new ProviderAuditRepository({ provider });
    await audit.create(auditEvent({ id: ids.audit, requestId: prefix, action: "phase3c.write", timestamp }));
    assert.equal((await audit.get(ids.audit))?.id, ids.audit);
    written.push({ domain: "Audit", relation: "app.operation_audit_events", status: "PASS" });

    await audit.create(auditEvent({
      id: ids.agentStart,
      requestId: prefix,
      action: "agent.run.started",
      timestamp,
      runId: ids.agentRun,
      module: "ai",
      metadata: { agentName: "phase3c.readiness", agentVersion: "1.0.0", contextVersions: "staging@1" },
    }));
    await audit.create(auditEvent({
      id: ids.agentTool,
      requestId: prefix,
      action: "agent.tool.invoke",
      timestamp,
      runId: ids.agentRun,
      module: "ai",
      metadata: { agentName: "phase3c.readiness", agentVersion: "1.0.0", toolName: "staging.health", toolVersion: "1.0.0" },
    }));
    await audit.create(auditEvent({
      id: ids.agentComplete,
      requestId: prefix,
      action: "agent.run.completed",
      timestamp,
      runId: ids.agentRun,
      module: "ai",
      metadata: { agentName: "phase3c.readiness", agentVersion: "1.0.0", toolCallCount: 1, totalTokens: 0 },
    }));
    await projectAgentObservability(provider);
    const monitoring = new AgentObservabilityRepository({ provider });
    assert.equal((await monitoring.getRun(ids.agentRun))?.status, "succeeded");
    assert.equal((await monitoring.listToolInvocations(ids.agentRun)).length, 1);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM ai_shadow.agent_runs WHERE id=$1", [ids.agentRun])).rows[0].count), 1);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM ai_shadow.tool_invocations WHERE agent_run_id=$1", [ids.agentRun])).rows[0].count), 1);
    written.push({ domain: "Agent Run", relation: "app.operation_audit_events + ai_shadow.agent_runs", status: "PASS" });
    written.push({ domain: "Tool Invocation", relation: "app.operation_audit_events + ai_shadow.tool_invocations", status: "PASS" });

    const productRow = (await provider.query(`SELECT id,deleted_at,deleted_by,delete_reason,restored_at,restored_by,updated_at,revision
      FROM product_skus WHERE deleted_at IS NULL ORDER BY id LIMIT 1`)).rows[0];
    if (!productRow) throw new Error("No staged product row is available for soft-delete validation");
    productOriginal = productRow;
    const deletedProduct = await productCatalog.softDelete(productRow.id, {
      reason: "Phase 3C staging soft-delete validation",
      operatorLabel: "phase3c-staging",
    });
    assert.ok(deletedProduct.deletedAt);
    assert.ok((await provider.query("SELECT 1 present FROM product_skus WHERE id=$1", [productRow.id])).rows[0]);
    await productCatalog.restore(productRow.id, { operatorLabel: "phase3c-staging" });
    deletes.push({ domain: "Product", policy: "soft-delete + restore", rowRetained: true, status: "PASS" });

    const scheduler = new ProviderSchedulerRepository({
      provider,
      exportFiles: new ProviderExportFileRepository({ provider }),
    });
    await scheduler.saveAccountProfile({
      id: ids.schedulerAccount,
      name: "Phase 3C staging account",
      username: ids.schedulerAccount,
      encryptedPassword: "staging-only-contract-value",
      enabled: false,
    });
    await scheduler.saveDingtalkConfig({
      id: ids.schedulerRobot,
      name: "Phase 3C staging robot",
      encryptedWebhookUrl: "staging-only-contract-value",
      encryptedSecret: "staging-only-contract-value",
      enabled: false,
      notifyOnSuccess: false,
      notifyOnFailure: false,
      notifyOnEmpty: false,
      atAll: false,
      atMobiles: [],
    });
    await scheduler.saveTask({
      id: ids.schedulerTask,
      taskType: "order_export",
      name: "Phase 3C staging scheduled task",
      accountProfileId: ids.schedulerAccount,
      dingtalkConfigId: ids.schedulerRobot,
      scheduleType: "daily",
      scheduleConfig: { hour: 0, minute: 0 },
      timezone: "Asia/Shanghai",
      paymentDateMode: "today",
      paymentDateConfig: {},
      filters: [],
      enabled: false,
      fileRetentionDays: 1,
      notifyEnabled: false,
      catchUpEnabled: false,
    });
    await scheduler.softDeleteTask(ids.schedulerTask, {
      deletedBy: "phase3c-staging",
      deleteReason: "soft-delete validation",
    });
    const softTask = (await provider.query("SELECT deleted_at FROM scheduled_export_tasks WHERE id=$1", [ids.schedulerTask])).rows[0];
    assert.ok(softTask?.deleted_at);
    await scheduler.restoreTask(ids.schedulerTask);
    deletes.push({ domain: "Task configuration", policy: "soft-delete + restore", rowRetained: true, status: "PASS" });

    await provider.execute("DELETE FROM growth_order_headers WHERE id=$1", [ids.sales]);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM growth_order_headers WHERE id=$1", [ids.sales])).rows[0].count), 0);
    deletes.push({ domain: "Sales", policy: "controlled hard-delete", rowRetained: false, status: "PASS" });
    await provider.execute("DELETE FROM growth_inventory_snapshots WHERE id=$1", [ids.inventory]);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM growth_inventory_snapshots WHERE id=$1", [ids.inventory])).rows[0].count), 0);
    deletes.push({ domain: "Inventory", policy: "controlled hard-delete", rowRetained: false, status: "PASS" });
    await provider.execute("DELETE FROM operation_audit_events WHERE id=$1", [ids.audit]);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM operation_audit_events WHERE id=$1", [ids.audit])).rows[0].count), 0);
    deletes.push({ domain: "Audit", policy: "retention-controlled hard-delete", rowRetained: false, status: "PASS" });
    await provider.execute("DELETE FROM ai_shadow.agent_runs WHERE id=$1", [ids.agentRun]);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM ai_shadow.agent_runs WHERE id=$1", [ids.agentRun])).rows[0].count), 0);
    assert.equal(Number((await provider.query("SELECT COUNT(*) count FROM ai_shadow.tool_invocations WHERE agent_run_id=$1", [ids.agentRun])).rows[0].count), 0);
    deletes.push({ domain: "Agent Run + Tool Invocation", policy: "hard-delete with FK cascade", rowRetained: false, status: "PASS" });

    return { written, deletes, externalCalls: 0, productionWrites: 0, cleanup: "pending" };
  } finally {
    await cleanup();
    const residue = (await provider.query(`SELECT
      (SELECT COUNT(*)::integer FROM product_detail_preferences WHERE scope_key=$1) product,
      (SELECT COUNT(*)::integer FROM growth_source_batches WHERE id=ANY($2::text[])) batches,
      (SELECT COUNT(*)::integer FROM foundation_tasks WHERE id=$3) task,
      (SELECT COUNT(*)::integer FROM operation_audit_events WHERE id=ANY($4::text[])) audit,
      (SELECT COUNT(*)::integer FROM scheduled_export_tasks WHERE id=$5) scheduled_task,
      (SELECT COUNT(*)::integer FROM ai_shadow.agent_runs WHERE id=$6) agent
    `, [
      ids.productPreference,
      [ids.salesBatch, ids.inventoryBatch],
      ids.task,
      [ids.audit, ids.agentStart, ids.agentTool, ids.agentComplete],
      ids.schedulerTask,
      ids.agentRun,
    ])).rows[0];
    assert.deepEqual(residue, { product: 0, batches: 0, task: 0, audit: 0, scheduled_task: 0, agent: 0 });
    await provider.close();
  }
}

async function finalSync({ base, runtime }) {
  const snapshot = await createSnapshot(runtime, "final-sync");
  const source = openSnapshot(snapshot);
  const provider = createProvider({ ...base, statementTimeoutMs: 300_000 }, {
    database: POSTGRESQL_STAGING_DATABASE,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const manifest = buildIncrementalSyncManifest(buildShadowSchema(source).source);
    const control = new SyncControlRepository({
      provider,
      stateId: STATE_ID,
      targetProvider: "postgresql_staging",
    });
    const sync = await new MigrationSyncService({
      sourceDatabase: source,
      provider,
      control,
      manifest,
      deletePolicy: BLOCK_DELETE_POLICY,
    }).run({ sourceSnapshotTime: snapshot.time, sourceSnapshotSha256: snapshot.sha256 });
    const targetOnly = await reconcileTargetOnlyRows({
      database: source,
      provider,
      control,
      manifest,
      batchId: sync.batchId,
      batchRows: 5_000,
      deletePolicy: Object.freeze({
        mode: "DETECT",
        fullReconcile: true,
        executesDetection: true,
        executesDeletes: false,
      }),
    });
    if (targetOnly.candidates !== 0) throw new Error(`Final staging sync has ${targetOnly.candidates} target-only rows`);
    const validation = await new MigrationSyncValidator({
      sourceDatabase: source,
      provider,
      manifest,
      deletePolicy: BLOCK_DELETE_POLICY,
    }).validate({ sourceSnapshotTime: snapshot.time, sourceSnapshotSha256: snapshot.sha256 });
    if (validation.status !== "PASS") throw new Error("Final staging sync validation failed");
    await control.recordValidation({ syncBatchId: sync.batchId, validation });
    return {
      snapshot: { ...snapshot, path: undefined },
      sync: compactSync(sync),
      targetOnly: {
        mode: targetOnly.mode,
        keysExamined: targetOnly.keysExamined,
        candidates: targetOnly.candidates,
        deleted: targetOnly.deleted,
      },
      validation: compactValidation(validation),
    };
  } finally {
    source.close();
    await provider.close();
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function healthRequest(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Health request timed out")));
    request.on("error", reject);
  });
}

async function runServiceDryRun(base, password) {
  const port = await freePort();
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, "server.mjs")], {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_PROVIDER: "postgres",
      POSTGRES_SHADOW_MODE: "false",
      POSTGRES_STAGING_MODE: "true",
      POSTGRES_STAGING_CONFIRM_DATABASE: POSTGRESQL_STAGING_DATABASE,
      POSTGRES_STAGING_DATABASE: POSTGRESQL_STAGING_DATABASE,
      POSTGRES_STAGING_APP_USER: POSTGRESQL_STAGING_APP_USER,
      POSTGRES_STAGING_APP_PASSWORD: password,
      APP_PORT: String(port),
      PORT: String(port),
      HOST: "127.0.0.1",
      AD_SERVICE_MODE: "external",
      PRICE_CONTROL_SYNC_ENABLED: "false",
      PRICE_CONTROL_MANUAL_SYNC_ENABLED: "false",
    },
  });
  let stdout = "";
  let stderr = "";
  let succeeded = false;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  let health = null;
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Staging service exited before health check: ${stderr.slice(-400)}`);
      try {
        health = await healthRequest(port);
        if (health.statusCode === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!health || health.statusCode !== 200) throw new Error("Staging service health check did not pass");
    succeeded = true;
    return {
      configSwitch: "process-scoped DATABASE_PROVIDER=postgres with exact staging guard",
      serverStarted: true,
      healthStatus: health.statusCode,
      healthBody: health.body,
      applicationRole: POSTGRESQL_STAGING_APP_USER,
      database: POSTGRESQL_STAGING_DATABASE,
      externalServiceMode: "external/no-spawn",
      startupLogObserved: stdout.length > 0,
    };
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    if (!succeeded) {
      const cleanupProvider = createProvider(base, {
        database: POSTGRESQL_STAGING_DATABASE,
        user: POSTGRESQL_STAGING_APP_USER,
        password,
      });
      try {
        await cleanupProvider.execute(`DELETE FROM operation_audit_events
          WHERE module='file' AND action='file.temp.cleanup' AND created_at >= $1`, [startedAt]);
      } catch {} finally {
        await cleanupProvider.close();
      }
    }
  }
}

async function finalIsolationEvidence(base) {
  const admin = createProvider(base, { database: "postgres", user: base.adminUser, password: base.adminPassword, readOnly: true });
  try {
    return databaseEvidence(admin, [base.database, base.testDatabase, "commerce_ops_shadow", POSTGRESQL_STAGING_DATABASE]);
  } finally {
    await admin.close();
  }
}

async function run() {
  loadLocalEnv(rootDir);
  const productionProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (productionProvider !== "sqlite") throw new Error("Phase 3C rehearsal requires production DATABASE_PROVIDER=sqlite");
  const base = loadPostgresqlF1Config({ rootDir });
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const invocation = resolvePhase3cStagingInvocation(process.argv.slice(2), base);
  if (!invocation.apply) {
    return {
      status: "PLAN",
      contract: PHASE3C_STAGING_CONTRACT,
      target: invocation.targetDatabase,
      template: base.testDatabase,
      productionProvider,
      productionTouched: false,
      shadowTouched: false,
      applyCommand: `npm run postgres:phase3c:rehearse -- --apply --confirm-database=${invocation.targetDatabase}`,
    };
  }
  let provision;
  let reset;
  let initial;
  let stagingSecret;
  if (invocation.resume) {
    const staging = loadPostgresqlStagingConfig({ rootDir });
    stagingSecret = staging.appPassword;
    provision = { resumed: true, database: staging.database, secretFile: POSTGRESQL_STAGING_ENV_FILENAME, secretPrinted: false };
    reset = { resumed: true, schemasReset: false };
    initial = await resumeEvidence(base);
  } else {
    provision = await provisionStaging(base, invocation);
    stagingSecret = loadPostgresqlStagingConfig({ rootDir }).appPassword;
    reset = await resetStagingAndGrant(base, stagingSecret);
    initial = await initialSync({ base, runtime });
  }
  const role = await verifyApplicationRole(base, stagingSecret);
  const contracts = await runWriteAndDeleteContracts(base, stagingSecret);
  contracts.cleanup = "verified";
  const final = await finalSync({ base, runtime });
  const service = await runServiceDryRun(base, stagingSecret);
  const databases = await finalIsolationEvidence(base);
  return {
    status: "PASS",
    contract: PHASE3C_STAGING_CONTRACT,
    productionProvider,
    target: `${POSTGRESQL_STAGING_DATABASE}.app`,
    applicationRole: POSTGRESQL_STAGING_APP_USER,
    productionTouched: false,
    shadowTouched: false,
    provision,
    reset,
    initial,
    role,
    contracts,
    final,
    service,
    databases,
    externalCalls: 0,
    isSwitchReady: false,
  };
}

run().then(async (result) => {
  if (result.status === "PASS") {
    const evidenceDir = path.join(rootDir, "tmp", "postgresql-phase3c");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "staging-rehearsal-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  const safe = safeError(error);
  process.stderr.write(`PostgreSQL Phase 3C staging rehearsal failed [${safe.code}]: ${safe.message}\n`);
  process.exitCode = 1;
});
