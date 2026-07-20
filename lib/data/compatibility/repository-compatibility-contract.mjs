import assert from "node:assert/strict";
import { RepositoryCompatibilityError } from "./provider-record-repository.mjs";

const IDS = Object.freeze({
  account: "f4000000-0000-4000-8000-000000000001",
  dingtalk: "f4000000-0000-4000-8000-000000000002",
  task: "f4000000-0000-4000-8000-000000000003",
  run: "f4000000-0000-4000-8000-000000000004",
  exportFile: "f4000000-0000-4000-8000-000000000005",
  scan: "f4000000-0000-4000-8000-000000000006",
  lifecycleItem: "f4000000-0000-4000-8000-000000000007",
  managedFile: "f4000000-0000-4000-8000-000000000008",
  quarantine: "f4000000-0000-4000-8000-000000000009",
  audit: "f4000000-0000-4000-8000-00000000000a",
  auditCommit: "f4000000-0000-4000-8000-00000000000b",
  auditRollback: "f4000000-0000-4000-8000-00000000000c",
  auditDelete: "f4000000-0000-4000-8000-00000000000d",
  invalidTask: "f4000000-0000-4000-8000-00000000000e",
  invalidAccount: "f4000000-0000-4000-8000-00000000000f",
  request: "f4000000-0000-4000-8000-000000000010",
});

const RUN_EVENT_ID = 4_000_000_001;
const FILTER_OPTION_ID = 4_000_000_002;
const NOW = "2026-07-20T10:00:00.000Z";
const LATER = "2026-07-20T10:30:00.000Z";

function auditRecord(id, action) {
  return {
    id,
    request_id: IDS.request,
    occurred_at: NOW,
    module: "database_compatibility",
    action,
    http_method: null,
    request_path: null,
    status: "success",
    http_status: null,
    duration_ms: 5,
    source_ip: null,
    actor_type: "system",
    actor_identifier: null,
    task_id: IDS.task,
    run_id: IDS.run,
    file_id: IDS.exportFile,
    error_stage: null,
    error_code: null,
    error_summary: null,
    metadata_json: { suite: "f4", stable: true },
    created_at: NOW,
  };
}

async function cleanupFixtures(repositories) {
  const operations = [
    [repositories.quarantineRecords, IDS.quarantine],
    [repositories.managedFiles, IDS.managedFile],
    [repositories.lifecycleProtectedFiles, IDS.exportFile],
    [repositories.lifecycleItems, IDS.lifecycleItem],
    [repositories.lifecycleScans, IDS.scan],
    [repositories.exportFiles, IDS.exportFile],
    [repositories.scheduledRunEvents, RUN_EVENT_ID],
    [repositories.scheduledRuns, IDS.run],
    [repositories.scheduledTasks, IDS.invalidTask],
    [repositories.scheduledTasks, IDS.task],
    [repositories.filterOptions, FILTER_OPTION_ID],
    [repositories.dingtalkConfigs, IDS.dingtalk],
    [repositories.accounts, IDS.account],
    [repositories.auditEvents, IDS.auditDelete],
    [repositories.auditEvents, IDS.auditRollback],
    [repositories.auditEvents, IDS.auditCommit],
    [repositories.auditEvents, IDS.audit],
    [repositories.schedulerLeases, "f4-repository-contract"],
  ];
  for (const [repository, id] of operations) await repository.delete(id);
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function typeSummary(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    item === null ? "null" : Array.isArray(item) ? "array" : typeof item,
  ]));
}

async function assertCompatibilityError(callback, expectedCode) {
  await assert.rejects(callback, (error) => (
    error instanceof RepositoryCompatibilityError && error.code === expectedCode
  ));
}

