<script setup lang="ts">
import {
  Bot,
  ExternalLink,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Trash2,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import MarketplaceImage from "@/components/MarketplaceImage.vue";
import MabangPublisherWorkbench from "@/components/MabangPublisherWorkbench.vue";
import {
  createAiPreview,
  createBatchPreview,
  executeBatchPreview,
  loadAiStatus,
  loadBatchJob,
  loadListingHealth,
  loadListingPlatforms,
  loadListingShops,
  loadListings,
  loadWarehouseOptions,
  loginListing,
  logoutListing,
  type AiParsedCommand,
  type AiPreviewResult,
  type AiStatus,
  type BatchJob,
  type BatchOperation,
  type BatchPreview,
  type BatchTargetScope,
  type ListingItem,
  type ListingPlatform,
  type ListingSession,
  type ListingShop,
  type ListingVariant,
  type PreviewChange,
  type WarehouseOption,
  type WarehouseStock,
} from "@/services/listing";
import { useWorkspaceStore } from "@/stores/workspace";

interface TableRef {
  clearSelection: () => void;
  toggleRowSelection: (row: ListingItem, selected?: boolean) => void;
}

interface PreviewTableRef {
  clearSelection: () => void;
  toggleAllSelection: () => void;
}

interface PlatformView {
  state: string;
  shops: ListingShop[];
  selectedShops: string[];
  listings: ListingItem[];
  page: number;
  pageSize: number;
  query: string;
  searchType: string;
  total: number;
  fetchedAt: string;
}

const workspace = useWorkspaceStore();
const loading = ref(false);
const connecting = ref(false);
const error = ref("");
const notice = ref("");
const session = ref<ListingSession | null>(null);
const aiStatus = ref<AiStatus | null>(null);
const platforms = ref<ListingPlatform[]>([]);
const shops = ref<ListingShop[]>([]);
const listings = ref<ListingItem[]>([]);
const total = ref(0);
const fetchedAt = ref("");
const activePlatform = ref("");
const loadedPlatform = ref("");
const activeState = ref("");
const selectedShops = ref<string[]>([]);
const expandedRows = ref<string[]>([]);
const selectedRows = ref(new Map<string, ListingItem>());
const allFilteredSelected = ref(false);
const tableRef = ref<TableRef | null>(null);
const previewTableRef = ref<PreviewTableRef | null>(null);
const viewCache = new Map<string, PlatformView>();
const workspaceMode = ref<"manage" | "publish">("manage");
const publisherSeed = ref<ListingItem | null>(null);
const loginForm = reactive({ username: "陈泽彬", password: "" });
const query = reactive({ page: 1, pageSize: 50, searchType: "title", value: "" });

const command = ref("");
const aiParsing = ref(false);
const aiResult = ref<AiPreviewResult | null>(null);
const aiTargetScope = ref<BatchTargetScope | null>(null);
const batchOpen = ref(false);
const operations = ref<BatchOperation[]>([]);
const matchSku = ref("");
const warehouseOptions = ref<WarehouseOption[]>([]);
const warehouseLoading = ref(false);
const warehouseError = ref("");
const previewing = ref(false);
const preview = ref<BatchPreview | null>(null);
const selectedChanges = ref(new Set<string>());
const executing = ref(false);
const job = ref<BatchJob | null>(null);
let jobTimer: number | null = null;

const currentPlatform = computed(() => platforms.value.find((item) => item.key === activePlatform.value) || null);
const states = computed(() => currentPlatform.value?.states || []);
const totalVariants = computed(() => listings.value.reduce((sum, item) => sum + (item.variants?.length || 0), 0));
const selectedCount = computed(() => allFilteredSelected.value ? total.value : selectedRows.value.size);
const activeWriteEnabled = computed(() => Boolean(currentPlatform.value?.write_enabled) && activeState.value === "online");
const aiCommands = computed(() => aiResult.value?.commands || (aiResult.value?.command ? [aiResult.value.command] : []));
const hasStockOperation = computed(() => operations.value.some((item) => item.field === "stock"));
const effectiveTargetScope = computed<BatchTargetScope>(() => aiTargetScope.value || batchTargetScope.value);
const batchTargetScope = computed<BatchTargetScope>(() => {
  if (allFilteredSelected.value) {
    return {
      target_query: {
        platform: activePlatform.value,
        state: activeState.value,
        shop_ids: selectedShops.value,
        search_type: query.value.trim() ? query.searchType : "",
        search_value: query.value.trim(),
      },
    };
  }
  return {
    targets: Array.from(selectedRows.value.values()).map((item) => ({
      platform: item.platform,
      internal_id: item.internal_id,
      product_id: item.product_id,
      shop_name: item.shop_name,
      title: item.title,
    })),
  };
});

const batchFields = computed(() => [
  { value: "price", label: activePlatform.value === "shopee" ? "原价" : "售价" },
  { value: "special_price", label: activePlatform.value === "shopee" ? "售价" : "促销价" },
  { value: "stock", label: "库存" },
  { value: "package_length", label: "包裹长度" },
  { value: "package_width", label: "包裹宽度" },
  { value: "package_height", label: "包裹高度" },
  { value: "package_weight", label: "包裹重量" },
  { value: "sku", label: "变体 SKU" },
  { value: "variation", label: "规格值" },
]);

const exampleCommands = [
  "将选中商品的售价提高 3%",
  "把 SKU T3AA1863489 在有库存的仓库设为 10",
  "将菲律宾店铺 SKU T3CC2150516 的售价改为 1360",
];

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function numeric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function money(value: unknown, currency = "") {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? `${currency} ${number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim()
    : "未设置";
}

function range(values: unknown[], currency = "") {
  const numbers = values.map(numeric).filter((item) => item > 0);
  if (!numbers.length) return "未设置";
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? money(min, currency) : `${money(min, currency)} ~ ${money(max, currency)}`;
}

function rowKey(row: ListingItem) {
  return [row.platform, row.state, row.internal_id, row.product_id, row.shop_id].join(":");
}

function previewRowKey(row: PreviewChange) {
  return row.change_id;
}

function stockSummary(row: ListingItem) {
  return row.variants.reduce((sum, item) => sum + numeric(item.stock), 0);
}

function warehouseLabel(warehouse: WarehouseStock, index: number) {
  return String(
    warehouse._warehouse_name || warehouse.warehouse_name || warehouse.name || warehouse.warehouse_code || warehouse.code
      || warehouse.location_id || warehouse.warehouse_id || `仓库 ${index + 1}`,
  ).trim();
}

function specification(variant: ListingVariant) {
  const direct = [variant.specification_name, variant.specification_value, variant.variation_name, variant.variation_value]
    .map((value) => String(value || "").trim()).filter(Boolean);
  if (direct.length) return direct.join(" / ");
  if (Array.isArray(variant.properties)) {
    return variant.properties.map((item) => String(item.value || item.name || "")).filter(Boolean).join(" / ") || "—";
  }
  if (variant.properties && typeof variant.properties === "object") {
    return Object.entries(variant.properties).map(([key, value]) => `${key}: ${String(value)}`).join(" / ") || "—";
  }
  return "—";
}

function defaultPriceField(platform = activePlatform.value) {
  return platform === "shopee" || platform === "lazada" ? "special_price" : "price";
}

function newOperation(field = defaultPriceField()): BatchOperation {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field,
    mode: field === "sku" || field === "variation" ? "replace" : "set",
    value: "",
    spec_name: "",
    warehouse_key: "",
  };
}

function operationFromAi(item: AiParsedCommand): BatchOperation | null {
  const field = item.operation.field;
  if (field === "sku" && item.operation.mode === "replace") {
    return { ...newOperation("sku"), mode: "replace", value: String(item.operation.value || "") };
  }
  if (field === "variation" && item.operation.mode === "replace" && item.operation.value && typeof item.operation.value === "object") {
    const value = item.operation.value as { name?: unknown; spec_name?: unknown; value?: unknown };
    return {
      ...newOperation("variation"),
      mode: "replace",
      spec_name: String(value.name || value.spec_name || ""),
      value: String(value.value || ""),
    };
  }
  const number = Number(item.operation.value);
  if (!batchFields.value.some((entry) => entry.value === field) || !Number.isFinite(number)) return null;
  const modes: Record<string, { mode: string; value: number }> = {
    set: { mode: "set", value: number },
    increase_amount: { mode: "add", value: Math.abs(number) },
    decrease_amount: { mode: "add", value: -Math.abs(number) },
    increase_percent: { mode: "percent", value: Math.abs(number) },
    decrease_percent: { mode: "percent", value: -Math.abs(number) },
  };
  const mapped = modes[item.operation.mode];
  if (!mapped || (field === "stock" && mapped.mode === "percent")) return null;
  return { ...newOperation(field), mode: mapped.mode, value: String(mapped.value) };
}

function cacheCurrentView(platformKey = loadedPlatform.value) {
  if (!platformKey || !listings.value.length) return;
  viewCache.set(platformKey, {
    state: activeState.value,
    shops: shops.value,
    selectedShops: [...selectedShops.value],
    listings: listings.value,
    page: query.page,
    pageSize: query.pageSize,
    query: query.value,
    searchType: query.searchType,
    total: total.value,
    fetchedAt: fetchedAt.value,
  });
}

function restoreTableSelection() {
  nextTick(() => {
    tableRef.value?.clearSelection();
    if (allFilteredSelected.value) {
      listings.value.forEach((row) => tableRef.value?.toggleRowSelection(row, true));
      return;
    }
    listings.value.forEach((row) => {
      if (selectedRows.value.has(rowKey(row))) tableRef.value?.toggleRowSelection(row, true);
    });
  });
}

async function load({ resetPage = false, refresh = false } = {}) {
  if (!activePlatform.value || !activeState.value) return;
  if (resetPage) query.page = 1;
  loading.value = true;
  error.value = "";
  try {
    const result = await loadListings({
      platform: activePlatform.value,
      state: activeState.value,
      page: query.page,
      pageSize: query.pageSize,
      query: query.value.trim(),
      searchType: query.searchType,
      shopIds: selectedShops.value,
      refresh,
    });
    listings.value = result.items || [];
    total.value = result.total || 0;
    fetchedAt.value = result.fetched_at || "";
    workspace.lastSyncedAt = new Date();
    restoreTableSelection();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "刊登列表加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadCatalog() {
  const result = await loadListingPlatforms();
  session.value = result.session;
  platforms.value = result.platforms || [];
  if (!activePlatform.value || !platforms.value.some((item) => item.key === activePlatform.value)) {
    activePlatform.value = platforms.value[0]?.key || "";
  }
  await changePlatform(false);
}

async function initialize() {
  loading.value = true;
  error.value = "";
  try {
    const [health, status] = await Promise.all([loadListingHealth(), loadAiStatus().catch(() => null)]);
    session.value = health.session;
    aiStatus.value = status?.ai || health.ai || null;
    if (health.session.connected) await loadCatalog();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "马帮刊登服务不可用");
  } finally {
    loading.value = false;
  }
}

async function connect() {
  if (!loginForm.username.trim() || !loginForm.password) {
    ElMessage.warning("请输入马帮刊登账号和密码");
    return;
  }
  connecting.value = true;
  error.value = "";
  try {
    const result = await loginListing(loginForm.username.trim(), loginForm.password);
    session.value = result.session;
    loginForm.password = "";
    await loadCatalog();
    ElMessage.success("马帮刊登连接成功");
  } catch (connectError) {
    error.value = String((connectError as Error)?.message || connectError || "连接失败");
  } finally {
    loginForm.password = "";
    connecting.value = false;
  }
}

async function disconnect() {
  await logoutListing().catch(() => undefined);
  session.value = session.value ? { ...session.value, connected: false } : null;
  platforms.value = [];
  listings.value = [];
  shops.value = [];
  selectedRows.value = new Map();
  viewCache.clear();
  loadedPlatform.value = "";
}

async function changePlatform(useCache = true) {
  cacheCurrentView();
  const cached = useCache ? viewCache.get(activePlatform.value) : null;
  const platform = platforms.value.find((item) => item.key === activePlatform.value);
  activeState.value = cached?.state || platform?.states[0]?.key || "";
  selectedShops.value = cached?.selectedShops || [];
  shops.value = cached?.shops || [];
  query.page = cached?.page || 1;
  query.pageSize = cached?.pageSize || 50;
  query.value = cached?.query || "";
  query.searchType = cached?.searchType || "title";
  listings.value = cached?.listings || [];
  total.value = cached?.total || 0;
  fetchedAt.value = cached?.fetchedAt || "";
  selectedRows.value = new Map();
  allFilteredSelected.value = false;
  expandedRows.value = [];
  resetEditing();
  if (activePlatform.value !== "lazada") workspaceMode.value = "manage";
  if (!activePlatform.value) return;
  if (!shops.value.length) {
    const result = await loadListingShops(activePlatform.value);
    shops.value = result.shops || [];
  }
  if (!cached) await load();
  else restoreTableSelection();
  loadedPlatform.value = activePlatform.value;
}

function changeState() {
  query.page = 1;
  selectedRows.value = new Map();
  allFilteredSelected.value = false;
  expandedRows.value = [];
  resetEditing();
  load();
}

function handleSelectionChange(rows: ListingItem[]) {
  if (allFilteredSelected.value) return;
  const currentKeys = new Set(listings.value.map(rowKey));
  const next = new Map(selectedRows.value);
  currentKeys.forEach((key) => next.delete(key));
  rows.forEach((row) => next.set(rowKey(row), row));
  selectedRows.value = next;
}

function selectAllFiltered() {
  if (!total.value) return;
  allFilteredSelected.value = true;
  selectedRows.value = new Map();
  restoreTableSelection();
  ElMessage.success(`已选择当前筛选条件下的 ${total.value} 个商品`);
}

function clearSelection() {
  allFilteredSelected.value = false;
  selectedRows.value = new Map();
  tableRef.value?.clearSelection();
}

function resetEditing() {
  operations.value = [newOperation(defaultPriceField())];
  matchSku.value = "";
  batchOpen.value = false;
  preview.value = null;
  aiResult.value = null;
  aiTargetScope.value = null;
  warehouseOptions.value = [];
  warehouseError.value = "";
  selectedChanges.value = new Set();
  job.value = null;
  if (jobTimer !== null) window.clearTimeout(jobTimer);
}

function openBatchEditor() {
  if (!selectedCount.value) {
    ElMessage.warning("请先勾选要操作的商品");
    return;
  }
  if (!activeWriteEnabled.value) {
    ElMessage.warning("只有在线商品且平台允许写入时才能批量编辑");
    return;
  }
  aiTargetScope.value = null;
  batchOpen.value = true;
  if (!operations.value.length) operations.value = [newOperation()];
}

function addOperation() {
  operations.value.push(newOperation());
}

function removeOperation(id: string) {
  operations.value = operations.value.filter((item) => item.id !== id);
  if (!operations.value.length) operations.value = [newOperation()];
}

function operationFieldChanged(operation: BatchOperation) {
  operation.mode = operation.field === "sku" || operation.field === "variation" ? "replace" : "set";
  operation.spec_name = "";
  operation.warehouse_key = "";
  preview.value = null;
  if (operation.field === "stock" && selectedCount.value) refreshWarehouseOptions();
}

async function refreshWarehouseOptions() {
  if (!hasStockOperation.value || !selectedCount.value) {
    warehouseOptions.value = [];
    return;
  }
  warehouseLoading.value = true;
  warehouseError.value = "";
  try {
    const result = await loadWarehouseOptions(effectiveTargetScope.value, matchSku.value.trim());
    warehouseOptions.value = result.warehouses || [];
    const valid = new Set(warehouseOptions.value.map((item) => item.key));
    operations.value.forEach((operation) => {
      if (operation.field !== "stock") return;
      if (!operation.warehouse_key || !valid.has(operation.warehouse_key)) {
        operation.warehouse_key = valid.has(result.recommended_warehouse_key) ? result.recommended_warehouse_key : "";
      }
    });
  } catch (reason) {
    warehouseError.value = String((reason as Error)?.message || reason || "无法读取仓库库存");
  } finally {
    warehouseLoading.value = false;
  }
}

function synchronizePreviewPrices(nextPreview: BatchPreview) {
  const grouped = new Map<string, PreviewChange[]>();
  nextPreview.changes.filter((change) => change.field === "price" || change.field === "special_price").forEach((change) => {
    const key = `${change.platform}:${change.internal_id}`;
    grouped.set(key, [...(grouped.get(key) || []), change]);
  });
  if (!grouped.size) return;
  listings.value = listings.value.map((listing) => {
    const changes = grouped.get(`${listing.platform}:${String(listing.internal_id)}`) || [];
    if (!changes.length) return listing;
    return {
      ...listing,
      variants: listing.variants.map((variant) => {
        const match = changes.filter((change) => {
          if (String(change.sku_id || "") && String(variant.variant_id || "")) return String(change.sku_id) === String(variant.variant_id);
          return String(change.sku || "") === String(variant.sku || "");
        });
        if (!match.length) return variant;
        const next = { ...variant };
        match.forEach((change) => {
          if (change.field === "price") next.price = change.old_value;
          if (change.field === "special_price") next.sale_price = change.old_value;
        });
        return next;
      }),
    };
  });
}

function preparePreview(nextPreview: BatchPreview) {
  synchronizePreviewPrices(nextPreview);
  preview.value = nextPreview;
  selectedChanges.value = new Set(nextPreview.changes.map((item) => item.change_id));
  nextTick(() => previewTableRef.value?.toggleAllSelection());
}

async function generateAiPreview() {
  if (!command.value.trim()) {
    ElMessage.warning("请输入要执行的修改指令");
    return;
  }
  if (!aiStatus.value?.configured) {
    error.value = `DeepSeek 尚未配置。请在本机设置 DEEPSEEK_API_KEY；当前模型为 ${aiStatus.value?.model || "deepseek-v4-flash"}。`;
    return;
  }
  aiParsing.value = true;
  error.value = "";
  notice.value = "";
  preview.value = null;
  job.value = null;
  try {
    const result = await createAiPreview(command.value.trim(), activePlatform.value);
    aiResult.value = result;
    const parsed = result.commands || [result.command];
    const mapped = parsed.map(operationFromAi).filter((item): item is BatchOperation => Boolean(item));
    if (mapped.length) operations.value = mapped;
    matchSku.value = parsed.length === 1 ? parsed[0].target.sku : "";
    if (result.warehouse_selection_required) {
      const targets = Array.from(new Map(result.batch_preview.changes.map((change) => [
        `${change.platform}:${change.internal_id}`,
        { platform: change.platform, internal_id: change.internal_id, product_id: change.product_id, shop_name: change.shop_name, title: change.title },
      ])).values());
      aiTargetScope.value = { targets };
      batchOpen.value = true;
      notice.value = `DeepSeek 已定位 ${targets.length} 个商品。请选择目标仓库后生成最终差异预览。`;
      await nextTick();
      await refreshWarehouseOptions();
    } else {
      aiTargetScope.value = null;
      batchOpen.value = false;
      preparePreview(result.batch_preview);
      notice.value = `DeepSeek 已解析 ${parsed.length} 条指令并生成 ${result.batch_preview.change_count} 项差异，尚未写入。`;
    }
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason || "DeepSeek 无法生成范围预览");
  } finally {
    aiParsing.value = false;
  }
}

async function generatePreview() {
  if (!selectedCount.value && !aiTargetScope.value) {
    ElMessage.warning("请先选择商品");
    return;
  }
  if (!operations.value.length || operations.value.some((item) => !String(item.value).trim())) {
    ElMessage.warning("请完整填写修改字段和值");
    return;
  }
  if (hasStockOperation.value) {
    await refreshWarehouseOptions();
    if (operations.value.some((item) => item.field === "stock" && !item.warehouse_key)) {
      ElMessage.warning("请选择库存修改的目标仓库");
      return;
    }
  }
  previewing.value = true;
  error.value = "";
  preview.value = null;
  job.value = null;
  try {
    const result = await createBatchPreview(effectiveTargetScope.value, matchSku.value.trim(), operations.value);
    preparePreview(result);
    batchOpen.value = false;
    notice.value = `已读取最新刊登详情并生成 ${result.change_count} 项差异，尚未写入。`;
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason || "无法生成批量差异预览");
  } finally {
    previewing.value = false;
  }
}

function handlePreviewSelection(rows: PreviewChange[]) {
  selectedChanges.value = new Set(rows.map((item) => item.change_id));
}

async function executePreview() {
  if (!preview.value || !selectedChanges.value.size) {
    ElMessage.warning("请至少选择一项差异");
    return;
  }
  await ElMessageBox.confirm(`确认向马帮提交 ${selectedChanges.value.size} 项修改？提交后会继续回读店铺验证。`, "确认同步", {
    confirmButtonText: "确认提交",
    cancelButtonText: "取消",
    type: "warning",
  });
  executing.value = true;
  error.value = "";
  try {
    job.value = await executeBatchPreview(preview.value.preview_token, Array.from(selectedChanges.value));
    notice.value = "马帮任务已创建，正在等待平台回读核验。";
    scheduleJobPoll();
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason || "无法启动批量同步");
    executing.value = false;
  }
}

function scheduleJobPoll() {
  if (!job.value || ["completed", "partial", "failed"].includes(job.value.state)) {
    executing.value = false;
    return;
  }
  if (jobTimer !== null) window.clearTimeout(jobTimer);
  jobTimer = window.setTimeout(async () => {
    try {
      if (!job.value) return;
      job.value = await loadBatchJob(job.value.job_id);
      scheduleJobPoll();
    } catch (reason) {
      error.value = String((reason as Error)?.message || reason || "任务状态回读失败");
      executing.value = false;
    }
  }, 1800);
}

function closeAiResult() {
  aiResult.value = null;
  aiTargetScope.value = null;
  preview.value = null;
  batchOpen.value = false;
  warehouseOptions.value = [];
  job.value = null;
}

function copyToDraft(row: ListingItem) {
  if (row.platform !== "lazada") {
    ElMessage.warning("当前新建刊登工作台只支持 Lazada");
    return;
  }
  publisherSeed.value = row;
  workspaceMode.value = "publish";
}

watch(activePlatform, () => {
  operations.value = [newOperation(defaultPriceField())];
});

onMounted(() => {
  operations.value = [newOperation("special_price")];
  initialize();
});

onBeforeUnmount(() => {
  if (jobTimer !== null) window.clearTimeout(jobTimer);
});
</script>

<template>
  <div class="listing-vue-page" v-loading="loading">
    <section class="module-toolbar listing-toolbar">
      <div class="service-summary">
        <span class="live-indicator" :class="{ active: session?.connected }" />
        <div>
          <strong>{{ session?.connected ? "马帮刊登已连接" : "等待连接马帮刊登" }}</strong>
          <small>{{ session?.connected ? `账号 ${session.username} · ${session.account_host}` : "连接后读取 Lazada、Shopee 与 TikTok Shop 刊登" }}</small>
        </div>
      </div>
      <div class="module-toolbar-actions">
        <el-tag v-if="aiStatus" :type="aiStatus.configured ? 'success' : 'warning'" effect="plain">
          DeepSeek · {{ aiStatus.model }} · {{ aiStatus.configured ? "已配置" : "待配置" }}
        </el-tag>
        <el-button v-if="session?.connected" :icon="LogOut" @click="disconnect">断开</el-button>
        <el-button :icon="RefreshCw" @click="session?.connected ? loadCatalog() : initialize()">刷新</el-button>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-if="notice" type="success" :closable="true" show-icon :title="notice" @close="notice = ''" />

    <section v-if="!session?.connected" class="listing-login-card">
      <div class="listing-login-icon"><LogIn :size="25" /></div>
      <span class="panel-kicker">SECURE SESSION</span>
      <h2>连接马帮刊登</h2>
      <p>账号只发送到本机马帮刊登服务，密码不会保存在 Vue 页面。</p>
      <form @submit.prevent="connect">
        <label><span>账号</span><el-input v-model="loginForm.username" autocomplete="username" /></label>
        <label><span>密码</span><el-input v-model="loginForm.password" type="password" show-password autocomplete="current-password" /></label>
        <el-button native-type="submit" type="primary" :icon="LogIn" :loading="connecting">连接马帮刊登</el-button>
      </form>
    </section>

    <template v-else>
      <section class="listing-platformbar">
        <el-segmented
          v-model="activePlatform"
          :options="platforms.map(item => ({ label: `${item.name}${item.listing_count !== undefined ? ` ${item.listing_count}` : ''}`, value: item.key }))"
          @change="changePlatform()"
        />
        <el-segmented
          v-if="activePlatform === 'lazada'"
          v-model="workspaceMode"
          :options="[{ label: '在线商品管理', value: 'manage' }, { label: '新建商品刊登', value: 'publish' }]"
        />
        <el-segmented
          v-if="workspaceMode === 'manage' && states.length"
          v-model="activeState"
          :options="states.map(item => ({ label: item.label, value: item.key }))"
          @change="changeState"
        />
      </section>

      <MabangPublisherWorkbench
        v-if="workspaceMode === 'publish'"
        :shops="shops"
        :seed-listing="publisherSeed"
        :ai-status="aiStatus"
        @return-manage="workspaceMode = 'manage'"
      />

      <template v-else>
        <section class="ai-command-center">
          <header>
            <div><span class="panel-kicker">DEEPSEEK COMMAND CENTER</span><h3>AI 批量修改助手</h3></div>
            <el-tag effect="plain">仅生成范围与差异，不直接写入</el-tag>
          </header>
          <div class="ai-command-grid">
            <el-input v-model="command" type="textarea" :rows="3" resize="vertical" placeholder="例如：将菲律宾店铺 SKU T3CC2150516 的售价改为 1360" />
            <el-button type="primary" :icon="Bot" :loading="aiParsing" @click="generateAiPreview">解析并生成差异</el-button>
          </div>
          <div class="ai-examples">
            <button v-for="example in exampleCommands" :key="example" type="button" @click="command = example">{{ example }}</button>
          </div>
          <div v-if="aiCommands.length" class="ai-result-summary">
            <div v-for="(item, index) in aiCommands" :key="index">
              <strong>指令 {{ index + 1 }} · {{ item.action }}</strong>
              <span>SKU {{ item.target.sku || "不限" }} · 置信度 {{ Math.round(item.confidence * 100) }}%</span>
            </div>
            <el-button circle text :icon="X" title="关闭 AI 结果" @click="closeAiResult" />
          </div>
        </section>

        <section class="module-toolbar listing-filterbar">
          <div class="listing-search">
            <el-select v-model="query.searchType">
              <el-option label="标题" value="title" />
              <el-option label="SKU" value="sku" />
              <el-option label="产品 ID" value="product_id" />
            </el-select>
            <el-input v-model="query.value" clearable placeholder="搜索当前平台刊登" @keyup.enter="load({ resetPage: true })">
              <template #prefix><Search :size="16" /></template>
            </el-input>
          </div>
          <el-select v-model="selectedShops" multiple collapse-tags collapse-tags-tooltip clearable placeholder="全部店铺">
            <el-option v-for="shop in shops" :key="shop.id" :label="`${shop.name} · ${shop.site}`" :value="String(shop.id)" />
          </el-select>
          <div class="module-toolbar-actions">
            <el-button type="primary" :icon="Search" @click="load({ resetPage: true })">查询</el-button>
            <el-button :icon="RefreshCw" @click="load({ refresh: true })">重新获取</el-button>
            <el-button :icon="Settings2" :disabled="!selectedCount || !activeWriteEnabled" @click="openBatchEditor">批量编辑 {{ selectedCount || '' }}</el-button>
          </div>
        </section>

        <section v-if="selectedCount" class="selection-strip">
          <span>{{ allFilteredSelected ? `已选择全部 ${selectedCount} 个筛选结果` : `已手动选择 ${selectedCount} 个商品` }}</span>
          <div>
            <el-button v-if="!allFilteredSelected && total > listings.length" link type="primary" @click="selectAllFiltered">选择全部 {{ total }} 个结果</el-button>
            <el-button link @click="clearSelection">清除选择</el-button>
          </div>
        </section>

        <section v-if="batchOpen" class="batch-editor">
          <header>
            <div><span class="panel-kicker">SAFE BATCH EDIT</span><h3>批量修改条件</h3></div>
            <el-button circle text :icon="X" title="关闭批量编辑" @click="batchOpen = false" />
          </header>
          <div class="batch-sku-filter">
            <label>匹配变体 SKU</label>
            <el-input v-model="matchSku" clearable placeholder="留空时匹配商品内全部变体" @change="hasStockOperation && refreshWarehouseOptions()" />
          </div>
          <div class="operation-list">
            <div v-for="operation in operations" :key="operation.id" class="operation-row">
              <el-select v-model="operation.field" @change="operationFieldChanged(operation)">
                <el-option v-for="field in batchFields" :key="field.value" :label="field.label" :value="field.value" />
              </el-select>
              <el-input v-if="operation.field === 'variation'" v-model="operation.spec_name" placeholder="规格名称" />
              <el-select v-if="operation.field !== 'sku' && operation.field !== 'variation'" v-model="operation.mode">
                <el-option label="设为" value="set" />
                <el-option label="增减" value="add" />
                <el-option v-if="operation.field !== 'stock'" label="按百分比" value="percent" />
              </el-select>
              <el-select
                v-if="operation.field === 'stock'"
                v-model="operation.warehouse_key"
                :loading="warehouseLoading"
                placeholder="选择目标仓库"
                filterable
              >
                <el-option v-for="warehouse in warehouseOptions" :key="warehouse.key" :label="warehouse.label" :value="warehouse.key">
                  <span>{{ warehouse.label }}</span><small> 库存 {{ warehouse.stock_min }}~{{ warehouse.stock_max }}</small>
                </el-option>
              </el-select>
              <el-input v-model="operation.value" :placeholder="operation.field === 'sku' ? '替换后的 SKU' : operation.field === 'variation' ? '新规格值' : '数值'" />
              <el-button circle text type="danger" :icon="Trash2" title="删除字段" @click="removeOperation(operation.id)" />
            </div>
          </div>
          <el-alert v-if="warehouseError" type="error" :closable="false" :title="warehouseError" />
          <footer>
            <el-button :icon="Plus" @click="addOperation">添加字段</el-button>
            <el-button type="primary" :icon="Send" :loading="previewing" @click="generatePreview">生成差异预览</el-button>
          </footer>
        </section>

        <section v-if="preview" class="preview-panel">
          <header>
            <div>
              <span class="panel-kicker">REVIEW BEFORE WRITE</span>
              <h3>{{ preview.command_count }} 条指令 · {{ preview.target_count }} 个商品 · {{ preview.change_count }} 项变更</h3>
            </div>
            <el-tag type="warning" effect="plain">尚未写入</el-tag>
          </header>
          <el-alert v-for="warning in preview.warnings || []" :key="warning" type="warning" :closable="false" :title="warning" />
          <el-table
            ref="previewTableRef"
            :data="preview.changes"
            :row-key="previewRowKey"
            max-height="390"
            @selection-change="handlePreviewSelection"
          >
            <el-table-column type="selection" width="46" reserve-selection />
            <el-table-column prop="shop_name" label="店铺" min-width="160" />
            <el-table-column label="商品 / SKU" min-width="230">
              <template #default="scope"><strong>{{ scope.row.sku || scope.row.requested_sku || '全部变体' }}</strong><small>{{ scope.row.product_id }}</small></template>
            </el-table-column>
            <el-table-column label="字段" min-width="160">
              <template #default="scope"><strong>{{ scope.row.field_label }}</strong><small v-if="scope.row.warehouse_label">{{ scope.row.warehouse_label }}</small></template>
            </el-table-column>
            <el-table-column prop="old_value" label="原值" min-width="120" />
            <el-table-column prop="new_value" label="新值" min-width="120"><template #default="scope"><strong class="new-value">{{ scope.row.new_value }}</strong></template></el-table-column>
          </el-table>
          <footer>
            <span>已选择 {{ selectedChanges.size }} / {{ preview.change_count }} 项</span>
            <el-button type="primary" :icon="Send" :loading="executing" @click="executePreview">确认并同步</el-button>
          </footer>
        </section>

        <section v-if="job" class="job-panel">
          <header><div><span class="panel-kicker">MABANG JOB</span><h3>同步任务 {{ job.state }}</h3></div><strong>{{ job.processed_products }}/{{ job.total_products }}</strong></header>
          <el-progress :percentage="job.total_products ? Math.round(job.processed_products / job.total_products * 100) : 0" :status="job.state === 'failed' ? 'exception' : job.state === 'completed' ? 'success' : undefined" />
          <div class="job-results">
            <div v-for="result in job.results || []" :key="`${result.platform}-${result.internal_id}`" :class="result.status">
              <el-tag :type="result.status === 'success' ? 'success' : result.status === 'failed' ? 'danger' : 'warning'" size="small">{{ result.status }}</el-tag>
              <strong>{{ result.shop_name }}</strong>
              <span>{{ result.message }}</span>
            </div>
          </div>
        </section>

        <section class="listing-summary-strip">
          <div><span>当前结果</span><strong>{{ total.toLocaleString("zh-CN") }}</strong></div>
          <div><span>当前页刊登</span><strong>{{ listings.length }}</strong></div>
          <div><span>当前页变体</span><strong>{{ totalVariants }}</strong></div>
          <div><span>数据时间</span><strong class="date">{{ formatDate(fetchedAt) }}</strong></div>
        </section>

        <section class="dashboard-panel listing-table-panel">
          <header><div><span class="panel-kicker">LISTINGS</span><h3>{{ currentPlatform?.name }} 刊登列表</h3></div><span>{{ shops.length }} 个店铺</span></header>
          <el-table
            ref="tableRef"
            v-model:expand-row-keys="expandedRows"
            :data="listings"
            :row-key="rowKey"
            stripe
            empty-text="暂无刊登数据"
            @selection-change="handleSelectionChange"
          >
            <el-table-column type="selection" width="46" reserve-selection fixed />
            <el-table-column type="expand" width="46">
              <template #default="scope">
                <div class="variant-table">
                  <h4>SKU 变体明细</h4>
                  <el-table :data="scope.row.variants || []" size="small" border>
                    <el-table-column prop="sku" label="变体 SKU" min-width="150" fixed />
                    <el-table-column prop="stock_sku" label="库存 SKU" min-width="150" />
                    <el-table-column label="规格" min-width="160"><template #default="variant">{{ specification(variant.row) }}</template></el-table-column>
                    <el-table-column label="原价" width="135" align="right"><template #default="variant">{{ money(variant.row.price, scope.row.currency) }}</template></el-table-column>
                    <el-table-column :label="scope.row.platform === 'shopee' ? '售价' : '促销价'" width="135" align="right"><template #default="variant">{{ money(variant.row.sale_price, scope.row.currency) }}</template></el-table-column>
                    <el-table-column prop="stock" label="总库存" width="90" align="right" />
                    <el-table-column label="多仓库存" min-width="250">
                      <template #default="variant">
                        <div v-if="variant.row.warehouse_stock?.length" class="warehouse-stock-list">
                          <span v-for="(warehouse, index) in variant.row.warehouse_stock" :key="`${warehouseLabel(warehouse,index)}-${index}`">
                            {{ warehouseLabel(warehouse, index) }} <strong>{{ warehouse.stock ?? 0 }}</strong>
                          </span>
                        </div>
                        <span v-else>单仓 {{ variant.row.stock ?? 0 }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="供货价" width="130" align="right"><template #default="variant">{{ money(variant.row.supply_price, scope.row.currency) }}</template></el-table-column>
                  </el-table>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="商品" min-width="350" fixed>
              <template #default="scope">
                <div class="product-cell">
                  <MarketplaceImage :source="scope.row.image" :alt="scope.row.title" :size="62" />
                  <div><strong>{{ scope.row.title || '未命名商品' }}</strong><small>平台 ID {{ scope.row.product_id }} · 马帮 ID {{ scope.row.internal_id }}</small><a v-if="scope.row.product_url" :href="scope.row.product_url" target="_blank" rel="noreferrer">商品链接 <ExternalLink :size="12" /></a></div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="shop_name" label="店铺 / 站点" min-width="180"><template #default="scope"><strong>{{ scope.row.shop_name }}</strong><small>{{ scope.row.site }}</small></template></el-table-column>
            <el-table-column prop="parent_sku" label="父 SKU" min-width="150" />
            <el-table-column label="价格" min-width="190">
              <template #default="scope">
                <span>原价 {{ range(scope.row.variants.map((item: ListingVariant) => item.price), scope.row.currency) }}</span>
                <strong>{{ scope.row.platform === 'shopee' ? '售价' : '促销价' }} {{ range(scope.row.variants.map((item: ListingVariant) => item.sale_price), scope.row.currency) }}</strong>
              </template>
            </el-table-column>
            <el-table-column label="库存" width="100" align="right"><template #default="scope"><strong>{{ stockSummary(scope.row).toLocaleString('zh-CN') }}</strong></template></el-table-column>
            <el-table-column label="刊登时间" width="170"><template #default="scope"><span>{{ formatDate(scope.row.publish_time) }}</span><small>更新 {{ formatDate(scope.row.update_time) }}</small></template></el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="scope">
                <el-button v-if="scope.row.platform === 'lazada'" link type="primary" @click="copyToDraft(scope.row)">复制刊登</el-button>
                <el-button v-if="scope.row.product_url" link tag="a" :href="scope.row.product_url" target="_blank">打开</el-button>
              </template>
            </el-table-column>
          </el-table>
          <footer class="listing-pagination">
            <el-pagination
              v-model:current-page="query.page"
              v-model:page-size="query.pageSize"
              :total="total"
              :page-sizes="[20,50,100]"
              layout="sizes, prev, pager, next"
              background
              @current-change="load()"
              @size-change="load({ resetPage: true })"
            />
          </footer>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.listing-vue-page { display: grid; gap: 14px; }
.listing-login-card { width: min(520px,100%); min-height: 390px; display: grid; justify-items: center; align-content: center; gap: 8px; margin: 40px auto; padding: 32px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); text-align: center; }
.listing-login-icon { display: grid; place-items: center; width: 58px; height: 58px; margin-bottom: 8px; border-radius: 8px; color: var(--ops-primary); background: #eff6ff; }
.listing-login-card h2 { margin: 4px 0; }.listing-login-card p { margin: 0 0 12px; color: var(--ops-text-secondary); font-size: 12px; }.listing-login-card form { width: 100%; display: grid; gap: 14px; }.listing-login-card label { display: grid; gap: 6px; text-align: left; }.listing-login-card label span { font-size: 12px; font-weight: 650; }
.listing-platformbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); overflow-x: auto; }
.listing-filterbar > .el-select { min-width: 220px; }.listing-search { flex: 1; display: flex; }.listing-search .el-select { width: 110px; }
.ai-command-center, .batch-editor, .preview-panel, .job-panel { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); }
.ai-command-center header, .batch-editor header, .preview-panel header, .job-panel header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.ai-command-center h3, .batch-editor h3, .preview-panel h3, .job-panel h3 { margin: 3px 0 0; font-size: 17px; }
.ai-command-grid { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: end; gap: 10px; }
.ai-examples { display: flex; flex-wrap: wrap; gap: 7px; }.ai-examples button { padding: 5px 8px; border: 1px solid var(--ops-border-light); border-radius: 5px; background: var(--ops-surface-muted); color: var(--ops-text-secondary); font-size: 11px; cursor: pointer; }
.ai-result-summary { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-left: 3px solid var(--ops-primary); background: var(--ops-surface-muted); }.ai-result-summary > div { display: grid; gap: 2px; }.ai-result-summary span { color: var(--ops-text-secondary); font-size: 11px; }.ai-result-summary .el-button { margin-left: auto; }
.selection-strip { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; border: 1px solid #bfdbfe; border-radius: 7px; background: #eff6ff; color: #1d4ed8; font-size: 12px; font-weight: 650; }
.batch-sku-filter { display: grid; grid-template-columns: 130px minmax(0,1fr); align-items: center; gap: 10px; }.batch-sku-filter label { font-size: 12px; font-weight: 650; }
.operation-list { display: grid; gap: 8px; }.operation-row { display: grid; grid-template-columns: 150px minmax(120px,170px) minmax(160px,1fr) minmax(140px,1fr) 34px; gap: 8px; align-items: center; }.operation-row > :nth-child(2):last-of-type { grid-column: auto; }
.batch-editor footer, .preview-panel footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.preview-panel small, .listing-table-panel small, .job-panel small { display: block; margin-top: 3px; color: var(--ops-text-secondary); font-size: 10px; }.new-value { color: #15803d; }
.job-results { display: grid; gap: 6px; }.job-results > div { display: grid; grid-template-columns: 85px 180px minmax(0,1fr); align-items: start; gap: 8px; padding: 8px 0; border-top: 1px solid var(--ops-border-light); font-size: 12px; }.job-results > div.failed span { color: #b91c1c; }
.listing-summary-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); }.listing-summary-strip > div { display: grid; gap: 5px; min-height: 78px; align-content: center; padding: 12px 16px; border-right: 1px solid var(--ops-border-light); }.listing-summary-strip > div:last-child { border-right: 0; }.listing-summary-strip span { color: var(--ops-text-secondary); font-size: 11px; }.listing-summary-strip strong { font-size: 20px; }.listing-summary-strip strong.date { font-size: 13px; }
.listing-table-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); }.variant-table { padding: 10px 24px 18px; }.variant-table h4 { margin: 0 0 8px; }.warehouse-stock-list { display: flex; flex-wrap: wrap; gap: 5px; }.warehouse-stock-list span { padding: 3px 6px; border: 1px solid var(--ops-border-light); border-radius: 4px; background: var(--ops-surface-muted); font-size: 10px; }.warehouse-stock-list strong { margin-left: 4px; }
.product-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }.product-cell > div { min-width: 0; display: grid; gap: 3px; }.product-cell strong { overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.35; }.product-cell a { display: inline-flex; align-items: center; gap: 3px; color: var(--ops-primary); font-size: 10px; text-decoration: none; }.listing-pagination { display: flex; justify-content: flex-end; padding: 14px 16px; border-top: 1px solid var(--ops-border-light); }
@media (max-width: 1100px) { .operation-row { grid-template-columns: repeat(2,minmax(0,1fr)) 34px; }.operation-row .el-button { grid-column: 3; grid-row: 1; }.job-results > div { grid-template-columns: 80px 140px minmax(0,1fr); } }
@media (max-width: 760px) { .listing-platformbar { align-items: flex-start; flex-direction: column; }.listing-filterbar { align-items: stretch; flex-direction: column; }.listing-filterbar > .el-select { width: 100%; }.listing-summary-strip { grid-template-columns: repeat(2,minmax(0,1fr)); }.ai-command-grid { grid-template-columns: 1fr; }.operation-row { grid-template-columns: 1fr; padding-bottom: 10px; border-bottom: 1px solid var(--ops-border-light); }.operation-row .el-button { grid-column: auto; grid-row: auto; justify-self: end; }.job-results > div { grid-template-columns: 70px 1fr; }.job-results > div span { grid-column: 1 / -1; } }
@media (max-width: 440px) { .listing-summary-strip { grid-template-columns: 1fr; }.listing-summary-strip > div { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }.selection-strip { align-items: flex-start; flex-direction: column; } }
</style>
