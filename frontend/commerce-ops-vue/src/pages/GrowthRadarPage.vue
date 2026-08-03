<script setup lang="ts">
import { Play, RefreshCw } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import MetricCard from "@/components/MetricCard.vue";
import { loadGrowthTasks, loadGrowthWorkspace, runGrowthAnalysis, type GrowthWorkspace } from "@/services/growth";
import { useWorkspaceStore } from "@/stores/workspace";

const workspaceStore = useWorkspaceStore();
const loading = ref(false);
const analyzing = ref(false);
const error = ref("");
const workspace = ref<GrowthWorkspace | null>(null);
const tasks = ref<Array<Record<string, unknown>>>([]);
const activeTab = ref("tasks");

const summary = computed(() => workspace.value?.summary || {});
const readiness = computed(() => workspace.value?.readiness);

function number(value: unknown) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function percent(value: unknown) {
  const result = Number(value || 0);
  return `${(Math.abs(result) <= 1 ? result * 100 : result).toFixed(1)}%`;
}

function field(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return "—";
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [workspaceResult, taskResult] = await Promise.all([loadGrowthWorkspace(), loadGrowthTasks()]);
    workspace.value = workspaceResult;
    tasks.value = taskResult.items || workspaceResult.operationTasks || [];
    workspaceStore.lastSyncedAt = new Date();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "增长雷达加载失败");
  } finally {
    loading.value = false;
  }
}

