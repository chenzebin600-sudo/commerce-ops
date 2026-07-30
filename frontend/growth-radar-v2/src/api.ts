import type {
  CountryMappingRow,
  DirectionCode,
  OperationTask,
  OpportunityCell,
  PlatformCode,
  ProductInsight,
  ReadinessItem,
  ShopMappingRow,
  StoreState,
  StoreSummary,
  TaskEvent,
  TaskPriority,
  TaskStatus,
  TaskType,
  TrendState,
} from "./types";

export interface AssistantReadiness {
  latestMigration: string | null;
  analysisSchemaReady: boolean;
  taskPersistenceReady: boolean;
  publishedAnalysisAvailable: boolean;
  inventoryRowCount: number;
  inventorySkuCount: number;
  warehouseCount: number;
  mappedWarehouseCount: number;
  unmappedWarehouseCount: number;
  sourceShopCount: number;
  mappedShopCount: number;
  unmappedShopCount: number;
  managerConfiguredShopCount: number;
  unownedShopCount: number;
  countryConfiguredShopCount: number;
  countryUnresolvedShopCount: number;
  historyDays: number;
  historyStart: string | null;
  historyEnd: string | null;
  requiredHistoryDays: number;
  confirmedPredictionRows: number;
  unconfirmedPredictionRows: number;
  operationTasksPublishable: boolean;
  blockers: string[];
}

export interface AssistantWorkspaceResponse {
  ok: boolean;
  contractVersion: string;
  mode: "published" | "readiness";
  publishable: boolean;
  generatedFromPublishedRun: boolean;
  taskPersistenceReady: boolean;
  readiness: AssistantReadiness;
  summary: {
    actionRequiredStoreCount?: number;
    watchStoreCount?: number;
    stableStoreCount?: number;
    blockedStoreCount?: number;
    publishedTaskCount?: number;
    candidateTaskCount?: number;
  };
  run?: {
    id?: string;
    analysisDate?: string;
    publishedAt?: string;
    metricsVersion?: string;
  } | null;
  operationTasks?: Array<Record<string, unknown>>;
  stores?: Array<Record<string, unknown>>;
  products?: Array<Record<string, unknown>>;
  opportunityMap?: Array<Record<string, unknown>>;
}

export interface AssistantWorkspaceData {
  tasks: OperationTask[];
  stores: StoreSummary[];
  products: ProductInsight[];
  opportunityCells: OpportunityCell[];
}

interface AssistantTaskListResponse {
  ok: boolean;
  total: number;
  page: number;
  pageSize: number;
  items: Array<Record<string, unknown>>;
}

interface AssistantTaskMutationResponse {
  ok: boolean;
  item: Record<string, unknown>;
  replayed: boolean;
}

interface AssistantTaskDetailResponse {
  ok: boolean;
  item: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

export class GrowthRadarApiError extends Error {
  code: string;
  currentItem: OperationTask | null;

