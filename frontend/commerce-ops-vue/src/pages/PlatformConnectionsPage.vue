<script setup lang="ts">
import {
  Cable,
  CheckCircle2,
  KeyRound,
  RefreshCw,
  Search,
  Store as StoreIcon,
  TriangleAlert,
} from "@lucide/vue";
import dayjs from "dayjs";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  loadCommercePlatforms,
  loadPlatformConnectionShops,
  loadPlatformRuntimeStatus,
  synchronizePlatformApiShops,
  type CommercePlatform,
  type PlatformConnectionShop,
  type PlatformRuntimeStatus,
} from "@/services/platform-connections";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(true);
const syncing = ref(false);
const error = ref("");
const runtime = ref<PlatformRuntimeStatus | null>(null);
const platforms = ref<CommercePlatform[]>([]);
const shops = ref<PlatformConnectionShop[]>([]);
const page = ref(1);
const pageSize = ref(25);
const filters = reactive({ search: "", platform: "", country: "", authorization: "" });
let loadController: AbortController | null = null;

const platformMap = computed(() => new Map(platforms.value.map((platform) => [platform.id, platform])));
const countryOptions = computed(() => [...new Set(shops.value.map((shop) => shop.country).filter(Boolean))].sort());
const authorizedCount = computed(() => shops.value.filter((shop) => shop.authorizationStatus === "AUTHORIZED").length);
const callableCount = computed(() => shops.value.filter((shop) => shop.callable).length);
const attentionCount = computed(() => shops.value.filter((shop) => shop.authorizationStatus !== "AUTHORIZED").length);

function platformFor(shop: PlatformConnectionShop) {
  return platformMap.value.get(shop.platformId);
}

function platformName(shop: PlatformConnectionShop) {
  return platformFor(shop)?.name || shop.platformId;
}

function shortCode(shop: PlatformConnectionShop) {
  return String(shop.platformShortCode || shop.metadata?.providerShortCode || shop.metadata?.shortCode || "—");
}

function authorizationType(shop: PlatformConnectionShop) {
  if (shop.authorizationStatus === "AUTHORIZED") return "success";
  if (["EXPIRED", "AUTHORIZATION_ERROR", "REVIEW_REQUIRED"].includes(shop.authorizationStatus || "")) return "danger";
  return "warning";
}

function authorizationLabel(shop: PlatformConnectionShop) {
  if (shop.authorizationStatus === "AUTHORIZED") {
    const application = shop.authorization?.applicationId;
    return application ? `已授权 · ${application}` : "已授权";
  }
  return shop.authorizationLabel || "未授权";
}

function expiryTime(shop: PlatformConnectionShop) {
  if (shop.authorizationDelegated) return "由 Broker 托管";
  return shop.authorization?.expiresAt ? dayjs(shop.authorization.expiresAt).format("YYYY-MM-DD HH:mm") : "—";
}

function availabilityReason(shop: PlatformConnectionShop) {
  if (shop.identityStatus === "REVIEW_REQUIRED") return "平台身份存在冲突，需核对";
  if (shop.callable) return "可通过 Commerce API Gateway 调用";
  if (shop.authorizationStatus === "EXPIRED") return "授权已过期，需刷新或重新授权";
  if (shop.authorizationStatus === "AUTHORIZED") return "Connector 或平台状态不可用";
  return "尚未完成平台授权";
}

const filteredShops = computed(() => {
  const search = filters.search.trim().toLocaleLowerCase();
  return shops.value
    .filter((shop) => !filters.platform || shop.platformId === filters.platform)
    .filter((shop) => !filters.country || shop.country === filters.country)
    .filter((shop) => !filters.authorization || shop.authorizationStatus === filters.authorization)
    .filter((shop) => !search || [shop.shopCode, shop.shopName, shop.sellerId, shortCode(shop), platformName(shop)]
      .some((value) => String(value || "").toLocaleLowerCase().includes(search)))
    .sort((left, right) => `${left.shopCode}-${left.shopName}`.localeCompare(`${right.shopCode}-${right.shopName}`, "zh-CN"));
});

