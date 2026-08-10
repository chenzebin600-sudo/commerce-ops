import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { ProviderExportFileRepository } from "../lib/files/provider-export-file-repository.mjs";
import { ProviderFileLifecycleRepository } from "../lib/files/provider-file-lifecycle-repository.mjs";
import { ProviderFileReviewRepository } from "../lib/files/provider-file-review-repository.mjs";
import { ProviderSchedulerRepository } from "../lib/data/provider-scheduler-repository.mjs";
import { ProviderAuditRepository } from "../lib/data/provider-audit-repository.mjs";
import { FoundationRepository } from "../lib/foundation/foundation-repository.mjs";
import { FoundationTaskService } from "../lib/foundation/foundation-task-service.mjs";
import { PriceControlRepository } from "../lib/price-control/price-control-repository.mjs";
import { ProviderFulfillmentRepository } from "../fulfillment-service/provider-repository.mjs";
import { PHASE3D_REHEARSAL_DATABASE } from "../lib/postgresql/phase3d-rehearsal.mjs";
import { PHASE3D_PRODUCTION_CANDIDATE_DATABASE } from "../lib/postgresql/phase3d-production-candidate.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const SHADOW_DATABASE = "commerce_ops_shadow";
const TARGET_ARGUMENT = "--target=";
const PREFIX = `phase3a-${randomUUID()}`;
const now = new Date();
const timestamp = now.toISOString();

if (String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase() !== "sqlite") {
  throw new Error("Phase 3A write-contract check requires production DATABASE_PROVIDER to remain sqlite");
}

const config = Object.freeze({ ...loadPostgresqlF1Config({ rootDir }), schema: "app" });
const targetArguments = process.argv.slice(2).filter((value) => value.startsWith(TARGET_ARGUMENT));
if (targetArguments.length > 1) throw new Error("Phase 3A write-contract target may only be specified once");
const targetName = targetArguments[0]?.slice(TARGET_ARGUMENT.length) || "shadow";
if (!new Set(["shadow", "test", "cutover", "candidate"]).has(targetName)) {
  throw new Error("Phase 3A write-contract target must be shadow, test, cutover, or candidate");
}
const targetDatabase = targetName === "test"
  ? config.testDatabase
  : targetName === "cutover" ? PHASE3D_REHEARSAL_DATABASE
    : targetName === "candidate" ? config.database : SHADOW_DATABASE;
const candidateConfirmed = targetName !== "candidate" || (
  targetDatabase === PHASE3D_PRODUCTION_CANDIDATE_DATABASE
  && process.argv.includes(`--confirm-database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`)
  && process.argv.includes("--confirm-production-mutation=WRITE_CONTRACT_CLEANUP_ONLY")
);
if (
  (targetName !== "candidate" && targetDatabase === config.database)
  || (targetName === "shadow" && targetDatabase === config.testDatabase)
  || (targetName === "test" && targetDatabase === SHADOW_DATABASE)
  || (targetName === "cutover" && targetDatabase !== PHASE3D_REHEARSAL_DATABASE)
  || !candidateConfirmed
  || ["postgres", "template0", "template1"].includes(targetDatabase)
) {
  throw new Error("Phase 3A write-contract target is not isolated");
}
const applicationRoleTarget = new Set(["cutover", "candidate"]).has(targetName);
const provider = new PostgresqlProvider({
  config,
  database: targetDatabase,
  user: applicationRoleTarget ? config.appUser : config.migratorUser,
  password: applicationRoleTarget ? config.appPassword : config.migratorPassword,
  readOnly: false,
});

const ids = Object.freeze({
  account: `${PREFIX}-account`,
  dingtalk: `${PREFIX}-dingtalk`,
  schedulerTask: `${PREFIX}-scheduler-task`,
  lease: `${PREFIX}-lease`,
  leaseOwner: `${PREFIX}-owner`,
  exportFile: `${PREFIX}-export`,
  lifecycleItem: `${PREFIX}-lifecycle-item`,
  audit: `${PREFIX}-audit`,
  task: `${PREFIX}-task`,
  fulfillment: `${PREFIX}-fulfillment`,
  priceRun: `${PREFIX}-price-run`,
  priceApplyNo: `${PREFIX}-apply`,
  priceSnapshot: `${PREFIX}-price-snapshot`,
  priceChange: `${PREFIX}-price-change`,
  priceKey: `${PREFIX}|SHOPEE|STANDARD|REGULAR`,
});
const resources = { schedulerRun: null, lifecycleScan: null };
const checks = [];
let result = null;

