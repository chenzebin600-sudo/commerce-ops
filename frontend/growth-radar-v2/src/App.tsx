import { useEffect, useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import {
  Alert,
  Badge,
  Button,
  ConfigProvider,
  DatePicker,
  Drawer,
  Empty,
  Input,
  Modal,
  Progress,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  message,
  theme,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { EChartsOption } from "echarts";
import {
  ArrowRight,
  BellRing,
  Blocks,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  DatabaseZap,
  Flame,
  Globe2,
  Layers3,
  Menu,
  PackageCheck,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Store,
  Target,
  TrendingUp,
} from "lucide-react";
import { EChart } from "./components/EChart";
import { MetricCard } from "./components/MetricCard";
import { Sidebar } from "./components/Sidebar";
import { TaskRail } from "./components/TaskRail";
import {
  assistantWorkspaceDataFromApi,
  GrowthRadarApiError,
  loadMabangSyncOverview,
  loadAssistantTaskDetail,
  loadAssistantTasks,
  countryMappingsFromApi,
  loadAssistantConfiguration,
  loadAssistantWorkspace,
  readinessItemsFromApi,
  readinessTasksFromItems,
  runMabangSyncTask,
  saveMabangDailySyncTask,
  setMabangSyncTaskEnabled,
  shopMappingsFromApi,
  updateAssistantTaskStatus,
} from "./api";
import type {
  AssistantDataSourceStatus,
  MabangScheduledTask,
  MabangSyncOverview,
  MabangSyncTaskType,
} from "./api";
import {
  countryMappings as initialCountryMappings,
  demoTasks,
  metrics,
  opportunityCells,
  products,
  readinessItems,
  shopMappings as initialShopMappings,
  stores,
  trendSeries,
} from "./fixtures";
import type {
  CountryCode,
  CountryMappingRow,
  DataMode,
  DirectionCode,
  OperationTask,
  ProductInsight,
  ReadinessItem,
  ShopMappingRow,
  StoreState,
  StoreSummary,
  TaskPriority,
  TaskEvent,
  TaskStatus,
  TrendState,
} from "./types";

const countryOrder: CountryCode[] = ["TH", "PH", "ID", "VN", "MY"];
const categories = ["太阳能", "家居", "工具", "灯具", "汽车用品"];

const countryOptions = [
  { value: "ALL", label: "全部国家" },
  { value: "TH", label: "泰国" },
  { value: "PH", label: "菲律宾" },
  { value: "ID", label: "印尼" },
  { value: "VN", label: "越南" },
  { value: "MY", label: "马来西亚" },
];

const managerOptions = [
  { value: "ALL", label: "全部店长" },
  { value: "张敏", label: "张敏" },
  { value: "李桐", label: "李桐" },
  { value: "王澄", label: "王澄" },
  { value: "赵岚", label: "赵岚" },
];

const platformLabels = {
  SHOPEE: "Shopee",
  LAZADA: "Lazada",
  TIKTOK: "TikTok",
  UNMAPPED: "待映射",
} as const;

const priorityLabels: Record<TaskPriority, string> = {
  P0: "立即处理",
  P1: "高优先",
  P2: "计划处理",
  P3: "观察",
};

const statusLabels: Record<TaskStatus, string> = {
  NEW: "待确认",
  ACKNOWLEDGED: "已接收",
  IN_PROGRESS: "处理中",
  MONITORING: "观察中",
  RESOLVED: "已解决",
  BLOCKED: "已阻塞",
  DISMISSED: "已忽略",
  REOPENED: "已重开",
};

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  NEW: ["ACKNOWLEDGED", "BLOCKED", "DISMISSED"],
  ACKNOWLEDGED: ["IN_PROGRESS", "BLOCKED", "DISMISSED"],
  IN_PROGRESS: ["MONITORING", "BLOCKED"],
  MONITORING: ["RESOLVED", "BLOCKED"],
  BLOCKED: ["IN_PROGRESS", "DISMISSED"],
  RESOLVED: ["REOPENED"],
  DISMISSED: ["REOPENED"],
  REOPENED: ["ACKNOWLEDGED", "IN_PROGRESS"],
};

const taskReasonOptions: Partial<Record<TaskStatus, Array<{ value: string; label: string }>>> = {
  BLOCKED: [
    { value: "WAITING_STORE_CONFIRMATION", label: "等待店铺核查" },
    { value: "DATA_OR_PERMISSION_BLOCKED", label: "数据或权限阻断" },
    { value: "OTHER_BLOCKED", label: "其他阻断" },
  ],
  RESOLVED: [
    { value: "ACTION_COMPLETED", label: "动作已完成" },
    { value: "RISK_CLEARED", label: "风险已解除" },
    { value: "NO_ACTION_REQUIRED", label: "核查后无需动作" },
  ],
  DISMISSED: [
    { value: "NOT_RELEVANT", label: "当前不适用" },
    { value: "DUPLICATE", label: "重复任务" },
    { value: "OUT_OF_SCOPE", label: "不在负责范围" },
  ],
};

const taskEventLabels: Record<string, string> = {
  CREATED: "任务生成",
  ASSIGNED: "负责人调整",
  ACKNOWLEDGED: "任务已接收",
  STARTED: "开始处理",
  MONITORING_STARTED: "进入观察",
  BLOCKED: "标记阻塞",
  RESOLVED: "任务解决",
  DISMISSED: "任务忽略",
  REOPENED: "任务重开",
  SIGNAL_REFRESHED: "证据刷新",
  NOT_HIT_IN_LATEST_RUN: "本次分析未再命中",
  SCHEDULED: "复核时间调整",
};

const storeStateMeta: Record<
  StoreState,
  { label: string; color: string; description: string }
> = {
  ACTION_REQUIRED: {
    label: "需处理",
    color: "red",
    description: "存在 P0 / P1 活动任务",
  },
  WATCH: {
    label: "观察",
    color: "orange",
    description: "仅有 P2 / P3 或趋势证据不足",
  },
  STABLE: {
    label: "稳定",
    color: "green",
    description: "无活动高优先任务",
  },
  BLOCKED: {
    label: "阻塞",
    color: "default",
    description: "配置或数据质量不完整",
  },
};

const directionMeta: Record<
  DirectionCode,
  { label: string; action: string; color: string }
> = {
  PRIORITY_GROWTH: {
    label: "优先增长",
    action: "优先跟进",
    color: "#d64545",
  },
  QUIET_ENTRY: {
    label: "蓝海候选",
    action: "核查后低风险测试",
    color: "#2563eb",
  },
  DEFEND_WINNER: {
    label: "守住优势",
    action: "持续经营",
    color: "#14945f",
  },
  SUPPLY_CONSTRAINED: {
    label: "供给受限",
    action: "补货后发力",
    color: "#d98516",
  },
  CROSS_COUNTRY_CANDIDATE: {
    label: "跨国候选",
    action: "核查后测试",
    color: "#7c5ac7",
  },
};

const viewMeta: Record<string, { title: string; description: string }> = {
  today: {
    title: "今日作战台",
    description: "先处理最重要的运营任务，再查看分析证据。",
  },
  stores: {
    title: "我的店铺战场",
    description: "用一张可排序列表管理多国家、多平台店铺。",
  },
  gaps: {
    title: "店铺缺口诊断",
    description: "回答每家店正在错过哪些已验证货盘。",
  },
  map: {
    title: "货盘机会地图",
    description: "从国家 × 类目切入，定位值得投入的方向。",
  },
  products: {
    title: "产品雷达",
    description: "识别明星、增长、衰退、蓝海与跨国候选产品。",
  },
  comparison: {
    title: "货盘验证 vs 我方承接",
    description: "比较来源预测表现和我方有效订单销量，不冒充市场份额。",
  },
  tasks: {
    title: "全部任务",
    description: "管理任务接收、处理、观察、解决与阻塞生命周期。",
  },
  monitoring: {
    title: "我的观察项",
    description: "跟进已采取动作、等待数据反馈的任务。",
  },
  resolved: {
    title: "已完成任务",
    description: "保留已解决和已忽略任务的证据轨迹。",
  },
  settings: {
    title: "数据准备与映射",
    description: "维护仓库国家、店铺与店长归属，未确认配置不参与分析。",
  },
};

const metricIcons = [BellRing, Store, TrendingUp, DatabaseZap];

function formatNumber(value: number | null) {
  if (value === null) return "数据不足";
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatPercent(value: number | null, digits = 1) {
  if (value === null) return "数据不足";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "尚无记录";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : String(value);
}

function dailyScheduleLabel(task: MabangScheduledTask) {
  const hour = String(task.scheduleConfig.hour ?? 0).padStart(2, "0");
  const minute = String(task.scheduleConfig.minute ?? 0).padStart(2, "0");
  return task.scheduleType === "daily"
    ? `每天 ${hour}:${minute}`
    : `${task.scheduleType} · ${hour}:${minute}`;
}

function sourceFreshness(source: AssistantDataSourceStatus) {
  const timestamp = source.latestBatch?.collectedAt || source.latestBatch?.importedAt;
  if (!timestamp) return { label: "尚未入库", color: "default" };
  const ageHours = dayjs().diff(dayjs(timestamp), "hour");
  if (ageHours <= 36) return { label: "最新", color: "success" };
  if (ageHours <= 72) return { label: "待更新", color: "warning" };
  return { label: "已过期", color: "error" };
}

function trendLabel(state: TrendState) {
  switch (state) {
    case "GROWING":
      return "增长";
    case "DECLINING":
      return "下滑";
    case "NEWLY_SELLING":
      return "新近产生销售";
    case "INSUFFICIENT_HISTORY":
      return "数据不足";
    default:
      return "稳定";
  }
}

function readinessPercent(item: ReadinessItem) {
  if (item.target <= 0) return item.state === "READY" ? 100 : 0;
  return Math.min(100, Math.round((item.current / item.target) * 100));
}

function viewFromMetric(targetView: string) {
  const aliases: Record<string, string> = {
    configuration: "settings",
  };
  const view = aliases[targetView] || targetView;
  return viewMeta[view] ? view : "today";
}

function requestKey(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export interface GrowthRadarAppProps {
  embedded?: boolean;
  initialView?: string;
  onViewChange?: (view: string) => void;
  popupContainer?: HTMLElement;
}

const embeddedViews = [
  ["today", "今日作战台"],
  ["stores", "店铺战场"],
  ["gaps", "缺口诊断"],
  ["map", "机会地图"],
  ["products", "产品雷达"],
  ["comparison", "货盘 vs 我方"],
  ["tasks", "运营任务"],
  ["settings", "数据配置"],
] as const;

export default function App({
  embedded = false,
  initialView = "today",
  onViewChange,
  popupContainer,
}: GrowthRadarAppProps = {}) {
  const [activeView, setActiveView] = useState(viewFromMetric(initialView));
  const [dataMode, setDataMode] = useState<DataMode>(embedded ? "READINESS" : "DEMO");
  const [analysisDate, setAnalysisDate] = useState<Dayjs>(dayjs("2026-07-27"));
  const [country, setCountry] = useState("ALL");
  const [manager, setManager] = useState("ALL");
  const [platform, setPlatform] = useState("ALL");
  const [selectedCategory, setSelectedCategory] = useState("ALL");
  const [productSegment, setProductSegment] = useState("ALL");
  const [tasks, setTasks] = useState(demoTasks);
  const [selectedTask, setSelectedTask] = useState<OperationTask | null>(null);
  const [selectedTaskEvents, setSelectedTaskEvents] = useState<TaskEvent[]>([]);
  const [taskAction, setTaskAction] = useState<{
    task: OperationTask;
    status: TaskStatus;
  } | null>(null);
  const [taskActionReason, setTaskActionReason] = useState<string>();
  const [taskActionNote, setTaskActionNote] = useState("");
  const [taskActionReviewAt, setTaskActionReviewAt] = useState<Dayjs | null>(null);
  const [taskActionSaving, setTaskActionSaving] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductInsight | null>(null);
  const [selectedStore, setSelectedStore] = useState<StoreSummary | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [countryMappings, setCountryMappings] =
    useState<CountryMappingRow[]>(initialCountryMappings);
  const [shopMappings, setShopMappings] =
    useState<ShopMappingRow[]>(initialShopMappings);
  const [liveCountryMappings, setLiveCountryMappings] =
    useState<CountryMappingRow[]>([]);
  const [liveShopMappings, setLiveShopMappings] =
    useState<ShopMappingRow[]>([]);
  const [shopMappingSearch, setShopMappingSearch] = useState("");
  const [configurationSource, setConfigurationSource] =
    useState<"LOADING" | "API" | "AUDIT_SNAPSHOT">("LOADING");
  const [configurationWriteGate, setConfigurationWriteGate] = useState({
    enabled: false,
    reasons: ["FORMAL_CONFIGURATION_WRITE_NOT_APPROVED"],
  });
  const [dataSources, setDataSources] =
    useState<AssistantDataSourceStatus[]>([]);
  const [mabangSync, setMabangSync] =
    useState<MabangSyncOverview | null>(null);
  const [mabangSyncState, setMabangSyncState] =
    useState<"LOADING" | "READY" | "UNAVAILABLE">("LOADING");
  const [mabangSyncError, setMabangSyncError] = useState("");
  const [syncActionId, setSyncActionId] = useState<string | null>(null);
  const [syncEditorSaving, setSyncEditorSaving] = useState(false);
  const [syncEditor, setSyncEditor] = useState<{
    task: MabangScheduledTask | null;
    taskType: MabangSyncTaskType;
    name: string;
    accountProfileId: string;
    time: Dayjs;
    paymentDateMode: string;
    enabled: boolean;
  } | null>(null);
  const [liveReadinessItems, setLiveReadinessItems] =
    useState<ReadinessItem[]>(readinessItems);
  const [readinessSource, setReadinessSource] =
    useState<"LOADING" | "API" | "AUDIT_SNAPSHOT">("LOADING");
  const [publishedTaskCount, setPublishedTaskCount] = useState(0);
  const [workspacePublishable, setWorkspacePublishable] = useState(false);
  const [taskPersistenceReady, setTaskPersistenceReady] = useState(false);
  const [liveTasks, setLiveTasks] = useState<OperationTask[]>([]);
  const [liveStores, setLiveStores] = useState<StoreSummary[]>([]);
  const [liveProducts, setLiveProducts] = useState<ProductInsight[]>([]);
  const [liveOpportunityCells, setLiveOpportunityCells] = useState(
    [] as typeof opportunityCells,
  );
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    setActiveView(viewFromMetric(initialView));
  }, [initialView]);

  useEffect(() => {
    const controller = new AbortController();
    loadAssistantWorkspace(controller.signal)
      .then(async (workspace) => {
        const data = assistantWorkspaceDataFromApi(workspace);
        setLiveReadinessItems(readinessItemsFromApi(workspace.readiness));
        setPublishedTaskCount(workspace.summary.publishedTaskCount || 0);
        setWorkspacePublishable(workspace.publishable);
        setTaskPersistenceReady(workspace.taskPersistenceReady);
        if (workspace.taskPersistenceReady) {
          try {
            setLiveTasks(await loadAssistantTasks(controller.signal));
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            setLiveTasks(data.tasks);
          }
        } else {
          setLiveTasks(data.tasks);
        }
        setLiveStores(data.stores);
        setLiveProducts(data.products);
        setLiveOpportunityCells(data.opportunityCells);
        setReadinessSource("API");
        if (workspace.readiness.historyEnd) {
          setAnalysisDate(dayjs(workspace.readiness.historyEnd));
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setReadinessSource("AUDIT_SNAPSHOT");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadAssistantConfiguration(controller.signal)
      .then((configuration) => {
        setLiveCountryMappings(countryMappingsFromApi(configuration.countryMappings));
        setLiveShopMappings(shopMappingsFromApi(configuration.shopMappings));
        setDataSources(configuration.dataSources || []);
        setConfigurationWriteGate({
          enabled: configuration.writeGate.enabled,
          reasons: configuration.writeGate.reasons,
        });
        setConfigurationSource("API");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setConfigurationSource("AUDIT_SNAPSHOT");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadMabangSyncOverview(controller.signal)
      .then((overview) => {
        setMabangSync(overview);
        setMabangSyncState("READY");
        setMabangSyncError("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMabangSyncState("UNAVAILABLE");
        setMabangSyncError(
          error instanceof Error ? error.message : "马帮定时同步状态读取失败。",
        );
      });
    return () => controller.abort();
  }, []);

  async function refreshMabangSync() {
    setMabangSyncState("LOADING");
    try {
      const overview = await loadMabangSyncOverview();
      setMabangSync(overview);
      setMabangSyncState("READY");
      setMabangSyncError("");
    } catch (error) {
      setMabangSyncState("UNAVAILABLE");
      setMabangSyncError(
        error instanceof Error ? error.message : "马帮定时同步状态读取失败。",
      );
    }
  }

  function openSyncEditor(
    taskType: MabangSyncTaskType,
    task: MabangScheduledTask | null = null,
  ) {
    const firstEnabledAccount = mabangSync?.accounts.find((account) => account.enabled);
    const hour = task?.scheduleConfig.hour ?? (taskType === "order_export" ? 7 : 8);
    const minute = task?.scheduleConfig.minute ?? 0;
    setSyncEditor({
      task,
      taskType,
      name: task?.name || (taskType === "order_export"
        ? "超级店长助手 · 每日订单"
        : "超级店长助手 · 每日库存"),
      accountProfileId: task?.accountProfileId || firstEnabledAccount?.id || "",
      time: dayjs().hour(hour).minute(minute).second(0),
      paymentDateMode: task?.paymentDateMode || "yesterday",
      enabled: task?.enabled ?? true,
    });
  }

  async function confirmSyncEditor() {
    if (!syncEditor) return;
    if (!syncEditor.name.trim() || !syncEditor.accountProfileId) {
      messageApi.warning("请填写任务名称并选择可用的马帮账号。");
      return;
    }
    setSyncEditorSaving(true);
    try {
      await saveMabangDailySyncTask({
        ...syncEditor,
        name: syncEditor.name.trim(),
        hour: syncEditor.time.hour(),
        minute: syncEditor.time.minute(),
      });
      messageApi.success(syncEditor.task ? "定时同步任务已更新。" : "每日同步任务已创建。");
      setSyncEditor(null);
      await refreshMabangSync();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "定时同步任务保存失败。");
    } finally {
      setSyncEditorSaving(false);
    }
  }

  async function toggleSyncTask(task: MabangScheduledTask) {
    setSyncActionId(task.id);
    try {
      await setMabangSyncTaskEnabled(task.id, !task.enabled);
      messageApi.success(task.enabled ? "定时同步已停用。" : "定时同步已启用。");
      await refreshMabangSync();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "任务状态更新失败。");
    } finally {
      setSyncActionId(null);
    }
  }

  async function runSyncTask(task: MabangScheduledTask) {
    setSyncActionId(task.id);
    try {
      const result = await runMabangSyncTask(task.id);
      messageApi.success(`任务已进入后台队列：${result.runId.slice(0, 8)}`);
      await refreshMabangSync();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "任务提交失败。");
    } finally {
      setSyncActionId(null);
    }
  }

  const liveReadinessTasks = useMemo(
    () => readinessTasksFromItems(liveReadinessItems),
    [liveReadinessItems],
  );
  const currentTasks = dataMode === "DEMO"
    ? tasks
    : workspacePublishable
      ? liveTasks
      : liveReadinessTasks;
  const currentStores = dataMode === "DEMO" ? stores : liveStores;
  const currentProducts = dataMode === "DEMO" ? products : liveProducts;
  const currentOpportunityCells = dataMode === "DEMO"
    ? opportunityCells
    : liveOpportunityCells;
  const activeCountryMappings =
    dataMode === "DEMO" ? countryMappings : liveCountryMappings;
  const activeShopMappings = useMemo(() => {
    const source = dataMode === "DEMO" ? shopMappings : liveShopMappings;
    const query = shopMappingSearch.trim().toLocaleLowerCase();
    if (!query) return source;
    return source.filter((item) =>
      [
        item.sourceShopName,
        item.internalShopName,
        item.countryName,
        item.manager,
      ].some((value) => String(value || "").toLocaleLowerCase().includes(query)),
    );
  }, [dataMode, liveShopMappings, shopMappingSearch, shopMappings]);

  const filteredStores = useMemo(
    () =>
      currentStores.filter(
        (store) =>
          (country === "ALL" || store.countryCode === country) &&
          (manager === "ALL" || store.manager === manager) &&
          (platform === "ALL" || store.platform === platform),
      ),
    [country, currentStores, manager, platform],
  );

  const filteredProducts = useMemo(
    () =>
      currentProducts.filter((product) => {
        const matchesScope =
          (country === "ALL" || product.countryCode === country) &&
          (selectedCategory === "ALL" || product.category === selectedCategory);
        if (!matchesScope) return false;
        if (productSegment === "GROWING") return product.trendState === "GROWING";
        if (productSegment === "DECLINING") return product.trendState === "DECLINING";
        if (productSegment === "QUIET_ENTRY") return product.direction === "QUIET_ENTRY";
        if (productSegment === "WINNERS") return product.direction === "DEFEND_WINNER";
        return true;
      }),
    [country, currentProducts, productSegment, selectedCategory],
  );

  const filteredTasks = useMemo(
    () =>
      currentTasks.filter(
        (task) =>
          (country === "ALL" || task.countryCode === country) &&
          (manager === "ALL" || task.manager === manager) &&
          (platform === "ALL" || task.platform === platform),
      ),
    [country, currentTasks, manager, platform],
  );

  const heatmapOption = useMemo<EChartsOption>(() => {
    const countries =
      country === "ALL" ? countryOrder : [country as CountryCode];
    const cells = currentOpportunityCells.filter((cell) =>
      countries.includes(cell.countryCode),
    );

    return {
      aria: { enabled: true },
      animationDuration: 220,
      grid: { left: 56, right: 20, top: 14, bottom: 50 },
      tooltip: {
        trigger: "item",
        formatter: (params: unknown) => {
          const data = (
            params as {
              data?: {
                value: [number, number, number];
                cell: (typeof cells)[number];
              };
            }
          ).data;
          if (!data) return "";
          return [
            `<strong>${data.cell.countryName} · ${data.cell.category}</strong>`,
            `可行动机会：${data.cell.opportunityCount} 个`,
            `来源高表现 SKU：${data.cell.highPerformanceSkuCount} 个`,
            `低承接 SKU：${data.cell.lowCaptureSkuCount} 个`,
            `库存可支撑：${data.cell.inventoryReadySkuCount} 个`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: categories,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#58657a", fontSize: 11, interval: 0 },
      },
      yAxis: {
        type: "category",
        data: countries,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#28354a", fontSize: 11, fontWeight: 600 },
      },
      visualMap: {
        min: 0,
        max: 20,
        orient: "horizontal",
        left: 0,
        bottom: 2,
        itemWidth: 12,
        itemHeight: 72,
        text: ["机会多", "机会少"],
        textStyle: { color: "#6b7688", fontSize: 10 },
        inRange: {
          color: ["#e8f2ec", "#b7d8c1", "#f0d78c", "#e99b62", "#d85b57"],
        },
      },
      series: [
        {
          name: "可行动机会",
          type: "heatmap",
          data: cells.map((cell) => ({
            value: [
              categories.indexOf(cell.category),
              countries.indexOf(cell.countryCode),
              cell.opportunityCount,
            ],
            cell,
          })),
          label: {
            show: true,
            color: "#172033",
            fontSize: 12,
            fontWeight: 700,
          },
          itemStyle: {
            borderColor: "#ffffff",
            borderWidth: 3,
            borderRadius: 4,
          },
          emphasis: {
            itemStyle: {
              borderColor: "#1f4f73",
              borderWidth: 2,
              shadowBlur: 8,
              shadowColor: "rgba(31, 79, 115, 0.18)",
            },
          },
        },
      ],
    };
  }, [country, currentOpportunityCells]);

  const quadrantOption = useMemo<EChartsOption>(() => {
    const rows = filteredProducts.map((product) => [
      Math.round(product.captureRatio * 1000) / 10,
      product.marketPercentile,
      Math.max(10, Math.min(30, Math.sqrt(product.predictedDailySales) / 1.2)),
      product.sku,
      product.direction,
    ]);

    return {
      aria: { enabled: true },
      animationDuration: 220,
      grid: { left: 54, right: 18, top: 22, bottom: 42 },
      tooltip: {
        formatter: (params: unknown) => {
          const value = (
            params as {
              value?: [number, number, number, string, DirectionCode];
            }
          ).value;
          if (!value) return "";
          return [
            `<strong>${value[3]}</strong>`,
            `来源表现分位：P${value[1]}`,
            `我方承接比：${value[0]}%`,
            `方向：${directionMeta[value[4]].label}`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "value",
        min: 0,
        max: 35,
        name: "我方承接比",
        nameLocation: "middle",
        nameGap: 28,
        axisLabel: { formatter: "{value}%", color: "#697588", fontSize: 10 },
        splitLine: { lineStyle: { color: "#e6eaf0" } },
      },
      yAxis: {
        type: "value",
        min: 60,
        max: 100,
        name: "来源表现分位",
        nameLocation: "middle",
        nameGap: 34,
        axisLabel: { formatter: "P{value}", color: "#697588", fontSize: 10 },
        splitLine: { lineStyle: { color: "#e6eaf0" } },
      },
      series: [
        {
          type: "scatter",
          data: rows,
          symbolSize: (value: unknown) =>
            Number((value as [number, number, number])[2] ?? 12),
          itemStyle: {
            color: (params: unknown) => {
              const direction = (
                params as {
                  value?: [number, number, number, string, DirectionCode];
                }
              ).value?.[4];
              return direction ? directionMeta[direction].color : "#4b6687";
            },
            borderColor: "#ffffff",
            borderWidth: 1.5,
            opacity: 0.9,
          },
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: "#9ba6b5", type: "dashed", width: 1 },
            data: [{ xAxis: 10 }, { yAxis: 80 }],
          },
        },
      ],
    };
  }, [filteredProducts]);

  const storeHealthOption = useMemo<EChartsOption>(() => {
    const grouped = filteredStores.reduce(
      (result, store) => {
        result[store.state] += 1;
        return result;
      },
      { ACTION_REQUIRED: 0, WATCH: 0, STABLE: 0, BLOCKED: 0 },
    );

    return {
      aria: { enabled: true },
      animationDuration: 220,
      tooltip: { trigger: "item", formatter: "{b}: {c} 家 ({d}%)" },
      legend: {
        orient: "vertical",
        right: 8,
        top: "middle",
        icon: "circle",
        itemWidth: 9,
        textStyle: { color: "#58657a", fontSize: 11 },
      },
      series: [
        {
          type: "pie",
          radius: ["55%", "76%"],
          center: ["36%", "50%"],
          avoidLabelOverlap: true,
          label: { show: false },
          emphasis: { scaleSize: 4 },
          data: [
            { value: grouped.ACTION_REQUIRED, name: "需处理", itemStyle: { color: "#d94c4c" } },
            { value: grouped.WATCH, name: "观察", itemStyle: { color: "#df9a2e" } },
            { value: grouped.STABLE, name: "稳定", itemStyle: { color: "#2b9b68" } },
            { value: grouped.BLOCKED, name: "阻塞", itemStyle: { color: "#8a94a4" } },
          ],
        },
      ],
    };
  }, [filteredStores]);

  const trendOption = useMemo<EChartsOption>(
    () => {
      if (dataMode !== "DEMO") {
        const rows = filteredStores.slice(0, 10);
        return {
          aria: { enabled: true },
          animationDuration: 220,
          tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
          legend: {
            top: 0,
            right: 0,
            icon: "roundRect",
            itemWidth: 12,
            textStyle: { color: "#697588", fontSize: 10 },
          },
          grid: { left: 44, right: 14, top: 34, bottom: 58 },
          xAxis: {
            type: "category",
            data: rows.map((store) => store.shopName),
            axisLabel: {
              color: "#697588",
              fontSize: 10,
              rotate: rows.length > 5 ? 25 : 0,
              width: 72,
              overflow: "truncate",
            },
          },
          yAxis: {
            type: "value",
            axisLabel: { color: "#697588", fontSize: 10 },
            splitLine: { lineStyle: { color: "#edf0f4" } },
          },
          series: [
            {
              name: "当前 7 天",
              type: "bar",
              data: rows.map((store) => store.current7d),
              itemStyle: { color: "#176d5b", borderRadius: [3, 3, 0, 0] },
            },
            {
              name: "前 7 天",
              type: "bar",
              data: rows.map((store) => store.previous7d),
              itemStyle: { color: "#a7b0bc", borderRadius: [3, 3, 0, 0] },
            },
          ],
        };
      }
      return {
      aria: { enabled: true },
      animationDuration: 220,
      tooltip: { trigger: "axis" },
      legend: {
        top: 0,
        right: 0,
        icon: "roundRect",
        itemWidth: 12,
        textStyle: { color: "#697588", fontSize: 10 },
      },
      grid: { left: 44, right: 14, top: 34, bottom: 28 },
      xAxis: {
        type: "category",
        data: trendSeries.dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#dce1e8" } },
        axisTick: { show: false },
        axisLabel: { color: "#697588", fontSize: 10 },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#697588", fontSize: 10 },
        splitLine: { lineStyle: { color: "#edf0f4" } },
      },
      series: [
        {
          name: "当前 7 天",
          type: "line",
          data: trendSeries.current,
          smooth: 0.25,
          symbolSize: 5,
          lineStyle: { width: 2.5, color: "#176d5b" },
          itemStyle: { color: "#176d5b" },
          areaStyle: { color: "rgba(23, 109, 91, 0.09)" },
        },
        {
          name: "前 7 天",
          type: "line",
          data: trendSeries.previous,
          smooth: 0.25,
          symbolSize: 4,
          lineStyle: { width: 1.5, color: "#96a0ae", type: "dashed" },
          itemStyle: { color: "#96a0ae" },
        },
      ],
      };
    },
    [dataMode, filteredStores],
  );

  const gapBarOption = useMemo<EChartsOption>(() => {
    const values = categories.map((category) => ({
      category,
      value: currentProducts.filter(
        (product) =>
          product.category === category &&
          (product.direction === "QUIET_ENTRY" ||
            product.direction === "PRIORITY_GROWTH"),
      ).length,
    }));

    return {
      aria: { enabled: true },
      animationDuration: 220,
      grid: { left: 78, right: 20, top: 14, bottom: 22 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: {
        type: "value",
        axisLabel: { color: "#6a7689", fontSize: 10 },
        splitLine: { lineStyle: { color: "#edf0f4" } },
      },
      yAxis: {
        type: "category",
        data: values.map((item) => item.category),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: "#2d3a4d", fontSize: 11 },
      },
      series: [
        {
          name: "待核查 SKU",
          type: "bar",
          data: values.map((item) => item.value),
          barWidth: 14,
          itemStyle: { color: "#d88a39", borderRadius: [0, 3, 3, 0] },
          label: { show: true, position: "right", color: "#435065", fontSize: 10 },
        },
      ],
    };
  }, [currentProducts]);

  const storeColumns: ColumnsType<StoreSummary> = [
    {
      title: "店铺",
      dataIndex: "shopName",
      width: 170,
      fixed: "left",
      render: (value: string, row) => (
        <button type="button" className="table-link" onClick={() => setSelectedStore(row)}>
          {value}
        </button>
      ),
    },
    {
      title: "国家 / 平台",
      key: "scope",
      width: 130,
      render: (_, row) => (
        <span className="stacked-cell">
          <strong>{row.countryName}</strong>
          <small>{platformLabels[row.platform]}</small>
        </span>
      ),
    },
    { title: "店长", dataIndex: "manager", width: 86 },
    {
      title: "当前 7 天",
      dataIndex: "current7d",
      width: 96,
      align: "right",
      render: (value: number | null) => <strong>{formatNumber(value)}</strong>,
    },
    {
      title: "相比前 7 天",
      dataIndex: "trendPercent",
      width: 112,
      align: "right",
      sorter: (a, b) => (a.trendPercent ?? -999) - (b.trendPercent ?? -999),
      render: (value: number | null, row) => (
        <span className={`trend-value trend-value--${row.trendState.toLowerCase()}`}>
          {row.trendState === "INSUFFICIENT_HISTORY"
            ? "数据不足"
            : formatPercent(value)}
        </span>
      ),
    },
    {
      title: "高表现货盘销售覆盖",
      dataIndex: "highPerformanceCoverage",
      width: 150,
      render: (value: number | null) =>
        value === null ? (
          "数据不足"
        ) : (
          <div className="table-progress">
            <Progress percent={value} size="small" showInfo={false} strokeColor="#2d8069" />
            <span>{value}%</span>
          </div>
        ),
    },
    {
      title: "任务",
      dataIndex: "activeTaskCount",
      width: 72,
      align: "center",
      render: (value: number) => <Badge count={value} color="#d74c4c" />,
    },
    {
      title: "状态",
      dataIndex: "state",
      width: 90,
      render: (value: StoreState) => (
        <Tag color={storeStateMeta[value].color}>{storeStateMeta[value].label}</Tag>
      ),
    },
    {
      title: "最近数据",
      dataIndex: "updatedAt",
      width: 136,
      render: (value: string) => value.slice(5),
    },
  ];

  const productColumns: ColumnsType<ProductInsight> = [
    {
      title: "排名",
      dataIndex: "rank",
      width: 58,
      align: "center",
      render: (value: number) => <strong className="rank-number">{value}</strong>,
    },
    {
      title: "SKU / 商品",
      key: "product",
      width: 210,
      render: (_, row) => (
        <button
          type="button"
          className="table-link table-link--stacked"
          onClick={() => setSelectedProduct(row)}
        >
          <strong>{row.sku}</strong>
          <small>{row.name}</small>
        </button>
      ),
    },
    {
      title: "国家 / 类目",
      key: "scope",
      width: 120,
      render: (_, row) => (
        <span className="stacked-cell">
          <strong>{row.countryName}</strong>
          <small>{row.category}</small>
        </span>
      ),
    },
    {
      title: "来源预测日销量",
      dataIndex: "predictedDailySales",
      width: 130,
      align: "right",
      sorter: (a, b) => a.predictedDailySales - b.predictedDailySales,
      render: (value: number) => <strong>{formatNumber(value)}</strong>,
    },
    {
      title: "我方 28 天有效订单",
      dataIndex: "ownSales28d",
      width: 132,
      align: "right",
      render: (value: number) => formatNumber(value),
    },
    {
      title: "当前趋势",
      dataIndex: "trendState",
      width: 112,
      render: (value: TrendState, row) => (
        <span className={`trend-value trend-value--${value.toLowerCase()}`}>
          {trendLabel(value)}
          {row.trendPercent !== null ? ` ${formatPercent(row.trendPercent)}` : ""}
        </span>
      ),
    },
    {
      title: "库存",
      key: "inventory",
      width: 126,
      render: (_, row) => (
        <span className="stacked-cell">
          <strong>可用 {formatNumber(row.available)}</strong>
          <small>
            在途 {formatNumber(row.inbound)} ·{" "}
            {row.coverageDays === null ? "按仓查看风险" : `${row.coverageDays} 天`}
          </small>
        </span>
      ),
    },
    {
      title: "方向",
      dataIndex: "direction",
      width: 136,
      render: (value: DirectionCode) => (
        <Tag color={directionMeta[value].color}>{directionMeta[value].action}</Tag>
      ),
    },
  ];

  const countryMappingColumns: ColumnsType<CountryMappingRow> = [
    { title: "仓库", dataIndex: "warehouseName", width: 220 },
    {
      title: "国家",
      dataIndex: "countryCode",
      width: 180,
      render: (value: string | undefined, row) => (
        <Select
          value={value as CountryCode | undefined}
          placeholder="选择国家"
          options={countryOptions.slice(1)}
          disabled={dataMode !== "DEMO"}
          onChange={(nextValue: CountryCode) =>
            setCountryMappings((current) =>
              current.map((item) =>
                item.key === row.key
                  ? {
                      ...item,
                      countryCode: nextValue,
                      countryName: countryOptions.find(
                        (option) => option.value === nextValue,
                      )?.label,
                      status: "DRAFT",
                    }
                  : item,
              ),
            )
          }
        />
      ),
    },
    {
      title: "库存行",
      dataIndex: "rowCount",
      width: 100,
      align: "right",
      render: (value: number | undefined) => formatNumber(value || 0),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: CountryMappingRow["status"]) => (
        <Tag color={value === "CONFIRMED" ? "green" : value === "DRAFT" ? "orange" : "default"}>
          {value === "CONFIRMED" ? "已确认" : value === "DRAFT" ? "草稿" : "未映射"}
        </Tag>
      ),
    },
  ];

  const shopMappingColumns: ColumnsType<ShopMappingRow> = [
    { title: "来源店铺", dataIndex: "sourceShopName", width: 180 },
    {
      title: "内部店铺",
      dataIndex: "internalShopName",
      width: 180,
      render: (value: string | undefined) => value || <span className="muted-text">待匹配</span>,
    },
    {
      title: "平台",
      dataIndex: "platform",
      width: 100,
      render: (value: ShopMappingRow["platform"]) => platformLabels[value],
    },
    {
      title: "国家",
      dataIndex: "countryCode",
      width: 160,
      render: (value: string | undefined, row) => (
        <Select
          value={value as CountryCode | undefined}
          placeholder="选择国家"
          options={countryOptions.slice(1)}
          disabled={dataMode !== "DEMO"}
          onChange={(nextValue: CountryCode) =>
            setShopMappings((current) =>
              current.map((item) =>
                item.key === row.key
                  ? { ...item, countryCode: nextValue, status: "DRAFT" }
                  : item,
              ),
            )
          }
        />
      ),
    },
    {
      title: "店长",
      dataIndex: "manager",
      width: 160,
      render: (value: string | undefined, row) => (
        <Select
          value={value}
          placeholder="选择店长"
          options={managerOptions.slice(1)}
          disabled={dataMode !== "DEMO"}
          onChange={(nextValue: string) =>
            setShopMappings((current) =>
              current.map((item) =>
                item.key === row.key
                  ? { ...item, manager: nextValue, status: "DRAFT" }
                  : item,
              ),
            )
          }
        />
      ),
    },
    {
      title: "待补字段",
      dataIndex: "missingFields",
      width: 150,
      render: (value: string[] | undefined) =>
        value?.length ? value.join(" / ") : <span className="muted-text">无</span>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: ShopMappingRow["status"]) => (
        <Tag color={value === "CONFIRMED" ? "green" : value === "DRAFT" ? "orange" : "default"}>
          {value === "CONFIRMED" ? "已确认" : value === "DRAFT" ? "草稿" : "未映射"}
        </Tag>
      ),
    },
  ];

  function navigate(view: string) {
    const nextView = viewFromMetric(view);
    setActiveView(nextView);
    onViewChange?.(nextView === "settings" ? "configuration" : nextView);
    setMobileNavigationOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function replaceLiveTask(nextTask: OperationTask) {
    setLiveTasks((current) =>
      current.map((task) => (task.id === nextTask.id ? nextTask : task)),
    );
    setSelectedTask((current) =>
      current?.id === nextTask.id ? nextTask : current,
    );
  }

  async function openTask(task: OperationTask) {
    setSelectedTask(task);
    setSelectedTaskEvents([]);
    if (dataMode !== "READINESS" || !task.persisted || !taskPersistenceReady) return;
    try {
      const detail = await loadAssistantTaskDetail(task.id);
      replaceLiveTask(detail.item);
      setSelectedTaskEvents(detail.events);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "任务详情加载失败。");
    }
  }

  async function executeTaskStatusUpdate(
    task: OperationTask,
    status: TaskStatus,
    details: {
      reasonCode?: string;
      note?: string;
      snoozedUntil?: string;
    } = {},
  ) {
    if (!taskTransitions[task.status].includes(status)) {
      messageApi.warning("当前任务状态已变化，请刷新后重试。");
      return false;
    }
    if (dataMode === "DEMO") {
      const nextTask = {
        ...task,
        status,
        snoozedUntil: details.snoozedUntil || task.snoozedUntil,
      };
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? nextTask : item)),
      );
      setSelectedTask((current) => current?.id === task.id ? nextTask : current);
      messageApi.success(`任务状态已更新为“${statusLabels[status]}”（仅原型会话）`);
      return true;
    }
    if (!workspacePublishable || !taskPersistenceReady || !task.persisted || !task.revision) {
      messageApi.warning("任务写入门禁未就绪；当前只展示已发布分析结果。");
      return false;
    }
    setTaskActionSaving(true);
    try {
      const result = await updateAssistantTaskStatus(task.id, {
        status,
        expectedRevision: task.revision,
        idempotencyKey: requestKey(`task-${status.toLowerCase()}`),
        ...details,
      });
      replaceLiveTask(result.item);
      const detail = await loadAssistantTaskDetail(task.id);
      replaceLiveTask(detail.item);
      setSelectedTaskEvents(detail.events);
      messageApi.success(`任务状态已更新为“${statusLabels[status]}”`);
      return true;
    } catch (error) {
      if (error instanceof GrowthRadarApiError && error.currentItem) {
        replaceLiveTask(error.currentItem);
        messageApi.warning("任务已被其他操作更新，已刷新到最新版本。");
      } else {
        messageApi.error(error instanceof Error ? error.message : "任务状态更新失败。");
      }
      return false;
    } finally {
      setTaskActionSaving(false);
    }
  }

  function updateTaskStatus(id: string, status: TaskStatus) {
    const task = currentTasks.find((item) => item.id === id);
    if (!task) {
      messageApi.warning("任务已不在当前列表中，请刷新后重试。");
      return;
    }
    const needsDetails = status === "MONITORING"
      || ["BLOCKED", "RESOLVED", "DISMISSED"].includes(status);
    if (needsDetails) {
      setTaskAction({ task, status });
      setTaskActionReason(taskReasonOptions[status]?.[0]?.value);
      setTaskActionNote("");
      setTaskActionReviewAt(
        status === "MONITORING" ? dayjs().add(7, "day") : null,
      );
      return;
    }
    void executeTaskStatusUpdate(task, status);
  }

  async function confirmTaskAction() {
    if (!taskAction) return;
    const reasonRequired = ["BLOCKED", "RESOLVED", "DISMISSED"].includes(
      taskAction.status,
    );
    if (reasonRequired && !taskActionReason) {
      messageApi.warning("请选择处理原因。");
      return;
    }
    if (taskAction.status === "MONITORING" && !taskActionReviewAt) {
      messageApi.warning("请选择复核时间。");
      return;
    }
    const completed = await executeTaskStatusUpdate(
      taskAction.task,
      taskAction.status,
      {
        reasonCode: taskActionReason,
        note: taskActionNote.trim() || undefined,
        snoozedUntil: taskActionReviewAt?.toISOString(),
      },
    );
    if (completed) setTaskAction(null);
  }

  function saveMappingDraft() {
    if (dataMode !== "DEMO") {
      messageApi.warning("正式配置写入尚未批准；当前只展示真实缺口，不会修改数据库。");
      return;
    }
    messageApi.info("当前为前端原型，仅保存在本次会话，未写入正式数据库。");
  }

  function renderModeNotice() {
    if (dataMode === "DEMO") {
      return (
        <Alert
          className="mode-alert"
          type="info"
          showIcon
          title="当前展示交互样例数据"
          description="用于确认 V2.2 信息架构和操作流程，不代表正式经营结论。切换到“真实数据门禁”可查看当前数据准备度。"
          action={
            <Button size="small" onClick={() => setDataMode("READINESS")}>
              查看数据门禁
            </Button>
          }
        />
      );
    }
    if (workspacePublishable) {
      return (
        <Alert
          className="mode-alert"
          type="success"
          showIcon
          title="正在展示最新已发布分析"
          description={taskPersistenceReady
            ? "任务来自确定性规则；处理状态、复核时间和事件轨迹会写入隔离任务库。"
            : "分析结果已发布，但任务持久化迁移尚未批准应用，当前操作保持只读。"}
        />
      );
    }

    return (
      <Alert
        className="mode-alert"
        type="warning"
        showIcon
        title="正式分析尚未达到发布条件"
        description="趋势、店铺归属和国家映射不足时，系统只展示阻塞任务，不生成经营建议。"
        action={
          <Button size="small" onClick={() => navigate("settings")}>
            查看准备项
          </Button>
        }
      />
    );
  }

  function renderReadinessPanel() {
    return (
      <section className="readiness-panel">
        <header className="section-header">
          <div>
            <span className="section-kicker">正式数据门禁</span>
            <h2>发布前准备度</h2>
            <p>缺失事实不会被补零，未确认映射不会参与经营分析。</p>
          </div>
          <Tag color="orange">
            {liveReadinessItems.filter((item) => item.state !== "READY").length} 项待处理
          </Tag>
        </header>
        <div className="readiness-list">
          {liveReadinessItems.map((item) => (
            <article className="readiness-row" key={item.key}>
              <div className="readiness-row__heading">
                <span
                  className={`readiness-dot readiness-dot--${item.state.toLowerCase()}`}
                  aria-hidden="true"
                />
                <strong>{item.label}</strong>
                <span>
                  {item.current}/{item.target} {item.unit}
                </span>
              </div>
              <Progress
                percent={readinessPercent(item)}
                showInfo={false}
                strokeColor={
                  item.state === "READY"
                    ? "#238561"
                    : item.state === "PARTIAL"
                      ? "#d5912f"
                      : "#b65a5a"
                }
                railColor="#e9edf2"
              />
              <p>{item.detail}</p>
              <small>{item.nextAction}</small>
            </article>
          ))}
        </div>
      </section>
    );
  }

  function renderToday() {
    const readinessByKey = new Map(
      liveReadinessItems.map((item) => [item.key, item]),
    );
    const shopReadiness = readinessByKey.get("shops");
    const warehouseReadiness = readinessByKey.get("warehouses");
    const historyReadiness = readinessByKey.get("history");
    const activeMetrics =
      dataMode === "DEMO"
        ? metrics
        : workspacePublishable
          ? [
              {
                key: "tasks",
                label: "今日运营任务",
                value: publishedTaskCount,
                tone: "danger" as const,
                description: "每位店长最多 10 项",
                targetView: "tasks",
              },
              {
                key: "stores",
                label: "需处理店铺",
                value: liveStores.filter((store) => store.state === "ACTION_REQUIRED").length,
                tone: "warning" as const,
                description: "存在确定性高优先任务",
                targetView: "stores",
              },
              {
                key: "opportunities",
                label: "增长候选",
                value: liveTasks.filter((task) => [
                  "STORE_ASSORTMENT_GAP",
                  "QUIET_ENTRY",
                  "CROSS_COUNTRY_CANDIDATE",
                ].includes(task.type)).length,
                tone: "positive" as const,
                description: "已附证据与动作边界",
                targetView: "products",
              },
              {
                key: "risks",
                label: "库存风险",
                value: liveTasks.filter((task) => task.type === "INVENTORY_RISK").length,
                tone: "info" as const,
                description: "需人工核查补货计划",
                targetView: "tasks",
              },
            ]
          : [
            {
              key: "publishable",
              label: "可发布任务",
              value: publishedTaskCount,
              tone: "danger" as const,
              description: "数据门禁未通过",
              targetView: "settings",
            },
            {
              key: "shop-map",
              label: "待映射店铺",
              value: Math.max(
                0,
                (shopReadiness?.target || 0) - (shopReadiness?.current || 0),
              ),
              tone: "warning" as const,
              description: "缺少国家与店长归属",
              targetView: "settings",
            },
            {
              key: "warehouse-map",
              label: "待映射仓库",
              value: Math.max(
                0,
                (warehouseReadiness?.target || 0)
                  - (warehouseReadiness?.current || 0),
              ),
              tone: "warning" as const,
              description: "国家维度仍被阻断",
              targetView: "settings",
            },
            {
              key: "history",
              label: "有效历史天数",
              value: historyReadiness?.current || 0,
              tone: "info" as const,
              description: "趋势要求至少 14 天",
              targetView: "settings",
            },
            ];

    return (
      <>
        {renderModeNotice()}
        <section className="metric-grid" aria-label="今日运营概览">
          {activeMetrics.map((metric, index) => (
            <MetricCard
              key={metric.key}
              metric={metric}
              icon={metricIcons[index]}
              onSelect={navigate}
            />
          ))}
        </section>

        <div className="today-primary-grid">
          <TaskRail
            tasks={filteredTasks}
            onOpen={(task) => void openTask(task)}
            onStatusChange={updateTaskStatus}
          />
          {dataMode === "DEMO" || workspacePublishable ? (
            <section className="store-health-panel">
              <header className="section-header">
                <div>
                  <span className="section-kicker">50 家店的处理顺序</span>
                  <h2>店铺状态概览</h2>
                  <p>状态来自活动任务与数据阻塞，不使用黑盒健康分。</p>
                </div>
                <Button type="text" onClick={() => navigate("stores")}>
                  查看店铺
                  <ArrowRight size={15} />
                </Button>
              </header>
              <EChart
                option={storeHealthOption}
                ariaLabel="店铺状态分布环形图"
                className="store-health-chart"
              />
              <div className="store-health-summary">
                {(["ACTION_REQUIRED", "WATCH", "STABLE"] as StoreState[]).map(
                  (state) => (
                    <span key={state}>
                      <i data-state={state.toLowerCase()} />
                      {storeStateMeta[state].label}
                      <strong>
                        {filteredStores.filter((store) => store.state === state).length}
                      </strong>
                    </span>
                  ),
                )}
              </div>
            </section>
          ) : (
            renderReadinessPanel()
          )}
        </div>

        {(dataMode === "DEMO" || workspacePublishable) && (
          <>
            <div className="analysis-grid">
              <section className="workspace-section">
                <header className="section-header">
                  <div>
                    <span className="section-kicker">经营变化</span>
                    <h2>店铺有效订单趋势</h2>
                    <p>当前 7 天与前 7 天比较；历史不足时必须显示数据不足。</p>
                  </div>
                  <Tag color="green">
                    {dataMode === "DEMO" ? "交互样例" : "最新发布"}
                  </Tag>
                </header>
                <EChart
                  option={trendOption}
                  ariaLabel="当前七天与前七天有效订单销量趋势折线图"
                  className="trend-chart"
                />
              </section>

              <section className="workspace-section">
                <header className="section-header">
                  <div>
                    <span className="section-kicker">产品方向</span>
                    <h2>货盘验证 vs 我方承接</h2>
                    <p>纵轴是来源表现分位，横轴是我方承接比，不称为市场份额。</p>
                  </div>
                  <Button type="text" onClick={() => navigate("comparison")}>
                    展开分析
                    <ArrowRight size={15} />
                  </Button>
                </header>
                <EChart
                  option={quadrantOption}
                  ariaLabel="来源预测表现和我方承接比四象限散点图"
                  className="quadrant-chart"
                  onPointClick={(params) => {
                    const value = (
                      params as { value?: [number, number, number, string] }
                    ).value;
                    const product = currentProducts.find((item) => item.sku === value?.[3]);
                    if (product) setSelectedProduct(product);
                  }}
                />
              </section>
            </div>

            <section className="workspace-section opportunity-preview">
              <header className="section-header">
                <div>
                  <span className="section-kicker">投入方向</span>
                  <h2>国家 × 类目机会地图</h2>
                  <p>数字代表同时满足来源表现、我方低承接和库存门槛的 SKU 数量。</p>
                </div>
                <Button type="text" onClick={() => navigate("map")}>
                  查看完整地图
                  <ArrowRight size={15} />
                </Button>
              </header>
              <EChart
                option={heatmapOption}
                ariaLabel="国家和类目可行动机会数量热力图"
                className="heatmap-chart"
                onPointClick={(params) => {
                  const data = (
                    params as {
                      data?: { cell?: { countryCode: CountryCode; category: string } };
                    }
                  ).data;
                  if (!data?.cell) return;
                  setCountry(data.cell.countryCode);
                  setSelectedCategory(data.cell.category);
                  navigate("products");
                }}
              />
            </section>
          </>
        )}
      </>
    );
  }

  function renderStores() {
    if (dataMode === "READINESS" && !workspacePublishable) {
      return (
        <>
          {renderModeNotice()}
          {renderReadinessPanel()}
          <BlockedWorkspace
            title="店铺战场尚未开放"
            description="107 家来源店铺尚未确认内部店铺、国家和店长归属。当前不能生成“我的店铺”结论。"
            action={() => navigate("settings")}
          />
        </>
      );
    }

    return (
      <>
        {renderModeNotice()}
        <div className="analysis-grid analysis-grid--store">
          <section className="workspace-section">
            <header className="section-header">
              <div>
                <span className="section-kicker">全局状态</span>
                <h2>店铺状态分布</h2>
                <p>需处理、观察、稳定和阻塞四种可解释状态。</p>
              </div>
            </header>
            <EChart
              option={storeHealthOption}
              ariaLabel="店铺状态分布图"
              className="store-health-chart store-health-chart--wide"
            />
          </section>
          <section className="workspace-section">
            <header className="section-header">
              <div>
                <span className="section-kicker">销售事实</span>
                <h2>近两周有效订单趋势</h2>
                <p>统计已发货、待处理、配货中、已完成订单；按付款日期归属。</p>
              </div>
            </header>
            <EChart
              option={trendOption}
              ariaLabel="近两周有效订单销量趋势图"
              className="trend-chart"
            />
          </section>
        </div>
        <section className="workspace-section table-section">
          <header className="section-header">
            <div>
              <span className="section-kicker">店长管理面板</span>
              <h2>店铺战场列表</h2>
              <p>默认把需处理和阻塞店铺排在前面。</p>
            </div>
            <span className="section-count">{filteredStores.length}</span>
          </header>
          <Table
            rowKey="id"
            columns={storeColumns}
            dataSource={filteredStores}
            pagination={false}
            size="small"
            scroll={{ x: 1080 }}
            rowClassName={(row) =>
              row.state === "ACTION_REQUIRED" ? "table-row--attention" : ""
            }
          />
        </section>
      </>
    );
  }

  function renderMap() {
    if (dataMode === "READINESS" && !workspacePublishable) {
      return (
        <>
          {renderModeNotice()}
          <BlockedWorkspace
            title="国家 × 类目机会被国家映射阻断"
            description="20,022 条最新库存快照均未解析到国家，系统不会猜测国家或跨仓盲目求和。"
            action={() => navigate("settings")}
          />
        </>
      );
    }

    return (
      <>
        {renderModeNotice()}
        <section className="workspace-section map-workspace">
          <header className="section-header">
            <div>
              <span className="section-kicker">国家 × 类目</span>
              <h2>可行动机会数量</h2>
              <p>点击单元格下钻到对应国家和类目的 SKU 证据列表。</p>
            </div>
            {selectedCategory !== "ALL" && (
              <Button size="small" onClick={() => setSelectedCategory("ALL")}>
                清除类目筛选
              </Button>
            )}
          </header>
          <EChart
            option={heatmapOption}
            ariaLabel="国家和类目可行动机会热力图"
            className="heatmap-chart heatmap-chart--full"
            onPointClick={(params) => {
              const data = (
                params as {
                  data?: { cell?: { countryCode: CountryCode; category: string } };
                }
              ).data;
              if (!data?.cell) return;
              setCountry(data.cell.countryCode);
              setSelectedCategory(data.cell.category);
              navigate("products");
            }}
          />
        </section>
        <section className="workspace-section map-explanation">
          <header className="section-header">
            <div>
              <span className="section-kicker">口径说明</span>
              <h2>什么会进入机会地图</h2>
            </div>
          </header>
          <div className="rule-steps">
            <RuleStep index="01" title="来源已验证" detail="同国家、同类目预测日销量位于 P80 以上。" />
            <RuleStep index="02" title="我方低承接" detail="近 28 天有效订单承接比低于 10% 配置阈值。" />
            <RuleStep index="03" title="库存可行动" detail="可用库存和可售天数满足低风险测试门槛。" />
            <RuleStep index="04" title="人工核查" detail="核查在线状态后再执行，不自动上架或推广。" />
          </div>
        </section>
      </>
    );
  }

  function renderProducts() {
    if (dataMode === "READINESS" && !workspacePublishable) {
      return (
        <>
          {renderModeNotice()}
          <BlockedWorkspace
            title="产品雷达只显示数据准备状态"
            description="预测日销量语义和国家映射未确认，暂不生成正式产品方向。"
            action={() => navigate("settings")}
          />
        </>
      );
    }

    return (
      <>
        {renderModeNotice()}
        <section className="workspace-section table-section">
          <header className="section-header section-header--filters">
            <div>
              <span className="section-kicker">确定性产品分类</span>
              <h2>SKU 表现雷达</h2>
              <p>所有方向都能追溯到来源预测、有效订单事实和仓库库存证据。</p>
            </div>
            <Segmented
              value={productSegment}
              onChange={(value) => setProductSegment(String(value))}
              options={[
                { label: "全部", value: "ALL" },
                { label: "明星产品", value: "WINNERS" },
                { label: "增长产品", value: "GROWING" },
                { label: "衰退产品", value: "DECLINING" },
                { label: "蓝海候选", value: "QUIET_ENTRY" },
              ]}
            />
          </header>
          <Table
            rowKey="key"
            columns={productColumns}
            dataSource={filteredProducts}
            pagination={{ pageSize: 8, placement: ["bottomEnd"] }}
            size="small"
            scroll={{ x: 1040 }}
            locale={{
              emptyText: <Empty description="当前筛选范围没有满足条件的 SKU" />,
            }}
          />
        </section>
      </>
    );
  }

  function renderComparison() {
    if (dataMode === "READINESS" && !workspacePublishable) {
      return (
        <>
          {renderModeNotice()}
          <BlockedWorkspace
            title="正式四象限分析尚未发布"
            description="该视图依赖已确认的国家粒度、预测销量语义和店铺销售事实。"
            action={() => navigate("settings")}
          />
        </>
      );
    }

    return (
      <>
        {renderModeNotice()}
        <section className="workspace-section comparison-workspace">
          <header className="section-header">
            <div>
              <span className="section-kicker">货盘验证参考 × 我方承接</span>
              <h2>产品四象限</h2>
              <p>我方承接比不是市场份额；无有效订单不代表未上架。</p>
            </div>
          </header>
          <div className="comparison-layout">
            <EChart
              option={quadrantOption}
              ariaLabel="来源预测表现与我方承接比四象限散点图"
              className="quadrant-chart quadrant-chart--full"
              onPointClick={(params) => {
                const value = (
                  params as { value?: [number, number, number, string] }
                ).value;
                const product = currentProducts.find((item) => item.sku === value?.[3]);
                if (product) setSelectedProduct(product);
              }}
            />
            <div className="quadrant-guide">
              <QuadrantGuide
                tone="danger"
                title="货盘强 · 我方弱"
                action="优先增长"
                detail="来源验证较强，但我方近期承接不足。"
              />
              <QuadrantGuide
                tone="positive"
                title="货盘强 · 我方强"
                action="守住优势"
                detail="保持经营，重点观察库存和趋势。"
              />
              <QuadrantGuide
                tone="info"
                title="货盘弱 · 我方强"
                action="我的优势"
                detail="不扩张结论，继续观察我方真实表现。"
              />
              <QuadrantGuide
                tone="muted"
                title="货盘弱 · 我方弱"
                action="低优先"
                detail="除非有新品或跨国证据，否则不占用今日任务。"
              />
            </div>
          </div>
        </section>
      </>
    );
  }

  function renderGaps() {
    if (dataMode === "READINESS" && !workspacePublishable) {
      return (
        <>
          {renderModeNotice()}
          <BlockedWorkspace
            title="店铺缺口诊断被店铺身份映射阻断"
            description="历史未出单不能直接解释为未上架。完成店铺映射后，系统仍会要求先核查在线状态。"
            action={() => navigate("settings")}
          />
        </>
      );
    }

    const gapProducts = filteredProducts.filter(
      (product) =>
        product.direction === "QUIET_ENTRY" ||
        product.direction === "PRIORITY_GROWTH",
    );

    return (
      <>
        {renderModeNotice()}
        <div className="analysis-grid analysis-grid--gaps">
          <section className="workspace-section">
            <header className="section-header">
              <div>
                <span className="section-kicker">缺口结构</span>
                <h2>待核查 SKU 类目分布</h2>
                <p>仅代表近 28 天未观察到充分销售，不等于未上架。</p>
              </div>
            </header>
            <EChart
              option={gapBarOption}
              ariaLabel="店铺货盘缺口类目分布条形图"
              className="gap-chart"
            />
          </section>
          <section className="workspace-section gap-summary">
            <header className="section-header">
              <div>
                <span className="section-kicker">今日诊断</span>
                <h2>菲律宾 Shopee · 太阳能</h2>
                <p>按来源高表现 Top20 SKU 进行销售覆盖核查。</p>
              </div>
              <Tag color="red">P1</Tag>
            </header>
            <div className="gap-summary__metrics">
              <span><small>来源高表现</small><strong>20</strong></span>
              <span><small>近 28 天有销售</small><strong>5</strong></span>
              <span><small>库存可支撑</small><strong>12</strong></span>
            </div>
            <div className="action-callout">
              <Target size={19} aria-hidden="true" />
              <div>
                <strong>建议动作</strong>
                <p>先核查 12 个 SKU 的在线状态，再选择 3–5 个进行低风险测试。</p>
              </div>
            </div>
          </section>
        </div>
        <section className="workspace-section table-section">
          <header className="section-header">
            <div>
              <span className="section-kicker">证据清单</span>
              <h2>待核查高表现 SKU</h2>
            </div>
            <span className="section-count">{gapProducts.length}</span>
          </header>
          <Table
            rowKey="key"
            columns={productColumns}
            dataSource={gapProducts}
            pagination={false}
            size="small"
            scroll={{ x: 1040 }}
          />
        </section>
      </>
    );
  }

  function renderTasksView(statusFilter?: TaskStatus[]) {
    const rows = statusFilter
      ? filteredTasks.filter((task) => statusFilter.includes(task.status))
      : filteredTasks;

    return (
      <>
        {renderModeNotice()}
        <TaskRail
          tasks={rows}
          onOpen={(task) => void openTask(task)}
          onStatusChange={updateTaskStatus}
          limit={50}
          title={viewMeta[activeView].title}
        />
      </>
    );
  }

  function renderSettings() {
    const liveConfiguration = dataMode !== "DEMO";
    const writeBlocked = liveConfiguration;
    const syncTasks = mabangSync?.tasks || [];
    const syncTaskColumns: ColumnsType<MabangScheduledTask> = [
      {
        title: "数据",
        dataIndex: "taskType",
        width: 110,
        render: (value: MabangSyncTaskType) => (
          <Tag color={value === "order_export" ? "blue" : "cyan"}>
            {value === "order_export" ? "订单" : "库存"}
          </Tag>
        ),
      },
      {
        title: "任务与账号",
        dataIndex: "name",
        render: (_value, task) => (
          <div className="sync-task-name">
            <strong>{task.name}</strong>
            <span>{task.accountName} · {task.accountUsernameMasked}</span>
          </div>
        ),
      },
      {
        title: "执行周期",
        width: 140,
        render: (_value, task) => (
          <div className="sync-task-name">
            <strong>{dailyScheduleLabel(task)}</strong>
            <span>{task.taskType === "order_export" ? "按付款时间更新" : "完整库存快照"}</span>
          </div>
        ),
      },
      {
        title: "状态",
        width: 120,
        render: (_value, task) => (
          <div className="sync-task-name">
            <Tag color={task.enabled ? "success" : "default"}>
              {task.enabled ? "已启用" : "已停用"}
            </Tag>
            <span>{task.lastRunStatus ? `上次 ${task.lastRunStatus}` : "尚未执行"}</span>
          </div>
        ),
      },
      {
        title: "最近 / 下次",
        width: 190,
        render: (_value, task) => (
          <div className="sync-task-name">
            <strong>{formatDateTime(task.lastRunAt)}</strong>
            <span>{task.nextRunAt ? `下次 ${formatDateTime(task.nextRunAt)}` : "暂无下次执行"}</span>
          </div>
        ),
      },
      {
        title: "操作",
        width: 220,
        fixed: "right",
        render: (_value, task) => (
          <div className="sync-task-actions">
            <Tooltip title="编辑每日同步时间与账号">
              <Button
                aria-label={`编辑 ${task.name}`}
                icon={<Pencil size={15} />}
                onClick={() => openSyncEditor(task.taskType, task)}
              />
            </Tooltip>
            <Tooltip title={mabangSync?.scheduler.online ? "立即执行一次" : "调度器离线，暂不能执行"}>
              <Button
                aria-label={`立即执行 ${task.name}`}
                icon={<Play size={15} />}
                disabled={!mabangSync?.scheduler.online}
                loading={syncActionId === task.id}
                onClick={() => void runSyncTask(task)}
              />
            </Tooltip>
            <Button
              loading={syncActionId === task.id}
              onClick={() => void toggleSyncTask(task)}
            >
              {task.enabled ? "停用" : "启用"}
            </Button>
          </div>
        ),
      },
    ];
    return (
      <>
        {renderModeNotice()}
        {renderReadinessPanel()}
        <Alert
          className="mode-alert"
          type={liveConfiguration ? "warning" : "info"}
          showIcon
          title={liveConfiguration
            ? "真实映射缺口只读"
            : "配置交互原型"}
          description={liveConfiguration
            ? configurationSource === "API"
              ? `已读取现有 A2 店铺事实和库存仓库。写入门禁：${configurationWriteGate.reasons.join("、")}。`
              : "独立前端未连接正式 API，当前显示审计快照；不会写入数据库。"
            : "可试用国家与店长选择流程；保存仅作用于当前浏览器会话。"}
        />
        <section className="workspace-section sync-section">
          <header className="section-header">
            <div>
              <span className="section-kicker">超级店长助手基础数据</span>
              <h2>马帮订单与库存同步</h2>
              <p>订单与库存成功采集后直接进入 Growth Radar 事实层；页面始终读取最新已成功入库批次。</p>
            </div>
            <div className="mapping-actions">
              <Badge
                status={mabangSync?.scheduler.online ? "success" : "error"}
                text={mabangSync?.scheduler.online ? "调度器在线" : "调度器离线"}
              />
              <Tooltip title="刷新数据源和任务状态">
                <Button
                  aria-label="刷新马帮同步状态"
                  icon={<RefreshCw size={16} />}
                  loading={mabangSyncState === "LOADING"}
                  onClick={() => void refreshMabangSync()}
                />
              </Tooltip>
              <Button
                icon={<CalendarClock size={16} />}
                disabled={!mabangSync?.accounts.some((account) => account.enabled)}
                onClick={() => openSyncEditor("order_export")}
              >
                新建订单同步
              </Button>
              <Button
                type="primary"
                icon={<DatabaseZap size={16} />}
                disabled={!mabangSync?.accounts.some((account) => account.enabled)}
                onClick={() => openSyncEditor("inventory_export")}
              >
                新建库存同步
              </Button>
            </div>
          </header>

          {mabangSyncState === "UNAVAILABLE" && (
            <Alert
              type="error"
              showIcon
              title="马帮定时同步状态不可用"
              description={mabangSyncError}
            />
          )}
          {mabangSyncState === "READY" && !mabangSync?.scheduler.online && (
            <Alert
              type="warning"
              showIcon
              title="调度器当前离线"
              description="可以维护任务配置，但任务不会自动执行。启动 Commerce Ops 完整服务后会恢复后台调度。"
            />
          )}
          {mabangSyncState === "READY" && !mabangSync?.accounts.length && (
            <Alert
              type="warning"
              showIcon
              title="尚未配置马帮账号"
              description="请先在马帮数据模块配置并验证服务端账号，再回来创建每日订单与库存同步任务。"
            />
          )}

          <div className="sync-source-grid">
            {dataSources.map((source) => {
              const freshness = sourceFreshness(source);
              const relatedTasks = syncTasks.filter((task) => task.taskType === source.taskType);
              return (
                <article className="sync-source-card" key={source.key}>
                  <div className="sync-source-icon" aria-hidden="true">
                    {source.key === "orders"
                      ? <CalendarDays size={20} />
                      : <PackageCheck size={20} />}
                  </div>
                  <div className="sync-source-content">
                    <div className="sync-source-heading">
                      <div>
                        <span>{source.label}</span>
                        <strong>{source.latestBatch
                          ? formatDateTime(source.latestBatch.collectedAt || source.latestBatch.importedAt)
                          : "尚无成功批次"}</strong>
                      </div>
                      <Tag color={freshness.color}>{freshness.label}</Tag>
                    </div>
                    <dl className="sync-source-metrics">
                      <div>
                        <dt>最新行数</dt>
                        <dd>{formatNumber(source.latestBatch?.rowCount ?? 0)}</dd>
                      </div>
                      <div>
                        <dt>定时任务</dt>
                        <dd>{relatedTasks.filter((task) => task.enabled).length} / {relatedTasks.length}</dd>
                      </div>
                      <div>
                        <dt>来源文件</dt>
                        <dd title={source.latestBatch?.sourceFilename || ""}>
                          {source.latestBatch?.sourceFilename || "尚未记录"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </article>
              );
            })}
            {!dataSources.length && (
              <div className="sync-source-empty">
                <DatabaseZap size={22} />
                <span>正在读取订单与库存最新批次。</span>
              </div>
            )}
          </div>

          <Table<MabangScheduledTask>
            rowKey="id"
            columns={syncTaskColumns}
            dataSource={syncTasks}
            pagination={false}
            size="small"
            scroll={{ x: 980 }}
            locale={{ emptyText: "尚未创建订单或库存定时同步任务" }}
          />
        </section>
        <section className="workspace-section mapping-section">
          <header className="section-header">
            <div>
              <span className="section-kicker">国家维度基础</span>
              <h2>仓库 → 国家映射</h2>
              <p>配置必须由用户确认并发布版本，未确认仓库不会进入国家分析。</p>
            </div>
            <Button
              type="primary"
              icon={<CheckCircle2 size={16} />}
              onClick={saveMappingDraft}
              disabled={writeBlocked}
            >
              {writeBlocked ? "等待写入批准" : "保存草稿"}
            </Button>
          </header>
          <Table
            rowKey="key"
            columns={countryMappingColumns}
            dataSource={activeCountryMappings}
            pagination={false}
            size="small"
            scroll={{ x: 560 }}
          />
        </section>

        <section className="workspace-section mapping-section">
          <header className="section-header">
            <div>
              <span className="section-kicker">店长责任范围</span>
              <h2>来源店铺 → 国家 / 店长</h2>
              <p>未确认身份只作为来源观测，不生成“我的店铺”任务。</p>
            </div>
            <div className="mapping-actions">
              <Input
                prefix={<Search size={15} />}
                placeholder="搜索来源店铺"
                aria-label="搜索来源店铺"
                value={shopMappingSearch}
                onChange={(event) => setShopMappingSearch(event.target.value)}
              />
              <Button
                type="primary"
                icon={<CheckCircle2 size={16} />}
                onClick={saveMappingDraft}
                disabled={writeBlocked}
              >
                {writeBlocked ? "等待写入批准" : "保存草稿"}
              </Button>
            </div>
          </header>
          <Table
            rowKey="key"
            columns={shopMappingColumns}
            dataSource={activeShopMappings}
            pagination={false}
            size="small"
            scroll={{ x: 720 }}
          />
        </section>
      </>
    );
  }

  function renderActiveView() {
    switch (activeView) {
      case "stores":
        return renderStores();
      case "gaps":
        return renderGaps();
      case "map":
        return renderMap();
      case "products":
        return renderProducts();
      case "comparison":
        return renderComparison();
      case "tasks":
        return renderTasksView();
      case "monitoring":
        return renderTasksView(["MONITORING"]);
      case "resolved":
        return renderTasksView(["RESOLVED", "DISMISSED"]);
      case "settings":
        return renderSettings();
      default:
        return renderToday();
    }
  }

  return (
    <ConfigProvider
      getPopupContainer={() => popupContainer || document.body}
      theme={{
        algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm],
        token: {
          colorPrimary: "#1f6b5b",
          colorInfo: "#315d8c",
          colorSuccess: "#238561",
          colorWarning: "#c47f22",
          colorError: "#c94b4b",
          colorText: "#172033",
          colorTextSecondary: "#657186",
          colorBorder: "#dfe4ea",
          borderRadius: 6,
          fontFamily:
            '"Segoe UI Variable", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
          controlHeight: 36,
        },
        components: {
          Table: {
            headerBg: "#f4f6f8",
            headerColor: "#435065",
            rowHoverBg: "#f7faf9",
          },
          Segmented: {
            itemSelectedBg: "#ffffff",
          },
        },
      }}
    >
      {contextHolder}
      {!embedded && (
        <a className="skip-link" href="#growth-radar-content">
          跳到主要内容
        </a>
      )}
      <div className={`growth-radar-app ${embedded ? "is-embedded" : ""}`}>
        {!embedded && <Sidebar activeKey={activeView} onNavigate={navigate} />}

        {!embedded && <div className="mobile-topbar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setMobileNavigationOpen(true)}
            aria-label="打开导航"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div>
            <strong>Growth Radar</strong>
            <span>超级店长运营助手</span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => navigate("settings")}
            aria-label="打开数据配置"
          >
            <Settings2 size={19} aria-hidden="true" />
          </button>
        </div>}

        <main id="growth-radar-content" className="workspace-main">
          <header className="workspace-toolbar">
            <div className="workspace-title">
              <span className="eyebrow">Growth Radar V2.2</span>
              <h1>{viewMeta[activeView].title}</h1>
              <p>{viewMeta[activeView].description}</p>
            </div>

            <div className="toolbar-actions">
              {embedded ? (
                <Tag color="green" icon={<DatabaseZap size={14} aria-hidden="true" />}>
                  正式数据 / 门禁
                </Tag>
              ) : (
                <Segmented
                  value={dataMode}
                  onChange={(value) => setDataMode(value as DataMode)}
                  options={[
                    { value: "DEMO", label: "运营样例" },
                    { value: "READINESS", label: "真实数据门禁" },
                  ]}
                />
              )}
              <Tooltip title="分析日期">
                <DatePicker
                  value={analysisDate}
                  onChange={(value) => value && setAnalysisDate(value)}
                  allowClear={false}
                  suffixIcon={<CalendarDays size={15} />}
                />
              </Tooltip>
              <Select
                value={manager}
                onChange={setManager}
                options={managerOptions}
                aria-label="筛选店长"
              />
              <Select
                value={country}
                onChange={(value) => {
                  setCountry(value);
                  setSelectedCategory("ALL");
                }}
                options={countryOptions}
                aria-label="筛选国家"
              />
              <Select
                value={platform}
                onChange={setPlatform}
                options={[
                  { value: "ALL", label: "全部平台" },
                  { value: "SHOPEE", label: "Shopee" },
                  { value: "LAZADA", label: "Lazada" },
                  { value: "TIKTOK", label: "TikTok" },
                ]}
                aria-label="筛选平台"
              />
            </div>

            <div className="toolbar-meta">
              <span>
                <Clock3 size={14} aria-hidden="true" />
                数据更新：08:31
              </span>
              <span>
                <Layers3 size={14} aria-hidden="true" />
                GRV2-METRICS-1.2.0
              </span>
              <Badge
                status={
                  dataMode === "DEMO"
                    ? "processing"
                    : readinessSource === "API"
                      ? "warning"
                      : "default"
                }
                text={
                  dataMode === "DEMO"
                    ? "示例数据"
                    : readinessSource === "API"
                      ? "实时门禁"
                      : readinessSource === "LOADING"
                        ? "门禁加载中"
                        : "审计快照"
                }
              />
            </div>
          </header>

          {embedded && (
            <nav className="embedded-navigation" aria-label="Growth Radar 分析视图">
              {embeddedViews.map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  className={activeView === key ? "is-active" : ""}
                  aria-current={activeView === key ? "page" : undefined}
                  onClick={() => navigate(key)}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}

          <div className="workspace-body">{renderActiveView()}</div>
        </main>

        {!embedded && <Drawer
          title="Growth Radar 导航"
          placement="left"
          open={mobileNavigationOpen}
          onClose={() => setMobileNavigationOpen(false)}
          size={280}
          className="mobile-navigation-drawer"
        >
          <Sidebar activeKey={activeView} onNavigate={navigate} compact />
        </Drawer>}

        <Drawer
          title={selectedTask?.title ?? "任务详情"}
          placement="right"
          open={Boolean(selectedTask)}
          onClose={() => {
            setSelectedTask(null);
            setSelectedTaskEvents([]);
          }}
          size={520}
        >
          {selectedTask && (
            <div className="detail-drawer">
              <div className="detail-heading">
                <div>
                  <Tag
                    className={`priority-tag priority-tag--${selectedTask.priority.toLowerCase()}`}
                  >
                    {selectedTask.priority} · {priorityLabels[selectedTask.priority]}
                  </Tag>
                  <Tag>{statusLabels[selectedTask.status]}</Tag>
                </div>
                <p>
                  {selectedTask.shopName} · {selectedTask.countryName} ·{" "}
                  {platformLabels[selectedTask.platform]}
                </p>
              </div>

              <section className="detail-section">
                <span>发现</span>
                <p>{selectedTask.discovery}</p>
              </section>

              <section className="detail-section">
                <span>关键证据</span>
                <div className="evidence-grid">
                  {selectedTask.evidence.map((item) => (
                    <div key={item.label}>
                      <small>{item.label}</small>
                      <strong>{item.value}</strong>
                      {item.detail && <p>{item.detail}</p>}
                    </div>
                  ))}
                </div>
              </section>

              <section className="detail-section action-callout">
                <Target size={19} aria-hidden="true" />
                <div>
                  <span>建议动作</span>
                  <p>{selectedTask.recommendation}</p>
                </div>
              </section>

              <section className="detail-section detail-timeline">
                <span>任务轨迹</span>
                <dl>
                  <div><dt>首次发现</dt><dd>{selectedTask.firstSeen}</dd></div>
                  <div><dt>最近命中</dt><dd>{selectedTask.lastHit}</dd></div>
                  <div><dt>负责人</dt><dd>{selectedTask.manager}</dd></div>
                  <div><dt>涉及 SKU</dt><dd>{selectedTask.skuCount}</dd></div>
                  {selectedTask.snoozedUntil && (
                    <div>
                      <dt>复核时间</dt>
                      <dd>{dayjs(selectedTask.snoozedUntil).format("YYYY-MM-DD HH:mm")}</dd>
                    </div>
                  )}
                </dl>
              </section>

              {selectedTaskEvents.length > 0 && (
                <section className="detail-section">
                  <span>事件历史</span>
                  <ol className="task-event-list">
                    {selectedTaskEvents.map((event) => (
                      <li key={event.id}>
                        <i aria-hidden="true" />
                        <div>
                          <strong>
                            {taskEventLabels[event.eventType] || event.eventType}
                          </strong>
                          <p>
                            {dayjs(event.occurredAt).format("YYYY-MM-DD HH:mm")}
                            {" · "}
                            {event.actorType === "system" ? "系统" : event.actorUserId}
                          </p>
                          {event.note && <small>{event.note}</small>}
                        </div>
                        <Tag>v{event.taskRevision}</Tag>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <div className="drawer-actions">
                {taskTransitions[selectedTask.status].map((status, index) => (
                  <Button
                    key={status}
                    type={index === 0 ? "primary" : "default"}
                    icon={status === "ACKNOWLEDGED" || status === "RESOLVED"
                      ? <CheckCircle2 size={16} />
                      : status === "IN_PROGRESS" || status === "REOPENED"
                        ? <ArrowRight size={16} />
                        : undefined}
                    loading={taskActionSaving}
                    onClick={() => updateTaskStatus(selectedTask.id, status)}
                  >
                    {statusLabels[status]}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Drawer>

        <Modal
          title={syncEditor?.task ? "编辑每日马帮同步" : "新建每日马帮同步"}
          open={Boolean(syncEditor)}
          confirmLoading={syncEditorSaving}
          okText="保存任务"
          cancelText="取消"
          onOk={() => void confirmSyncEditor()}
          onCancel={() => !syncEditorSaving && setSyncEditor(null)}
          destroyOnHidden
        >
          {syncEditor && (
            <div className="sync-editor-form">
              <Alert
                type="info"
                showIcon
                title={syncEditor.taskType === "order_export"
                  ? "订单会按付款时间采集并写入超级店长助手事实层。"
                  : "库存会保存执行时点完整快照并写入超级店长助手事实层。"}
              />
              <label>
                <span>数据类型</span>
                <Select
                  value={syncEditor.taskType}
                  disabled={Boolean(syncEditor.task)}
                  options={[
                    { value: "order_export", label: "订单信息" },
                    { value: "inventory_export", label: "库存信息" },
                  ]}
                  onChange={(taskType: MabangSyncTaskType) => setSyncEditor({
                    ...syncEditor,
                    taskType,
                    name: taskType === "order_export"
                      ? "超级店长助手 · 每日订单"
                      : "超级店长助手 · 每日库存",
                  })}
                />
              </label>
              <label>
                <span>任务名称</span>
                <Input
                  value={syncEditor.name}
                  maxLength={80}
                  onChange={(event) => setSyncEditor({
                    ...syncEditor,
                    name: event.target.value,
                  })}
                />
              </label>
              <label>
                <span>马帮账号</span>
                <Select
                  value={syncEditor.accountProfileId || undefined}
                  placeholder="选择已验证账号"
                  options={(mabangSync?.accounts || []).map((account) => ({
                    value: account.id,
                    label: `${account.name} · ${account.usernameMasked}${account.enabled ? "" : "（已停用）"}`,
                    disabled: !account.enabled,
                  }))}
                  onChange={(accountProfileId) => setSyncEditor({
                    ...syncEditor,
                    accountProfileId,
                  })}
                />
              </label>
              <label>
                <span>每天执行时间</span>
                <TimePicker
                  value={syncEditor.time}
                  format="HH:mm"
                  minuteStep={5}
                  allowClear={false}
                  onChange={(time) => time && setSyncEditor({
                    ...syncEditor,
                    time,
                  })}
                />
              </label>
              {syncEditor.taskType === "order_export" && (
                <label>
                  <span>付款时间范围</span>
                  <Select
                    value={syncEditor.paymentDateMode}
                    options={[
                      { value: "yesterday", label: "昨天（推荐）" },
                      { value: "last_7_days", label: "最近 7 天" },
                      { value: "last_14_days", label: "最近 14 天" },
                      { value: "last_30_days", label: "最近 30 天" },
                    ]}
                    onChange={(paymentDateMode) => setSyncEditor({
                      ...syncEditor,
                      paymentDateMode,
                    })}
                  />
                </label>
              )}
              <label className="sync-editor-switch">
                <span>
                  <strong>保存后启用</strong>
                  <small>启用后由后台调度器按计划自动获取并入库。</small>
                </span>
                <Switch
                  checked={syncEditor.enabled}
                  onChange={(enabled) => setSyncEditor({
                    ...syncEditor,
                    enabled,
                  })}
                />
              </label>
            </div>
          )}
        </Modal>

        <Modal
          title={taskAction ? `更新任务：${statusLabels[taskAction.status]}` : "更新任务"}
          open={Boolean(taskAction)}
          confirmLoading={taskActionSaving}
          okText="确认更新"
          cancelText="取消"
          onOk={() => void confirmTaskAction()}
          onCancel={() => !taskActionSaving && setTaskAction(null)}
          destroyOnHidden
        >
          {taskAction && (
            <div className="task-action-form">
              <div>
                <span>任务</span>
                <strong>{taskAction.task.title}</strong>
              </div>
              {taskReasonOptions[taskAction.status] && (
                <label>
                  <span>处理原因</span>
                  <Select
                    value={taskActionReason}
                    options={taskReasonOptions[taskAction.status]}
                    onChange={setTaskActionReason}
                  />
                </label>
              )}
              {taskAction.status === "MONITORING" && (
                <label>
                  <span>复核时间</span>
                  <DatePicker
                    showTime
                    value={taskActionReviewAt}
                    onChange={setTaskActionReviewAt}
                    allowClear={false}
                  />
                </label>
              )}
              <label>
                <span>处理说明</span>
                <Input.TextArea
                  value={taskActionNote}
                  onChange={(event) => setTaskActionNote(event.target.value)}
                  placeholder="记录核查结果、后续动作或阻断信息"
                  maxLength={1000}
                  showCount
                  autoSize={{ minRows: 3, maxRows: 6 }}
                />
              </label>
            </div>
          )}
        </Modal>

        <Drawer
          title={selectedProduct ? `SKU ${selectedProduct.sku}` : "SKU 详情"}
          placement="right"
          open={Boolean(selectedProduct)}
          onClose={() => setSelectedProduct(null)}
          size={520}
        >
          {selectedProduct && (
            <div className="detail-drawer">
              <div className="detail-heading">
                <div>
                  <Tag color={directionMeta[selectedProduct.direction].color}>
                    {directionMeta[selectedProduct.direction].label}
                  </Tag>
                  <Tag>{trendLabel(selectedProduct.trendState)}</Tag>
                </div>
                <h2>{selectedProduct.name}</h2>
                <p>{selectedProduct.countryName} · {selectedProduct.category}</p>
              </div>

              <section className="detail-section">
                <span>货盘验证参考</span>
                <div className="evidence-grid">
                  <div><small>来源预测日销量</small><strong>{formatNumber(selectedProduct.predictedDailySales)}</strong></div>
                  <div><small>类目分位</small><strong>P{selectedProduct.marketPercentile}</strong></div>
                  <div><small>数据来源</small><strong>{selectedProduct.sourceLabel}</strong></div>
                </div>
              </section>

              <section className="detail-section">
                <span>我方表现</span>
                <div className="evidence-grid">
                  <div><small>近 28 天有效订单</small><strong>{formatNumber(selectedProduct.ownSales28d)}</strong></div>
                  <div><small>当前 7 天</small><strong>{formatNumber(selectedProduct.current7d)}</strong></div>
                  <div><small>前 7 天</small><strong>{formatNumber(selectedProduct.previous7d)}</strong></div>
                  <div><small>承接比</small><strong>{(selectedProduct.captureRatio * 100).toFixed(1)}%</strong></div>
                </div>
              </section>

              <section className="detail-section">
                <span>库存证据</span>
                <div className="evidence-grid">
                  <div><small>可用库存</small><strong>{formatNumber(selectedProduct.available)}</strong></div>
                  <div><small>在途量</small><strong>{formatNumber(selectedProduct.inbound)}</strong></div>
                  <div>
                    <small>可售天数</small>
                    <strong>
                      {selectedProduct.coverageDays === null
                        ? "国家层不聚合"
                        : `${selectedProduct.coverageDays} 天`}
                    </strong>
                  </div>
                </div>
              </section>

              <section className="detail-section formula-block">
                <span>结论边界</span>
                <p>来源预测日销量不是公司实际销量；近期无有效订单不代表未上架。蓝海与跨国候选必须先核查在线状态。</p>
              </section>
            </div>
          )}
        </Drawer>

        <Drawer
          title={selectedStore?.shopName ?? "店铺详情"}
          placement="right"
          open={Boolean(selectedStore)}
          onClose={() => setSelectedStore(null)}
          size={520}
        >
          {selectedStore && (
            <div className="detail-drawer">
              <div className="detail-heading">
                <Tag color={storeStateMeta[selectedStore.state].color}>
                  {storeStateMeta[selectedStore.state].label}
                </Tag>
                <h2>{selectedStore.shopName}</h2>
                <p>
                  {selectedStore.countryName} · {platformLabels[selectedStore.platform]} ·{" "}
                  {selectedStore.manager}
                </p>
              </div>
              <section className="detail-section">
                <span>销售趋势</span>
                <div className="evidence-grid">
                  <div><small>当前 7 天</small><strong>{formatNumber(selectedStore.current7d)}</strong></div>
                  <div><small>前 7 天</small><strong>{formatNumber(selectedStore.previous7d)}</strong></div>
                  <div><small>变化</small><strong>{formatPercent(selectedStore.trendPercent)}</strong></div>
                </div>
              </section>
              <section className="detail-section">
                <span>运营状态</span>
                <div className="evidence-grid">
                  <div><small>高表现货盘销售覆盖</small><strong>{selectedStore.highPerformanceCoverage}%</strong></div>
                  <div><small>活动任务</small><strong>{selectedStore.activeTaskCount}</strong></div>
                  <div><small>严重异常</small><strong>{selectedStore.severeAnomalyCount}</strong></div>
                </div>
              </section>
              <Button type="primary" block onClick={() => navigate("gaps")}>
                查看店铺缺口诊断
              </Button>
            </div>
          )}
        </Drawer>
      </div>
    </ConfigProvider>
  );
}

function BlockedWorkspace({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: () => void;
}) {
  return (
    <section className="blocked-workspace">
      <span className="blocked-workspace__icon" aria-hidden="true">
        <ShieldAlert size={28} />
      </span>
      <div>
        <span className="section-kicker">Fail closed</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <Button type="primary" icon={<Settings2 size={16} />} onClick={action}>
        打开数据配置
      </Button>
    </section>
  );
}

function RuleStep({
  index,
  title,
  detail,
}: {
  index: string;
  title: string;
  detail: string;
}) {
  return (
    <article>
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </article>
  );
}

function QuadrantGuide({
  tone,
  title,
  action,
  detail,
}: {
  tone: "danger" | "positive" | "info" | "muted";
  title: string;
  action: string;
  detail: string;
}) {
  const icons = {
    danger: Flame,
    positive: PackageCheck,
    info: Globe2,
    muted: Blocks,
  };
  const Icon = icons[tone];

  return (
    <article className="quadrant-guide__item" data-tone={tone}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <span>{title}</span>
        <strong>{action}</strong>
        <p>{detail}</p>
      </div>
      <ChevronRight size={15} aria-hidden="true" />
    </article>
  );
}
