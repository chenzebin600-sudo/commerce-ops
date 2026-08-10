<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Activity, CheckCircle2, Database, Play, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, Upload } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  approveInventorySync,
  approveSkuRebind,
  loadInventorySyncProgress,
  loadInventoryPrepareProgress,
  loadInventoryPreviewProgress,
  loadInventoryOperationPlan,
  loadSkuRebindProgress,
  loadInventorySyncStatus,
  loadLazadaRunMonitor,
  loadContinuousInventorySync,
  prepareInventorySync,
  previewInventoryConfigImport,
  previewInventorySync,
  previewSkuRebind,
  startSkuRebind,
  startInventorySync,
  startContinuousInventorySync,
  type InventorySyncAccount,
  type InventoryConfigImportPreview,
  type InventorySyncItem,
  type InventoryPoolInput,
  type InventorySyncPlan,
  type InventorySyncShop,
  type InventorySyncWarehouse,
  type InventoryPrepareProgress,
  type InventoryPreviewProgress,
  type InventoryContinuousRun,
  type LazadaRunMonitor,
  type SkuRebindItem,
  type SkuRebindPlan,
  type SkuRebindProgress,
} from "@/services/inventory-sync";

interface InventoryExceptionRow {
  key: string;
  source: "匹配阻断" | "执行失败" | "执行跳过";
  batch: number;
  shopId: string;
  shopName: string;
  internalId: string;
  productId: string;
  title: string;
  variationId: string;
  sellerSku: string;
  reasonCode: string;
  message: string;
}

const accounts = ref<InventorySyncAccount[]>([]);
const platform = ref<"shopee" | "lazada">("shopee");
const history = ref<Array<InventorySyncPlan | SkuRebindPlan>>([]);
const shops = ref<InventorySyncShop[]>([]);
const warehouses = ref<InventorySyncWarehouse[]>([]);
const accountProfileId = ref("");
const inventoryPools = ref<InventoryPoolInput[]>([]);
const snapshot = ref<{ id: string; capturedAt: string; expiresAt: string; rowCount: number; compactRowCount?: number; cacheUpdateTime?: string | null; reused?: boolean; scoped?: boolean; scopeWarehouseNames?: string[]; readMetrics?: { loginMs?: number; shopReadMs?: number; inventoryReadMs?: number; totalMs?: number } | null; sourceMode?: string; sourcePageCount?: number } | null>(null);
const safetyStock = ref(5);
const perListingCap = ref(999);
const multiWarehouseMode = ref<"block" | "single_largest" | "proportional">("block");
const settingsVisible = ref(false);
const configImportVisible = ref(false);
const configImporting = ref(false);
const configImportPreview = ref<InventoryConfigImportPreview | null>(null);
const draftMultiWarehouseMode = ref<"block" | "single_largest" | "proportional">("block");
const plan = ref<InventorySyncPlan | null>(null);
const inventoryProgress = ref<SkuRebindProgress | null>(null);
const rebindPlan = ref<SkuRebindPlan | null>(null);
const rebindProgress = ref<SkuRebindProgress | null>(null);
const rebindApprovalText = ref("");
const rebindApprovalInput = ref("");
const manualMappingText = ref("");
const requiredApprovalText = ref("");
const approvalInput = ref("");
const loading = ref(false);
const preparing = ref(false);
const prepareProgress = ref<InventoryPrepareProgress | null>(null);
const previewing = ref(false);
const previewProgress = ref<InventoryPreviewProgress | null>(null);
const approving = ref(false);
const executing = ref(false);
const continuousExecuting = ref(false);
const continuousCompletedBatches = ref(0);
const continuousEstimatedBatches = ref(0);
const continuousExceptions = ref<InventoryExceptionRow[]>([]);
const continuousRunId = ref("");
const rebindBusy = ref(false);
const openingPlanId = ref("");
const error = ref("");
const lazadaRunMonitor = ref<LazadaRunMonitor | null>(null);
const lazadaMonitorError = ref("");
const lazadaMonitorLoading = ref(false);
let lazadaMonitorTimer = 0;
let rebindPollGeneration = 0;
let inventoryPollGeneration = 0;
let preparePollGeneration = 0;
let previewPollGeneration = 0;
let poolSequence = 0;
const INVENTORY_SETTINGS_KEY = "commerce-ops.inventory-sync.settings.v1";
const INVENTORY_POOLS_KEY_PREFIX = "commerce-ops.inventory-sync.pools.v1";
const CONTINUOUS_NOTICE_KEY = "commerce-ops.inventory-sync.continuous-notice.v1";
const platformLabel = computed(() => platform.value === "lazada" ? "Lazada" : "Shopee");
const continuousApprovalText = computed(() => `确认连续同步 ${platformLabel.value} 库存`);
const supportsSkuRebind = computed(() => platform.value === "shopee");
const lazadaMonitorTagType = computed<"primary" | "success" | "warning" | "danger" | "info">(() => {
  if (["SUCCEEDED", "NO_CHANGES"].includes(lazadaRunMonitor.value?.state || "")) return "success";
  if (lazadaRunMonitor.value?.state === "FAILED") return "danger";
  if (["STALLED", "PARTIAL"].includes(lazadaRunMonitor.value?.state || "")) return "warning";
  if (lazadaRunMonitor.value?.state === "RUNNING") return "primary";
  return "info";
});
const lazadaMonitorStateLabel = computed(() => ({
  IDLE: "未运行", RUNNING: "运行中", STALLED: "可能卡住", SUCCEEDED: "已完成", PARTIAL: "部分完成", NO_CHANGES: "无需变更", FAILED: "失败",
}[lazadaRunMonitor.value?.state || "IDLE"]));
const lazadaMonitorFacts = computed(() => {
  const counts = lazadaRunMonitor.value?.counts || {};
  return [
    counts.shops ? `${counts.shops} 家店铺` : "",
    counts.warehouses ? `${counts.warehouses} 个仓库` : "",
    counts.listingsTotal ? `在线商品 ${counts.listingsFetched || 0}/${counts.listingsTotal}` : "",
    counts.ready !== undefined ? `待更新 ${counts.ready}` : "",
    counts.blocked !== undefined ? `已跳过 ${counts.blocked}` : "",
    counts.batchCount ? `批次 ${counts.batch || 0}/${counts.batchCount}` : "",
  ].filter(Boolean);
});

function formatDuration(startedAt?: string | null, finishedAt?: string | null) {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((new Date(finishedAt || Date.now()).getTime() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

async function refreshLazadaRunMonitor() {
  if (lazadaMonitorLoading.value) return;
  lazadaMonitorLoading.value = true;
  try {
    const result = await loadLazadaRunMonitor();
    lazadaRunMonitor.value = result.monitor;
    lazadaMonitorError.value = "";
  } catch (reason) {
    lazadaMonitorError.value = String((reason as Error)?.message || reason);
  } finally {
    lazadaMonitorLoading.value = false;
  }
}

const multiWarehouseModeLabels = {
  block: "多仓商品先阻断",
  single_largest: "总库存集中到一仓",
  proportional: "按现有库存占比分配",
} as const;

function loadInventorySettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(INVENTORY_SETTINGS_KEY) || "{}");
    if (["block", "single_largest", "proportional"].includes(saved.multiWarehouseMode)) {
      multiWarehouseMode.value = saved.multiWarehouseMode;
    }
  } catch {
    multiWarehouseMode.value = "block";
  }
}

function openInventorySettings() {
  draftMultiWarehouseMode.value = multiWarehouseMode.value;
  settingsVisible.value = true;
}

function saveInventorySettings() {
  multiWarehouseMode.value = draftMultiWarehouseMode.value;
  window.localStorage.setItem(INVENTORY_SETTINGS_KEY, JSON.stringify({
    multiWarehouseMode: multiWarehouseMode.value,
  }));
  settingsVisible.value = false;
  ElMessage.success("库存同步设置已保存，下一次生成计划时生效");
}

function createInventoryPool(): InventoryPoolInput {
  poolSequence += 1;
  return { id: `pool-${Date.now()}-${poolSequence}`, name: `库存池 ${poolSequence}`, shopIds: [], warehouseNames: [] };
}

function addInventoryPool() {
  inventoryPools.value.push(createInventoryPool());
}

function removeInventoryPool(poolId: string) {
  if (inventoryPools.value.length <= 1) return;
  inventoryPools.value = inventoryPools.value.filter((pool) => pool.id !== poolId);
}

function setPoolShop(pool: InventoryPoolInput, shopId: unknown) {
  const normalizedShopId = String(shopId || "");
  pool.shopIds = normalizedShopId ? [normalizedShopId] : [];
}

function fileBase64(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
    }
    return window.btoa(binary);
  });
}

async function handleConfigImportFile(uploadFile: { raw?: File }) {
  const file = uploadFile.raw;
  if (!file) return;
  if (!snapshot.value) return ElMessage.warning("请先读取库存和店铺，再导入配置表");
  if (!/\.(xlsx|csv)$/i.test(file.name)) return ElMessage.warning("请选择 .xlsx 或 .csv 配置表");
  if (file.size > 1024 * 1024) return ElMessage.warning("配置表不能超过 1MB");
  configImporting.value = true;
  error.value = "";
  try {
    configImportPreview.value = await previewInventoryConfigImport({
      accountProfileId: accountProfileId.value,
      snapshotId: snapshot.value.id,
      platform: platform.value,
      filename: file.name,
      fileBase64: await fileBase64(file),
    });
    configImportVisible.value = true;
    const summary = configImportPreview.value.summary;
    if (summary.needsReview) {
      ElMessage.warning(`已识别 ${summary.total} 家店铺，${summary.ready} 家可应用，${summary.needsReview} 家需要核查`);
    } else {
      ElMessage.success(`已识别 ${summary.total} 家店铺，全部可应用`);
    }
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
  } finally {
    configImporting.value = false;
  }
}

async function applyConfigImport() {
  const imported = configImportPreview.value;
  if (!imported?.inventoryPools.length || !imported.summary.ready) return;
  await ElMessageBox.confirm(
    `将用配置表中 ${imported.summary.ready} 家已匹配的 ${platformLabel.value} 店铺替换当前库存池草稿；不会修改在线库存。是否继续？`,
    "应用批量配置",
    { type: "warning", confirmButtonText: "应用配置", cancelButtonText: "返回核查" },
  );
  inventoryPools.value = imported.inventoryPools.map((pool) => ({
    ...pool,
    shopIds: [...pool.shopIds],
    warehouseNames: [...pool.warehouseNames],
  }));
  poolSequence = inventoryPools.value.length;
  plan.value = null;
  configImportVisible.value = false;
  ElMessage.success(`已应用 ${imported.summary.ready} 家店铺、${imported.inventoryPools.length} 个库存池；请强制刷新后生成差异预览`);
}

function shopAssignedElsewhere(shopId: string, poolId: string) {
  return inventoryPools.value.some((pool) => pool.id !== poolId && pool.shopIds.includes(shopId));
}

function inventoryPoolsStorageKey() {
  return `${INVENTORY_POOLS_KEY_PREFIX}:${platform.value}:${accountProfileId.value || "default"}`;
}

function savedWarehouseScope() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(inventoryPoolsStorageKey()) || "[]");
    if (!Array.isArray(saved)) return [];
    return [...new Set(saved.flatMap((pool) => Array.isArray(pool?.warehouseNames) ? pool.warehouseNames : []).map(String).filter(Boolean))];
  } catch {
    return [];
  }
}

