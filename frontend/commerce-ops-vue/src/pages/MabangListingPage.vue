<script setup lang="ts">
import { LogIn, LogOut, RefreshCw, Search, Send } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import {
  loadListingHealth,
  loadListingPlatforms,
  loadListingShops,
  loadListings,
  loginListing,
  logoutListing,
  type ListingItem,
  type ListingPlatform,
  type ListingSession,
  type ListingShop,
} from "@/services/listing";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const connecting = ref(false);
const error = ref("");
const session = ref<ListingSession | null>(null);
const platforms = ref<ListingPlatform[]>([]);
const shops = ref<ListingShop[]>([]);
const listings = ref<ListingItem[]>([]);
const total = ref(0);
const fetchedAt = ref("");
const activePlatform = ref("");
const activeState = ref("");
const selectedShops = ref<string[]>([]);
const expandedRows = ref<string[]>([]);
const loginForm = reactive({ username: "陈泽彬", password: "" });
const query = reactive({ page: 1, pageSize: 50, searchType: "title", value: "" });

const currentPlatform = computed(() => platforms.value.find((item) => item.key === activePlatform.value) || null);
const states = computed(() => currentPlatform.value?.states || []);
const totalVariants = computed(() => listings.value.reduce((sum, item) => sum + (item.variants?.length || 0), 0));

function formatDate(value?: string) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function money(value: unknown, currency = "") { const number = Number(value); return Number.isFinite(number) ? `${currency} ${number.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`.trim() : "—"; }

async function loadCatalog() {
  const result = await loadListingPlatforms();
  session.value = result.session;
  platforms.value = result.platforms || [];
  if (!activePlatform.value || !platforms.value.some((item) => item.key === activePlatform.value)) activePlatform.value = platforms.value[0]?.key || "";
  const platform = platforms.value.find((item) => item.key === activePlatform.value);
  if (!activeState.value || !platform?.states.some((item) => item.key === activeState.value)) activeState.value = platform?.states[0]?.key || "";
  await changePlatform(false);
}

async function load({ resetPage = false } = {}) {
  if (!activePlatform.value || !activeState.value) return;
  if (resetPage) query.page = 1;
  loading.value = true; error.value = "";
  try {
    const result = await loadListings({ platform: activePlatform.value, state: activeState.value, page: query.page, pageSize: query.pageSize, query: query.value.trim(), searchType: query.searchType, shopIds: selectedShops.value });
    listings.value = result.items || []; total.value = result.total || 0; fetchedAt.value = result.fetched_at || "";
    workspace.lastSyncedAt = new Date();
  } catch (loadError) { error.value = String((loadError as Error)?.message || loadError || "刊登列表加载失败"); }
  finally { loading.value = false; }
}

async function initialize() {
  loading.value = true; error.value = "";
  try {
    const health = await loadListingHealth();
    session.value = health.session;
    if (health.session.connected) await loadCatalog();
  } catch (loadError) { error.value = String((loadError as Error)?.message || loadError || "马帮刊登服务不可用"); }
  finally { loading.value = false; }
}

async function connect() {
  if (!loginForm.username.trim() || !loginForm.password) { ElMessage.warning("请输入马帮刊登账号和密码"); return; }
  connecting.value = true; error.value = "";
  try {
    const result = await loginListing(loginForm.username.trim(), loginForm.password);
    session.value = result.session; loginForm.password = ""; await loadCatalog(); ElMessage.success("马帮刊登连接成功");
  } catch (connectError) { error.value = String((connectError as Error)?.message || connectError || "连接失败"); }
  finally { loginForm.password = ""; connecting.value = false; }
}

async function disconnect() {
  await logoutListing().catch(() => {}); session.value = session.value ? { ...session.value, connected: false } : null; platforms.value = []; listings.value = []; shops.value = [];
}

