<script setup lang="ts">
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CalendarClock,
  Download,
  Play,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import DailyOperationsBrief from "@/components/DailyOperationsBrief.vue";
import MetricCard from "@/components/MetricCard.vue";
import ModuleAiInsight from "@/components/ModuleAiInsight.vue";
import SalesSourceImports from "@/components/SalesSourceImports.vue";
import TrendChart from "@/components/TrendChart.vue";
import {
  loadSalesDashboard,
  loadSalesTrend,
  type BusinessOpportunity,
  type SalesDashboard,
} from "@/services/overview";
import {
  analyzeSalesDashboard,
  deleteDingtalkConfig,
  downloadMabangExport,
  loadAutomationOverview,
  loadMabangFilterOptions,
  loadMabangRunDetail,
  loadSalesAiStatus,
  runSyncTask,
  saveDailySyncTask,
  saveDingtalkConfig,
  testDingtalkConfig,
  type AutomationOverview,
  type DingtalkConfig,
  type MabangFilterOptions,
  type MabangOrderFilter,
  type MabangRunDetail,
  type MabangScheduledRun,
  type MabangScheduledTask,
  type MabangSyncTaskType,
  type SalesAssortmentAnalysis,
  type SalesAssortmentAiStatus,
} from "@/services/sales-automation";
import {
  applySalesImport,
  loadSalesSourceRows,
  previewSalesImport,
  type SalesImportKind,
  type SalesImportPreview,
  type SalesSourceDataPage,
} from "@/services/sales-imports";
import { useWorkspaceStore } from "@/stores/workspace";

function shanghaiCalendarDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftCalendarDay(day: string, offset: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function pickerRange(from: string, to: string): [Date, Date] {
  return [new Date(`${from}T00:00:00+08:00`), new Date(`${to}T00:00:00+08:00`)];
}

function yesterdayRange(): [string, string] {
  const yesterday = shiftCalendarDay(shanghaiCalendarDay(), -1);
  return [yesterday, yesterday];
}

function monthComparisonWindow() {
  const today = shanghaiCalendarDay();
  const [year, month, day] = today.split("-").map(Number);
  const currentStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const previousAnchor = new Date(Date.UTC(year, month - 2, 1));
  const previousYear = previousAnchor.getUTCFullYear();
  const previousMonth = previousAnchor.getUTCMonth() + 1;
  const previousMonthDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const previousStart = `${previousYear}-${String(previousMonth).padStart(2, "0")}-01`;
  const previousEnd = `${previousYear}-${String(previousMonth).padStart(2, "0")}-${String(Math.min(day, previousMonthDays)).padStart(2, "0")}`;
  return {
    currentStart,
    currentEnd: today,
    previousStart,
    previousEnd,
    currentLabel: `${month}月1日-${month}月${day}日`,
    previousLabel: `${previousMonth}月1日-${previousMonth}月${Math.min(day, previousMonthDays)}日`,
  };
}

const workspace = useWorkspaceStore();
const loading = ref(false);
const error = ref("");
const dashboard = shallowRef<SalesDashboard | null>(null);
let dashboardController: AbortController | null = null;
let monthlyTrendController: AbortController | null = null;
let dashboardLoadSequence = 0;
const periodDays = ref(7);
const dateRangeFilter = ref<[string, string] | null>(yesterdayRange());
const comparisonDays = ref(1);
const monthlyTrendLoading = ref(false);
const monthlyTrendError = ref("");
const currentMonthTrend = shallowRef<SalesDashboard["trend"]>([]);
const previousMonthTrend = shallowRef<SalesDashboard["trend"]>([]);
const monthlyWindow = ref(monthComparisonWindow());
const filters = reactive({ country: "", categoryL1: "", categoryL2: "", style: "", store: "" });
const anomalyFilter = reactive({ storeAmount: 0, storeRate: 0, styleQuantity: 0, styleRate: 0 });

const fileInput = ref<HTMLInputElement | null>(null);
const selectedImportKind = ref<SalesImportKind>("orders");
const importBusyKind = ref<SalesImportKind | null>(null);
const importPreview = ref<SalesImportPreview | null>(null);
const importApplying = ref(false);
const sourceDialogOpen = ref(false);
const sourceLoading = ref(false);
const sourceKind = ref<SalesImportKind>("orders");
const sourceData = ref<SalesSourceDataPage | null>(null);

const automation = ref<AutomationOverview | null>(null);
const automationLoading = ref(false);
const automationError = ref("");
const aiStatus = ref<SalesAssortmentAiStatus | null>(null);
const aiAnalysis = ref<SalesAssortmentAnalysis | null>(null);
const aiLoading = ref(false);
const aiError = ref("");
let analysisController: AbortController | null = null;

const taskDialogOpen = ref(false);
const taskSaving = ref(false);
const editingTask = ref<MabangScheduledTask | null>(null);
const taskForm = reactive({
  taskType: "order_export" as MabangSyncTaskType,
  name: "",
  accountProfileId: "",
  time: "08:00",
  paymentDateMode: "yesterday",
  dingtalkConfigId: "",
  notifyEnabled: true,
  enabled: true,
});

const immediateDialogOpen = ref(false);
const immediateRunning = ref(false);
const immediateOptionsLoading = ref(false);
const immediateFilterOptions = ref<MabangFilterOptions>({});
const immediateForm = reactive({
  taskId: "",
  paymentDateMode: "yesterday",
  fixedDateRange: [] as string[],
  relativeStartDays: 7,
  relativeEndDays: 1,
  filters: [] as MabangOrderFilter[],
});

const progressDialogOpen = ref(false);
const progressLoading = ref(false);
const progressRun = ref<MabangRunDetail | null>(null);
let progressTimer: ReturnType<typeof setTimeout> | null = null;

const dingtalkDialogOpen = ref(false);
const dingtalkSaving = ref(false);
const editingDingtalk = ref<DingtalkConfig | null>(null);
const dingtalkForm = reactive({
  name: "",
  webhookUrl: "",
  secret: "",
  atMobiles: "",
  enabled: true,
  notifyOnSuccess: true,
  notifyOnFailure: true,
  notifyOnEmpty: false,
  atAll: false,
});

const options = computed(() => dashboard.value?.filters?.options || {});
const orderTasks = computed(() => automation.value?.tasks.filter((task) => task.taskType === "order_export") || []);
const runnableOrderTasks = computed(() => orderTasks.value.filter((task) => task.accountAvailable && task.accountEnabled));
const orderRuns = computed(() => automation.value?.runs.filter((run) => run.taskType === "order_export") || []);
const selectedImmediateTask = computed(() => orderTasks.value.find((task) => task.id === immediateForm.taskId) || null);
const immediateNotificationText = computed(() => {
  const task = selectedImmediateTask.value;
  if (!task?.notifyEnabled || !task.dingtalkConfigId) return "本次导出不发送钉钉机器人通知。";
  return `本次会继承任务的钉钉设置：${task.dingtalkName || "已绑定机器人"}；成功、失败和空数据是否提醒由机器人配置决定。`;
});
const orderFields = computed(() => {
  const primary = new Set(automation.value?.primaryFilterIds || []);
  return [...(automation.value?.fields || [])]
    .filter((field) => field.id !== "uq115")
    .sort((left, right) => Number(primary.has(right.id)) - Number(primary.has(left.id)));
});
const paymentDateModeOptions = [
  ["today", "今天"], ["yesterday", "昨天"], ["last_7_days", "近 7 天"],
  ["last_14_days", "近 14 天"], ["last_30_days", "近 30 天"],
  ["this_week", "本周"], ["previous_week", "上周"], ["this_month", "本月"],
  ["previous_month", "上月"], ["relative", "相对天数"], ["fixed", "自定义日期"],
].map(([value, label]) => ({ value, label }));
const filterOperatorOptions = [
  ["equals", "等于任一值"], ["contains", "包含任一值"], ["notEquals", "不等于所有值"],
  ["notContains", "不包含所有值"], ["empty", "为空"], ["notEmpty", "非空"],
].map(([value, label]) => ({ value, label }));
const filterOptionKeys: Record<string, keyof MabangFilterOptions> = {
  uq172: "managers", uq135: "shops", uq205: "platforms", uq108: "regions",
  uq137: "warehouses", uq136: "orderStatuses", uq119: "skus", uq128: "logisticsChannels",
};
const terminalRunStatuses = new Set(["success", "partial_success", "failed", "skipped"]);
const runStatusLabels: Record<string, string> = {
  pending: "排队中",
  running: "执行中",
  success: "成功",
  partial_success: "部分成功",
  failed: "失败",
  skipped: "已跳过",
};
const runStageLabels: Record<string, string> = {
  calculate_date_range: "计算付款时间",
  load_credentials: "读取马帮账号",
  mabang_login: "登录马帮",
  fetch_orders: "获取订单",
  apply_filters: "应用筛选条件",
  generate_excel: "生成 Excel",
  save_file: "保存导出文件",
  persist_collected_data: "写入订单数据库",
  send_dingtalk: "发送钉钉通知",
  complete: "执行完成",
  task_state: "检查任务状态",
};
const progressStages = [
  "calculate_date_range", "load_credentials", "mabang_login", "fetch_orders", "apply_filters",
  "generate_excel", "save_file", "persist_collected_data", "send_dingtalk", "complete",
];
const exportProgressPercent = computed(() => {
  const run = progressRun.value;
  if (!run) return 0;
  if (terminalRunStatuses.has(run.status)) return 100;
  const completed = new Set(
    run.events
      .filter((event) => ["success", "partial_success", "skipped"].includes(event.status))
      .map((event) => event.stage),
  );
  const ratio = progressStages.filter((stage) => completed.has(stage)).length / progressStages.length;
  return Math.max(run.status === "running" ? 5 : 0, Math.min(95, Math.round(ratio * 100)));
});
const exportProgressBarStatus = computed<"success" | "exception" | "warning" | undefined>(() => {
  if (progressRun.value?.status === "success") return "success";
  if (progressRun.value?.status === "failed") return "exception";
  if (progressRun.value?.status === "partial_success") return "warning";
  return undefined;
});
const periodLabel = computed(() => {
  const period = dashboard.value?.period;
  if (!period?.orderDateFrom || !period?.orderDateTo) return `近 ${periodDays.value} 天`;
  return `${period.orderDateFrom} 至 ${period.orderDateTo}`;
});
const importDialogOpen = computed({
  get: () => Boolean(importPreview.value),
  set: (open: boolean) => { if (!open) importPreview.value = null; },
});
const sourceColumns = computed(() => ({
  orders: [
    ["paidAt", "付款时间", 150], ["store", "店铺", 160], ["platform", "平台", 90],
    ["manager", "店长", 90], ["status", "状态", 90], ["warehouse", "仓库", 150],
    ["sku", "SKU", 135], ["productName", "商品", 210], ["quantity", "数量", 80],
  ],
  inventory: [
    ["sku", "SKU", 135], ["productName", "商品", 210], ["warehouse", "仓库", 150],
    ["status", "状态", 90], ["activity", "活跃度", 80], ["isNew", "新品", 70],
    ["categoryL1", "一级类目", 110], ["categoryL2", "二级类目", 110],
    ["predictedDailySales", "预测日销", 100], ["availableQuantity", "可用库存", 100],
    ["inTransitQuantity", "在途", 80], ["daysOfSupply", "可售天数", 100],
  ],
  "product-package": [
    ["sku", "SKU", 135], ["mainSku", "主 SKU", 135], ["productName", "商品", 210],
    ["country", "国家", 90], ["categoryL1", "一级类目", 110], ["categoryL2", "二级类目", 110],
    ["style", "款名", 120], ["warehouse", "仓库", 150], ["priceTier45", "45%标价", 100],
    ["exchangeRate", "汇率", 80],
  ],
} as Record<SalesImportKind, Array<[string, string, number]>>)[sourceKind.value]);
const storeDeclines = computed(() => (dashboard.value?.storeAnomalies?.declines || []).filter((item) => (
  Math.max(item.currentAmount, item.previousAmount) >= anomalyFilter.storeAmount
  && Math.abs(Number(item.changeRate || 0)) >= anomalyFilter.storeRate
)));
const storeGrowth = computed(() => (dashboard.value?.storeAnomalies?.growth || []).filter((item) => (
  Math.max(item.currentAmount, item.previousAmount) >= anomalyFilter.storeAmount
  && Math.abs(Number(item.changeRate || 0)) >= anomalyFilter.storeRate
)));
const styleDeclines = computed(() => (dashboard.value?.styleAnomalies?.declines || []).filter((item) => (
  Math.max(item.currentQuantity, item.previousQuantity) >= anomalyFilter.styleQuantity
  && Math.abs(Number(item.changeRate || 0)) >= anomalyFilter.styleRate
)));
const styleGrowth = computed(() => (dashboard.value?.styleAnomalies?.growth || []).filter((item) => (
  Math.max(item.currentQuantity, item.previousQuantity) >= anomalyFilter.styleQuantity
  && Math.abs(Number(item.changeRate || 0)) >= anomalyFilter.styleRate
)));
const storeDeclineRows = computed(() => storeDeclines.value.slice(0, 20));
const storeGrowthRows = computed(() => storeGrowth.value.slice(0, 20));
const styleDeclineRows = computed(() => styleDeclines.value.slice(0, 20));
const styleGrowthRows = computed(() => styleGrowth.value.slice(0, 20));
const businessOpportunityChildren = computed(() => new Map(
  (dashboard.value?.businessOpportunities || []).map((row) => [String(row.key), row.children || []]),
));
const businessOpportunityRows = computed(() => (dashboard.value?.businessOpportunities || []).map((row) => ({
  ...row,
  children: undefined,
  hasChildren: Boolean(row.children?.length),
})));

function loadBusinessOpportunityChildren(
  row: BusinessOpportunity,
  _treeNode: unknown,
  resolve: (rows: BusinessOpportunity["children"]) => void,
) {
  resolve(businessOpportunityChildren.value.get(String(row.key)) || []);
}

function presetRange(days: number, endOffset = 0) {
  const end = shiftCalendarDay(shanghaiCalendarDay(), endOffset);
  return pickerRange(shiftCalendarDay(end, -(days - 1)), end);
}

const dateShortcuts = [
  { text: "今天", value: () => presetRange(1) },
  { text: "昨天", value: () => presetRange(1, -1) },
  { text: "近7天", value: () => presetRange(7) },
  { text: "近14天", value: () => presetRange(14) },
  { text: "近30天", value: () => presetRange(30) },
  { text: "本月", value: () => {
    const range = monthComparisonWindow();
    return pickerRange(range.currentStart, range.currentEnd);
  } },
  { text: "上月", value: () => {
    const today = shanghaiCalendarDay();
    const [year, month] = today.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
    const range = monthComparisonWindow();
    return pickerRange(range.previousStart, `${range.previousStart.slice(0, 8)}${String(lastDay).padStart(2, "0")}`);
  } },
];

function taskForType(taskType: MabangSyncTaskType) {
  return automation.value?.tasks.find((task) => task.taskType === taskType) || null;
}

function taskButtonHint(taskType: MabangSyncTaskType) {
  const task = taskForType(taskType);
  return task ? `${scheduleLabel(task)} · ${task.enabled ? "已启用" : "已停用"}` : "尚未设置";
}

function filterSuggestions(fieldId: string) {
  if (fieldId === "uq135") {
    const managers = immediateForm.filters.find((filter) => filter.fieldId === "uq172")?.values || [];
    if (managers.length && immediateFilterOptions.value.managerShops) {
      return [...new Set(managers.flatMap((manager) => immediateFilterOptions.value.managerShops?.[manager] || []))];
    }
  }
  const key = filterOptionKeys[fieldId];
  const values = key ? immediateFilterOptions.value[key] : [];
  return Array.isArray(values) ? values : [];
}

function addImmediateFilter() {
  const used = new Set(immediateForm.filters.map((filter) => filter.fieldId));
  const field = orderFields.value.find((item) => !used.has(item.id)) || orderFields.value[0];
  if (!field) return;
  immediateForm.filters.push({ fieldId: field.id, operator: "equals", values: [] });
}

function removeImmediateFilter(index: number) {
  immediateForm.filters.splice(index, 1);
}

function changeImmediateFilterField(filter: MabangOrderFilter) {
  filter.values = [];
}

async function loadImmediateFilterOptions(task: MabangScheduledTask) {
  immediateOptionsLoading.value = true;
  try {
    immediateFilterOptions.value = await loadMabangFilterOptions(task.accountProfileId);
  } catch (loadError) {
    immediateFilterOptions.value = {};
    ElMessage.warning(String((loadError as Error)?.message || loadError || "筛选建议值加载失败，可继续手工输入"));
  } finally {
    immediateOptionsLoading.value = false;
  }
}

async function applyImmediateTask(taskId: string) {
  const task = orderTasks.value.find((item) => item.id === taskId);
  if (!task) return;
  immediateForm.paymentDateMode = task.paymentDateMode || "yesterday";
  immediateForm.fixedDateRange = task.paymentDateMode === "fixed"
    ? [String(task.paymentDateConfig.startDate || ""), String(task.paymentDateConfig.endDate || "")].filter(Boolean)
    : [];
  immediateForm.relativeStartDays = Number(task.paymentDateConfig.startDaysAgo ?? 7);
  immediateForm.relativeEndDays = Number(task.paymentDateConfig.endDaysAgo ?? 1);
  immediateForm.filters = task.filters
    .filter((filter) => String(filter.fieldId || "") !== "uq115")
    .map((filter) => ({
      fieldId: String(filter.fieldId || ""),
      operator: String(filter.operator || "equals") as MabangOrderFilter["operator"],
      values: Array.isArray(filter.values) ? filter.values.map(String) : [],
    }));
  await loadImmediateFilterOptions(task);
}

async function openImmediateExport() {
  const task = runnableOrderTasks.value.find((item) => item.id === immediateForm.taskId)
    || runnableOrderTasks.value[0];
  if (!task) {
    ElMessage.warning("请先通过“订单定时”配置并启用一个可用的马帮订单账号");
    return;
  }
  const shouldLoadTaskDefaults = immediateForm.taskId !== task.id;
  immediateForm.taskId = task.id;
  immediateDialogOpen.value = true;
  if (shouldLoadTaskDefaults) {
    await applyImmediateTask(task.id);
  } else if (!Object.keys(immediateFilterOptions.value).length) {
    await loadImmediateFilterOptions(task);
  }
}

async function changeImmediateTask(taskId: string) {
  await applyImmediateTask(taskId);
}

async function executeImmediateOrderExport() {
  const task = orderTasks.value.find((item) => item.id === immediateForm.taskId);
  if (!task) {
    ElMessage.warning("请选择订单导出配置");
    return;
  }
  if (!task.accountAvailable || !task.accountEnabled) {
    ElMessage.warning("当前订单导出配置的马帮账号不可用");
    return;
  }
  let paymentDateConfig: Record<string, unknown> = {};
  if (immediateForm.paymentDateMode === "fixed") {
    if (immediateForm.fixedDateRange.length !== 2) {
      ElMessage.warning("请选择完整的付款日期范围");
      return;
    }
    paymentDateConfig = { startDate: immediateForm.fixedDateRange[0], endDate: immediateForm.fixedDateRange[1] };
  }
  if (immediateForm.paymentDateMode === "relative") {
    if (immediateForm.relativeStartDays < immediateForm.relativeEndDays) {
      ElMessage.warning("相对日期的开始天数必须大于等于结束天数");
      return;
    }
    paymentDateConfig = { startDaysAgo: immediateForm.relativeStartDays, endDaysAgo: immediateForm.relativeEndDays };
  }
  const invalidIndex = immediateForm.filters.findIndex((filter) => (
    !["empty", "notEmpty"].includes(filter.operator) && !filter.values.map((value) => value.trim()).filter(Boolean).length
  ));
  if (invalidIndex >= 0) {
    ElMessage.warning(`请填写第 ${invalidIndex + 1} 个筛选条件的值`);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将按本次选择的付款时间和 ${immediateForm.filters.length} 项筛选条件立即导出，不会修改定时任务。`,
      "确认立即导出订单",
      { type: "info", confirmButtonText: "立即执行" },
    );
    immediateRunning.value = true;
    const result = await runSyncTask(task.id, {
      paymentDateMode: immediateForm.paymentDateMode,
      paymentDateConfig,
      filters: immediateForm.filters.map((filter) => ({ ...filter, values: filter.values.map((value) => value.trim()).filter(Boolean) })),
    }) as { runId?: string; paymentDateRange?: { startDate?: string; endDate?: string } };
    const range = result.paymentDateRange;
    immediateDialogOpen.value = false;
    ElMessage.success(range?.startDate ? `订单导出已进入队列：${range.startDate} 至 ${range.endDate}` : "订单导出已进入执行队列");
    if (result.runId) await openExportProgress(result.runId);
    else await loadAutomation();
  } catch (action) {
    if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action || "订单导出启动失败"));
  } finally {
    immediateRunning.value = false;
  }
}

function stopExportProgressPolling() {
  if (progressTimer !== null) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
}

function runStatusType(status: string) {
  return ({
    pending: "info",
    running: "warning",
    success: "success",
    partial_success: "warning",
    failed: "danger",
    skipped: "info",
  } as Record<string, "info" | "warning" | "success" | "danger">)[status] || "info";
}

function eventStatusType(status: string) {
  return runStatusType(status === "running" ? "running" : status);
}

function runStatusLabel(status: string) {
  return runStatusLabels[status] || status || "未知";
}

function runStageLabel(stage: string) {
  return runStageLabels[stage] || stage;
}

function triggerTypeLabel(triggerType: string) {
  return ({ manual: "立即执行", scheduled: "定时执行", retry: "失败重试", catch_up: "补偿执行" } as Record<string, string>)[triggerType]
    || triggerType
    || "未知";
}

function notificationStatusLabel(status: string | null) {
  return ({
    success: "已发送",
    failed: "发送失败",
    disabled: "未启用",
    skipped_empty: "空数据未通知",
  } as Record<string, string>)[status || ""] || (status ? status : "等待执行");
}

function formatRunDateTime(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

function paymentRangeLabel(run: MabangScheduledRun) {
  if (!run.paymentStartDate || !run.paymentEndDate) return "等待计算";
  return `${run.paymentStartDate} 至 ${run.paymentEndDate}`;
}

function persistenceStatusLabel(run: MabangScheduledRun) {
  const persistence = run.logSummary?.dataPersistence;
  if (!persistence) return terminalRunStatuses.has(run.status) ? "暂无入库结果" : "等待写入";
  if (persistence.status === "applied") return `已写入订单事实库（${Number(persistence.rowCount || 0)} 行）`;
  if (persistence.status === "reused") return "重复批次，已复用原有订单数据";
  if (persistence.status === "empty") return "没有可写入的订单明细";
  if (persistence.status === "not_configured") return "数据入库服务未配置";
  return persistence.status || "已处理";
}

async function refreshExportProgress(runId = progressRun.value?.id || orderRuns.value[0]?.id || "") {
  stopExportProgressPolling();
  if (!runId) {
    progressRun.value = null;
    return;
  }
  progressLoading.value = true;
  let loaded = false;
  try {
    const [detail, overview] = await Promise.all([
      loadMabangRunDetail(runId),
      loadAutomationOverview(),
    ]);
    progressRun.value = detail;
    automation.value = overview;
    automationError.value = "";
    loaded = true;
  } catch (loadError) {
    ElMessage.error(String((loadError as Error)?.message || loadError || "导出进度读取失败"));
  } finally {
    progressLoading.value = false;
  }
  if (loaded && progressDialogOpen.value && progressRun.value?.id === runId && !terminalRunStatuses.has(progressRun.value.status)) {
    progressTimer = setTimeout(() => void refreshExportProgress(runId), 2000);
  }
}

async function openExportProgress(runId = "") {
  progressDialogOpen.value = true;
  if (!runId && !orderRuns.value.length) await loadAutomation();
  const targetRunId = runId || progressRun.value?.id || orderRuns.value[0]?.id || "";
  if (targetRunId) await refreshExportProgress(targetRunId);
}

async function selectExportRun(run: MabangScheduledRun) {
  await refreshExportProgress(run.id);
}

async function downloadExportRun(run: MabangScheduledRun) {
  if (!run.exportFileId) {
    ElMessage.warning("文件尚未生成，完成后即可下载");
    return;
  }
  try {
    await downloadMabangExport(run.exportFileId, run.filename || undefined);
  } catch (downloadError) {
    ElMessage.error(String((downloadError as Error)?.message || downloadError || "导出文件下载失败"));
  }
}

function money(value: unknown) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

function percent(value: unknown) {
  const number = Number(value || 0);
  return `${number.toFixed(1)}%`;
}

function signedPercent(value: unknown) {
  const result = Number(value || 0);
  return `${result > 0 ? "+" : ""}${result.toFixed(1)}%`;
}

function inventoryTypeLabel(type: string) {
  return ({ stockout: "已断货", low_stock: "即将断货", rapid_drop: "库存急降", new_arrival: "新品到货", restock_arrival: "到仓增加", observe: "观察" } as Record<string, string>)[type] || type;
}

function inventoryTagType(type: string) {
  return ({ stockout: "danger", low_stock: "warning", rapid_drop: "warning", new_arrival: "success", restock_arrival: "success", observe: "info" } as Record<string, "danger" | "warning" | "success" | "info">)[type] || "info";
}

function scheduleLabel(task: MabangScheduledTask) {
  const hour = String(task.scheduleConfig.hour ?? 0).padStart(2, "0");
  const minute = String(task.scheduleConfig.minute ?? 0).padStart(2, "0");
  return `每日 ${hour}:${minute}`;
}

function currentFilters(forceRefresh = false) {
  return {
    periodDays: periodDays.value,
    dateFrom: dateRangeFilter.value?.[0],
    dateTo: dateRangeFilter.value?.[1],
    comparisonDays: comparisonDays.value,
    country: filters.country,
    categoryL1: filters.categoryL1,
    categoryL2: filters.categoryL2,
    style: filters.style,
    store: filters.store,
    forceRefresh,
  };
}

async function loadMonthlyTrend(forceRefresh = false) {
  monthlyTrendController?.abort();
  const controller = new AbortController();
  monthlyTrendController = controller;
  monthlyTrendLoading.value = true;
  monthlyTrendError.value = "";
  const window = monthComparisonWindow();
  monthlyWindow.value = window;
  try {
    const monthlyTrend = await loadSalesTrend({
      periodDays: 90,
      dateFrom: window.previousStart,
      dateTo: window.currentEnd,
      comparisonDays: 7,
      country: filters.country,
      categoryL1: filters.categoryL1,
      categoryL2: filters.categoryL2,
      style: filters.style,
      store: filters.store,
      forceRefresh,
    }, controller.signal);
    if (controller.signal.aborted) return;
    currentMonthTrend.value = monthlyTrend.filter((item) => (
      item.date >= window.currentStart && item.date <= window.currentEnd
    ));
    previousMonthTrend.value = monthlyTrend.filter((item) => (
      item.date >= window.previousStart && item.date <= window.previousEnd
    ));
  } catch (loadError) {
    if ((loadError as Error)?.name === "AbortError") return;
    monthlyTrendError.value = String((loadError as Error)?.message || loadError || "月度趋势读取失败");
    currentMonthTrend.value = [];
    previousMonthTrend.value = [];
  } finally {
    if (monthlyTrendController === controller) {
      monthlyTrendController = null;
      monthlyTrendLoading.value = false;
    }
  }
}

function importKindLabel(kind: SalesImportKind) {
  return ({ orders: "订单表", inventory: "库存表", "product-package": "产品包" } as const)[kind];
}

function selectImportFile(kind: SalesImportKind) {
  selectedImportKind.value = kind;
  fileInput.value?.click();
}

async function handleImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  importBusyKind.value = selectedImportKind.value;
  try {
    importPreview.value = await previewSalesImport(selectedImportKind.value, file);
  } catch (previewError) {
    ElMessage.error(String((previewError as Error)?.message || previewError || "文件预览失败"));
  } finally {
    importBusyKind.value = null;
  }
}

async function confirmImport() {
  const preview = importPreview.value;
  if (!preview || preview.blockers > 0) return;
  importApplying.value = true;
  try {
    await applySalesImport(preview);
    ElMessage.success(`${importKindLabel(preview.kind)}已导入并更新驾驶舱数据`);
    importPreview.value = null;
    await load(true);
  } catch (applyError) {
    ElMessage.error(String((applyError as Error)?.message || applyError || "数据导入失败"));
  } finally {
    importApplying.value = false;
  }
}

async function loadSourcePage(page = 1) {
  sourceLoading.value = true;
  try {
    sourceData.value = await loadSalesSourceRows(sourceKind.value, page);
  } catch (loadError) {
    ElMessage.error(String((loadError as Error)?.message || loadError || "数据源读取失败"));
  } finally {
    sourceLoading.value = false;
  }
}

function openSourceData(kind: SalesImportKind) {
  sourceKind.value = kind;
  sourceData.value = null;
  sourceDialogOpen.value = true;
  void loadSourcePage(1);
}

async function loadAutomation() {
  automationLoading.value = true;
  automationError.value = "";
  try {
    automation.value = await loadAutomationOverview();
  } catch (loadError) {
    automationError.value = String((loadError as Error)?.message || loadError || "自动采集状态读取失败");
  } finally {
    automationLoading.value = false;
  }
}

async function loadAiStatus() {
  try {
    aiStatus.value = await loadSalesAiStatus();
  } catch (loadError) {
    aiError.value = String((loadError as Error)?.message || loadError || "DeepSeek 状态读取失败");
  }
}

async function analyze(forceRefresh = false) {
  if (!dashboard.value || !aiStatus.value?.configured) return;
  analysisController?.abort();
  analysisController = new AbortController();
  aiLoading.value = true;
  aiError.value = "";
  try {
    aiAnalysis.value = await analyzeSalesDashboard(currentFilters(forceRefresh), analysisController.signal);
  } catch (analysisError) {
    if ((analysisError as Error)?.name !== "AbortError") {
      aiError.value = String((analysisError as Error)?.message || analysisError || "DeepSeek 分析失败");
    }
  } finally {
    aiLoading.value = false;
  }
}

async function load(forceRefresh = false) {
  const sequence = ++dashboardLoadSequence;
  dashboardController?.abort();
  analysisController?.abort();
  const controller = new AbortController();
  dashboardController = controller;
  loading.value = true;
  error.value = "";
  try {
    const nextDashboard = await loadSalesDashboard(currentFilters(forceRefresh), controller.signal);
    if (controller.signal.aborted || sequence !== dashboardLoadSequence) return;
    dashboard.value = nextDashboard;
    workspace.lastSyncedAt = new Date();
    void loadMonthlyTrend(forceRefresh);
  } catch (loadError) {
    if ((loadError as Error)?.name === "AbortError") return;
    error.value = String((loadError as Error)?.message || loadError || "销售与货盘数据加载失败");
  } finally {
    if (dashboardController === controller) {
      dashboardController = null;
      loading.value = false;
    }
  }
  if (!controller.signal.aborted && sequence === dashboardLoadSequence && dashboard.value) void analyze(false);
}

function reset() {
  dateRangeFilter.value = yesterdayRange();
  periodDays.value = 7;
  comparisonDays.value = 1;
  Object.assign(filters, { country: "", categoryL1: "", categoryL2: "", style: "", store: "" });
  Object.assign(anomalyFilter, { storeAmount: 0, storeRate: 0, styleQuantity: 0, styleRate: 0 });
  void load(false);
}

function openTask(taskType: MabangSyncTaskType, task: MabangScheduledTask | null = null) {
  editingTask.value = task;
  const hour = String(task?.scheduleConfig.hour ?? 8).padStart(2, "0");
  const minute = String(task?.scheduleConfig.minute ?? 0).padStart(2, "0");
  Object.assign(taskForm, {
    taskType: task?.taskType || taskType,
    name: task?.name || (taskType === "order_export"
      ? "每日订单同步"
      : taskType === "inventory_export"
        ? "每日库存同步"
        : "每日经营日报"),
    accountProfileId: task?.accountProfileId || automation.value?.accounts.find((item) => item.enabled)?.id || "",
    time: `${hour}:${minute}`,
    paymentDateMode: task?.paymentDateMode || "yesterday",
    dingtalkConfigId: task?.dingtalkConfigId || "",
    notifyEnabled: task?.notifyEnabled ?? true,
    enabled: task?.enabled ?? true,
  });
  taskDialogOpen.value = true;
}

async function saveTask() {
  if (!taskForm.name.trim() || !taskForm.accountProfileId || !taskForm.time) {
    ElMessage.warning("请填写任务名称、马帮账号和执行时间");
    return;
  }
  if (taskForm.taskType === "daily_report" && !taskForm.dingtalkConfigId) {
    ElMessage.warning("经营日报任务必须选择钉钉机器人");
    return;
  }
  taskSaving.value = true;
  try {
    await saveDailySyncTask({ task: editingTask.value, ...taskForm });
    taskDialogOpen.value = false;
    await loadAutomation();
    ElMessage.success(editingTask.value ? "定时采集任务已更新" : "定时采集任务已创建");
  } catch (saveError) {
    ElMessage.error(String((saveError as Error)?.message || saveError || "任务保存失败"));
  } finally {
    taskSaving.value = false;
  }
}

async function runTask(task: MabangScheduledTask) {
  try {
    await ElMessageBox.confirm(`立即运行“${task.name}”？`, "运行采集任务", { type: "info" });
    await runSyncTask(task.id);
    await loadAutomation();
    ElMessage.success("任务已进入执行队列");
  } catch (action) {
    if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action));
  }
}

function openDingtalk(config: DingtalkConfig | null = null) {
  editingDingtalk.value = config;
  Object.assign(dingtalkForm, {
    name: config?.name || "",
    webhookUrl: "",
    secret: "",
    atMobiles: config?.atMobiles?.join(",") || "",
    enabled: config?.enabled ?? true,
    notifyOnSuccess: config?.notifyOnSuccess ?? true,
    notifyOnFailure: config?.notifyOnFailure ?? true,
    notifyOnEmpty: config?.notifyOnEmpty ?? false,
    atAll: config?.atAll ?? false,
  });
  dingtalkDialogOpen.value = true;
}

async function saveRobot() {
  if (!dingtalkForm.name.trim() || (!editingDingtalk.value && !dingtalkForm.webhookUrl.trim())) {
    ElMessage.warning("请填写机器人名称和 Webhook");
    return;
  }
  dingtalkSaving.value = true;
  try {
    await saveDingtalkConfig({ config: editingDingtalk.value, ...dingtalkForm });
    dingtalkDialogOpen.value = false;
    await loadAutomation();
    ElMessage.success("钉钉机器人已保存");
  } catch (saveError) {
    ElMessage.error(String((saveError as Error)?.message || saveError || "机器人保存失败"));
  } finally {
    dingtalkSaving.value = false;
  }
}

async function testRobot(config: DingtalkConfig) {
  try {
    await testDingtalkConfig(config.id);
    ElMessage.success("钉钉测试消息发送成功");
  } catch (testError) {
    ElMessage.error(String((testError as Error)?.message || testError || "测试消息发送失败"));
  }
}

async function removeRobot(config: DingtalkConfig) {
  try {
    await ElMessageBox.confirm(`删除钉钉机器人“${config.name}”？`, "删除机器人", { type: "warning" });
    await deleteDingtalkConfig(config.id);
    await loadAutomation();
    ElMessage.success("钉钉机器人已删除");
  } catch (action) {
    if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action));
  }
}

onMounted(async () => {
  await Promise.all([loadAutomation(), loadAiStatus()]);
  await load(false);
});

onBeforeUnmount(() => {
  dashboardController?.abort();
  monthlyTrendController?.abort();
  analysisController?.abort();
  stopExportProgressPolling();
});
</script>

<template>
  <div class="assortment-page" v-loading="loading">
    <input
      ref="fileInput"
      class="manual-import-input"
      type="file"
      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      @change="handleImportFile"
    />

    <SalesSourceImports
      :sources="dashboard?.sourceStatus"
      :busy-kind="importBusyKind"
      @import="selectImportFile"
      @view="openSourceData"
    />

    <section class="automation-toolbar" aria-label="数据自动化设置" v-loading="automationLoading">
      <div class="automation-toolbar-status">
        <span class="live-indicator" :class="{ active: automation?.scheduler.online }" />
        <div><strong>数据自动化</strong><small>{{ automation?.scheduler.online ? "马帮调度器在线" : "马帮调度器离线" }}</small></div>
        <el-tag size="small" :type="aiStatus?.configured ? 'success' : 'info'">DeepSeek {{ aiStatus?.configured ? aiStatus.model : "未配置" }}</el-tag>
      </div>
      <div class="automation-toolbar-actions">
        <el-button :icon="Send" @click="openDingtalk()">钉钉机器人</el-button>
        <el-tooltip :content="runnableOrderTasks.length ? '自定义付款时间和订单筛选条件后立即执行' : '请先配置订单定时任务和可用的马帮账号'">
          <el-button type="primary" :icon="Play" :disabled="!runnableOrderTasks.length || !automation?.scheduler.online" @click="openImmediateExport">订单立即导出</el-button>
        </el-tooltip>
        <el-button :icon="RefreshCw" @click="openExportProgress()">导出进度</el-button>
        <el-tooltip :content="taskButtonHint('order_export')"><el-button :icon="CalendarClock" @click="openTask('order_export', taskForType('order_export'))">订单定时</el-button></el-tooltip>
        <el-tooltip :content="taskButtonHint('inventory_export')"><el-button :icon="CalendarClock" @click="openTask('inventory_export', taskForType('inventory_export'))">库存定时</el-button></el-tooltip>
        <el-tooltip :content="taskButtonHint('daily_report')"><el-button :icon="Bot" @click="openTask('daily_report', taskForType('daily_report'))">日报推送</el-button></el-tooltip>
        <el-button text :icon="RefreshCw" aria-label="刷新自动化状态" @click="loadAutomation" />
      </div>
    </section>
    <el-alert v-if="automationError" type="error" :closable="false" show-icon :title="automationError" />

    <section class="decision-filter" aria-label="销售与货盘筛选器">
      <div class="decision-filter-heading"><div><span class="panel-kicker">GLOBAL SCOPE</span><strong>经营范围</strong></div><span>{{ periodLabel }}</span></div>
      <div class="decision-filter-grid">
        <el-date-picker v-model="dateRangeFilter" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :shortcuts="dateShortcuts" clearable />
        <el-select v-model="filters.country" placeholder="全部国家" clearable><el-option v-for="item in options.countries || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.categoryL1" placeholder="一级类目" clearable filterable><el-option v-for="item in options.categoryL1 || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.categoryL2" placeholder="二级类目" clearable filterable><el-option v-for="item in options.categoryL2 || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.style" placeholder="款名" clearable filterable><el-option v-for="item in options.styles || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.store" placeholder="全部店铺" clearable filterable><el-option v-for="item in options.stores || []" :key="item" :label="item" :value="item" /></el-select>
        <div class="decision-filter-actions"><el-button @click="reset">重置</el-button><el-button type="primary" :icon="RefreshCw" :loading="loading" @click="load(false)">应用筛选</el-button></div>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-else-if="dashboard?.period?.sufficient === false" type="warning" :closable="false" show-icon title="当前订单周期不足，趋势和日均指标仅供参考。" />

    <section class="section-heading"><div><span class="panel-kicker">BUSINESS PULSE</span><h2>经营指标</h2></div><span>统一使用国家匹配后的产品包 4 档价（45%）</span></section>
    <section class="metric-grid assortment-metrics">
      <MetricCard label="我方 GMV" :value="dashboard ? money(dashboard.summary.ownAmount) : '—'" hint="订单 SKU × 商品数量 × 同国家45%标价" />
      <MetricCard
        label="货盘 GMV"
        :value="dashboard ? money(dashboard.summary.assortmentAmount) : '—'"
        :hint="dashboard ? `预测日销 × 同国家45%标价 × ${dashboard.summary.ownDataDays}个有效付款日` : '预测日销量 × 同国家45%标价 × 有效付款日期天数'"
      />
      <MetricCard label="我方占比" :value="dashboard ? percent(dashboard.summary.ownShare) : '—'" hint="我方销售额 ÷ 货盘金额" />
      <MetricCard label="GMV 缺口" :value="dashboard ? money(dashboard.summary.gapAmount) : '—'" hint="货盘 GMV - 我方 GMV" tone="warning" />
      <MetricCard label="订单量" :value="dashboard ? dashboard.summary.orderCount.toLocaleString('zh-CN') : '—'" hint="按交易编号去重" />
      <MetricCard label="客单价" :value="dashboard ? money(dashboard.summary.averageOrderValue) : '—'" hint="我方 GMV ÷ 订单量" />
    </section>

    <section class="section-heading"><div><span class="panel-kicker">MONTHLY GMV TREND</span><h2>本月与上月同期趋势</h2></div><span>趋势时间独立于经营范围，业务维度筛选保持一致</span></section>
    <el-alert v-if="monthlyTrendError" type="error" :closable="false" show-icon :title="monthlyTrendError" />
    <article class="dashboard-panel executive-trend-panel monthly-comparison-panel" v-loading="monthlyTrendLoading">
      <header>
        <div><span class="panel-kicker">MONTHLY COMPARISON</span><h3>本月与上月同期 GMV 对比</h3></div>
        <span>{{ monthlyWindow.currentLabel }} 对比 {{ monthlyWindow.previousLabel }}</span>
      </header>
      <TrendChart
        v-if="currentMonthTrend.length || previousMonthTrend.length"
        :rows="currentMonthTrend"
        :comparison-rows="previousMonthTrend"
      />
      <el-empty v-else description="当前筛选无月度趋势数据" />
    </article>

    <section class="section-heading anomaly-heading"><div><span class="panel-kicker">EXCEPTION RADAR</span><h2>异常数据</h2></div><el-segmented v-model="comparisonDays" :options="[{ label: '昨日比前日', value: 1 }, { label: '近3日比前3日', value: 3 }, { label: '近7日比前7日', value: 7 }]" @change="load" /></section>
    <section class="anomaly-controls">
      <label>店铺最低金额<el-input-number v-model="anomalyFilter.storeAmount" :min="0" :step="1000" controls-position="right" /></label>
      <label>店铺最低变动<el-input-number v-model="anomalyFilter.storeRate" :min="0" :max="1000" :step="5" controls-position="right" /><span>%</span></label>
      <label>款名最低销量<el-input-number v-model="anomalyFilter.styleQuantity" :min="0" :step="10" controls-position="right" /></label>
      <label>款名最低变动<el-input-number v-model="anomalyFilter.styleRate" :min="0" :max="1000" :step="5" controls-position="right" /><span>%</span></label>
    </section>

    <section class="anomaly-grid anomaly-analysis-grid">
      <div class="anomaly-lane">
        <article class="movement-panel decline-panel"><header><div><ArrowDownRight :size="18" /><strong>销售额下滑店铺</strong></div><span>按影响金额优先 · {{ storeDeclines.length }} 家</span></header><el-table :data="storeDeclineRows" height="360" empty-text="当前门槛下无下滑店铺"><el-table-column prop="store" label="店铺" min-width="150" show-overflow-tooltip /><el-table-column prop="country" label="国家" width="82" /><el-table-column label="本期" width="112" sortable prop="currentAmount"><template #default="scope">{{ money(scope.row.currentAmount) }}</template></el-table-column><el-table-column label="上期" width="112" sortable prop="previousAmount"><template #default="scope">{{ money(scope.row.previousAmount) }}</template></el-table-column><el-table-column label="影响金额" width="118" sortable prop="impactAmount"><template #default="scope"><strong class="decline-value">{{ money(scope.row.impactAmount) }}</strong></template></el-table-column><el-table-column label="环比" width="88" sortable prop="changeRate"><template #default="scope"><strong class="decline-value">{{ signedPercent(scope.row.changeRate) }}</strong></template></el-table-column></el-table></article>
        <ModuleAiInsight title="店铺下滑重点诊断" tone="decline" :analysis="aiAnalysis?.analysis.modules.storeDeclines" :configured="Boolean(aiStatus?.configured)" :loading="aiLoading" :error="aiError" :generated-at="aiAnalysis?.generatedAt" :cached="aiAnalysis?.cached" @refresh="analyze(true)" />
      </div>
      <div class="anomaly-lane">
        <article class="movement-panel growth-panel"><header><div><ArrowUpRight :size="18" /><strong>销售额上涨店铺</strong></div><span>按影响金额优先 · {{ storeGrowth.length }} 家</span></header><el-table :data="storeGrowthRows" height="360" empty-text="当前门槛下无上涨店铺"><el-table-column prop="store" label="店铺" min-width="150" show-overflow-tooltip /><el-table-column prop="country" label="国家" width="82" /><el-table-column label="本期" width="112" sortable prop="currentAmount"><template #default="scope">{{ money(scope.row.currentAmount) }}</template></el-table-column><el-table-column label="上期" width="112" sortable prop="previousAmount"><template #default="scope">{{ money(scope.row.previousAmount) }}</template></el-table-column><el-table-column label="影响金额" width="118" sortable prop="impactAmount"><template #default="scope"><strong class="growth-value">{{ money(scope.row.impactAmount) }}</strong></template></el-table-column><el-table-column label="环比" width="88" sortable prop="changeRate"><template #default="scope"><strong class="growth-value">{{ signedPercent(scope.row.changeRate) }}</strong></template></el-table-column></el-table></article>
        <ModuleAiInsight title="店铺增长重点诊断" tone="growth" :analysis="aiAnalysis?.analysis.modules.storeGrowth" :configured="Boolean(aiStatus?.configured)" :loading="aiLoading" :error="aiError" :generated-at="aiAnalysis?.generatedAt" :cached="aiAnalysis?.cached" @refresh="analyze(true)" />
      </div>
    </section>

    <section class="anomaly-grid anomaly-analysis-grid">
      <div class="anomaly-lane">
        <article class="movement-panel decline-panel"><header><div><ArrowDownRight :size="18" /><strong>款名销量下滑</strong></div><span>按影响销量优先 · {{ styleDeclines.length }} 个款</span></header><el-table :data="styleDeclineRows" height="360" empty-text="当前门槛下无下滑款名"><el-table-column prop="style" label="款名" min-width="160" show-overflow-tooltip /><el-table-column prop="country" label="国家" width="82" /><el-table-column prop="currentQuantity" label="本期" width="86" sortable /><el-table-column prop="previousQuantity" label="上期" width="86" sortable /><el-table-column prop="impactQuantity" label="影响销量" width="96" sortable><template #default="scope"><strong class="decline-value">{{ scope.row.impactQuantity }}</strong></template></el-table-column><el-table-column label="环比" width="88" sortable prop="changeRate"><template #default="scope"><strong class="decline-value">{{ signedPercent(scope.row.changeRate) }}</strong></template></el-table-column></el-table></article>
        <ModuleAiInsight title="款名下滑重点诊断" tone="decline" :analysis="aiAnalysis?.analysis.modules.styleDeclines" :configured="Boolean(aiStatus?.configured)" :loading="aiLoading" :error="aiError" :generated-at="aiAnalysis?.generatedAt" :cached="aiAnalysis?.cached" @refresh="analyze(true)" />
      </div>
      <div class="anomaly-lane">
        <article class="movement-panel growth-panel"><header><div><ArrowUpRight :size="18" /><strong>款名销量上涨</strong></div><span>按影响销量优先 · {{ styleGrowth.length }} 个款</span></header><el-table :data="styleGrowthRows" height="360" empty-text="当前门槛下无上涨款名"><el-table-column prop="style" label="款名" min-width="160" show-overflow-tooltip /><el-table-column prop="country" label="国家" width="82" /><el-table-column prop="currentQuantity" label="本期" width="86" sortable /><el-table-column prop="previousQuantity" label="上期" width="86" sortable /><el-table-column prop="impactQuantity" label="影响销量" width="96" sortable><template #default="scope"><strong class="growth-value">{{ scope.row.impactQuantity }}</strong></template></el-table-column><el-table-column label="环比" width="88" sortable prop="changeRate"><template #default="scope"><strong class="growth-value">{{ signedPercent(scope.row.changeRate) }}</strong></template></el-table-column></el-table></article>
        <ModuleAiInsight title="款名增长重点诊断" tone="growth" :analysis="aiAnalysis?.analysis.modules.styleGrowth" :configured="Boolean(aiStatus?.configured)" :loading="aiLoading" :error="aiError" :generated-at="aiAnalysis?.generatedAt" :cached="aiAnalysis?.cached" @refresh="analyze(true)" />
      </div>
    </section>

    <section class="section-heading"><div><span class="panel-kicker">COMMERCIAL OPPORTUNITY</span><h2>商业机会</h2></div><span>点击款名前的展开按钮查看中文商品明细</span></section>
    <section class="dashboard-panel opportunity-panel">
      <el-table :data="businessOpportunityRows" row-key="key" lazy :load="loadBusinessOpportunityChildren" :tree-props="{ children: 'children', hasChildren: 'hasChildren' }" height="620" stripe empty-text="当前筛选无商业机会">
        <el-table-column label="款名 / 商品中文名" min-width="260" fixed><template #default="scope"><strong v-if="scope.row.style && !scope.row.productName">{{ scope.row.style }}</strong><span v-else>{{ scope.row.productName }}</span></template></el-table-column>
        <el-table-column prop="country" label="国家" width="90" />
        <el-table-column prop="categoryL1" label="一级类目" min-width="130" show-overflow-tooltip />
        <el-table-column prop="categoryL2" label="二级类目" min-width="130" show-overflow-tooltip />
        <el-table-column label="货盘 GMV" width="140" align="right" sortable prop="assortmentAmount"><template #default="scope">{{ money(scope.row.assortmentAmount) }}</template></el-table-column>
        <el-table-column label="机会缺口" width="140" align="right" sortable prop="opportunityAmount"><template #default="scope"><strong class="negative-value">{{ money(scope.row.opportunityAmount) }}</strong></template></el-table-column>
        <el-table-column label="库存标价金额" width="145" align="right" sortable prop="inventoryValue"><template #default="scope">{{ money(scope.row.inventoryValue) }}</template></el-table-column>
        <el-table-column prop="assortmentDailySales" label="货盘日销" width="110" align="right" sortable />
        <el-table-column prop="ownDailySales" label="我方日销" width="110" align="right" sortable />
        <el-table-column label="日销承接" width="120" align="right" sortable prop="ownDailySalesShare"><template #default="scope"><strong :class="scope.row.ownDailySalesShare < 10 ? 'negative-value' : 'positive-value'">{{ percent(scope.row.ownDailySalesShare) }}</strong></template></el-table-column>
        <el-table-column prop="availableQuantity" label="可用库存" width="110" align="right" sortable />
      </el-table>
    </section>
    <ModuleAiInsight title="高价值商业机会" tone="opportunity" :analysis="aiAnalysis?.analysis.modules.businessOpportunities" :configured="Boolean(aiStatus?.configured)" :loading="aiLoading" :error="aiError" :generated-at="aiAnalysis?.generatedAt" :cached="aiAnalysis?.cached" @refresh="analyze(true)" />

    <section class="section-heading"><div><span class="panel-kicker">INVENTORY ACTION</span><h2>库存行动</h2></div><span>优先展示我方日销好、断货风险和新品到货</span></section>
    <section class="dashboard-panel inventory-panel">
      <el-table :data="dashboard?.inventoryInsights || []" height="520" stripe empty-text="当前没有需要处理的库存事项">
        <el-table-column label="状态" width="105"><template #default="scope"><el-tag :type="inventoryTagType(scope.row.type)" effect="light">{{ inventoryTypeLabel(scope.row.type) }}</el-tag></template></el-table-column>
        <el-table-column prop="productName" label="商品" min-width="210" show-overflow-tooltip />
        <el-table-column prop="style" label="款名" min-width="150" show-overflow-tooltip />
        <el-table-column prop="country" label="国家" width="90" />
        <el-table-column label="货盘 GMV" width="130" align="right" sortable prop="assortmentAmount"><template #default="scope">{{ money(scope.row.assortmentAmount) }}</template></el-table-column>
        <el-table-column label="我方 GMV" width="125" align="right" sortable prop="ownAmount"><template #default="scope">{{ money(scope.row.ownAmount) }}</template></el-table-column>
        <el-table-column prop="ownDailySales" label="我方日销" width="105" align="right" sortable />
        <el-table-column prop="previousAvailableQuantity" label="上次库存" width="105" align="right" sortable><template #default="scope">{{ scope.row.previousAvailableQuantity === null ? '—' : scope.row.previousAvailableQuantity }}</template></el-table-column>
        <el-table-column prop="availableQuantity" label="可用库存" width="105" align="right" sortable />
        <el-table-column prop="inventoryChange" label="库存变化" width="105" align="right" sortable><template #default="scope">{{ scope.row.inventoryChange === null ? '—' : (scope.row.inventoryChange > 0 ? '+' : '') + scope.row.inventoryChange }}</template></el-table-column>
        <el-table-column prop="inventoryChangeRate" label="变化率" width="95" align="right" sortable><template #default="scope">{{ scope.row.inventoryChangeRate === null ? '—' : signedPercent(scope.row.inventoryChangeRate) }}</template></el-table-column>
        <el-table-column prop="daysOfSupply" label="可售天数" width="105" align="right" sortable />
        <el-table-column prop="action" label="建议动作" min-width="280" show-overflow-tooltip />
      </el-table>
    </section>
    <ModuleAiInsight title="库存变化与 GMV 诊断" tone="inventory" :analysis="aiAnalysis?.analysis.modules.inventory" :configured="Boolean(aiStatus?.configured)" :loading="aiLoading" :error="aiError" :generated-at="aiAnalysis?.generatedAt" :cached="aiAnalysis?.cached" @refresh="analyze(true)" />

    <section class="section-heading"><div><span class="panel-kicker">DAILY BRIEF</span><h2>经营日报</h2></div><span>最多 10 项，支持按计划推送钉钉</span></section>
    <DailyOperationsBrief :report="dashboard?.dailyReport" :alerts="dashboard?.priorityAlerts || []" />
    <ModuleAiInsight title="经营日报总判断" tone="report" :analysis="aiAnalysis?.analysis.modules.dailyReport" :configured="Boolean(aiStatus?.configured)" :loading="aiLoading" :error="aiError" :generated-at="aiAnalysis?.generatedAt" :cached="aiAnalysis?.cached" @refresh="analyze(true)" />

    <section class="data-quality-strip">
      <AlertTriangle :size="16" />
      <span>数据准备度：订单 {{ Number(dashboard?.quality?.orderRows || 0).toLocaleString('zh-CN') }} 行 · 库存 {{ Number(dashboard?.quality?.inventoryRows || 0).toLocaleString('zh-CN') }} 行 · 产品包 {{ Number(dashboard?.quality?.productPackageRows || 0).toLocaleString('zh-CN') }} 行 · 价格覆盖 {{ percent(dashboard?.quality?.priceCoverage || 0) }}</span>
    </section>

    <el-dialog v-model="sourceDialogOpen" :title="`${importKindLabel(sourceKind)}数据源`" width="min(1180px, 96vw)" destroy-on-close>
      <el-table v-loading="sourceLoading" :data="sourceData?.rows || []" stripe height="min(62vh, 620px)" empty-text="当前还没有可查看的数据">
        <el-table-column
          v-for="column in sourceColumns"
          :key="column[0]"
          :prop="column[0]"
          :label="column[1]"
          :width="column[2]"
          show-overflow-tooltip
        />
      </el-table>
      <div class="source-pagination">
        <span>共 {{ Number(sourceData?.total || 0).toLocaleString('zh-CN') }} 行</span>
        <el-pagination
          v-if="Number(sourceData?.total || 0) > 50"
          background
          layout="prev, pager, next"
          :page-size="50"
          :current-page="sourceData?.page || 1"
          :total="sourceData?.total || 0"
          @current-change="loadSourcePage"
        />
      </div>
      <template #footer><el-button @click="sourceDialogOpen = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="importDialogOpen" :title="`${importPreview ? importKindLabel(importPreview.kind) : '数据'}导入确认`" width="min(620px, 94vw)" destroy-on-close>
      <div v-if="importPreview" class="import-preview">
        <div class="import-preview-file"><strong>{{ importPreview.filename }}</strong><span>文件已安全保存，确认后写入业务数据。</span></div>
        <div class="import-preview-metrics">
          <div><span>有效行</span><strong>{{ importPreview.rowCount.toLocaleString('zh-CN') }}</strong></div>
          <div><span>提醒</span><strong>{{ importPreview.warnings }}</strong></div>
          <div :class="{ blocked: importPreview.blockers > 0 }"><span>阻断</span><strong>{{ importPreview.blockers }}</strong></div>
        </div>
        <el-alert
          v-if="importPreview.blockers > 0"
          type="error"
          :closable="false"
          show-icon
          title="文件存在阻断问题，暂时不能写入。请修正表格后重新导入。"
        />
        <el-alert
          v-else
          type="info"
          :closable="false"
          show-icon
          :title="importPreview.kind === 'orders' ? '订单会追加到历史事实层并自动去重。' : '库存与产品包会更新当前视图，同时保留既有导入记录。'"
        />
      </div>
      <template #footer>
        <el-button @click="importDialogOpen = false">取消</el-button>
        <el-button type="primary" :disabled="Boolean(importPreview?.blockers)" :loading="importApplying" @click="confirmImport">确认导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="immediateDialogOpen" title="订单立即导出" width="min(920px, 96vw)" destroy-on-close>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="本次条件只作用于本次导出，不会覆盖定时任务设置。生成的 Excel 和订单事实仍会正常保存。"
      />
      <el-alert
        class="immediate-notification-alert"
        :type="selectedImmediateTask?.notifyEnabled && selectedImmediateTask?.dingtalkConfigId ? 'warning' : 'info'"
        :closable="false"
        show-icon
        :title="immediateNotificationText"
      />
      <el-form class="immediate-export-form" label-position="top" v-loading="immediateOptionsLoading">
        <div class="dialog-grid immediate-export-head">
          <el-form-item label="订单导出配置">
            <el-select v-model="immediateForm.taskId" filterable @change="changeImmediateTask">
              <el-option
                v-for="task in orderTasks"
                :key="task.id"
                :label="`${task.name} · ${task.accountName || task.accountUsernameMasked}`"
                :value="task.id"
                :disabled="!task.accountAvailable || !task.accountEnabled"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="付款时间">
            <el-select v-model="immediateForm.paymentDateMode">
              <el-option v-for="item in paymentDateModeOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="immediateForm.paymentDateMode === 'fixed'" label="自定义付款日期" class="dialog-grid-wide">
            <el-date-picker
              v-model="immediateForm.fixedDateRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              unlink-panels
            />
          </el-form-item>
          <el-form-item v-if="immediateForm.paymentDateMode === 'relative'" label="相对执行日" class="dialog-grid-wide">
            <div class="relative-date-fields">
              <span>从</span><el-input-number v-model="immediateForm.relativeStartDays" :min="0" :max="365" />
              <span>天前，到</span><el-input-number v-model="immediateForm.relativeEndDays" :min="0" :max="365" />
              <span>天前</span>
            </div>
          </el-form-item>
        </div>

        <section class="immediate-filter-section">
          <header>
            <div><strong>其他订单筛选</strong><span>多个条件同时满足；同一条件中的多个值按“任一值”匹配</span></div>
            <el-button :icon="Plus" :disabled="immediateForm.filters.length >= orderFields.length" @click="addImmediateFilter">添加筛选</el-button>
          </header>
          <el-empty v-if="!immediateForm.filters.length" :image-size="56" description="不添加筛选时，将导出付款时间范围内的全部订单" />
          <div v-else class="immediate-filter-list">
            <div v-for="(filter, index) in immediateForm.filters" :key="index" class="immediate-filter-row">
              <el-select v-model="filter.fieldId" filterable aria-label="筛选字段" @change="changeImmediateFilterField(filter)">
                <el-option
                  v-for="field in orderFields"
                  :key="field.id"
                  :label="`${automation?.primaryFilterIds.includes(field.id) ? '常用 · ' : ''}${field.label}`"
                  :value="field.id"
                />
              </el-select>
              <el-select v-model="filter.operator" aria-label="匹配方式">
                <el-option v-for="item in filterOperatorOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <el-select
                v-model="filter.values"
                multiple
                filterable
                allow-create
                default-first-option
                collapse-tags
                collapse-tags-tooltip
                :disabled="['empty', 'notEmpty'].includes(filter.operator)"
                placeholder="选择建议值或输入后回车"
                aria-label="筛选值"
              >
                <el-option v-for="value in filterSuggestions(filter.fieldId)" :key="value" :label="value" :value="value" />
              </el-select>
              <el-button text type="danger" :icon="Trash2" aria-label="移除筛选条件" @click="removeImmediateFilter(index)" />
            </div>
          </div>
        </section>
      </el-form>
      <template #footer>
        <el-button @click="immediateDialogOpen = false">取消</el-button>
        <el-button
          type="primary"
          :icon="Play"
          :loading="immediateRunning"
          :disabled="!automation?.scheduler.online"
          @click="executeImmediateOrderExport"
        >立即执行</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="progressDialogOpen"
      title="订单导出进度"
      width="min(1080px, 96vw)"
      destroy-on-close
      @closed="stopExportProgressPolling"
    >
      <div class="export-progress-toolbar">
        <span>展示最近 30 条订单导出；运行中的记录每 2 秒自动刷新。</span>
        <el-button :icon="RefreshCw" :loading="progressLoading" @click="refreshExportProgress()">刷新</el-button>
      </div>

      <el-table
        :data="orderRuns"
        height="248"
        highlight-current-row
        empty-text="暂无订单导出记录"
        @row-click="selectExportRun"
      >
        <el-table-column label="提交时间" width="174">
          <template #default="{ row }">{{ formatRunDateTime(row.scheduledRunAt) }}</template>
        </el-table-column>
        <el-table-column label="执行方式" width="94">
          <template #default="{ row }">{{ triggerTypeLabel(row.triggerType) }}</template>
        </el-table-column>
        <el-table-column label="付款时间" min-width="196">
          <template #default="{ row }">{{ paymentRangeLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="94">
          <template #default="{ row }"><el-tag size="small" :type="runStatusType(row.status)">{{ runStatusLabel(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="导出明细" width="92" align="right">
          <template #default="{ row }">{{ row.detailRowCount || 0 }} 行</template>
        </el-table-column>
        <el-table-column label="钉钉" width="112">
          <template #default="{ row }">{{ notificationStatusLabel(row.notificationStatus) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="128" fixed="right">
          <template #default="{ row }">
            <el-button text @click.stop="selectExportRun(row)">查看</el-button>
            <el-button text type="primary" :icon="Download" :disabled="!row.exportFileId" @click.stop="downloadExportRun(row)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>

      <section v-if="progressRun" class="export-progress-detail" v-loading="progressLoading">
        <header>
          <div><span>{{ triggerTypeLabel(progressRun.triggerType) }} · {{ formatRunDateTime(progressRun.scheduledRunAt) }}</span><strong>{{ progressRun.taskName }}</strong></div>
          <div class="export-progress-detail-actions">
            <el-tag :type="runStatusType(progressRun.status)">{{ runStatusLabel(progressRun.status) }}</el-tag>
            <el-button v-if="progressRun.exportFileId" type="primary" plain :icon="Download" @click="downloadExportRun(progressRun)">下载 Excel</el-button>
          </div>
        </header>
        <el-progress :percentage="exportProgressPercent" :status="exportProgressBarStatus" :stroke-width="10" />
        <div class="export-progress-facts">
          <div><span>付款时间</span><strong>{{ paymentRangeLabel(progressRun) }}</strong></div>
          <div><span>订单数量</span><strong>{{ progressRun.filteredOrderCount || 0 }} 单 / {{ progressRun.detailRowCount || 0 }} 行</strong></div>
          <div><span>订单数据库</span><strong>{{ persistenceStatusLabel(progressRun) }}</strong></div>
          <div><span>钉钉通知</span><strong>{{ notificationStatusLabel(progressRun.notificationStatus) }}</strong></div>
          <div class="export-progress-fact-wide"><span>导出文件</span><strong>{{ progressRun.filename || "等待生成" }}</strong></div>
        </div>
        <el-alert
          v-if="progressRun.errorMessage"
          type="error"
          :closable="false"
          show-icon
          :title="progressRun.errorMessage"
        />
        <el-table :data="progressRun.events" max-height="260" size="small" empty-text="任务尚在排队，暂无阶段记录">
          <el-table-column label="执行阶段" min-width="150"><template #default="{ row }"><strong>{{ runStageLabel(row.stage) }}</strong></template></el-table-column>
          <el-table-column label="状态" width="96"><template #default="{ row }"><el-tag size="small" :type="eventStatusType(row.status)">{{ runStatusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column prop="message" label="详情" min-width="280" show-overflow-tooltip />
          <el-table-column label="时间" width="174"><template #default="{ row }">{{ formatRunDateTime(row.finishedAt || row.startedAt) }}</template></el-table-column>
        </el-table>
      </section>
      <el-empty v-else :image-size="72" description="暂无可查询的订单导出进度" />
    </el-dialog>

    <el-dialog v-model="taskDialogOpen" :title="editingTask ? '编辑自动化任务' : '新建自动化任务'" width="min(680px, 94vw)">
      <el-form label-position="top">
        <div class="dialog-grid"><el-form-item label="任务类型"><el-segmented v-model="taskForm.taskType" :options="[{ label: '订单', value: 'order_export' }, { label: '库存', value: 'inventory_export' }, { label: '经营日报', value: 'daily_report' }]" :disabled="Boolean(editingTask)" /></el-form-item><el-form-item label="任务名称"><el-input v-model="taskForm.name" /></el-form-item><el-form-item label="马帮账号"><el-select v-model="taskForm.accountProfileId" filterable><el-option v-for="account in automation?.accounts || []" :key="account.id" :label="`${account.name} · ${account.usernameMasked}`" :value="account.id" :disabled="!account.enabled || !account.passwordConfigured" /></el-select></el-form-item><el-form-item label="每日执行时间"><el-time-picker v-model="taskForm.time" format="HH:mm" value-format="HH:mm" /></el-form-item><el-form-item v-if="taskForm.taskType === 'order_export'" label="订单付款时间"><el-select v-model="taskForm.paymentDateMode"><el-option label="昨天" value="yesterday" /><el-option label="当天" value="today" /></el-select></el-form-item><el-form-item label="钉钉机器人"><el-select v-model="taskForm.dingtalkConfigId" clearable :placeholder="taskForm.taskType === 'daily_report' ? '日报推送必须选择' : '不通知'"><el-option v-for="config in automation?.dingtalkConfigs || []" :key="config.id" :label="config.name" :value="config.id" :disabled="!config.enabled" /></el-select></el-form-item></div>
        <div class="switch-row"><el-switch v-model="taskForm.notifyEnabled" active-text="发送钉钉通知" /><el-switch v-model="taskForm.enabled" active-text="创建后启用" /></div>
      </el-form>
      <template #footer><el-button v-if="editingTask" :icon="Play" @click="runTask(editingTask)">立即运行</el-button><el-button @click="taskDialogOpen = false">取消</el-button><el-button type="primary" :loading="taskSaving" @click="saveTask">保存任务</el-button></template>
    </el-dialog>

    <el-dialog v-model="dingtalkDialogOpen" :title="editingDingtalk ? '编辑钉钉机器人' : '钉钉机器人'" width="min(760px, 94vw)">
      <div v-if="!editingDingtalk && automation?.dingtalkConfigs.length" class="robot-list"><article v-for="config in automation.dingtalkConfigs" :key="config.id"><div><strong>{{ config.name }}</strong><span>{{ config.enabled ? '启用' : '停用' }} · Webhook {{ config.webhookConfigured ? '已配置' : '未配置' }}</span></div><div><el-button text :icon="Send" @click="testRobot(config)">测试</el-button><el-button text @click="openDingtalk(config)">编辑</el-button><el-button text type="danger" :icon="Trash2" @click="removeRobot(config)">删除</el-button></div></article></div>
      <el-divider v-if="!editingDingtalk && automation?.dingtalkConfigs.length">新增机器人</el-divider>
      <el-form label-position="top"><div class="dialog-grid"><el-form-item label="名称"><el-input v-model="dingtalkForm.name" placeholder="运营通知机器人" /></el-form-item><el-form-item label="提醒手机号"><el-input v-model="dingtalkForm.atMobiles" placeholder="多个手机号用逗号分隔" /></el-form-item><el-form-item label="Webhook" class="dialog-grid-wide"><el-input v-model="dingtalkForm.webhookUrl" :placeholder="editingDingtalk?.webhookConfigured ? '已配置；留空保持不变' : 'https://oapi.dingtalk.com/robot/send?...'" /></el-form-item><el-form-item label="加签密钥" class="dialog-grid-wide"><el-input v-model="dingtalkForm.secret" type="password" show-password :placeholder="editingDingtalk?.secretConfigured ? '已配置；留空保持不变' : 'SEC...'" /></el-form-item></div><div class="switch-row robot-switches"><el-switch v-model="dingtalkForm.enabled" active-text="启用" /><el-switch v-model="dingtalkForm.notifyOnSuccess" active-text="成功通知" /><el-switch v-model="dingtalkForm.notifyOnFailure" active-text="失败通知" /><el-switch v-model="dingtalkForm.notifyOnEmpty" active-text="空数据通知" /><el-switch v-model="dingtalkForm.atAll" active-text="@所有人" /></div></el-form>
      <template #footer><el-button v-if="editingDingtalk" @click="openDingtalk(null)">返回列表</el-button><el-button @click="dingtalkDialogOpen = false">关闭</el-button><el-button type="primary" :icon="Plus" :loading="dingtalkSaving" @click="saveRobot">保存机器人</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.assortment-page { display: grid; gap: 16px; color: var(--ops-text-primary); }
.manual-import-input { position: fixed; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; }
.automation-toolbar,.decision-filter,.anomaly-controls,.movement-panel,.data-quality-strip { border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.automation-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 14px; }
.automation-toolbar-status { display: flex; align-items: center; gap: 10px; min-width: 0; }.automation-toolbar-status > div { display: grid; gap: 2px; }.automation-toolbar-status strong { font-size: 13px; }.automation-toolbar-status small { color: var(--ops-text-secondary); font-size: 11px; }.automation-toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.decision-filter { padding: 14px; }.decision-filter-heading,.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; }.decision-filter-heading { margin-bottom: 12px; }.decision-filter-heading > div { display: grid; gap: 2px; }.decision-filter-heading > span,.section-heading > span { color: var(--ops-text-secondary); font-size: 11px; }.decision-filter-grid { display: grid; grid-template-columns: minmax(260px,1.45fr) repeat(5,minmax(120px,1fr)) auto; gap: 8px; }.decision-filter-grid :deep(.el-select),.decision-filter-grid :deep(.el-date-editor) { width: 100%; }.decision-filter-actions { display: flex; gap: 8px; }
.section-heading { margin-top: 8px; }.section-heading > div { display: grid; gap: 2px; }.section-heading h2 { margin: 0; font-size: 17px; line-height: 1.3; letter-spacing: 0; }.panel-kicker { color: #087f5b; font-size: 10px; font-weight: 800; letter-spacing: .08em; }
.executive-trend-panel { min-width: 0; min-height: 440px; }.executive-trend-panel > header { margin-bottom: 8px; }.monthly-comparison-panel { width: 100%; }.monthly-comparison-panel .trend-chart { min-height: 370px; }
.anomaly-heading { align-items: center; }.anomaly-controls { display: flex; flex-wrap: wrap; gap: 16px; padding: 10px 14px; }.anomaly-controls label { display: flex; align-items: center; gap: 7px; color: var(--ops-text-secondary); font-size: 11px; }.anomaly-controls :deep(.el-input-number) { width: 120px; }
.anomaly-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; }.anomaly-analysis-grid { align-items: stretch; }.anomaly-lane { display: grid; grid-template-rows: auto 1fr; gap: 14px; min-width: 0; }.anomaly-lane :deep(.module-ai) { box-sizing: border-box; height: 100%; }.movement-panel { min-width: 0; overflow: hidden; }.movement-panel > header { display: flex; align-items: center; justify-content: space-between; min-height: 50px; padding: 0 14px; border-bottom: 1px solid var(--ops-border-light); }.movement-panel > header div { display: flex; align-items: center; gap: 8px; }.movement-panel > header strong { font-size: 13px; }.movement-panel > header span { color: var(--ops-text-secondary); font-size: 11px; }.movement-panel :deep(.el-table) { font-size: 12px; }.decline-panel > header { color: #087f5b; background: #f3fbf7; }.growth-panel > header { color: #c73545; background: #fff7f7; }
.decline-value { color: #087f5b; }.growth-value { color: #d9485f; }.negative-value { color: #d9485f; }.positive-value { color: #087f5b; }.opportunity-panel,.inventory-panel { overflow: hidden; }.opportunity-panel :deep(.el-table__expand-icon) { color: #2563eb; }.inventory-panel :deep(.el-tag) { min-width: 68px; justify-content: center; }
.data-quality-strip { display: flex; align-items: center; gap: 8px; padding: 10px 14px; color: var(--ops-text-secondary); font-size: 11px; }
.import-preview { display: grid; gap: 14px; }.import-preview-file { display: grid; gap: 4px; }.import-preview-file span { color: var(--ops-text-secondary); font-size: 11px; }.import-preview-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; }.import-preview-metrics > div { display: grid; gap: 4px; padding: 12px; border: 1px solid var(--ops-border-light); border-radius: 6px; background: var(--ops-surface-subtle); }.import-preview-metrics span { color: var(--ops-text-secondary); font-size: 10px; }.import-preview-metrics strong { font-size: 20px; }.import-preview-metrics .blocked strong { color: var(--el-color-danger); }
.immediate-notification-alert { margin-top: 8px; }.immediate-export-form { margin-top: 18px; }.immediate-export-head { padding-bottom: 2px; }.relative-date-fields { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.relative-date-fields span { color: var(--ops-text-secondary); font-size: 12px; }.immediate-filter-section { overflow: hidden; border: 1px solid var(--ops-border-light); border-radius: 8px; }.immediate-filter-section > header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 12px; background: var(--ops-surface-subtle); border-bottom: 1px solid var(--ops-border-light); }.immediate-filter-section > header > div { display: grid; gap: 3px; }.immediate-filter-section > header span { color: var(--ops-text-secondary); font-size: 10px; }.immediate-filter-list { display: grid; gap: 8px; padding: 12px; }.immediate-filter-row { display: grid; grid-template-columns: minmax(170px,.8fr) minmax(150px,.65fr) minmax(260px,1.4fr) 36px; gap: 8px; align-items: start; }.immediate-filter-row :deep(.el-select) { width: 100%; }
.export-progress-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }.export-progress-toolbar span { color: var(--ops-text-secondary); font-size: 11px; }.export-progress-detail { display: grid; gap: 14px; margin-top: 16px; padding: 14px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface-subtle); }.export-progress-detail > header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.export-progress-detail > header > div:first-child { display: grid; gap: 3px; }.export-progress-detail > header span { color: var(--ops-text-secondary); font-size: 10px; }.export-progress-detail > header strong { font-size: 14px; }.export-progress-detail-actions { display: flex; align-items: center; gap: 8px; }.export-progress-facts { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; }.export-progress-facts > div { display: grid; gap: 4px; min-width: 0; padding: 10px; border: 1px solid var(--ops-border-light); border-radius: 6px; background: var(--ops-surface); }.export-progress-facts span { color: var(--ops-text-secondary); font-size: 10px; }.export-progress-facts strong { overflow-wrap: anywhere; font-size: 12px; }.export-progress-fact-wide { grid-column: 1 / -1; }
.source-pagination { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-top: 12px; color: var(--ops-text-secondary); font-size: 11px; }
.dialog-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 0 16px; }.dialog-grid-wide { grid-column: 1 / -1; }.dialog-grid :deep(.el-select),.dialog-grid :deep(.el-date-editor) { width: 100%; }.switch-row { display: flex; flex-wrap: wrap; gap: 18px; }.robot-list { display: grid; gap: 8px; }.robot-list article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 12px; border: 1px solid var(--ops-border-light); border-radius: 8px; }.robot-list article > div:first-child { display: grid; gap: 4px; }.robot-list span { color: var(--ops-text-secondary); font-size: 10px; }
@media (max-width: 1380px) { .decision-filter-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }.decision-filter-actions { justify-content: flex-end; }.assortment-metrics { grid-template-columns: repeat(3,minmax(0,1fr)); } }
@media (max-width: 960px) { .anomaly-grid { grid-template-columns: 1fr; }.assortment-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }.monthly-comparison-panel > header { align-items: flex-start; flex-direction: column; gap: 4px; }.monthly-comparison-panel .trend-chart { min-height: 420px; } }
@media (max-width: 760px) { .automation-toolbar { align-items: flex-start; flex-direction: column; }.automation-toolbar-actions { width: 100%; justify-content: flex-start; }.decision-filter-grid { grid-template-columns: 1fr; }.decision-filter-heading,.section-heading { align-items: flex-start; flex-direction: column; }.dialog-grid { grid-template-columns: 1fr; }.dialog-grid-wide { grid-column: auto; }.immediate-filter-row { grid-template-columns: 1fr; }.immediate-filter-section > header,.export-progress-detail > header,.export-progress-toolbar { align-items: flex-start; flex-direction: column; }.export-progress-facts { grid-template-columns: repeat(2,minmax(0,1fr)); }.export-progress-fact-wide { grid-column: 1 / -1; } }
@media (max-width: 520px) { .automation-toolbar-status { flex-wrap: wrap; }.robot-list article { align-items: flex-start; flex-direction: column; }.assortment-metrics { grid-template-columns: 1fr; } }
</style>
