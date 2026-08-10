import { apiJson } from "@/services/api";

export interface ProductPackageSyncRun {
  id: string;
  triggerType: "initial" | "manual" | "scheduled";
  status: "RUNNING" | "SUCCEEDED" | "NO_CHANGES" | "FAILED";
  scheduleDate: string | null;
  importBatchId: string | null;
  sourceSnapshotSha256: string | null;
  sourceRowCount: number;
  localRowCountBefore: number;
  localRowCountAfter: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  removedCount: number;
  fieldChangeCount: number;
  sourceCheckedAt: string | null;
  sourceTableUpdatedAt: string | null;
  sourceMaxUpdatedAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ProductPackageSourceField {
  column: string;
  label: string;
  normalizedField: string | null;
  type: string;
}

export interface ProductPackageSyncStatus {
  schemaReady: boolean;
  sourceConfigured: boolean;
  syncEnabled: boolean;
  manualSyncEnabled: boolean;
  schedule: { time: string; timezone: string; catchUpAfterRestart: boolean };
  batchSize: number;
  maxRemovalRatio: number;
  currentRowCount: number;
  latestRun: ProductPackageSyncRun | null;
  fields: ProductPackageSourceField[];
}

export interface ProductPackageChange {
  id: string;
  runId: string;
  importBatchId: string;
  changeType: "ADDED" | "UPDATED" | "REMOVED";
  countryCode: string | null;
  sku: string | null;
  warehouse: string | null;
  productName: string | null;
  sourceColumn: string;
  fieldName: string;
  fieldLabel: string;
  oldValue: unknown;
  newValue: unknown;
  oldType: string | null;
  newType: string | null;
  hasManualOverride: boolean;
  changedAt: string;
}

export function loadProductPackageSyncStatus() {
  return apiJson<{ status: ProductPackageSyncStatus }>("/api/product-package-sync/status").then((response) => response.status);
}

export function loadProductPackageSyncRuns(pageSize = 20) {
  return apiJson<{ runs: ProductPackageSyncRun[] }>(`/api/product-package-sync/runs?page_size=${pageSize}`);
}

export function loadProductPackageChanges(query: {
  runId?: string;
  page?: number;
  pageSize?: number;
  country?: string;
  sku?: string;
  field?: string;
  changeType?: string;
}) {
  const params = new URLSearchParams({
    page: String(query.page || 1),
    page_size: String(query.pageSize || 50),
  });
  if (query.runId) params.set("run_id", query.runId);
  if (query.country) params.set("country", query.country);
  if (query.sku) params.set("sku", query.sku);
  if (query.field) params.set("field", query.field);
  if (query.changeType) params.set("change_type", query.changeType);
  return apiJson<{ changes: ProductPackageChange[]; total: number; page: number; pageSize: number; totalPages: number }>(
    `/api/product-package-sync/changes?${params}`,
  );
}

export function runProductPackageSync() {
  return apiJson<{ run: ProductPackageSyncRun; changed: boolean; skipped: boolean }>("/api/product-package-sync/run", {
    method: "POST",
  });
}