  constructor(message: string, code = "GROWTH_RADAR_API_FAILED", currentItem: OperationTask | null = null) {
    super(message);
    this.name = "GrowthRadarApiError";
    this.code = code;
    this.currentItem = currentItem;
  }
}

interface AssistantConfigurationCountryMapping {
  key: string;
  sourceWarehouseName: string;
  normalizedWarehouseName: string;
  rowCount: number;
  countryCode: string | null;
  countryName: string | null;
  mappingStatus: "confirmed" | "excluded" | "unmapped";
  lastUpdated: string | null;
}

interface AssistantConfigurationShopMapping {
  key: string;
  sourceShopName: string;
  platform: string | null;
  internalShopId: string | null;
  internalShopName: string | null;
  countryCode: string | null;
  countryName: string | null;
  managerUserId: string | null;
  readinessStatus: "confirmed" | "unmapped";
  missingFields: string[];
}

export interface AssistantConfigurationResponse {
  ok: boolean;
  writeGate: {
    enabled: boolean;
    approvalRequired: boolean;
    reasons: string[];
  };
  dataSources: AssistantDataSourceStatus[];
  countryMappings: AssistantConfigurationCountryMapping[];
  shopMappings: AssistantConfigurationShopMapping[];
}

export interface AssistantDataSourceStatus {
  key: "orders" | "inventory";
  taskType: MabangSyncTaskType;
  sourceType: "mabang_order" | "mabang_inventory";
  label: string;
  latestBatch: {
    id: string;
    sourceFilename: string | null;
    collectedAt: string | null;
    importedAt: string | null;
    rowCount: number;
  } | null;
}

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
  scheduleType: "daily" | "weekly" | "monthly";
  scheduleConfig: {
    hour?: number;
    minute?: number;
    weekdays?: number[];
    day?: number | "last";
  };
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

export interface MabangSyncOverview {
  scheduler: {
    online: boolean;
    leaseUntil: string | null;
    updatedAt: string | null;
  };
  encryptionConfigured: boolean;
  accounts: MabangAccountProfile[];
  tasks: MabangScheduledTask[];
  runs: MabangScheduledRun[];
}

export type GrowthRadarFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let runtimeFetch: GrowthRadarFetch | null = null;
let runtimeApiBase: string | null = null;

export function configureGrowthRadarApi({
  fetchImpl,
  apiBase = "",
}: {
  fetchImpl?: GrowthRadarFetch;
  apiBase?: string;
} = {}) {
  runtimeFetch = fetchImpl || null;
  runtimeApiBase = String(apiBase || "").replace(/\/+$/, "");
}

function apiUrl(path: string) {
  if (runtimeApiBase !== null) return `${runtimeApiBase}${path}`;
  const configuredBase = import.meta.env.VITE_GROWTH_RADAR_API_BASE;
  if (import.meta.env.DEV && configuredBase === undefined) return null;
  const base = String(configuredBase || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

function request(input: RequestInfo | URL, init?: RequestInit) {
  return (runtimeFetch || globalThis.fetch.bind(globalThis))(input, init);
}

export async function loadAssistantWorkspace(signal?: AbortSignal) {
  const url = apiUrl("/api/growth-radar/v2/assistant/workspace?max_tasks=10");
  if (!url) {
    throw new Error("Growth Radar API is disabled in the independent development workspace.");
  }
  const response = await request(url, {
    headers: { accept: "application/json" },
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | AssistantWorkspaceResponse
    | { error?: string }
    | null;
  if (!response.ok || !payload || !("readiness" in payload)) {
    throw new Error(
      (payload && "error" in payload && payload.error)
      || `Growth Radar API unavailable (${response.status})`,
    );
  }
  return payload;
}

export async function loadAssistantConfiguration(signal?: AbortSignal) {
  const url = apiUrl("/api/growth-radar/v2/assistant/configuration");
  if (!url) {
    throw new Error("Growth Radar API is disabled in the independent development workspace.");
  }
  const response = await request(url, {
    headers: { accept: "application/json" },
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | AssistantConfigurationResponse
    | { error?: string }
    | null;
  if (!response.ok || !payload || !("writeGate" in payload)) {
    throw new Error(
      (payload && "error" in payload && payload.error)
      || `Growth Radar configuration API unavailable (${response.status})`,
    );
  }
  return payload;
}

async function mabangSchedulerRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = apiUrl(path);
  if (!url) {
    throw new Error("马帮定时同步 API 在独立开发工作区中不可用。");
  }
  const response = await request(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { ok?: boolean })
    | { error?: string }
    | null;
  if (!response.ok || !payload) {
    throw new Error(
      (payload && "error" in payload && payload.error)
      || `马帮定时同步 API 不可用 (${response.status})`,
    );
  }
  return payload as T;
}

export async function loadMabangSyncOverview(
  signal?: AbortSignal,
): Promise<MabangSyncOverview> {
  const [meta, accounts, tasks, runs] = await Promise.all([
    mabangSchedulerRequest<{
      scheduler: MabangSyncOverview["scheduler"];
      encryptionConfigured: boolean;
    }>("/api/mabang/scheduler-meta", { signal }),
    mabangSchedulerRequest<{ profiles: MabangAccountProfile[] }>(
      "/api/mabang/account-profiles",
      { signal },
    ),
    mabangSchedulerRequest<{ tasks: MabangScheduledTask[] }>(
      "/api/mabang/scheduled-tasks",
      { signal },
    ),
    mabangSchedulerRequest<{ runs: MabangScheduledRun[] }>(
      "/api/mabang/scheduled-runs?limit=30",
      { signal },
    ),
  ]);
  return {
    scheduler: meta.scheduler,
    encryptionConfigured: meta.encryptionConfigured,
    accounts: accounts.profiles || [],
    tasks: (tasks.tasks || []).filter((task) => (
      task.taskType === "order_export" || task.taskType === "inventory_export"
    )),
    runs: runs.runs || [],
  };
}

export async function saveMabangDailySyncTask(input: {
  task?: MabangScheduledTask | null;
  taskType: MabangSyncTaskType;
  name: string;
  accountProfileId: string;
  hour: number;
  minute: number;
  paymentDateMode?: string;
  enabled: boolean;
}) {
  const existing = input.task || null;
  const path = existing
    ? `/api/mabang/scheduled-tasks/${encodeURIComponent(existing.id)}`
    : "/api/mabang/scheduled-tasks";
  return mabangSchedulerRequest<{ task: MabangScheduledTask }>(path, {
    method: existing ? "PUT" : "POST",
    body: JSON.stringify({
      taskType: input.taskType,
      name: input.name,
      description: existing?.description
        || (input.taskType === "order_export"
          ? "超级店长助手每日订单事实同步"
          : "超级店长助手每日库存快照同步"),
      accountProfileId: input.accountProfileId,
      dingtalkConfigId: existing?.dingtalkConfigId || null,
      scheduleType: "daily",
      scheduleConfig: { hour: input.hour, minute: input.minute },
      timezone: existing?.timezone || "Asia/Shanghai",
      paymentDateMode: input.taskType === "order_export"
        ? input.paymentDateMode || "yesterday"
        : "snapshot",
      paymentDateConfig: existing?.paymentDateConfig || {},
      filters: existing?.filters || [],
      enabled: input.enabled,
      fileRetentionDays: existing?.fileRetentionDays ?? 30,
      notifyEnabled: existing?.notifyEnabled ?? false,
      catchUpEnabled: existing?.catchUpEnabled ?? true,
    }),
  });
}

export async function setMabangSyncTaskEnabled(
  taskId: string,
  enabled: boolean,
) {
  return mabangSchedulerRequest<{ task: MabangScheduledTask }>(
    `/api/mabang/scheduled-tasks/${encodeURIComponent(taskId)}/${enabled ? "enable" : "disable"}`,
    { method: "POST", body: "{}" },
  );
}

export async function runMabangSyncTask(taskId: string) {
  return mabangSchedulerRequest<{ runId: string; status: string }>(
    `/api/mabang/scheduled-tasks/${encodeURIComponent(taskId)}/run-now`,
    { method: "POST", body: "{}" },
  );
}

async function taskRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = apiUrl(path);
  if (!url) {
    throw new GrowthRadarApiError(
      "Growth Radar API is disabled in the independent development workspace.",
    );
  }
  const response = await request(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & {
        error?: string;
        code?: string;
        currentItem?: Record<string, unknown>;
      })
    | null;
  if (!response.ok || !payload) {
    throw new GrowthRadarApiError(
      payload?.error || `Growth Radar task API unavailable (${response.status})`,
      payload?.code,
      payload?.currentItem ? operationTaskFromApi(payload.currentItem) : null,
    );
  }
  return payload;
}

export async function loadAssistantTasks(signal?: AbortSignal) {
  const payload = await taskRequest<AssistantTaskListResponse>(
    "/api/growth-radar/v2/tasks?page_size=500",
    { signal },
  );
  return payload.items.map((row) => operationTaskFromApi(row));
}

export async function loadAssistantTaskDetail(id: string, signal?: AbortSignal) {
  const payload = await taskRequest<AssistantTaskDetailResponse>(
    `/api/growth-radar/v2/tasks/${encodeURIComponent(id)}`,
    { signal },
  );
  return {
    item: operationTaskFromApi(payload.item),
    events: payload.events.map((row): TaskEvent => ({
      id: text(row.id),
      taskRevision: number(row.taskRevision),
      eventType: text(row.eventType),
      fromStatus: row.fromStatus ? taskStatus(row.fromStatus) : undefined,
      toStatus: taskStatus(row.toStatus),
      actorUserId: text(row.actorUserId, "unknown"),
      actorType: row.actorType === "user" ? "user" : "system",
      reasonCode: row.reasonCode ? text(row.reasonCode) : undefined,
      note: row.note ? text(row.note) : undefined,
      occurredAt: text(row.occurredAt),
    })),
  };
}

export async function updateAssistantTaskStatus(
  id: string,
  input: {
    status: TaskStatus;
    expectedRevision: number;
    idempotencyKey: string;
    reasonCode?: string;
    note?: string;
    dueAt?: string;
    snoozedUntil?: string;
  },
) {
  const payload = await taskRequest<AssistantTaskMutationResponse>(
    `/api/growth-radar/v2/tasks/${encodeURIComponent(id)}/status`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return {
    item: operationTaskFromApi(payload.item),
    replayed: payload.replayed,
  };
}

export async function assignAssistantTask(
  id: string,
  input: {
    ownerUserId: string;
    expectedRevision: number;
    idempotencyKey: string;
    note?: string;
  },
) {
  const payload = await taskRequest<AssistantTaskMutationResponse>(
    `/api/growth-radar/v2/tasks/${encodeURIComponent(id)}/assignment`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return {
    item: operationTaskFromApi(payload.item),
    replayed: payload.replayed,
  };
}

function platformCode(value: string | null): PlatformCode {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized.includes("SHOPEE")) return "SHOPEE";
  if (normalized.includes("LAZADA")) return "LAZADA";
  if (normalized.includes("TIKTOK")) return "TIKTOK";
  return "UNMAPPED";
}

export function countryMappingsFromApi(
  rows: AssistantConfigurationResponse["countryMappings"],
): CountryMappingRow[] {
  return rows.map((row) => ({
    key: row.key,
    warehouseName: row.sourceWarehouseName,
    normalizedWarehouseName: row.normalizedWarehouseName,
    rowCount: row.rowCount,
    countryCode: row.countryCode || undefined,
    countryName: row.countryName || undefined,
    status: row.mappingStatus === "confirmed" || row.mappingStatus === "excluded"
      ? "CONFIRMED"
      : "UNMAPPED",
    lastUpdated: row.lastUpdated || undefined,
  }));
}

export function shopMappingsFromApi(
  rows: AssistantConfigurationResponse["shopMappings"],
): ShopMappingRow[] {
  return rows.map((row) => ({
    key: row.key,
    sourceShopName: row.sourceShopName,
    platform: platformCode(row.platform),
    internalShopId: row.internalShopId || undefined,
    internalShopName: row.internalShopName || undefined,
    countryCode: row.countryCode || undefined,
    countryName: row.countryName || undefined,
    manager: row.managerUserId || undefined,
    missingFields: row.missingFields,
    status: row.readinessStatus === "confirmed" ? "CONFIRMED" : "UNMAPPED",
  }));
}

const countryNames: Record<string, string> = {
  TH: "泰国",
  PH: "菲律宾",
  ID: "印尼",
  VN: "越南",
  MY: "马来西亚",
};

function number(value: unknown, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function text(value: unknown, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function taskPriority(value: unknown): TaskPriority {
  return ["P0", "P1", "P2", "P3"].includes(String(value))
    ? value as TaskPriority
    : "P3";
}

function taskStatus(value: unknown): TaskStatus {
  return [
    "NEW",
    "ACKNOWLEDGED",
    "IN_PROGRESS",
    "MONITORING",
    "RESOLVED",
    "BLOCKED",
    "DISMISSED",
    "REOPENED",
  ].includes(String(value))
    ? value as TaskStatus
    : "NEW";
}

function taskType(value: unknown): TaskType {
  return ({
    DATA_BLOCKED: "DATA_CONFIGURATION",
    STORE_WATCH: "DATA_CONFIGURATION",
    INVENTORY_RISK: "INVENTORY_RISK",
    GROWTH_OPPORTUNITY: "STORE_ASSORTMENT_GAP",
    BLUE_OCEAN: "QUIET_ENTRY",
    CROSS_COUNTRY_CANDIDATE: "CROSS_COUNTRY_CANDIDATE",
  } as Record<string, TaskType>)[String(value)] || "DATA_CONFIGURATION";
}

function storeState(value: unknown): StoreState {
  return ["ACTION_REQUIRED", "WATCH", "STABLE", "BLOCKED"].includes(String(value))
    ? value as StoreState
    : "BLOCKED";
}

function trendState(value: unknown): TrendState {
  return [
    "GROWING",
    "DECLINING",
    "STABLE",
    "NEWLY_SELLING",
    "INSUFFICIENT_HISTORY",
  ].includes(String(value))
    ? value as TrendState
    : "INSUFFICIENT_HISTORY";
}

function directionCode(value: unknown): DirectionCode | null {
  return [
    "QUIET_ENTRY",
    "PRIORITY_GROWTH",
    "DEFEND_WINNER",
    "SUPPLY_CONSTRAINED",
    "CROSS_COUNTRY_CANDIDATE",
  ].includes(String(value))
    ? value as DirectionCode
    : null;
}

function evidenceLabel(key: string) {
  return ({
    supplyConstrainedCount: "供给受限 SKU",
    priorityGrowthCount: "增长跟进 SKU",
    quietEntryCount: "蓝海候选 SKU",
    ownSalesQuantity28d: "近 28 天有效订单销量",
    highPerformanceCoverageRate28d: "高表现货盘销售覆盖",
    saleableCoverageRate28d: "可售货盘销售覆盖",
    sourcePredictedDailySales: "来源预测日销量",
    availableQuantity: "可用库存",
    validatedCountryCode: "已验证国家",
    candidateCountryCode: "候选国家",
    evidenceBoundary: "证据边界",
    availabilityStatus: "可用状态",
    qualityStatus: "质量状态",
    reasonCode: "原因码",
  } as Record<string, string>)[key] || key;
}

function evidenceValue(value: unknown) {
  if (typeof value === "number") {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  }
  if (value === null || value === undefined || value === "") return "数据不足";
  return String(value);
}

export function assistantWorkspaceDataFromApi(
  workspace: AssistantWorkspaceResponse,
): AssistantWorkspaceData {
  const opportunityRows = workspace.opportunityMap || [];
  const countryNameByCode = new Map<string, string>(
    opportunityRows.map((row) => [
      text(row.countryCode, "UNMAPPED"),
      text(row.countryName, countryNames[text(row.countryCode)] || text(row.countryCode)),
    ]),
  );
  const publishedAt = text(
    workspace.run?.publishedAt || workspace.run?.analysisDate,
    new Date().toISOString(),
  );
  const rawTasks = workspace.operationTasks || [];
  const tasks = rawTasks.map((row) => operationTaskFromApi(
    row,
    countryNameByCode,
    publishedAt,
  ));

  const taskCountsByStore = new Map<string, { active: number; severe: number }>();
  for (const item of tasks) {
    const raw = rawTasks.find((entry) => text(entry.id) === item.id);
    const storeId = text(raw?.storeId);
    if (!storeId) continue;
    if (!taskCountsByStore.has(storeId)) {
      taskCountsByStore.set(storeId, { active: 0, severe: 0 });
    }
    const counts = taskCountsByStore.get(storeId);
    if (!counts) continue;
    if (!["RESOLVED", "DISMISSED"].includes(item.status)) counts.active += 1;
    if (["P0", "P1"].includes(item.priority)) counts.severe += 1;
  }

  const stores = (workspace.stores || []).map((row): StoreSummary => {
    const code = text(row.countryCode, "UNMAPPED");
    const trend = row.trend && typeof row.trend === "object"
      ? row.trend as Record<string, unknown>
      : {};
    const counts = taskCountsByStore.get(text(row.shopId)) || { active: 0, severe: 0 };
    const coverage = nullableNumber(row.highPerformanceCoverageRate28d);
    return {
      id: text(row.shopId),
      shopName: text(row.displayName, "未命名店铺"),
      countryCode: code,
      countryName: countryNameByCode.get(code) || countryNames[code] || code,
      platform: platformCode(text(row.platform)),
      manager: text(row.ownerUserId, "未配置负责人"),
      current7d: nullableNumber(trend.current7d),
      previous7d: nullableNumber(trend.previous7d),
      trendPercent: nullableNumber(trend.changeRate) === null
        ? null
        : number(trend.changeRate) * 100,
      trendState: trendState(trend.status),
      highPerformanceCoverage: coverage === null ? null : coverage * 100,
      activeTaskCount: counts.active,
      severeAnomalyCount: counts.severe,
      state: storeState(row.state),
      updatedAt: publishedAt,
      blocker: row.state === "BLOCKED" ? text(row.reasonCode, "数据准备未完成") : undefined,
    };
  });

  const products = (workspace.products || []).flatMap((row, index): ProductInsight[] => {
    const direction = directionCode(row.directionCode);
    if (!direction) return [];
    const code = text(row.countryCode, "UNMAPPED");
    const trend = row.trend && typeof row.trend === "object"
      ? row.trend as Record<string, unknown>
      : {};
    const changeRate = nullableNumber(trend.changeRate);
    return [{
      key: `${code}-${text(row.sku)}-${index}`,
      rank: number(row.forecastRank, index + 1),
      sku: text(row.sku),
      name: text(row.productName, text(row.sku)),
      countryCode: code,
      countryName: text(row.countryName, countryNameByCode.get(code) || countryNames[code] || code),
      category: text(row.category, "未分类"),
      predictedDailySales: number(row.sourcePredictedDailySales),
      ownSales28d: number(row.ownSalesQuantity28d),
      current7d: number(trend.current7d),
      previous7d: number(trend.previous7d),
      captureRatio: number(row.ownCaptureRatio28d),
      available: number(row.availableQuantity),
      inbound: number(row.inTransitQuantity),
      coverageDays: nullableNumber(row.forecastCoverageDays),
      direction,
      marketPercentile: Math.round(number(row.forecastPercentile) * 100),
      trendState: trendState(trend.status),
      trendPercent: changeRate === null ? null : changeRate * 100,
      sourceLabel: "马帮来源预测日销量",
    }];
  });

  const opportunityCells = opportunityRows.map((row): OpportunityCell => ({
    countryCode: text(row.countryCode),
    countryName: text(
      row.countryName,
      countryNames[text(row.countryCode)] || text(row.countryCode),
    ),
    category: text(row.category, "未分类"),
    opportunityCount: number(row.actionCount),
    highPerformanceSkuCount: number(row.verifiedSkuCount),
    lowCaptureSkuCount: number(row.quietEntryCount) + number(row.priorityGrowthCount),
    inventoryReadySkuCount: number(row.quietEntryCount) + number(row.priorityGrowthCount),
  }));

  return { tasks, stores, products, opportunityCells };
}

export function operationTaskFromApi(
  row: Record<string, unknown>,
  countryNameByCode = new Map<string, string>(),
  fallbackDate = new Date().toISOString(),
): OperationTask {
  const code = text(row.countryCode, "UNMAPPED");
  const rawEvidence = row.evidence && typeof row.evidence === "object"
    ? row.evidence as Record<string, unknown>
    : {};
  return {
    id: text(row.id),
    persisted: row.persisted === true,
    revision: Math.max(0, number(row.revision)),
    priority: taskPriority(row.priority),
    type: taskType(row.type),
    title: text(row.title, "待处理运营任务"),
    discovery: text(row.reason, "请查看证据字段。"),
    recommendation: text(row.recommendedAction, "核查证据后人工处理。"),
    shopName: text(row.storeName, "全部相关店铺"),
    countryCode: code,
    countryName: countryNameByCode.get(code) || countryNames[code] || code,
    platform: platformCode(text(row.platform)),
    manager: text(row.managerId, "未配置负责人"),
    category: text(row.category, "跨类目"),
    skuCount: row.sku ? 1 : number(rawEvidence.skuCount),
    status: taskStatus(row.status),
    firstSeen: text(row.firstDetectedAt, fallbackDate),
    lastHit: text(row.lastDetectedAt, fallbackDate),
    dueAt: row.dueAt ? text(row.dueAt) : undefined,
    snoozedUntil: row.snoozedUntil ? text(row.snoozedUntil) : undefined,
    evidence: Object.entries(rawEvidence).map(([key, value]) => ({
      label: evidenceLabel(key),
      value: evidenceValue(value),
    })),
    blockedReason: row.type === "DATA_BLOCKED"
      ? text(row.reason, "数据尚未达到分析条件。")
      : row.blockedReasonCode
        ? text(row.blockedReasonCode)
        : undefined,
  };
}

function readinessState(current: number, target: number): ReadinessItem["state"] {
  if (target <= 0 || current >= target) return "READY";
  return current > 0 ? "PARTIAL" : "BLOCKED";
}

export function readinessItemsFromApi(
  readiness: AssistantReadiness,
): ReadinessItem[] {
  const shopIdentityCurrent = Math.min(
    readiness.mappedShopCount,
    readiness.managerConfiguredShopCount,
    readiness.countryConfiguredShopCount,
  );
  return [
    {
      key: "schema",
      label: "V2 分析数据模型",
      current: readiness.analysisSchemaReady ? 1 : 0,
      target: 1,
      unit: "项",
      state: readiness.analysisSchemaReady ? "READY" : "BLOCKED",
      detail: readiness.analysisSchemaReady
        ? `当前迁移：${readiness.latestMigration || "未知"}`
        : `当前迁移止于 ${readiness.latestMigration || "未知"}，正式 V2 表尚未批准。`,
      nextAction: readiness.analysisSchemaReady
        ? "继续检查最新已发布分析。"
        : "完成迁移评审前保持只读，不创建正式经营任务。",
    },
    {
      key: "history",
      label: "有效订单历史窗口",
      current: readiness.historyDays,
      target: readiness.requiredHistoryDays,
      unit: "天",
      state: readinessState(readiness.historyDays, readiness.requiredHistoryDays),
      detail: readiness.historyStart && readiness.historyEnd
        ? `${readiness.historyStart} 至 ${readiness.historyEnd}，按四类有效订单的付款日期归属。`
        : "尚无可用于趋势比较的完整业务日期。",
      nextAction: "连续同步至少 14 个完整业务日后启用当前 7 天 vs 前 7 天趋势。",
    },
    {
      key: "shops",
      label: "店铺身份、国家与店长归属",
      current: shopIdentityCurrent,
      target: readiness.sourceShopCount,
      unit: "家",
      state: readinessState(shopIdentityCurrent, readiness.sourceShopCount),
      detail: `${readiness.unmappedShopCount} 家身份未映射，${readiness.unownedShopCount} 家未绑定店长，${readiness.countryUnresolvedShopCount} 家国家未确认。`,
      nextAction: "在配置页确认内部店铺、国家和店长归属。",
    },
    {
      key: "warehouses",
      label: "仓库国家映射",
      current: readiness.mappedWarehouseCount,
      target: readiness.warehouseCount,
      unit: "个",
      state: readinessState(
        readiness.mappedWarehouseCount,
        readiness.warehouseCount,
      ),
      detail: `${readiness.unmappedWarehouseCount} 个仓库尚未进入已发布国家映射。`,
      nextAction: "由用户维护并发布带版本的仓库国家配置。",
    },
    {
      key: "forecast",
      label: "预测日销量语义",
      current: readiness.confirmedPredictionRows,
      target: readiness.inventoryRowCount,
      unit: "行",
      state: readinessState(
        readiness.confirmedPredictionRows,
        readiness.inventoryRowCount,
      ),
      detail: `${readiness.unconfirmedPredictionRows} 行仍未确认来源预测日销量语义。`,
      nextAction: "确认该字段只作为来源预测参考，不称为公司实际销量。",
    },
  ];
}

export function readinessTasksFromItems(items: ReadinessItem[]): OperationTask[] {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  return items
    .filter((item) => item.state !== "READY")
    .map((item) => ({
      id: `readiness-${item.key}`,
      priority: item.state === "BLOCKED" ? "P1" : "P3",
      type: "DATA_CONFIGURATION",
      title: item.label,
      discovery: item.detail,
      recommendation: item.nextAction,
      shopName: "数据准备",
      countryCode: "UNMAPPED",
      countryName: "待确认",
      platform: "UNMAPPED",
      manager: "数据管理员",
      category: "数据门禁",
      skuCount: 0,
      status: item.state === "BLOCKED" ? "BLOCKED" : "MONITORING",
      firstSeen: now,
      lastHit: now,
      evidence: [
        { label: "当前", value: `${item.current}${item.unit}` },
        { label: "目标", value: `${item.target}${item.unit}` },
        {
          label: "完成度",
          value: `${Math.min(100, Math.round((item.current / Math.max(1, item.target)) * 100))}%`,
        },
      ],
      blockedReason: item.state === "BLOCKED" ? item.detail : undefined,
    }));
}
