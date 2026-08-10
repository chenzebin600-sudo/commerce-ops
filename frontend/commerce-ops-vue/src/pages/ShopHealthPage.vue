<script setup lang="ts">
import {
  Activity,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Store,
  TriangleAlert,
  UserRound,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import ShopHealthTrend from "@/components/shopee/ShopHealthTrend.vue";
import {
  createHealthAppeal,
  loadDingtalkConfigs,
  loadHealthDashboard,
  markAllHealthNotificationsRead,
  runHealthCollection,
  saveHealthSettings,
  saveHealthThresholds,
  testHealthKey,
  updateHealthAppeal,
  type AppealStatus,
  type DingtalkConfig,
  type HealthAppeal,
  type HealthDashboard,
  type HealthIssue,
  type HealthSettings,
  type HealthStatus,
  type ShopHealthSnapshot,
  type ThresholdConfig,
} from "@/services/shop-health";

const loading = ref(true);
const refreshing = ref(false);
const savingSettings = ref(false);
const collecting = ref(false);
const dashboard = ref<HealthDashboard | null>(null);
const activeTab = ref("overview");
const shopQuery = ref("");
const countryFilter = ref("");
const statusFilter = ref("");
const issueSeverity = ref("");
const issueCountry = ref("");
const issueShopId = ref("");
const settingsOpen = ref(false);
const notificationsOpen = ref(false);
const issueShopOpen = ref(false);
const issueOpen = ref(false);
const appealOpen = ref(false);
const selectedIssue = ref<HealthIssue | null>(null);
const selectedAppeal = ref<HealthAppeal | null>(null);
const robots = ref<DingtalkConfig[]>([]);
const thresholdRows = ref<ThresholdConfig[]>([]);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const settingsForm = reactive({
  tokenKey: "",
  scheduleTime: "09:00",
  retryCount: 3,
  warningRatioPercent: 10,
  dingtalkConfigId: "",
  siteNotificationsEnabled: true,
  dingtalkNotificationsEnabled: false,
  enabled: true,
});
const appealForm = reactive({
  status: "pending_review" as AppealStatus,
  assigneeUserId: "current-user",
  assigneeName: "我",
  dueDate: "",
  sellerCenterReference: "",
  evidence: [] as Array<{ name: string; url: string }>,
  notes: "",
  resolution: "",
  eventNote: "",
});

type IssueModuleKey = "punishment" | "penalty" | "metric" | "listing" | "late_order";
const issueModules: Array<{ key: IssueModuleKey; label: string; description: string; icon: typeof ShieldAlert }> = [
  { key: "punishment", label: "处罚", description: "活动限制与进行中的平台处罚", icon: ShieldAlert },
  { key: "penalty", label: "扣分", description: "违规扣分与待处理记录", icon: ClipboardCheck },
  { key: "metric", label: "健康指标", description: "表现指标与官方目标差距", icon: Activity },
  { key: "listing", label: "问题商品", description: "需要修改或下架的商品", icon: Store },
  { key: "late_order", label: "迟发订单", description: "超过平台时效的订单", icon: Clock3 },
];

const summary = computed(() => dashboard.value?.summary || { healthy: 0, warning: 0, critical: 0, unavailable: 42, activeIssues: 0, openAppeals: 0 });
const countries = computed(() => [...new Set((dashboard.value?.shops || []).map((shop) => shop.country))]);
const filteredShops = computed(() => (dashboard.value?.shops || []).filter((shop) => {
  const query = shopQuery.value.trim().toLocaleLowerCase("zh-CN");
  return (!countryFilter.value || shop.country === countryFilter.value)
    && (!statusFilter.value || shop.status === statusFilter.value)
    && (!query || `${shop.shopCode}${shop.shopName}${shop.shopId}`.toLocaleLowerCase("zh-CN").includes(query));
}));
const filteredIssues = computed(() => (dashboard.value?.issues || []).filter((issue) =>
  (!issueSeverity.value || issue.severity === issueSeverity.value)
    && (!issueCountry.value || issue.country === issueCountry.value),
));
const issueShopGroups = computed(() => groupIssuesByShop(filteredIssues.value));
const selectedIssueShopGroup = computed(() => groupIssuesByShop(dashboard.value?.issues || []).find((group) => group.shopId === issueShopId.value) || null);
const selectedShopIssueModules = computed(() => issueModules.map((module) => ({
  ...module,
  issues: (selectedIssueShopGroup.value?.issues || []).filter((issue) => issueModuleKey(issue) === module.key),
})).filter((module) => module.issues.length));
const latestRun = computed(() => dashboard.value?.latestRun as Record<string, unknown> | null);
const runStatus = computed(() => String(latestRun.value?.status || ""));
const isRunActive = computed(() => ["pending", "running"].includes(runStatus.value));
const tokenConfigured = computed(() => Boolean(dashboard.value?.settings?.tokenConfigured));
const appealByIssue = computed(() => new Map((dashboard.value?.appeals || []).map((appeal) => [appeal.issueId, appeal])));
const fulfillmentCoverage = computed(() => {
  const values = (dashboard.value?.shops || []).map((shop) => fulfillmentRate(shop)?.value).filter((value): value is number => value != null);
  return { count: values.length, average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
});

const statusMeta: Record<HealthStatus, { label: string; note: string }> = {
  healthy: { label: "健康", note: "全部指标在安全范围" },
  warning: { label: "预警", note: "指标正在接近目标线" },
  critical: { label: "异常", note: "需要立即检查或处理" },
  unavailable: { label: "未采集", note: "等待首次健康检查" },
};
const appealStatuses: Array<{ value: AppealStatus; label: string }> = [
  { value: "pending_review", label: "待判断" }, { value: "preparing", label: "准备材料" },
  { value: "submitted", label: "已提交申诉" }, { value: "waiting_result", label: "等待结果" },
  { value: "approved", label: "申诉成功" }, { value: "rejected", label: "申诉失败" }, { value: "closed", label: "已关闭" },
];
const issueTypeLabels: Record<string, string> = { metric: "健康指标", penalty: "扣分", punishment: "处罚", listing: "问题商品", late_order: "迟发订单" };

function formatDate(value?: string | null, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) });
}
function appealStatusLabel(value: string) { return appealStatuses.find((item) => item.value === value)?.label || value; }
function ratingLabel(value?: number | null) { return value === 4 ? "优秀" : value === 3 ? "良好" : value === 2 ? "待改善" : value === 1 ? "较差" : "—"; }
function issueCount(shop: ShopHealthSnapshot) { return Number(shop.warningCount || 0) + Number(shop.criticalCount || 0); }
function issueModuleKey(issue: HealthIssue): IssueModuleKey {
  if (issue.issueType === "punishment") return "punishment";
  if (issue.issueType === "penalty") return "penalty";
  if (issue.issueType === "listing") return "listing";
  if (issue.issueType === "late_order") return "late_order";
  return "metric";
}
function groupIssuesByShop(issues: HealthIssue[]) {
  const groups = new Map<string, {
    shopId: string; shopCode: string; shopName: string; country: string; issues: HealthIssue[];
    criticalCount: number; warningCount: number; latestSeenAt: string;
    typeCounts: Array<{ key: string; label: string; count: number }>;
  }>();
  for (const issue of issues) {
    if (!groups.has(issue.shopId)) groups.set(issue.shopId, {
      shopId: issue.shopId, shopCode: issue.shopCode, shopName: issue.shopName, country: issue.country,
      issues: [], criticalCount: 0, warningCount: 0, latestSeenAt: issue.lastSeenAt,
      typeCounts: [],
    });
    const group = groups.get(issue.shopId)!;
    group.issues.push(issue);
    if (issue.severity === "critical") group.criticalCount += 1;
    else group.warningCount += 1;
    if (issue.lastSeenAt > group.latestSeenAt) group.latestSeenAt = issue.lastSeenAt;
  }
  for (const group of groups.values()) {
    group.typeCounts = Object.entries(issueTypeLabels).map(([key, label]) => ({
      key, label, count: group.issues.filter((issue) => issue.issueType === key).length,
    })).filter((item) => item.count > 0);
  }
  return [...groups.values()].sort((left, right) =>
    right.criticalCount - left.criticalCount
      || right.issues.length - left.issues.length
      || right.latestSeenAt.localeCompare(left.latestSeenAt),
  );
}
function openIssueShop(shopId: string) {
  issueShopId.value = shopId;
  issueShopOpen.value = true;
}
function openShopIssues(shop: ShopHealthSnapshot) {
  if (!issueCount(shop)) return;
  openIssueShop(shop.shopId);
}
function showAllIssues() {
  issueCountry.value = "";
  issueSeverity.value = "";
  issueShopOpen.value = false;
  activeTab.value = "issues";
}
function switchWorkspaceTab(tabId: string) {
  activeTab.value = tabId;
}
function fulfillmentRate(shop: ShopHealthSnapshot) {
  const metrics = shop.metrics || [];
  const isFulfillment = (name: string) => /(履约|fulfil|fulfill)/i.test(name) && /(率|rate)/i.test(name);
  const isNonFulfillment = (name: string) => /(未履约|non[\s_-]*fulfil|non[\s_-]*fulfill|\bnfr\b)/i.test(name);
  const direct = metrics.find((metric) => isFulfillment(metric.metricName || "") && !isNonFulfillment(metric.metricName || "") && metric.currentPeriod != null);
  const inverse = metrics.find((metric) => isFulfillment(metric.metricName || "") && isNonFulfillment(metric.metricName || "") && metric.currentPeriod != null);
  const metric = direct || inverse;
  if (!metric) return null;
  const rawValue = Number(metric.currentPeriod);
  if (!Number.isFinite(rawValue)) return null;
  const value = Math.max(0, Math.min(100, direct ? rawValue : 100 - rawValue));
  return {
    value,
    display: `${value.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`,
    note: direct ? "Shopee 官方口径" : `由${metric.metricName || "未履约率"}换算`,
  };
}

