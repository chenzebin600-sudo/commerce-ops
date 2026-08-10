import { apiJson, authorizedFetch } from "./api";

export type MabangSyncTaskType = "order_export" | "inventory_export" | "daily_report";

export interface MabangOrderField {
  id: string;
  label: string;
}

export interface MabangOrderFilter {
  fieldId: string;
  operator: "equals" | "contains" | "notEquals" | "notContains" | "empty" | "notEmpty";
  values: string[];
}

export interface MabangFilterOptions {
  managers?: string[];
  shops?: string[];
  platforms?: string[];
  regions?: string[];
  warehouses?: string[];
  orderStatuses?: string[];
  skus?: string[];
  logisticsChannels?: string[];
  managerShops?: Record<string, string[]>;
}

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
  triggerType: string;
  status: string;
  scheduledRunAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  paymentStartDate: string | null;
  paymentEndDate: string | null;
  rawOrderCount: number;
  filteredOrderCount: number;
  detailRowCount: number;
  exportFileId: string | null;
  filename: string | null;
  notificationStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  logSummary?: {
    dataPersistence?: {
      status?: string;
      batchId?: string | null;
      rowCount?: number;
    } | null;
    executionOptions?: Record<string, unknown> | null;
  };
}

export interface MabangRunEvent {
  id: number;
  stage: string;
  status: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  message: string;
  errorCode: string | null;
}

export interface MabangRunDetail extends MabangScheduledRun {
  events: MabangRunEvent[];
  task: MabangScheduledTask;
}

export interface AutomationOverview {
  scheduler: { online: boolean; leaseUntil: string | null; updatedAt: string | null };
  encryptionConfigured: boolean;
  fields: MabangOrderField[];
  primaryFilterIds: string[];
  paymentDateModes: string[];
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

export interface AiModuleAnalysis {
  headline: string;
  summary: string;
  findings: AiInsight[];
  recommendations: AiRecommendation[];
  dataLimitations: string[];
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
    modules: Partial<Record<"trend" | "dataQuality" | "hierarchy" | "opportunities" | "products" | "stores" | "storeDeclines" | "storeGrowth" | "styleDeclines" | "styleGrowth" | "businessOpportunities" | "inventory" | "dailyReport", AiModuleAnalysis | null>>;
  };
}

export async function loadAutomationOverview(signal?: AbortSignal): Promise<AutomationOverview> {
  const [meta, accounts, dingtalk, tasks, runs] = await Promise.all([
    apiJson<{
      scheduler: AutomationOverview["scheduler"];
      encryptionConfigured?: boolean;
      fields?: MabangOrderField[];
      primaryFilterIds?: string[];
      paymentDateModes?: string[];
    }>("/api/mabang/scheduler-meta", { signal }),
    apiJson<{ profiles?: MabangAccountProfile[] }>("/api/mabang/account-profiles", { signal }),
    apiJson<{ configs?: DingtalkConfig[] }>("/api/notifications/dingtalk/configs", { signal }),
    apiJson<{ tasks?: MabangScheduledTask[] }>("/api/mabang/scheduled-tasks", { signal }),
    apiJson<{ runs?: MabangScheduledRun[] }>("/api/mabang/scheduled-runs?limit=30", { signal }),
  ]);
  return {
    scheduler: meta.scheduler,
    encryptionConfigured: Boolean(meta.encryptionConfigured),
    fields: meta.fields || [],
    primaryFilterIds: meta.primaryFilterIds || [],
    paymentDateModes: meta.paymentDateModes || [],
    accounts: accounts.profiles || [],
    dingtalkConfigs: dingtalk.configs || [],
    tasks: (tasks.tasks || []).filter((task) => ["order_export", "inventory_export", "daily_report"].includes(task.taskType)),
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
        : input.taskType === "inventory_export"
          ? "销售与货盘驾驶舱每日库存快照同步"
          : "生成销售与货盘经营日报并推送钉钉"),
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

export function runSyncTask(taskId: string, executionOptions?: {
  paymentDateMode: string;
  paymentDateConfig: Record<string, unknown>;
  filters: MabangOrderFilter[];
}) {
  return apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(taskId)}/run-now`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(executionOptions || {}),
  });
}

export async function loadMabangFilterOptions(accountProfileId: string, signal?: AbortSignal) {
  const payload = await apiJson<{ options?: MabangFilterOptions }>(
    `/api/mabang/scheduler-filter-options?accountProfileId=${encodeURIComponent(accountProfileId)}`,
    { signal },
  );
  return payload.options || {};
}

export async function loadMabangRunDetail(runId: string, signal?: AbortSignal) {
  const payload = await apiJson<{ run: MabangRunDetail }>(
    `/api/mabang/scheduled-runs/${encodeURIComponent(runId)}`,
    { signal },
  );
  return payload.run;
}

export async function downloadMabangExport(fileId: string, filename = "马帮订单导出.xlsx") {
  const response = await authorizedFetch(`/api/mabang/export-files/${encodeURIComponent(fileId)}/download`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `导出文件下载失败 (${response.status})`);
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename || "马帮订单导出.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
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

export async function loadSavedSalesAnalysis(signal?: AbortSignal) {
  const payload = await apiJson<{ analysis: SalesAssortmentAnalysis | null }>(
    "/api/sales-assortment/analysis",
    { signal },
  );
  return payload.analysis;
}

export async function analyzeSalesDashboard(filters: {
  periodDays: number;
  dateFrom?: string;
  dateTo?: string;
  comparisonDays?: number;
  country?: string;
  categoryL1?: string;
  categoryL2?: string;
  style?: string;
  store?: string;
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