function restoreInventoryPools(serverPools: InventoryPoolInput[] = []) {
  const shopIds = new Set(shops.value.map((shop) => shop.id));
  const warehouseNames = new Set(warehouses.value.map((warehouse) => warehouse.name));
  try {
    const localSaved = JSON.parse(window.localStorage.getItem(inventoryPoolsStorageKey()) || "[]");
    const saved = Array.isArray(localSaved) && localSaved.length ? localSaved : serverPools;
    if (Array.isArray(saved) && saved.length) {
      const hadSharedPools = saved.some((pool) => Array.isArray(pool?.shopIds) && pool.shopIds.length > 1);
      inventoryPools.value = saved.map((pool, index) => ({
        id: String(pool.id || `pool-saved-${index + 1}`),
        name: String(pool.name || `库存池 ${index + 1}`),
        shopIds: Array.isArray(pool.shopIds) && pool.shopIds.length <= 1 ? pool.shopIds.filter((id: string) => shopIds.has(id)) : [],
        warehouseNames: Array.isArray(pool.warehouseNames) ? pool.warehouseNames.filter((name: string) => warehouseNames.has(name)) : [],
      }));
      poolSequence = inventoryPools.value.length;
      if (hadSharedPools) ElMessage.warning("检测到旧版共享库存池，已取消其店铺绑定；请重新导入配置表或逐一选择店铺");
      return;
    }
  } catch {
    // Invalid local drafts fall back to a clean pool below.
  }
  poolSequence = 0;
  inventoryPools.value = [createInventoryPool()];
}

watch(inventoryPools, (value) => {
  if (!snapshot.value || !accountProfileId.value) return;
  window.localStorage.setItem(inventoryPoolsStorageKey(), JSON.stringify(value));
}, { deep: true });

watch(platform, () => {
  snapshot.value = null;
  shops.value = [];
  warehouses.value = [];
  inventoryPools.value = [];
  plan.value = null;
  inventoryProgress.value = null;
  rebindPlan.value = null;
  rebindProgress.value = null;
  configImportPreview.value = null;
  requiredApprovalText.value = "";
  approvalInput.value = "";
  error.value = "";
});

const assignedShopCount = computed(() => new Set(inventoryPools.value.flatMap((pool) => pool.shopIds)).size);
const assignedWarehouseCount = computed(() => new Set(inventoryPools.value.flatMap((pool) => pool.warehouseNames)).size);

const planShopFilter = ref("");
const planStatusFilter = ref("");
const planPage = ref(1);
const planPageSize = ref(100);
const planShopSummaries = computed(() => {
  const currentPlan = plan.value;
  if (!currentPlan) return [];
  const catalogNames = new Map(shops.value.map((shop) => [shop.id, shop.name]));
  const rowsByShop = new Map<string, InventorySyncItem[]>();
  for (const item of currentPlan.items || []) {
    const rows = rowsByShop.get(item.shopId) || [];
    rows.push(item);
    rowsByShop.set(item.shopId, rows);
  }
  const scopeShopIds = [...new Set([
    ...(currentPlan.scope.shopIds || []),
    ...rowsByShop.keys(),
  ])];
  return scopeShopIds.map((shopId) => {
    const rows = rowsByShop.get(shopId) || [];
    return {
      shopId,
      shopName: rows[0]?.shopName || catalogNames.get(shopId) || shopId,
      total: rows.length,
      ready: rows.filter((item) => item.status === "READY").length,
      unchanged: rows.filter((item) => item.status === "UNCHANGED").length,
      blocked: rows.filter((item) => item.status === "BLOCKED").length,
    };
  });
});
const filteredPlanItems = computed(() => (plan.value?.items || []).filter((item) => (
  (!planShopFilter.value || item.shopId === planShopFilter.value)
  && (!planStatusFilter.value || item.status === planStatusFilter.value)
)));
const displayItems = computed(() => {
  const start = (planPage.value - 1) * planPageSize.value;
  return filteredPlanItems.value.slice(start, start + planPageSize.value);
});

function selectPlanShop(shopId: string) {
  planShopFilter.value = shopId;
}

watch([planShopFilter, planStatusFilter, planPageSize], () => {
  planPage.value = 1;
});

watch(() => plan.value?.id, () => {
  planShopFilter.value = "";
  planStatusFilter.value = "";
  planPage.value = 1;
});

const executable = computed(() => plan.value?.state === "APPROVED" && Number(plan.value?.summary.readyCount || 0) > 0);
const continuingAfterSuccessfulBatch = computed(() => (
  plan.value?.state === "SUCCEEDED"
  && Number(plan.value?.summary.productBatchCount || 1) > 1
));
const approvalMatches = computed(() => approvalInput.value.trim() === requiredApprovalText.value);
const continuousApprovalMatches = computed(() => approvalInput.value.trim() === continuousApprovalText.value);
const approvable = computed(() => approvalMatches.value && Number(plan.value?.summary.readyCount || 0) > 0);
const rebindableCount = computed(() => supportsSkuRebind.value ? (plan.value?.items || []).filter((item) => item.reasonCode === "SELLER_SKU_REBIND_REQUIRED").length : 0);
const unmappedSkuCount = computed(() => supportsSkuRebind.value ? new Set((plan.value?.items || [])
  .filter((item) => item.reasonCode === "SELLER_SKU_NOT_IN_INVENTORY")
  .map((item) => item.sellerSku.trim().toUpperCase())
  .filter(Boolean)).size : 0);
const manualMappingLineCount = computed(() => manualMappingText.value.split(/\r?\n/).filter((line) => line.trim() && !/seller.*sku.*库存.*sku/i.test(line)).length);
const rebindApprovalMatches = computed(() => rebindApprovalInput.value.trim() === rebindApprovalText.value);
const rebindProgressStatus = computed(() => {
  if (rebindProgress.value?.stage === "SUCCEEDED") return "success";
  if (["FAILED", "BLOCKED"].includes(rebindProgress.value?.stage || "")) return "exception";
  if (rebindProgress.value?.stage === "UNKNOWN") return "warning";
  return undefined;
});
const inventoryProgressStatus = computed(() => {
  if (inventoryProgress.value?.stage === "SUCCEEDED") return "success";
  if (["FAILED", "BLOCKED"].includes(inventoryProgress.value?.stage || "")) return "exception";
  if (inventoryProgress.value?.stage === "UNKNOWN") return "warning";
  return undefined;
});
const inventoryStages = [
  { key: "VALIDATING", label: "安全检查" },
  { key: "PREFLIGHT", label: "马帮预检" },
  { key: "SUBMITTING", label: "提交批次" },
  { key: "PROCESSING", label: "处理与回读" },
];
const rebindStages = [
  { key: "VALIDATING", label: "安全检查" },
  { key: "PREFLIGHT", label: "马帮预检" },
  { key: "SUBMITTING", label: "提交批次" },
  { key: "PROCESSING", label: "批次处理" },
  { key: "READBACK", label: "在线回读" },
];
const rebindStageOrder: Record<string, number> = { QUEUED: 0, VALIDATING: 1, PREFLIGHT: 2, SUBMITTING: 3, PROCESSING: 4, READBACK: 5, SUCCEEDED: 6 };

function rebindStageState(key: string) {
  const current = rebindProgress.value?.stage || "QUEUED";
  if (["FAILED", "UNKNOWN", "BLOCKED"].includes(current)) {
    const thresholds = [5, 20, 32, 40, 90];
    const failedIndex = Math.max(0, thresholds.reduce((found, value, index) => value <= Number(rebindProgress.value?.percent || 0) ? index : found, -1));
    const stageIndex = rebindStages.findIndex((stage) => stage.key === key);
    if (stageIndex < failedIndex) return "done";
    return stageIndex === failedIndex ? "failed" : "idle";
  }
  const currentOrder = rebindStageOrder[current] || 0;
  const stageOrder = rebindStageOrder[key];
  if (stageOrder < currentOrder || current === "SUCCEEDED") return "done";
  if (stageOrder === currentOrder) return "active";
  return "idle";
}

function inventoryStageState(key: string) {
  const current = inventoryProgress.value?.stage || "QUEUED";
  const order: Record<string, number> = { QUEUED: 0, VALIDATING: 1, PREFLIGHT: 2, SUBMITTING: 3, PROCESSING: 4, SUCCEEDED: 5 };
  if (["FAILED", "UNKNOWN", "BLOCKED"].includes(current)) {
    const thresholds = [5, 25, 35, 40];
    const failedIndex = Math.max(0, thresholds.reduce((found, value, index) => value <= Number(inventoryProgress.value?.percent || 0) ? index : found, -1));
    const stageIndex = inventoryStages.findIndex((stage) => stage.key === key);
    if (stageIndex < failedIndex) return "done";
    return stageIndex === failedIndex ? "failed" : "idle";
  }
  const currentOrder = order[current] || 0;
  const stageOrder = order[key];
  if (stageOrder < currentOrder || current === "SUCCEEDED") return "done";
  if (stageOrder === currentOrder) return "active";
  return "idle";
}

function rowIdentity(row: InventorySyncPlan["items"][number]) {
  return [row.shopId, row.internalId, row.productId, row.variationId, row.sellerSku].join(":");
}

function rebindRowIdentity(row: SkuRebindItem) {
  return [row.shopId, row.internalId, row.variationId].join(":");
}

function isRebindPlan(value: InventorySyncPlan | SkuRebindPlan): value is SkuRebindPlan {
  return value.operationType === "MABANG.SKU_REBIND.SHOPEE";
}

function operationLabel(value: InventorySyncPlan | SkuRebindPlan) {
  return isRebindPlan(value) ? "SKU 换绑" : "库存同步";
}

function parseManualMappings() {
  const mappings = new Map<string, string>();
  for (const [index, rawLine] of manualMappingText.value.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || /seller.*sku.*库存.*sku/i.test(line)) continue;
    const values = line.split(/\t|,|，|=>|->|→|=/).map((value) => value.trim()).filter(Boolean);
    if (values.length !== 2) throw new Error(`人工映射第 ${index + 1} 行格式不正确，应为“当前 Seller SKU<Tab>目标库存 SKU”`);
    const fromSku = values[0].toUpperCase();
    const toSku = values[1].toUpperCase();
    const previous = mappings.get(fromSku);
    if (previous && previous !== toSku) throw new Error(`Seller SKU ${fromSku} 填写了多个不同目标`);
    mappings.set(fromSku, toSku);
  }
  return [...mappings].map(([fromSku, toSku]) => ({ fromSku, toSku }));
}

const stateLabels: Record<string, string> = {
  PREVIEWED: "待确认", APPROVED: "已批准", IN_FLIGHT: "执行中", SUCCEEDED: "已完成",
  FAILED: "失败", UNKNOWN: "结果待确认", EXPIRED: "已过期", BLOCKED: "已阻止",
};
const reasonLabels: Record<string, string> = {
  SHARED_POOL_EQUAL_ALLOCATION: "同店同SKU变体等额分配",
  ALREADY_MATCHED: "当前库存已一致",
  INVENTORY_SKU_NOT_FOUND: "库存表未找到该库存 SKU",
  SELLER_SKU_IDENTITY_MISSING: "在线商品缺少 Seller SKU",
  SELLER_SKU_NOT_IN_INVENTORY: "Seller SKU 未在库存表精确命中",
  SELLER_SKU_REBIND_REQUIRED: "存在同产品库存 SKU，需先换绑 SKU",
  COMBO_SKU_MAPPING_REQUIRED: "组合 SKU 需先读取组件关系",
  LISTING_SKU_IDENTITY_MISSING: "在线商品缺少 SKU 身份",
  DEFERRED_AFTER_BATCH_FAILURE: "前序批次失败，已保留到待修复池",
  SHOP_NOT_FOUND: "当前账号未找到店铺，已记录并跳过",
  WAREHOUSE_NOT_FOUND: "来源仓库未找到，已记录并跳过",
  WAREHOUSE_OUTSIDE_SNAPSHOT: "仓库未包含在本次快照，已记录并跳过",
  ONLINE_LISTINGS_EMPTY: "未读取到在线商品，已记录并跳过",
};
const rebindReasonLabels: Record<string, string> = {
  HIGHEST_AVAILABLE_PRODUCT_SKU: "同产品库存最高候选",
  MANUAL_CONFIRMED_INVENTORY_SKU: "人工确认库存 SKU",
  SKU_REBIND_LISTING_DRIFT: "在线 Seller SKU 已变化",
  SKU_REBIND_NO_STOCKED_REPLACEMENT: "没有高于安全库存的候选",
  SKU_REBIND_TARGET_COLLISION: "同一商品目标 SKU 冲突",
};

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function stateType(state: string) {
  if (["SUCCEEDED", "UNCHANGED"].includes(state)) return "success";
  if (["FAILED", "BLOCKED"].includes(state)) return "danger";
  if (["UNKNOWN", "EXPIRED"].includes(state)) return "warning";
  return "primary";
}