function syncForms(settings: HealthSettings) {
  settingsForm.tokenKey = "";
  settingsForm.scheduleTime = settings.scheduleTime || "09:00";
  settingsForm.retryCount = settings.retryCount ?? 3;
  settingsForm.warningRatioPercent = Math.round(Number(settings.warningRatio || 0.1) * 100);
  settingsForm.dingtalkConfigId = settings.dingtalkConfigId || "";
  settingsForm.siteNotificationsEnabled = settings.siteNotificationsEnabled;
  settingsForm.dingtalkNotificationsEnabled = Boolean(settings.dingtalkNotificationsEnabled && settings.dingtalkConfigId);
  settingsForm.enabled = settings.enabled;
}

function buildThresholdRows(data: HealthDashboard) {
  const current = new Map(data.thresholds.map((item) => [item.metricId, item]));
  for (const shop of data.shops) {
    for (const metric of shop.metrics || []) {
      const typed = metric as { metricId: number; metricName: string };
      if (!current.has(Number(typed.metricId))) current.set(Number(typed.metricId), { metricId: Number(typed.metricId), metricName: typed.metricName, warningValue: null, enabled: true });
    }
  }
  thresholdRows.value = [...current.values()].sort((left, right) => left.metricId - right.metricId);
}

async function load({ quiet = false } = {}) {
  if (!quiet) loading.value = true;
  else refreshing.value = true;
  try {
    const data = await loadHealthDashboard(30);
    dashboard.value = data;
    syncForms(data.settings);
    buildThresholdRows(data);
    collecting.value = ["pending", "running"].includes(String(data.latestRun?.status || ""));
    if (collecting.value) startPolling();
    else stopPolling();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "店铺健康数据加载失败");
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => load({ quiet: true }), 4000);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

async function runNow() {
  if (!tokenConfigured.value) { settingsOpen.value = true; return ElMessage.warning("请先配置并验证 Shopee 专属 Key"); }
  try {
    await ElMessageBox.confirm("将立即检查42家已授权店铺；通知全部关闭时，异常仍会保留在异常队列。", "开始健康检查", { type: "info", confirmButtonText: "开始检查", cancelButtonText: "取消" });
    collecting.value = true;
    await runHealthCollection();
    ElMessage.success("健康检查已开始，可继续浏览页面");
    startPolling();
    await load({ quiet: true });
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : "启动失败");
    collecting.value = false;
  }
}

async function openSettings() {
  settingsOpen.value = true;
  try { robots.value = await loadDingtalkConfigs(); }
  catch { robots.value = []; }
}

async function saveSettings() {
  savingSettings.value = true;
  try {
    await saveHealthSettings({
      tokenKey: settingsForm.tokenKey || undefined,
      scheduleTime: settingsForm.scheduleTime, retryCount: settingsForm.retryCount,
      warningRatio: Number(settingsForm.warningRatioPercent) / 100,
      dingtalkConfigId: settingsForm.dingtalkConfigId || null,
      siteNotificationsEnabled: settingsForm.siteNotificationsEnabled,
      dingtalkNotificationsEnabled: settingsForm.dingtalkNotificationsEnabled,
      enabled: settingsForm.enabled,
    });
    if (thresholdRows.value.length) await saveHealthThresholds(thresholdRows.value);
    ElMessage.success(settingsForm.tokenKey ? "Key 验证通过，配置已保存" : "店铺健康配置已保存");
    settingsOpen.value = false;
    await load({ quiet: true });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); }
  finally { savingSettings.value = false; }
}

async function testSavedKey() {
  try {
    const result = await testHealthKey();
    ElMessage.success(`连接正常，当前识别 ${result.recognizedShopCount}/${result.monitoredShopCount} 家监控店铺`);
    await load({ quiet: true });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "Key 验证失败"); }
}