export async function runRepositoryCompatibilityContract(dataAccess) {
  const { repositories } = dataAccess;
  await cleanupFixtures(repositories);
  try {
    await repositories.accounts.insert({
      id: IDS.account,
      name: "F4 account",
      username: "f4-test-user",
      encrypted_password: "f4-test",
      enabled: true,
      last_verified_at: null,
      last_verify_status: null,
      last_verify_message: null,
      created_at: NOW,
      updated_at: NOW,
    });
    await repositories.dingtalkConfigs.insert({
      id: IDS.dingtalk,
      name: "F4 notification",
      encrypted_webhook_url: "f4-test",
      encrypted_secret: null,
      enabled: true,
      notify_on_success: true,
      notify_on_failure: true,
      notify_on_empty: false,
      at_all: false,
      at_mobiles_json: [],
      created_at: NOW,
      updated_at: NOW,
    });
    await repositories.scheduledTasks.insert({
      id: IDS.task,
      task_type: "order_export",
      name: "F4 repository task",
      description: null,
      account_profile_id: IDS.account,
      dingtalk_config_id: IDS.dingtalk,
      schedule_type: "daily",
      schedule_config_json: { hour: 8, minute: 30 },
      timezone: "Asia/Shanghai",
      payment_date_mode: "previous_day",
      payment_date_config_json: {},
      filters_json: [{ field: "manager", values: ["F4"] }],
      enabled: true,
      file_retention_days: 30,
      notify_enabled: true,
      catch_up_enabled: true,
      last_run_at: null,
      last_run_status: null,
      next_run_at: LATER,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      deleted_by: null,
      delete_reason: null,
    });
    await repositories.scheduledRuns.insert({
      id: IDS.run,
      task_id: IDS.task,
      trigger_type: "manual",
      scheduled_run_at: NOW,
      started_at: NOW,
      finished_at: null,
      status: "running",
      payment_start_date: "2026-07-19",
      payment_end_date: "2026-07-19",
      raw_order_count: 3,
      filtered_order_count: 2,
      detail_row_count: 4,
      export_file_id: IDS.exportFile,
      notification_status: null,
      retry_count: 0,
      error_stage: null,
      error_code: null,
      error_message: null,
      log_summary_json: { source: "f4", rows: 4 },
      created_at: NOW,
      updated_at: NOW,
    });
    await repositories.exportFiles.insert({
      id: IDS.exportFile,
      file_type: "excel",
      source_type: "mabang_scheduled_order",
      task_id: IDS.task,
      run_id: IDS.run,
      request_key: "f4-provider-contract",
      original_filename: "f4-report.xlsx",
      storage_filename: "f4-report.xlsx",
      relative_path: "f4/f4-report.xlsx",
      mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      file_size: 128,
      file_hash: "a".repeat(64),
      status: "available",
      expires_at: null,
      missing_at: null,
      metadata_json: { exportedRows: 4, generatedBy: "f4" },
      created_at: NOW,
      updated_at: NOW,
    });
    await repositories.scheduledRunEvents.insert({
      id: RUN_EVENT_ID,
      run_id: IDS.run,
      stage: "complete",
      status: "success",
      attempt: 1,
      started_at: NOW,
      finished_at: LATER,
      duration_ms: 10,
      message: null,
      error_code: null,
      created_at: NOW,
    });
    await repositories.lifecycleScans.insert({
      id: IDS.scan,
      status: "completed",
      scopes_json: ["formal_exports"],
      summary_json: { healthy: 1 },
      scope_errors_json: [],
      total_files: 1,
      total_bytes: 128,
      truncated: false,
      report_file_id: null,
      error_code: null,
      started_at: NOW,
      finished_at: LATER,
      created_at: NOW,
      updated_at: LATER,
    });
    await repositories.lifecycleItems.insert({
      id: IDS.lifecycleItem,
      scan_id: IDS.scan,
      classification: "healthy",
      categories_json: ["healthy"],
      scope: "formal_exports",
      source_type: "advertising_output",
      file_id: IDS.exportFile,
      task_id: IDS.task,
      run_id: IDS.run,
      masked_filename: "f4-***.xlsx",
      file_size: 128,
      file_created_at: NOW,
      file_modified_at: NOW,
      database_status: "available",
      physical_status: "present",
      suggest_quarantine: false,
      suggest_cleanup: false,
      reason_code: "F4_COMPATIBILITY",
      short_hash: "aaaaaaaaaaaa",
      error_code: null,
      created_at: NOW,
      detected_file_type: "advertising_output",
      review_status: "registered",
      reviewed_at: NOW,
      reviewed_by: "system",
      review_reason: null,
      root_key: "ad_output",
      relative_path: "f4/output.xlsx",
      full_hash: "b".repeat(64),
      job_id: null,
      mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      signature_code: "xlsx",
      detection_reason_code: "F4",
      managed_file_id: IDS.managedFile,
      original_relative_path: null,
      quarantine_relative_path: null,
      quarantined_at: null,
      restored_at: null,
      deleted_at: null,
    });
    await repositories.lifecycleProtectedFiles.insert({
      file_id: IDS.exportFile,
      reason: "f4_contract",
      created_at: NOW,
    });
    await repositories.managedFiles.insert({
      id: IDS.managedFile,
      lifecycle_item_id: IDS.lifecycleItem,
      scan_id: IDS.scan,
      root_key: "ad_output",
      relative_path: "f4/output.xlsx",
      source_type: "advertising_output",
      job_id: null,
      mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      file_size: 128,
      file_hash: "b".repeat(64),
      file_created_at: NOW,
      status: "available",
      metadata_json: { source: "f4" },
      registered_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    });
    await repositories.quarantineRecords.insert({
      id: IDS.quarantine,
      lifecycle_item_id: IDS.lifecycleItem,
      managed_file_id: IDS.managedFile,
      root_key: "ad_output",
      original_relative_path: "f4/output.xlsx",
      quarantine_relative_path: "f4/quarantine/output.xlsx",
      file_size: 128,
      file_hash: "b".repeat(64),
      status: "quarantined",
      quarantined_at: NOW,
      quarantined_by: "system",
      quarantine_reason: "f4_contract",
      restored_at: null,
      restored_by: null,
      created_at: NOW,
      updated_at: NOW,
    });
    await repositories.filterOptions.insert({
      id: FILTER_OPTION_ID,
      account_profile_id: IDS.account,
      manager: "F4",
      shop_name: "F4 Shop",
      platform: "Lazada",
      region: "MY",
      warehouse: "F4",
      order_status: "paid",
      sku: "F4-SKU",
      logistics_channel: "F4",
      updated_at: NOW,
    });
    await repositories.schedulerLeases.insert({
      name: "f4-repository-contract",
      owner_id: "f4-test-runner",
      lease_until: LATER,
      updated_at: NOW,
    });
    await repositories.auditEvents.insert(auditRecord(IDS.audit, "repository_contract"));

    const account = await repositories.accounts.update(IDS.account, {
      name: "F4 account updated",
      enabled: false,
      last_verified_at: LATER,
      last_verify_status: "success",
      updated_at: LATER,
    });
    const task = await repositories.scheduledTasks.update(IDS.task, {
      last_run_at: LATER,
      last_run_status: "success",
      enabled: false,
      next_run_at: null,
      updated_at: LATER,
    });
    const run = await repositories.scheduledRuns.update(IDS.run, {
      status: "success",
      finished_at: LATER,
      notification_status: "success",
      log_summary_json: { rows: 4, source: "f4", completed: true },
      updated_at: LATER,
    });

    assert.equal((await repositories.accounts.list({ enabled: false })).some((row) => row.id === IDS.account), true);
    assert.equal((await repositories.scheduledTasks.list({ id: IDS.task })).length, 1);

    await dataAccess.transaction(async ({ repositories: transactional }) => {
      await transactional.auditEvents.insert(auditRecord(IDS.auditCommit, "transaction_commit"));
    });
    assert.equal((await repositories.auditEvents.get(IDS.auditCommit))?.action, "transaction_commit");

    await assert.rejects(dataAccess.transaction(async ({ repositories: transactional }) => {
      await transactional.auditEvents.insert(auditRecord(IDS.auditRollback, "transaction_rollback"));
      throw new Error("F4_TRANSACTION_ROLLBACK");
    }), /F4_TRANSACTION_ROLLBACK/);
    assert.equal(await repositories.auditEvents.get(IDS.auditRollback), null);

    await repositories.auditEvents.insert(auditRecord(IDS.auditDelete, "delete_test"));
    assert.equal(await repositories.auditEvents.delete(IDS.auditDelete), 1);
    assert.equal(await repositories.auditEvents.get(IDS.auditDelete), null);

    await assertCompatibilityError(() => repositories.accounts.insert({
      id: IDS.account,
      name: "duplicate",
      username: "duplicate",
      encrypted_password: "test-only",
      enabled: true,
      created_at: NOW,
      updated_at: NOW,
    }), "UNIQUE_CONSTRAINT");

    await assertCompatibilityError(() => repositories.scheduledTasks.insert({
      id: IDS.invalidTask,
      name: "invalid foreign key",
      account_profile_id: IDS.invalidAccount,
      dingtalk_config_id: null,
      schedule_type: "daily",
      schedule_config_json: { hour: 8 },
      payment_date_mode: "previous_day",
      created_at: NOW,
      updated_at: NOW,
    }), "FOREIGN_KEY_CONSTRAINT");

    const exportFile = await repositories.exportFiles.get(IDS.exportFile);
    const lifecycleItem = await repositories.lifecycleItems.get(IDS.lifecycleItem);
    const managedFile = await repositories.managedFiles.get(IDS.managedFile);
    const audit = await repositories.auditEvents.get(IDS.audit);
    const lease = await repositories.schedulerLeases.get("f4-repository-contract");

    return Object.freeze({
      operations: Object.freeze({
        query: true,
        insert: true,
        update: true,
        delete: true,
        transactionCommit: true,
        transactionRollback: true,
        uniqueError: "UNIQUE_CONSTRAINT",
        foreignKeyError: "FOREIGN_KEY_CONSTRAINT",
      }),
      values: Object.freeze({
        account: pick(account, ["id", "name", "enabled", "last_verified_at", "last_verify_message"]),
        task: pick(task, ["id", "description", "schedule_config_json", "filters_json", "enabled", "next_run_at"]),
        run: pick(run, ["id", "payment_start_date", "payment_end_date", "raw_order_count", "log_summary_json", "notification_status"]),
        exportFile: pick(exportFile, ["id", "file_size", "metadata_json", "expires_at"]),
        lifecycleItem: pick(lifecycleItem, ["id", "categories_json", "suggest_quarantine", "suggest_cleanup", "job_id"]),
        managedFile: pick(managedFile, ["id", "file_size", "metadata_json", "deleted_at"]),
        audit: pick(audit, ["id", "metadata_json", "http_status", "actor_identifier"]),
        lease: pick(lease, ["name", "lease_until"]),
      }),
      types: Object.freeze({
        task: typeSummary(pick(task, ["id", "description", "schedule_config_json", "filters_json", "enabled", "next_run_at"])),
        run: typeSummary(pick(run, ["payment_start_date", "raw_order_count", "log_summary_json", "notification_status"])),
        file: typeSummary(pick(exportFile, ["file_size", "metadata_json", "expires_at"])),
      }),
      modules: Object.freeze([
        "mabang_accounts",
        "scheduled_tasks",
        "execution_records",
        "export_files",
        "managed_files",
        "file_lifecycle",
        "operation_audit_events",
        "notification_config",
        "scheduler_state",
      ]),
    });
  } finally {
    await cleanupFixtures(repositories);
  }
}

export const F4_COMPATIBILITY_IDS = IDS;
