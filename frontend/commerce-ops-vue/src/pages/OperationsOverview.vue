<script setup lang="ts">
import { AlertTriangle, RefreshCw } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import MetricCard from "@/components/MetricCard.vue";
import TrendChart from "@/components/TrendChart.vue";
import { loadOperationsOverview, type FulfillmentDashboard, type SalesDashboard } from "@/services/overview";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(true);
const sales = shallowRef<Pick<SalesDashboard, "summary" | "trend" | "stores"> | null>(null);
const fulfillment = shallowRef<FulfillmentDashboard | null>(null);
const warnings = ref<string[]>([]);
let refreshController: AbortController | null = null;

interface FulfillmentTotals { total: number; success: number; running: number; exceptions: number }

const fulfillmentTotals = computed(() => (fulfillment.value?.shops || []).reduce<FulfillmentTotals>((total, shop) => ({
  total: total.total + Number(shop.total || 0),
  success: total.success + Number(shop.success || 0),
  running: total.running + Number(shop.running || 0),
  exceptions: total.exceptions + Number(shop.exceptions || 0),
}), { total: 0, success: 0, running: 0, exceptions: 0 }));

const successRate = computed(() => fulfillmentTotals.value.total
  ? `${Math.round(fulfillmentTotals.value.success / fulfillmentTotals.value.total * 100)}%`
  : "—");

async function refresh() {
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  loading.value = true;
  try {
    const result = await loadOperationsOverview(workspace.periodDays, controller.signal);
    if (controller.signal.aborted) return;
    sales.value = result.sales;
    fulfillment.value = result.fulfillment;
    warnings.value = result.warnings;
    workspace.lastSyncedAt = new Date();
  } finally {
    if (refreshController === controller) {
      refreshController = null;
      loading.value = false;
    }
  }
}

watch(() => workspace.periodDays, refresh);
onMounted(refresh);
onBeforeUnmount(() => refreshController?.abort());
</script>

<template>
  <div class="overview-page" v-loading="loading">
    <section class="overview-commandbar">
      <div><h2>跨境经营概览</h2><p>统一查看销售、货盘、店铺和履约的当前状态。</p></div>
      <el-button :icon="RefreshCw" :loading="loading" @click="refresh">刷新数据</el-button>
    </section>

    <el-alert v-if="warnings.length" type="warning" :closable="false" show-icon>
      <template #title>部分数据源暂不可用，已展示其余可用指标</template>
      <template #default>{{ warnings.join("；") }}</template>
    </el-alert>

    <section class="metric-grid" aria-label="核心经营指标">
      <MetricCard label="我方标准化估值" :value="sales ? `¥${(sales.summary.ownEstimatedAmount ?? sales.summary.ownAmount).toLocaleString('zh-CN')}` : '—'" :hint="`${workspace.periodDays} 天目标利润标价估值，非实际销售额`" />
      <MetricCard label="销售件数" :value="sales ? sales.summary.ownQuantity.toLocaleString('zh-CN') : '—'" hint="订单有效商品数量" />
      <MetricCard label="标准化承接占比" :value="sales ? `${Number(sales.summary.ownShare || 0).toFixed(1)}%` : '—'" hint="我方标准化估值 / 货盘标准化估值" />
      <MetricCard label="履约成功率" :value="successRate" :hint="`${fulfillmentTotals.total} 个履约订单`" tone="success" />
      <MetricCard label="执行中" :value="fulfillmentTotals.running.toLocaleString('zh-CN')" hint="正在处理的履约任务" tone="warning" />
      <MetricCard label="履约异常" :value="fulfillmentTotals.exceptions.toLocaleString('zh-CN')" hint="需要人工关注" :tone="fulfillmentTotals.exceptions ? 'danger' : 'default'" />
    </section>

    <section class="overview-grid">
      <article class="dashboard-panel trend-panel">
        <header><div><span class="panel-kicker">PERFORMANCE</span><h3>销售与货盘趋势</h3></div><span>最近 {{ workspace.periodDays }} 天</span></header>
        <TrendChart v-if="sales?.trend?.length" :rows="sales.trend" />
        <el-empty v-else description="暂无可展示的趋势数据" />
      </article>
      <article class="dashboard-panel attention-panel">
        <header><div><span class="panel-kicker">ATTENTION</span><h3>今日关注</h3></div><AlertTriangle :size="18" /></header>
        <div class="attention-list">
          <div><span>履约异常</span><strong>{{ fulfillmentTotals.exceptions }}</strong><small>进入履约中心处理</small></div>
          <div><span>销售缺口</span><strong>{{ sales ? `¥${sales.summary.dailySalesGap.toLocaleString('zh-CN')}` : '—' }}</strong><small>查看货盘机会</small></div>
          <div><span>机会店铺</span><strong>{{ sales?.stores.filter((store) => store.opportunityCount > 0).length || 0 }}</strong><small>存在可执行机会</small></div>
        </div>
      </article>
    </section>

    <section class="dashboard-panel store-panel">
      <header><div><span class="panel-kicker">STORES</span><h3>店铺经营概览</h3></div><span>{{ sales?.summary.storeCount || 0 }} 家店铺</span></header>
      <el-table :data="sales?.stores || []" stripe table-layout="fixed" empty-text="暂无店铺经营数据">
        <el-table-column prop="country" label="国家" width="90" />
        <el-table-column prop="platform" label="平台" width="120" />
        <el-table-column prop="store" label="店铺" min-width="180" show-overflow-tooltip />
        <el-table-column label="标准化估值" width="150" align="right"><template #default="scope">¥{{ Number(scope.row.ownAmount || 0).toLocaleString("zh-CN") }}</template></el-table-column>
        <el-table-column prop="opportunityCount" label="机会数" width="100" align="right" sortable />
      </el-table>
    </section>
  </div>
</template>