function inspectIssue(issue: HealthIssue) { selectedIssue.value = issue; issueOpen.value = true; }
async function beginAppeal(issue: HealthIssue) {
  try {
    const existing = appealByIssue.value.get(issue.id);
    selectedAppeal.value = existing || await createHealthAppeal(issue.id, { assigneeUserId: "current-user", assigneeName: "我" });
    fillAppealForm(selectedAppeal.value);
    issueOpen.value = false;
    appealOpen.value = true;
    await load({ quiet: true });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "创建申诉工单失败"); }
}
function fillAppealForm(appeal: HealthAppeal) {
  appealForm.status = appeal.status;
  appealForm.assigneeUserId = appeal.assigneeUserId || "current-user";
  appealForm.assigneeName = appeal.assigneeName || "我";
  appealForm.dueDate = appeal.dueDate || "";
  appealForm.sellerCenterReference = appeal.sellerCenterReference || "";
  appealForm.evidence = [...(appeal.evidence || [])];
  appealForm.notes = appeal.notes || "";
  appealForm.resolution = appeal.resolution || "";
  appealForm.eventNote = "";
}
function openAppeal(appeal: HealthAppeal) { selectedAppeal.value = appeal; fillAppealForm(appeal); appealOpen.value = true; }
function addEvidence() { appealForm.evidence.push({ name: "", url: "" }); }
async function saveAppeal() {
  if (!selectedAppeal.value) return;
  try {
    selectedAppeal.value = await updateHealthAppeal(selectedAppeal.value.id, { ...appealForm, evidence: appealForm.evidence.filter((item) => item.name || item.url) });
    ElMessage.success("申诉工单已更新");
    appealOpen.value = false;
    await load({ quiet: true });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存申诉工单失败"); }
}

async function readAllNotifications() {
  await markAllHealthNotificationsRead();
  await load({ quiet: true });
}

onMounted(() => load());
onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="shop-health-page">
    <section class="health-command" aria-labelledby="health-command-title">
      <div>
        <span class="health-eyebrow"><Activity :size="14" /> DAILY CONTROL</span>
        <h2 id="health-command-title">42家店，一眼看清今天哪里需要你。</h2>
        <p>每天09:00自动检查表现、扣分、处罚、问题商品与迟发订单；提前预警保留处理窗口。</p>
      </div>
      <div class="health-command-actions">
        <button class="notification-button" type="button" aria-label="查看店铺健康通知" @click="notificationsOpen = true">
          <Bell :size="18" /><span v-if="dashboard?.unreadNotifications" class="notification-count">{{ dashboard.unreadNotifications > 99 ? '99+' : dashboard.unreadNotifications }}</span>
        </button>
        <el-button size="large" @click="openSettings"><Settings2 :size="17" />设置</el-button>
        <el-button type="primary" size="large" :loading="collecting || isRunActive" @click="runNow"><RefreshCw :size="17" />{{ collecting || isRunActive ? '检查进行中' : '立即检查' }}</el-button>
      </div>
    </section>

    <section v-if="!tokenConfigured && !loading" class="setup-callout" role="status">
      <div class="setup-icon"><KeyRound :size="21" /></div>
      <div><strong>还差一步：配置 Shopee 专属 Key</strong><p>Key 会加密保存在服务端，刷新后可随时在设置中安全更换。</p></div>
      <el-button type="primary" @click="openSettings">现在配置</el-button>
    </section>
    <section v-else-if="dashboard?.settings.lastKeyError" class="key-error-callout" role="alert">
      <ShieldAlert :size="20" /><div><strong>Key 验证失败</strong><p>{{ dashboard.settings.lastKeyError }}</p></div><el-button @click="openSettings">更新 Key</el-button>
    </section>

    <section class="health-summary" aria-label="店铺健康汇总">
      <button type="button" class="summary-primary" @click="statusFilter = ''; activeTab = 'overview'">
        <span>监控覆盖</span><strong>{{ dashboard?.monitoredShopCount || 42 }}</strong><small>家已授权店铺</small>
      </button>
      <button type="button" class="summary-item healthy" @click="statusFilter = 'healthy'; activeTab = 'overview'">
        <CheckCircle2 :size="18" /><span><b>{{ summary.healthy }}</b>健康</span><small>无需处理</small>
      </button>
      <button type="button" class="summary-item warning" @click="statusFilter = 'warning'; activeTab = 'overview'">
        <Clock3 :size="18" /><span><b>{{ summary.warning }}</b>预警</span><small>接近目标线</small>
      </button>
      <button type="button" class="summary-item critical" @click="statusFilter = 'critical'; activeTab = 'overview'">
        <TriangleAlert :size="18" /><span><b>{{ summary.critical }}</b>异常</span><small>{{ summary.activeIssues }}项待处理</small>
      </button>
      <button type="button" class="summary-item appeals" @click="activeTab = 'appeals'">
        <ClipboardCheck :size="18" /><span><b>{{ summary.openAppeals }}</b>申诉</span><small>进行中的工单</small>
      </button>
      <button type="button" class="summary-item fulfillment" @click="activeTab = 'overview'">
        <Activity :size="18" />
        <span><b>{{ fulfillmentCoverage.average == null ? '—' : `${fulfillmentCoverage.average.toFixed(1)}%` }}</b></span>
        <small>{{ fulfillmentCoverage.count ? `平均履约率 · ${fulfillmentCoverage.count}家` : '履约率等待首次采集' }}</small>
      </button>
    </section>

    <section class="health-workspace">
      <div class="workspace-tabs" role="tablist" aria-label="店铺健康视图">
        <button v-for="tab in [{id:'overview',label:'店铺矩阵'},{id:'issues',label:'异常队列'},{id:'appeals',label:'申诉工作台'},{id:'trend',label:'趋势'}]" :key="tab.id" type="button" :class="{ active: activeTab === tab.id }" @click="switchWorkspaceTab(tab.id)">{{ tab.label }}</button>
        <span class="last-run">最近检查：{{ formatDate(String(latestRun?.finished_at || latestRun?.started_at || '')) }}</span>
      </div>

      <div v-if="loading" class="health-loading" aria-live="polite">
        <div v-for="index in 6" :key="index" class="skeleton-row" />
      </div>

      <template v-else-if="activeTab === 'overview'">
        <div class="filter-bar">
          <el-input v-model="shopQuery" clearable placeholder="搜索店编、店名或 shop_id" aria-label="搜索店铺" />
          <el-select v-model="countryFilter" clearable placeholder="全部国家" aria-label="按国家筛选"><el-option v-for="country in countries" :key="country" :label="country" :value="country" /></el-select>
          <el-select v-model="statusFilter" clearable placeholder="全部状态" aria-label="按健康状态筛选"><el-option v-for="(meta,key) in statusMeta" :key="key" :label="meta.label" :value="key" /></el-select>
          <span>{{ filteredShops.length }}家店</span>
        </div>
        <div class="health-table" role="table" aria-label="店铺健康矩阵">
          <div class="health-table-head" role="row"><span>店铺</span><span>状态</span><span>表现评级</span><span>履约率</span><span>扣分</span><span>处罚</span><span>问题商品</span><span>迟发订单</span><span>最近检查</span></div>
          <button v-for="shop in filteredShops" :key="shop.shopId" type="button" class="health-table-row" role="row" @click="openShopIssues(shop)">
            <span class="shop-identity"><i>{{ shop.country.slice(0, 1) }}</i><span><b>{{ shop.shopCode }} · {{ shop.shopName }}</b><small>{{ shop.country }} / {{ shop.shopId }}</small></span></span>
            <span><i class="status-pill" :class="shop.status"><span />{{ statusMeta[shop.status].label }}</i></span>
            <span class="data-cell" data-label="表现评级"><b>{{ ratingLabel(shop.overallRating) }}</b><small>{{ issueCount(shop) ? `${issueCount(shop)}项异常` : statusMeta[shop.status].note }}</small></span>
            <span class="data-cell fulfillment-cell" data-label="履约率"><b>{{ fulfillmentRate(shop)?.display || '—' }}</b><small>{{ fulfillmentRate(shop)?.note || '等待指标采集' }}</small></span>
            <span class="number-cell" data-label="扣分" :class="{ danger: Number(shop.penaltyPoints) > 0 }">{{ shop.penaltyPoints ?? '—' }}</span>
            <span class="number-cell" data-label="处罚" :class="{ danger: Number(shop.ongoingPunishments) > 0 }">{{ shop.ongoingPunishments ?? '—' }}</span>
            <span class="number-cell" data-label="问题商品" :class="{ warning: Number(shop.issueListingCount) > 0 }">{{ shop.issueListingCount ?? '—' }}</span>
            <span class="number-cell" data-label="迟发订单" :class="{ warning: Number(shop.lateOrderCount) > 0 }">{{ shop.lateOrderCount ?? '—' }}</span>
            <span class="time-cell" data-label="最近检查">{{ formatDate(shop.collectedAt) }}</span>
          </button>
          <div v-if="!filteredShops.length" class="empty-state"><Store :size="28" /><strong>没有符合条件的店铺</strong><span>清除筛选条件后再查看。</span></div>
        </div>
      </template>

      <template v-else-if="activeTab === 'issues'">
        <div class="filter-bar compact">
          <div class="issue-scope"><strong>异常店铺</strong><small>{{ issueShopGroups.length }} 家店 · {{ filteredIssues.length }} 项异常，按严重程度排序</small></div>
          <span class="filter-spacer" />
          <el-select v-model="issueCountry" clearable placeholder="全部国家"><el-option v-for="country in countries" :key="country" :label="country" :value="country" /></el-select>
          <el-select v-model="issueSeverity" clearable placeholder="全部等级"><el-option label="严重异常" value="critical" /><el-option label="提前预警" value="warning" /></el-select>
        </div>
        <div v-if="issueShopGroups.length" class="issue-shop-list" role="list" aria-label="异常店铺列表">
          <article v-for="group in issueShopGroups" :key="group.shopId" class="issue-shop-row" :class="{ critical: group.criticalCount > 0 }" role="listitem">
            <span class="shop-risk-rail" />
            <div class="issue-shop-identity">
              <span class="shop-country-mark">{{ group.country.slice(0, 1) }}</span>
              <span><strong>{{ group.shopCode }} · {{ group.shopName }}</strong><small>{{ group.country }} / {{ group.shopId }}</small></span>
            </div>
            <div class="shop-risk-counts" aria-label="异常等级统计">
              <span v-if="group.criticalCount" class="risk-count critical"><b>{{ group.criticalCount }}</b> 严重</span>
              <span v-if="group.warningCount" class="risk-count warning"><b>{{ group.warningCount }}</b> 预警</span>
              <small>共 {{ group.issues.length }} 项</small>
            </div>
            <div class="shop-risk-types" aria-label="异常类型统计">
              <span v-for="item in group.typeCounts" :key="item.key">{{ item.label }} {{ item.count }}</span>
            </div>
            <div class="shop-risk-updated"><span>最近发现</span><b>{{ formatDate(group.latestSeenAt) }}</b></div>
            <el-button type="primary" plain class="shop-risk-action" @click="openIssueShop(group.shopId)">查看并处理 {{ group.issues.length }} 项</el-button>
          </article>
        </div>
        <div v-else class="empty-state tall"><CheckCircle2 :size="32" /><strong>当前没有待处理异常</strong><span>新的异常和提前预警会按严重程度自动进入这里。</span></div>
      </template>

      <template v-else-if="activeTab === 'appeals'">
        <div class="appeal-toolbar"><div><strong>申诉工作台</strong><span>支持认领、转交和多人协作；当前默认负责人为“我”。</span></div><span>{{ dashboard?.appeals.length || 0 }}个工单</span></div>
        <div v-if="dashboard?.appeals.length" class="appeal-list">
          <button v-for="appeal in dashboard.appeals" :key="appeal.id" type="button" class="appeal-row" @click="openAppeal(appeal)">
            <span class="appeal-status" :class="appeal.status">{{ appealStatusLabel(appeal.status) }}</span>
            <span class="appeal-title"><b>{{ appeal.title }}</b><small>工单 {{ appeal.id.slice(0,8) }} · 更新于 {{ formatDate(appeal.updatedAt) }}</small></span>
            <span class="appeal-owner"><UserRound :size="15" />{{ appeal.assigneeName || '待认领' }}</span>
            <span class="appeal-due"><Clock3 :size="15" />{{ appeal.dueDate || '未设截止日期' }}</span>
            <span class="row-arrow">›</span>
          </button>
        </div>
        <div v-else class="empty-state tall"><ClipboardCheck :size="32" /><strong>还没有申诉工单</strong><span>从异常队列打开扣分原因后即可创建。</span><el-button type="primary" plain @click="showAllIssues">查看异常队列</el-button></div>
      </template>

      <template v-else>
        <div class="trend-layout">
          <div class="trend-heading"><div><strong>30天健康趋势</strong><span>汇总趋势永久保留，用于观察风险是否持续改善。</span></div><span class="trend-legend-note">按每日最终快照统计</span></div>
          <ShopHealthTrend v-if="dashboard?.trend.length" :rows="dashboard.trend" />
          <div v-else class="empty-state tall"><Activity :size="32" /><strong>趋势正在等待首次采集</strong><span>完成第一次健康检查后，这里会开始累计每日趋势。</span></div>
        </div>
      </template>
    </section>

    <el-drawer v-model="settingsOpen" title="店铺健康设置" size="min(560px, 96vw)" class="health-drawer">
      <div class="drawer-intro"><ShieldAlert :size="20" /><div><strong>凭证只在服务端解密使用</strong><p>页面不会读取或回显完整 Key；更新后会立即验证42家监控店铺范围。</p></div></div>
      <section class="settings-section"><div class="section-heading"><span>01</span><div><strong>Shopee 专属 Key</strong><small>当前：{{ dashboard?.settings.tokenConfigured ? dashboard.settings.tokenHint : '未配置' }}</small></div></div><el-form label-position="top"><el-form-item label="新 Key（不更换请留空）"><el-input v-model="settingsForm.tokenKey" type="password" show-password autocomplete="new-password" placeholder="输入新的 X-Token-Key" /></el-form-item><div class="key-meta"><span>验证店铺 {{ dashboard?.settings.tokenShopCount || 0 }}/42</span><span>最近验证 {{ formatDate(dashboard?.settings.tokenVerifiedAt) }}</span><el-button text :disabled="!dashboard?.settings.tokenConfigured" @click="testSavedKey">测试已保存 Key</el-button></div></el-form></section>
      <section class="settings-section">
        <div class="section-heading"><span>02</span><div><strong>每日检查</strong><small>北京时间执行，失败自动重试</small></div></div>
        <div class="settings-grid schedule-grid">
          <el-form-item label="执行时间"><el-time-select v-model="settingsForm.scheduleTime" start="00:00" step="00:30" end="23:30" /></el-form-item>
          <el-form-item label="失败重试次数"><el-input-number v-model="settingsForm.retryCount" :min="0" :max="5" /></el-form-item>
          <el-form-item class="full-field" label="默认提前预警范围"><el-input-number v-model="settingsForm.warningRatioPercent" :min="0" :max="100"><template #suffix>%</template></el-input-number></el-form-item>
        </div>
        <div class="switch-row"><div><b>启用每日自动检查</b><small>关闭后仍可手动立即检查</small></div><el-switch v-model="settingsForm.enabled" /></div>
      </section>
      <section class="settings-section notification-settings">
        <div class="section-heading"><span>03</span><div><strong>通知（可选）</strong><small>全部关闭也不会影响健康检查和异常记录</small></div></div>
        <div class="switch-row"><div><b>站内通知</b><small>新异常、采集失败和 Key 失效</small></div><el-switch v-model="settingsForm.siteNotificationsEnabled" /></div>
        <div class="switch-row"><div><b>钉钉通知</b><small>{{ settingsForm.dingtalkNotificationsEnabled ? '向指定机器人推送每日异常汇总' : '不发送钉钉消息' }}</small></div><el-switch v-model="settingsForm.dingtalkNotificationsEnabled" /></div>
        <el-form-item v-if="settingsForm.dingtalkNotificationsEnabled" class="robot-field" label="钉钉机器人（可选）">
          <el-select v-model="settingsForm.dingtalkConfigId" clearable placeholder="暂不设置">
            <el-option v-for="robot in robots" :key="robot.id" :label="robot.name" :value="robot.id" :disabled="!robot.enabled" />
          </el-select>
          <p class="field-help">未选择机器人时，系统会自动关闭钉钉推送。</p>
        </el-form-item>
      </section>
      <section class="settings-section"><div class="section-heading"><span>04</span><div><strong>指标预警阈值</strong><small>留空时按距离官方目标10%自动计算</small></div></div><div v-if="thresholdRows.length" class="threshold-list"><div v-for="row in thresholdRows" :key="row.metricId" class="threshold-row"><el-switch v-model="row.enabled" /><span><b>{{ row.metricName }}</b><small>ID {{ row.metricId }}</small></span><el-input-number v-model="row.warningValue" :controls="false" placeholder="自动" /></div></div><p v-else class="settings-empty">首次采集后将列出店铺实际返回的指标，可逐项调整。</p></section>
      <template #footer><div class="drawer-footer"><el-button @click="settingsOpen = false">取消</el-button><el-button type="primary" :loading="savingSettings" @click="saveSettings">{{ settingsForm.tokenKey ? '验证 Key 并保存' : '保存设置' }}</el-button></div></template>
    </el-drawer>

    <el-drawer v-model="notificationsOpen" title="店铺健康通知" size="min(480px, 96vw)" class="health-drawer">
      <div class="notification-toolbar"><span>{{ dashboard?.unreadNotifications || 0 }}条未读</span><el-button text @click="readAllNotifications">全部标为已读</el-button></div><div v-if="dashboard?.notifications.length" class="notification-list"><article v-for="item in dashboard.notifications" :key="item.id" :class="[item.severity, { unread: !item.readAt }]"><span class="notification-dot" /><div><strong>{{ item.title }}</strong><p>{{ item.message }}</p><small>{{ formatDate(item.createdAt) }}</small></div></article></div><div v-else class="empty-state tall"><Bell :size="30" /><strong>暂无通知</strong><span>系统会把新异常和采集失败留在这里。</span></div>
    </el-drawer>

    <el-drawer v-model="issueShopOpen" title="店铺异常处理" size="min(720px, 96vw)" class="health-drawer issue-shop-drawer">
      <template v-if="selectedIssueShopGroup">
        <div class="shop-drawer-summary">
          <span class="shop-country-mark large">{{ selectedIssueShopGroup.country.slice(0, 1) }}</span>
          <div><span>{{ selectedIssueShopGroup.country }} / {{ selectedIssueShopGroup.shopId }}</span><h3>{{ selectedIssueShopGroup.shopCode }} · {{ selectedIssueShopGroup.shopName }}</h3><p>异常集中在这里处理，关闭后仍保留当前队列筛选位置。</p></div>
          <div class="shop-drawer-counts"><b>{{ selectedIssueShopGroup.issues.length }}</b><span>待处理项</span></div>
        </div>
        <div class="shop-drawer-riskbar">
          <span v-if="selectedIssueShopGroup.criticalCount" class="risk-count critical"><b>{{ selectedIssueShopGroup.criticalCount }}</b> 严重</span>
          <span v-if="selectedIssueShopGroup.warningCount" class="risk-count warning"><b>{{ selectedIssueShopGroup.warningCount }}</b> 预警</span>
          <span v-for="item in selectedIssueShopGroup.typeCounts" :key="item.key" class="risk-type-summary">{{ item.label }} {{ item.count }}</span>
        </div>
        <section v-for="module in selectedShopIssueModules" :key="module.key" class="drawer-issue-section" :aria-labelledby="`drawer-issue-${module.key}`">
          <header><span><component :is="module.icon" :size="17" /></span><div><strong :id="`drawer-issue-${module.key}`">{{ module.label }}</strong><small>{{ module.description }}</small></div><b>{{ module.issues.length }} 项</b></header>
          <article v-for="issue in module.issues" :key="issue.id" class="drawer-issue-row" :class="issue.severity">
            <span class="drawer-severity-mark" />
            <div class="drawer-issue-copy"><div><span class="issue-level" :class="issue.severity">{{ issue.severity === 'critical' ? '严重' : '预警' }}</span><strong>{{ issue.title }}</strong></div><p>{{ issue.reason || '请查看官方返回详情。' }}</p><small>首次发现 {{ formatDate(issue.firstSeenAt) }}</small></div>
            <div class="drawer-issue-actions"><span v-if="issue.status === 'in_appeal'" class="appeal-chip">申诉处理中</span><el-button @click="inspectIssue(issue)">查看原因</el-button><el-button v-if="issue.status !== 'in_appeal'" type="primary" plain @click="beginAppeal(issue)">创建申诉</el-button></div>
          </article>
        </section>
      </template>
    </el-drawer>

    <el-drawer v-model="issueOpen" title="异常原因" size="min(600px, 96vw)" class="health-drawer">
      <template v-if="selectedIssue"><div class="issue-detail-header" :class="selectedIssue.severity"><span>{{ selectedIssue.shopCode }} · {{ selectedIssue.country }}</span><h3>{{ selectedIssue.title }}</h3><p>{{ selectedIssue.reason }}</p></div><dl class="issue-facts"><div><dt>异常类型</dt><dd>{{ issueTypeLabels[selectedIssue.issueType] || selectedIssue.issueType }}</dd></div><div><dt>首次发现</dt><dd>{{ formatDate(selectedIssue.firstSeenAt) }}</dd></div><div><dt>关联编号</dt><dd>{{ selectedIssue.referenceId || '—' }}</dd></div><div><dt>官方目标</dt><dd>{{ selectedIssue.comparator || '' }} {{ selectedIssue.targetValue ?? '—' }}</dd></div></dl><section class="raw-detail"><strong>官方来源明细</strong><pre>{{ JSON.stringify(selectedIssue.details, null, 2) }}</pre></section><div class="seller-center-note"><ExternalLink :size="18" /><p>AccountHealth API不提供提交申诉能力。工单会在本系统跟踪，实际材料仍需提交至对应站点 Seller Center。</p></div><el-button type="primary" size="large" class="full-action" :disabled="selectedIssue.status === 'in_appeal'" @click="beginAppeal(selectedIssue)">{{ selectedIssue.status === 'in_appeal' ? '已进入申诉流程' : '创建人工申诉工单' }}</el-button></template>
    </el-drawer>

    <el-drawer v-model="appealOpen" title="申诉工单" size="min(620px, 96vw)" class="health-drawer">
      <template v-if="selectedAppeal"><div class="appeal-drawer-title"><span>工单 {{ selectedAppeal.id.slice(0,8) }}</span><h3>{{ selectedAppeal.title }}</h3></div><el-form label-position="top" class="appeal-form"><div class="settings-grid two"><el-form-item label="处理状态"><el-select v-model="appealForm.status"><el-option v-for="status in appealStatuses" :key="status.value" :label="status.label" :value="status.value" /></el-select></el-form-item><el-form-item label="截止日期"><el-date-picker v-model="appealForm.dueDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" /></el-form-item></div><div class="settings-grid two"><el-form-item label="负责人"><el-input v-model="appealForm.assigneeName" placeholder="输入人员姓名" /></el-form-item><el-form-item label="Seller Center 申诉编号"><el-input v-model="appealForm.sellerCenterReference" placeholder="提交后回填" /></el-form-item></div><el-form-item label="处理备注"><el-input v-model="appealForm.notes" type="textarea" :rows="4" placeholder="判断依据、需准备的材料和沟通记录" /></el-form-item><div class="evidence-heading"><span><b>证据材料</b><small>填写云盘、钉钉文档或Seller Center材料链接</small></span><el-button plain @click="addEvidence">添加材料</el-button></div><div v-for="(item,index) in appealForm.evidence" :key="index" class="evidence-row"><el-input v-model="item.name" placeholder="材料名称" /><el-input v-model="item.url" placeholder="https://" /><el-button text type="danger" @click="appealForm.evidence.splice(index,1)">移除</el-button></div><el-form-item label="本次操作说明"><el-input v-model="appealForm.eventNote" placeholder="将记录到工单时间线" /></el-form-item><el-form-item v-if="['approved','rejected','closed'].includes(appealForm.status)" label="处理结果"><el-input v-model="appealForm.resolution" type="textarea" :rows="3" placeholder="记录Shopee反馈和最终处理结果" /></el-form-item></el-form><div class="seller-center-note"><ExternalLink :size="18" /><p>保存进度后，请前往对应站点 Seller Center 完成实际申诉，再回到这里更新状态和编号。</p></div></template><template #footer><div class="drawer-footer"><el-button @click="appealOpen = false">取消</el-button><el-button type="primary" @click="saveAppeal">保存工单</el-button></div></template>
    </el-drawer>
  </div>
</template>

<style scoped>
.shop-health-page { display: grid; gap: 16px; max-width: 1580px; margin: 0 auto; }
.health-command { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 24px 26px; border: 1px solid #d8e2ef; border-radius: var(--ops-radius-lg); background: linear-gradient(105deg, #fff 0 72%, #eef5ff 100%); box-shadow: var(--ops-shadow-sm); }
.health-eyebrow { display: inline-flex; align-items: center; gap: 7px; color: #2563eb; font-size: 11px; font-weight: 800; letter-spacing: .12em; }
.health-command h2 { margin: 7px 0 5px; color: #172033; font-size: clamp(21px, 2.2vw, 30px); line-height: 1.2; letter-spacing: -.025em; }
.health-command p { max-width: 740px; margin: 0; color: #5f6f86; font-size: 13px; line-height: 1.7; }
.health-command-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.notification-button { position: relative; width: 44px; height: 44px; display: grid; place-items: center; border: 1px solid #dbe3ee; border-radius: 10px; color: #475569; background: #fff; cursor: pointer; }
.notification-button:hover { border-color: #93b4ea; color: #2563eb; }.notification-button:focus-visible { outline: 3px solid #bfdbfe; outline-offset: 2px; }
.notification-count { position: absolute; top: -6px; right: -6px; min-width: 19px; height: 19px; display: grid; place-items: center; padding: 0 5px; border: 2px solid #fff; border-radius: 10px; color: #fff; background: #dc2626; font-size: 9px; font-weight: 800; }
.setup-callout,.key-error-callout { display: flex; align-items: center; gap: 13px; padding: 14px 18px; border: 1px solid #bfdbfe; border-radius: 12px; background: #eff6ff; }.setup-callout>div:nth-child(2),.key-error-callout>div { flex: 1; }.setup-callout strong,.key-error-callout strong { font-size: 13px; }.setup-callout p,.key-error-callout p { margin: 3px 0 0; color: #5f6f86; font-size: 12px; }.setup-icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: #1d4ed8; background: #dbeafe; }.key-error-callout { border-color: #fecaca; color: #b91c1c; background: #fff7f7; }
.health-summary { display: grid; grid-template-columns: 1.15fr repeat(5, 1fr); overflow: hidden; border: 1px solid #dbe3ee; border-radius: 14px; background: #fff; box-shadow: var(--ops-shadow-sm); }
.health-summary button { min-width: 0; min-height: 92px; border: 0; border-right: 1px solid #eaf0f6; background: transparent; cursor: pointer; text-align: left; transition: background 180ms ease; }.health-summary button:last-child { border-right: 0; }.health-summary button:hover { background: #f8fafc; }
.summary-primary { padding: 17px 22px; }.summary-primary span,.summary-primary small { display: block; color: #64748b; font-size: 11px; }.summary-primary strong { margin-right: 7px; color: #172033; font-size: 32px; font-variant-numeric: tabular-nums; }.summary-primary small { display: inline; }
.summary-item { display: grid; grid-template-columns: 22px 1fr; align-content: center; gap: 1px 9px; padding: 15px 18px; color: #64748b; }.summary-item span { display: flex; align-items: baseline; gap: 6px; color: #334155; font-size: 12px; white-space: nowrap; }.summary-item b { font-size: 25px; font-variant-numeric: tabular-nums; }.summary-item small { grid-column: 2; color: #8a99ad; font-size: 10px; }.summary-item.healthy svg,.summary-item.healthy b { color: #15803d; }.summary-item.warning svg,.summary-item.warning b { color: #b45309; }.summary-item.critical svg,.summary-item.critical b { color: #b91c1c; }.summary-item.appeals svg,.summary-item.appeals b,.summary-item.fulfillment svg,.summary-item.fulfillment b { color: #1d4ed8; }
.health-workspace { min-height: 560px; overflow: hidden; border: 1px solid #dbe3ee; border-radius: 14px; background: #fff; box-shadow: var(--ops-shadow-sm); }
.workspace-tabs { min-height: 54px; display: flex; align-items: center; gap: 4px; padding: 0 16px; border-bottom: 1px solid #eaf0f6; }.workspace-tabs button { align-self: stretch; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; color: #64748b; background: transparent; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }.workspace-tabs button.active { border-bottom-color: #2563eb; color: #1d4ed8; }.workspace-tabs button:focus-visible { outline: 3px solid #bfdbfe; outline-offset: -4px; }.last-run { margin-left: auto; color: #8a99ad; font-size: 10px; }
.filter-bar { display: grid; grid-template-columns: minmax(260px, 1fr) 150px 150px auto; align-items: center; gap: 9px; padding: 13px 16px; border-bottom: 1px solid #eaf0f6; background: #fbfdff; }.filter-bar>span { color: #8a99ad; font-size: 11px; }.filter-bar.compact { grid-template-columns: auto 1fr 150px 150px; }.filter-bar.compact>strong { font-size: 12px; }.filter-spacer { min-width: 0; }
.issue-scope { min-width: 0; }.issue-scope strong,.issue-scope small { display: block; }.issue-scope strong { overflow: hidden; color: #27364d; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.issue-scope small { margin-top: 3px; color: #8a99ad; font-size: 10px; }
.health-table-head,.health-table-row { display: grid; grid-template-columns: minmax(250px, 1.7fr) 96px 118px 142px repeat(4, 76px) 100px; align-items: center; column-gap: 10px; padding: 0 17px; }.health-table-head { min-height: 38px; color: #8a99ad; background: #f8fafc; font-size: 10px; font-weight: 750; letter-spacing: .02em; }.health-table-row { width: 100%; min-height: 68px; border: 0; border-top: 1px solid #edf2f7; color: #334155; background: #fff; font: inherit; font-size: 12px; text-align: left; cursor: pointer; transition: background 160ms ease; }.health-table-row:hover { background: #f8fbff; }.health-table-row:focus-visible { outline: 3px solid #bfdbfe; outline-offset: -3px; }
.fulfillment-cell b { color: #1d4ed8; font-variant-numeric: tabular-nums; }.fulfillment-cell small { overflow: hidden; max-width: 138px; text-overflow: ellipsis; white-space: nowrap; }
.shop-identity { min-width: 0; display: flex; align-items: center; gap: 11px; }.shop-identity>i { width: 34px; height: 34px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid #dbeafe; border-radius: 9px; color: #1d4ed8; background: #eff6ff; font-style: normal; font-size: 12px; font-weight: 800; }.shop-identity>span { min-width: 0; }.shop-identity b,.shop-identity small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.shop-identity b { color: #27364d; font-size: 11px; }.shop-identity small { margin-top: 4px; color: #8a99ad; font-size: 9px; }
.status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; font-style: normal; font-size: 10px; font-weight: 750; }.status-pill span { width: 6px; height: 6px; border-radius: 50%; }.status-pill.healthy { color: #166534; background: #f0fdf4; }.status-pill.healthy span { background: #16a34a; }.status-pill.warning { color: #92400e; background: #fffbeb; }.status-pill.warning span { background: #d97706; }.status-pill.critical { color: #991b1b; background: #fef2f2; }.status-pill.critical span { background: #dc2626; }.status-pill.unavailable { color: #64748b; background: #f1f5f9; }.status-pill.unavailable span { background: #94a3b8; }
.data-cell b,.data-cell small { display: block; }.data-cell b { font-size: 11px; }.data-cell small { margin-top: 3px; color: #8a99ad; font-size: 9px; }.number-cell { color: #64748b; font-weight: 700; font-variant-numeric: tabular-nums; }.number-cell.danger { color: #b91c1c; }.number-cell.warning { color: #b45309; }.time-cell { color: #8a99ad; font-size: 10px; }
.issue-groups { display: grid; gap: 14px; padding: 14px; background: #f4f7fb; }.issue-group { --module-color: #2563eb; --module-soft: #eff6ff; --module-border: #bfdbfe; overflow: hidden; border: 1px solid var(--module-border); border-radius: 11px; background: #fff; }.issue-group.punishment { --module-color: #b42318; --module-soft: #fff1f0; --module-border: #fecaca; }.issue-group.penalty { --module-color: #a15c07; --module-soft: #fff8e8; --module-border: #f6d58d; }.issue-group.metric { --module-color: #1d5fbf; --module-soft: #eef5ff; --module-border: #bfdbfe; }
.issue-group-header { min-height: 62px; display: grid; grid-template-columns: 36px minmax(0,1fr) auto; align-items: center; gap: 11px; padding: 10px 14px; border-bottom: 1px solid var(--module-border); color: var(--module-color); background: var(--module-soft); }.issue-group-icon { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--module-border); border-radius: 8px; background: rgb(255 255 255 / 72%); }.issue-group-header strong,.issue-group-header small { display: block; }.issue-group-header strong { color: #24324a; font-size: 13px; }.issue-group-header small { margin-top: 3px; color: #5f6f86; font-size: 10px; }.issue-group-header>b { padding: 5px 8px; border: 1px solid var(--module-border); border-radius: 7px; background: rgb(255 255 255 / 76%); font-size: 10px; font-variant-numeric: tabular-nums; }
.issue-list { display: grid; }.issue-row { position: relative; min-height: 84px; display: grid; grid-template-columns: 4px 92px minmax(240px,1fr) 110px auto; align-items: center; gap: 14px; padding: 10px 14px 10px 0; border-bottom: 1px solid #eaf0f6; transition: background 180ms ease; }.issue-row:last-child { border-bottom: 0; }.issue-row:hover { background: var(--module-soft); }.severity-rail { align-self: stretch; border-radius: 0 3px 3px 0; background: var(--module-color); }.issue-source span,.issue-source small { display: block; }.issue-source span { color: #27364d; font-size: 11px; font-weight: 800; }.issue-source small { margin-top: 4px; color: #718096; font-size: 10px; }.issue-copy { min-width: 0; }.issue-meta { display: flex; align-items: center; gap: 7px; }.issue-type { color: var(--module-color); font-size: 9px; font-weight: 800; letter-spacing: .04em; }.issue-level { padding: 2px 5px; border-radius: 4px; color: #92400e; background: #fffbeb; font-size: 8px; font-weight: 800; }.issue-level.critical { color: #991b1b; background: #fef2f2; }.issue-copy strong { display: block; margin: 4px 0 3px; color: #24324a; font-size: 12px; }.issue-copy p { overflow: hidden; margin: 0; color: #64748b; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.issue-time span,.issue-time b { display: block; }.issue-time span { color: #718096; font-size: 9px; }.issue-time b { margin-top: 4px; color: #475569; font-size: 10px; font-variant-numeric: tabular-nums; }.issue-actions { display: flex; align-items: center; gap: 7px; }.appeal-chip { padding: 5px 8px; border-radius: 7px; color: #1d4ed8; background: #eff6ff; font-size: 9px; font-weight: 750; }
.issue-shop-list { display: grid; background: #f8fafc; }
.issue-shop-row { position: relative; min-height: 82px; display: grid; grid-template-columns: 4px minmax(245px,1.2fr) 150px minmax(230px,1fr) 92px auto; align-items: center; gap: 16px; padding: 12px 14px 12px 0; border-bottom: 1px solid #e7edf5; background: #fff; transition: background 180ms ease; }.issue-shop-row:last-child { border-bottom: 0; }.issue-shop-row:hover { background: #f8fbff; }
.shop-risk-rail { align-self: stretch; border-radius: 0 3px 3px 0; background: #d97706; }.issue-shop-row.critical .shop-risk-rail { background: #dc2626; }
.issue-shop-identity { min-width: 0; display: flex; align-items: center; gap: 11px; }.issue-shop-identity>span:last-child { min-width: 0; }.issue-shop-identity strong,.issue-shop-identity small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.issue-shop-identity strong { color: #24324a; font-size: 12px; }.issue-shop-identity small { margin-top: 4px; color: #718096; font-size: 10px; }
.shop-country-mark { width: 36px; height: 36px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid #bfdbfe; border-radius: 9px; color: #1d4ed8; background: #eff6ff; font-size: 12px; font-weight: 800; }.shop-country-mark.large { width: 44px; height: 44px; border-radius: 11px; font-size: 14px; }
.shop-risk-counts { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }.shop-risk-counts>small { width: 100%; color: #718096; font-size: 10px; }
.risk-count { display: inline-flex; align-items: baseline; gap: 3px; padding: 4px 7px; border-radius: 6px; font-size: 10px; font-weight: 700; white-space: nowrap; }.risk-count b { font-size: 13px; font-variant-numeric: tabular-nums; }.risk-count.critical { color: #991b1b; background: #fef2f2; }.risk-count.warning { color: #92400e; background: #fffbeb; }
.shop-risk-types { min-width: 0; display: flex; flex-wrap: wrap; gap: 5px; }.shop-risk-types span,.risk-type-summary { padding: 4px 7px; border: 1px solid #e2e8f0; border-radius: 6px; color: #526174; background: #f8fafc; font-size: 9px; font-weight: 650; white-space: nowrap; }
.shop-risk-updated span,.shop-risk-updated b { display: block; }.shop-risk-updated span { color: #718096; font-size: 9px; }.shop-risk-updated b { margin-top: 4px; color: #475569; font-size: 10px; font-variant-numeric: tabular-nums; }.shop-risk-action { min-height: 36px; }
.shop-drawer-summary { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 13px; padding: 16px; border: 1px solid #dbeafe; border-radius: 12px; background: linear-gradient(115deg,#f8fbff,#eef5ff); }.shop-drawer-summary>div { min-width: 0; }.shop-drawer-summary>div>span { color: #64748b; font-size: 10px; }.shop-drawer-summary h3 { overflow: hidden; margin: 4px 0; color: #172033; font-size: 17px; text-overflow: ellipsis; white-space: nowrap; }.shop-drawer-summary p { margin: 0; color: #64748b; font-size: 10px; line-height: 1.5; }.shop-drawer-counts { text-align: right; }.shop-drawer-counts b,.shop-drawer-counts span { display: block; }.shop-drawer-counts b { color: #1d4ed8; font-size: 26px; font-variant-numeric: tabular-nums; }.shop-drawer-counts span { color: #64748b; font-size: 9px; }
.shop-drawer-riskbar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 12px 2px 6px; }
.drawer-issue-section { overflow: hidden; margin-top: 12px; border: 1px solid #e2e8f0; border-radius: 11px; background: #fff; }.drawer-issue-section>header { min-height: 52px; display: grid; grid-template-columns: 30px minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 8px 11px; border-bottom: 1px solid #e7edf5; background: #f8fafc; }.drawer-issue-section>header>span { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: #1d5fbf; background: #eaf3ff; }.drawer-issue-section>header strong,.drawer-issue-section>header small { display: block; }.drawer-issue-section>header strong { color: #24324a; font-size: 12px; }.drawer-issue-section>header small { margin-top: 2px; color: #718096; font-size: 9px; }.drawer-issue-section>header>b { color: #475569; font-size: 10px; font-variant-numeric: tabular-nums; }
.drawer-issue-row { position: relative; min-height: 76px; display: grid; grid-template-columns: 4px minmax(0,1fr) auto; align-items: center; gap: 11px; padding: 10px 11px 10px 0; border-bottom: 1px solid #edf2f7; }.drawer-issue-row:last-child { border-bottom: 0; }.drawer-severity-mark { align-self: stretch; border-radius: 0 3px 3px 0; background: #d97706; }.drawer-issue-row.critical .drawer-severity-mark { background: #dc2626; }.drawer-issue-copy { min-width: 0; }.drawer-issue-copy>div { display: flex; align-items: center; gap: 7px; }.drawer-issue-copy strong { overflow: hidden; color: #24324a; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.drawer-issue-copy p { overflow: hidden; margin: 5px 0 3px; color: #5f6f86; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.drawer-issue-copy small { color: #8a99ad; font-size: 9px; }.drawer-issue-actions { display: flex; align-items: center; gap: 7px; }
.appeal-toolbar,.trend-heading { display: flex; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid #eaf0f6; }.appeal-toolbar strong,.appeal-toolbar span,.trend-heading strong,.trend-heading span { display: block; }.appeal-toolbar strong,.trend-heading strong { font-size: 13px; }.appeal-toolbar div span,.trend-heading div span { margin-top: 4px; color: #8a99ad; font-size: 10px; }.appeal-toolbar>span,.trend-legend-note { color: #64748b; font-size: 10px; }.appeal-list { display: grid; }.appeal-row { min-height: 70px; display: grid; grid-template-columns: 105px minmax(250px,1fr) 125px 145px 18px; align-items: center; gap: 12px; padding: 11px 18px; border: 0; border-bottom: 1px solid #eaf0f6; color: #475569; background: #fff; font: inherit; text-align: left; cursor: pointer; }.appeal-row:hover { background: #f8fbff; }.appeal-status { justify-self: start; padding: 5px 8px; border-radius: 7px; color: #1d4ed8; background: #eff6ff; font-size: 9px; font-weight: 750; }.appeal-status.approved { color: #166534; background: #f0fdf4; }.appeal-status.rejected { color: #991b1b; background: #fef2f2; }.appeal-status.closed { color: #475569; background: #f1f5f9; }.appeal-title b,.appeal-title small { display: block; }.appeal-title b { color: #27364d; font-size: 11px; }.appeal-title small { margin-top: 4px; color: #8a99ad; font-size: 9px; }.appeal-owner,.appeal-due { display: flex; align-items: center; gap: 6px; font-size: 10px; }.row-arrow { color: #94a3b8; font-size: 22px; }.trend-layout { padding-bottom: 18px; }
.empty-state { min-height: 170px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: #94a3b8; }.empty-state.tall { min-height: 370px; }.empty-state strong { color: #475569; font-size: 13px; }.empty-state span { font-size: 10px; }.empty-state .el-button { margin-top: 8px; }.health-loading { padding: 16px; }.skeleton-row { height: 58px; margin-bottom: 9px; border-radius: 8px; background: linear-gradient(90deg,#f1f5f9,#f8fafc,#f1f5f9); background-size: 200% 100%; animation: skeleton 1.2s ease infinite; }
.drawer-intro,.seller-center-note { min-width: 0; display: flex; gap: 12px; padding: 14px; border: 1px solid #dbeafe; border-radius: 10px; color: #1d4ed8; background: #eff6ff; }.drawer-intro>div,.seller-center-note>p { min-width: 0; }.drawer-intro strong { color: #1e3a8a; font-size: 13px; }.drawer-intro p,.seller-center-note p { margin: 4px 0 0; color: #526681; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }.settings-section { min-width: 0; margin-top: 22px; padding-top: 18px; border-top: 1px solid #eaf0f6; }.section-heading { min-width: 0; display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; }.section-heading>span { width: 28px; height: 28px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 7px; color: #1d4ed8; background: #eff6ff; font-size: 10px; font-weight: 800; }.section-heading>div { min-width: 0; }.section-heading strong,.section-heading small { display: block; }.section-heading strong { font-size: 13px; line-height: 1.45; }.section-heading small { margin-top: 2px; color: #718096; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }.key-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; color: #718096; font-size: 11px; }.key-meta .el-button { margin-left: auto; }.settings-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 0 12px; }.settings-grid>*,.settings-grid.two>* { min-width: 0; }.settings-grid.two { grid-template-columns: repeat(2,minmax(0,1fr)); }.settings-grid .full-field { grid-column: 1/-1; }.settings-grid :deep(.el-input-number),.settings-grid :deep(.el-select),.settings-grid :deep(.el-date-editor) { width: 100%; }.switch-row { min-width: 0; min-height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid #eef2f7; }.switch-row>div { min-width: 0; }.switch-row :deep(.el-switch) { flex: 0 0 auto; }.switch-row b,.switch-row small { display: block; }.switch-row b { font-size: 12px; line-height: 1.45; }.switch-row small { margin-top: 3px; color: #718096; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }.robot-field { margin-top: 12px; }.robot-field :deep(.el-select) { width: 100%; }.field-help { margin: 6px 0 0; color: #718096; font-size: 11px; line-height: 1.5; }.threshold-list { display: grid; max-width: 100%; max-height: 360px; overflow-y: auto; overflow-x: hidden; border: 1px solid #e2e8f0; border-radius: 10px; }.threshold-row { min-width: 0; min-height: 58px; display: grid; grid-template-columns: auto minmax(0,1fr) minmax(88px,105px); align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #eef2f7; }.threshold-row:last-child { border-bottom: 0; }.threshold-row>span { min-width: 0; }.threshold-row b,.threshold-row small { display: block; overflow-wrap: anywhere; }.threshold-row b { font-size: 11px; }.threshold-row small { margin-top: 2px; color: #718096; font-size: 10px; }.threshold-row :deep(.el-input-number) { width: 100%; }.settings-empty { color: #718096; font-size: 11px; line-height: 1.6; }.drawer-footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
:deep(.health-drawer) { max-width: 100vw; }
:deep(.health-drawer .el-drawer__header) { margin-bottom: 0; padding: 20px 20px 16px; }
:deep(.health-drawer .el-drawer__body) { min-width: 0; overflow-x: hidden; padding: 0 20px 20px; }
:deep(.health-drawer .el-drawer__footer) { padding: 12px 20px 16px; }
.notification-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; color: #64748b; font-size: 10px; }.notification-list { display: grid; }.notification-list article { display: grid; grid-template-columns: 8px 1fr; gap: 10px; padding: 14px 4px; border-bottom: 1px solid #eaf0f6; }.notification-dot { width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: #94a3b8; }.notification-list article.warning .notification-dot { background: #d97706; }.notification-list article.critical .notification-dot { background: #dc2626; }.notification-list article.unread strong { color: #172033; }.notification-list strong { font-size: 11px; }.notification-list p { margin: 4px 0; color: #64748b; font-size: 10px; line-height: 1.6; }.notification-list small { color: #94a3b8; font-size: 9px; }
.issue-detail-header { padding: 18px; border-left: 4px solid #d97706; border-radius: 10px; background: #fffbeb; }.issue-detail-header.critical { border-left-color: #dc2626; background: #fff7f7; }.issue-detail-header span { color: #64748b; font-size: 9px; font-weight: 800; letter-spacing: .06em; }.issue-detail-header h3 { margin: 5px 0; font-size: 18px; }.issue-detail-header p { margin: 0; color: #64748b; font-size: 11px; }.issue-facts { display: grid; grid-template-columns: repeat(2,1fr); gap: 1px; overflow: hidden; margin: 16px 0; border: 1px solid #e2e8f0; border-radius: 10px; background: #e2e8f0; }.issue-facts div { padding: 11px; background: #fff; }.issue-facts dt { color: #8a99ad; font-size: 9px; }.issue-facts dd { margin: 4px 0 0; color: #334155; font-size: 11px; font-weight: 650; }.raw-detail>strong { font-size: 11px; }.raw-detail pre { max-height: 280px; overflow: auto; padding: 13px; border-radius: 9px; color: #dbeafe; background: #172033; font: 9px/1.6 ui-monospace,Consolas,monospace; }.full-action { width: 100%; margin-top: 16px; }.appeal-drawer-title span { color: #2563eb; font-size: 9px; font-weight: 800; }.appeal-drawer-title h3 { margin: 5px 0 18px; font-size: 18px; }.evidence-heading { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }.evidence-heading b,.evidence-heading small { display: block; }.evidence-heading b { font-size: 11px; }.evidence-heading small { margin-top: 3px; color: #8a99ad; font-size: 9px; }.evidence-row { display: grid; grid-template-columns: .7fr 1.3fr auto; gap: 7px; margin-bottom: 8px; }
@keyframes skeleton { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .skeleton-row { animation: none; } * { scroll-behavior: auto !important; } }
@media (max-width: 1380px) { .health-table-head,.health-table-row { grid-template-columns: minmax(190px,1.4fr) 76px 86px 110px repeat(4,48px) 76px; column-gap: 6px; padding-inline: 13px; } }
@media (max-width: 1100px) { .health-summary { grid-template-columns: 1.15fr repeat(2,1fr); }.health-summary button { border-bottom: 1px solid #eaf0f6; }.issue-row { grid-template-columns: 5px 75px minmax(200px,1fr) auto; }.issue-time { display: none; }.issue-shop-row { grid-template-columns: 4px minmax(220px,1fr) 140px minmax(190px,1fr) auto; }.shop-risk-updated { display: none; }.appeal-row { grid-template-columns: 100px minmax(220px,1fr) 110px 130px 18px; } }
@media (max-width: 760px) { .health-command { align-items: stretch; flex-direction: column; padding: 18px; }.health-command-actions { display: grid; grid-template-columns: 44px 1fr 1.2fr; }.health-summary { grid-template-columns: repeat(2,1fr); }.summary-primary { grid-column: 1/-1; }.health-summary button { min-height: 78px; }.workspace-tabs { overflow-x: auto; }.workspace-tabs button { flex: 0 0 auto; min-height: 50px; }.last-run { display: none; }.filter-bar,.filter-bar.compact { grid-template-columns: 1fr 1fr; }.filter-bar .el-input,.issue-scope { grid-column: 1/-1; }.filter-spacer { display: none; }.health-table-head { display: none; }.health-table { padding: 9px; background: #f8fafc; }.health-table-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; min-height: 0; margin-bottom: 9px; padding: 14px; border: 1px solid #e2e8f0; border-radius: 11px; }.shop-identity { grid-column: 1/-1; }.data-cell { grid-column: 1/-1; padding: 8px 0; border-top: 1px solid #eef2f7; }.number-cell,.time-cell { display: flex; justify-content: space-between; }.number-cell::before,.time-cell::before { content: attr(data-label); color: #8a99ad; font-size: 9px; font-weight: 500; }.issue-shop-list { gap: 9px; padding: 9px; }.issue-shop-row { grid-template-columns: 4px minmax(0,1fr); gap: 10px; min-height: 0; padding: 13px 13px 13px 0; border: 1px solid #e2e8f0; border-radius: 11px; }.shop-risk-rail { grid-row: 1/5; }.issue-shop-identity,.shop-risk-counts,.shop-risk-types,.shop-risk-action { grid-column: 2; }.shop-risk-counts>small { width: auto; }.shop-risk-action { width: 100%; min-height: 42px; }.shop-drawer-summary { grid-template-columns: auto minmax(0,1fr); }.shop-drawer-counts { grid-column: 1/-1; display: flex; align-items: baseline; gap: 6px; text-align: left; }.shop-drawer-summary h3 { white-space: normal; }.drawer-issue-row { grid-template-columns: 4px minmax(0,1fr); }.drawer-severity-mark { grid-row: 1/3; }.drawer-issue-actions { grid-column: 2; flex-wrap: wrap; }.drawer-issue-actions .el-button { min-height: 38px; }.drawer-issue-copy p { white-space: normal; }.appeal-row { grid-template-columns: 1fr auto; gap: 8px; padding: 14px; }.appeal-status { grid-column: 1; }.appeal-title { grid-column: 1/-1; }.appeal-owner,.appeal-due { grid-column: 1; }.row-arrow { grid-column: 2; grid-row: 1/5; }.settings-grid,.settings-grid.two { grid-template-columns: 1fr; }.settings-grid .full-field { grid-column: auto; }.key-meta .el-button { width: 100%; margin-left: 0; }.threshold-row { grid-template-columns: auto minmax(0,1fr) 90px; }.evidence-row { grid-template-columns: 1fr auto; }.evidence-row .el-input:nth-child(2) { grid-column: 1; }.setup-callout,.key-error-callout { align-items: flex-start; flex-wrap: wrap; }.setup-callout .el-button,.key-error-callout .el-button { width: 100%; } :deep(.health-drawer .el-drawer__header) { padding-inline: 16px; } :deep(.health-drawer .el-drawer__body) { padding-inline: 16px; } :deep(.health-drawer .el-drawer__footer) { padding-inline: 16px; } }
</style>
