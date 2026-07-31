<script setup lang="ts">
import { Download, RefreshCw } from "@lucide/vue";
import { computed, onMounted, reactive, ref } from "vue";
import MetricCard from "@/components/MetricCard.vue";
import TrendChart from "@/components/TrendChart.vue";
import { loadSalesDashboard, type SalesDashboard } from "@/services/overview";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const error = ref("");
const dashboard = ref<SalesDashboard | null>(null);
const activeTab = ref("hierarchy");
const filters = reactive({ country: "", categoryL1: "", categoryL2: "", style: "" });

const options = computed(() => dashboard.value?.filters?.options || {});
const periodLabel = computed(() => {
  const period = dashboard.value?.period;
  if (!period?.orderDateFrom || !period?.orderDateTo) return `${workspace.periodDays} 天`;
  return `${period.orderDateFrom} 至 ${period.orderDateTo}`;
});

function money(value: unknown) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    dashboard.value = await loadSalesDashboard({ periodDays: workspace.periodDays, ...filters });
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "销售与货盘数据加载失败");
  } finally {
    loading.value = false;
  }
}

function reset() {
  Object.assign(filters, { country: "", categoryL1: "", categoryL2: "", style: "" });
  load();
}

onMounted(load);
</script>

<template>
  <div class="assortment-page" v-loading="loading">
    <section class="module-toolbar">
      <div class="module-filter-grid">
        <el-select v-model="filters.country" placeholder="全部国家" clearable><el-option v-for="item in options.countries || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.categoryL1" placeholder="一级类目" clearable filterable><el-option v-for="item in options.categoryL1 || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.categoryL2" placeholder="二级类目" clearable filterable><el-option v-for="item in options.categoryL2 || []" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="filters.style" placeholder="款名" clearable filterable><el-option v-for="item in options.styles || []" :key="item" :label="item" :value="item" /></el-select>
      </div>
      <div class="module-toolbar-actions">
        <el-button @click="reset">重置</el-button>
        <el-button :icon="RefreshCw" :loading="loading" @click="load">应用筛选</el-button>
        <el-button type="primary" :icon="Download" disabled>导出</el-button>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-else-if="dashboard?.period?.sufficient === false" type="warning" :closable="false" show-icon title="当前订单周期不足，趋势和日均指标仅供参考。" />

    <section class="metric-grid assortment-metrics">
      <MetricCard label="我方销售额" :value="dashboard ? money(dashboard.summary.ownAmount) : '—'" :hint="periodLabel" />
      <MetricCard label="货盘金额" :value="dashboard ? money(dashboard.summary.assortmentAmount) : '—'" hint="当前筛选货盘规模" />
      <MetricCard label="我方占比" :value="dashboard ? `${(dashboard.summary.ownShare * 100).toFixed(1)}%` : '—'" hint="我方销售 / 货盘" />
      <MetricCard label="日销售缺口" :value="dashboard ? money(dashboard.summary.dailySalesGap) : '—'" hint="预测日销与实际差额" tone="warning" />
      <MetricCard label="SKU 数" :value="dashboard ? dashboard.summary.skuCount.toLocaleString('zh-CN') : '—'" hint="有效货盘 SKU" />
      <MetricCard label="店铺数" :value="dashboard ? dashboard.summary.storeCount.toLocaleString('zh-CN') : '—'" hint="有效销售店铺" />
    </section>

    <section class="overview-grid assortment-chart-grid">
      <article class="dashboard-panel">
        <header><div><span class="panel-kicker">SALES TREND</span><h3>销售与货盘趋势</h3></div><span>{{ periodLabel }}</span></header>
        <TrendChart v-if="dashboard?.trend?.length" :rows="dashboard.trend" />
        <el-empty v-else description="当前筛选无趋势数据" />
      </article>
      <article class="dashboard-panel quality-panel">
        <header><div><span class="panel-kicker">DATA QUALITY</span><h3>数据准备度</h3></div><span>实时口径</span></header>
        <dl>
          <div><dt>订单明细</dt><dd>{{ Number(dashboard?.quality?.orderRows || 0).toLocaleString("zh-CN") }}</dd></div>
          <div><dt>库存明细</dt><dd>{{ Number(dashboard?.quality?.inventoryRows || 0).toLocaleString("zh-CN") }}</dd></div>
          <div><dt>产品包明细</dt><dd>{{ Number(dashboard?.quality?.productPackageRows || 0).toLocaleString("zh-CN") }}</dd></div>
          <div><dt>价格覆盖率</dt><dd>{{ `${(Number(dashboard?.quality?.priceCoverage || 0) * 100).toFixed(1)}%` }}</dd></div>
          <div><dt>未匹配产品</dt><dd>{{ Number(dashboard?.quality?.unmatchedInventoryProducts || 0).toLocaleString("zh-CN") }}</dd></div>
        </dl>
      </article>
    </section>

    <section class="dashboard-panel data-workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="经营层级" name="hierarchy">
          <el-table :data="dashboard?.hierarchy?.rows || []" stripe empty-text="暂无层级数据">
            <el-table-column prop="label" label="维度" min-width="180" fixed />
            <el-table-column prop="skuCount" label="SKU" width="100" align="right" sortable />
            <el-table-column label="货盘金额" width="150" align="right"><template #default="scope">{{ money(scope.row.assortmentAmount) }}</template></el-table-column>
            <el-table-column label="我方销售额" width="150" align="right"><template #default="scope">{{ money(scope.row.ownAmount) }}</template></el-table-column>
            <el-table-column label="销售占比" width="120" align="right"><template #default="scope">{{ `${(Number(scope.row.ownShare || 0) * 100).toFixed(1)}%` }}</template></el-table-column>
            <el-table-column label="日销售缺口" width="150" align="right"><template #default="scope">{{ money(scope.row.dailySalesGap) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="机会矩阵" name="opportunities">
          <el-table :data="dashboard?.opportunityMatrix || []" stripe empty-text="暂无机会数据">
            <el-table-column prop="country" label="国家" width="90" />
            <el-table-column prop="category" label="类目" min-width="180" />
            <el-table-column prop="label" label="对象" min-width="180" />
            <el-table-column prop="opportunityScore" label="机会分" width="110" align="right" sortable />
            <el-table-column label="日销售缺口" width="150" align="right"><template #default="scope">{{ money(scope.row.dailySalesGap) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="重点产品" name="products">
          <el-table :data="dashboard?.topProducts || []" stripe empty-text="暂无产品数据">
            <el-table-column prop="country" label="国家" width="90" fixed />
            <el-table-column prop="productName" label="产品" min-width="210" show-overflow-tooltip />
            <el-table-column prop="mainSku" label="主 SKU" min-width="150" show-overflow-tooltip />
            <el-table-column prop="categoryL1" label="一级类目" min-width="140" />
            <el-table-column prop="style" label="款名" min-width="130" />
            <el-table-column label="我方销售额" width="150" align="right"><template #default="scope">{{ money(scope.row.ownAmount) }}</template></el-table-column>
            <el-table-column prop="daysOfSupply" label="库存天数" width="110" align="right" sortable />
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="店铺表现" name="stores">
          <el-table :data="dashboard?.stores || []" stripe empty-text="暂无店铺数据">
            <el-table-column prop="country" label="国家" width="90" />
            <el-table-column prop="platform" label="平台" width="120" />
            <el-table-column prop="store" label="店铺" min-width="200" />
            <el-table-column label="我方销售额" width="150" align="right"><template #default="scope">{{ money(scope.row.ownAmount) }}</template></el-table-column>
            <el-table-column prop="opportunityCount" label="机会数" width="110" align="right" sortable />
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>
  </div>
</template>
