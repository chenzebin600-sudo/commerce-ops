<script setup lang="ts">
import {
  Bot,
  CalendarClock,
  Download,
  Play,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import MetricCard from "@/components/MetricCard.vue";
import TrendChart from "@/components/TrendChart.vue";
import { loadSalesDashboard, type SalesDashboard } from "@/services/overview";
import {
  analyzeSalesDashboard,
  deleteDingtalkConfig,
  loadAutomationOverview,
  loadSalesAiStatus,
  runSyncTask,
  saveDailySyncTask,
  saveDingtalkConfig,
  setSyncTaskEnabled,
  testDingtalkConfig,
  type AutomationOverview,
  type DingtalkConfig,
  type MabangScheduledTask,
  type MabangSyncTaskType,
  type SalesAssortmentAnalysis,
  type SalesAssortmentAiStatus,
} from "@/services/sales-automation";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const error = ref("");
const dashboard = ref<SalesDashboard | null>(null);
const activeTab = ref("hierarchy");
const filters = reactive({ country: "", categoryL1: "", categoryL2: "", style: "" });

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
const periodLabel = computed(() => {
  const period = dashboard.value?.period;
  if (!period?.orderDateFrom || !period?.orderDateTo) return `${workspace.periodDays} 天`;
  return `${period.orderDateFrom} 至 ${period.orderDateTo}`;
});
const latestRunsByTask = computed(() => {
  const result = new Map<string, AutomationOverview["runs"][number]>();
  for (const run of automation.value?.runs || []) if (!result.has(run.taskId)) result.set(run.taskId, run);
  return result;
});

function money(value: unknown) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

function percent(value: unknown) {
  const number = Number(value || 0);
  const normalized = Math.abs(number) <= 1 ? number * 100 : number;
  return `${normalized.toFixed(1)}%`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function scheduleLabel(task: MabangScheduledTask) {
  const hour = String(task.scheduleConfig.hour ?? 0).padStart(2, "0");
  const minute = String(task.scheduleConfig.minute ?? 0).padStart(2, "0");
  return `每日 ${hour}:${minute}`;
}

function currentFilters(forceRefresh = false) {
  return {
    periodDays: workspace.periodDays,
    country: filters.country,
    categoryL1: filters.categoryL1,
    categoryL2: filters.categoryL2,
    style: filters.style,
    forceRefresh,
  };
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

async function load() {
  loading.value = true;
  error.value = "";
  try {
    dashboard.value = await loadSalesDashboard(currentFilters());
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "销售与货盘数据加载失败");
  } finally {
    loading.value = false;
  }
  if (dashboard.value) void analyze(false);
}

function reset() {
  Object.assign(filters, { country: "", categoryL1: "", categoryL2: "", style: "" });
  load();
}

function openTask(taskType: MabangSyncTaskType, task: MabangScheduledTask | null = null) {
  editingTask.value = task;
  const hour = String(task?.scheduleConfig.hour ?? 8).padStart(2, "0");
  const minute = String(task?.scheduleConfig.minute ?? 0).padStart(2, "0");
  Object.assign(taskForm, {
    taskType: task?.taskType || taskType,
    name: task?.name || (taskType === "order_export" ? "每日订单同步" : "每日库存同步"),
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

async function toggleTask(task: MabangScheduledTask) {
  try {
    await setSyncTaskEnabled(task.id, !task.enabled);
    await loadAutomation();
    ElMessage.success(task.enabled ? "任务已停用" : "任务已启用");
  } catch (actionError) {
    ElMessage.error(String((actionError as Error)?.message || actionError));
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
  await load();
});

onBeforeUnmount(() => analysisController?.abort());
</script>

<template>
  <div class="assortment-page" v-loading="loading">
    <section class="automation-command-center" aria-label="自动采集与智能分析">
      <header class="command-center-header">
        <div>
          <span class="panel-kicker">AUTOMATION & INTELLIGENCE</span>
          <h2>自动采集与智能分析</h2>
          <p>沿用马帮调度器更新订单和库存，入库后由 DeepSeek 基于当前筛选生成可核对的经营建议。</p>
        </div>
        <div class="command-center-actions">
          <el-button :icon="Bot" @click="openDingtalk()">钉钉机器人</el-button>
          <el-button :icon="CalendarClock" @click="openTask('order_export')">订单定时</el-button>
          <el-button type="primary" :icon="CalendarClock" @click="openTask('inventory_export')">库存定时</el-button>
        </div>
      </header>

      <el-alert v-if="automationError" type="error" :closable="false" show-icon :title="automationError" />
      <div class="automation-ai-grid">
        <article class="automation-panel" v-loading="automationLoading">
          <header>
            <div>
              <span class="panel-kicker">MABANG SCHEDULER</span>
              <h3>订单与库存定时采集</h3>
            </div>
            <div class="panel-status">
              <span class="live-indicator" :class="{ active: automation?.scheduler.online }" />
              {{ automation?.scheduler.online ? "调度器在线" : "调度器离线" }}
              <el-button text :icon="RefreshCw" aria-label="刷新自动采集状态" @click="loadAutomation" />
            </div>
          </header>
          <div v-if="automation?.tasks.length" class="automation-task-list">
            <div v-for="task in automation.tasks" :key="task.id" class="automation-task-row">
              <div class="task-kind" :class="task.taskType"><CalendarClock :size="17" /></div>
              <div class="task-copy">
                <strong>{{ task.name }}</strong>
                <span>{{ task.accountName }} · {{ scheduleLabel(task) }}<template v-if="task.notifyEnabled && task.dingtalkConfigId"> · 钉钉 {{ task.dingtalkName || "已启用" }}</template></span>
                <small>最近：{{ latestRunsByTask.get(task.id)?.status || task.lastRunStatus || "尚未运行" }} · 下次：{{ formatDate(task.nextRunAt) }}</small>
              </div>
              <el-tag :type="task.enabled ? 'success' : 'info'">{{ task.enabled ? "启用" : "停用" }}</el-tag>
              <div class="task-actions">
                <el-button text @click="openTask(task.taskType, task)">编辑</el-button>
                <el-button text :icon="Play" @click="runTask(task)">运行</el-button>
                <el-button text @click="toggleTask(task)">{{ task.enabled ? "停用" : "启用" }}</el-button>
              </div>
            </div>
          </div>
          <el-empty v-else description="尚未创建自动采集任务" :image-size="54">
            <div class="empty-actions"><el-button @click="openTask('order_export')">创建订单任务</el-button><el-button @click="openTask('inventory_export')">创建库存任务</el-button></div>
          </el-empty>
        </article>

        <article class="ai-panel" v-loading="aiLoading">
          <header>
            <div><span class="panel-kicker">DEEPSEEK ANALYSIS</span><h3>DeepSeek 经营分析</h3></div>
            <div class="panel-status"><el-tag :type="aiStatus?.configured ? 'success' : 'info'">{{ aiStatus?.configured ? aiStatus.model : "未配置" }}</el-tag><el-button text :icon="Sparkles" :disabled="!aiStatus?.configured || !dashboard" @click="analyze(true)">重新分析</el-button></div>
          </header>
          <el-alert v-if="aiError" type="warning" :closable="false" show-icon :title="aiError" />
          <div v-else-if="!aiStatus?.configured" class="ai-empty"><Bot :size="28" /><div><strong>等待 DeepSeek 配置</strong><span>配置密钥后，系统会自动分析当前筛选数据。</span></div></div>
          <div v-else-if="aiAnalysis" class="ai-result">
            <div class="ai-summary"><strong>{{ aiAnalysis.analysis.headline }}</strong><p>{{ aiAnalysis.analysis.overview }}</p><small>{{ formatDate(aiAnalysis.generatedAt) }} · {{ aiAnalysis.cached ? "缓存结果" : "最新分析" }}</small></div>
            <div class="ai-recommendations">
              <article v-for="item in aiAnalysis.analysis.recommendations.slice(0, 3)" :key="`${item.priority}-${item.title}`">
                <el-tag :type="item.priority === 'P0' ? 'danger' : item.priority === 'P1' ? 'warning' : 'info'">{{ item.priority }}</el-tag>
                <div><strong>{{ item.title }}</strong><p>{{ item.action }}</p><small>{{ item.evidence.slice(0, 2).join("；") }}</small></div>
              </article>
            </div>
          </div>
          <div v-else class="ai-empty"><Sparkles :size="28" /><div><strong>正在等待分析结果</strong><span>加载驾驶舱后会自动分析，也可以手动重新分析。</span></div></div>
        </article>
      </div>
    </section>

    <section class="module-toolbar">
      <div class="module-filter-grid">
        <el-select v-model="filters.country" placeholder="全部国家" clearable><el-option v-for="item in options.countries || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.categoryL1" placeholder="一级类目" clearable filterable><el-option v-for="item in options.categoryL1 || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.categoryL2" placeholder="二级类目" clearable filterable><el-option v-for="item in options.categoryL2 || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.style" placeholder="款名" clearable filterable><el-option v-for="item in options.styles || []" :key="item" :label="item" :value="item" /></el-select>
      </div>
      <div class="module-toolbar-actions"><el-button @click="reset">重置</el-button><el-button :icon="RefreshCw" :loading="loading" @click="load">应用筛选</el-button><el-button type="primary" :icon="Download" disabled>导出</el-button></div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-else-if="dashboard?.period?.sufficient === false" type="warning" :closable="false" show-icon title="当前订单周期不足，趋势和日均指标仅供参考。" />

    <section class="metric-grid assortment-metrics">
      <MetricCard label="我方销售额" :value="dashboard ? money(dashboard.summary.ownAmount) : '—'" :hint="periodLabel" />
      <MetricCard label="货盘金额" :value="dashboard ? money(dashboard.summary.assortmentAmount) : '—'" hint="当前筛选货盘规模" />
      <MetricCard label="我方占比" :value="dashboard ? percent(dashboard.summary.ownShare) : '—'" hint="我方销售 / 货盘" />
      <MetricCard label="日销售缺口" :value="dashboard ? money(dashboard.summary.dailySalesGap) : '—'" hint="预测日销与实际差额" tone="warning" />
      <MetricCard label="SKU 数" :value="dashboard ? dashboard.summary.skuCount.toLocaleString('zh-CN') : '—'" hint="有效货盘 SKU" />
      <MetricCard label="店铺数" :value="dashboard ? dashboard.summary.storeCount.toLocaleString('zh-CN') : '—'" hint="有效销售店铺" />
    </section>

    <section class="overview-grid assortment-chart-grid">
      <article class="dashboard-panel"><header><div><span class="panel-kicker">SALES TREND</span><h3>销售与货盘趋势</h3></div><span>{{ periodLabel }}</span></header><TrendChart v-if="dashboard?.trend?.length" :rows="dashboard.trend" /><el-empty v-else description="当前筛选无趋势数据" /></article>
      <article class="dashboard-panel quality-panel"><header><div><span class="panel-kicker">DATA QUALITY</span><h3>数据准备度</h3></div><span>实时口径</span></header><dl><div><dt>订单明细</dt><dd>{{ Number(dashboard?.quality?.orderRows || 0).toLocaleString("zh-CN") }}</dd></div><div><dt>库存明细</dt><dd>{{ Number(dashboard?.quality?.inventoryRows || 0).toLocaleString("zh-CN") }}</dd></div><div><dt>产品包明细</dt><dd>{{ Number(dashboard?.quality?.productPackageRows || 0).toLocaleString("zh-CN") }}</dd></div><div><dt>价格覆盖率</dt><dd>{{ percent(dashboard?.quality?.priceCoverage || 0) }}</dd></div><div><dt>未匹配产品</dt><dd>{{ Number(dashboard?.quality?.unmatchedInventoryProducts || 0).toLocaleString("zh-CN") }}</dd></div></dl></article>
    </section>

    <section class="dashboard-panel data-workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="经营层级" name="hierarchy"><el-table :data="dashboard?.hierarchy?.rows || []" stripe empty-text="暂无层级数据"><el-table-column prop="label" label="维度" min-width="180" fixed /><el-table-column prop="skuCount" label="SKU" width="100" align="right" sortable /><el-table-column label="货盘金额" width="150" align="right"><template #default="scope">{{ money(scope.row.assortmentAmount) }}</template></el-table-column><el-table-column label="我方销售额" width="150" align="right"><template #default="scope">{{ money(scope.row.ownAmount) }}</template></el-table-column><el-table-column label="销售占比" width="120" align="right"><template #default="scope">{{ percent(scope.row.ownShare) }}</template></el-table-column><el-table-column label="日销售缺口" width="150" align="right"><template #default="scope">{{ money(scope.row.dailySalesGap) }}</template></el-table-column></el-table></el-tab-pane>
        <el-tab-pane label="机会矩阵" name="opportunities"><el-table :data="dashboard?.opportunityMatrix || []" stripe empty-text="暂无机会数据"><el-table-column prop="country" label="国家" width="90" /><el-table-column prop="category" label="类目" min-width="180" /><el-table-column prop="label" label="对象" min-width="180" /><el-table-column prop="opportunityScore" label="机会分" width="110" align="right" sortable /><el-table-column label="日销售缺口" width="150" align="right"><template #default="scope">{{ money(scope.row.dailySalesGap) }}</template></el-table-column></el-table></el-tab-pane>
        <el-tab-pane label="重点产品" name="products"><el-table :data="dashboard?.topProducts || []" stripe empty-text="暂无产品数据"><el-table-column prop="country" label="国家" width="90" fixed /><el-table-column prop="productName" label="产品" min-width="210" show-overflow-tooltip /><el-table-column prop="mainSku" label="主 SKU" min-width="150" /><el-table-column prop="categoryL1" label="一级类目" min-width="140" /><el-table-column prop="style" label="款名" min-width="130" /><el-table-column label="我方销售额" width="150" align="right"><template #default="scope">{{ money(scope.row.ownAmount) }}</template></el-table-column><el-table-column prop="daysOfSupply" label="库存天数" width="110" align="right" sortable /></el-table></el-tab-pane>
        <el-tab-pane label="店铺表现" name="stores"><el-table :data="dashboard?.stores || []" stripe empty-text="暂无店铺数据"><el-table-column prop="country" label="国家" width="90" /><el-table-column prop="platform" label="平台" width="120" /><el-table-column prop="store" label="店铺" min-width="200" /><el-table-column label="我方销售额" width="150" align="right"><template #default="scope">{{ money(scope.row.ownAmount) }}</template></el-table-column><el-table-column prop="opportunityCount" label="机会数" width="110" align="right" sortable /></el-table></el-tab-pane>
      </el-tabs>
    </section>

    <el-dialog v-model="taskDialogOpen" :title="editingTask ? '编辑定时采集任务' : '新建定时采集任务'" width="min(620px, 94vw)">
      <el-form label-position="top">
        <div class="dialog-grid"><el-form-item label="数据类型"><el-segmented v-model="taskForm.taskType" :options="[{ label: '订单', value: 'order_export' }, { label: '库存', value: 'inventory_export' }]" :disabled="Boolean(editingTask)" /></el-form-item><el-form-item label="任务名称"><el-input v-model="taskForm.name" /></el-form-item><el-form-item label="马帮账号"><el-select v-model="taskForm.accountProfileId" filterable><el-option v-for="account in automation?.accounts || []" :key="account.id" :label="`${account.name} · ${account.usernameMasked}`" :value="account.id" :disabled="!account.enabled || !account.passwordConfigured" /></el-select></el-form-item><el-form-item label="每日执行时间"><el-time-picker v-model="taskForm.time" format="HH:mm" value-format="HH:mm" /></el-form-item><el-form-item v-if="taskForm.taskType === 'order_export'" label="订单付款时间"><el-select v-model="taskForm.paymentDateMode"><el-option label="昨天" value="yesterday" /><el-option label="当天" value="today" /></el-select></el-form-item><el-form-item label="钉钉机器人"><el-select v-model="taskForm.dingtalkConfigId" clearable placeholder="不通知"><el-option v-for="config in automation?.dingtalkConfigs || []" :key="config.id" :label="config.name" :value="config.id" :disabled="!config.enabled" /></el-select></el-form-item></div>
        <div class="switch-row"><el-switch v-model="taskForm.notifyEnabled" active-text="发送钉钉通知" /><el-switch v-model="taskForm.enabled" active-text="创建后启用" /></div>
      </el-form>
      <template #footer><el-button @click="taskDialogOpen = false">取消</el-button><el-button type="primary" :loading="taskSaving" @click="saveTask">保存任务</el-button></template>
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
.assortment-page { display: grid; gap: 16px; }
.automation-command-center { display: grid; gap: 14px; padding: 18px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.command-center-header,.automation-panel > header,.ai-panel > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.command-center-header h2 { margin: 5px 0; font-size: 20px; }.command-center-header p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; }.command-center-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.automation-ai-grid { display: grid; grid-template-columns: minmax(0,1.18fr) minmax(340px,.82fr); gap: 14px; }.automation-panel,.ai-panel { min-height: 300px; padding: 16px; border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface-muted); }.automation-panel h3,.ai-panel h3 { margin: 4px 0 0; font-size: 15px; }.panel-status { display: flex; align-items: center; gap: 7px; color: var(--ops-text-secondary); font-size: 11px; }
.automation-task-list { display: grid; gap: 8px; margin-top: 14px; }.automation-task-row { display: grid; grid-template-columns: 38px minmax(0,1fr) auto auto; align-items: center; gap: 10px; padding: 11px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); }.task-kind { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: #2563eb; background: #eff6ff; }.task-kind.inventory_export { color: #059669; background: #ecfdf5; }.task-copy { display: grid; gap: 3px; min-width: 0; }.task-copy strong { font-size: 12px; }.task-copy span,.task-copy small { overflow: hidden; color: var(--ops-text-secondary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.task-actions { display: flex; align-items: center; }.empty-actions { display: flex; gap: 8px; }
.ai-result { display: grid; gap: 12px; margin-top: 14px; }.ai-summary { padding: 14px; border-radius: 9px; background: linear-gradient(135deg,#eef6ff,#f7fbff); }.ai-summary strong { display: block; line-height: 1.5; }.ai-summary p { margin: 7px 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.65; }.ai-summary small { color: var(--ops-text-muted); font-size: 9px; }.ai-recommendations { display: grid; gap: 7px; }.ai-recommendations article { display: grid; grid-template-columns: auto minmax(0,1fr); align-items: start; gap: 9px; padding: 10px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); }.ai-recommendations strong { font-size: 11px; }.ai-recommendations p { margin: 3px 0; font-size: 10px; line-height: 1.5; }.ai-recommendations small { display: block; color: var(--ops-text-muted); font-size: 9px; line-height: 1.5; }.ai-empty { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 210px; color: var(--ops-text-muted); }.ai-empty div { display: grid; gap: 5px; }.ai-empty strong { color: var(--ops-text); }.ai-empty span { font-size: 11px; }
.dialog-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 0 16px; }.dialog-grid-wide { grid-column: 1 / -1; }.dialog-grid :deep(.el-select),.dialog-grid :deep(.el-date-editor) { width: 100%; }.switch-row { display: flex; flex-wrap: wrap; gap: 18px; }.robot-list { display: grid; gap: 8px; }.robot-list article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 12px; border: 1px solid var(--ops-border-light); border-radius: 8px; }.robot-list article > div:first-child { display: grid; gap: 4px; }.robot-list span { color: var(--ops-text-secondary); font-size: 10px; }
@media (max-width: 1050px) { .automation-ai-grid { grid-template-columns: 1fr; }.automation-task-row { grid-template-columns: 38px minmax(0,1fr) auto; }.task-actions { grid-column: 2 / -1; justify-content: flex-end; } }
@media (max-width: 760px) { .command-center-header { flex-direction: column; }.command-center-actions { width: 100%; justify-content: flex-start; }.automation-command-center { padding: 13px; }.dialog-grid { grid-template-columns: 1fr; }.dialog-grid-wide { grid-column: auto; } }
@media (max-width: 520px) { .automation-task-row { grid-template-columns: 34px minmax(0,1fr); }.automation-task-row > .el-tag { grid-column: 2; justify-self: start; }.task-actions { grid-column: 1 / -1; }.robot-list article { align-items: flex-start; flex-direction: column; } }
</style>
