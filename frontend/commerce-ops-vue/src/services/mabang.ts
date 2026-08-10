import { apiJson } from "@/services/api";

export interface MabangAccount {
  id: string;
  name: string;
  usernameMasked?: string;
  enabled: boolean;
  passwordConfigured?: boolean;
}

export interface ScheduledTask {
  id: string;
  taskType: string;
  name: string;
  accountName: string;
  scheduleType: string;
  scheduleConfig: Record<string, unknown>;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string | null;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  taskType: string;
  status: string;
  scheduledRunAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  detailRowCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface MabangImageBatch {
  id: string;
  accountId: string;
  mode: string;
  status: string;
  currentPage: number;
  totalPages: number | null;
  discoveredSkus: number;
  downloadedImages: number;
  duplicateImages: number;
  failedImages: number;
  missingImages: number;
  linkedProducts: number;
  startedAt?: string;
  createdAt: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export async function loadMabangWorkspace() {
  const [meta, accounts, tasks, runs, imageAccounts, imageBatches, syncRuns] = await Promise.all([
    apiJson<{ scheduler: { online: boolean; leaseUntil: string | null; updatedAt: string | null }; encryptionConfigured: boolean }>("/api/mabang/scheduler-meta"),
    apiJson<{ profiles: MabangAccount[] }>("/api/mabang/account-profiles"),
    apiJson<{ tasks: ScheduledTask[] }>("/api/mabang/scheduled-tasks"),
    apiJson<{ runs: ScheduledRun[] }>("/api/mabang/scheduled-runs?limit=100"),
    apiJson<{ accounts: MabangAccount[] }>("/api/mabang-images/accounts"),
    apiJson<{ batches: MabangImageBatch[] }>("/api/mabang-images/batches?limit=50"),
    apiJson<{ syncRuns: Array<Record<string, unknown>> }>("/api/mabang-images/sync-runs?limit=20"),
  ]);
  return {
    scheduler: meta.scheduler,
    encryptionConfigured: meta.encryptionConfigured,
    accounts: accounts.profiles || [],
    tasks: tasks.tasks || [],
    runs: runs.runs || [],
    imageAccounts: imageAccounts.accounts || [],
    imageBatches: imageBatches.batches || [],
    syncRuns: syncRuns.syncRuns || [],
  };
}

export function testMabangLogin(username: string, password: string) {
  return apiJson<Record<string, unknown>>("/api/mabang-data/login-test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
  });
}

export async function connectMabangAccount(username: string, password: string, accountId = "") {
  await testMabangLogin(username, password);
  const existing = accountId ? await apiJson<{ profiles: MabangAccount[] }>("/api/mabang/account-profiles") : { profiles: [] };
  const matched = (existing.profiles || []).find((profile) => profile.id === accountId);
  const path = accountId ? `/api/mabang/account-profiles/${encodeURIComponent(accountId)}` : "/api/mabang/account-profiles";
  const result = await apiJson<{ profile: MabangAccount }>(path, {
    method: accountId ? "PUT" : "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: matched?.name || "马帮主账号", username, password, enabled: true, allowUsernameChange: true }),
  });
  return result.profile;
}

export function loadMabangAccounts() {
  return apiJson<{ profiles: MabangAccount[] }>("/api/mabang/account-profiles").then((result) => result.profiles || []);
}

export function collectMabangData(input: Record<string, unknown>) {
  return apiJson<Record<string, unknown>>("/api/mabang-data/collect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

export function runScheduledTask(id: string) {
  return apiJson<Record<string, unknown>>(`/api/mabang/scheduled-tasks/${encodeURIComponent(id)}/run-now`, { method: "POST" });
}

export function startImageTask(accountId: string, mode: "full_initial" | "missing_only") {
  if (mode === "full_initial") {
    return apiJson<Record<string, unknown>>("/api/mabang-images/sync-runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId }) });
  }
  return apiJson<Record<string, unknown>>("/api/mabang-images/batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId, mode }) });
}