async function changePlatform(shouldLoad = true) {
  const platform = platforms.value.find((item) => item.key === activePlatform.value);
  activeState.value = platform?.states[0]?.key || ""; selectedShops.value = []; query.page = 1;
  if (!activePlatform.value) return;
  const result = await loadListingShops(activePlatform.value);
  shops.value = result.shops || [];
  if (shouldLoad) await load(); else await load();
}

function changeState() { query.page = 1; load(); }
function rowKey(row: ListingItem) { return `${row.platform}-${row.internal_id}`; }

onMounted(initialize);
</script>

<template>
  <div class="listing-vue-page" v-loading="loading">
    <section class="module-toolbar listing-toolbar">
      <div class="service-summary"><span class="live-indicator" :class="{ active: session?.connected }" /><div><strong>{{ session?.connected ? "马帮刊登已连接" : "等待连接马帮刊登" }}</strong><small>{{ session?.connected ? `账号 ${session.username} · ${session.account_host}` : "连接后读取 Lazada、Shopee 与 TikTok Shop 刊登" }}</small></div></div>
      <div class="module-toolbar-actions"><el-button v-if="session?.connected" :icon="LogOut" @click="disconnect">断开</el-button><el-button :icon="RefreshCw" @click="session?.connected ? loadCatalog() : initialize()">刷新</el-button></div>
    </section>
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />

    <section v-if="!session?.connected" class="listing-login-card">
      <div class="listing-login-icon"><LogIn :size="25" /></div><span class="panel-kicker">SECURE SESSION</span><h2>连接马帮刊登</h2><p>账号只发送到本机马帮刊登服务，密码不会保存在 Vue 页面。</p>
      <form @submit.prevent="connect"><label><span>账号</span><el-input v-model="loginForm.username" autocomplete="username" /></label><label><span>密码</span><el-input v-model="loginForm.password" type="password" show-password autocomplete="current-password" /></label><el-button native-type="submit" type="primary" :icon="LogIn" :loading="connecting">连接马帮刊登</el-button></form>
    </section>

    <template v-else>
      <section class="listing-platformbar">
        <el-segmented v-model="activePlatform" :options="platforms.map(item => ({ label: `${item.name}${item.listing_count !== undefined ? ` ${item.listing_count}` : ''}`, value: item.key }))" @change="changePlatform()" />
        <el-segmented v-if="states.length" v-model="activeState" :options="states.map(item => ({ label: item.label, value: item.key }))" @change="changeState" />
      </section>
      <section class="module-toolbar listing-filterbar">
        <div class="listing-search"><el-select v-model="query.searchType"><el-option label="标题" value="title" /><el-option label="SKU" value="sku" /><el-option label="产品 ID" value="product_id" /></el-select><el-input v-model="query.value" clearable placeholder="搜索当前平台刊登" @keyup.enter="load({ resetPage: true })"><template #prefix><Search :size="16" /></template></el-input></div>
        <el-select v-model="selectedShops" multiple collapse-tags collapse-tags-tooltip clearable placeholder="全部店铺"><el-option v-for="shop in shops" :key="shop.id" :label="`${shop.name} · ${shop.site}`" :value="String(shop.id)" /></el-select>
        <div class="module-toolbar-actions"><el-button type="primary" :icon="Search" @click="load({ resetPage: true })">查询</el-button><el-button :icon="Send" disabled>批量编辑</el-button></div>
      </section>
      <section class="listing-summary-strip"><div><span>当前结果</span><strong>{{ total.toLocaleString("zh-CN") }}</strong></div><div><span>当前页刊登</span><strong>{{ listings.length }}</strong></div><div><span>当前页变体</span><strong>{{ totalVariants }}</strong></div><div><span>数据时间</span><strong class="date">{{ formatDate(fetchedAt) }}</strong></div></section>
      <section class="dashboard-panel listing-table-panel">
        <header><div><span class="panel-kicker">LISTINGS</span><h3>{{ currentPlatform?.name }} 刊登列表</h3></div><span>{{ shops.length }} 个店铺</span></header>
        <el-table v-model:expand-row-keys="expandedRows" :data="listings" :row-key="rowKey" stripe empty-text="暂无刊登数据">
          <el-table-column type="expand"><template #default="scope"><div class="variant-table"><h4>SKU 变体</h4><el-table :data="scope.row.variants || []" size="small"><el-table-column prop="sku" label="平台 SKU" min-width="170" /><el-table-column prop="stock_sku" label="库存 SKU" min-width="170" /><el-table-column label="售价" width="130" align="right"><template #default="variant">{{ money(variant.row.sale_price || variant.row.price, scope.row.currency) }}</template></el-table-column><el-table-column prop="stock" label="库存" width="100" align="right" /></el-table></div></template></el-table-column>
          <el-table-column prop="title" label="商品" min-width="280" show-overflow-tooltip fixed />
          <el-table-column prop="parent_sku" label="主 SKU" min-width="150" />
          <el-table-column prop="shop_name" label="店铺" min-width="180" />
          <el-table-column prop="site" label="站点" width="100" />
          <el-table-column prop="state" label="状态" width="120" />
          <el-table-column label="变体" width="80" align="right"><template #default="scope">{{ scope.row.variants?.length || 0 }}</template></el-table-column>
          <el-table-column label="更新时间" width="170"><template #default="scope">{{ formatDate(scope.row.update_time) }}</template></el-table-column>
          <el-table-column label="链接" width="80" fixed="right"><template #default="scope"><el-button v-if="scope.row.product_url" link type="primary" tag="a" :href="scope.row.product_url" target="_blank">打开</el-button></template></el-table-column>
        </el-table>
        <footer class="listing-pagination"><el-pagination v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total" :page-sizes="[20,50,100]" layout="sizes, prev, pager, next" background @current-change="load()" @size-change="load({ resetPage: true })" /></footer>
      </section>
    </template>
  </div>