async function cleanup() {
  await provider.execute("DELETE FROM product_price_change_events WHERE id=$1", [ids.priceChange]);
  await provider.execute("DELETE FROM product_sku_current_prices WHERE price_key=$1", [ids.priceKey]);
  await provider.execute("DELETE FROM price_control_price_snapshots WHERE id=$1", [ids.priceSnapshot]);
  await provider.execute("DELETE FROM price_control_source_batches WHERE apply_no=$1", [ids.priceApplyNo]);
  await provider.execute("DELETE FROM price_control_sync_runs WHERE id=$1", [ids.priceRun]);
  await provider.execute("DELETE FROM fulfillment_agent_runs WHERE id=$1", [ids.fulfillment]);
  await provider.execute("DELETE FROM foundation_task_events WHERE task_id=$1", [ids.task]);
  await provider.execute("DELETE FROM foundation_task_leases WHERE task_id=$1", [ids.task]);
  await provider.execute("DELETE FROM foundation_tasks WHERE id=$1", [ids.task]);
  await provider.execute("DELETE FROM operation_audit_events WHERE id=$1", [ids.audit]);
  if (resources.lifecycleScan) {
    await provider.execute("DELETE FROM file_lifecycle_items WHERE scan_id=$1", [resources.lifecycleScan]);
    await provider.execute("DELETE FROM file_lifecycle_scans WHERE id=$1", [resources.lifecycleScan]);
  }
  await provider.execute("DELETE FROM export_files WHERE id=$1", [ids.exportFile]);
  if (resources.schedulerRun) {
    await provider.execute("DELETE FROM scheduled_export_run_events WHERE run_id=$1", [resources.schedulerRun]);
    await provider.execute("DELETE FROM scheduled_export_runs WHERE id=$1", [resources.schedulerRun]);
  }
  await provider.execute("DELETE FROM scheduled_export_tasks WHERE id=$1", [ids.schedulerTask]);
  await provider.execute("DELETE FROM dingtalk_robot_configs WHERE id=$1", [ids.dingtalk]);
  await provider.execute("DELETE FROM mabang_account_profiles WHERE id=$1", [ids.account]);
  await provider.execute("DELETE FROM scheduler_leases WHERE name=$1", [ids.lease]);
}

