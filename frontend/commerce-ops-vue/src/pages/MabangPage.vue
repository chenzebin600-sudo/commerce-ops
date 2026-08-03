<script setup lang="ts">
import { Image, Play, RefreshCw, ShieldCheck } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import {
  collectMabangData,
  loadMabangWorkspace,
  runScheduledTask,
  startImageTask,
  testMabangLogin,
  type MabangAccount,
  type MabangImageBatch,
  type ScheduledRun,
  type ScheduledTask,
} from "@/services/mabang";
import { useWorkspaceStore } from "@/stores/workspace";

const workspaceStore = useWorkspaceStore();
const loading = ref(false);
const actionLoading = ref(false);
const error = ref("");
const activeTab = ref("collection");
const scheduler = ref({ online: false, leaseUntil: null as string | null, updatedAt: null as string | null });
const encryptionConfigured = ref(false);
const accounts = ref<MabangAccount[]>([]);
const tasks = ref<ScheduledTask[]>([]);
const runs = ref<ScheduledRun[]>([]);
const imageAccounts = ref<MabangAccount[]>([]);
const imageBatches = ref<MabangImageBatch[]>([]);
const syncRuns = ref<Array<Record<string, unknown>>>([]);
const selectedImageAccount = ref("");
const collectionResult = ref<Record<string, unknown> | null>(null);
const credentials = reactive({ username: "", password: "", dateRange: [] as string[], kind: "orders" });

const successfulRuns = computed(() => runs.value.filter((item) => item.status === "success" || item.status === "completed").length);
const activeTasks = computed(() => tasks.value.filter((item) => item.enabled).length);
const activeImageBatch = computed(() => imageBatches.value.find((item) => ["pending", "running", "pause_requested"].includes(item.status)) || null);

function formatDate(value?: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function statusType(status?: string | null) {
  if (["success", "completed", "downloaded"].includes(status || "")) return "success";
  if (["failed"].includes(status || "")) return "danger";
  if (["partial_success", "warning", "paused"].includes(status || "")) return "warning";
  return "info";
}
function scheduleLabel(task: ScheduledTask) {
  const config = task.scheduleConfig || {};
  return `${task.scheduleType} · ${String(config.hour ?? "--").padStart(2, "0")}:${String(config.minute ?? "--").padStart(2, "0")} · ${task.timezone}`;
}

async function load() {
  loading.value = true; error.value = "";
  try {
    const result = await loadMabangWorkspace();
    scheduler.value = result.scheduler; encryptionConfigured.value = result.encryptionConfigured;
    accounts.value = result.accounts; tasks.value = result.tasks; runs.value = result.runs;
    imageAccounts.value = result.imageAccounts; imageBatches.value = result.imageBatches; syncRuns.value = result.syncRuns;
    if (!selectedImageAccount.value) selectedImageAccount.value = result.imageAccounts.find((item) => item.enabled)?.id || "";
    workspaceStore.lastSyncedAt = new Date();
  } catch (loadError) { error.value = String((loadError as Error)?.message || loadError || "马帮工作台加载失败"); }
  finally { loading.value = false; }
}

async function testLogin() {
  if (!credentials.username || !credentials.password) { ElMessage.warning("请输入马帮账号和密码"); return; }
  actionLoading.value = true;
  try { await testMabangLogin(credentials.username, credentials.password); ElMessage.success("马帮账号验证成功"); }
  catch (actionError) { ElMessage.error(String((actionError as Error)?.message || actionError || "登录验证失败")); }
  finally { credentials.password = ""; actionLoading.value = false; }
}

async function collect() {
  if (!credentials.username || !credentials.password) { ElMessage.warning("请输入马帮账号和密码"); return; }
  if (credentials.kind === "orders" && credentials.dateRange.length !== 2) { ElMessage.warning("请选择订单日期范围"); return; }
  actionLoading.value = true;
  try {
    collectionResult.value = await collectMabangData({ username: credentials.username, password: credentials.password, kind: credentials.kind, startDate: credentials.dateRange[0], endDate: credentials.dateRange[1] });
    ElMessage.success("马帮数据采集完成");
  } catch (actionError) { ElMessage.error(String((actionError as Error)?.message || actionError || "采集失败")); }
  finally { credentials.password = ""; actionLoading.value = false; }
}

async function runTask(task: ScheduledTask) {
  try {
    await ElMessageBox.confirm(`立即运行定时任务“${task.name}”？`, "运行马帮任务", { type: "info" });
    actionLoading.value = true; await runScheduledTask(task.id); await load(); ElMessage.success("任务已进入执行队列");
  } catch (action) { if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action)); }
  finally { actionLoading.value = false; }
}