const pagedShops = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return filteredShops.value.slice(start, start + pageSize.value);
});

watch(filters, () => { page.value = 1; });

function resetFilters() {
  Object.assign(filters, { search: "", platform: "", country: "", authorization: "" });
}

async function load() {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  error.value = "";
  try {
    const [statusResult, platformResult, shopResult] = await Promise.all([
      loadPlatformRuntimeStatus(controller.signal),
      loadCommercePlatforms(controller.signal),
      loadPlatformConnectionShops(controller.signal),
    ]);
    if (controller.signal.aborted) return;
    runtime.value = statusResult;
    platforms.value = platformResult;
    shops.value = shopResult;
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    if (!controller.signal.aborted) error.value = String((loadError as Error)?.message || "平台接入数据加载失败");
  } finally {
    if (loadController === controller) {
      loadController = null;
      loading.value = false;
    }
  }
}

async function synchronizeProjection() {
  try {
    await ElMessageBox.confirm(
      "将把当前 Platform Gateway 店铺集合写入 PostgreSQL 非敏感投影。负责人、品类和控价店型会保留；名称或代码候选不会自动合并。是否继续？",
      "确认同步 API 店铺投影",
      { type: "warning", confirmButtonText: "确认同步", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  syncing.value = true;
  try {
    const result = await synchronizePlatformApiShops();
    const reviewText = result.reviewRequired ? `，${result.reviewRequired} 家待核对` : "";
    ElMessage.success(`已同步 ${result.observed} 家 API 店铺${reviewText}`);
    await load();
  } catch (syncError) {
    ElMessage.error(String((syncError as Error)?.message || "API 店铺投影同步失败"));
  } finally {
    syncing.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => loadController?.abort());
</script>

<template>
  <div class="platform-connections-page" v-loading="loading">
    <section class="connection-commandbar" aria-label="Commerce API Gateway 状态">
      <div class="gateway-state">
        <span class="gateway-indicator" :class="{ ready: runtime?.enabled }" aria-hidden="true" />
        <div>
          <strong>{{ runtime?.enabled ? "Commerce API Gateway 已就绪" : "Commerce API Gateway 暂不可用" }}</strong>
          <span>店铺技术身份与授权直接采用平台 API 数据，本地只叠加非敏感业务补充</span>
        </div>
      </div>
      <div class="gateway-actions">
        <el-button :icon="RefreshCw" type="primary" :loading="syncing" @click="synchronizeProjection">同步 API 店铺投影</el-button>
        <el-button :loading="loading" @click="load">刷新实时状态</el-button>
      </div>
    </section>

    <el-alert v-if="error" role="alert" type="error" :closable="false" show-icon :title="error">
      <template #default><el-button size="small" @click="load">重新加载</el-button></template>
    </el-alert>

    <section class="connection-metrics" aria-label="平台接入核心指标">
      <article><span class="metric-icon total"><StoreIcon :size="19" /></span><div><span>API 店铺</span><strong>{{ shops.length }}</strong><small>权威集合来自 Platform Gateway</small></div></article>
      <article><span class="metric-icon success"><CheckCircle2 :size="19" /></span><div><span>已授权</span><strong>{{ authorizedCount }}</strong><small>授权状态来自 Connector</small></div></article>
      <article><span class="metric-icon country"><Cable :size="19" /></span><div><span>当前可调用</span><strong>{{ callableCount }}</strong><small>Gateway 与 Token 均有效</small></div></article>
      <article><span class="metric-icon warning"><TriangleAlert :size="19" /></span><div><span>待处理</span><strong>{{ attentionCount }}</strong><small>未授权、过期或身份冲突</small></div></article>
    </section>

    <section class="connection-filterbar" aria-label="接入店铺筛选">
      <label class="wide-filter"><span>搜索店铺</span><el-input v-model="filters.search" :prefix-icon="Search" clearable placeholder="店编、店名、Seller ID 或短码" /></label>
      <label><span>平台</span><el-select v-model="filters.platform" clearable placeholder="全部平台"><el-option v-for="platform in platforms" :key="platform.id" :label="platform.name" :value="platform.id" /></el-select></label>
      <label><span>国家 / 地区</span><el-select v-model="filters.country" clearable placeholder="全部国家"><el-option v-for="country in countryOptions" :key="country" :label="country" :value="country" /></el-select></label>
      <label><span>授权状态</span><el-select v-model="filters.authorization" clearable placeholder="全部状态"><el-option label="已授权" value="AUTHORIZED" /><el-option label="未授权" value="NOT_AUTHORIZED" /><el-option label="已过期" value="EXPIRED" /><el-option label="待核对" value="REVIEW_REQUIRED" /></el-select></label>
      <div class="connection-filter-actions"><span>筛选结果 {{ filteredShops.length }} 家</span><el-button @click="resetFilters">重置</el-button></div>
    </section>

    <section class="dashboard-panel connection-table-panel">
      <header><div><span class="panel-kicker">PLATFORM API SHOP AUTHORITY</span><h3>平台 API 接入店铺</h3></div><span>API 身份为准；负责人、品类与控价店型来自本地业务补充</span></header>
      <el-table class="connection-table" :data="pagedShops" stripe table-layout="fixed" empty-text="没有符合条件的店铺">
        <el-table-column prop="shopCode" label="店编" width="92" fixed="left" />
        <el-table-column label="平台 / 店铺" min-width="220"><template #default="scope"><div class="shop-identity"><strong>{{ scope.row.shopName }}</strong><span>{{ platformName(scope.row) }} · {{ scope.row.country }} / {{ scope.row.siteDefaultCurrency || "币种待补" }} · {{ scope.row.categoryName || "未设置品类" }}</span></div></template></el-table-column>
        <el-table-column label="负责人" min-width="150"><template #default="scope"><div class="stacked-cell"><strong>{{ scope.row.managerName || "—" }}</strong><span>高级：{{ scope.row.seniorManagerName || "—" }}</span></div></template></el-table-column>
        <el-table-column label="Seller ID / 短码" min-width="190"><template #default="scope"><div class="stacked-cell"><code>{{ scope.row.sellerId || "—" }}</code><span>{{ shortCode(scope.row) }}</span></div></template></el-table-column>
        <el-table-column prop="shopTypeLabel" label="店铺类型" width="92" />
        <el-table-column label="授权状态" min-width="150"><template #default="scope"><div class="stacked-cell"><el-tag :type="authorizationType(scope.row)" effect="light">{{ authorizationLabel(scope.row) }}</el-tag><span>{{ expiryTime(scope.row) }}</span></div></template></el-table-column>
        <el-table-column label="调用状态" width="170" fixed="right"><template #default="scope"><div class="availability-state" :class="{ callable: scope.row.callable }"><CheckCircle2 v-if="scope.row.callable" :size="16" /><TriangleAlert v-else :size="16" /><span>{{ scope.row.callable ? "当前可调用" : "需要处理" }}</span><small>{{ availabilityReason(scope.row) }}</small></div></template></el-table-column>
      </el-table>
      <footer v-if="filteredShops.length" class="connection-pagination"><span>第 {{ page }} 页，共 {{ Math.ceil(filteredShops.length / pageSize) }} 页</span><el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="filteredShops.length" :page-sizes="[10, 25, 50, 100]" layout="sizes, prev, pager, next" background /></footer>
    </section>

    <p class="connection-security-note"><KeyRound :size="17" />Access Token、Refresh Token 与 App Secret 始终保留在加密 Connector 控制面；PostgreSQL 仅保存 API 非敏感投影与业务补充，业务模块和 Agent 仍只能通过 Commerce API Gateway 调用平台。</p>
  </div>
</template>

<style scoped>
.platform-connections-page { min-height: 560px; display: grid; gap: 16px; }
.connection-commandbar { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 16px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.gateway-state, .gateway-actions { display: flex; align-items: center; gap: 12px; }.gateway-state > div { display: grid; gap: 3px; }.gateway-state strong { font-size: 13px; }.gateway-state span { color: var(--ops-text-secondary); font-size: 11px; }
.gateway-indicator { width: 11px; height: 11px; border-radius: 50%; background: var(--ops-danger); box-shadow: 0 0 0 5px rgba(220,38,38,.09); }.gateway-indicator.ready { background: var(--ops-success); box-shadow: 0 0 0 5px rgba(22,163,74,.09); }.gateway-actions .el-button { min-height: 44px; }
.connection-metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); overflow: hidden; background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }.connection-metrics article { min-height: 104px; display: flex; align-items: center; gap: 13px; padding: 16px; border-right: 1px solid var(--ops-border-light); }.connection-metrics article:last-child { border-right: 0; }.connection-metrics article > div { min-width: 0; display: grid; gap: 3px; }.connection-metrics article span { color: var(--ops-text-secondary); font-size: 11px; }.connection-metrics article strong { font-size: 25px; line-height: 1; }.connection-metrics article small { overflow: hidden; color: var(--ops-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.metric-icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: var(--ops-primary); background: #eff6ff; }.metric-icon.success { color: #087f5b; background: #ecfdf5; }.metric-icon.country { color: #7c3aed; background: #f5f3ff; }.metric-icon.warning { color: #c2410c; background: #fff7ed; }
.connection-filterbar { display: grid; grid-template-columns: minmax(240px,1.5fr) repeat(3,minmax(135px,.8fr)) auto; align-items: end; gap: 10px; padding: 14px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }.connection-filterbar label { min-width: 0; display: grid; gap: 6px; }.connection-filterbar label > span { color: var(--ops-text-secondary); font-size: 11px; font-weight: 700; }.connection-filterbar .el-select { width: 100%; }.connection-filterbar :deep(.el-input__wrapper),.connection-filterbar :deep(.el-select__wrapper) { min-height: 44px; }.connection-filter-actions { display: flex; align-items: center; gap: 10px; }.connection-filter-actions > span { color: var(--ops-text-secondary); font-size: 11px; white-space: nowrap; }
.connection-table-panel > header > span { text-align: right; }.connection-table { --el-table-header-bg-color: var(--ops-surface-muted); --el-table-border-color: var(--ops-border-light); }.shop-identity,.stacked-cell { display: grid; gap: 4px; }.shop-identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.shop-identity span,.stacked-cell span { color: var(--ops-text-secondary); font-size: 10px; }.stacked-cell code { font-size: 11px; font-variant-numeric: tabular-nums; }.availability-state { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 2px 6px; color: var(--ops-warning); }.availability-state.callable { color: #087f5b; }.availability-state span { font-size: 11px; font-weight: 750; }.availability-state small { grid-column: 1 / -1; color: var(--ops-text-muted); font-size: 9px; white-space: normal; }
.connection-pagination { min-height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-top: 1px solid var(--ops-border-light); }.connection-pagination > span { color: var(--ops-text-secondary); font-size: 11px; }.connection-security-note { display: flex; gap: 9px; margin: 0; padding: 13px 15px; border: 1px solid #cfe9df; border-radius: var(--ops-radius-sm); color: #365f55; background: #f0f9f6; font-size: 11px; line-height: 1.65; }
@media (max-width: 1100px) { .connection-metrics { grid-template-columns: 1fr 1fr; }.connection-filterbar { grid-template-columns: 1fr 1fr; }.wide-filter { grid-column: 1 / -1; }.connection-filter-actions { justify-content: flex-end; } }
@media (max-width: 760px) { .connection-commandbar { align-items: stretch; flex-direction: column; }.gateway-actions { display: grid; grid-template-columns: 1fr 1fr; }.connection-metrics,.connection-filterbar { grid-template-columns: 1fr; }.wide-filter { grid-column: auto; }.connection-metrics article { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }.connection-table-panel { overflow-x: auto; }.connection-table { min-width: 1080px; }.connection-pagination { align-items: flex-start; flex-direction: column; } }
</style>
