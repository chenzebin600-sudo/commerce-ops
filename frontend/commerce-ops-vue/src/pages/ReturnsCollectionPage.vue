<script setup lang="ts">
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  FileClock,
  RefreshCw,
  RotateCcw,
  Search,
  Store,
  TriangleAlert,
} from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import {
  loadReturnsCollectionDashboard,
  runReturnsCollection,
  type CollectedReturnCase,
  type CollectionHealth,
  type CollectionJobStatus,
  type ReturnCaseStatus,
  type ReturnsCollectionDashboard,
  type ReturnsCollectionJob,
} from "@/services/returns-collection";

const loading = ref(true);
const collecting = ref(false);
const dashboard = ref<ReturnsCollectionDashboard | null>(null);
const activeTab = ref("overview");
const shopQuery = ref("");
const shopCountry = ref("");
const shopHealth = ref("");
const jobStatus = ref("");
const caseQuery = ref("");
const caseCountry = ref("");
const caseStatus = ref("");
const selectedCase = ref<CollectedReturnCase | null>(null);
const caseDrawerOpen = ref(false);
const selectedJob = ref<ReturnsCollectionJob | null>(null);
const jobDrawerOpen = ref(false);
const syncingShopId = ref("");

const summary = computed(() => dashboard.value?.summary || {
  totalShops: 0, healthyShops: 0, attentionShops: 0, todayCases: 0,
  activeCases: 0, urgentCases: 0, coverageRate: 0,
});
const countries = computed(() => [...new Set((dashboard.value?.shops || []).map((shop) => shop.country))].sort());
const filteredShops = computed(() => (dashboard.value?.shops || []).filter((shop) => {
  const query = shopQuery.value.trim().toLocaleLowerCase("zh-CN");
  return (!shopCountry.value || shop.country === shopCountry.value)
    && (!shopHealth.value || shop.health === shopHealth.value)
    && (!query || `${shop.shopName}${shop.shopCode}${shop.shopId}`.toLocaleLowerCase("zh-CN").includes(query));
}));
const filteredJobs = computed(() => (dashboard.value?.jobs || []).filter((job) => !jobStatus.value || job.status === jobStatus.value));
const filteredCases = computed(() => (dashboard.value?.cases || []).filter((item) => {
  const query = caseQuery.value.trim().toLocaleLowerCase("zh-CN");
  return (!caseCountry.value || item.country === caseCountry.value)
    && (!caseStatus.value || item.status === caseStatus.value)
    && (!query || `${item.returnSn}${item.orderSn}${item.shopName}${item.items.map((line) => line.sku).join(" ")}`.toLocaleLowerCase("zh-CN").includes(query));
}));
const attentionShops = computed(() => (dashboard.value?.shops || []).filter((shop) => shop.health !== "healthy"));
const runningJobs = computed(() => (dashboard.value?.jobs || []).filter((job) => job.status === "running").length);

const healthMeta: Record<CollectionHealth, { label: string; type: "success" | "warning" | "danger" | "info" }> = {
  healthy: { label: "采集正常", type: "success" },
  delayed: { label: "同步延迟", type: "warning" },
  failed: { label: "采集失败", type: "danger" },
  unauthorized: { label: "未授权", type: "danger" },
  never: { label: "等待首采", type: "info" },
};
const jobStatusMeta: Record<CollectionJobStatus, { label: string; type: "success" | "warning" | "danger" | "info" }> = {
  running: { label: "执行中", type: "info" },
  success: { label: "成功", type: "success" },
  failed: { label: "失败", type: "danger" },
  partial: { label: "部分成功", type: "warning" },
};
const returnStatusMeta: Record<ReturnCaseStatus, { label: string; type: "success" | "warning" | "danger" | "info" }> = {
  requested: { label: "待响应", type: "danger" },
  processing: { label: "处理中", type: "warning" },
  accepted: { label: "已受理", type: "info" },
  completed: { label: "已完成", type: "success" },
  cancelled: { label: "已取消", type: "info" },
};
const jobTypeLabel: Record<ReturnsCollectionJob["type"], string> = {
  incremental: "增量同步", backfill: "历史回溯", repair: "补漏修复", detail: "详情补采",
};