async function refreshStatus() {
  loading.value = true;
  error.value = "";
  try {
    const result = await loadInventorySyncStatus();
    accounts.value = result.accounts || [];
    history.value = [...(result.plans || []), ...(result.rebindPlans || [])]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const latestPlatformPlan = (result.plans || []).find((item) => (item.scope?.platform || "shopee") === platform.value);
    if (!plan.value && latestPlatformPlan) {
      plan.value = latestPlatformPlan;
      requiredApprovalText.value = `确认同步 ${platformLabel.value} 库存 ${plan.value.summary.readyCount} 项`;
    }
    const platformRuns = (result.continuousRuns || []).filter((run) => (run.platform || "shopee") === platform.value);
    const latestRun = platformRuns[0];
    const activeRun = platformRuns.find((run) => !run.terminal);
    if (activeRun && !continuousExecuting.value) void pollContinuousRun(activeRun.id);
    else if (latestRun?.terminal) {
      applyContinuousRun(latestRun);
      const noticeIdentity = `${latestRun.id}:${latestRun.updatedAt}`;
      if (window.localStorage.getItem(CONTINUOUS_NOTICE_KEY) !== noticeIdentity) {
        window.localStorage.setItem(CONTINUOUS_NOTICE_KEY, noticeIdentity);
        if (latestRun.state === "COMPLETED") ElMessage.success(`全部店铺处理完成：成功 ${latestRun.successfulProducts}，待修复 ${latestRun.exceptionCount}`);
        else ElMessage.warning(`后台连续处理已停止：${latestRun.message}`);
      }
    }
    if (!accountProfileId.value) accountProfileId.value = accounts.value.find((item) => item.enabled && item.passwordConfigured)?.id || "";
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
  } finally {
    loading.value = false;
  }
}

async function openHistoryPlan(item: InventorySyncPlan | SkuRebindPlan) {
  openingPlanId.value = item.id;
  error.value = "";
  try {
    const loaded = await loadInventoryOperationPlan(item.id);
    if (isRebindPlan(loaded.plan)) {
      const source = await loadInventoryOperationPlan(loaded.plan.sourceSnapshot.sourcePlanId);
      if (isRebindPlan(source.plan)) throw new Error("SKU 换绑来源计划类型不正确");
      plan.value = source.plan;
      rebindPlan.value = loaded.plan;
      rebindApprovalText.value = `确认换绑 Shopee SKU ${loaded.plan.summary.readyCount} 项`;
      rebindApprovalInput.value = "";
      rebindProgress.value = null;
      if (loaded.plan.state === "IN_FLIGHT") void pollRebindProgress(loaded.plan.id);
    } else {
      const loadedPlatform = loaded.plan.scope?.platform || "shopee";
      if (platform.value !== loadedPlatform) {
        platform.value = loadedPlatform;
        await nextTick();
      }
      plan.value = loaded.plan;
      rebindPlan.value = null;
      rebindProgress.value = null;
      requiredApprovalText.value = `确认同步 ${platformLabel.value} 库存 ${loaded.plan.summary.readyCount} 项`;
      approvalInput.value = "";
      inventoryProgress.value = null;
      if (loaded.plan.state === "IN_FLIGHT") void pollInventoryProgress(loaded.plan.id);
    }
    ElMessage.success(`已打开${operationLabel(loaded.plan)}计划`);
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
  } finally {
    openingPlanId.value = "";
  }
}

async function prepare(forceRefresh = false) {
  if (!accountProfileId.value) return ElMessage.warning("请先选择马帮账号");
  preparing.value = true;
  error.value = "";
  plan.value = null;
  inventoryProgress.value = null;
  rebindPlan.value = null;
  rebindProgress.value = null;
  manualMappingText.value = "";
  preparePollGeneration += 1;
  const generation = preparePollGeneration;
  void pollPrepareProgress(generation);
  try {
    const requestedWarehouses = savedWarehouseScope();
    const result = await prepareInventorySync(accountProfileId.value, platform.value, forceRefresh, requestedWarehouses);
    snapshot.value = result.snapshot;
    shops.value = result.shops || [];
    warehouses.value = result.warehouses || [];
    restoreInventoryPools(result.inventoryPools || []);
    ElMessage.success(result.snapshot.reused
      ? `已复用 ${result.snapshot.rowCount} 行库存快照和 ${result.shops.length} 个 ${platformLabel.value} 店铺`
      : `已重新采集 ${result.snapshot.rowCount} 行库存和 ${result.shops.length} 个 ${platformLabel.value} 店铺`);
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
  } finally {
    preparing.value = false;
    preparePollGeneration += 1;
  }
}

