const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function bounded(value, fallback, minimum, maximum, name) {
  const parsed = value == null || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export const LIFECYCLE_CLASSIFICATIONS = Object.freeze([
  "healthy",
  "metadata_missing",
  "physical_missing",
  "size_mismatch",
  "hash_mismatch",
  "path_invalid",
  "temp_stale",
  "expired_candidate",
  "unknown_file",
  "duplicate_content",
  "legacy_untracked_export",
  "active_or_recent",
]);

export const LIFECYCLE_SCOPE_NAMES = Object.freeze([
  "main_export",
  "main_upload",
  "main_temp",
  "main_storage",
  "ad_upload",
  "ad_temp",
  "ad_output",
  "ad_storage",
]);

export function resolveLifecyclePolicy(env = process.env) {
  const legacyCutoff = new Date(env.FILE_LIFECYCLE_LEGACY_CUTOFF || "2026-07-16T00:00:00+08:00");
  if (Number.isNaN(legacyCutoff.getTime())) throw new Error("FILE_LIFECYCLE_LEGACY_CUTOFF is invalid");
  return Object.freeze({
    manualMs: bounded(env.FILE_RETENTION_MANUAL_DAYS, 30, 1, 3650, "FILE_RETENTION_MANUAL_DAYS") * DAY_MS,
    scheduledMs: bounded(env.FILE_RETENTION_SCHEDULED_DAYS, 90, 1, 3650, "FILE_RETENTION_SCHEDULED_DAYS") * DAY_MS,
    adSourceMs: bounded(env.FILE_RETENTION_AD_SOURCE_DAYS, 30, 1, 3650, "FILE_RETENTION_AD_SOURCE_DAYS") * DAY_MS,
    adOutputMs: bounded(env.FILE_RETENTION_AD_OUTPUT_DAYS, 90, 1, 3650, "FILE_RETENTION_AD_OUTPUT_DAYS") * DAY_MS,
    reportMs: bounded(env.FILE_RETENTION_REPORT_DAYS, 90, 1, 3650, "FILE_RETENTION_REPORT_DAYS") * DAY_MS,
    tempMs: bounded(env.FILE_RETENTION_FAILED_TEMP_HOURS, 24, 1, 24 * 365, "FILE_RETENTION_FAILED_TEMP_HOURS") * HOUR_MS,
    recentMs: bounded(env.FILE_LIFECYCLE_RECENT_MINUTES, 10, 1, 24 * 60, "FILE_LIFECYCLE_RECENT_MINUTES") * MINUTE_MS,
    maxFiles: bounded(env.FILE_LIFECYCLE_MAX_FILES, 10000, 10, 100000, "FILE_LIFECYCLE_MAX_FILES"),
    timeoutMs: bounded(env.FILE_LIFECYCLE_TIMEOUT_SECONDS, 60, 5, 600, "FILE_LIFECYCLE_TIMEOUT_SECONDS") * 1000,
    legacyCutoff,
  });
}

export function retentionMsFor({ sourceType, scope, relativePath }, policy) {
  if (sourceType?.startsWith("mabang_manual_")) return policy.manualMs;
  if (sourceType?.startsWith("mabang_scheduled_")) return policy.scheduledMs;
  if (sourceType === "system_file_lifecycle_report") return policy.reportMs;
  if (scope === "ad_temp" || scope === "main_temp") return policy.tempMs;
  if (scope === "ad_output" || /(?:^|\/)output(?:\/|$)/i.test(relativePath || "")) return policy.adOutputMs;
  if (scope === "ad_upload") return policy.adSourceMs;
  return null;
}
