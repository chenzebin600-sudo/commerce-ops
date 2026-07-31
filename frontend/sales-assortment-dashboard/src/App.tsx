import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  ConfigProvider,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  Tooltip,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { EChartsOption } from "echarts";
import {
  BellRing,
  Bot,
  Boxes,
  CalendarClock,
  ChartNoAxesCombined,
  CheckCircle2,
  CircleDollarSign,
  Database,
  FileSpreadsheet,
  FilterX,
  Gauge,
  PackageSearch,
  Pencil,
  Play,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Sparkles,
  Trash2,
  Upload,
  Webhook,
} from "lucide-react";
import {
  analyzeDashboard,
  applyImport,
  deleteDingtalkConfig,
  loadAiStatus,
  loadAutomationOverview,
  loadDashboard,
  previewImport,
  runSyncTask,
  saveDailySyncTask,
  saveDingtalkConfig,
  setSyncTaskEnabled,
  testDingtalkConfig,
  type ImportPreview,
} from "./api";
import { EChart } from "./EChart";
import type {
  AutomationOverview,
  DashboardData,
  DingtalkConfig,
  MabangScheduledTask,
  MabangSyncTaskType,
  ProductRow,
  SalesAssortmentAnalysis,
  SalesAssortmentAiStatus,
  StoreRow,
} from "./types";

