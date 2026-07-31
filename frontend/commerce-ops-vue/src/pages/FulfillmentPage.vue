<script setup lang="ts">
import { CircleAlert, Play, RefreshCw, Store, Truck } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import MetricCard from "@/components/MetricCard.vue";
import {
  loadFulfillmentWorkspace,
  runFulfillmentScan,
  type FulfillmentBatch,
  type FulfillmentDashboard,
  type FulfillmentHealth,
  type FulfillmentRecovery,
  type FulfillmentScheduler,
} from "@/services/overview";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const scanning = ref(false);
const error = ref("");
const activeTab = ref("shops");
const health = ref<FulfillmentHealth | null>(null);
const scheduler = ref<FulfillmentScheduler | null>(null);
const dashboard = ref<FulfillmentDashboard | null>(null);
const batches = ref<FulfillmentBatch[]>([]);
const recoveries = ref<FulfillmentRecovery[]>([]);

interface FulfillmentTotals { total: number; success: number; running: number; exceptions: number }

const totals = computed(() => (dashboard.value?.shops || []).reduce<FulfillmentTotals>((result, shop) => ({
  total: result.total + Number(shop.total || 0),
  success: result.success + Number(shop.success || 0),
  running: result.running + Number(shop.running || 0),
  exceptions: result.exceptions + Number(shop.exceptions || 0),
}), { total: 0, success: 0, running: 0, exceptions: 0 }));

const successRate = computed(() => totals.value.total ? `${Math.round(totals.value.success / totals.value.total * 100)}%` : "—");
const shopName = (shopId?: string) => health.value?.shops?.find((shop) => shop.id === shopId)?.name || shopId || "—";
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const result = await loadFulfillmentWorkspace();
    health.value = result.health;
    scheduler.value = result.scheduler;
    dashboard.value = result.dashboard;
    batches.value = Array.isArray(result.batches) ? result.batches : [];
    recoveries.value = Array.isArray(result.recoveries) ? result.recoveries : [];
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "履约数据加载失败");
  } finally {
    loading.value = false;
  }
}

async function scan() {
  await ElMessageBox.confirm("扫描只会读取订单并生成预览，不会直接提交发货。确认立即扫描？", "立即扫描订单", { confirmButtonText: "确认扫描", cancelButtonText: "取消", type: "warning" });
  scanning.value = true;
  try {
    const result = await runFulfillmentScan();
    ElMessage.success(result.message || "订单扫描已完成");
    await load();
  } catch (scanError) {
    ElMessage.error(String((scanError as Error)?.message || scanError || "订单扫描失败"));
  } finally {
    scanning.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="fulfillment-vue-page" v-loading="loading">
    <section class="module-toolbar fulfillment-toolbar">
      <div class="service-summary">
        <span class="live-indicator" :class="{ active: !error }"></span>
        <div><strong>{{ error ? "履约服务不可用" : "履约服务已连接" }}</strong><small>下次扫描：{{ time(scheduler?.nextScanAt) }}</small></div>
      </div>
      <div class="module-toolbar-actions">
        <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Play" :loading="scanning" @click="scan">立即扫描</el-button>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-else-if="health?.realSubmitEnabled" type="warning" :closable="false" show-icon title="真实提交已启用，请在确认批次前复核库存、仓库和物流渠道。" />

    <section class="metric-grid fulfillment-metrics">
      <MetricCard label="履约订单" :value="totals.total.toLocaleString('zh-CN')" hint="最近 7 天" />
      <MetricCard label="成功订单" :value="totals.success.toLocaleString('zh-CN')" hint="完成并校验" tone="success" />
      <MetricCard label="成功率" :value="successRate" hint="成功 / 总订单" tone="success" />
      <MetricCard label="执行中" :value="totals.running.toLocaleString('zh-CN')" hint="队列与恢复任务" tone="warning" />
      <MetricCard label="异常订单" :value="totals.exceptions.toLocaleString('zh-CN')" hint="需要人工处理" :tone="totals.exceptions ? 'danger' : 'default'" />
      <MetricCard label="接入店铺" :value="String(health?.shops?.length || 0)" hint="跨平台店铺" />
    </section>

    <section class="fulfillment-summary-grid">
      <article class="dashboard-panel">
        <header><div><span class="panel-kicker">QUEUE</span><h3>任务队列</h3></div><Truck :size="18" /></header>
        <div class="compact-stat-list">
          <div><span>最近扫描</span><strong>{{ time(scheduler?.lastScanAt) }}</strong></div>
          <div><span>扫描结果</span><strong>{{ scheduler?.lastOutcome || "—" }}</strong></div>
          <div><span>跟踪恢复</span><strong>{{ recoveries.length }}</strong></div>
          <div><span>最近批次</span><strong>{{ batches.length }}</strong></div>
        </div>
      </article>
      <article class="dashboard-panel">
        <header><div><span class="panel-kicker">EXCEPTIONS</span><h3>异常分类</h3></div><CircleAlert :size="18" /></header>
        <div class="exception-chip-list">
          <span v-for="item in dashboard?.exceptions || []" :key="item.code"><b>{{ item.count || 0 }}</b>{{ item.code || "未知异常" }}</span>
          <el-empty v-if="!dashboard?.exceptions?.length" :image-size="54" description="暂无异常" />
        </div>
      </article>
    </section>

    <section class="dashboard-panel data-workbench fulfillment-workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane name="shops"><template #label><span class="tab-label"><Store :size="15" />店铺状态</span></template>
          <el-table :data="health?.shops || []" stripe empty-text="暂无店铺配置">
            <el-table-column prop="countryCode" label="国家" width="90" />
            <el-table-column prop="platform" label="平台" width="130" />
            <el-table-column prop="name" label="店铺" min-width="200" />
            <el-table-column prop="channelName" label="默认物流渠道" min-width="180" show-overflow-tooltip />
            <el-table-column label="发货模式" width="130"><template #default="scope"><el-tag :type="scope.row.autoFulfillEnabled ? 'success' : 'info'">{{ scope.row.autoFulfillEnabled ? "自动发货" : "人工确认" }}</el-tag></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="履约批次" name="batches">
          <el-table :data="batches" stripe empty-text="暂无履约批次">
            <el-table-column prop="id" label="批次" min-width="180" show-overflow-tooltip />
            <el-table-column label="店铺" min-width="160"><template #default="scope">{{ shopName(scope.row.shopId) }}</template></el-table-column>
            <el-table-column prop="status" label="状态" width="120" />
            <el-table-column prop="orderCount" label="订单数" width="100" align="right" />
            <el-table-column prop="successCount" label="成功" width="90" align="right" />
            <el-table-column prop="failedCount" label="失败" width="90" align="right" />
            <el-table-column label="创建时间" width="150"><template #default="scope">{{ time(scope.row.createdAt) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="跟踪恢复" name="recoveries">
          <el-table :data="recoveries" stripe empty-text="暂无恢复任务">
            <el-table-column prop="orderReference" label="订单" min-width="180" />
            <el-table-column label="店铺" min-width="160"><template #default="scope">{{ shopName(scope.row.shopId) }}</template></el-table-column>
            <el-table-column prop="status" label="状态" width="130" />
            <el-table-column prop="reason" label="原因" min-width="240" show-overflow-tooltip />
            <el-table-column label="更新时间" width="150"><template #default="scope">{{ time(scope.row.updatedAt) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>
  </div>
</template>