function formatDate(value?: string | null, second = false) {
  if (!value) return "未执行";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    ...(second ? { second: "2-digit" } : {}), hour12: false,
  });
}
function formatMoney(value: number, currency: string) {
  try { return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
}
function dueLabel(value: string | null) {
  if (!value) return "无待办";
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "已超时";
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

async function load() {
  loading.value = true;
  try { dashboard.value = await loadReturnsCollectionDashboard(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "售后采集数据加载失败"); }
  finally { loading.value = false; }
}
async function collect(shopId?: string) {
  if (collecting.value || syncingShopId.value) return;
  if (shopId) syncingShopId.value = shopId;
  else collecting.value = true;
  try {
    dashboard.value = await runReturnsCollection(shopId ? [shopId] : []);
    ElMessage.success(shopId ? "该店铺已进入增量采集队列" : "已为全部可用店铺创建增量采集任务");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "启动采集失败");
  } finally {
    collecting.value = false;
    syncingShopId.value = "";
  }
}
function openCase(item: CollectedReturnCase) { selectedCase.value = item; caseDrawerOpen.value = true; }
function openJob(item: ReturnsCollectionJob) { selectedJob.value = item; jobDrawerOpen.value = true; }

onMounted(load);
</script>

<template>
  <div class="returns-collection-page" v-loading="loading">
    <section class="collection-commandbar" aria-label="采集操作">
      <div>
        <div class="collection-title-row">
          <h2>售后数据采集中心</h2>
          <el-tag v-if="dashboard?.source === 'demo'" type="info" effect="plain">演示数据</el-tag>
          <el-tag v-else type="success" effect="plain">实时数据</el-tag>
        </div>
        <p>统一监控多站点店铺的退货退款数据覆盖、同步延迟和失败恢复。</p>
      </div>
      <div class="collection-command-actions">
        <span class="generated-at">数据生成于 {{ formatDate(dashboard?.generatedAt, true) }}</span>
        <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新页面</el-button>
        <el-button type="primary" :icon="Database" :loading="collecting" @click="collect()">全部增量采集</el-button>
      </div>
    </section>

    <section class="collection-metrics" aria-label="采集概览">
      <article class="collection-metric">
        <span>纳管店铺</span><strong>{{ summary.totalShops }}</strong><small>{{ summary.healthyShops }} 家采集正常</small>
      </article>
      <article class="collection-metric tone-success">
        <span>数据覆盖率</span><strong>{{ summary.coverageRate }}%</strong><small>详情字段完整率</small>
      </article>
      <article class="collection-metric tone-warning">
        <span>需关注店铺</span><strong>{{ summary.attentionShops }}</strong><small>授权、延迟或采集异常</small>
      </article>
      <article class="collection-metric">
        <span>今日新增售后</span><strong>{{ summary.todayCases }}</strong><small>全部站点累计</small>
      </article>
      <article class="collection-metric">
        <span>处理中案件</span><strong>{{ summary.activeCases }}</strong><small>{{ runningJobs }} 个采集任务执行中</small>
      </article>
      <article class="collection-metric tone-danger">
        <span>即将超时</span><strong>{{ summary.urgentCases }}</strong><small>24 小时内需要响应</small>
      </article>
    </section>

    <section class="collection-workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane name="overview">
          <template #label><span class="collection-tab-label"><Activity :size="15" />数据总览</span></template>
          <div class="overview-layout">
            <article class="collection-panel coverage-panel">
              <header><div><span class="panel-kicker">COLLECTION COVERAGE</span><h3>采集覆盖与时效</h3></div><el-tag type="success" effect="plain">整体稳定</el-tag></header>
              <div class="coverage-body">
                <div class="coverage-gauge">
                  <el-progress type="dashboard" :percentage="summary.coverageRate" :stroke-width="10" :width="150" color="#2563eb" />
                  <p>标准化详情字段完整度</p>
                </div>
                <dl class="coverage-stats">
                  <div><dt>采集正常</dt><dd>{{ summary.healthyShops }} 家</dd></div>
                  <div><dt>需人工关注</dt><dd class="warning-text">{{ summary.attentionShops }} 家</dd></div>
                  <div><dt>当前执行任务</dt><dd>{{ runningJobs }} 个</dd></div>
                  <div><dt>补漏窗口</dt><dd>最近 7 天</dd></div>
                </dl>
              </div>
            </article>

            <article class="collection-panel attention-panel">
              <header><div><span class="panel-kicker">ATTENTION NEEDED</span><h3>需要处理的店铺</h3></div><el-button text @click="activeTab = 'shops'">查看全部</el-button></header>
              <div v-if="attentionShops.length" class="attention-stack">
                <button v-for="shop in attentionShops.slice(0, 4)" :key="shop.shopId" type="button" @click="activeTab = 'shops'">
                  <span class="attention-icon" :class="shop.health"><TriangleAlert v-if="shop.health === 'failed'" :size="17" /><Clock3 v-else :size="17" /></span>
                  <span class="attention-copy"><strong>{{ shop.shopName }}</strong><small>{{ shop.latestError || healthMeta[shop.health].label }}</small></span>
                  <el-tag :type="healthMeta[shop.health].type" effect="light">{{ healthMeta[shop.health].label }}</el-tag>
                </button>
              </div>
              <el-empty v-else description="所有店铺采集正常" :image-size="64" />
            </article>

            <article class="collection-panel latest-jobs-panel">
              <header><div><span class="panel-kicker">RECENT RUNS</span><h3>最近采集任务</h3></div><el-button text @click="activeTab = 'jobs'">进入任务中心</el-button></header>
              <el-table :data="dashboard?.jobs.slice(0, 5) || []" size="small" @row-click="openJob">
                <el-table-column prop="shopName" label="店铺" min-width="170" />
                <el-table-column label="类型" width="100"><template #default="scope">{{ jobTypeLabel[scope.row.type as ReturnsCollectionJob['type']] }}</template></el-table-column>
                <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="jobStatusMeta[scope.row.status as CollectionJobStatus].type" effect="light">{{ jobStatusMeta[scope.row.status as CollectionJobStatus].label }}</el-tag></template></el-table-column>
                <el-table-column label="新增 / 更新" width="120"><template #default="scope"><span class="tabular-number">{{ scope.row.inserted }} / {{ scope.row.updated }}</span></template></el-table-column>
                <el-table-column label="开始时间" width="120"><template #default="scope">{{ formatDate(scope.row.startedAt) }}</template></el-table-column>
                <el-table-column label="详情" width="72" align="right"><template #default="scope"><el-button text :icon="Eye" aria-label="查看任务详情" @click.stop="openJob(scope.row)" /></template></el-table-column>
              </el-table>
            </article>
          </div>
        </el-tab-pane>

        <el-tab-pane name="shops">
          <template #label><span class="collection-tab-label"><Store :size="15" />店铺监控</span></template>
          <div class="table-toolbar">
            <el-input v-model="shopQuery" :prefix-icon="Search" clearable placeholder="搜索店铺名称、编号或 Shop ID" aria-label="搜索店铺" />
            <el-select v-model="shopCountry" clearable placeholder="全部站点" aria-label="筛选站点"><el-option v-for="country in countries" :key="country" :label="country" :value="country" /></el-select>
            <el-select v-model="shopHealth" clearable placeholder="全部采集状态" aria-label="筛选采集状态"><el-option v-for="(meta, key) in healthMeta" :key="key" :label="meta.label" :value="key" /></el-select>
            <span class="toolbar-count">{{ filteredShops.length }} 家店铺</span>
          </div>
          <el-table :data="filteredShops" class="collection-table" stripe>
            <el-table-column label="店铺" min-width="220">
              <template #default="scope"><div class="shop-identity"><span>{{ scope.row.country }}</span><div><strong>{{ scope.row.shopName }}</strong><small>{{ scope.row.shopCode }} · {{ scope.row.shopId }}</small></div></div></template>
            </el-table-column>
            <el-table-column label="授权" width="98"><template #default="scope"><el-tag :type="scope.row.authorizationStatus === 'active' ? 'success' : 'danger'" effect="plain">{{ scope.row.authorizationStatus === 'active' ? '有效' : scope.row.authorizationStatus === 'expired' ? '已失效' : '未配置' }}</el-tag></template></el-table-column>
            <el-table-column label="采集状态" width="112"><template #default="scope"><el-tag :type="healthMeta[scope.row.health as CollectionHealth].type" effect="light">{{ healthMeta[scope.row.health as CollectionHealth].label }}</el-tag></template></el-table-column>
            <el-table-column label="最近同步" width="130"><template #default="scope"><div class="stacked-cell"><span>{{ formatDate(scope.row.lastSyncAt) }}</span><small v-if="scope.row.latencyMinutes !== null">延迟 {{ scope.row.latencyMinutes }} 分钟</small></div></template></el-table-column>
            <el-table-column prop="todayCollected" label="今日采集" width="100" align="right" />
            <el-table-column prop="totalCases" label="累计案件" width="110" align="right" />
            <el-table-column label="连续失败" width="90" align="right"><template #default="scope"><span :class="{ 'danger-text': scope.row.consecutiveFailures }" class="tabular-number">{{ scope.row.consecutiveFailures }}</span></template></el-table-column>
            <el-table-column label="最近问题" min-width="220"><template #default="scope"><span :class="scope.row.latestError ? 'error-copy' : 'muted-copy'">{{ scope.row.latestError || '未发现异常' }}</span></template></el-table-column>
            <el-table-column label="操作" width="112" fixed="right"><template #default="scope"><el-button text type="primary" :icon="RefreshCw" :loading="syncingShopId === scope.row.shopId" :disabled="scope.row.authorizationStatus !== 'active'" @click="collect(scope.row.shopId)">立即同步</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="jobs">
          <template #label><span class="collection-tab-label"><FileClock :size="15" />任务中心</span></template>
          <div class="table-toolbar compact-toolbar">
            <el-select v-model="jobStatus" clearable placeholder="全部任务状态" aria-label="筛选任务状态"><el-option v-for="(meta, key) in jobStatusMeta" :key="key" :label="meta.label" :value="key" /></el-select>
            <span class="toolbar-count">{{ filteredJobs.length }} 条执行记录</span>
          </div>
          <el-table :data="filteredJobs" class="collection-table" stripe @row-click="openJob">
            <el-table-column prop="id" label="任务编号" min-width="170" />
            <el-table-column label="店铺" min-width="180"><template #default="scope">{{ scope.row.shopName }} <small class="country-code">{{ scope.row.country }}</small></template></el-table-column>
            <el-table-column label="任务类型" width="110"><template #default="scope">{{ jobTypeLabel[scope.row.type as ReturnsCollectionJob['type']] }}</template></el-table-column>
            <el-table-column label="状态" width="110"><template #default="scope"><el-tag :type="jobStatusMeta[scope.row.status as CollectionJobStatus].type" effect="light">{{ jobStatusMeta[scope.row.status as CollectionJobStatus].label }}</el-tag></template></el-table-column>
            <el-table-column prop="scanned" label="扫描" width="88" align="right" />
            <el-table-column prop="inserted" label="新增" width="88" align="right" />
            <el-table-column prop="updated" label="更新" width="88" align="right" />
            <el-table-column prop="skipped" label="跳过" width="88" align="right" />
            <el-table-column label="执行时间" width="150"><template #default="scope">{{ formatDate(scope.row.startedAt) }}</template></el-table-column>
            <el-table-column label="错误 / 备注" min-width="230"><template #default="scope"><span :class="scope.row.error ? 'error-copy' : 'muted-copy'">{{ scope.row.error || '执行完成，无异常' }}</span></template></el-table-column>
            <el-table-column label="操作" width="88" fixed="right"><template #default="scope"><el-button v-if="scope.row.status === 'failed'" text type="primary" :icon="RotateCcw" @click.stop="collect(scope.row.shopId)">重试</el-button><el-button v-else text :icon="Eye" @click.stop="openJob(scope.row)">详情</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="cases">
          <template #label><span class="collection-tab-label"><Database :size="15" />售后数据</span></template>
          <div class="table-toolbar">
            <el-input v-model="caseQuery" :prefix-icon="Search" clearable placeholder="搜索退货单、订单号、店铺或 SKU" aria-label="搜索售后数据" />
            <el-select v-model="caseCountry" clearable placeholder="全部站点" aria-label="筛选售后站点"><el-option v-for="country in countries" :key="country" :label="country" :value="country" /></el-select>
            <el-select v-model="caseStatus" clearable placeholder="全部案件状态" aria-label="筛选案件状态"><el-option v-for="(meta, key) in returnStatusMeta" :key="key" :label="meta.label" :value="key" /></el-select>
            <span class="toolbar-count">{{ filteredCases.length }} 条售后数据</span>
          </div>
          <el-table :data="filteredCases" class="collection-table" stripe @row-click="openCase">
            <el-table-column prop="returnSn" label="退货退款单" min-width="150" />
            <el-table-column prop="orderSn" label="订单号" min-width="150" />
            <el-table-column label="店铺" min-width="185"><template #default="scope">{{ scope.row.shopName }} <small class="country-code">{{ scope.row.country }}</small></template></el-table-column>
            <el-table-column label="商品" min-width="200"><template #default="scope"><div class="stacked-cell"><span>{{ scope.row.items[0]?.name }}</span><small>{{ scope.row.items[0]?.sku }} · {{ scope.row.items[0]?.quantity }} 件</small></div></template></el-table-column>
            <el-table-column prop="reason" label="申请原因" min-width="145" />
            <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="returnStatusMeta[scope.row.status as ReturnCaseStatus].type" effect="light">{{ returnStatusMeta[scope.row.status as ReturnCaseStatus].label }}</el-tag></template></el-table-column>
            <el-table-column label="退款金额" width="125" align="right"><template #default="scope"><strong class="money-cell">{{ formatMoney(scope.row.refundAmount, scope.row.currency) }}</strong></template></el-table-column>
            <el-table-column label="处理时限" width="110"><template #default="scope"><span :class="{ 'danger-text': scope.row.dueAt && new Date(scope.row.dueAt).getTime() - Date.now() < 24 * 60 * 60 * 1000 }">{{ dueLabel(scope.row.dueAt) }}</span></template></el-table-column>
            <el-table-column label="完整度" width="90"><template #default="scope"><span class="completeness"><CheckCircle2 v-if="scope.row.complete" :size="15" /><AlertCircle v-else :size="15" />{{ scope.row.complete ? '完整' : '待补采' }}</span></template></el-table-column>
            <el-table-column label="详情" width="72" fixed="right" align="right"><template #default="scope"><el-button text :icon="Eye" aria-label="查看售后详情" @click.stop="openCase(scope.row)" /></template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>

    <el-drawer v-model="caseDrawerOpen" title="售后数据详情" size="min(560px, 92vw)">
      <div v-if="selectedCase" class="detail-drawer-content">
        <div class="drawer-status-row"><el-tag :type="returnStatusMeta[selectedCase.status].type" size="large">{{ returnStatusMeta[selectedCase.status].label }}</el-tag><span :class="selectedCase.complete ? 'complete-state' : 'incomplete-state'">{{ selectedCase.complete ? '数据已完整采集' : '详情字段等待补采' }}</span></div>
        <section class="drawer-section"><h4>案件信息</h4><dl><div><dt>退货退款单</dt><dd>{{ selectedCase.returnSn }}</dd></div><div><dt>关联订单</dt><dd>{{ selectedCase.orderSn }}</dd></div><div><dt>店铺</dt><dd>{{ selectedCase.shopName }}（{{ selectedCase.country }}）</dd></div><div><dt>买家</dt><dd>{{ selectedCase.buyerName }}</dd></div><div><dt>申请原因</dt><dd>{{ selectedCase.reason }}</dd></div><div><dt>申请时间</dt><dd>{{ formatDate(selectedCase.createdAt) }}</dd></div><div><dt>最后更新</dt><dd>{{ formatDate(selectedCase.updatedAt) }}</dd></div><div><dt>处理时限</dt><dd>{{ dueLabel(selectedCase.dueAt) }}</dd></div></dl></section>
        <section class="drawer-section"><h4>商品与金额</h4><div v-for="item in selectedCase.items" :key="item.sku" class="drawer-item"><div><strong>{{ item.name }}</strong><small>{{ item.sku }} · {{ item.quantity }} 件</small></div><b>{{ formatMoney(item.amount, selectedCase.currency) }}</b></div><div class="refund-total"><span>申请退款金额</span><strong>{{ formatMoney(selectedCase.refundAmount, selectedCase.currency) }}</strong></div></section>
        <section class="drawer-section"><h4>逆向物流</h4><div class="logistics-line"><Clock3 :size="17" /><div><strong>{{ selectedCase.logisticsStatus }}</strong><small>最新物流状态由详情补采任务更新</small></div></div></section>
      </div>
    </el-drawer>

    <el-drawer v-model="jobDrawerOpen" title="采集任务详情" size="min(520px, 92vw)">
      <div v-if="selectedJob" class="detail-drawer-content">
        <div class="drawer-status-row"><el-tag :type="jobStatusMeta[selectedJob.status].type" size="large">{{ jobStatusMeta[selectedJob.status].label }}</el-tag><strong>{{ selectedJob.id }}</strong></div>
        <section class="drawer-section"><h4>执行摘要</h4><dl><div><dt>店铺</dt><dd>{{ selectedJob.shopName }}（{{ selectedJob.country }}）</dd></div><div><dt>任务类型</dt><dd>{{ jobTypeLabel[selectedJob.type] }}</dd></div><div><dt>开始时间</dt><dd>{{ formatDate(selectedJob.startedAt, true) }}</dd></div><div><dt>完成时间</dt><dd>{{ formatDate(selectedJob.finishedAt, true) }}</dd></div><div><dt>重试次数</dt><dd>{{ selectedJob.retries }}</dd></div></dl></section>
        <section class="job-numbers"><div><span>扫描</span><strong>{{ selectedJob.scanned }}</strong></div><div><span>新增</span><strong>{{ selectedJob.inserted }}</strong></div><div><span>更新</span><strong>{{ selectedJob.updated }}</strong></div><div><span>跳过</span><strong>{{ selectedJob.skipped }}</strong></div></section>
        <el-alert v-if="selectedJob.error" :title="selectedJob.error" type="error" :closable="false" show-icon />
        <el-button v-if="selectedJob.status === 'failed'" type="primary" :icon="RotateCcw" :loading="syncingShopId === selectedJob.shopId" @click="collect(selectedJob.shopId)">重新执行该店铺采集</el-button>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.returns-collection-page { display: grid; gap: 16px; min-height: 620px; }
.collection-commandbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.collection-title-row { display: flex; align-items: center; gap: 10px; }
.collection-title-row h2 { margin: 0; font-size: 19px; letter-spacing: -.025em; }
.collection-commandbar p { margin: 5px 0 0; color: var(--ops-text-secondary); font-size: 13px; }
.collection-command-actions { display: flex; align-items: center; gap: 9px; }
.generated-at { color: var(--ops-text-muted); font-size: 11px; white-space: nowrap; }
.collection-metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.collection-metric { min-height: 108px; display: grid; align-content: start; gap: 5px; padding: 14px 15px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.collection-metric::before { content: ""; width: 24px; height: 3px; margin-bottom: 5px; border-radius: 4px; background: var(--ops-primary); }
.collection-metric.tone-success::before { background: var(--ops-success); }
.collection-metric.tone-warning::before { background: var(--ops-warning); }
.collection-metric.tone-danger::before { background: var(--ops-danger); }
.collection-metric span { color: var(--ops-text-secondary); font-size: 12px; font-weight: 650; }
.collection-metric strong { font-size: 26px; line-height: 1.1; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
.collection-metric small { color: var(--ops-text-muted); font-size: 11px; }
.collection-workbench { padding: 0 16px 16px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); overflow: hidden; }
.collection-workbench :deep(.el-tabs__header) { margin: 0 0 14px; }
.collection-tab-label { display: inline-flex; align-items: center; gap: 6px; }
.overview-layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr); gap: 12px; }
.collection-panel { overflow: hidden; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-sm); background: var(--ops-surface); }
.collection-panel > header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--ops-border-light); }
.collection-panel h3 { margin: 3px 0 0; font-size: 14px; }
.coverage-body { min-height: 220px; display: grid; grid-template-columns: 180px 1fr; align-items: center; gap: 16px; padding: 18px; }
.coverage-gauge { display: grid; justify-items: center; gap: 4px; }
.coverage-gauge p { margin: 0; color: var(--ops-text-muted); font-size: 11px; }
.coverage-stats { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border: 1px solid var(--ops-border-light); border-radius: 9px; overflow: hidden; }
.coverage-stats div { min-height: 78px; display: grid; align-content: center; gap: 5px; padding: 12px; border-right: 1px solid var(--ops-border-light); border-bottom: 1px solid var(--ops-border-light); }
.coverage-stats div:nth-child(even) { border-right: 0; }
.coverage-stats div:nth-last-child(-n+2) { border-bottom: 0; }
.coverage-stats dt { color: var(--ops-text-secondary); font-size: 11px; }
.coverage-stats dd { margin: 0; font-size: 17px; font-weight: 750; font-variant-numeric: tabular-nums; }
.attention-stack { display: grid; }
.attention-stack button { width: 100%; min-height: 55px; display: grid; grid-template-columns: 34px 1fr auto; align-items: center; gap: 10px; padding: 8px 13px; border: 0; border-bottom: 1px solid var(--ops-border-light); background: white; color: inherit; cursor: pointer; text-align: left; transition: background var(--ops-transition); }
.attention-stack button:hover { background: var(--ops-surface-muted); }
.attention-stack button:last-child { border-bottom: 0; }
.attention-icon { display: grid; place-items: center; width: 31px; height: 31px; border-radius: 8px; color: var(--ops-warning); background: #fff7ed; }
.attention-icon.failed { color: var(--ops-danger); background: #fef2f2; }
.attention-copy { min-width: 0; display: grid; gap: 2px; }
.attention-copy strong { font-size: 12px; }
.attention-copy small { overflow: hidden; color: var(--ops-text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.latest-jobs-panel { grid-column: 1 / -1; }
.latest-jobs-panel :deep(.el-table__row) { cursor: pointer; }
.table-toolbar { min-height: 54px; display: grid; grid-template-columns: minmax(260px, 360px) 130px 160px 1fr; align-items: center; gap: 9px; padding-bottom: 12px; }
.table-toolbar.compact-toolbar { grid-template-columns: 160px 1fr; }
.toolbar-count { justify-self: end; color: var(--ops-text-muted); font-size: 12px; }
.collection-table { --el-table-header-bg-color: var(--ops-surface-muted); --el-table-border-color: var(--ops-border-light); }
.collection-table :deep(th.el-table__cell) { color: var(--ops-text-secondary); font-size: 11px; font-weight: 700; }
.collection-table :deep(td.el-table__cell) { font-size: 12px; }
.collection-table :deep(.el-table__row) { cursor: pointer; }
.shop-identity { display: flex; align-items: center; gap: 10px; }
.shop-identity > span { flex: 0 0 34px; display: grid; place-items: center; width: 34px; height: 30px; border-radius: 7px; color: #1e40af; background: #eff6ff; font-size: 10px; font-weight: 800; }
.shop-identity > div, .stacked-cell { display: grid; gap: 2px; min-width: 0; }
.shop-identity strong { font-size: 12px; }
.shop-identity small, .stacked-cell small { color: var(--ops-text-muted); font-size: 10px; }
.tabular-number, .money-cell { font-variant-numeric: tabular-nums; }
.country-code { margin-left: 4px; color: var(--ops-text-muted); }
.error-copy { color: #b42318; }
.muted-copy { color: var(--ops-text-muted); }
.danger-text { color: var(--ops-danger); font-weight: 700; }
.warning-text { color: var(--ops-warning); }
.money-cell { font-size: 12px; }
.completeness { display: inline-flex; align-items: center; gap: 5px; color: var(--ops-success); font-size: 11px; }
.completeness:has(.lucide-alert-circle) { color: var(--ops-warning); }
.detail-drawer-content { display: grid; gap: 16px; }
.drawer-status-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.drawer-status-row > span, .drawer-status-row > strong { font-size: 12px; }
.complete-state { color: var(--ops-success); }
.incomplete-state { color: var(--ops-warning); }
.drawer-section { padding: 15px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-sm); }
.drawer-section h4 { margin: 0 0 13px; font-size: 13px; }
.drawer-section dl { display: grid; gap: 10px; margin: 0; }
.drawer-section dl div { display: grid; grid-template-columns: 110px 1fr; gap: 12px; }
.drawer-section dt { color: var(--ops-text-secondary); font-size: 11px; }
.drawer-section dd { margin: 0; font-size: 12px; text-align: right; }
.drawer-item, .refund-total, .logistics-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.drawer-item > div, .logistics-line > div { display: grid; gap: 3px; }
.drawer-item strong, .logistics-line strong { font-size: 12px; }
.drawer-item small, .logistics-line small { color: var(--ops-text-muted); font-size: 10px; }
.refund-total { margin-top: 13px; padding-top: 13px; border-top: 1px solid var(--ops-border-light); font-size: 12px; }
.refund-total strong { color: var(--ops-primary); font-size: 16px; }
.logistics-line { justify-content: flex-start; }
.logistics-line svg { color: var(--ops-primary); }
.job-numbers { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-sm); overflow: hidden; }
.job-numbers div { display: grid; gap: 4px; padding: 12px; border-right: 1px solid var(--ops-border-light); }
.job-numbers div:last-child { border-right: 0; }
.job-numbers span { color: var(--ops-text-muted); font-size: 10px; }
.job-numbers strong { font-size: 18px; font-variant-numeric: tabular-nums; }
@media (max-width: 1360px) {
  .collection-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .collection-commandbar { align-items: flex-start; }
  .collection-command-actions { flex-wrap: wrap; justify-content: flex-end; }
}
@media (max-width: 980px) {
  .overview-layout { grid-template-columns: 1fr; }
  .latest-jobs-panel { grid-column: auto; }
  .table-toolbar { grid-template-columns: 1fr 1fr; }
  .table-toolbar .el-input, .toolbar-count { grid-column: 1 / -1; }
  .toolbar-count { justify-self: start; }
}
@media (max-width: 720px) {
  .collection-commandbar { display: grid; }
  .collection-command-actions { justify-content: stretch; }
  .collection-command-actions .generated-at { width: 100%; }
  .collection-command-actions .el-button { flex: 1; margin-left: 0; }
  .collection-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .coverage-body { grid-template-columns: 1fr; }
  .coverage-stats { width: 100%; }
  .collection-workbench { padding: 0 10px 12px; }
}
@media (max-width: 440px) {
  .collection-metrics { grid-template-columns: 1fr; }
  .table-toolbar, .table-toolbar.compact-toolbar { grid-template-columns: 1fr; }
  .table-toolbar .el-input, .toolbar-count { grid-column: auto; }
  .coverage-stats { grid-template-columns: 1fr; }
  .coverage-stats div { border-right: 0; }
  .coverage-stats div:nth-last-child(-n+2) { border-bottom: 1px solid var(--ops-border-light); }
  .coverage-stats div:last-child { border-bottom: 0; }
}
</style>