const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function compactMoney(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function dateTime(value?: string | null) {
  if (!value) return "尚未导入";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function timeValue(task?: MabangScheduledTask | null) {
  const hour = task?.scheduleConfig.hour ?? (task?.taskType === "inventory_export" ? 8 : 7);
  const minute = task?.scheduleConfig.minute ?? 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function runStatusLabel(value?: string | null) {
  const labels: Record<string, string> = {
    pending: "排队中",
    running: "执行中",
    success: "成功",
    failed: "失败",
    empty: "无数据",
  };
  return value ? labels[value] || value : "尚未执行";
}

function SourceCard({
  title,
  description,
  source,
  icon,
  onImport,
  busy,
}: {
  title: string;
  description: string;
  source?: DashboardData["sourceStatus"]["order"];
  icon: React.ReactNode;
  onImport: () => void;
  busy: boolean;
}) {
  return (
    <article className="source-card">
      <span className="source-icon" aria-hidden="true">{icon}</span>
      <div className="source-copy">
        <strong>{title}</strong>
        <span>{description}</span>
        <small>{source ? `${integer.format(source.row_count || 0)} 行 · ${dateTime(source.collected_at || source.applied_at || source.imported_at)}` : "等待首次导入"}</small>
      </div>
      <Tooltip title={`导入${title}`}>
        <Button
          type="text"
          className="icon-action"
          icon={<Upload size={17} />}
          aria-label={`导入${title}`}
          loading={busy}
          onClick={onImport}
        />
      </Tooltip>
    </article>
  );
}

function Metric({
  label,
  value,
  note,
  icon,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <article className={`metric ${tone}`}>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
      <i aria-hidden="true">{icon}</i>
    </article>
  );
}

export default function App({ popupContainer }: { popupContainer?: HTMLElement }) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [periodDays, setPeriodDays] = useState(7);
  const [country, setCountry] = useState("");
  const [categoryL1, setCategoryL1] = useState("");
  const [categoryL2, setCategoryL2] = useState("");
  const [style, setStyle] = useState("");
  const [importBusy, setImportBusy] = useState<ImportPreview["kind"] | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [automation, setAutomation] = useState<AutomationOverview | null>(null);
  const [automationLoading, setAutomationLoading] = useState(true);
  const [automationError, setAutomationError] = useState("");
  const [taskActionId, setTaskActionId] = useState<string | null>(null);
  const [taskEditorSaving, setTaskEditorSaving] = useState(false);
  const [taskEditor, setTaskEditor] = useState<{
    task: MabangScheduledTask | null;
    taskType: MabangSyncTaskType;
    name: string;
    accountProfileId: string;
    time: string;
    paymentDateMode: string;
    dingtalkConfigId: string;
    notifyEnabled: boolean;
    enabled: boolean;
  } | null>(null);
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  const [dingtalkSaving, setDingtalkSaving] = useState(false);
  const [dingtalkActionId, setDingtalkActionId] = useState<string | null>(null);
  const [dingtalkEditor, setDingtalkEditor] = useState<{
    config: DingtalkConfig | null;
    name: string;
    webhookUrl: string;
    secret: string;
    atMobiles: string;
    enabled: boolean;
    notifyOnSuccess: boolean;
    notifyOnFailure: boolean;
    notifyOnEmpty: boolean;
    atAll: boolean;
  }>({
    config: null,
    name: "",
    webhookUrl: "",
    secret: "",
    atMobiles: "",
    enabled: true,
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnEmpty: true,
    atAll: false,
  });
  const [aiStatus, setAiStatus] = useState<SalesAssortmentAiStatus | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<SalesAssortmentAnalysis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const fileKindRef = useRef<ImportPreview["kind"]>("orders");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDashboard(await loadDashboard({ periodDays, country, categoryL1, categoryL2, style }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "驾驶舱数据加载失败。");
    } finally {
      setLoading(false);
    }
  }, [periodDays, country, categoryL1, categoryL2, style]);

  const refreshAutomation = useCallback(async (signal?: AbortSignal) => {
    setAutomationLoading(true);
    setAutomationError("");
    try {
      setAutomation(await loadAutomationOverview(signal));
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === "AbortError") return;
      setAutomationError(nextError instanceof Error ? nextError.message : "自动采集状态读取失败。");
    } finally {
      setAutomationLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshAutomation(controller.signal);
    void loadAiStatus(controller.signal)
      .then(setAiStatus)
      .catch((nextError) => {
        if (nextError instanceof DOMException && nextError.name === "AbortError") return;
        setAiError(nextError instanceof Error ? nextError.message : "DeepSeek 状态读取失败。");
      });
    const timer = window.setInterval(() => void refreshAutomation(), 20_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refreshAutomation]);

  useEffect(() => {
    if (!dashboard || !aiStatus?.configured) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setAiLoading(true);
      setAiError("");
      try {
        setAiAnalysis(await analyzeDashboard({
          periodDays,
          country,
          categoryL1,
          categoryL2,
          style,
        }, controller.signal));
      } catch (nextError) {
        if (nextError instanceof DOMException && nextError.name === "AbortError") return;
        setAiError(nextError instanceof Error ? nextError.message : "DeepSeek 自动分析失败。");
      } finally {
        if (!controller.signal.aborted) setAiLoading(false);
      }
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [dashboard, aiStatus?.configured, periodDays, country, categoryL1, categoryL2, style]);

  function openTaskEditor(taskType: MabangSyncTaskType, task: MabangScheduledTask | null = null) {
    const account = automation?.accounts.find((item) => item.enabled);
    setTaskEditor({
      task,
      taskType,
      name: task?.name || (taskType === "order_export"
        ? "销售与货盘 · 每日订单"
        : "销售与货盘 · 每日库存"),
      accountProfileId: task?.accountProfileId || account?.id || "",
      time: timeValue(task || { taskType } as MabangScheduledTask),
      paymentDateMode: task?.paymentDateMode || "yesterday",
      dingtalkConfigId: task?.dingtalkConfigId || "",
      notifyEnabled: task?.notifyEnabled ?? Boolean(automation?.dingtalkConfigs.length),
      enabled: task?.enabled ?? true,
    });
  }

  async function confirmTaskEditor() {
    if (!taskEditor) return;
    if (!taskEditor.name.trim() || !taskEditor.accountProfileId) {
      messageApi.warning("请填写任务名称并选择可用的马帮账号。");
      return;
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(taskEditor.time)) {
      messageApi.warning("请选择有效的每日执行时间。");
      return;
    }
    setTaskEditorSaving(true);
    try {
      await saveDailySyncTask({ ...taskEditor, name: taskEditor.name.trim() });
      messageApi.success(taskEditor.task ? "定时采集任务已更新。" : "定时采集任务已创建。");
      setTaskEditor(null);
      await refreshAutomation();
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "任务保存失败。");
    } finally {
      setTaskEditorSaving(false);
    }
  }

  async function toggleTask(task: MabangScheduledTask) {
    setTaskActionId(task.id);
    try {
      await setSyncTaskEnabled(task.id, !task.enabled);
      messageApi.success(task.enabled ? "定时采集已停用。" : "定时采集已启用。");
      await refreshAutomation();
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "任务状态更新失败。");
    } finally {
      setTaskActionId(null);
    }
  }

  async function runTaskNow(task: MabangScheduledTask) {
    setTaskActionId(task.id);
    try {
      const result = await runSyncTask(task.id);
      messageApi.success(`任务已进入后台队列：${String(result.runId || "").slice(0, 8)}`);
      await refreshAutomation();
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "任务提交失败。");
    } finally {
      setTaskActionId(null);
    }
  }

  function resetDingtalkEditor(config: DingtalkConfig | null = null) {
    setDingtalkEditor({
      config,
      name: config?.name || "",
      webhookUrl: "",
      secret: "",
      atMobiles: (config?.atMobiles || []).join(", "),
      enabled: config?.enabled ?? true,
      notifyOnSuccess: config?.notifyOnSuccess ?? true,
      notifyOnFailure: config?.notifyOnFailure ?? true,
      notifyOnEmpty: config?.notifyOnEmpty ?? true,
      atAll: config?.atAll ?? false,
    });
  }

  async function confirmDingtalkEditor() {
    if (!dingtalkEditor.name.trim()) {
      messageApi.warning("请填写机器人名称。");
      return;
    }
    if (!dingtalkEditor.config && !dingtalkEditor.webhookUrl.trim()) {
      messageApi.warning("请填写钉钉机器人 Webhook。");
      return;
    }
    setDingtalkSaving(true);
    try {
      await saveDingtalkConfig({ ...dingtalkEditor, name: dingtalkEditor.name.trim() });
      messageApi.success(dingtalkEditor.config ? "机器人配置已更新。" : "机器人配置已创建。");
      resetDingtalkEditor();
      await refreshAutomation();
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "机器人配置保存失败。");
    } finally {
      setDingtalkSaving(false);
    }
  }

  async function testRobot(config: DingtalkConfig) {
    setDingtalkActionId(config.id);
    try {
      await testDingtalkConfig(config.id);
      messageApi.success("钉钉测试消息发送成功。");
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "机器人测试失败。");
    } finally {
      setDingtalkActionId(null);
    }
  }

  async function removeRobot(config: DingtalkConfig) {
    setDingtalkActionId(config.id);
    try {
      await deleteDingtalkConfig(config.id);
      messageApi.success("机器人配置已删除。");
      if (dingtalkEditor.config?.id === config.id) resetDingtalkEditor();
      await refreshAutomation();
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "机器人删除失败。");
    } finally {
      setDingtalkActionId(null);
    }
  }

  async function refreshAiAnalysis() {
    if (!aiStatus?.configured) return;
    setAiLoading(true);
    setAiError("");
    try {
      setAiAnalysis(await analyzeDashboard({
        periodDays,
        country,
        categoryL1,
        categoryL2,
        style,
        forceRefresh: true,
      }));
      messageApi.success("DeepSeek 已重新分析当前数据。");
    } catch (nextError) {
      setAiError(nextError instanceof Error ? nextError.message : "DeepSeek 分析失败。");
    } finally {
      setAiLoading(false);
    }
  }

  function chooseFile(kind: ImportPreview["kind"]) {
    fileKindRef.current = kind;
    fileInputRef.current?.click();
  }

  async function onFileSelected(file?: File) {
    if (!file) return;
    const kind = fileKindRef.current;
    setImportBusy(kind);
    try {
      const result = await previewImport(kind, file);
      setPreview(result);
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "文件校验失败。");
    } finally {
      setImportBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setApplying(true);
    try {
      await applyImport(preview);
      messageApi.success(`${preview.filename} 已完成入库`);
      setPreview(null);
      await refresh();
    } catch (nextError) {
      messageApi.error(nextError instanceof Error ? nextError.message : "导入失败。");
    } finally {
      setApplying(false);
    }
  }

  function clearFilters() {
    setCountry("");
    setCategoryL1("");
    setCategoryL2("");
    setStyle("");
  }

  const trendOption = useMemo<EChartsOption>(() => ({
    color: ["#176f5b", "#db8b30", "#3269a8"],
    tooltip: { trigger: "axis", valueFormatter: (value) => money.format(Number(value || 0)) },
    legend: { top: 0, data: ["我方标准化销售额", "货盘日均基准", "我方销量"], textStyle: { color: "#68758a" } },
    grid: { left: 16, right: 24, top: 42, bottom: 12, containLabel: true },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: dashboard?.trend.map((item) => item.date.slice(5)) || [],
      axisLine: { lineStyle: { color: "#dce2e8" } },
      axisLabel: { color: "#7a8797" },
    },
    yAxis: [
      {
        type: "value",
        axisLabel: { formatter: (value: number) => `${Math.round(value / 1000)}k`, color: "#7a8797" },
        splitLine: { lineStyle: { color: "#edf0f3" } },
      },
      {
        type: "value",
        axisLabel: { color: "#7a8797" },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "我方标准化销售额",
        type: "line",
        smooth: 0.25,
        symbolSize: 7,
        areaStyle: { color: "rgba(23,111,91,.08)" },
        data: dashboard?.trend.map((item) => item.ownAmount) || [],
      },
      {
        name: "货盘日均基准",
        type: "line",
        smooth: true,
        symbol: "none",
        lineStyle: { type: "dashed", width: 2 },
        data: dashboard?.trend.map((item) => item.assortmentDailyAmount) || [],
      },
      {
        name: "我方销量",
        type: "bar",
        yAxisIndex: 1,
        barMaxWidth: 18,
        data: dashboard?.trend.map((item) => item.ownQuantity) || [],
      },
    ],
  }), [dashboard]);

  const hierarchyOption = useMemo<EChartsOption>(() => {
    const rows = (dashboard?.hierarchy.rows || []).slice(0, 12).reverse();
    return {
      color: ["#176f5b", "#f0b14b"],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          return `${items[0]?.name || ""}<br/>${items.map((item: any) => `${item.marker}${item.seriesName}：${money.format(Number(item.value || 0))}`).join("<br/>")}`;
        },
      },
      legend: { top: 0, data: ["货盘标准化销售额", "我方标准化销售额"], textStyle: { color: "#68758a" } },
      grid: { left: 12, right: 24, top: 42, bottom: 8, containLabel: true },
      xAxis: { type: "value", axisLabel: { formatter: (value: number) => `${Math.round(value / 1000)}k` }, splitLine: { lineStyle: { color: "#edf0f3" } } },
      yAxis: { type: "category", data: rows.map((row) => row.label), axisLabel: { width: 100, overflow: "truncate", color: "#526071" }, axisTick: { show: false } },
      series: [
        { name: "货盘标准化销售额", type: "bar", data: rows.map((row) => row.assortmentAmount), barMaxWidth: 12, itemStyle: { borderRadius: [0, 3, 3, 0] } },
        { name: "我方标准化销售额", type: "bar", data: rows.map((row) => row.ownAmount), barMaxWidth: 12, itemStyle: { borderRadius: [0, 3, 3, 0] } },
      ],
    };
  }, [dashboard]);

  const scatterOption = useMemo<EChartsOption>(() => ({
    color: ["#287e91"],
    tooltip: {
      formatter: (params: any) => {
        const value = params.data?.value || [];
        return `<strong>${params.data?.name || ""}</strong><br/>货盘：${money.format(value[0] || 0)}<br/>我方：${money.format(value[1] || 0)}<br/>占比：${value[2] || 0}%`;
      },
    },
    grid: { left: 16, right: 24, top: 24, bottom: 14, containLabel: true },
    xAxis: { name: "货盘标准化销售额", type: "log", axisLabel: { formatter: (value: number) => `${Math.round(value / 1000)}k` }, splitLine: { lineStyle: { color: "#edf0f3" } } },
    yAxis: { name: "我方标准化销售额", type: "log", axisLabel: { formatter: (value: number) => `${Math.round(value / 1000)}k` }, splitLine: { lineStyle: { color: "#edf0f3" } } },
    series: [{
      type: "scatter",
      symbolSize: (value: number[]) => Math.max(8, Math.min(26, Math.sqrt(value[0] || 0) / 12)),
      data: (dashboard?.topProducts || []).slice(0, 45).filter((item) => item.assortmentAmount > 0 && item.ownAmount > 0).map((item) => ({
        name: item.productName,
        value: [item.assortmentAmount, item.ownAmount, item.ownShare],
        itemStyle: { color: item.ownShare < 10 ? "#d8664d" : item.ownShare < 30 ? "#d99a37" : "#2b8b68" },
      })),
    }],
  }), [dashboard]);

  const heatmapOption = useMemo<EChartsOption>(() => {
    const matrix = dashboard?.opportunityMatrix || [];
    const countries = [...new Set(matrix.map((item) => item.country))].slice(0, 8);
    const categories = [...new Set(matrix.sort((a, b) => b.assortmentAmount - a.assortmentAmount).map((item) => item.category))].slice(0, 10);
    return {
      tooltip: {
        formatter: (params: any) => {
          const item = matrix.find((row) => row.country === countries[params.value?.[1]] && row.category === categories[params.value?.[0]]);
          return item ? `<strong>${item.country} · ${item.category}</strong><br/>货盘：${money.format(item.assortmentAmount)}<br/>我方占比：${item.ownShare}%<br/>机会缺口：${item.opportunityScore}` : "";
        },
      },
      grid: { left: 12, right: 24, top: 16, bottom: 12, containLabel: true },
      xAxis: { type: "category", data: categories, splitArea: { show: true }, axisLabel: { rotate: 25, color: "#526071" } },
      yAxis: { type: "category", data: countries, splitArea: { show: true }, axisLabel: { color: "#526071" } },
      visualMap: {
        min: 0,
        max: 100,
        calculable: false,
        orient: "horizontal",
        left: "center",
        top: 0,
        show: false,
        inRange: { color: ["#e8f3ef", "#f3ca78", "#d8664d"] },
      },
      series: [{
        type: "heatmap",
        data: matrix.filter((item) => countries.includes(item.country) && categories.includes(item.category)).map((item) => [
          categories.indexOf(item.category),
          countries.indexOf(item.country),
          item.opportunityScore,
        ]),
        label: { show: true, formatter: (params: any) => `${params.value?.[2] || 0}`, color: "#243044" },
        itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 3 },
      }],
    };
  }, [dashboard]);

  const productColumns: ColumnsType<ProductRow> = [
    {
      title: "产品 / 款名",
      key: "product",
      width: 270,
      render: (_, item) => (
        <div className="table-primary">
          <strong>{item.productName}</strong>
          <span>{item.country} · {item.categoryL1} / {item.categoryL2}</span>
          <small>{item.style} · {item.mainSku}</small>
        </div>
      ),
    },
    { title: "货盘销量", dataIndex: "assortmentQuantity", align: "right", sorter: (a, b) => a.assortmentQuantity - b.assortmentQuantity, render: integer.format },
    { title: "我方销量", dataIndex: "ownQuantity", align: "right", sorter: (a, b) => a.ownQuantity - b.ownQuantity, render: integer.format },
    { title: "我方占比", dataIndex: "ownShare", align: "right", sorter: (a, b) => a.ownShare - b.ownShare, render: (value: number) => <strong className={value < 10 ? "danger-text" : "positive-text"}>{value}%</strong> },
    { title: "预测日销差", dataIndex: "dailySalesGap", align: "right", sorter: (a, b) => a.dailySalesGap - b.dailySalesGap, render: (value: number) => integer.format(value) },
    { title: "可用 / 在途", key: "stock", align: "right", render: (_, item) => <span>{integer.format(item.availableQuantity)} / {integer.format(item.inTransitQuantity)}</span> },
    {
      title: "信号",
      key: "signal",
      width: 160,
      render: (_, item) => (
        <div className="tag-row">
          <Tag color={item.ownShare < 10 && item.availableQuantity > 0 ? "volcano" : "green"}>
            {item.ownShare < 10 && item.availableQuantity > 0 ? "优先补覆盖" : "持续经营"}
          </Tag>
          {item.isNew && <Tag color="blue">新品</Tag>}
        </div>
      ),
    },
  ];

  const storeColumns: ColumnsType<StoreRow> = [
    {
      title: "店铺",
      key: "store",
      width: 230,
      render: (_, item) => (
        <div className="table-primary">
          <strong>{item.store}</strong>
          <span>{item.country} · {item.platform.toUpperCase()}</span>
          <small>店长：{item.manager}</small>
        </div>
      ),
    },
    { title: "标准化销售额", dataIndex: "ownAmount", align: "right", sorter: (a, b) => a.ownAmount - b.ownAmount, render: (value: number) => money.format(value) },
    { title: "销量", dataIndex: "ownQuantity", align: "right", sorter: (a, b) => a.ownQuantity - b.ownQuantity, render: integer.format },
    { title: "国家货盘占比", dataIndex: "countryShare", align: "right", sorter: (a, b) => a.countryShare - b.countryShare, render: (value: number) => `${value}%` },
    { title: "优势品类", dataIndex: "strength", render: (value: string) => <Tag color="green">{value}</Tag> },
    { title: "待补方向", dataIndex: "weakness", render: (value: string) => <Tag color="orange">{value}</Tag> },
    {
      title: "机会点",
      key: "opportunity",
      width: 220,
      render: (_, item) => (
        <Tooltip title={item.opportunityProducts.join("、") || "暂无明确机会"}>
          <span className="opportunity-cell">{item.opportunityCount} 个 · {item.opportunityProducts.slice(0, 1).join("") || "待积累数据"}</span>
        </Tooltip>
      ),
    },
  ];

  const source = dashboard?.sourceStatus;
  const summary = dashboard?.summary;
  const syncTasks = automation?.tasks || [];
  const latestRunsByTask = new Map<string, AutomationOverview["runs"][number]>();
  for (const run of automation?.runs || []) {
    if (!latestRunsByTask.has(run.taskId)) latestRunsByTask.set(run.taskId, run);
  }
  const popup = popupContainer || document.body;

  return (
    <ConfigProvider
      getPopupContainer={() => popup}
      theme={{
        token: {
          colorPrimary: "#176f5b",
          colorInfo: "#3269a8",
          colorSuccess: "#2b8b68",
          colorWarning: "#c47b25",
          colorError: "#c95347",
          borderRadius: 6,
          fontFamily: '"Segoe UI Variable", "Microsoft YaHei", system-ui, sans-serif',
        },
      }}
    >
      {contextHolder}
      <main className="dashboard-shell">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          onChange={(event) => onFileSelected(event.target.files?.[0])}
        />

        <header className="dashboard-header">
          <div>
            <span className="eyebrow">SALES & ASSORTMENT</span>
            <h2>销售与货盘驾驶舱</h2>
            <p>用统一标价比较货盘表现与我方承接，快速定位国家、类目、款名和店铺机会。</p>
          </div>
          <div className="header-meta">
            <Tag color="green">最新数据</Tag>
            <span>{dashboard?.contract.version || "SALES-ASSORTMENT-1.0.0"}</span>
            <Tooltip title="刷新驾驶舱">
              <Button type="text" className="icon-action" icon={<RefreshCw size={18} />} aria-label="刷新驾驶舱" loading={loading} onClick={refresh} />
            </Tooltip>
          </div>
        </header>

        <section className="automation-hub" aria-label="自动采集与智能分析">
          <header className="automation-header">
            <div>
              <span className="eyebrow">AUTOMATION & AI</span>
              <h3>自动采集与智能分析</h3>
              <p>沿用马帮数据调度器获取订单和库存；成功入库后，DeepSeek 会按当前筛选自动生成可核对的经营结论。</p>
            </div>
            <div className="automation-actions">
              <Badge
                status={automation?.scheduler.online ? "success" : "error"}
                text={automation?.scheduler.online ? "调度器在线" : "调度器离线"}
              />
              <Button icon={<Webhook size={16} />} onClick={() => setDingtalkOpen(true)}>
                钉钉机器人
              </Button>
              <Button
                icon={<CalendarClock size={16} />}
                disabled={!automation?.accounts.some((item) => item.enabled)}
                onClick={() => openTaskEditor("order_export")}
              >
                订单定时
              </Button>
              <Button
                type="primary"
                icon={<Database size={16} />}
                disabled={!automation?.accounts.some((item) => item.enabled)}
                onClick={() => openTaskEditor("inventory_export")}
              >
                库存定时
              </Button>
            </div>
          </header>

          {automationError && (
            <Alert
              type="error"
              showIcon
              message="自动采集状态不可用"
              description={automationError}
              action={<Button onClick={() => void refreshAutomation()}>重试</Button>}
            />
          )}
          {!automationError && automation && !automation.scheduler.online && (
            <Alert
              type="warning"
              showIcon
              message="后台调度器离线"
              description="任务配置仍可维护，但不会自动执行；启动完整 Commerce Ops 服务后会恢复。"
            />
          )}

          <div className="automation-grid">
            <div className="sync-console">
              <div className="console-heading">
                <div>
                  <BellRing size={18} />
                  <span>订单与库存定时采集</span>
                </div>
                <Tooltip title="刷新任务与执行状态">
                  <Button
                    type="text"
                    className="icon-action"
                    icon={<RefreshCw size={16} />}
                    loading={automationLoading}
                    aria-label="刷新自动采集状态"
                    onClick={() => void refreshAutomation()}
                  />
                </Tooltip>
              </div>

              <div className="task-list">
                {syncTasks.map((task) => {
                  const latestRun = latestRunsByTask.get(task.id);
                  return (
                    <article className="task-row" key={task.id}>
                      <span className={`task-kind ${task.taskType}`}>
                        {task.taskType === "order_export" ? <ShoppingBag size={17} /> : <Boxes size={17} />}
                      </span>
                      <div className="task-main">
                        <div className="task-title">
                          <strong>{task.name}</strong>
                          <Tag color={task.enabled ? "success" : "default"}>{task.enabled ? "已启用" : "已停用"}</Tag>
                        </div>
                        <span>
                          每日 {timeValue(task)} · {task.accountName} {task.accountUsernameMasked}
                          {task.notifyEnabled && task.dingtalkConfigId ? ` · 钉钉 ${task.dingtalkName || "已启用"}` : ""}
                        </span>
                        <small>
                          上次 {dateTime(task.lastRunAt)} · {runStatusLabel(latestRun?.status || task.lastRunStatus)}
                          {task.nextRunAt ? ` · 下次 ${dateTime(task.nextRunAt)}` : ""}
                        </small>
                      </div>
                      <div className="task-actions">
                        <Tooltip title="编辑任务">
                          <Button
                            aria-label={`编辑${task.name}`}
                            icon={<Pencil size={15} />}
                            onClick={() => openTaskEditor(task.taskType, task)}
                          />
                        </Tooltip>
                        <Tooltip title={automation?.scheduler.online ? "立即执行一次" : "调度器离线"}>
                          <Button
                            aria-label={`立即执行${task.name}`}
                            icon={<Play size={15} />}
                            disabled={!automation?.scheduler.online}
                            loading={taskActionId === task.id}
                            onClick={() => void runTaskNow(task)}
                          />
                        </Tooltip>
                        <Button loading={taskActionId === task.id} onClick={() => void toggleTask(task)}>
                          {task.enabled ? "停用" : "启用"}
                        </Button>
                      </div>
                    </article>
                  );
                })}
                {!automationLoading && !syncTasks.length && (
                  <div className="task-empty">
                    <CalendarClock size={22} />
                    <div>
                      <strong>尚未创建自动采集任务</strong>
                      <span>建议订单每天早晨获取昨天数据，库存随后获取最新快照。</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="ai-console">
              <div className="console-heading">
                <div>
                  <Bot size={18} />
                  <span>DeepSeek 经营分析</span>
                </div>
                <div className="ai-meta">
                  <Badge
                    status={aiStatus?.configured ? "success" : "default"}
                    text={aiStatus?.configured ? aiStatus.model : "未配置"}
                  />
                  <Tooltip title="重新分析当前筛选">
                    <Button
                      type="text"
                      className="icon-action"
                      icon={<Sparkles size={16} />}
                      loading={aiLoading}
                      disabled={!aiStatus?.configured || !dashboard}
                      aria-label="重新执行 DeepSeek 分析"
                      onClick={() => void refreshAiAnalysis()}
                    />
                  </Tooltip>
                </div>
              </div>

              {!aiStatus?.configured ? (
                <div className="ai-empty">
                  <Settings2 size={22} />
                  <div>
                    <strong>等待 DeepSeek 配置</strong>
                    <span>在服务端配置 DEEPSEEK_API_KEY 后，本区域会自动分析最新数据。</span>
                  </div>
                </div>
              ) : aiError ? (
                <Alert
                  type="error"
                  showIcon
                  message="DeepSeek 分析暂不可用"
                  description={aiError}
                  action={<Button onClick={() => void refreshAiAnalysis()}>重试</Button>}
                />
              ) : aiLoading && !aiAnalysis ? (
                <div className="ai-empty">
                  <Sparkles className="spin-soft" size={22} />
                  <div>
                    <strong>正在分析最新数据</strong>
                    <span>只发送聚合指标、产品机会和店铺表现，不发送客户信息。</span>
                  </div>
                </div>
              ) : aiAnalysis ? (
                <div className="ai-result">
                  <div className="ai-summary">
                    <strong>{aiAnalysis.analysis.headline}</strong>
                    <p>{aiAnalysis.analysis.overview}</p>
                  </div>
                  <div className="recommendation-list">
                    {aiAnalysis.analysis.recommendations.slice(0, 3).map((item, index) => (
                      <article key={`${item.title}-${index}`}>
                        <Tag color={item.priority === "P0" ? "red" : item.priority === "P1" ? "orange" : "blue"}>
                          {item.priority}
                        </Tag>
                        <div>
                          <strong>{item.title}</strong>
                          <span>{item.action}</span>
                          <small>{item.evidence.slice(0, 2).join(" · ") || item.reason}</small>
                        </div>
                      </article>
                    ))}
                  </div>
                  <footer>
                    <span>{dateTime(aiAnalysis.generatedAt)} · {aiAnalysis.cached ? "复用同源分析" : "本次生成"}</span>
                    <span>{aiAnalysis.promptVersion}</span>
                  </footer>
                </div>
              ) : (
                <div className="ai-empty">
                  <Sparkles size={22} />
                  <div>
                    <strong>等待看板数据</strong>
                    <span>看板加载后会自动分析当前国家、类目和款名范围。</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="source-strip" aria-label="数据导入">
          <SourceCard title="订单表" description="每日追加有效订单" source={source?.order} icon={<ShoppingBag size={20} />} busy={importBusy === "orders"} onImport={() => chooseFile("orders")} />
          <SourceCard title="库存表" description="最新快照替换当前视图" source={source?.inventory} icon={<Boxes size={20} />} busy={importBusy === "inventory"} onImport={() => chooseFile("inventory")} />
          <SourceCard title="产品包" description="最新产品合同与标准价" source={source?.productPackage} icon={<FileSpreadsheet size={20} />} busy={importBusy === "product-package"} onImport={() => chooseFile("product-package")} />
        </section>

        <section className="filter-bar" aria-label="驾驶舱筛选">
          <div className="filter-period">
            <span>观察周期</span>
            <Segmented<number> value={periodDays} options={[{ label: "近7天", value: 7 }, { label: "近28天", value: 28 }, { label: "近42天", value: 42 }]} onChange={setPeriodDays} />
          </div>
          <Select allowClear showSearch value={country || undefined} placeholder="全部国家" options={dashboard?.filters.options.countries.map((value) => ({ label: value, value }))} onChange={(value) => { setCountry(value || ""); setCategoryL1(""); setCategoryL2(""); setStyle(""); }} />
          <Select allowClear showSearch value={categoryL1 || undefined} placeholder="全部一级类目" options={dashboard?.filters.options.categoryL1.map((value) => ({ label: value, value }))} onChange={(value) => { setCategoryL1(value || ""); setCategoryL2(""); setStyle(""); }} />
          <Select allowClear showSearch value={categoryL2 || undefined} placeholder="全部二级类目" options={dashboard?.filters.options.categoryL2.map((value) => ({ label: value, value }))} onChange={(value) => { setCategoryL2(value || ""); setStyle(""); }} />
          <Select allowClear showSearch value={style || undefined} placeholder="全部款名" options={dashboard?.filters.options.styles.map((value) => ({ label: value, value }))} onChange={(value) => setStyle(value || "")} />
          <Tooltip title="清空筛选">
            <Button type="text" className="icon-action" icon={<FilterX size={18} />} aria-label="清空筛选" onClick={clearFilters} />
          </Tooltip>
        </section>

        {error && <Alert type="error" showIcon message="驾驶舱暂时不可用" description={error} action={<Button onClick={refresh}>重试</Button>} />}
        {!error && dashboard?.period && !dashboard.period.sufficient && (
          <Alert
            type="warning"
            showIcon
            message={`我方订单仅覆盖 ${dashboard.period.availableOrderDays} 天，当前选择 ${dashboard.period.days} 天`}
            description="货盘窗口完整，但我方占比可能偏低；继续积累每日订单后会自动变为完整口径。"
          />
        )}

        <section className="metric-grid" aria-label="核心指标">
          <Metric label="货盘标准化销售额" value={compactMoney(summary?.assortmentAmount || 0)} note={`${periodDays}天 · ${integer.format(summary?.assortmentQuantity || 0)} 件`} icon={<ChartNoAxesCombined size={22} />} tone="assortment" />
          <Metric label="我方标准化销售额" value={compactMoney(summary?.ownAmount || 0)} note={`${integer.format(summary?.ownQuantity || 0)} 件有效订单`} icon={<CircleDollarSign size={22} />} tone="own" />
          <Metric label="我方承接占比" value={`${summary?.ownShare || 0}%`} note="同一标准价横向比较" icon={<Gauge size={22} />} tone="share" />
          <Metric label="预测日销缺口" value={integer.format(summary?.dailySalesGap || 0)} note="货盘预测日销 - 我方日均" icon={<PackageSearch size={22} />} tone="gap" />
          <Metric label="可用库存" value={integer.format(summary?.availableQuantity || 0)} note={`在途 ${integer.format(summary?.inTransitQuantity || 0)}`} icon={<Database size={22} />} tone="stock" />
        </section>

        {!loading && dashboard && dashboard.summary.productCount === 0 ? (
          <Empty description="当前筛选没有可展示的数据" />
        ) : (
          <>
            <section className="visual-grid">
              <article className="visual-panel wide">
                <div className="section-heading">
                  <div><span>经营走势</span><h3>我方承接与货盘日均基准</h3></div>
                  <small>{dashboard?.period.orderDateFrom || "-"} 至 {dashboard?.period.orderDateTo || "-"}</small>
                </div>
                <EChart option={trendOption} ariaLabel="每日我方销售额、货盘日均基准与我方销量趋势图" />
              </article>
              <article className="visual-panel">
                <div className="section-heading">
                  <div><span>逐级拆解</span><h3>当前维度业绩对比</h3></div>
                  <Tag>{dashboard?.hierarchy.dimension || "country"}</Tag>
                </div>
                <EChart
                  option={hierarchyOption}
                  ariaLabel="当前国家或类目维度的货盘与我方销售额对比"
                  onPointClick={(params) => {
                    const name = String((params as { name?: string })?.name || "");
                    if (!name) return;
                    const dimension = dashboard?.hierarchy.dimension;
                    if (dimension === "country") setCountry(name);
                    if (dimension === "categoryL1") setCategoryL1(name);
                    if (dimension === "categoryL2") setCategoryL2(name);
                    if (dimension === "style") setStyle(name);
                  }}
                />
              </article>
              <article className="visual-panel">
                <div className="section-heading">
                  <div><span>承接效率</span><h3>货盘表现 vs 我方表现</h3></div>
                  <small>红色为低承接机会</small>
                </div>
                <EChart option={scatterOption} ariaLabel="各商品货盘标准化销售额与我方标准化销售额散点图" />
              </article>
              <article className="visual-panel wide">
                <div className="section-heading">
                  <div><span>机会地图</span><h3>国家 × 一级类目缺口</h3></div>
                  <small>数值越高，货盘强但我方承接越弱</small>
                </div>
                <EChart
                  option={heatmapOption}
                  ariaLabel="国家与一级类目机会缺口热力图"
                  onPointClick={(params) => {
                    const value = (params as { value?: number[] })?.value;
                    if (!Array.isArray(value)) return;
                    const matrix = dashboard?.opportunityMatrix || [];
                    const countries = [...new Set(matrix.map((item) => item.country))].slice(0, 8);
                    const categories = [...new Set([...matrix].sort((a, b) => b.assortmentAmount - a.assortmentAmount).map((item) => item.category))].slice(0, 10);
                    setCountry(countries[value[1]] || "");
                    setCategoryL1(categories[value[0]] || "");
                  }}
                />
              </article>
            </section>

            <section className="data-section">
              <div className="section-heading">
                <div><span>产品机会</span><h3>验证货盘与我方承接明细</h3></div>
                <small>按货盘标准化销售额排序</small>
              </div>
              <Table<ProductRow>
                rowKey="key"
                columns={productColumns}
                dataSource={dashboard?.topProducts || []}
                loading={loading}
                size="middle"
                scroll={{ x: 1180 }}
                pagination={{ pageSize: 10, showSizeChanger: false }}
              />
            </section>

            <section className="data-section">
              <div className="section-heading">
                <div><span>店铺诊断</span><h3>每个店铺的优势、短板与机会点</h3></div>
                <small>{summary?.storeCount || 0} 家有效出单店铺</small>
              </div>
              <Table<StoreRow>
                rowKey={(item) => `${item.store}-${item.country}`}
                columns={storeColumns}
                dataSource={dashboard?.stores || []}
                loading={loading}
                size="middle"
                scroll={{ x: 1180 }}
                pagination={{ pageSize: 10, showSizeChanger: false }}
              />
            </section>
          </>
        )}

        <footer className="data-footnote">
          <span>金额口径：{dashboard?.contract.amountBasis}</span>
          <span>聚合口径：{dashboard?.contract.aggregationKey}</span>
          <span>价格覆盖：{dashboard?.quality.priceCoverage || 0}%</span>
        </footer>
      </main>

      <Modal
        open={Boolean(taskEditor)}
        title={taskEditor?.task ? "编辑每日采集任务" : "新建每日采集任务"}
        okText="保存任务"
        cancelText="取消"
        confirmLoading={taskEditorSaving}
        onOk={() => void confirmTaskEditor()}
        onCancel={() => !taskEditorSaving && setTaskEditor(null)}
        getContainer={() => popup}
        destroyOnHidden
      >
        {taskEditor && (
          <div className="automation-form">
            <Alert
              type="info"
              showIcon
              message={taskEditor.taskType === "order_export"
                ? "订单按付款时间获取，成功后追加进入事实层。"
                : "库存保存执行时点完整快照，并替换驾驶舱当前视图。"}
            />
            <label>
              <span>数据类型</span>
              <Select
                value={taskEditor.taskType}
                disabled={Boolean(taskEditor.task)}
                options={[
                  { value: "order_export", label: "订单信息" },
                  { value: "inventory_export", label: "库存信息" },
                ]}
                onChange={(taskType: MabangSyncTaskType) => setTaskEditor({
                  ...taskEditor,
                  taskType,
                  name: taskType === "order_export" ? "销售与货盘 · 每日订单" : "销售与货盘 · 每日库存",
                })}
              />
            </label>
            <label>
              <span>任务名称</span>
              <Input
                value={taskEditor.name}
                maxLength={80}
                onChange={(event) => setTaskEditor({ ...taskEditor, name: event.target.value })}
              />
            </label>
            <label>
              <span>马帮账号</span>
              <Select
                value={taskEditor.accountProfileId || undefined}
                placeholder="选择已验证账号"
                options={(automation?.accounts || []).map((account) => ({
                  value: account.id,
                  label: `${account.name} · ${account.usernameMasked}${account.enabled ? "" : "（已停用）"}`,
                  disabled: !account.enabled,
                }))}
                onChange={(accountProfileId) => setTaskEditor({ ...taskEditor, accountProfileId })}
              />
            </label>
            <label>
              <span>每天执行时间</span>
              <Input
                type="time"
                value={taskEditor.time}
                onChange={(event) => setTaskEditor({ ...taskEditor, time: event.target.value })}
              />
            </label>
            {taskEditor.taskType === "order_export" && (
              <label>
                <span>付款时间范围</span>
                <Select
                  value={taskEditor.paymentDateMode}
                  options={[
                    { value: "yesterday", label: "昨天（推荐）" },
                    { value: "last_7_days", label: "最近 7 天" },
                    { value: "last_14_days", label: "最近 14 天" },
                    { value: "last_30_days", label: "最近 30 天" },
                  ]}
                  onChange={(paymentDateMode) => setTaskEditor({ ...taskEditor, paymentDateMode })}
                />
              </label>
            )}
            <label>
              <span>钉钉机器人</span>
              <Select
                allowClear
                value={taskEditor.dingtalkConfigId || undefined}
                placeholder="不发送通知"
                options={(automation?.dingtalkConfigs || []).map((config) => ({
                  value: config.id,
                  label: `${config.name}${config.enabled ? "" : "（已停用）"}`,
                  disabled: !config.enabled,
                }))}
                onChange={(dingtalkConfigId) => setTaskEditor({
                  ...taskEditor,
                  dingtalkConfigId: dingtalkConfigId || "",
                  notifyEnabled: Boolean(dingtalkConfigId),
                })}
              />
            </label>
            <label className="switch-row">
              <span>
                <strong>发送执行通知</strong>
                <small>成功、失败或无数据时按机器人配置发送。</small>
              </span>
              <Switch
                checked={taskEditor.notifyEnabled}
                disabled={!taskEditor.dingtalkConfigId}
                onChange={(notifyEnabled) => setTaskEditor({ ...taskEditor, notifyEnabled })}
              />
            </label>
            <label className="switch-row">
              <span>
                <strong>保存后启用</strong>
                <small>启用后由现有马帮后台调度器自动执行。</small>
              </span>
              <Switch checked={taskEditor.enabled} onChange={(enabled) => setTaskEditor({ ...taskEditor, enabled })} />
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={dingtalkOpen}
        title="钉钉机器人"
        width={760}
        footer={null}
        onCancel={() => setDingtalkOpen(false)}
        getContainer={() => popup}
        destroyOnHidden
      >
        <div className="dingtalk-manager">
          <section className="robot-list">
            <header>
              <div>
                <strong>现有机器人</strong>
                <span>定时采集任务可选择其中一个发送结果通知。</span>
              </div>
              <Button icon={<Webhook size={15} />} onClick={() => resetDingtalkEditor()}>
                新建
              </Button>
            </header>
            {(automation?.dingtalkConfigs || []).map((config) => (
              <article key={config.id}>
                <span className="robot-status"><CheckCircle2 size={17} /></span>
                <div>
                  <strong>{config.name}</strong>
                  <span>{config.enabled ? "已启用" : "已停用"} · 成功 {config.notifyOnSuccess ? "通知" : "不通知"} · 失败 {config.notifyOnFailure ? "通知" : "不通知"}</span>
                </div>
                <div className="robot-actions">
                  <Tooltip title="编辑">
                    <Button icon={<Pencil size={14} />} aria-label={`编辑${config.name}`} onClick={() => resetDingtalkEditor(config)} />
                  </Tooltip>
                  <Tooltip title="发送测试消息">
                    <Button
                      icon={<Play size={14} />}
                      aria-label={`测试${config.name}`}
                      loading={dingtalkActionId === config.id}
                      onClick={() => void testRobot(config)}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="删除机器人配置？"
                    description="正在被定时任务使用时，系统会拒绝删除。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void removeRobot(config)}
                  >
                    <Button danger icon={<Trash2 size={14} />} aria-label={`删除${config.name}`} />
                  </Popconfirm>
                </div>
              </article>
            ))}
            {!automation?.dingtalkConfigs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置机器人" />}
          </section>

          <section className="robot-form">
            <header>
              <strong>{dingtalkEditor.config ? `编辑：${dingtalkEditor.config.name}` : "新增机器人"}</strong>
              {dingtalkEditor.config && <Button type="link" onClick={() => resetDingtalkEditor()}>取消编辑</Button>}
            </header>
            <label>
              <span>配置名称</span>
              <Input value={dingtalkEditor.name} maxLength={80} onChange={(event) => setDingtalkEditor({ ...dingtalkEditor, name: event.target.value })} />
            </label>
            <label>
              <span>Webhook URL</span>
              <Input.Password
                value={dingtalkEditor.webhookUrl}
                placeholder={dingtalkEditor.config?.webhookConfigured ? "已配置；留空则不修改" : "https://oapi.dingtalk.com/robot/send?..."}
                onChange={(event) => setDingtalkEditor({ ...dingtalkEditor, webhookUrl: event.target.value })}
              />
            </label>
            <label>
              <span>加签 Secret</span>
              <Input.Password
                value={dingtalkEditor.secret}
                placeholder={dingtalkEditor.config?.secretConfigured ? "已配置；留空则不修改" : "未启用加签可留空"}
                onChange={(event) => setDingtalkEditor({ ...dingtalkEditor, secret: event.target.value })}
              />
            </label>
            <label>
              <span>@ 手机号</span>
              <Input
                value={dingtalkEditor.atMobiles}
                placeholder="多个手机号用逗号分隔"
                onChange={(event) => setDingtalkEditor({ ...dingtalkEditor, atMobiles: event.target.value })}
              />
            </label>
            <div className="robot-switches">
              <label><Switch size="small" checked={dingtalkEditor.enabled} onChange={(enabled) => setDingtalkEditor({ ...dingtalkEditor, enabled })} /><span>启用</span></label>
              <label><Switch size="small" checked={dingtalkEditor.notifyOnSuccess} onChange={(notifyOnSuccess) => setDingtalkEditor({ ...dingtalkEditor, notifyOnSuccess })} /><span>成功通知</span></label>
              <label><Switch size="small" checked={dingtalkEditor.notifyOnFailure} onChange={(notifyOnFailure) => setDingtalkEditor({ ...dingtalkEditor, notifyOnFailure })} /><span>失败通知</span></label>
              <label><Switch size="small" checked={dingtalkEditor.notifyOnEmpty} onChange={(notifyOnEmpty) => setDingtalkEditor({ ...dingtalkEditor, notifyOnEmpty })} /><span>空数据通知</span></label>
              <label><Switch size="small" checked={dingtalkEditor.atAll} onChange={(atAll) => setDingtalkEditor({ ...dingtalkEditor, atAll })} /><span>@ 所有人</span></label>
            </div>
            <Button type="primary" icon={<Webhook size={15} />} loading={dingtalkSaving} onClick={() => void confirmDingtalkEditor()}>
              {dingtalkEditor.config ? "保存修改" : "创建机器人"}
            </Button>
          </section>
        </div>
      </Modal>

      <Modal
        open={Boolean(preview)}
        title="确认导入数据"
        okText="确认入库"
        cancelText="取消"
        okButtonProps={{ disabled: Boolean(preview?.blockers), loading: applying }}
        onOk={confirmImport}
        onCancel={() => setPreview(null)}
        getContainer={() => popup}
      >
        {preview && (
          <div className="import-preview">
            <span className="preview-file"><FileSpreadsheet size={20} />{preview.filename}</span>
            <dl>
              <div><dt>识别行数</dt><dd>{integer.format(preview.rowCount)}</dd></div>
              <div><dt>阻断问题</dt><dd className={preview.blockers ? "danger-text" : "positive-text"}>{preview.blockers}</dd></div>
              <div><dt>提醒</dt><dd>{preview.warnings}</dd></div>
            </dl>
            <p>{preview.blockers ? "存在阻断问题，请先修正源文件后重新导入。" : "确认后写入现有事实层；订单追加，库存与产品包更新当前视图并保留历史批次。"}</p>
          </div>
        )}
      </Modal>
    </ConfigProvider>
  );
}
