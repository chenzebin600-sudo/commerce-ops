import type {
  AuthorizedFetch,
  AutomationOverview,
  DashboardData,
  DingtalkConfig,
  MabangScheduledTask,
  MabangSyncTaskType,
  SalesAssortmentAnalysis,
  SalesAssortmentAiStatus,
} from "./types";

let fetchImpl: AuthorizedFetch = fetch;

export function configureApi(authorizedFetch: AuthorizedFetch) {
  fetchImpl = authorizedFetch;
}

async function responseJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload;
}

export async function loadDashboard(filters: {
  periodDays: number;
  country?: string;
  categoryL1?: string;
  categoryL2?: string;
  style?: string;
}) {
  const query = new URLSearchParams({ period_days: String(filters.periodDays) });
  if (filters.country) query.set("country", filters.country);
  if (filters.categoryL1) query.set("category_l1", filters.categoryL1);
  if (filters.categoryL2) query.set("category_l2", filters.categoryL2);
  if (filters.style) query.set("style", filters.style);
  const payload = await responseJson(await fetchImpl(`/api/sales-assortment/dashboard?${query}`));
  return payload.dashboard as DashboardData;
}

export async function loadAutomationOverview(signal?: AbortSignal): Promise<AutomationOverview> {
  const [meta, accounts, dingtalk, tasks, runs] = await Promise.all([
    responseJson(await fetchImpl("/api/mabang/scheduler-meta", { signal })),
    responseJson(await fetchImpl("/api/mabang/account-profiles", { signal })),
    responseJson(await fetchImpl("/api/notifications/dingtalk/configs", { signal })),
    responseJson(await fetchImpl("/api/mabang/scheduled-tasks", { signal })),
    responseJson(await fetchImpl("/api/mabang/scheduled-runs?limit=30", { signal })),
  ]);
  return {
    scheduler: meta.scheduler,
    encryptionConfigured: Boolean(meta.encryptionConfigured),
    accounts: accounts.profiles || [],
    dingtalkConfigs: dingtalk.configs || [],
    tasks: (tasks.tasks || []).filter((task: MabangScheduledTask) => (
      task.taskType === "order_export" || task.taskType === "inventory_export"
    )),
    runs: runs.runs || [],
  };
}

export async function saveDailySyncTask(input: {
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
  const [hour, minute] = input.time.split(":").map((value) => Number(value));
  const path = existing
    ? `/api/mabang/scheduled-tasks/${encodeURIComponent(existing.id)}`
    : "/api/mabang/scheduled-tasks";
  return responseJson(await fetchImpl(path, {
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
      paymentDateMode: input.taskType === "order_export"
        ? input.paymentDateMode || "yesterday"
        : "snapshot",
      paymentDateConfig: existing?.paymentDateConfig || {},
      filters: existing?.filters || [],
      enabled: input.enabled,
      fileRetentionDays: existing?.fileRetentionDays ?? 30,
      notifyEnabled: input.notifyEnabled,
      catchUpEnabled: existing?.catchUpEnabled ?? true,
    }),
  }));
}

export async function setSyncTaskEnabled(taskId: string, enabled: boolean) {
  return responseJson(await fetchImpl(
    `/api/mabang/scheduled-tasks/${encodeURIComponent(taskId)}/${enabled ? "enable" : "disable"}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ));
}

export async function runSyncTask(taskId: string) {
  return responseJson(await fetchImpl(
    `/api/mabang/scheduled-tasks/${encodeURIComponent(taskId)}/run-now`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ));
}

export async function saveDingtalkConfig(input: {
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
  return responseJson(await fetchImpl(path, {
    method: input.config ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function testDingtalkConfig(id: string) {
  return responseJson(await fetchImpl(
    `/api/notifications/dingtalk/configs/${encodeURIComponent(id)}/test`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ));
}

export async function deleteDingtalkConfig(id: string) {
  return responseJson(await fetchImpl(
    `/api/notifications/dingtalk/configs/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  ));
}

export async function loadAiStatus(signal?: AbortSignal): Promise<SalesAssortmentAiStatus> {
  return responseJson(await fetchImpl("/api/sales-assortment/ai-status", { signal }));
}

export async function analyzeDashboard(filters: {
  periodDays: number;
  country?: string;
  categoryL1?: string;
  categoryL2?: string;
  style?: string;
  forceRefresh?: boolean;
}, signal?: AbortSignal): Promise<SalesAssortmentAnalysis> {
  const payload = await responseJson(await fetchImpl("/api/sales-assortment/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(filters),
    signal,
  }));
  return payload.analysis as SalesAssortmentAnalysis;
}

export interface ImportPreview {
  kind: "orders" | "inventory" | "product-package";
  previewId?: string;
  batchId?: string;
  rowCount: number;
  blockers: number;
  warnings: number;
  filename: string;
  summary?: Record<string, unknown>;
}

export async function previewImport(kind: ImportPreview["kind"], file: File): Promise<ImportPreview> {
  const headers = {
    "content-type": file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "x-file-name": encodeURIComponent(file.name)
  };
  if (kind === "product-package") {
    const payload = await responseJson(await fetchImpl("/api/product-center/imports", {
      method: "POST",
      headers,
      body: file
    }));
    const batch = payload.detail?.batch || {};
    return {
      kind,
      batchId: batch.id,
      rowCount: Number(batch.rowCount || 0),
      blockers: Number(batch.blockerCount || 0),
      warnings: Number(batch.reminderCount || 0) + Number(batch.exceptionCount || 0),
      filename: file.name,
      summary: batch
    };
  }
  const payload = await responseJson(await fetchImpl(`/api/growth-radar/import/${kind}/preview`, {
    method: "POST",
    headers,
    body: file
  }));
  const preview = payload.preview;
  return {
    kind,
    previewId: preview.previewId,
    rowCount: Number(preview.rowCount || 0),
    blockers: (preview.issues || []).filter((item: { blocking?: boolean }) => item.blocking).length,
    warnings: (preview.issues || []).filter((item: { blocking?: boolean }) => !item.blocking).length,
    filename: file.name,
    summary: preview.summary
  };
}

export async function applyImport(preview: ImportPreview) {
  if (preview.kind === "product-package") {
    return responseJson(await fetchImpl(`/api/product-center/imports/${preview.batchId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        acknowledgeWarnings: true,
        acknowledgeUnknownFields: true
      })
    }));
  }
  return responseJson(await fetchImpl(`/api/growth-radar/import/${preview.kind}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId: preview.previewId })
  }));
}
