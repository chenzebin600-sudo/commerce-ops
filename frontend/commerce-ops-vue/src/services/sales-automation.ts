import { apiJson } from "./api";

export type MabangSyncTaskType = "order_export" | "inventory_export";

export interface MabangAccountProfile {
  id: string;
  name: string;
  usernameMasked: string;
  enabled: boolean;
  passwordConfigured: boolean;
  lastVerifiedAt: string | null;
  lastVerifyStatus: string | null;
}

export interface DingtalkConfig {
  id: string;
  name: string;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  enabled: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnEmpty: boolean;
  atAll: boolean;
  atMobiles: string[];
}

export interface MabangScheduledTask {
  id: string;
  taskType: MabangSyncTaskType;
  name: string;
  description: string;
  accountProfileId: string;
  accountName: string;
  accountUsernameMasked: string;
  accountAvailable: boolean;
  accountEnabled: boolean;
  dingtalkConfigId: string | null;
  dingtalkName?: string | null;
  scheduleType: "daily" | "weekly" | "monthly";
  scheduleConfig: { hour?: number; minute?: number; weekdays?: number[]; day?: number | "last" };
  timezone: string;
  paymentDateMode: string;
  paymentDateConfig: Record<string, unknown>;
  filters: Array<Record<string, unknown>>;
  enabled: boolean;
  fileRetentionDays: number | "forever";
  notifyEnabled: boolean;
  catchUpEnabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string | null;
}

export interface MabangScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  taskType: MabangSyncTaskType;
  status: string;
  scheduledRunAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  detailRowCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface AutomationOverview {
  scheduler: { online: boolean; leaseUntil: string | null; updatedAt: string | null };
  encryptionConfigured: boolean;
  accounts: MabangAccountProfile[];
  dingtalkConfigs: DingtalkConfig[];
  tasks: MabangScheduledTask[];
  runs: MabangScheduledRun[];
}

export interface SalesAssortmentAiStatus {
  configured: boolean;
  provider: string;
  model: string;
  promptVersion: string;
}

export interface AiInsight {
  type: string;
  title: string;
  reason: string;
  evidence: string[];
}

export interface AiRecommendation {
  priority: "P0" | "P1" | "P2" | "P3";
  title: string;
  action: string;
  reason: string;
  evidence: string[];
}

export interface SalesAssortmentAnalysis {
  id: string;
  generatedAt: string;
  provider: string;
  model: string;
  promptVersion: string;
  cached: boolean;
  scope: Record<string, string | number>;
  period: Record<string, unknown>;
  sources: Record<string, Record<string, unknown> | null>;
  analysis: {
    headline: string;
    overview: string;
    conclusions: AiInsight[];
    recommendations: AiRecommendation[];
    risks: AiInsight[];
    dataLimitations: string[];
  };
}

export async function loadAutomationOverview(signal?: AbortSignal): Promise<AutomationOverview> {
  const [meta, accounts, dingtalk, tasks, runs] = await Promise.all([
    apiJson<{ scheduler: AutomationOverview["scheduler"]; encryptionConfigured?: boolean }>("/api/mabang/scheduler-meta", { signal }),
    apiJson<{ profiles?: MabangAccountProfile[] }>("/api/mabang/account-profiles", { signal }),
    apiJson<{ configs?: DingtalkConfig[] }>("/api/notifications/dingtalk/configs", { signal }),
    apiJson<{ tasks?: MabangScheduledTask[] }>("/api/mabang/scheduled-tasks", { signal }),
    apiJson<{ runs?: MabangScheduledRun[] }>("/api/mabang/scheduled-runs?limit=30", { signal }),
  ]);
  return {
    scheduler: meta.scheduler,
    encryptionConfigured: Boolean(meta.encryptionConfigured),
    accounts: accounts.profiles || [],
    dingtalkConfigs: dingtalk.configs || [],
    tasks: (tasks.tasks || []).filter((task) => task.taskType === "order_export" || task.taskType === "inventory_export"),
    runs: runs.runs || [],
  };
}

export function saveDailySyncTask(input: {
  task?: MabangScheduledTask | null;
  taskType: MabangSyncTaskType;
  name: string;
  accountProfileId: string;
  time: string;
  paymentDateMode?: string;
  dingtalkConfigId?: string | null;
  notifyEnabled: boolean;
  enabled: boolean;
}) {
  const existing = input.task || null;
  const [hour, minute] = input.time.split(":").map(Number);
  const path = existing
    ? `/api/mabang/scheduled-tasks/${encodeURIComponent(existing.id)}`
    : "/api/mabang/scheduled-tasks";
  return apiJson(path, {
    method: existing ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskType: input.taskType,
      name: input.name,
      description: existing?.description || (input.taskType === "order_export"
        ? "销售与货盘驾驶舱每日订单事实同步"
        : "销售与货盘驾驶舱每日库存快照同步"),
      accountProfileId: input.accountProfileId,
      dingtalkConfigId: input.dingtalkConfigId || null,
      scheduleType: "daily",
      scheduleConfig: { hour, minute },
      timezone: existing?.timezone || "Asia/Shanghai",
      paymentDateMode: input.taskType === "order_export" ? input.paymentDateMode || "yesterday" : "snapshot",
      paymentDateConfig: existing?.paymentDateConfig || {},
      filters: existing?.filters || [],
      enabled: input.enabled,
      fileRetentionDays: existing?.fileRetentionDays ?? 30,
      notifyEnabled: input.notifyEnabled,
      catchUpEnabled: existing?.catchUpEnabled ?? true,
    }),
  });
}

export function setSyncTaskEnabled(taskId: string, enabled: boolean) {
  return apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(taskId)}/${enabled ? "enable" : "disable"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function runSyncTask(taskId: string) {
  return apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(taskId)}/run-now`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function saveDingtalkConfig(input: {
  config?: DingtalkConfig | null;
  name: string;
  webhookUrl: string;
  secret: string;
  atMobiles: string;
  enabled: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnEmpty: boolean;
  atAll: boolean;
}) {
  const path = input.config
    ? `/api/notifications/dingtalk/configs/${encodeURIComponent(input.config.id)}`
    : "/api/notifications/dingtalk/configs";
  return apiJson(path, {
    method: input.config ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function testDingtalkConfig(id: string) {
  return apiJson(`/api/notifications/dingtalk/configs/${encodeURIComponent(id)}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function deleteDingtalkConfig(id: string) {
  return apiJson(`/api/notifications/dingtalk/configs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function loadSalesAiStatus(signal?: AbortSignal) {
  return apiJson<SalesAssortmentAiStatus>("/api/sales-assortment/ai-status", { signal });
}

export async function analyzeSalesDashboard(filters: {
  periodDays: number;
  country?: string;
  categoryL1?: string;
  categoryL2?: string;
  style?: string;
  forceRefresh?: boolean;
}, signal?: AbortSignal) {
  const payload = await apiJson<{ analysis: SalesAssortmentAnalysis }>("/api/sales-assortment/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(filters),
    signal,
  });
  return payload.analysis;
}