async function startImages(mode: "full_initial" | "missing_only") {
  if (!selectedImageAccount.value) { ElMessage.warning("请选择可用马帮账号"); return; }
  try {
    if (mode === "full_initial") await ElMessageBox.confirm("全量图片同步会遍历全部 SKU 并安全分批执行，是否继续？", "启动图片同步", { type: "warning" });
    actionLoading.value = true; await startImageTask(selectedImageAccount.value, mode); await load(); ElMessage.success("图片任务已启动");
  } catch (action) { if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action)); }
  finally { actionLoading.value = false; }
}

onMounted(load);
</script>

<template>
  <div class="mabang-vue-page" v-loading="loading">
    <section class="module-toolbar mabang-toolbar">
      <div class="service-summary"><span class="live-indicator" :class="{ active: scheduler.online }" /><div><strong>{{ scheduler.online ? "调度器在线" : "调度器离线" }}</strong><small>账号加密：{{ encryptionConfigured ? "已配置" : "未配置" }} · {{ accounts.length }} 个账号</small></div></div>
      <div class="module-toolbar-actions"><el-button :icon="RefreshCw" @click="load">刷新全部数据</el-button></div>
    </section>
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <section class="dashboard-panel data-workbench mabang-workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="即时采集" name="collection">
          <div class="collection-layout">
            <section class="collection-form">
              <header><div><span class="panel-kicker">ON-DEMAND COLLECTION</span><h3>即时获取马帮数据</h3></div><ShieldCheck :size="20" /></header>
              <div class="collection-fields">
                <label><span>马帮账号</span><el-input v-model="credentials.username" autocomplete="username" /></label>
                <label><span>马帮密码</span><el-input v-model="credentials.password" type="password" show-password autocomplete="current-password" /></label>
                <label><span>数据类型</span><el-segmented v-model="credentials.kind" :options="[{ label: '订单', value: 'orders' }, { label: '库存', value: 'inventory' }]" /></label>
                <label v-if="credentials.kind === 'orders'"><span>订单日期</span><el-date-picker v-model="credentials.dateRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" /></label>
              </div>
              <div class="collection-actions"><el-button :loading="actionLoading" @click="testLogin">验证账号</el-button><el-button type="primary" :loading="actionLoading" @click="collect">开始采集</el-button></div>
              <p class="security-note">密码只用于本次本机请求，任务结束后会从输入框清除。</p>
            </section>
            <section class="collection-result"><span class="panel-kicker">LATEST RESULT</span><h3>最近采集结果</h3><pre v-if="collectionResult">{{ JSON.stringify(collectionResult, null, 2) }}</pre><el-empty v-else :image-size="80" description="本次会话暂无采集结果" /></section>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="`定时同步 ${activeTasks}`" name="scheduled">
          <div class="mabang-summary-row"><div><span>启用任务</span><strong>{{ activeTasks }}</strong></div><div><span>最近执行</span><strong>{{ runs.length }}</strong></div><div><span>成功执行</span><strong>{{ successfulRuns }}</strong></div><div><span>租约到期</span><strong>{{ formatDate(scheduler.leaseUntil) }}</strong></div></div>
          <el-table :data="tasks" stripe empty-text="暂无定时任务">
            <el-table-column prop="name" label="任务" min-width="220" />
            <el-table-column prop="taskType" label="类型" width="140" />
            <el-table-column prop="accountName" label="账号" min-width="150" />
            <el-table-column label="计划" min-width="220"><template #default="scope">{{ scheduleLabel(scope.row) }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="scope.row.enabled ? 'success' : 'info'">{{ scope.row.enabled ? "启用" : "停用" }}</el-tag></template></el-table-column>
            <el-table-column label="下次运行" width="170"><template #default="scope">{{ formatDate(scope.row.nextRunAt) }}</template></el-table-column>
            <el-table-column label="操作" width="100" fixed="right"><template #default="scope"><el-button link type="primary" :icon="Play" :disabled="actionLoading" @click="runTask(scope.row)">立即运行</el-button></template></el-table-column>
          </el-table>
          <h3 class="subtable-title">最近执行记录</h3>
          <el-table :data="runs" stripe empty-text="暂无执行记录">
            <el-table-column prop="taskName" label="任务" min-width="220" />
            <el-table-column prop="taskType" label="类型" width="130" />
            <el-table-column label="状态" width="110"><template #default="scope"><el-tag :type="statusType(scope.row.status)">{{ scope.row.status }}</el-tag></template></el-table-column>
            <el-table-column prop="detailRowCount" label="数据行" width="110" align="right" />
            <el-table-column label="开始时间" width="170"><template #default="scope">{{ formatDate(scope.row.startedAt || scope.row.scheduledRunAt) }}</template></el-table-column>
            <el-table-column prop="errorMessage" label="错误" min-width="220" show-overflow-tooltip />
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`SKU 图片 ${imageBatches.length}`" name="images">
          <section class="image-commandbar"><div><span class="panel-kicker">MABANG MEDIA</span><h3>SKU 图片采集</h3><p>安全分批下载、去重并关联到产品中心，不覆盖人工主图。</p></div><div class="image-actions"><el-select v-model="selectedImageAccount" placeholder="选择账号"><el-option v-for="account in imageAccounts.filter(item => item.enabled)" :key="account.id" :label="`${account.name} · ${account.usernameMasked || ''}`" :value="account.id" /></el-select><el-button :icon="Image" :loading="actionLoading" @click="startImages('missing_only')">补采缺失</el-button><el-button type="primary" :loading="actionLoading" @click="startImages('full_initial')">全量同步</el-button></div></section>
          <el-alert v-if="activeImageBatch" type="info" :closable="false" show-icon :title="`任务 ${activeImageBatch.id.slice(0,8)} 正在运行：第 ${activeImageBatch.currentPage || 0} / ${activeImageBatch.totalPages || '?'} 页`" />
          <el-table :data="imageBatches" stripe empty-text="暂无图片采集批次">
            <el-table-column label="批次" width="120"><template #default="scope">{{ scope.row.id.slice(0, 8) }}</template></el-table-column>
            <el-table-column prop="mode" label="模式" width="130" />
            <el-table-column label="状态" width="130"><template #default="scope"><el-tag :type="statusType(scope.row.status)">{{ scope.row.status }}</el-tag></template></el-table-column>
            <el-table-column label="页进度" width="110"><template #default="scope">{{ scope.row.currentPage || 0 }} / {{ scope.row.totalPages || "?" }}</template></el-table-column>
            <el-table-column label="发现 SKU" prop="discoveredSkus" width="110" align="right" />
            <el-table-column label="下载 / 重复" width="130" align="right"><template #default="scope">{{ scope.row.downloadedImages }} / {{ scope.row.duplicateImages }}</template></el-table-column>
            <el-table-column prop="failedImages" label="失败" width="90" align="right" />
            <el-table-column prop="linkedProducts" label="关联产品" width="110" align="right" />
            <el-table-column label="开始时间" min-width="170"><template #default="scope">{{ formatDate(scope.row.startedAt || scope.row.createdAt) }}</template></el-table-column>
          </el-table>
          <p class="sync-run-note">全量同步记录：{{ syncRuns.length }} 条</p>
        </el-tab-pane>
      </el-tabs>
    </section>
  </div>
