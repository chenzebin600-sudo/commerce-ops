import { assertDatabaseProvider } from "../database-provider.mjs";
import { ProviderRecordRepository, createRepositoryTableMap } from "./provider-record-repository.mjs";

const REPOSITORY_TABLES = Object.freeze({
  accounts: "mabang_account_profiles",
  dingtalkConfigs: "dingtalk_robot_configs",
  scheduledTasks: "scheduled_export_tasks",
  scheduledRuns: "scheduled_export_runs",
  scheduledRunEvents: "scheduled_export_run_events",
  exportFiles: "export_files",
  lifecycleScans: "file_lifecycle_scans",
  lifecycleItems: "file_lifecycle_items",
  lifecycleProtectedFiles: "file_lifecycle_protected_files",
  managedFiles: "managed_files",
  quarantineRecords: "file_quarantine_records",
  auditEvents: "operation_audit_events",
  filterOptions: "mabang_filter_option_cache",
  schedulerLeases: "scheduler_leases",
});

function buildRepositories({ provider, executor, tableMap }) {
  return Object.freeze(Object.fromEntries(Object.entries(REPOSITORY_TABLES).map(([name, tableName]) => {
    const table = tableMap.get(tableName);
    if (!table) throw new Error(`Compatibility schema is missing ${tableName}`);
    return [name, new ProviderRecordRepository({ provider, executor, table })];
  })));
}

export function openCompatibilityDataAccess({ provider, schema, executor = provider }) {
  assertDatabaseProvider(provider);
  const tableMap = createRepositoryTableMap(schema);
  const repositories = buildRepositories({ provider, executor, tableMap });
  return Object.freeze({
    dialect: provider.dialect,
    repositories,
    async transaction(callback) {
      if (typeof callback !== "function") throw new TypeError("Compatibility transaction callback is required");
      return provider.transaction(async (transactionExecutor) => callback(openCompatibilityDataAccess({
        provider,
        schema,
        executor: transactionExecutor,
      })));
    },
  });
}

export const COMPATIBILITY_REPOSITORY_TABLES = REPOSITORY_TABLES;