</template>

<style scoped>
.listing-vue-page { display: grid; gap: 16px; }.listing-login-card { width: min(520px,100%); min-height: 390px; display: grid; justify-items: center; align-content: center; gap: 8px; margin: 40px auto; padding: 32px; border: 1px solid var(--ops-border-light); border-radius: 16px; background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); text-align: center; }.listing-login-icon { display: grid; place-items: center; width: 58px; height: 58px; margin-bottom: 8px; border-radius: 15px; color: var(--ops-primary); background: #eff6ff; }.listing-login-card h2 { margin: 4px 0; }.listing-login-card p { margin: 0 0 12px; color: var(--ops-text-secondary); font-size: 12px; }.listing-login-card form { width: 100%; display: grid; gap: 14px; }.listing-login-card label { display: grid; gap: 6px; text-align: left; }.listing-login-card label span { font-size: 12px; font-weight: 650; }
.listing-platformbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface); overflow-x: auto; }.listing-filterbar > .el-select { min-width: 220px; }.listing-search { flex: 1; display: flex; }.listing-search .el-select { width: 110px; }.listing-summary-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface); }.listing-summary-strip > div { display: grid; gap: 5px; min-height: 82px; align-content: center; padding: 14px 18px; border-right: 1px solid var(--ops-border-light); }.listing-summary-strip > div:last-child { border-right: 0; }.listing-summary-strip span { color: var(--ops-text-secondary); font-size: 11px; }.listing-summary-strip strong { font-size: 21px; }.listing-summary-strip strong.date { font-size: 13px; }
.listing-table-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); }.variant-table { padding: 10px 38px 18px; }.variant-table h4 { margin: 0 0 8px; }.listing-pagination { display: flex; justify-content: flex-end; padding: 14px 16px; border-top: 1px solid var(--ops-border-light); }
@media (max-width: 760px) { .listing-platformbar { align-items: flex-start; flex-direction: column; }.listing-filterbar { align-items: stretch; flex-direction: column; }.listing-filterbar > .el-select { width: 100%; }.listing-summary-strip { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media (max-width: 440px) { .listing-summary-strip { grid-template-columns: 1fr; }.listing-summary-strip > div { border-right: 0; border-bottom: 1px solid var(--ops-border-light); } }
</style>