async function pollPrepareProgress(generation: number) {
  while (generation === preparePollGeneration && preparing.value && accountProfileId.value) {
    try {
      const result = await loadInventoryPrepareProgress(accountProfileId.value);
      if (generation !== preparePollGeneration) return;
      prepareProgress.value = result.progress;
    } catch {
      // The main prepare request remains authoritative; transient progress failures are non-fatal.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 700));
  }
}

async function preview(productBatchNumber = 1, options: { quiet?: boolean; excludedProducts?: Array<{ shopId: string; internalId: string }> } = {}) {
  if (!snapshot.value) {
    ElMessage.warning("请先读取库存和店铺范围");
    return false;
  }
  const incompletePool = inventoryPools.value.find((pool) => !pool.name.trim() || !pool.shopIds.length || !pool.warehouseNames.length);
  if (incompletePool) {
    ElMessage.warning(`${incompletePool.name || "未命名库存池"}需要填写名称，并至少绑定一个店铺和一个来源仓库`);
    return false;
  }
  const sharedPool = inventoryPools.value.find((pool) => pool.shopIds.length > 1);
  if (sharedPool) {
    ElMessage.warning(`${sharedPool.name}绑定了多个店铺；库存池必须严格一店一池`);
    return false;
  }
  previewing.value = true;
  previewProgress.value = null;
  error.value = "";
  previewPollGeneration += 1;
  const generation = previewPollGeneration;
  void pollPreviewProgress(generation);
  try {
    const result = await previewInventorySync({
      snapshotId: snapshot.value.id,
      accountProfileId: accountProfileId.value,
      platform: platform.value,
      inventoryPools: inventoryPools.value.map((pool) => ({ ...pool, name: pool.name.trim() })),
      safetyStock: safetyStock.value,
      perListingCap: perListingCap.value,
      multiWarehouseMode: multiWarehouseMode.value,
      productBatchNumber,
      excludedProducts: options.excludedProducts || [],
    });
    plan.value = result.plan;
    inventoryProgress.value = null;
    rebindPlan.value = null;
    rebindProgress.value = null;
    manualMappingText.value = "";
    requiredApprovalText.value = result.approvalText;
    approvalInput.value = "";
    if (!options.quiet) ElMessage.success("库存差异预览已生成，尚未执行写入");
    return true;
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
    return false;
  } finally {
    previewing.value = false;
    previewPollGeneration += 1;
  }
}

async function previewNextBatch() {
  if (!plan.value) return;
  // A completed batch changes the live difference set. The remaining products
  // are therefore re-numbered from batch 1 by the backend; carrying the old
  // ordinal forward (for example 1/2 -> 2) can request a now-invalid batch.
  const productBatchNumber = plan.value.state === "SUCCEEDED"
    ? 1
    : Number(plan.value.summary.productBatchNumber || 1) + 1;
  await preview(productBatchNumber);
}

async function pollPreviewProgress(generation: number) {
  while (generation === previewPollGeneration && previewing.value && accountProfileId.value) {
    try {
      const result = await loadInventoryPreviewProgress(accountProfileId.value);
      if (generation !== previewPollGeneration) return;
      previewProgress.value = result.progress;
    } catch {
      // The preview response remains authoritative if a progress poll is interrupted.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 700));
  }
}

async function createRebindPlan() {
  if (!plan.value || !rebindableCount.value) return;
  rebindBusy.value = true;
  error.value = "";
  try {
    const mappings = parseManualMappings();
    const result = await previewSkuRebind(plan.value.id, plan.value.planHash, mappings);
    rebindPlan.value = result.plan;
    rebindApprovalText.value = result.approvalText;
    rebindApprovalInput.value = "";
    ElMessage.success(`已生成 ${result.plan.summary.readyCount} 项普通 SKU 换绑预览`);
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
  } finally {
    rebindBusy.value = false;
  }
}

async function approveRebindPlan() {
  if (!rebindPlan.value || !rebindApprovalMatches.value) return;
  rebindBusy.value = true;
  error.value = "";
  try {
    const result = await approveSkuRebind(rebindPlan.value.id, rebindPlan.value.planHash, rebindApprovalInput.value.trim());
    rebindPlan.value = result.plan;
    ElMessage.success("普通 SKU 换绑计划已批准，尚未写入");
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
  } finally {
    rebindBusy.value = false;
  }
}

async function executeRebindPlan() {
  if (!rebindPlan.value || rebindPlan.value.state !== "APPROVED") return;
  await ElMessageBox.confirm(
    `将通过马帮商品编辑接口换绑 ${rebindPlan.value.summary.readyCount} 个 Shopee Seller SKU；完成后必须重新生成库存预览。是否继续？`,
    "执行普通 SKU 换绑",
    { type: "warning", confirmButtonText: "确认换绑", cancelButtonText: "取消" },
  );
  rebindBusy.value = true;
  error.value = "";
  try {
    const result = await startSkuRebind(rebindPlan.value.id, rebindPlan.value.planHash);
    rebindPlan.value = result.plan;
    rebindProgress.value = result.progress;
    await pollRebindProgress(result.plan.id);
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
    rebindBusy.value = false;
  }
}

async function pollRebindProgress(planId: string) {
  const generation = ++rebindPollGeneration;
  rebindBusy.value = true;
  let consecutiveErrors = 0;
  while (generation === rebindPollGeneration) {
    try {
      const result = await loadSkuRebindProgress(planId);
      if (generation !== rebindPollGeneration) return;
      consecutiveErrors = 0;
      rebindPlan.value = result.plan;
      rebindProgress.value = result.progress;
      if (result.progress.terminal) {
        rebindBusy.value = false;
        if (result.plan.state === "SUCCEEDED") ElMessage.success("SKU 换绑和在线回读已完成；请重新读取库存后再同步");
        else ElMessage.warning(result.progress.message || "SKU 换绑任务已结束，请检查结果");
        await refreshStatus();
        return;
      }
    } catch (reason) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        error.value = `进度查询暂时中断：${String((reason as Error)?.message || reason)}。任务可能仍在后台执行，可从历史计划重新打开。`;
        rebindBusy.value = false;
        return;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
}

async function approve() {
  if (!plan.value || !approvable.value) return;
  approving.value = true;
  error.value = "";
  try {
    const result = await approveInventorySync(plan.value.id, plan.value.planHash, approvalInput.value.trim());
    plan.value = result.plan;
    ElMessage.success("计划已批准；点击执行后才会写入马帮");
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
  } finally {
    approving.value = false;
  }
}

async function execute() {
  if (!plan.value || !executable.value) return;
  await ElMessageBox.confirm(
    `将通过马帮接口修改 ${plan.value.summary.readyCount} 个 ${platformLabel.value} 变体库存。提交后会等待马帮批次和详情回读，是否继续？`,
    "执行库存同步",
    { type: "warning", confirmButtonText: "确认执行", cancelButtonText: "取消" },
  );
  executing.value = true;
  error.value = "";
  try {
    const result = await startInventorySync(plan.value.id, plan.value.planHash);
    plan.value = result.plan;
    inventoryProgress.value = result.progress;
    await pollInventoryProgress(result.plan.id);
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
    executing.value = false;
  }
}

async function pollInventoryProgress(planId: string, options: { quiet?: boolean } = {}) {
  const generation = ++inventoryPollGeneration;
  executing.value = true;
  let consecutiveErrors = 0;
  while (generation === inventoryPollGeneration) {
    try {
      const result = await loadInventorySyncProgress(planId);
      if (generation !== inventoryPollGeneration) return;
      consecutiveErrors = 0;
      plan.value = result.plan;
      inventoryProgress.value = result.progress;
      if (result.progress.terminal) {
        executing.value = false;
        if (!options.quiet) {
          if (result.plan.state === "SUCCEEDED") ElMessage.success("库存同步和马帮任务回读已完成");
          else ElMessage.warning(result.progress.message || "库存任务已结束，请检查结果");
        }
        await refreshStatus();
        return result.plan.state === "SUCCEEDED";
      }
    } catch (reason) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        error.value = `库存进度查询暂时中断：${String((reason as Error)?.message || reason)}。任务可能仍在后台执行，可从历史计划重新打开。`;
        executing.value = false;
        return false;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  return false;
}

async function copyContinuousExceptions() {
  const header = ["来源", "批次", "店铺", "店铺ID", "商品ID", "变体ID", "Seller SKU", "原因代码", "说明", "商品标题"];
  const rows = continuousExceptions.value.map((item) => [
    item.source, item.batch, item.shopName, item.shopId, item.internalId, item.variationId,
    item.sellerSku, item.reasonCode, item.message, item.title,
  ]);
  try {
    await navigator.clipboard.writeText([header, ...rows].map((row) => row.join("\t")).join("\n"));
    ElMessage.success(`已复制 ${rows.length} 条待修复记录`);
  } catch (reason) {
    ElMessage.error(`复制失败：${String((reason as Error)?.message || reason)}`);
  }
}

async function startContinuousSync() {
  if (!plan.value || continuousExecuting.value || executing.value || previewing.value) return;
  if (plan.value.state === "PREVIEWED" && !continuousApprovalMatches.value) {
    return ElMessage.warning(`请先完整输入：${continuousApprovalText.value}`);
  }
  if (!["PREVIEWED", "APPROVED", "SUCCEEDED", "FAILED", "EXPIRED"].includes(plan.value.state)) {
    return ElMessage.warning("当前计划状态不能启动连续处理");
  }
  const estimatedBatches = Math.max(1, Number(plan.value.summary.productBatchCount || 1));
  const totalProducts = Number(plan.value.summary.totalReadyProductCount || plan.value.summary.readyCount || 0);
  await ElMessageBox.confirm(
    `系统将在后台连续处理约 ${estimatedBatches} 批、${totalProducts} 个待写商品。单个商品失败会保留到待修复池，其余商品继续；刷新或关闭页面不会中断。是否继续？`,
    "一键连续库存同步",
    { type: "warning", confirmButtonText: "确认连续处理", cancelButtonText: "取消" },
  );
  try {
    continuousExecuting.value = true;
    continuousCompletedBatches.value = 0;
    continuousEstimatedBatches.value = estimatedBatches;
    continuousExceptions.value = [];
    error.value = "";
    const result = await startContinuousInventorySync(plan.value.id, requiredApprovalText.value);
    await pollContinuousRun(result.run.id);
  } catch (reason) {
    error.value = String((reason as Error)?.message || reason);
    continuousExecuting.value = false;
    ElMessage.warning("后台连续处理启动失败，请检查错误信息");
  }
}

function applyContinuousRun(run: InventoryContinuousRun) {
  continuousRunId.value = run.id;
  continuousExecuting.value = !run.terminal;
  continuousCompletedBatches.value = Number(run.completedBatches || 0);
  continuousEstimatedBatches.value = Math.max(1, Number(run.estimatedBatches || 1));
  continuousExceptions.value = (run.exceptions || []).map((row, index) => ({
    key: [String(row.source || "异常"), String(row.shopId || ""), String(row.internalId || ""), String(row.variationId || ""), index].join(":"),
    source: String(row.source || "执行失败") as InventoryExceptionRow["source"],
    batch: Number(row.batch || 0), shopId: String(row.shopId || ""), shopName: String(row.shopName || ""),
    internalId: String(row.internalId || ""), productId: String(row.productId || ""), title: String(row.title || ""),
    variationId: String(row.variationId || ""), sellerSku: String(row.sellerSku || ""),
    reasonCode: String(row.reasonCode || ""), message: String(row.message || ""),
  }));
}

async function pollContinuousRun(runId: string) {
  if (continuousRunId.value === runId && continuousExecuting.value) return;
  continuousRunId.value = runId;
  continuousExecuting.value = true;
  while (continuousRunId.value === runId) {
    const result = await loadContinuousInventorySync(runId);
    applyContinuousRun(result.run);
    if (result.run.currentPlanId && result.run.currentPlanId !== plan.value?.id) {
      const loaded = await loadInventoryOperationPlan(result.run.currentPlanId);
      if (!isRebindPlan(loaded.plan)) plan.value = loaded.plan;
    }
    if (result.run.terminal) {
      if (result.run.state === "COMPLETED") {
        ElMessage.success(`全部店铺处理完成：成功 ${result.run.successfulProducts}，待修复 ${result.run.exceptionCount}`);
      } else {
        error.value = result.run.message;
        ElMessage.warning("后台连续处理因全局错误停止");
      }
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
}

onMounted(() => {
  loadInventorySettings();
  void refreshStatus();
  void refreshLazadaRunMonitor();
  lazadaMonitorTimer = window.setInterval(() => void refreshLazadaRunMonitor(), 5_000);
});
onBeforeUnmount(() => { continuousRunId.value = ""; rebindPollGeneration += 1; inventoryPollGeneration += 1; preparePollGeneration += 1; window.clearInterval(lazadaMonitorTimer); });
</script>

<template>
  <main class="inventory-sync-page" v-loading="loading">
    <el-alert type="info" :closable="false" show-icon :title="`当前使用马帮 ${platformLabel} 刊登库存接口，不需要平台官方 API 权限。无法匹配的店铺、仓库、SKU 或商品会记录到待修复池并跳过。`" />

    <section v-if="platform === 'lazada'" class="lazada-run-monitor" :class="`is-${(lazadaRunMonitor?.state || 'idle').toLowerCase()}`" aria-live="polite">
      <header>
        <div class="monitor-title"><Activity :size="18" /><div><span class="panel-kicker">BACKGROUND MONITOR</span><h2>Lazada 库存同步监控</h2></div></div>
        <div class="monitor-actions">
          <el-tag :type="lazadaMonitorTagType" effect="light">{{ lazadaMonitorStateLabel }}</el-tag>
          <el-button text :icon="RefreshCw" :loading="lazadaMonitorLoading" @click="refreshLazadaRunMonitor">刷新</el-button>
        </div>
      </header>
      <template v-if="lazadaRunMonitor">
        <div class="monitor-primary">
          <strong>{{ lazadaRunMonitor.stageLabel }}</strong>
          <span>{{ lazadaRunMonitor.message }}</span>
        </div>
        <div class="monitor-facts">
          <span>开始：{{ formatTime(lazadaRunMonitor.startedAt) }}</span>
          <span>最近更新：{{ formatTime(lazadaRunMonitor.updatedAt) }}</span>
          <span>耗时：{{ formatDuration(lazadaRunMonitor.startedAt, lazadaRunMonitor.finishedAt) }}</span>
          <span v-for="fact in lazadaMonitorFacts" :key="fact">{{ fact }}</span>
        </div>
        <el-alert
          v-if="lazadaRunMonitor.problem"
          :type="lazadaRunMonitor.state === 'FAILED' ? 'error' : 'warning'"
          :closable="false"
          show-icon
          :title="`${lazadaRunMonitor.problem.code}：${lazadaRunMonitor.problem.message}`"
        />
        <ul v-if="lazadaRunMonitor.problem?.details?.length" class="monitor-problem-details">
          <li v-for="(detail, index) in lazadaRunMonitor.problem.details.slice(0, 8)" :key="index">{{ JSON.stringify(detail) }}</li>
        </ul>
      </template>
      <el-alert v-else-if="lazadaMonitorError" type="error" :closable="false" show-icon :title="`监控接口不可用：${lazadaMonitorError}`" />
      <p v-else class="monitor-empty">当前没有可显示的 Lazada 后台同步记录。</p>
    </section>

    <el-dialog v-model="settingsVisible" title="库存同步设置" width="min(560px, calc(100vw - 28px))" align-center destroy-on-close>
      <div class="settings-dialog-body">
        <div class="settings-intro">
          <span class="panel-kicker">{{ platformLabel.toUpperCase() }} WAREHOUSE POLICY</span>
          <strong>在线商品多仓写入</strong>
          <p>这里控制 {{ platformLabel }} 在线仓库如何承接计划中的总库存目标，不会改变上方选择的马帮来源库存范围。</p>
        </div>
        <el-radio-group v-model="draftMultiWarehouseMode" class="strategy-list">
          <el-radio value="block">
            <strong>多仓商品先阻断</strong>
            <small>默认安全模式，不判断仓库分配。</small>
          </el-radio>
          <el-radio value="single_largest">
            <strong>总库存集中到一仓</strong>
            <small>放入该变体当前库存最多的可写仓，其余仓清零；库存并列时按马帮返回顺序。</small>
          </el-radio>
          <el-radio value="proportional">
            <strong>按现有库存占比分配</strong>
            <small>各仓保持原有占比，尾数按最大余数补齐；所有仓均为 0 时阻断。</small>
          </el-radio>
        </el-radio-group>
        <el-alert type="warning" :closable="false" show-icon title="设置保存在当前浏览器中，并会冻结到新生成的批准计划；已经生成的计划不会被修改。" />
      </div>
      <template #footer>
        <el-button @click="settingsVisible = false">取消</el-button>
        <el-button type="primary" @click="saveInventorySettings">保存设置</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="configImportVisible" title="库存同步配置导入核查" width="min(1180px, calc(100vw - 28px))" align-center destroy-on-close>
      <div v-if="configImportPreview" class="config-import-dialog">
        <div class="config-import-summary" aria-label="配置导入汇总">
          <div><span>配置工作表</span><strong>{{ configImportPreview.sheetName }}</strong></div>
          <div><span>识别店铺</span><strong>{{ configImportPreview.summary.total }}</strong></div>
          <div><span>{{ platformLabel }}可应用</span><strong>{{ configImportPreview.summary.ready }}</strong></div>
          <div><span>需要核查</span><strong>{{ configImportPreview.summary.needsReview }}</strong></div>
          <div><span>生成库存池</span><strong>{{ configImportPreview.summary.inventoryPoolCount }}</strong></div>
        </div>
        <el-alert type="info" :closable="false" show-icon :title="`当前只应用 ${platformLabel} 行；配置表中的其他平台会记录为已跳过，不会写入。`" />
        <el-alert
          v-if="configImportPreview.summary.warningCount"
          type="info"
          :closable="false"
          show-icon
          :title="`${configImportPreview.summary.warningCount} 家店铺存在范围合并提示，请在应用前查看“核查结果”列。`"
        />
        <el-table :data="configImportPreview.rows" max-height="520" stripe row-key="id">
          <el-table-column prop="shopCode" label="店编" width="95" fixed />
          <el-table-column prop="shopName" label="配置店名" min-width="170" fixed show-overflow-tooltip />
          <el-table-column label="平台" width="92">
            <template #default="scope"><el-tag size="small" :type="scope.row.platform === 'Shopee' ? 'primary' : 'info'">{{ scope.row.platform }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="countryCode" label="国家" width="72" />
          <el-table-column prop="matchedShopName" label="马帮匹配店铺" min-width="170" show-overflow-tooltip />
          <el-table-column label="对应仓库" min-width="260">
            <template #default="scope"><span>{{ scope.row.matchedWarehouses.join('、') || scope.row.sourceWarehouses.join('、') || '—' }}</span></template>
          </el-table-column>
          <el-table-column prop="syncMode" label="同步方式" min-width="155" />
          <el-table-column label="核查结果" min-width="250">
            <template #default="scope">
              <div class="config-import-result">
                <el-tag size="small" :type="scope.row.ready ? 'success' : 'danger'">{{ scope.row.ready ? '可应用' : '需核查' }}</el-tag>
                <span v-if="scope.row.issues.length" class="is-error">{{ scope.row.issues.join('；') }}</span>
                <span v-else-if="scope.row.warnings.length" class="is-warning">{{ scope.row.warnings.join('；') }}</span>
                <span v-else>店铺与仓库均已匹配</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button @click="configImportVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :disabled="!configImportPreview?.summary.ready"
          @click="applyConfigImport"
        >应用可匹配的 {{ configImportPreview?.summary.ready || 0 }} 家店铺</el-button>
      </template>
    </el-dialog>

    <section class="sync-command-panel">
      <header>
        <div><span class="panel-kicker">SOURCE & SCOPE</span><h2>读取库存与同步范围</h2></div>
        <div class="command-actions">
          <el-button :icon="Settings2" data-permission="inventory_sync.settings.manage" @click="openInventorySettings">库存同步设置</el-button>
          <el-button :icon="Database" :loading="preparing" @click="prepare(false)">快速读取</el-button>
          <el-button :icon="RefreshCw" :loading="preparing" @click="prepare(true)">强制刷新</el-button>
        </div>
      </header>
      <div class="source-grid">
        <el-form-item label="同步平台">
          <el-radio-group v-model="platform" :disabled="preparing || previewing || executing || continuousExecuting" aria-label="选择库存同步平台">
            <el-radio-button value="shopee">Shopee</el-radio-button>
            <el-radio-button value="lazada">Lazada</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="马帮账号">
          <el-select v-model="accountProfileId" placeholder="选择已保存密码的账号" :disabled="preparing || previewing || executing">
            <el-option v-for="account in accounts" :key="account.id" :value="account.id" :label="`${account.name} · ${account.usernameMasked}`" :disabled="!account.enabled || !account.passwordConfigured" />
          </el-select>
        </el-form-item>
        <div class="snapshot-fact"><span>库存快照</span><strong>{{ snapshot ? formatTime(snapshot.capturedAt) : '尚未读取' }}</strong><small v-if="snapshot">{{ snapshot.rowCount }} 行 · {{ snapshot.scoped ? `${snapshot.scopeWarehouseNames?.length || 0} 个绑定仓库` : '全部仓库' }} · {{ snapshot.sourceMode === 'html_pages' ? `HTML 快速读取 ${snapshot.sourcePageCount || 0} 页` : (snapshot.sourceMode === 'excel_fallback' ? 'Excel 安全回退' : (snapshot.reused ? '已复用' : 'Excel 采集')) }}</small></div>
        <div class="snapshot-fact"><span>马帮缓存时间</span><strong>{{ snapshot?.cacheUpdateTime || '—' }}</strong><small>执行前仍会检查在线商品库存漂移</small></div>
      </div>
      <div v-if="preparing && prepareProgress" class="prepare-progress">
        <div><strong>{{ prepareProgress.message }}</strong><span>{{ prepareProgress.percent }}%</span></div>
        <el-progress :percentage="prepareProgress.percent" :stroke-width="8" :show-text="false" />
        <div class="preview-progress-facts">
          <span v-if="prepareProgress.elapsedMs">已耗时 {{ (prepareProgress.elapsedMs / 1000).toFixed(1) }} 秒</span>
          <span v-if="prepareProgress.metrics?.shopReadMs">店铺目录 {{ (prepareProgress.metrics.shopReadMs / 1000).toFixed(1) }} 秒</span>
          <span v-if="prepareProgress.metrics?.inventoryReadMs">库存导出 {{ (prepareProgress.metrics.inventoryReadMs / 1000).toFixed(1) }} 秒</span>
        </div>
      </div>
    </section>

    <section v-if="snapshot" class="pool-workspace">
      <div class="pool-editor">
        <header class="pool-editor-header">
          <div>
            <span class="panel-kicker">INVENTORY POOLS</span>
            <h2>店铺与来源仓库绑定</h2>
            <p>严格一店一池：每家店只在自己绑定的来源仓库内按库存 SKU 匹配；同一仓库可以被多家店独立使用，但不会合并店铺范围。</p>
          </div>
          <div class="pool-editor-actions">
            <span>已绑定 {{ assignedShopCount }}/{{ shops.length }} 店铺 · {{ assignedWarehouseCount }}/{{ warehouses.length }} 仓库</span>
            <el-upload accept=".xlsx,.csv" :auto-upload="false" :show-file-list="false" :on-change="handleConfigImportFile">
              <el-button :icon="Upload" :loading="configImporting">导入配置表</el-button>
            </el-upload>
            <el-button :icon="Plus" @click="addInventoryPool">新增库存池</el-button>
          </div>
        </header>
        <div class="pool-list">
          <article v-for="(pool, index) in inventoryPools" :key="pool.id" class="pool-card">
            <header>
              <div class="pool-title">
                <span>{{ String(index + 1).padStart(2, '0') }}</span>
                <el-input v-model="pool.name" maxlength="30" placeholder="库存池名称，例如：马来库存池" aria-label="库存池名称" />
              </div>
              <el-button
                text
                type="danger"
                :icon="Trash2"
                :disabled="inventoryPools.length <= 1"
                :aria-label="`删除${pool.name}`"
                @click="removeInventoryPool(pool.id)"
              >删除</el-button>
            </header>
            <div class="pool-binding-grid">
              <el-form-item :label="`该库存池唯一对应的 ${platformLabel} 店铺`">
                <el-select
                  :model-value="pool.shopIds[0] || ''"
                  filterable
                  clearable
                  placeholder="选择一个店铺"
                  @update:model-value="setPoolShop(pool, $event)"
                >
                  <el-option
                    v-for="shop in shops"
                    :key="shop.id"
                    :value="shop.id"
                    :label="`${shop.name} · ${shop.site || shop.id}`"
                    :disabled="shopAssignedElsewhere(shop.id, pool.id)"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="该库存池包含的马帮来源仓库">
                <el-select v-model="pool.warehouseNames" multiple filterable collapse-tags :max-collapse-tags="3" placeholder="选择来源仓库">
                  <el-option
                    v-for="warehouse in warehouses"
                    :key="warehouse.name"
                    :value="warehouse.name"
                    :label="warehouse.loaded ? `${warehouse.name} · ${warehouse.rowCount} SKU · 可用 ${warehouse.availableQuantity.toLocaleString('zh-CN')}` : `${warehouse.name} · 本次未读取`"
                  />
                </el-select>
              </el-form-item>
            </div>
            <footer>
              <span>{{ pool.shopIds.length ? '1 家店铺独立使用' : '尚未选择店铺' }}</span>
              <span>{{ pool.warehouseNames.length }} 个绑定来源仓库</span>
              <strong v-if="pool.shopIds.length && pool.warehouseNames.length">绑定完整</strong>
              <strong v-else class="is-incomplete">待补充</strong>
            </footer>
          </article>
        </div>
      </div>
      <div class="scope-panel policy-panel">
        <header><div><span class="panel-kicker">POLICY V3</span><h3>库存池策略</h3></div><ShieldCheck :size="19" /></header>
        <el-form-item label="每个库存池的每个 SKU 保留安全库存"><el-input-number v-model="safetyStock" :min="0" :max="100000" controls-position="right" /></el-form-item>
        <el-form-item label="单个店铺变体库存上限"><el-input-number v-model="perListingCap" :min="1" :max="9999999" controls-position="right" /></el-form-item>
        <div class="active-policy">
          <span>在线多仓</span>
          <strong>{{ multiWarehouseModeLabels[multiWarehouseMode] }}</strong>
          <small>可从“库存同步设置”修改；生成计划后不可变更。</small>
        </div>
        <p>每家店在自己的仓库范围内按库存 SKU 单独计算；同名仓库可重复绑定，但店铺之间不合并范围、不参与彼此分配。</p>
        <el-button type="primary" :icon="Database" :loading="previewing" :disabled="continuousExecuting" @click="preview(1)">生成差异预览</el-button>
        <div v-if="previewing && previewProgress" class="prepare-progress preview-read-progress" role="status" aria-live="polite">
          <div><strong>{{ previewProgress.message }}</strong><span>{{ Math.round(previewProgress.percent) }}%</span></div>
          <el-progress :percentage="previewProgress.percent" :stroke-width="8" :show-text="false" />
          <div class="preview-progress-facts">
            <span v-if="previewProgress.totalCount">商品 {{ previewProgress.fetchedCount }}/{{ previewProgress.totalCount }}</span>
            <span v-if="previewProgress.pageCount">分页 {{ previewProgress.page }}/{{ previewProgress.pageCount }}</span>
            <span v-if="previewProgress.elapsedMs">耗时 {{ (previewProgress.elapsedMs / 1000).toFixed(1) }} 秒</span>
          </div>
        </div>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />

    <template v-if="plan">
      <section v-if="(plan.summary.productBatchCount || 1) > 1" class="continuous-plan-panel active-policy batch-policy">
        <span>安全分批</span>
        <strong>第 {{ plan.summary.productBatchNumber || 1 }}/{{ plan.summary.productBatchCount }} 批</strong>
        <small>全店 {{ plan.summary.totalProductCount || plan.summary.listingCount }} 个商品、{{ plan.summary.totalVariantCount || plan.summary.variantCount }} 个变体；其中 {{ plan.summary.totalReadyProductCount }} 个商品待写、{{ plan.summary.totalBlockedVariantCount || 0 }} 个变体阻断。每批最多 100 个商品且不超过 500 个待写变体，可逐批操作或一键连续处理。</small>
        <div v-if="continuousExecuting" class="continuous-batch-status" role="status" aria-live="polite">
          已完成 {{ continuousCompletedBatches }}/约 {{ continuousEstimatedBatches }} 批；当前批会完成提交和回读后再继续
        </div>
        <div class="batch-actions">
          <el-button size="small" :disabled="continuousExecuting || (plan.summary.productBatchNumber || 1) <= 1 || previewing" @click="preview((plan.summary.productBatchNumber || 1) - 1)">上一批</el-button>
          <el-button
            size="small"
            :disabled="continuousExecuting || (!continuingAfterSuccessfulBatch && (plan.summary.productBatchNumber || 1) >= (plan.summary.productBatchCount || 1)) || previewing || plan.state === 'IN_FLIGHT'"
            @click="previewNextBatch"
          >{{ continuingAfterSuccessfulBatch ? "处理剩余批次" : "下一批" }}</el-button>
          <el-button
            v-if="!continuousExecuting"
            type="primary"
            size="small"
            :icon="Play"
            :disabled="previewing || executing || !['PREVIEWED', 'APPROVED', 'SUCCEEDED', 'FAILED', 'EXPIRED'].includes(plan.state) || (plan.state === 'PREVIEWED' && !continuousApprovalMatches)"
            @click="startContinuousSync"
          >一键连续处理</el-button>
          <el-tag v-else type="primary" size="large">后台连续处理中，可安全关闭页面</el-tag>
        </div>
      </section>

      <section class="summary-strip">
        <div><span>有效库存池</span><strong>{{ plan.summary.inventoryPoolCount || plan.scope.inventoryPools?.length || 0 }}</strong><small v-if="plan.summary.skippedInventoryPoolCount">跳过 {{ plan.summary.skippedInventoryPoolCount }}</small></div>
        <div><span>待写变体</span><strong>{{ plan.summary.readyCount }}</strong></div>
        <div><span>库存已一致</span><strong>{{ plan.summary.unchangedCount }}</strong></div>
        <div><span>安全阻止</span><strong>{{ plan.summary.blockedCount }}</strong></div>
        <div><span>涉及商品</span><strong>{{ plan.summary.uniqueProductCount }}</strong></div>
        <div><span>计划状态</span><el-tag :type="stateType(plan.state)">{{ stateLabels[plan.state] || plan.state }}</el-tag></div>
      </section>

      <section class="plan-panel">
        <header><div><span class="panel-kicker">IMMUTABLE PLAN</span><h2>库存差异明细</h2></div><small>计划有效至 {{ formatTime(plan.expiresAt) }}</small></header>
        <div class="plan-shop-coverage" aria-label="计划店铺覆盖情况">
          <button
            type="button"
            class="plan-shop-card plan-shop-card-all"
            :class="{ 'is-active': !planShopFilter }"
            :aria-pressed="!planShopFilter"
            @click="selectPlanShop('')"
          >
            <span>全部店铺</span>
            <strong>{{ planShopSummaries.length }} 家 · {{ plan.items.length }} 行</strong>
          </button>
          <button
            v-for="shop in planShopSummaries"
            :key="shop.shopId"
            type="button"
            class="plan-shop-card"
            :class="{ 'is-active': planShopFilter === shop.shopId }"
            :aria-pressed="planShopFilter === shop.shopId"
            @click="selectPlanShop(shop.shopId)"
          >
            <span>{{ shop.shopName }}</span>
            <strong>{{ shop.total }} 行</strong>
            <small>待写 {{ shop.ready }} · 一致 {{ shop.unchanged }} · 阻断 {{ shop.blocked }}</small>
          </button>
        </div>
        <div class="plan-table-toolbar">
          <div>
            <strong>{{ planShopFilter ? planShopSummaries.find((shop) => shop.shopId === planShopFilter)?.shopName : '全部店铺' }}</strong>
            <span>筛选结果 {{ filteredPlanItems.length }} 行，计划共 {{ plan.items.length }} 行</span>
          </div>
          <div>
            <el-select v-model="planShopFilter" clearable placeholder="全部店铺" aria-label="按店铺筛选库存差异" style="width: 210px">
              <el-option v-for="shop in planShopSummaries" :key="shop.shopId" :value="shop.shopId" :label="`${shop.shopName} · ${shop.total} 行`" />
            </el-select>
            <el-select v-model="planStatusFilter" clearable placeholder="全部状态" aria-label="按状态筛选库存差异" style="width: 140px">
              <el-option value="READY" label="READY · 待写" />
              <el-option value="UNCHANGED" label="UNCHANGED · 已一致" />
              <el-option value="BLOCKED" label="BLOCKED · 阻断" />
            </el-select>
          </div>
        </div>
        <el-table :data="displayItems" :row-key="rowIdentity" max-height="560" stripe>
          <el-table-column prop="shopName" label="店铺" min-width="150" fixed />
          <el-table-column prop="inventoryPoolName" label="库存池" min-width="130" />
          <el-table-column prop="title" label="在线商品" min-width="220" show-overflow-tooltip />
          <el-table-column prop="sellerSku" label="Seller SKU" min-width="150" />
          <el-table-column prop="stockSku" label="库存 SKU" min-width="150" />
          <el-table-column prop="inventoryAvailable" label="仓库可用" width="100" align="right" />
          <el-table-column prop="sharedTargetCount" label="同SKU变体" width="96" align="right" />
          <el-table-column prop="currentStock" label="当前" width="82" align="right" />
          <el-table-column prop="targetStock" label="目标" width="82" align="right" />
          <el-table-column label="判断" min-width="170"><template #default="scope"><span>{{ reasonLabels[scope.row.reasonCode] || scope.row.reasonCode }}</span></template></el-table-column>
          <el-table-column label="状态" width="100" fixed="right"><template #default="scope"><el-tag size="small" :type="stateType(scope.row.status)">{{ scope.row.status }}</el-tag></template></el-table-column>
        </el-table>
        <div class="plan-table-footer">
          <span>第 {{ filteredPlanItems.length ? (planPage - 1) * planPageSize + 1 : 0 }}–{{ Math.min(planPage * planPageSize, filteredPlanItems.length) }} 行，共 {{ filteredPlanItems.length }} 行</span>
          <el-pagination
            v-model:current-page="planPage"
            v-model:page-size="planPageSize"
            :page-sizes="[50, 100, 200]"
            :total="filteredPlanItems.length"
            layout="sizes, prev, pager, next, jumper"
            background
          />
        </div>
      </section>

      <section v-if="rebindableCount || unmappedSkuCount || rebindPlan" class="rebind-panel">
        <header>
          <div>
            <span class="panel-kicker">SELLER SKU REBIND</span>
            <h2>普通 SKU 换绑</h2>
            <p>仅处理同产品键存在库存候选的普通 SKU；组合 SKU 不参与。换绑成功后需要重新生成库存预览。</p>
          </div>
          <el-button v-if="!rebindPlan" :loading="rebindBusy" :disabled="!['PREVIEWED', 'APPROVED'].includes(plan.state) || (!rebindableCount && !manualMappingLineCount)" @click="createRebindPlan">生成换绑预览（自动 {{ rebindableCount }} · 人工 {{ manualMappingLineCount }}）</el-button>
          <el-tag v-else :type="stateType(rebindPlan.state)">{{ stateLabels[rebindPlan.state] || rebindPlan.state }}</el-tag>
        </header>

        <div v-if="!rebindPlan && unmappedSkuCount" class="manual-mapping-box">
          <div>
            <strong>{{ unmappedSkuCount }} 个普通 Seller SKU 没有自动候选</strong>
            <p>从 Excel 复制两列粘贴到这里：第一列为当前 Seller SKU，第二列为目标库存 SKU。目标必须存在于当前所选仓库并高于安全库存。</p>
          </div>
          <el-input
            v-model="manualMappingText"
            type="textarea"
            :rows="6"
            resize="vertical"
            placeholder="当前 Seller SKU&#9;目标库存 SKU&#10;T3AA2123973&#9;T5AA3483973"
          />
          <small>支持 Tab、逗号、等号或箭头分隔；可以保留表头。系统不会接受组合 SKU、未知目标或同商品目标冲突。</small>
        </div>

        <template v-if="rebindPlan">
          <div class="rebind-summary">
            <span>候选 {{ rebindPlan.summary.candidateCount }}</span>
            <strong>可换绑 {{ rebindPlan.summary.readyCount }}</strong>
            <span>阻断 {{ rebindPlan.summary.blockedCount }}</span>
          </div>
          <el-table :data="rebindPlan.items" :row-key="rebindRowIdentity" max-height="360" size="small" stripe>
            <el-table-column prop="shopName" label="店铺" min-width="140" />
            <el-table-column prop="title" label="在线商品" min-width="210" show-overflow-tooltip />
            <el-table-column prop="fromSku" label="当前 Seller SKU" min-width="155" />
            <el-table-column prop="toSku" label="目标库存 SKU" min-width="155" />
            <el-table-column prop="targetAvailable" label="候选可用" width="95" align="right" />
            <el-table-column label="判断" min-width="170"><template #default="scope">{{ rebindReasonLabels[scope.row.reasonCode] || scope.row.reasonCode }}</template></el-table-column>
            <el-table-column label="状态" width="95"><template #default="scope"><el-tag size="small" :type="stateType(scope.row.status)">{{ scope.row.status }}</el-tag></template></el-table-column>
          </el-table>
          <div v-if="rebindPlan.state === 'PREVIEWED'" class="rebind-approval">
            <div><label>请输入换绑确认文本</label><el-input v-model="rebindApprovalInput" :placeholder="rebindApprovalText" /><small>必须完整输入：{{ rebindApprovalText }}</small></div>
            <el-button :disabled="!rebindApprovalMatches" :loading="rebindBusy" @click="approveRebindPlan">批准换绑计划</el-button>
          </div>
          <div v-else-if="rebindPlan.state === 'APPROVED'" class="rebind-approval">
            <p>执行时会重新检查库存快照、在线 Seller SKU 和同商品目标冲突。</p>
            <el-button type="danger" :loading="rebindBusy" @click="executeRebindPlan">执行普通 SKU 换绑</el-button>
          </div>
          <div v-if="rebindProgress && rebindProgress.stage !== 'IDLE'" class="rebind-progress" role="status" aria-live="polite" aria-atomic="true">
            <div class="progress-heading">
              <div>
                <span class="panel-kicker">LIVE EXECUTION</span>
                <strong>{{ rebindProgress.message }}</strong>
              </div>
              <span class="progress-percent">{{ Math.round(rebindProgress.percent) }}%</span>
            </div>
            <el-progress
              :percentage="Math.round(rebindProgress.percent)"
              :status="rebindProgressStatus"
              :stroke-width="10"
              :show-text="false"
              striped
              :striped-flow="!rebindProgress.terminal"
            />
            <ol class="progress-stages" aria-label="换绑执行阶段">
              <li v-for="stage in rebindStages" :key="stage.key" :class="`is-${rebindStageState(stage.key)}`">
                <span class="stage-dot" aria-hidden="true"></span>
                <span>{{ stage.label }}</span>
                <small>{{ rebindStageState(stage.key) === 'done' ? '已完成' : rebindStageState(stage.key) === 'active' ? '进行中' : rebindStageState(stage.key) === 'failed' ? '停在此处' : '等待' }}</small>
              </li>
            </ol>
            <div class="progress-facts">
              <span>已处理 <strong>{{ rebindProgress.processedCount }}/{{ rebindProgress.totalCount }}</strong></span>
              <span>成功 <strong>{{ rebindProgress.successfulCount }}</strong></span>
              <span>失败 <strong>{{ rebindProgress.failedCount }}</strong></span>
              <span v-if="rebindProgress.jobId">任务 <code>{{ rebindProgress.jobId }}</code></span>
              <span>更新于 {{ formatTime(rebindProgress.updatedAt) }}</span>
            </div>
          </div>
          <div v-if="rebindPlan.result?.verification" class="rebind-verification">
            <el-alert
              :type="rebindPlan.result.verification.failedCount === 0 ? 'success' : 'error'"
              :closable="false"
              show-icon
              :title="`在线回读验证：${rebindPlan.result.verification.verifiedCount}/${rebindPlan.result.verification.totalCount} 项一致`"
            />
            <el-table :data="rebindPlan.result.verification.rows" max-height="360" size="small" stripe>
              <el-table-column prop="shopName" label="店铺" min-width="140" />
              <el-table-column prop="internalId" label="商品 ID" min-width="120" />
              <el-table-column prop="fromSku" label="原 Seller SKU" min-width="150" />
              <el-table-column prop="toSku" label="目标 Seller SKU" min-width="150" />
              <el-table-column prop="observedSku" label="实际回读 SKU" min-width="150" />
              <el-table-column label="验证" width="100"><template #default="scope"><el-tag size="small" :type="scope.row.status === 'VERIFIED' ? 'success' : 'danger'">{{ scope.row.status === 'VERIFIED' ? '一致' : '不一致' }}</el-tag></template></el-table-column>
            </el-table>
          </div>
        </template>
      </section>

      <section class="approval-panel">
        <div><span class="panel-kicker">APPROVAL</span><h3>人工确认与执行</h3><p>预览和批准都不会写库存；只有“执行库存同步”会提交马帮写请求。</p></div>
        <div v-if="plan.state === 'PREVIEWED'" class="approval-input">
          <label>请输入确认文本</label>
          <el-input
            v-model="approvalInput"
            :placeholder="(plan.summary.productBatchCount || 1) > 1 ? continuousApprovalText : requiredApprovalText"
          />
          <small v-if="(plan.summary.productBatchCount || 1) > 1">连续处理必须完整输入：{{ continuousApprovalText }}</small>
          <small>仅批准当前批必须完整输入：{{ requiredApprovalText }}</small>
        </div>
        <el-button
          v-if="plan.state === 'PREVIEWED' && (plan.summary.productBatchCount || 1) > 1"
          type="primary" :icon="Play" :disabled="!continuousApprovalMatches || continuousExecuting" @click="startContinuousSync"
        >一键连续处理全部批次</el-button>
        <el-button v-else-if="plan.state === 'PREVIEWED'" :icon="CheckCircle2" :disabled="!approvable || continuousExecuting" :loading="approving" @click="approve">批准当前计划</el-button>
        <el-button
          v-else-if="plan.state === 'APPROVED' && (plan.summary.productBatchCount || 1) > 1"
          type="primary" :icon="Play" :disabled="continuousExecuting" @click="startContinuousSync"
        >一键连续处理全部批次</el-button>
        <el-button v-else-if="plan.state === 'APPROVED'" type="primary" :icon="Play" :disabled="!executable || continuousExecuting" :loading="executing" @click="execute">执行库存同步</el-button>
        <el-button
          v-else-if="['FAILED', 'SUCCEEDED', 'EXPIRED'].includes(plan.state) && (plan.summary.productBatchCount || 1) > 1"
          type="primary" :icon="Play" :disabled="continuousExecuting" @click="startContinuousSync"
        >一键连续处理剩余批次</el-button>
        <el-tag v-else :type="stateType(plan.state)" size="large">{{ stateLabels[plan.state] || plan.state }}</el-tag>
      </section>

      <section v-if="inventoryProgress && inventoryProgress.stage !== 'IDLE'" class="rebind-progress inventory-live-progress" role="status" aria-live="polite" aria-atomic="true">
        <div class="progress-heading">
          <div>
            <span class="panel-kicker">LIVE INVENTORY SYNC</span>
            <strong>{{ inventoryProgress.message }}</strong>
          </div>
          <span class="progress-percent">{{ Math.round(inventoryProgress.percent) }}%</span>
        </div>
        <el-progress
          :percentage="Math.round(inventoryProgress.percent)"
          :status="inventoryProgressStatus"
          :stroke-width="10"
          :show-text="false"
          striped
          :striped-flow="!inventoryProgress.terminal"
        />
        <ol class="progress-stages inventory-progress-stages" aria-label="库存同步执行阶段">
          <li v-for="stage in inventoryStages" :key="stage.key" :class="`is-${inventoryStageState(stage.key)}`">
            <span class="stage-dot" aria-hidden="true"></span>
            <span>{{ stage.label }}</span>
            <small>{{ inventoryStageState(stage.key) === 'done' ? '已完成' : inventoryStageState(stage.key) === 'active' ? '进行中' : inventoryStageState(stage.key) === 'failed' ? '停在此处' : '等待' }}</small>
          </li>
        </ol>
        <div class="progress-facts">
          <span>已处理 <strong>{{ inventoryProgress.processedCount }}/{{ inventoryProgress.totalCount }}</strong></span>
          <span>成功 <strong>{{ inventoryProgress.successfulCount }}</strong></span>
          <span v-if="inventoryProgress.adjustedCount">自动重算 <strong>{{ inventoryProgress.adjustedCount }}</strong></span>
          <span v-if="inventoryProgress.skippedCount">安全跳过 <strong>{{ inventoryProgress.skippedCount }}</strong></span>
          <span>失败 <strong>{{ inventoryProgress.failedCount }}</strong></span>
          <span v-if="inventoryProgress.jobId">任务 <code>{{ inventoryProgress.jobId }}</code></span>
          <span>更新于 {{ formatTime(inventoryProgress.updatedAt) }}</span>
        </div>
      </section>
    </template>

    <section v-if="continuousExceptions.length" class="exception-pool-panel">
      <header>
        <div>
          <span class="panel-kicker">REPAIR QUEUE</span>
          <h2>库存待修复池</h2>
          <p>可匹配商品已继续处理；这里集中保留未匹配、执行失败和安全跳过的记录。修复后重新读取并生成差异预览，只会补同步仍有差异的商品。</p>
        </div>
        <el-button @click="copyContinuousExceptions">复制异常清单（{{ continuousExceptions.length }}）</el-button>
      </header>
      <el-table :data="continuousExceptions" row-key="key" max-height="520" size="small" stripe>
        <el-table-column prop="source" label="来源" width="92">
          <template #default="scope"><el-tag size="small" :type="scope.row.source === '匹配阻断' ? 'warning' : 'danger'">{{ scope.row.source }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="batch" label="批次" width="68" align="right" />
        <el-table-column prop="shopName" label="店铺" min-width="150" show-overflow-tooltip />
        <el-table-column prop="internalId" label="商品 ID" min-width="125" />
        <el-table-column prop="sellerSku" label="Seller SKU" min-width="145" />
        <el-table-column prop="title" label="商品" min-width="220" show-overflow-tooltip />
        <el-table-column prop="message" label="待修复原因" min-width="340" show-overflow-tooltip />
      </el-table>
    </section>

    <section v-if="history.length" class="history-panel">
      <header><div><span class="panel-kicker">RECENT RUNS</span><h2>最近库存计划</h2></div><el-button text :icon="RefreshCw" @click="refreshStatus">刷新</el-button></header>
      <el-table :data="history" size="small">
        <el-table-column prop="createdAt" label="创建时间" min-width="170"><template #default="scope">{{ formatTime(scope.row.createdAt) }}</template></el-table-column>
        <el-table-column label="平台" width="90"><template #default="scope"><el-tag size="small" :type="(scope.row.scope.platform || 'shopee') === 'lazada' ? 'warning' : 'primary'">{{ (scope.row.scope.platform || 'shopee') === 'lazada' ? 'Lazada' : 'Shopee' }}</el-tag></template></el-table-column>
        <el-table-column label="类型" width="100"><template #default="scope">{{ operationLabel(scope.row) }}</template></el-table-column>
        <el-table-column label="范围" min-width="220"><template #default="scope">{{ scope.row.scope.inventoryPools?.length || 1 }} 库存池 · {{ scope.row.scope.shopIds.length }} 店铺 · {{ scope.row.scope.warehouseNames.length }} 仓库</template></el-table-column>
        <el-table-column label="变更" width="90" align="right"><template #default="scope">{{ scope.row.summary.readyCount }}</template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="scope"><el-tag size="small" :type="stateType(scope.row.state)">{{ stateLabels[scope.row.state] || scope.row.state }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button text type="primary" :loading="openingPlanId === scope.row.id" @click="openHistoryPlan(scope.row)">打开</el-button></template></el-table-column>
      </el-table>
    </section>
  </main>
</template>

<style scoped>
.inventory-sync-page { display: grid; gap: 14px; }
.sync-command-panel,.scope-panel,.pool-editor,.plan-panel,.rebind-panel,.approval-panel,.exception-pool-panel,.history-panel,.lazada-run-monitor { border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); }
.lazada-run-monitor { display: grid; gap: 12px; padding: 15px 16px; border-left: 3px solid var(--ops-primary); }.lazada-run-monitor.is-failed { border-left-color: var(--el-color-danger); }.lazada-run-monitor.is-stalled,.lazada-run-monitor.is-partial { border-left-color: var(--el-color-warning); }.lazada-run-monitor.is-succeeded,.lazada-run-monitor.is-no_changes { border-left-color: var(--el-color-success); }.lazada-run-monitor header,.monitor-title,.monitor-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }.monitor-title { justify-content: flex-start; }.monitor-title > svg { color: var(--ops-primary); }.monitor-title h2 { margin: 2px 0 0; font-size: 15px; }.monitor-primary { display: grid; grid-template-columns: minmax(120px,auto) minmax(0,1fr); gap: 12px; align-items: baseline; padding: 10px 12px; border-radius: 6px; background: var(--ops-surface-muted); }.monitor-primary strong { font-size: 13px; }.monitor-primary span,.monitor-facts,.monitor-empty,.monitor-problem-details { color: var(--ops-text-secondary); font-size: 11px; }.monitor-facts { display: flex; flex-wrap: wrap; gap: 7px 18px; font-variant-numeric: tabular-nums; }.monitor-empty { margin: 0; }.monitor-problem-details { max-height: 150px; margin: 0; overflow: auto; line-height: 1.55; }
.sync-command-panel,.pool-editor,.plan-panel,.rebind-panel,.exception-pool-panel,.history-panel { padding: 16px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
header h2,header h3,.approval-panel h3 { margin: 3px 0 0; }.panel-kicker { color: var(--ops-primary); font-size: 10px; font-weight: 750; letter-spacing: .11em; }
.source-grid { display: grid; grid-template-columns: minmax(240px,1.3fr) repeat(2,minmax(190px,1fr)); gap: 12px; margin-top: 14px; }.source-grid :deep(.el-form-item) { margin: 0; }.source-grid :deep(.el-select) { width: 100%; }
.snapshot-fact { display: grid; gap: 4px; padding: 10px 12px; border-left: 2px solid var(--ops-border-light); }.snapshot-fact span,.snapshot-fact small,.scope-panel header > span,.plan-panel header small,.table-note { color: var(--ops-text-secondary); font-size: 11px; }.snapshot-fact strong { font-size: 13px; }
.prepare-progress { display: grid; gap: 8px; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface-soft); }.prepare-progress > div { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; }.prepare-progress span { color: var(--ops-text-secondary); font-variant-numeric: tabular-nums; }
.preview-read-progress { width: 100%; margin-top: 4px; }.preview-progress-facts { justify-content: flex-start !important; flex-wrap: wrap; gap: 6px 14px !important; font-size: 10px !important; }
.batch-policy { align-items: start; }.batch-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }.continuous-batch-status { width: 100%; padding: 7px 8px; border-radius: 5px; background: color-mix(in srgb, var(--el-color-primary) 9%, transparent); color: var(--ops-text-primary); font-size: 10px; line-height: 1.45; }
.scope-panel { min-width: 0; padding: 14px; }.policy-panel { display: grid; align-content: start; gap: 8px; }.policy-panel :deep(.el-form-item) { display: grid; grid-template-columns: minmax(0,1fr); gap: 6px; min-width: 0; margin-bottom: 4px; }.policy-panel :deep(.el-form-item__label) { justify-content: flex-start; width: auto; height: auto; padding: 0; line-height: 1.45; white-space: normal; }.policy-panel :deep(.el-form-item__content) { min-width: 0; margin-left: 0 !important; }.policy-panel :deep(.el-input-number) { width: 100%; max-width: 100%; }.policy-panel p,.approval-panel p { margin: 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.55; }
.pool-workspace { display: grid; grid-template-columns: minmax(0,1fr) minmax(270px,320px); align-items: start; gap: 12px; }.pool-editor-header > div:first-child { max-width: 720px; }.pool-editor-header p { margin: 5px 0 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.55; }.pool-editor-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }.pool-editor-actions > span { color: var(--ops-text-secondary); font-size: 10px; }.pool-list { display: grid; gap: 9px; margin-top: 14px; }.pool-card { padding: 12px; border: 1px solid var(--ops-border-light); border-radius: 7px; background: var(--ops-surface-muted); }.pool-card > header { align-items: center; }.pool-title { display: flex; align-items: center; gap: 8px; width: min(420px,100%); }.pool-title > span { color: var(--ops-primary); font-size: 11px; font-weight: 750; font-variant-numeric: tabular-nums; }.pool-title :deep(.el-input__wrapper) { background: var(--ops-surface); }.pool-binding-grid { display: grid; grid-template-columns: 1fr 1.25fr; gap: 10px; margin-top: 10px; }.pool-binding-grid :deep(.el-form-item) { min-width: 0; margin: 0; }.pool-binding-grid :deep(.el-form-item__label) { color: var(--ops-text-secondary); font-size: 11px; }.pool-binding-grid :deep(.el-select) { width: 100%; }.pool-card > footer { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 9px; color: var(--ops-text-secondary); font-size: 10px; }.pool-card > footer strong { margin-left: auto; color: var(--el-color-success); }.pool-card > footer .is-incomplete { color: var(--el-color-warning); }
.command-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }.settings-dialog-body,.settings-intro { display: grid; gap: 8px; }.settings-intro strong { color: var(--ops-text-primary); font-size: 15px; }.settings-intro p { margin: 0 0 4px; color: var(--ops-text-secondary); font-size: 12px; line-height: 1.6; }.strategy-list { display: grid; gap: 7px; }.strategy-list :deep(.el-radio) { width: 100%; height: auto; min-height: 56px; margin: 0; padding: 10px 11px; border: 1px solid var(--ops-border-light); border-radius: 6px; align-items: flex-start; cursor: pointer; transition: border-color .18s ease, background-color .18s ease; }.strategy-list :deep(.el-radio.is-checked) { border-color: var(--el-color-primary); background: color-mix(in srgb, var(--el-color-primary) 7%, transparent); }.strategy-list :deep(.el-radio__input) { margin-top: 2px; }.strategy-list :deep(.el-radio__label) { display: grid; gap: 3px; min-width: 0; white-space: normal; }.strategy-list strong { color: var(--ops-text-primary); font-size: 12px; }.strategy-list small { color: var(--ops-text-secondary); font-size: 11px; line-height: 1.45; }.active-policy { display: grid; gap: 2px; padding: 9px 10px; border: 1px solid var(--ops-border-light); border-radius: 6px; background: var(--ops-surface-muted); }.active-policy span,.active-policy small { color: var(--ops-text-secondary); font-size: 10px; }.active-policy strong { color: var(--ops-text-primary); font-size: 12px; }
.config-import-dialog { display: grid; gap: 12px; }.config-import-summary { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); border: 1px solid var(--ops-border-light); border-radius: 7px; background: var(--ops-surface-muted); }.config-import-summary > div { display: grid; gap: 4px; min-width: 0; padding: 10px 12px; border-right: 1px solid var(--ops-border-light); }.config-import-summary > div:last-child { border-right: 0; }.config-import-summary span { color: var(--ops-text-secondary); font-size: 10px; }.config-import-summary strong { overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }.config-import-result { display: flex; align-items: flex-start; gap: 7px; font-size: 11px; line-height: 1.45; }.config-import-result .el-tag { flex: 0 0 auto; }.config-import-result .is-error { color: var(--el-color-danger); }.config-import-result .is-warning { color: var(--el-color-warning-dark-2); }
.summary-strip { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); }.summary-strip > div { display: grid; gap: 5px; min-height: 74px; align-content: center; padding: 12px 16px; border-right: 1px solid var(--ops-border-light); }.summary-strip > div:last-child { border-right: 0; }.summary-strip span { color: var(--ops-text-secondary); font-size: 11px; }.summary-strip strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.plan-panel { padding-bottom: 12px; }.plan-shop-coverage { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 8px; margin-top: 14px; }.plan-shop-card { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 3px 10px; min-width: 0; padding: 10px 11px; border: 1px solid var(--ops-border-light); border-radius: 7px; color: var(--ops-text-primary); background: var(--ops-surface-muted); font: inherit; text-align: left; cursor: pointer; transition: border-color .18s ease,background-color .18s ease,box-shadow .18s ease; }.plan-shop-card:hover { border-color: color-mix(in srgb,var(--ops-primary) 42%,var(--ops-border-light)); }.plan-shop-card:focus-visible { outline: 2px solid var(--ops-primary); outline-offset: 2px; }.plan-shop-card.is-active { border-color: var(--ops-primary); background: color-mix(in srgb,var(--ops-primary) 6%,var(--ops-surface)); box-shadow: inset 3px 0 0 var(--ops-primary); }.plan-shop-card span { min-width: 0; overflow: hidden; font-size: 12px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }.plan-shop-card strong { color: var(--ops-text-primary); font-size: 12px; font-variant-numeric: tabular-nums; }.plan-shop-card small { grid-column: 1 / -1; color: var(--ops-text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; }.plan-shop-card-all { align-content: center; }.plan-table-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-top: 12px; }.plan-table-toolbar > div:first-child { display: grid; gap: 3px; }.plan-table-toolbar > div:first-child strong { font-size: 13px; }.plan-table-toolbar > div:first-child span,.plan-table-footer > span { color: var(--ops-text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; }.plan-table-toolbar > div:last-child { display: flex; gap: 8px; }.plan-panel :deep(.el-table) { margin-top: 10px; }.plan-table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding-top: 10px; }.table-note { margin: 8px 0 0; }
.rebind-panel header p { max-width: 720px; margin: 5px 0 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.5; }.rebind-summary { display: flex; gap: 18px; margin: 14px 0 8px; color: var(--ops-text-secondary); font-size: 12px; }.rebind-summary strong { color: var(--ops-text); }.rebind-approval { display: flex; align-items: end; justify-content: flex-end; gap: 14px; margin-top: 14px; }.rebind-approval > div { display: grid; gap: 5px; width: min(440px,100%); }.rebind-approval label { font-size: 12px; font-weight: 650; }.rebind-approval small { color: var(--ops-text-secondary); font-size: 10px; }
.rebind-progress { display: grid; gap: 12px; margin-top: 14px; padding: 14px; border: 1px solid color-mix(in srgb,var(--ops-primary) 24%,var(--ops-border-light)); border-radius: 7px; background: color-mix(in srgb,var(--ops-primary) 4%,var(--ops-surface)); }.progress-heading { display: flex; align-items: start; justify-content: space-between; gap: 16px; }.progress-heading > div { display: grid; gap: 4px; }.progress-heading strong { font-size: 13px; line-height: 1.45; }.progress-percent { color: var(--ops-primary); font-size: 20px; font-weight: 750; font-variant-numeric: tabular-nums; }.progress-stages { display: grid; grid-template-columns: repeat(5,1fr); gap: 8px; margin: 0; padding: 0; list-style: none; }.progress-stages li { display: grid; grid-template-columns: 10px 1fr; column-gap: 6px; align-items: center; min-width: 0; color: var(--ops-text-secondary); font-size: 11px; }.progress-stages small { grid-column: 2; color: var(--ops-text-secondary); font-size: 9px; }.stage-dot { width: 8px; height: 8px; border: 1px solid var(--ops-border); border-radius: 50%; background: var(--ops-surface); }.progress-stages .is-active { color: var(--ops-primary); font-weight: 700; }.progress-stages .is-active .stage-dot { border-color: var(--ops-primary); background: var(--ops-primary); box-shadow: 0 0 0 3px color-mix(in srgb,var(--ops-primary) 16%,transparent); }.progress-stages .is-done { color: var(--ops-text); }.progress-stages .is-done .stage-dot { border-color: var(--el-color-success); background: var(--el-color-success); }.progress-stages .is-failed { color: var(--el-color-danger); font-weight: 700; }.progress-stages .is-failed .stage-dot { border-color: var(--el-color-danger); background: var(--el-color-danger); }.progress-facts { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--ops-text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; }.progress-facts strong { color: var(--ops-text); }.progress-facts code { color: var(--ops-text); font-size: 10px; }
.inventory-live-progress { margin-top: 0; }.inventory-progress-stages { grid-template-columns: repeat(4,1fr); }
.manual-mapping-box { display: grid; gap: 9px; margin-top: 14px; padding: 13px; border: 1px solid var(--ops-border-light); border-radius: 7px; background: var(--ops-surface-muted); }.manual-mapping-box strong { font-size: 13px; }.manual-mapping-box p,.manual-mapping-box small { margin: 3px 0 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.5; }.manual-mapping-box :deep(textarea) { font-family: ui-monospace,SFMono-Regular,Consolas,monospace; font-size: 12px; }
.rebind-verification { display: grid; gap: 10px; margin-top: 14px; }
.approval-panel { display: grid; grid-template-columns: minmax(240px,1fr) minmax(260px,1fr) auto; align-items: end; gap: 16px; padding: 16px; }.approval-input { display: grid; gap: 5px; }.approval-input label { font-size: 12px; font-weight: 650; }.approval-input small { color: var(--ops-text-secondary); font-size: 10px; }.approval-panel > .el-button { min-height: 40px; }
.history-panel :deep(.el-table) { margin-top: 12px; }
.exception-pool-panel { border-color: color-mix(in srgb,var(--el-color-warning) 38%,var(--ops-border-light)); }.exception-pool-panel header p { max-width: 780px; margin: 5px 0 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.55; }.exception-pool-panel :deep(.el-table) { margin-top: 12px; }
@media (max-width: 1080px) { .pool-workspace { grid-template-columns: 1fr; }.approval-panel { grid-template-columns: 1fr 1fr; }.approval-panel > .el-button,.approval-panel > .el-tag { grid-column: 2; justify-self: end; }.summary-strip { grid-template-columns: repeat(3,1fr); } }
@media (max-width: 700px) { .source-grid,.approval-panel,.pool-binding-grid { grid-template-columns: 1fr; }.approval-panel > .el-button,.approval-panel > .el-tag { grid-column: auto; justify-self: stretch; }.summary-strip { grid-template-columns: repeat(2,1fr); }.summary-strip > div { border-bottom: 1px solid var(--ops-border-light); }.config-import-summary { grid-template-columns: repeat(2,minmax(0,1fr)); }.config-import-summary > div { border-bottom: 1px solid var(--ops-border-light); }.sync-command-panel,.pool-editor,.plan-panel,.rebind-panel,.history-panel { padding: 12px; }.lazada-run-monitor header,.monitor-primary { align-items: stretch; grid-template-columns: 1fr; flex-direction: column; }.monitor-actions { width: 100%; }.pool-editor-header,.pool-card > header { flex-direction: column; align-items: stretch; }.pool-editor-actions { justify-content: stretch; }.pool-editor-actions :deep(.el-upload),.pool-editor-actions .el-button { width: 100%; min-height: 44px; flex: 1; }.command-actions { width: 100%; justify-content: stretch; }.command-actions .el-button { flex: 1; min-height: 44px; margin: 0; }.plan-shop-coverage { grid-template-columns: 1fr; }.plan-shop-card { min-height: 54px; }.plan-table-toolbar,.plan-table-toolbar > div:last-child,.plan-table-footer { align-items: stretch; flex-direction: column; }.plan-table-toolbar :deep(.el-select) { width: 100% !important; }.plan-table-footer :deep(.el-pagination) { justify-content: center; overflow-x: auto; }.rebind-approval { align-items: stretch; flex-direction: column; }.progress-stages { grid-template-columns: 1fr 1fr; }.progress-heading { gap: 8px; } }
@media (prefers-reduced-motion: reduce) { .rebind-progress :deep(.el-progress-bar__inner) { transition: none !important; } }
</style>