async function analyze() {
  try {
    await ElMessageBox.confirm("将基于当前订单、库存和产品事实重新计算增长信号，是否继续？", "运行增长分析", { type: "info" });
    analyzing.value = true;
    await runGrowthAnalysis();
    await load();
    ElMessage.success("增长分析已完成");
  } catch (action) {
    if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action || "分析失败"));
  } finally {
    analyzing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="growth-radar-vue-page" v-loading="loading">
    <section class="module-toolbar growth-toolbar">
      <div class="service-summary"><span class="live-indicator" :class="{ active: workspace?.publishable }" /><div><strong>{{ workspace?.mode === "published" ? "已发布分析" : "数据准备模式" }}</strong><small>历史 {{ readiness?.historyDays || 0 }} / {{ readiness?.requiredHistoryDays || 0 }} 天</small></div></div>
      <div class="module-toolbar-actions"><el-button :icon="RefreshCw" @click="load">刷新</el-button><el-button type="primary" :icon="Play" :loading="analyzing" @click="analyze">运行分析</el-button></div>
    </section>
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-else-if="readiness?.blockers?.length" type="warning" :closable="false" show-icon :title="`当前有 ${readiness.blockers.length} 个数据阻塞项`" :description="readiness.blockers.join('；')" />

    <section class="metric-grid">
      <MetricCard label="需行动店铺" :value="number(summary.actionRequiredStoreCount)" hint="优先进入任务池" tone="danger" />
      <MetricCard label="观察店铺" :value="number(summary.watchStoreCount)" hint="趋势或覆盖异常" tone="warning" />
      <MetricCard label="稳定店铺" :value="number(summary.stableStoreCount)" hint="当前经营稳定" tone="success" />
      <MetricCard label="运营任务" :value="number(summary.publishedTaskCount || tasks.length)" hint="已发布任务" />
      <MetricCard label="库存 SKU" :value="number(readiness?.inventorySkuCount)" hint="库存事实覆盖" />
      <MetricCard label="未映射仓库" :value="number(readiness?.unmappedWarehouseCount)" hint="需要配置国家" tone="warning" />
    </section>

    <section class="dashboard-panel data-workbench growth-workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="运营任务" name="tasks">
          <el-table :data="tasks" stripe empty-text="暂无运营任务">
            <el-table-column label="优先级" width="90"><template #default="scope"><el-tag :type="field(scope.row, 'priority') === 'P0' ? 'danger' : field(scope.row, 'priority') === 'P1' ? 'warning' : 'info'">{{ field(scope.row, "priority") }}</el-tag></template></el-table-column>
            <el-table-column label="任务" min-width="250"><template #default="scope"><div class="growth-primary-cell"><strong>{{ field(scope.row, "title") }}</strong><span>{{ field(scope.row, "discovery", "description") }}</span></div></template></el-table-column>
            <el-table-column label="店铺" min-width="170"><template #default="scope">{{ field(scope.row, "shopName", "shop_name") }}</template></el-table-column>
            <el-table-column label="国家" width="100"><template #default="scope">{{ field(scope.row, "countryName", "country_code", "countryCode") }}</template></el-table-column>
            <el-table-column label="负责人" width="130"><template #default="scope">{{ field(scope.row, "manager", "ownerUserId", "owner_user_id") }}</template></el-table-column>
            <el-table-column label="状态" width="130"><template #default="scope">{{ field(scope.row, "status") }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="店铺雷达" name="stores">
          <el-table :data="workspace?.stores || []" stripe empty-text="暂无店铺分析">
            <el-table-column label="店铺" min-width="220"><template #default="scope">{{ field(scope.row, "shopName", "shop_name") }}</template></el-table-column>
            <el-table-column label="国家" width="100"><template #default="scope">{{ field(scope.row, "countryName", "country_code") }}</template></el-table-column>
            <el-table-column label="平台" width="120"><template #default="scope">{{ field(scope.row, "platform") }}</template></el-table-column>
            <el-table-column label="近 7 日" width="130" align="right"><template #default="scope">{{ number(field(scope.row, "current7d", "current_7d")) }}</template></el-table-column>
            <el-table-column label="趋势" width="110" align="right"><template #default="scope">{{ percent(field(scope.row, "trendPercent", "trend_percent")) }}</template></el-table-column>
            <el-table-column label="状态" width="140"><template #default="scope">{{ field(scope.row, "state") }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="产品机会" name="products">
          <el-table :data="workspace?.products || []" stripe empty-text="暂无产品机会">
            <el-table-column label="SKU" min-width="150"><template #default="scope">{{ field(scope.row, "sku") }}</template></el-table-column>
            <el-table-column label="产品" min-width="220"><template #default="scope">{{ field(scope.row, "name", "productName") }}</template></el-table-column>
            <el-table-column label="国家" width="100"><template #default="scope">{{ field(scope.row, "countryName", "countryCode") }}</template></el-table-column>
            <el-table-column label="预测日销" width="130" align="right"><template #default="scope">{{ number(field(scope.row, "predictedDailySales")) }}</template></el-table-column>
            <el-table-column label="捕获率" width="110" align="right"><template #default="scope">{{ percent(field(scope.row, "captureRatio")) }}</template></el-table-column>
            <el-table-column label="方向" min-width="160"><template #default="scope">{{ field(scope.row, "direction") }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="数据准备度" name="readiness">
          <div class="readiness-grid">
            <div><span>库存行</span><strong>{{ number(readiness?.inventoryRowCount) }}</strong></div>
            <div><span>仓库映射</span><strong>{{ number(readiness?.mappedWarehouseCount) }} / {{ number(readiness?.warehouseCount) }}</strong></div>
            <div><span>店铺映射</span><strong>{{ number(readiness?.mappedShopCount) }} / {{ number(readiness?.sourceShopCount) }}</strong></div>
            <div><span>任务发布</span><strong>{{ readiness?.operationTasksPublishable ? "已就绪" : "未就绪" }}</strong></div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </section>
  </div>
</template>

<style scoped>
.growth-radar-vue-page { display: grid; gap: 18px; }
.growth-toolbar { min-height: 66px; }
.growth-primary-cell { display: grid; gap: 4px; }
.growth-primary-cell span { color: var(--ops-text-secondary); font-size: 11px; }
.readiness-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 12px 0; }
.readiness-grid > div { display: grid; gap: 7px; padding: 18px; border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface-muted); }
.readiness-grid span { color: var(--ops-text-secondary); font-size: 11px; }
.readiness-grid strong { font-size: 20px; }
@media (max-width: 760px) { .readiness-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