</template>

<style scoped>
.mabang-vue-page { display: grid; gap: 16px; }.mabang-workbench { padding-bottom: 16px; }
.collection-layout { display: grid; grid-template-columns: minmax(0,1fr) minmax(320px,.75fr); gap: 14px; }.collection-form,.collection-result { border: 1px solid var(--ops-border-light); border-radius: 10px; padding: 16px; }.collection-form header { display: flex; justify-content: space-between; color: var(--ops-primary); }.collection-form h3,.collection-result h3 { margin: 4px 0 16px; color: var(--ops-text); }.collection-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }.collection-fields label { display: grid; gap: 7px; }.collection-fields span { color: var(--ops-text-secondary); font-size: 12px; }.collection-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }.security-note { margin: 10px 0 0; color: var(--ops-text-muted); font-size: 10px; }.collection-result pre { max-height: 330px; overflow: auto; margin: 0; padding: 14px; border-radius: 8px; background: #0f172a; color: #e2e8f0; font-size: 11px; }
.mabang-summary-row { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); margin-bottom: 14px; border: 1px solid var(--ops-border-light); border-radius: 10px; }.mabang-summary-row > div { display: grid; gap: 5px; padding: 14px; border-right: 1px solid var(--ops-border-light); }.mabang-summary-row > div:last-child { border-right: 0; }.mabang-summary-row span { color: var(--ops-text-secondary); font-size: 11px; }.mabang-summary-row strong { font-size: 16px; }.subtable-title { margin: 22px 0 10px; font-size: 14px; }
.image-commandbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 14px; }.image-commandbar h3 { margin: 4px 0; }.image-commandbar p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; }.image-actions { display: flex; gap: 8px; }.image-actions .el-select { width: 220px; }.sync-run-note { color: var(--ops-text-muted); font-size: 11px; }
@media (max-width: 920px) { .collection-layout { grid-template-columns: 1fr; }.image-commandbar { align-items: stretch; flex-direction: column; }.image-actions { flex-wrap: wrap; }.mabang-summary-row { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media (max-width: 520px) { .collection-fields { grid-template-columns: 1fr; }.image-actions { display: grid; grid-template-columns: 1fr 1fr; }.image-actions .el-select { grid-column: 1 / -1; width: 100%; }.mabang-summary-row { grid-template-columns: 1fr; } }
</style>