try {
  const identity = await provider.query(
    "SELECT current_database() database,current_user username,current_schema() schema,current_setting('default_transaction_read_only') read_only",
  );
  assert.deepEqual(identity.rows[0], {
    database: targetDatabase,
    username: applicationRoleTarget ? config.appUser : config.migratorUser,
    schema: "app",
    read_only: "off",
  });
  await cleanup();

  const scheduler = new ProviderSchedulerRepository({
    provider,
    exportFiles: new ProviderExportFileRepository({ provider }),
  });
  await scheduler.saveAccountProfile({
    id: ids.account,
    name: "Phase 3A isolated account",
    username: ids.account,
    encryptedPassword: "isolated-contract-value",
    enabled: true,
  });
  await scheduler.saveDingtalkConfig({
    id: ids.dingtalk,
    name: "Phase 3A isolated robot",
    encryptedWebhookUrl: "isolated-contract-value",
    encryptedSecret: "isolated-contract-value",
    enabled: true,
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnEmpty: false,
    atAll: false,
    atMobiles: [],
  });
  await scheduler.saveTask({
    id: ids.schedulerTask,
    taskType: "order_export",
    name: "Phase 3A isolated task",
    accountProfileId: ids.account,
    dingtalkConfigId: ids.dingtalk,
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
  const schedulerRun = await scheduler.createRun({
    taskId: ids.schedulerTask,
    triggerType: "manual",
    scheduledRunAt: now,
  });
  resources.schedulerRun = schedulerRun.id;
  await scheduler.addRunEvent({
    runId: schedulerRun.id,
    stage: "phase3a_contract",
    status: "success",
    startedAt: timestamp,
    finishedAt: timestamp,
    message: "isolated provider write contract",
  });
  assert.equal((await scheduler.getRunDetails(schedulerRun.id))?.id, schedulerRun.id);
  checks.push("scheduler_task_run");

  assert.equal(await scheduler.acquireLease(ids.lease, ids.leaseOwner, now, 30_000), true);
  const lease = await provider.query("SELECT owner_id FROM scheduler_leases WHERE name=$1", [ids.lease]);
  assert.equal(lease.rows[0]?.owner_id, ids.leaseOwner);
  await scheduler.releaseLease(ids.lease, ids.leaseOwner);
  checks.push("scheduler_lease");

  const exportFiles = new ProviderExportFileRepository({ provider });
  await exportFiles.create({
    id: ids.exportFile,
    sourceType: "mabang_manual_order",
    requestKey: ids.exportFile,
    originalFilename: "phase3a-contract.xlsx",
    storageFilename: "phase3a-contract.xlsx",
    relativePath: "phase3a-contract.xlsx",
    fileSize: 1,
    fileHash: "0".repeat(64),
    metadata: { generatedBy: "phase3a-write-contract" },
    createdAt: timestamp,
  });
  assert.equal((await exportFiles.updateStatus(ids.exportFile, "expired"))?.status, "expired");
  checks.push("export_file_metadata");

  const lifecycle = new ProviderFileLifecycleRepository({ provider });
  const lifecycleScan = await lifecycle.createScan(["main_temp"], now);
  resources.lifecycleScan = lifecycleScan.id;
  await lifecycle.completeScan(lifecycleScan.id, {
    items: [{
      id: ids.lifecycleItem,
      classification: "unknown_file",
      categories: ["unknown_file"],
      scope: "main_temp",
      maskedFilename: "phase3a-contract.tmp",
      fileSize: 1,
      fileCreatedAt: timestamp,
      fileModifiedAt: timestamp,
      physicalStatus: "present",
      suggestQuarantine: false,
      suggestCleanup: false,
      reasonCode: "PHASE3A_CONTRACT",
      reviewStatus: "pending_review",
    }],
    summary: { unknown_file: 1 },
    scopeErrors: [],
    totalFiles: 1,
    totalBytes: 1,
    truncated: false,
  }, now);
  const fileReview = new ProviderFileReviewRepository({ provider });
  await fileReview.saveEvidence(ids.lifecycleItem, {
    scanId: lifecycleScan.id,
    detectedFileType: "advertising_unknown",
    rootKey: "main_temp",
    relativePath: "phase3a-contract.tmp",
    fileHash: "0".repeat(64),
    mimeType: "application/octet-stream",
    signatureCode: "UNKNOWN",
    reasonCode: "PHASE3A_CONTRACT",
  });
  assert.equal((await fileReview.setReviewStatus(ids.lifecycleItem, "rejected", {
    actor: "phase3a-write-contract-check",
    reason: "isolated provider write contract",
    now,
  }))?.reviewStatus, "rejected");
  checks.push("file_lifecycle_review_metadata");

  const audit = new ProviderAuditRepository({ provider });
  await audit.create({
    id: ids.audit,
    requestId: PREFIX,
    occurredAt: timestamp,
    module: "database_provider",
    action: "provider.phase3a.shadow_write_check",
    httpMethod: null,
    requestPath: null,
    status: "success",
    httpStatus: null,
    durationMs: 1,
    sourceIp: null,
    actorType: "system",
    actorIdentifier: null,
    taskId: null,
    runId: null,
    fileId: null,
    errorStage: null,
    errorCode: null,
    errorSummary: null,
    metadataJson: JSON.stringify({ contract: "COMMERCE-OPS-PG-PHASE3A" }),
    createdAt: timestamp,
  });
  assert.equal((await audit.get(ids.audit))?.id, ids.audit);
  checks.push("audit_event");

  const foundationRepository = new FoundationRepository({ provider });
  const tasks = new FoundationTaskService({ repository: foundationRepository, now: () => now });
  const task = await tasks.create({
    id: ids.task,
    domain: "growth",
    taskKind: "phase3a_write_contract",
    executionMode: "system",
    domainRefType: "provider_contract",
    domainRefId: ids.task,
    state: "PENDING",
    priority: "P3",
    idempotencyKey: ids.task,
    input: { contract: "phase3a" },
    evidence: { shadow_only: true },
    createdBy: "phase3a-write-contract-check",
  });
  assert.equal((await foundationRepository.getTask(task.id))?.id, ids.task);
  const events = await provider.query("SELECT event_type FROM foundation_task_events WHERE task_id=$1", [ids.task]);
  assert.deepEqual(events.rows.map((row) => row.event_type), ["CREATED"]);
  checks.push("foundation_task_event");

  const priceControl = new PriceControlRepository({ provider });
  assert.equal(await priceControl.isAdjustmentWorkflowReady(), true);
  await priceControl.createRun({
    id: ids.priceRun,
    triggerType: "rehearsal",
    syncMode: "incremental",
    inputFingerprint: ids.priceRun,
  }, now);
  await priceControl.applyBatch({
    runId: ids.priceRun,
    batch: {
      applyNo: ids.priceApplyNo,
      countryCode: "TEST",
      approvalStatus: "CA",
      sourceRowCount: 1,
      batchFingerprint: ids.priceApplyNo,
      applyCreatedAt: timestamp,
      submittedAt: timestamp,
      approvedAt: timestamp,
      effectiveAt: timestamp,
    },
    snapshots: [{
      id: ids.priceSnapshot,
      sourceRowKey: ids.priceSnapshot,
      priceKey: ids.priceKey,
      countryCode: "TEST",
      categoryName: "phase3a",
      sku: PREFIX,
      productNameCn: null,
      skuStatus: "test",
      platform: "SHOPEE",
      shopType: "STANDARD",
      priceType: "REGULAR",
      priceValue: "1.00",
      rowFingerprint: ids.priceSnapshot,
    }],
    currentUpdates: [{
      priceKey: ids.priceKey,
      countryCode: "TEST",
      categoryName: "phase3a",
      sku: PREFIX,
      productNameCn: null,
      skuStatus: "test",
      platform: "SHOPEE",
      shopType: "STANDARD",
      priceType: "REGULAR",
      priceValue: "1.00",
      snapshotId: ids.priceSnapshot,
    }],
    currentRemovals: [],
    changes: [{
      id: ids.priceChange,
      priceKey: ids.priceKey,
      countryCode: "TEST",
      categoryName: "phase3a",
      sku: PREFIX,
      productNameCn: null,
      platform: "SHOPEE",
      shopType: "STANDARD",
      priceType: "REGULAR",
      oldPrice: null,
      newPrice: "1.00",
      deltaValue: null,
      deltaPercent: null,
      direction: "NEW",
      changeText: "Phase 3A isolated provider write contract",
      changeFingerprint: ids.priceChange,
    }],
  }, now);
  const adjusted = await priceControl.updateAdjustment(ids.priceChange, {
    status: "ADJUSTED",
    remark: "isolated provider write contract",
    updatedBy: "phase3a-write-contract-check",
  }, now);
  assert.equal(adjusted?.adjustmentStatus, "ADJUSTED");
  await priceControl.updateRun(ids.priceRun, { status: "SUCCEEDED", finishedAt: timestamp }, now);
  checks.push("price_control_change_adjustment");

  const fulfillment = await ProviderFulfillmentRepository.open({
    provider,
    initializeSqliteSchema: false,
  });
  await fulfillment.startAgentRun({
    id: ids.fulfillment,
    conversationId: PREFIX,
    model: "phase3a-no-external-model",
    startedAt: timestamp,
  });
  await fulfillment.finishAgentRun({
    id: ids.fulfillment,
    status: "completed",
    stepCount: 0,
    toolTrace: [],
    finishedAt: timestamp,
  });
  assert.equal((await fulfillment.getAgentRun(ids.fulfillment))?.status, "completed");
  checks.push("fulfillment_agent_run");

  result = {
    status: "PASS",
    contract: "COMMERCE-OPS-PG-PHASE3A-WRITES-1.0.0",
    target: `${targetDatabase}.app`,
    targetMode: targetName,
    role: applicationRoleTarget ? config.appUser : config.migratorUser,
    checks,
    externalCalls: 0,
    realFulfillmentActions: 0,
    priceActions: 0,
    cleanup: "verified",
  };
} finally {
  try {
    await cleanup();
    const cleanupCheck = await provider.query(`
      SELECT
        (SELECT COUNT(*)::integer FROM fulfillment_agent_runs WHERE id=$1) AS fulfillment,
        (SELECT COUNT(*)::integer FROM foundation_tasks WHERE id=$2) AS task,
        (SELECT COUNT(*)::integer FROM operation_audit_events WHERE id=$3) AS audit,
        (SELECT COUNT(*)::integer FROM scheduler_leases WHERE name=$4) AS lease,
        (SELECT COUNT(*)::integer FROM export_files WHERE id=$5) AS export_file,
        (SELECT COUNT(*)::integer FROM product_price_change_events WHERE id=$6) AS price_change,
        (SELECT COUNT(*)::integer FROM scheduled_export_tasks WHERE id=$7) AS scheduler_task
    `, [ids.fulfillment, ids.task, ids.audit, ids.lease, ids.exportFile, ids.priceChange, ids.schedulerTask]);
    assert.deepEqual(cleanupCheck.rows[0], {
      fulfillment: 0,
      task: 0,
      audit: 0,
      lease: 0,
      export_file: 0,
      price_change: 0,
      scheduler_task: 0,
    });
  } finally {
    await provider.close();
  }
}

if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
