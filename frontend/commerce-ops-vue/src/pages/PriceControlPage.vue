<script setup lang="ts">
import { ArrowDown, ArrowUp, CheckCircle2, CircleDollarSign, Clipboard, Database, MessageSquareText, RefreshCw, Search, ShieldCheck, Store, TriangleAlert } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  loadPriceChanges,
  loadPriceChangeRounds,
  loadCurrentPrices,
  loadPriceControlOverview,
  loadPriceControlAutomation,
  loadPriceControlRuns,
  loadPriceControlStatus,
  runPriceControlSync,
  savePriceControlAutomation,
  copyPriceChangeRound,
  updatePriceChangeAdjustment,
  loadPriceControlShops,
  createPriceControlRepricingPreview,
  confirmPriceControlRepricingPlan,
  refreshPriceControlRepricingPlan,
  type CommerceShop,
  type PriceChange,
  type PriceChangeRound,
  type PriceControlAutomation,
  type CurrentPrice,
  type PriceControlOverview,
  type PriceControlRun,
  type PriceControlStatus,
  type PriceControlRepricingPlan,
} from "@/services/price-control";
import { saveDingtalkConfig, testDingtalkConfig } from "@/services/sales-automation";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const route = useRoute();
const router = useRouter();
const loading = ref(false);
const syncing = ref(false);
const probing = ref(false);
const error = ref("");
const status = ref<PriceControlStatus | null>(null);
const overview = ref<PriceControlOverview>({
  totalChanges: 0, upCount: 0, downCount: 0, affectedSkuCount: 0,
  latestDetectedAt: null, currentPriceCount: 0, currentSkuCount: 0, latestEffectiveAt: null,
  filters: { countries: [], categories: [], batches: [] },
});
const changes = ref<PriceChange[]>([]);
const currentPrices = ref<CurrentPrice[]>([]);
const runs = ref<PriceControlRun[]>([]);
const changeRounds = ref<PriceChangeRound[]>([]);
const roundSelectionInitialized = ref(false);
const roundCopying = ref(false);
const viewMode = ref<"current" | "changes">("changes");
const total = ref(0);
const detailVisible = ref(false);
const detail = ref<PriceChange | null>(null);
const selectedChanges = ref<PriceChange[]>([]);
const repricingDialogOpen = ref(false);
const repricingStep = ref<"shops" | "preview" | "execution">("shops");
const repricingLoading = ref(false);
const repricingPlan = ref<PriceControlRepricingPlan | null>(null);
const repricingShops = ref<Record<string, CommerceShop[]>>({});
const repricingAssignments = ref<Record<string, string[]>>({});
const repricingSelectedItemIds = ref<string[]>([]);
const repricingConfirmationText = ref("");
const repricingUnknownAcknowledged = ref(false);
let repricingPollTimer: ReturnType<typeof setTimeout> | null = null;
const adjustmentDialogOpen = ref(false);
const adjustmentSaving = ref(false);
const adjustmentTarget = ref<PriceChange | null>(null);
const adjustmentForm = reactive({
  status: "UNADJUSTED" as "UNADJUSTED" | "ADJUSTED",
  remark: "",
});
const automationDrawerOpen = ref(false);
const automationSaving = ref(false);
const robotDialogOpen = ref(false);
const robotSaving = ref(false);
const automation = ref<PriceControlAutomation>({
  ready: false,
  settings: null,
  robots: [],
  defaults: { intervalMinutes: 60, minimumIntervalMinutes: 15 },
});
const automationForm = reactive({
  enabled: false,
  intervalMinutes: 60,
  dingtalkConfigId: "",
  notifyOnChange: true,
  notifyOnFailure: true,
});
const robotForm = reactive({
  name: "",
  webhookUrl: "",
  secret: "",
  atMobiles: "",
  atAll: false,
});
const query = reactive({
  page: 1, page_size: 50, country: "", category: "", sku: "", platform: "",
  shop_type: "", price_type: "", direction: "", apply_no: "", sync_run_id: "", adjustment_status: "",
});

const demoMode = computed(() => route.query.demo === "1");
const canSync = computed(() => Boolean(!demoMode.value && status.value?.schemaReady && status.value?.sourceConfigured && status.value?.manualSyncEnabled));
const latestRun = computed(() => runs.value[0] || null);
const selectedRound = computed(() => changeRounds.value.find((item) => item.id === query.sync_run_id) || null);
const roundQuickFilter = computed<"current" | "previous" | "history">(() => {
  if (query.sync_run_id && query.sync_run_id === changeRounds.value[0]?.id) return "current";
  if (query.sync_run_id && query.sync_run_id === changeRounds.value[1]?.id) return "previous";
  return "history";
});
const canCreateRepricingPreview = computed(() => Boolean(
  !demoMode.value
  && status.value?.repricing?.workflowReady
  && selectedChanges.value.length
  && selectedChanges.value.length <= 25
  && selectedRound.value?.id === changeRounds.value[0]?.id
  && selectedChanges.value.every((item) => item.adjustmentStatus === "UNADJUSTED"
    && item.platform !== "TIKTOK" && item.priceType !== "MEGA_CAMPAIGN" && item.newPrice !== null),
));
const repricingSelectableItemIds = computed(() =>
  repricingPlan.value?.items.filter((item) => item.status === "PREVIEWED").map((item) => item.id) || [],
);
const repricingAllItemsSelected = computed(() => Boolean(
  repricingSelectableItemIds.value.length
  && repricingSelectableItemIds.value.every((id) => repricingSelectedItemIds.value.includes(id)),
));
const repricingSelectionIndeterminate = computed(() => Boolean(
  repricingSelectedItemIds.value.length && !repricingAllItemsSelected.value,
));
const repricingHasUnknownShopTypes = computed(() => Boolean(
  repricingPlan.value?.items.some((item) =>
    item.controlShopType === "UNKNOWN" && repricingSelectedItemIds.value.includes(item.id)),
));
const repricingCanConfirm = computed(() => Boolean(
  repricingSelectedItemIds.value.length
  && repricingConfirmationText.value === "确认同步到店铺"
  && (!repricingHasUnknownShopTypes.value || repricingUnknownAcknowledged.value),
));
const repricingIsTerminal = computed(() => Boolean(
  repricingPlan.value && ["SUCCEEDED", "PARTIAL", "FAILED", "EXPIRED", "CANCELLED"].includes(repricingPlan.value.status),
));

watch(repricingSelectedItemIds, (current, previous) => {
  if (repricingStep.value !== "preview" || current.join("\u001f") === previous.join("\u001f")) return;
  repricingConfirmationText.value = "";
  repricingUnknownAcknowledged.value = false;
}, { deep: true });

const platformLabels: Record<string, string> = { LAZADA: "Lazada", SHOPEE: "Shopee", TIKTOK: "TikTok Shop" };
const shopLabels: Record<string, string> = { STANDARD: "标准店", MALL: "Mall 店" };
const priceTypeLabels: Record<string, string> = { REGULAR: "日常价", CAMPAIGN: "活动价", MEGA_CAMPAIGN: "大促价" };
const directionLabels: Record<string, string> = { UP: "上涨", DOWN: "下调", NEW: "新增", REMOVED: "移除" };

const mockDetectedAt = "2026-08-05T10:10:00.000Z";
const mockChanges: PriceChange[] = [
  {
    id: "mock-change-th-001", syncRunId: "mock-run-20260805", sourceApplyNo: "MOCK-TH-20260805-01",
    priceKey: "TH|TH-PHONE-001|SHOPEE|STANDARD|REGULAR", countryCode: "TH", categoryName: "手机配件",
    sku: "TH-PHONE-001", productNameCn: "磁吸无线充电器", platform: "SHOPEE", shopType: "STANDARD", priceType: "REGULAR",
    oldPrice: "299.00", newPrice: "319.00", deltaValue: "20.00", deltaPercent: 6.68, direction: "UP",
    changeText: "国家：TH；类目：手机配件；SKU：TH-PHONE-001；商品中文名：磁吸无线充电器；平台：Shopee；店铺类型：标准店；价格类型：日常价；从原价 299.00 变更到现价 319.00，上涨 20.00（6.68%）。",
    foundationTaskId: "mock-task-th-001", validityStatus: "VALID", invalidReason: null, invalidatedAt: null, invalidatedBy: null,
    adjustmentStatus: "UNADJUSTED", adjustmentRemark: null, adjustmentUpdatedAt: null, adjustmentUpdatedBy: null, detectedAt: mockDetectedAt,
  },
  {
    id: "mock-change-my-002", syncRunId: "mock-run-20260805", sourceApplyNo: "MOCK-MY-20260805-02",
    priceKey: "MY|MY-HOME-018|LAZADA|MALL|CAMPAIGN", countryCode: "MY", categoryName: "家居收纳",
    sku: "MY-HOME-018", productNameCn: "折叠衣物收纳箱", platform: "LAZADA", shopType: "MALL", priceType: "CAMPAIGN",
    oldPrice: "49.90", newPrice: "45.90", deltaValue: "-4.00", deltaPercent: -8.02, direction: "DOWN",
    changeText: "国家：MY；类目：家居收纳；SKU：MY-HOME-018；商品中文名：折叠衣物收纳箱；平台：Lazada；店铺类型：Mall 店；价格类型：活动价；从原价 49.90 变更到现价 45.90，下调 4.00（8.02%）。",
    foundationTaskId: "mock-task-my-002", validityStatus: "VALID", invalidReason: null, invalidatedAt: null, invalidatedBy: null,
    adjustmentStatus: "ADJUSTED", adjustmentRemark: "已在马帮调整", adjustmentUpdatedAt: mockDetectedAt, adjustmentUpdatedBy: "演示用户", detectedAt: mockDetectedAt,
  },
  {
    id: "mock-change-ph-003", syncRunId: "mock-run-20260805", sourceApplyNo: "MOCK-PH-20260805-03",
    priceKey: "PH|PH-BEAUTY-036|TIKTOK|STANDARD|REGULAR", countryCode: "PH", categoryName: "美容工具",
    sku: "PH-BEAUTY-036", productNameCn: "便携电动洁面仪", platform: "TIKTOK", shopType: "STANDARD", priceType: "REGULAR",
    oldPrice: null, newPrice: "189.00", deltaValue: null, deltaPercent: null, direction: "NEW",
    changeText: "国家：PH；类目：美容工具；SKU：PH-BEAUTY-036；商品中文名：便携电动洁面仪；平台：TikTok Shop；店铺类型：标准店；价格类型：日常价；从原价 无价格 变更到现价 189.00，新增。",
    foundationTaskId: "mock-task-ph-003", validityStatus: "VALID", invalidReason: null, invalidatedAt: null, invalidatedBy: null,
    adjustmentStatus: "UNADJUSTED", adjustmentRemark: null, adjustmentUpdatedAt: null, adjustmentUpdatedBy: null, detectedAt: mockDetectedAt,
  },
  {
    id: "mock-change-vn-004", syncRunId: "mock-run-20260805", sourceApplyNo: "MOCK-VN-20260805-04",
    priceKey: "VN|VN-KITCHEN-052|LAZADA|STANDARD|CAMPAIGN", countryCode: "VN", categoryName: "厨房用品",
    sku: "VN-KITCHEN-052", productNameCn: "多功能手动切菜器", platform: "LAZADA", shopType: "STANDARD", priceType: "CAMPAIGN",
    oldPrice: "129000.00", newPrice: "125000.00", deltaValue: "-4000.00", deltaPercent: -3.1, direction: "DOWN",
    changeText: "国家：VN；类目：厨房用品；SKU：VN-KITCHEN-052；商品中文名：多功能手动切菜器；平台：Lazada；店铺类型：标准店；价格类型：活动价；从原价 129000.00 变更到现价 125000.00，下调 4000.00（3.10%）。",
    foundationTaskId: "mock-task-vn-004", validityStatus: "VALID", invalidReason: null, invalidatedAt: null, invalidatedBy: null,
    adjustmentStatus: "UNADJUSTED", adjustmentRemark: "等待店铺确认", adjustmentUpdatedAt: mockDetectedAt, adjustmentUpdatedBy: "演示用户", detectedAt: mockDetectedAt,
  },
  {
    id: "mock-change-tw-005", syncRunId: "mock-run-20260805", sourceApplyNo: "MOCK-TW-20260805-05",
    priceKey: "TW|TW-3C-088|SHOPEE|MALL|MEGA_CAMPAIGN", countryCode: "TW", categoryName: "3C数码",
    sku: "TW-3C-088", productNameCn: "降噪蓝牙耳机", platform: "SHOPEE", shopType: "MALL", priceType: "MEGA_CAMPAIGN",
    oldPrice: "899.00", newPrice: "949.00", deltaValue: "50.00", deltaPercent: 5.56, direction: "UP",
    changeText: "国家：TW；类目：3C数码；SKU：TW-3C-088；商品中文名：降噪蓝牙耳机；平台：Shopee；店铺类型：Mall 店；价格类型：大促价；从原价 899.00 变更到现价 949.00，上涨 50.00（5.56%）。",
    foundationTaskId: "mock-task-tw-005", validityStatus: "VALID", invalidReason: null, invalidatedAt: null, invalidatedBy: null,
    adjustmentStatus: "ADJUSTED", adjustmentRemark: "已完成价格复核", adjustmentUpdatedAt: mockDetectedAt, adjustmentUpdatedBy: "演示用户", detectedAt: mockDetectedAt,
  },
  {
    id: "mock-change-sg-006", syncRunId: "mock-run-20260805", sourceApplyNo: "MOCK-SG-20260805-06",
    priceKey: "SG|SG-PET-109|TIKTOK|STANDARD|CAMPAIGN", countryCode: "SG", categoryName: "宠物用品",
    sku: "SG-PET-109", productNameCn: "宠物外出折叠水碗", platform: "TIKTOK", shopType: "STANDARD", priceType: "CAMPAIGN",
    oldPrice: "25.90", newPrice: "22.90", deltaValue: "-3.00", deltaPercent: -11.58, direction: "DOWN",
    changeText: "国家：SG；类目：宠物用品；SKU：SG-PET-109；商品中文名：宠物外出折叠水碗；平台：TikTok Shop；店铺类型：标准店；价格类型：活动价；从原价 25.90 变更到现价 22.90，下调 3.00（11.58%）。",
    foundationTaskId: "mock-task-sg-006", validityStatus: "VALID", invalidReason: null, invalidatedAt: null, invalidatedBy: null,
    adjustmentStatus: "UNADJUSTED", adjustmentRemark: null, adjustmentUpdatedAt: null, adjustmentUpdatedBy: null, detectedAt: mockDetectedAt,
  },
];

const mockCurrentPrices: CurrentPrice[] = mockChanges
  .filter((item) => item.newPrice !== null)
  .map((item) => ({
    priceKey: item.priceKey, countryCode: item.countryCode, categoryName: item.categoryName, sku: item.sku,
    productNameCn: item.productNameCn, skuStatus: "在售", platform: item.platform, shopType: item.shopType,
    priceType: item.priceType, priceValue: item.newPrice!, sourceApplyNo: item.sourceApplyNo,
    effectiveAt: "2026-08-05 18:08:00", revision: 2, updatedAt: mockDetectedAt,
  }));

function mockMatches(item: PriceChange | CurrentPrice) {
  if (query.country && item.countryCode !== query.country) return false;
  if (query.category && item.categoryName !== query.category) return false;
  if (query.sku && !item.sku.toUpperCase().includes(query.sku.toUpperCase())) return false;
  if (query.platform && item.platform !== query.platform) return false;
  if (query.shop_type && item.shopType !== query.shop_type) return false;
  if (query.price_type && item.priceType !== query.price_type) return false;
  if (query.apply_no && item.sourceApplyNo !== query.apply_no) return false;
  if ("syncRunId" in item && query.sync_run_id && item.syncRunId !== query.sync_run_id) return false;
  if ("direction" in item && query.direction && item.direction !== query.direction) return false;
  if ("adjustmentStatus" in item && query.adjustment_status && item.adjustmentStatus !== query.adjustment_status) return false;
  return true;
}

function applyMockData() {
  status.value = {
    schemaReady: true, adjustmentWorkflowReady: true, automationReady: true, sourceConfigured: true, syncEnabled: false, manualSyncEnabled: true,
    repricing: { workflowReady: true, executionProviders: ["MABANG_LISTING"], limits: { maxSourceChanges: 25, maxShopAssignments: 100 } },
    syncIntervalMs: 60 * 60 * 1000, batchLimit: 200, batchesPerScope: 1, approvalStatus: "CA",
    source: { connected: true, checked: true, transactionReadOnly: true, serverVersion: "MySQL 8.0（演示）", databaseName: "AI_Project_A（演示）" },
  };
  overview.value = {
    totalChanges: 6, upCount: 2, downCount: 2, affectedSkuCount: 6,
    latestDetectedAt: mockDetectedAt, currentPriceCount: 5, currentSkuCount: 5, latestEffectiveAt: "2026-08-05 18:08:00",
    filters: {
      countries: ["MY", "PH", "SG", "TH", "TW", "VN"],
      categories: ["3C数码", "厨房用品", "宠物用品", "家居收纳", "手机配件", "美容工具"],
      batches: mockChanges.map((item) => ({ applyNo: item.sourceApplyNo, countryCode: item.countryCode, effectiveAt: "2026-08-05 18:08:00" })),
    },
  };
  runs.value = [{
    id: "mock-run-20260805", triggerType: "rehearsal", syncMode: "incremental", status: "SUCCEEDED",
    sourceRowsSeen: 6, changeCount: 6, notificationStatus: "SENT", notifiedAt: mockDetectedAt,
    notificationErrorCode: null, watermarkAt: "2026-08-05 18:08:00",
    sourceCheckedAt: "2026-08-05 18:09:55", sourceTableUpdatedAt: "2026-08-05 18:08:12",
    sourceBusinessUpdatedAt: "2026-08-05 18:08:00", fetchedAt: mockDetectedAt, createdAt: mockDetectedAt,
  }];
  const mockAdjustedCount = mockChanges.filter((item) => item.adjustmentStatus === "ADJUSTED").length;
  changeRounds.value = [{
    id: "mock-run-20260805", triggerType: "rehearsal", firstDetectedAt: mockDetectedAt, lastDetectedAt: mockDetectedAt,
    sourceBusinessUpdatedAt: "2026-08-05 18:08:00", sourceTableUpdatedAt: "2026-08-05 18:08:12", fetchedAt: mockDetectedAt,
    changeCount: 6, affectedSkuCount: 6, adjustedCount: mockAdjustedCount, unadjustedCount: 6 - mockAdjustedCount,
  }];
  if (!roundSelectionInitialized.value) {
    query.sync_run_id = "mock-run-20260805";
    roundSelectionInitialized.value = true;
  }
  automation.value = {
    ready: true,
    settings: {
      enabled: false, intervalMinutes: 60, dingtalkConfigId: "mock-robot", notifyOnChange: true, notifyOnFailure: true,
      lastRunAt: mockDetectedAt, lastRunStatus: "SUCCEEDED", lastNotificationAt: mockDetectedAt,
      lastNotificationStatus: "SENT", nextRunAt: null, lastErrorCode: null, lastErrorMessage: null, updatedAt: mockDetectedAt,
    },
    robots: [{ id: "mock-robot", name: "控价提醒机器人（演示）", enabled: true, webhookConfigured: true, secretConfigured: true, atAll: false, atMobiles: [] }],
    defaults: { intervalMinutes: 60, minimumIntervalMinutes: 15 },
  };
  const source = viewMode.value === "current" ? mockCurrentPrices : mockChanges;
  const filtered = source.filter(mockMatches);
  const start = (query.page - 1) * query.page_size;
  total.value = filtered.length;
  if (viewMode.value === "current") {
    currentPrices.value = (filtered as CurrentPrice[]).slice(start, start + query.page_size);
    changes.value = [];
  } else {
    changes.value = (filtered as PriceChange[]).slice(start, start + query.page_size);
    currentPrices.value = [];
  }
  selectedChanges.value = [];
}

function hydrateAutomationForm() {
  const settings = automation.value.settings;
  Object.assign(automationForm, {
    enabled: settings?.enabled ?? false,
    intervalMinutes: settings?.intervalMinutes || automation.value.defaults.intervalMinutes || 60,
    dingtalkConfigId: settings?.dingtalkConfigId || "",
    notifyOnChange: settings?.notifyOnChange ?? true,
    notifyOnFailure: settings?.notifyOnFailure ?? true,
  });
}

function formatDate(value?: string | null) {
  return value ? new Date(value.replace(" ", "T")).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function formatInterval(milliseconds?: number) {
  const minutes = Math.max(1, Math.round(Number(milliseconds || 0) / 60_000));
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function directionTag(direction: string) {
  return direction === "UP" ? "danger" : direction === "DOWN" ? "success" : direction === "NEW" ? "primary" : "warning";
}

function adjustmentLabel(status: PriceChange["adjustmentStatus"]) {
  return status === "ADJUSTED" ? "已调整" : "未调整";
}

function roundLabel(round: PriceChangeRound) {
  return `${formatDate(round.lastDetectedAt)} · ${round.affectedSkuCount.toLocaleString("zh-CN")} SKU · ${round.changeCount.toLocaleString("zh-CN")} 条`;
}

function selectQuickRound(position: "current" | "previous") {
  const index = position === "current" ? 0 : 1;
  const target = changeRounds.value[index];
  if (!target) return;
  query.sync_run_id = target.id;
  load({ resetPage: true });
}

function copyableChangeText(item: PriceChange) {
  return `${item.changeText}；处理状态：${adjustmentLabel(item.adjustmentStatus)}${item.adjustmentRemark ? `；备注：${item.adjustmentRemark}` : ""}`;
}

async function load({ resetPage = false } = {}) {
  if (resetPage) query.page = 1;
  loading.value = true;
  error.value = "";
  try {
    if (demoMode.value) {
      applyMockData();
      workspace.lastSyncedAt = new Date();
      return;
    }
    status.value = await loadPriceControlStatus();
    overview.value = await loadPriceControlOverview();
    if (status.value.schemaReady) {
      const [roundResult, runResult, automationResult] = await Promise.all([
        status.value.adjustmentWorkflowReady ? loadPriceChangeRounds() : Promise.resolve({ rounds: [] as PriceChangeRound[] }),
        loadPriceControlRuns(),
        loadPriceControlAutomation(),
      ]);
      changeRounds.value = roundResult.rounds || [];
      if (viewMode.value === "changes" && !roundSelectionInitialized.value) {
        query.sync_run_id = changeRounds.value[0]?.id || "";
        roundSelectionInitialized.value = true;
      }
      const dataResult = await (viewMode.value === "current" ? loadCurrentPrices(query) : loadPriceChanges(query));
      if (viewMode.value === "current") {
        currentPrices.value = (dataResult as Awaited<ReturnType<typeof loadCurrentPrices>>).prices || [];
        total.value = (dataResult as Awaited<ReturnType<typeof loadCurrentPrices>>).total || 0;
      } else {
        changes.value = (dataResult as Awaited<ReturnType<typeof loadPriceChanges>>).changes || [];
        total.value = (dataResult as Awaited<ReturnType<typeof loadPriceChanges>>).total || 0;
      }
      runs.value = runResult.runs || [];
      automation.value = automationResult;
      hydrateAutomationForm();
      selectedChanges.value = [];
    } else {
      changes.value = [];
      currentPrices.value = [];
      total.value = 0;
      runs.value = [];
      changeRounds.value = [];
    }
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "控价变更加载失败");
  } finally {
    loading.value = false;
  }
}

function onChangeSelection(rows: PriceChange[]) {
  selectedChanges.value = rows;
}

function repricingScopeKey(change: PriceChange) {
  return `${change.platform}|${change.countryCode}`;
}

function availableShopsFor(change: PriceChange) {
  return repricingShops.value[repricingScopeKey(change)] || [];
}

function cancelRepricingPoll() {
  if (repricingPollTimer) clearTimeout(repricingPollTimer);
  repricingPollTimer = null;
}

function toggleAllRepricingItems(checked: boolean | string | number) {
  repricingSelectedItemIds.value = checked ? [...repricingSelectableItemIds.value] : [];
}

async function openRepricingDialog() {
  if (!selectedChanges.value.length) return ElMessage.warning("请先勾选控价变更。");
  if (selectedChanges.value.length > 25) return ElMessage.warning("每次最多选择 25 条控价变更。");
  if (selectedRound.value?.id !== changeRounds.value[0]?.id) return ElMessage.warning("只能基于最新一轮变更生成调价预览。");
  const unsupported = selectedChanges.value.find((item) => item.platform === "TIKTOK" || item.priceType === "MEGA_CAMPAIGN");
  if (unsupported) return ElMessage.warning("TikTok 或大促价尚未建立安全字段映射，请从本次选择中移除。");
  const handled = selectedChanges.value.find((item) => item.adjustmentStatus === "ADJUSTED");
  if (handled) return ElMessage.warning("已调整记录不能重复生成调价预览。");
  cancelRepricingPoll();
  repricingDialogOpen.value = true;
  repricingStep.value = "shops";
  repricingPlan.value = null;
  repricingConfirmationText.value = "";
  repricingUnknownAcknowledged.value = false;
  repricingSelectedItemIds.value = [];
  repricingAssignments.value = Object.fromEntries(selectedChanges.value.map((item) => [item.id, []]));
  repricingLoading.value = true;
  try {
    const scopes = [...new Map(selectedChanges.value.map((item) => [repricingScopeKey(item), item])).entries()];
    const results = await Promise.all(scopes.map(async ([key, item]) => [key, await loadPriceControlShops(item.platform, item.countryCode)] as const));
    repricingShops.value = Object.fromEntries(results);
  } catch (shopError) {
    repricingDialogOpen.value = false;
    ElMessage.error(String((shopError as Error)?.message || shopError || "店铺明细加载失败"));
  } finally {
    repricingLoading.value = false;
  }
}

async function generateRepricingPreview() {
  const incomplete = selectedChanges.value.find((item) => !(repricingAssignments.value[item.id] || []).length);
  if (incomplete) return ElMessage.warning(`请为 ${incomplete.countryCode} / ${incomplete.sku} 选择至少一家店铺。`);
  repricingLoading.value = true;
  try {
    const plan = await createPriceControlRepricingPreview({
      roundId: selectedRound.value?.id || "",
      assignments: selectedChanges.value.map((item) => ({
        changeId: item.id,
        shopIds: repricingAssignments.value[item.id] || [],
      })),
    });
    repricingPlan.value = plan;
    repricingSelectedItemIds.value = [];
    repricingStep.value = "preview";
    ElMessage.success(`已读取马帮实时商品，生成 ${plan.listingChangeCount} 条实际差异。`);
  } catch (previewError) {
    ElMessage.error(String((previewError as Error)?.message || previewError || "调价预览生成失败"));
  } finally {
    repricingLoading.value = false;
  }
}

async function pollRepricingPlan() {
  cancelRepricingPoll();
  const plan = repricingPlan.value;
  if (!plan || !["EXECUTING", "EXECUTION_UNKNOWN"].includes(plan.status)) return;
  if (plan.status === "EXECUTION_UNKNOWN" && !plan.executionJobId) return;
  try {
    repricingPlan.value = await refreshPriceControlRepricingPlan(plan.id);
    if (repricingIsTerminal.value) {
      if (repricingPlan.value?.status === "SUCCEEDED") ElMessage.success("店铺价格同步并回读完成。");
      else ElMessage.warning(`调价任务结束：${repricingPlan.value?.status}`);
      await load();
      return;
    }
    if (repricingPlan.value?.status === "EXECUTION_UNKNOWN" && !repricingPlan.value.executionJobId) return;
  } catch (pollError) {
    ElMessage.warning(String((pollError as Error)?.message || pollError || "任务状态刷新失败"));
  }
  repricingPollTimer = setTimeout(pollRepricingPlan, 1800);
}

async function confirmRepricingExecution() {
  const plan = repricingPlan.value;
  if (!plan) return;
  if (!repricingSelectedItemIds.value.length) return ElMessage.warning("请至少选择一条实际差异。");
  if (repricingConfirmationText.value !== "确认同步到店铺") return ElMessage.warning("请输入完整确认文本：确认同步到店铺");
  if (repricingHasUnknownShopTypes.value && !repricingUnknownAcknowledged.value) return ElMessage.warning("请确认已人工核对未分类店铺的 Standard/Mall 类型。");
  repricingLoading.value = true;
  try {
    repricingPlan.value = await confirmPriceControlRepricingPlan(plan.id, {
      confirmed: true,
      confirmationText: repricingConfirmationText.value,
      previewFingerprint: plan.previewFingerprint,
      selectedItemIds: repricingSelectedItemIds.value,
      acknowledgeUnknownShopTypes: repricingUnknownAcknowledged.value,
    });
    repricingStep.value = "execution";
    ElMessage.success("人工确认已记录，马帮调价任务已提交。");
    await pollRepricingPlan();
  } catch (confirmError) {
    ElMessage.error(String((confirmError as Error)?.message || confirmError || "调价任务提交失败"));
  } finally {
    repricingLoading.value = false;
  }
}

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("CLIPBOARD_WRITE_FAILED");
  }
}

async function copyChanges(items: PriceChange[], label: string) {
  if (!items.length) {
    ElMessage.warning("请先选择需要复制的控价变更");
    return;
  }
  try {
    await writeClipboardText(items.map(copyableChangeText).join("\n"));
    ElMessage.success(`已复制${label} ${items.length} 条控价变更`);
  } catch {
    ElMessage.error("复制失败，请检查浏览器剪贴板权限后重试");
  }
}

async function copySelectedRound() {
  const round = selectedRound.value;
  if (!round) {
    ElMessage.warning("请先选择一个控价变更轮次");
    return;
  }
  roundCopying.value = true;
  try {
    if (demoMode.value) {
      const items = mockChanges.filter((item) => item.syncRunId === round.id);
      const header = `最近变更时间：${formatDate(round.lastDetectedAt)}\n涉及 SKU：${round.affectedSkuCount}；有效变更：${round.changeCount}\n\n`;
      const text = items.map((item, index) => `${index + 1}. ${item.changeText}；处理状态：${adjustmentLabel(item.adjustmentStatus)}${item.adjustmentRemark ? `；备注：${item.adjustmentRemark}` : ""}`).join("\n");
      await writeClipboardText(header + text);
      ElMessage.success(`已复制本轮全部 ${items.length} 条控价变更`);
      return;
    }
    const result = await copyPriceChangeRound(round.id);
    await writeClipboardText(result.text);
    ElMessage.success(`已复制本轮全部 ${result.count.toLocaleString("zh-CN")} 条控价变更`);
  } catch (copyError) {
    ElMessage.error(String((copyError as Error)?.message || copyError || "本轮变更复制失败"));
  } finally {
    roundCopying.value = false;
  }
}

function openAdjustment(item: PriceChange) {
  adjustmentTarget.value = item;
  Object.assign(adjustmentForm, {
    status: item.adjustmentStatus,
    remark: item.adjustmentRemark || "",
  });
  adjustmentDialogOpen.value = true;
}

async function saveAdjustment() {
  const target = adjustmentTarget.value;
  if (!target) return;
  adjustmentSaving.value = true;
  try {
    if (demoMode.value) {
      target.adjustmentStatus = adjustmentForm.status;
      target.adjustmentRemark = adjustmentForm.remark.trim() || null;
      target.adjustmentUpdatedAt = new Date().toISOString();
      target.adjustmentUpdatedBy = "演示用户";
    } else {
      const result = await updatePriceChangeAdjustment(target.id, {
        status: adjustmentForm.status,
        remark: adjustmentForm.remark.trim(),
      });
      Object.assign(target, result.change);
      if (detail.value?.id === target.id) detail.value = result.change;
    }
    adjustmentDialogOpen.value = false;
    ElMessage.success(`已标记为${adjustmentLabel(adjustmentForm.status)}`);
    await load();
  } catch (saveError) {
    ElMessage.error(String((saveError as Error)?.message || saveError || "处理状态保存失败"));
  } finally {
    adjustmentSaving.value = false;
  }
}

function openAutomationDrawer() {
  hydrateAutomationForm();
  automationDrawerOpen.value = true;
}

async function saveAutomationSettings() {
  if (!automation.value.ready) return;
  if ((automationForm.notifyOnChange || automationForm.notifyOnFailure) && !automationForm.dingtalkConfigId) {
    ElMessage.warning("请选择接收控价提醒的钉钉机器人");
    return;
  }
  if (automationForm.enabled) {
    const robot = automation.value.robots.find((item) => item.id === automationForm.dingtalkConfigId);
    try {
      await ElMessageBox.confirm(
        `开启后系统将每 ${formatInterval(automationForm.intervalMinutes * 60_000)}读取控价；发现变更后发送到“${robot?.name || "所选机器人"}”。确认开启？`,
        "开启控价定时获取",
        { type: "warning", confirmButtonText: "确认开启", cancelButtonText: "取消" },
      );
    } catch { return; }
  }
  automationSaving.value = true;
  try {
    const result = await savePriceControlAutomation({
      enabled: automationForm.enabled,
      intervalMinutes: automationForm.intervalMinutes,
      dingtalkConfigId: automationForm.dingtalkConfigId || null,
      notifyOnChange: automationForm.notifyOnChange,
      notifyOnFailure: automationForm.notifyOnFailure,
    });
    if (automation.value.settings) automation.value.settings = result.settings;
    await load();
    ElMessage.success(automationForm.enabled ? "控价定时获取已开启" : "控价定时获取设置已保存");
  } catch (saveError) {
    ElMessage.error(String((saveError as Error)?.message || saveError));
  } finally {
    automationSaving.value = false;
  }
}

function openRobotDialog() {
  Object.assign(robotForm, { name: "", webhookUrl: "", secret: "", atMobiles: "", atAll: false });
  robotDialogOpen.value = true;
}

async function saveRobot() {
  if (!robotForm.name.trim() || !robotForm.webhookUrl.trim()) {
    ElMessage.warning("请填写机器人名称和 Webhook");
    return;
  }
  robotSaving.value = true;
  try {
    await saveDingtalkConfig({
      config: null,
      ...robotForm,
      enabled: true,
      notifyOnSuccess: true,
      notifyOnFailure: true,
      notifyOnEmpty: false,
    });
    robotDialogOpen.value = false;
    automation.value = await loadPriceControlAutomation();
    hydrateAutomationForm();
    ElMessage.success("钉钉机器人已加密保存");
  } catch (saveError) {
    ElMessage.error(String((saveError as Error)?.message || saveError));
  } finally {
    robotSaving.value = false;
  }
}

async function testSelectedRobot() {
  const robot = automation.value.robots.find((item) => item.id === automationForm.dingtalkConfigId);
  if (!robot) {
    ElMessage.warning("请先选择钉钉机器人");
    return;
  }
  try {
    await ElMessageBox.confirm(`将向“${robot.name}”发送一条真实测试消息，确认发送？`, "测试钉钉机器人", { type: "warning" });
    await testDingtalkConfig(robot.id);
    ElMessage.success("钉钉测试消息发送成功");
  } catch (action) {
    if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action));
  }
}

async function toggleDemo() {
  await router.replace({ query: { ...route.query, demo: demoMode.value ? undefined : "1" } });
  viewMode.value = "changes";
  roundSelectionInitialized.value = false;
  Object.assign(query, { page: 1, country: "", category: "", sku: "", platform: "", shop_type: "", price_type: "", direction: "", apply_no: "", sync_run_id: "", adjustment_status: "" });
  await load();
}

async function probeSource() {
  probing.value = true;
  try {
    status.value = await loadPriceControlStatus(true);
    if (status.value.source.connected) ElMessage.success("源数据库只读连接正常");
    else ElMessage.warning(status.value.source.error || "源数据库未连接");
  } catch (probeError) {
    ElMessage.error(String((probeError as Error)?.message || probeError));
  } finally {
    probing.value = false;
  }
}

async function sync(mode: "baseline" | "incremental") {
  if (!canSync.value) return;
  if (mode === "baseline") {
    try {
      await ElMessageBox.confirm("基线只建立当前价格，不生成变更提醒。确认继续？", "建立控价基线", { type: "warning", confirmButtonText: "确认建立", cancelButtonText: "取消" });
    } catch { return; }
  }
  syncing.value = true;
  try {
    const result = await runPriceControlSync(mode);
    ElMessage.success(mode === "baseline" ? "控价基线已建立" : `同步完成，发现 ${result.run.changeCount} 条变更`);
    await load();
  } catch (syncError) {
    ElMessage.error(String((syncError as Error)?.message || syncError));
  } finally {
    syncing.value = false;
  }
}

async function copyText(item: PriceChange) {
  try {
    await writeClipboardText(copyableChangeText(item));
    ElMessage.success("变更文本已复制");
  } catch {
    ElMessage.error("复制失败，请检查浏览器剪贴板权限后重试");
  }
}

function showDetail(item: PriceChange) {
  detail.value = item;
  detailVisible.value = true;
}

function reset() {
  Object.assign(query, { page: 1, country: "", category: "", sku: "", platform: "", shop_type: "", price_type: "", direction: "", apply_no: "", sync_run_id: changeRounds.value[0]?.id || "", adjustment_status: "" });
  load();
}

function switchView(mode: "current" | "changes") {
  viewMode.value = mode;
  query.page = 1;
  if (mode === "changes" && !query.sync_run_id) query.sync_run_id = changeRounds.value[0]?.id || "";
  load();
}

onMounted(() => {
  load();
});
onBeforeUnmount(cancelRepricingPoll);
</script>

<template>
  <div class="price-control-page" v-loading="loading">
    <section class="module-toolbar price-toolbar">
      <div class="price-filter-grid">
        <div v-if="viewMode === 'changes'" class="round-quick-filter" aria-label="快捷筛选变更轮次">
          <span>变更轮次</span>
          <el-radio-group :model-value="roundQuickFilter" size="default" @change="selectQuickRound($event as 'current' | 'previous')">
            <el-radio-button value="current" :disabled="!changeRounds[0]">本轮变化</el-radio-button>
            <el-radio-button value="previous" :disabled="!changeRounds[1]">上轮变化</el-radio-button>
          </el-radio-group>
        </div>
        <el-select v-if="viewMode === 'changes'" v-model="query.sync_run_id" class="round-filter" placeholder="选择历史变更轮次" filterable @change="load({ resetPage: true })">
          <el-option v-for="item in changeRounds" :key="item.id" :label="roundLabel(item)" :value="item.id" />
        </el-select>
        <el-select v-model="query.country" placeholder="全部国家" clearable><el-option v-for="item in overview.filters.countries" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="query.category" placeholder="全部类目" clearable filterable><el-option v-for="item in overview.filters.categories" :key="item" :label="item" :value="item" /></el-select>
        <el-input v-model="query.sku" placeholder="搜索 SKU" clearable @keyup.enter="load({ resetPage: true })" />
        <el-select v-model="query.platform" placeholder="全部平台" clearable><el-option label="Lazada" value="LAZADA" /><el-option label="Shopee" value="SHOPEE" /><el-option label="TikTok Shop" value="TIKTOK" /></el-select>
        <el-select v-model="query.shop_type" placeholder="全部店铺类型" clearable><el-option label="标准店" value="STANDARD" /><el-option label="Mall 店" value="MALL" /></el-select>
        <el-select v-model="query.price_type" placeholder="全部价格类型" clearable><el-option label="日常价" value="REGULAR" /><el-option label="活动价" value="CAMPAIGN" /><el-option label="大促价" value="MEGA_CAMPAIGN" /></el-select>
        <el-select v-if="viewMode === 'changes'" v-model="query.direction" placeholder="全部方向" clearable><el-option label="上涨" value="UP" /><el-option label="下调" value="DOWN" /><el-option label="新增" value="NEW" /><el-option label="移除" value="REMOVED" /></el-select>
        <el-select v-if="viewMode === 'changes'" v-model="query.adjustment_status" placeholder="全部处理状态" clearable><el-option label="未调整" value="UNADJUSTED" /><el-option label="已调整" value="ADJUSTED" /></el-select>
        <el-select v-model="query.apply_no" placeholder="全部申请批次" clearable filterable><el-option v-for="item in overview.filters.batches" :key="item.applyNo" :label="`${item.applyNo} · ${item.countryCode}`" :value="item.applyNo" /></el-select>
      </div>
      <div class="module-toolbar-actions">
        <el-button :type="demoMode ? 'warning' : 'default'" @click="toggleDemo">{{ demoMode ? "退出演示" : "查看演示数据" }}</el-button>
        <el-button @click="reset">重置</el-button>
        <el-button :icon="Search" type="primary" @click="load({ resetPage: true })">查询</el-button>
        <el-button :icon="RefreshCw" @click="load()">刷新</el-button>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-if="demoMode" type="warning" :closable="false" show-icon title="当前为演示数据模式：以下记录只在浏览器中展示，不写入数据库、不创建 Foundation 任务，也不会发送提醒。" />
    <el-alert v-if="status && !status.schemaReady" type="warning" :closable="false" show-icon title="控价变更候选迁移尚未正式启用；页面与接口已就绪，但不会写入正式数据库。" />
    <el-alert v-else-if="status && !status.adjustmentWorkflowReady" type="warning" :closable="false" show-icon title="变更轮次、处理状态与备注功能已就绪，需完成正式迁移后启用。" />

    <section v-if="viewMode === 'changes' && selectedRound" class="change-round-strip" aria-label="当前控价变更轮次">
      <div class="round-title"><span>当前变更轮次</span><strong>{{ formatDate(selectedRound.lastDetectedAt) }}</strong><small>源库控价更新时间：{{ formatDate(selectedRound.sourceBusinessUpdatedAt) }}</small></div>
      <div><span>涉及 SKU</span><strong>{{ selectedRound.affectedSkuCount.toLocaleString("zh-CN") }}</strong></div>
      <div><span>本轮变更</span><strong>{{ selectedRound.changeCount.toLocaleString("zh-CN") }}</strong></div>
      <div><span>未调整</span><strong class="pending">{{ selectedRound.unadjustedCount.toLocaleString("zh-CN") }}</strong></div>
      <div><span>已调整</span><strong class="completed">{{ selectedRound.adjustedCount.toLocaleString("zh-CN") }}</strong></div>
      <el-button type="primary" :icon="Clipboard" :loading="roundCopying" :disabled="!status?.adjustmentWorkflowReady" @click="copySelectedRound">复制本轮全部信息</el-button>
    </section>

    <section class="connection-strip" aria-label="控价数据源状态">
      <div><Database :size="18" /><span>源数据库</span><strong>{{ status?.sourceConfigured ? (status.source.connected ? "只读连接正常" : "已配置，未检测") : "未配置" }}</strong></div>
      <div><ShieldCheck :size="18" /><span>生效口径</span><strong>仅 CA 审批通过</strong></div>
      <div><RefreshCw :size="18" /><span>获取频率</span><strong>{{ status?.syncEnabled ? `每 ${formatInterval(status.syncIntervalMs)}自动检查` : "当前仅手动获取" }}</strong><small>默认每 {{ formatInterval(status?.syncIntervalMs || 60 * 60 * 1000) }}；每个国家/类目只读取最新批准批次</small></div>
      <div><Database :size="18" /><span>最新审批数据时间</span><strong>{{ latestRun ? formatDate(latestRun.sourceBusinessUpdatedAt) : "尚未获取" }}</strong><small>源表更新时间：{{ latestRun ? formatDate(latestRun.sourceTableUpdatedAt) : "—" }}</small></div>
      <div><RefreshCw :size="18" /><span>本次获取时间</span><strong>{{ latestRun ? formatDate(latestRun.fetchedAt || latestRun.createdAt) : "尚未获取" }}</strong></div>
      <div class="connection-actions">
        <el-button :icon="Database" :loading="probing" :disabled="!status?.sourceConfigured" @click="probeSource">检测连接</el-button>
        <el-button :icon="RefreshCw" @click="openAutomationDrawer">定时与钉钉</el-button>
        <el-button :disabled="!canSync" :loading="syncing" @click="sync('baseline')">建立基线</el-button>
        <el-button type="primary" :disabled="!canSync" :loading="syncing" @click="sync('incremental')">同步最新控价</el-button>
      </div>
    </section>

    <section class="price-summary-strip" aria-label="控价变更摘要">
      <div><span>当前控价点</span><strong>{{ overview.currentPriceCount.toLocaleString("zh-CN") }}</strong></div>
      <div><span>受影响 SKU</span><strong>{{ overview.affectedSkuCount.toLocaleString("zh-CN") }}</strong></div>
      <div><span>变更总数</span><strong>{{ overview.totalChanges.toLocaleString("zh-CN") }}</strong></div>
      <div><span>上涨</span><strong class="up"><ArrowUp :size="17" />{{ overview.upCount.toLocaleString("zh-CN") }}</strong></div>
      <div><span>下调</span><strong class="down"><ArrowDown :size="17" />{{ overview.downCount.toLocaleString("zh-CN") }}</strong></div>
      <div><span>最新生效控价</span><strong class="date">{{ formatDate(overview.latestEffectiveAt) }}</strong></div>
    </section>

    <section class="dashboard-panel price-table-panel">
      <header>
        <div><span class="panel-kicker">APPROVED PRICE CONTROL</span><h3>{{ viewMode === "current" ? "当前控价" : "控价变更明细" }}{{ demoMode ? "（演示）" : "" }}</h3></div>
        <div class="table-heading-actions">
          <template v-if="viewMode === 'changes'">
            <el-tooltip :disabled="canCreateRepricingPreview" content="仅支持最新轮次、未调整记录；TikTok 与大促价暂不执行" placement="bottom">
              <span>
                <el-button size="small" type="primary" :icon="CircleDollarSign" :disabled="!canCreateRepricingPreview" @click="openRepricingDialog">
                  生成马帮调价预览（{{ selectedChanges.length }}）
                </el-button>
              </span>
            </el-tooltip>
            <el-button size="small" type="primary" plain :icon="Clipboard" :loading="roundCopying" :disabled="!selectedRound || !status?.adjustmentWorkflowReady" @click="copySelectedRound">复制本轮全部</el-button>
            <el-button size="small" :icon="Clipboard" :disabled="!selectedChanges.length" @click="copyChanges(selectedChanges, '选中')">复制选中（{{ selectedChanges.length }}）</el-button>
            <el-button size="small" :icon="Clipboard" :disabled="!changes.length" @click="copyChanges(changes, '本页')">复制本页</el-button>
          </template>
          <el-radio-group :model-value="viewMode" size="small" @change="switchView($event as 'current' | 'changes')"><el-radio-button value="changes">变更记录</el-radio-button><el-radio-button value="current">当前控价</el-radio-button></el-radio-group>
          <span>共 {{ total.toLocaleString("zh-CN") }} 条</span>
        </div>
      </header>
      <div v-if="viewMode === 'current'" class="desktop-table">
        <el-table :data="currentPrices" stripe empty-text="尚未获取控价；请先建立基线">
          <el-table-column prop="countryCode" label="国家" width="72" fixed />
          <el-table-column prop="categoryName" label="类目" min-width="120" show-overflow-tooltip />
          <el-table-column prop="sku" label="SKU" min-width="140" show-overflow-tooltip />
          <el-table-column label="商品中文名" min-width="180" show-overflow-tooltip><template #default="scope">{{ scope.row.productNameCn || "未匹配中文名" }}</template></el-table-column>
          <el-table-column label="平台 / 店铺" min-width="145"><template #default="scope"><div class="stacked-cell"><strong>{{ platformLabels[scope.row.platform] }}</strong><span>{{ shopLabels[scope.row.shopType] }} · {{ priceTypeLabels[scope.row.priceType] }}</span></div></template></el-table-column>
          <el-table-column prop="priceValue" label="当前控价" width="120" align="right" />
          <el-table-column prop="skuStatus" label="商品状态" width="105" />
          <el-table-column prop="sourceApplyNo" label="来源申请批次" min-width="150" show-overflow-tooltip />
          <el-table-column label="控价生效时间" width="170"><template #default="scope">{{ formatDate(scope.row.effectiveAt) }}</template></el-table-column>
        </el-table>
      </div>
      <div v-else class="desktop-table">
        <el-table :data="changes" stripe empty-text="暂无控价变更；首次使用请先建立基线" @selection-change="onChangeSelection">
          <el-table-column type="selection" width="48" fixed />
          <el-table-column prop="countryCode" label="国家" width="72" fixed />
          <el-table-column prop="categoryName" label="类目" min-width="120" show-overflow-tooltip />
          <el-table-column prop="sku" label="SKU" min-width="140" show-overflow-tooltip />
          <el-table-column label="商品中文名" min-width="180" show-overflow-tooltip><template #default="scope">{{ scope.row.productNameCn || "未匹配中文名" }}</template></el-table-column>
          <el-table-column label="平台 / 店铺" min-width="145"><template #default="scope"><div class="stacked-cell"><strong>{{ platformLabels[scope.row.platform] }}</strong><span>{{ shopLabels[scope.row.shopType] }} · {{ priceTypeLabels[scope.row.priceType] }}</span></div></template></el-table-column>
          <el-table-column label="价格变更" min-width="185"><template #default="scope"><div class="price-delta"><span>{{ scope.row.oldPrice ?? "无价格" }}</span><b>→</b><strong>{{ scope.row.newPrice ?? "无价格" }}</strong></div></template></el-table-column>
          <el-table-column label="方向" width="92"><template #default="scope"><el-tag :type="directionTag(scope.row.direction)" effect="light">{{ directionLabels[scope.row.direction] }}</el-tag></template></el-table-column>
          <el-table-column label="处理状态" min-width="150"><template #default="scope"><div class="adjustment-state"><el-tag :type="scope.row.adjustmentStatus === 'ADJUSTED' ? 'success' : 'info'" effect="plain">{{ adjustmentLabel(scope.row.adjustmentStatus) }}</el-tag><span v-if="scope.row.adjustmentRemark" :title="scope.row.adjustmentRemark">{{ scope.row.adjustmentRemark }}</span></div></template></el-table-column>
          <el-table-column prop="sourceApplyNo" label="申请批次" min-width="150" show-overflow-tooltip />
          <el-table-column label="发现时间" width="170"><template #default="scope">{{ formatDate(scope.row.detectedAt) }}</template></el-table-column>
          <el-table-column label="操作" width="190" fixed="right"><template #default="scope"><el-button link type="primary" :icon="MessageSquareText" @click="openAdjustment(scope.row)">处理</el-button><el-button link @click="showDetail(scope.row)">详情</el-button><el-button link :icon="Clipboard" @click="copyText(scope.row)">复制</el-button></template></el-table-column>
        </el-table>
      </div>
      <div v-if="viewMode === 'current'" class="change-cards">
        <article v-for="item in currentPrices" :key="item.priceKey">
          <header><strong>{{ item.countryCode }} · {{ item.sku }}</strong><el-tag size="small">{{ item.priceValue }}</el-tag></header>
          <p>{{ item.productNameCn || "未匹配中文名" }}</p>
          <div><span>{{ platformLabels[item.platform] }} · {{ shopLabels[item.shopType] }} · {{ priceTypeLabels[item.priceType] }}</span><strong>{{ item.sourceApplyNo }}</strong></div>
        </article>
        <el-empty v-if="!currentPrices.length" description="尚未获取控价" :image-size="72" />
      </div>
      <div v-else class="change-cards">
        <article v-for="item in changes" :key="item.id" @click="showDetail(item)">
          <header><strong>{{ item.countryCode }} · {{ item.sku }}</strong><span class="mobile-tags"><el-tag :type="directionTag(item.direction)" size="small">{{ directionLabels[item.direction] }}</el-tag><el-tag :type="item.adjustmentStatus === 'ADJUSTED' ? 'success' : 'info'" size="small" effect="plain">{{ adjustmentLabel(item.adjustmentStatus) }}</el-tag></span></header>
          <p>{{ item.productNameCn || "未匹配中文名" }}</p>
          <div><span>{{ platformLabels[item.platform] }} · {{ shopLabels[item.shopType] }} · {{ priceTypeLabels[item.priceType] }}</span><strong>{{ item.oldPrice ?? "无价格" }} → {{ item.newPrice ?? "无价格" }}</strong></div>
          <div class="mobile-card-actions"><small>{{ item.adjustmentRemark || "暂无处理备注" }}</small><el-button size="small" :icon="MessageSquareText" @click.stop="openAdjustment(item)">更新处理</el-button></div>
        </article>
        <el-empty v-if="!changes.length" description="暂无控价变更" :image-size="72" />
      </div>
      <footer class="price-pagination"><el-pagination v-model:current-page="query.page" v-model:page-size="query.page_size" :total="total" :page-sizes="[20, 50, 100]" layout="sizes, prev, pager, next" background @current-change="load()" @size-change="load({ resetPage: true })" /></footer>
    </section>

    <el-dialog
      v-model="repricingDialogOpen"
      class="repricing-dialog"
      width="min(1120px, 96vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!repricingLoading"
      @closed="cancelRepricingPoll"
    >
      <template #header>
        <div class="repricing-dialog-header">
          <div>
            <span class="panel-kicker">HUMAN-CONFIRMED REPRICING</span>
            <h3>马帮实际调价预览</h3>
          </div>
          <ol class="repricing-steps" aria-label="调价流程">
            <li :class="{ active: repricingStep === 'shops', done: repricingStep !== 'shops' }"><b>1</b><span>按国家选店</span></li>
            <li :class="{ active: repricingStep === 'preview', done: repricingStep === 'execution' }"><b>2</b><span>核对实际差异</span></li>
            <li :class="{ active: repricingStep === 'execution' }"><b>3</b><span>人工确认执行</span></li>
          </ol>
        </div>
      </template>

      <div v-if="repricingLoading && repricingStep === 'shops'" class="repricing-skeleton" aria-live="polite">
        <el-skeleton :rows="6" animated />
      </div>

      <template v-else-if="repricingStep === 'shops'">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="店铺候选范围只来自数据库中同平台、同国家的有效马帮授权店铺。系统不会根据店名猜国家，也不会自动选择未分类店铺。"
        />
        <div class="repricing-scope-list">
          <section v-for="change in selectedChanges" :key="change.id" class="repricing-scope-row">
            <header>
              <div class="repricing-change-identity">
                <strong>{{ change.countryCode }} · {{ change.sku }}</strong>
                <span>{{ platformLabels[change.platform] }} · {{ shopLabels[change.shopType] }} · {{ priceTypeLabels[change.priceType] }}</span>
              </div>
              <div class="price-delta"><span>{{ change.oldPrice ?? "无价格" }}</span><b>→</b><strong>{{ change.newPrice ?? "无价格" }}</strong></div>
            </header>
            <el-checkbox-group v-model="repricingAssignments[change.id]" class="repricing-shop-grid">
              <el-checkbox
                v-for="shop in availableShopsFor(change)"
                :key="shop.id"
                :value="shop.id"
                border
                :disabled="!['UNKNOWN', 'ALL', change.shopType].includes(shop.controlShopType)"
              >
                <span class="repricing-shop-label"><Store :size="15" /><b>{{ shop.shopName }}</b><small>{{ shop.controlShopType === 'UNKNOWN' ? '类型待确认' : shop.controlShopType }}</small></span>
              </el-checkbox>
            </el-checkbox-group>
            <el-empty v-if="!availableShopsFor(change).length" description="该平台和国家没有可用授权店铺" :image-size="54" />
          </section>
        </div>
      </template>

      <template v-else-if="repricingStep === 'preview' && repricingPlan">
        <div class="repricing-preview-summary">
          <div><span>目标店铺</span><strong>{{ repricingPlan.targetShopCount }}</strong></div>
          <div><span>实际差异</span><strong>{{ repricingPlan.listingChangeCount }}</strong></div>
          <div><span>执行通道</span><strong>{{ repricingPlan.executionProvider === 'MABANG_LISTING' ? '马帮刊登' : '平台 API' }}</strong></div>
          <div><span>预览有效期</span><strong>{{ formatDate(repricingPlan.previewExpiresAt) }}</strong></div>
        </div>
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="以下旧值来自马帮实时商品详情。只有勾选的差异会被提交；提交时马帮会再次读取旧值，已变化的商品不会被覆盖。"
        />
        <div v-if="repricingPlan.warnings.length" class="repricing-warning-list" role="alert">
          <TriangleAlert :size="18" />
          <ul><li v-for="warning in repricingPlan.warnings" :key="warning">{{ warning }}</li></ul>
        </div>
        <div class="repricing-selection-toolbar">
          <el-checkbox
            :model-value="repricingAllItemsSelected"
            :indeterminate="repricingSelectionIndeterminate"
            @change="toggleAllRepricingItems"
          >我已核对并选择全部实际差异</el-checkbox>
          <span>默认不选择；也可在下表逐条勾选。</span>
        </div>
        <el-checkbox-group v-model="repricingSelectedItemIds">
          <el-table :data="repricingPlan.items" row-key="id" max-height="360" class="repricing-preview-table">
            <el-table-column width="52" fixed>
              <template #default="scope"><el-checkbox :value="scope.row.id" :aria-label="`选择 ${scope.row.shopName} ${scope.row.sku} 调价差异`" /></template>
            </el-table-column>
            <el-table-column label="店铺" min-width="180"><template #default="scope"><div class="stacked-cell"><strong>{{ scope.row.shopName }}</strong><span>{{ scope.row.countryCode }} · {{ platformLabels[scope.row.platform] }}</span></div></template></el-table-column>
            <el-table-column label="控价 SKU / 实际 SKU" min-width="190">
              <template #default="scope">
                <div class="stacked-cell">
                  <strong>{{ scope.row.sku }}</strong>
                  <span v-if="scope.row.matchedSku !== scope.row.sku">实际：{{ scope.row.matchedSku }} · 虚拟匹配</span>
                  <span v-else>实际 SKU 精确匹配</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="字段" width="120"><template #default="scope">{{ scope.row.targetField === 'price' ? '原价 / 售价' : '促销价' }}</template></el-table-column>
            <el-table-column label="实时差异" min-width="190"><template #default="scope"><div class="price-delta"><span>{{ scope.row.oldValue ?? '无价格' }}</span><b>→</b><strong>{{ scope.row.newValue ?? '无价格' }}</strong></div></template></el-table-column>
            <el-table-column label="店铺类型" width="120"><template #default="scope"><el-tag :type="scope.row.controlShopType === 'UNKNOWN' ? 'warning' : 'info'" effect="plain">{{ scope.row.controlShopType === 'UNKNOWN' ? '待人工确认' : scope.row.controlShopType }}</el-tag></template></el-table-column>
          </el-table>
        </el-checkbox-group>
        <el-collapse class="repricing-instruction-collapse">
          <el-collapse-item title="查看交给 AI 解析的自然语言指令" name="instruction">
            <pre>{{ repricingPlan.instructionText }}</pre>
          </el-collapse-item>
        </el-collapse>
        <div class="repricing-confirm-box">
          <div>
            <strong>最终人工确认</strong>
            <p>请逐条核对店铺、SKU、实时旧价和目标新价。输入指定文本后，才会向马帮提交执行。</p>
          </div>
          <el-input v-model="repricingConfirmationText" maxlength="8" autocomplete="off" placeholder="请输入：确认同步到店铺" aria-label="调价执行确认文本" />
          <el-checkbox v-if="repricingHasUnknownShopTypes" v-model="repricingUnknownAcknowledged">
            我已人工核对未分类店铺的 Standard / Mall 类型，确认所选控价适用于这些店铺
          </el-checkbox>
        </div>
      </template>

      <template v-else-if="repricingStep === 'execution' && repricingPlan">
        <div class="repricing-execution-state" :class="repricingPlan.status.toLowerCase()" aria-live="polite">
          <CheckCircle2 v-if="repricingPlan.status === 'SUCCEEDED'" :size="28" />
          <RefreshCw v-else-if="repricingPlan.status === 'EXECUTING'" :size="28" class="spin" />
          <TriangleAlert v-else :size="28" />
          <div><span>计划 {{ repricingPlan.id }}</span><strong>{{ repricingPlan.status }}</strong><p>{{ repricingPlan.errorMessage || '任务状态由马帮执行和平台回读结果驱动。' }}</p></div>
        </div>
        <el-table :data="repricingPlan.items.filter((item) => item.selected)" max-height="380">
          <el-table-column prop="shopName" label="店铺" min-width="180" />
          <el-table-column label="控价 SKU / 实际 SKU" min-width="190">
            <template #default="scope"><div class="stacked-cell"><strong>{{ scope.row.sku }}</strong><span>{{ scope.row.matchedSku === scope.row.sku ? '精确匹配' : `实际：${scope.row.matchedSku}` }}</span></div></template>
          </el-table-column>
          <el-table-column label="差异" min-width="180"><template #default="scope"><div class="price-delta"><span>{{ scope.row.oldValue }}</span><b>→</b><strong>{{ scope.row.newValue }}</strong></div></template></el-table-column>
          <el-table-column label="结果" width="150"><template #default="scope"><el-tag :type="scope.row.status === 'SUCCEEDED' ? 'success' : scope.row.status === 'FAILED' ? 'danger' : 'info'">{{ scope.row.status }}</el-tag></template></el-table-column>
        </el-table>
      </template>

      <template #footer>
        <div class="repricing-dialog-footer">
          <span v-if="repricingStep === 'preview'">已选择 {{ repricingSelectedItemIds.length }} / {{ repricingPlan?.items.length || 0 }} 条实际差异</span>
          <span v-else-if="repricingStep === 'execution'">关闭窗口不会中断已提交的马帮任务</span>
          <span v-else>已选择 {{ selectedChanges.length }} 条控价变更</span>
          <div>
            <el-button :disabled="repricingLoading" @click="repricingDialogOpen = false">关闭</el-button>
            <el-button v-if="repricingStep === 'shops'" type="primary" :loading="repricingLoading" @click="generateRepricingPreview">读取马帮并生成实际差异</el-button>
            <el-button v-else-if="repricingStep === 'preview'" type="danger" :loading="repricingLoading" :disabled="!repricingCanConfirm" @click="confirmRepricingExecution">确认并同步到店铺后台</el-button>
            <el-button v-else-if="repricingPlan && ['EXECUTING', 'EXECUTION_UNKNOWN'].includes(repricingPlan.status)" :loading="repricingLoading" @click="pollRepricingPlan">刷新任务状态</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="控价变更文本" size="min(680px, 96vw)">
      <template v-if="detail">
        <div class="change-text"><p>{{ detail.changeText }}</p><div class="detail-actions"><el-button type="primary" :icon="Clipboard" @click="copyText(detail)">复制完整文本</el-button><el-button :icon="MessageSquareText" @click="openAdjustment(detail)">更新处理状态</el-button></div></div>
        <dl class="change-detail-grid">
          <template v-for="item in [
            ['国家', detail.countryCode], ['类目', detail.categoryName || '未匹配'], ['SKU', detail.sku], ['商品中文名', detail.productNameCn || '未匹配'],
            ['平台', platformLabels[detail.platform]], ['店铺类型', shopLabels[detail.shopType]], ['价格类型', priceTypeLabels[detail.priceType]],
            ['原价', detail.oldPrice ?? '无价格'], ['现价', detail.newPrice ?? '无价格'], ['方向', directionLabels[detail.direction]],
            ['处理状态', adjustmentLabel(detail.adjustmentStatus)], ['处理备注', detail.adjustmentRemark || '—'], ['处理时间', formatDate(detail.adjustmentUpdatedAt)],
            ['申请批次', detail.sourceApplyNo], ['Foundation 任务', detail.foundationTaskId || '—'], ['发现时间', formatDate(detail.detectedAt)],
          ]" :key="String(item[0])"><dt>{{ item[0] }}</dt><dd>{{ item[1] }}</dd></template>
        </dl>
      </template>
    </el-drawer>

    <el-dialog v-model="adjustmentDialogOpen" title="更新控价变更处理状态" width="min(560px, 94vw)" :close-on-click-modal="!adjustmentSaving">
      <template v-if="adjustmentTarget">
        <div class="adjustment-context">
          <strong>{{ adjustmentTarget.countryCode }} · {{ adjustmentTarget.sku }} · {{ platformLabels[adjustmentTarget.platform] }}</strong>
          <p>{{ adjustmentTarget.changeText }}</p>
        </div>
        <el-form label-position="top" class="adjustment-form">
          <el-form-item label="处理状态">
            <el-radio-group v-model="adjustmentForm.status">
              <el-radio-button value="UNADJUSTED">未调整</el-radio-button>
              <el-radio-button value="ADJUSTED"><CheckCircle2 :size="15" />已调整</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="处理备注">
            <el-input v-model="adjustmentForm.remark" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="例如：已在马帮调整并完成店铺复核；或记录暂未调整的原因" />
          </el-form-item>
          <el-alert type="info" :closable="false" show-icon title="保存后会记录操作人和时间，并写入关联 Foundation 任务证据与 Operation Audit。" />
        </el-form>
      </template>
      <template #footer><el-button :disabled="adjustmentSaving" @click="adjustmentDialogOpen = false">取消</el-button><el-button type="primary" :loading="adjustmentSaving" @click="saveAdjustment">保存处理状态</el-button></template>
    </el-dialog>

    <el-drawer v-model="automationDrawerOpen" title="控价定时获取与钉钉提醒" size="min(620px, 96vw)">
      <el-alert v-if="!automation.ready" type="warning" :closable="false" show-icon title="定时功能数据库迁移尚未完成，当前不能启用。" />
      <el-alert v-else-if="demoMode" type="info" :closable="false" show-icon title="演示模式只展示配置界面，不会保存设置或发送消息。" />
      <div class="automation-status-grid">
        <div><span>当前状态</span><strong>{{ automation.settings?.enabled ? "运行中" : "未开启" }}</strong></div>
        <div><span>下次获取</span><strong>{{ formatDate(automation.settings?.nextRunAt) }}</strong></div>
        <div><span>上次结果</span><strong>{{ automation.settings?.lastRunStatus || "—" }}</strong></div>
        <div><span>钉钉结果</span><strong>{{ automation.settings?.lastNotificationStatus || "—" }}</strong></div>
      </div>
      <el-form class="automation-form" label-position="top">
        <el-form-item label="启用定时获取"><el-switch v-model="automationForm.enabled" /></el-form-item>
        <el-form-item label="获取间隔">
          <el-select v-model="automationForm.intervalMinutes">
            <el-option label="每 30 分钟" :value="30" />
            <el-option label="每 1 小时（默认）" :value="60" />
            <el-option label="每 2 小时" :value="120" />
            <el-option label="每 6 小时" :value="360" />
            <el-option label="每 12 小时" :value="720" />
          </el-select>
        </el-form-item>
        <el-form-item label="钉钉机器人">
          <div class="robot-picker">
            <el-select v-model="automationForm.dingtalkConfigId" placeholder="选择接收控价提醒的机器人" clearable>
              <el-option v-for="robot in automation.robots" :key="robot.id" :label="robot.name" :value="robot.id" />
            </el-select>
            <el-button @click="openRobotDialog">新建机器人</el-button>
            <el-button :disabled="demoMode || !automationForm.dingtalkConfigId" @click="testSelectedRobot">发送测试</el-button>
          </div>
        </el-form-item>
        <el-form-item label="提醒规则">
          <div class="automation-switches">
            <el-checkbox v-model="automationForm.notifyOnChange">发现新变更时发送</el-checkbox>
            <el-checkbox v-model="automationForm.notifyOnFailure">定时获取失败时发送</el-checkbox>
          </div>
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon title="无价格变化时不发送消息；发现变化后只创建人工复核任务，不会自动修改马帮或平台价格。" />
      </el-form>
      <template #footer>
        <el-button @click="automationDrawerOpen = false">取消</el-button>
        <el-button type="primary" :loading="automationSaving" :disabled="demoMode || !automation.ready" @click="saveAutomationSettings">保存设置</el-button>
      </template>
    </el-drawer>

    <el-dialog v-model="robotDialogOpen" title="新建钉钉机器人" width="min(560px, 94vw)">
      <el-alert type="info" :closable="false" show-icon title="Webhook 和加签密钥仅在服务端加密保存，不会返回浏览器。" />
      <el-form class="robot-form" label-position="top">
        <el-form-item label="机器人名称"><el-input v-model="robotForm.name" maxlength="80" placeholder="例如：控价变更提醒机器人" /></el-form-item>
        <el-form-item label="Webhook"><el-input v-model="robotForm.webhookUrl" type="textarea" :rows="3" placeholder="钉钉官方自定义机器人 Webhook" /></el-form-item>
        <el-form-item label="加签密钥"><el-input v-model="robotForm.secret" type="password" show-password placeholder="选填；机器人启用加签时填写" /></el-form-item>
        <el-form-item label="@手机号"><el-input v-model="robotForm.atMobiles" placeholder="选填，多个手机号用逗号分隔" /></el-form-item>
        <el-form-item><el-checkbox v-model="robotForm.atAll">提醒所有人</el-checkbox></el-form-item>
      </el-form>
      <template #footer><el-button @click="robotDialogOpen = false">取消</el-button><el-button type="primary" :loading="robotSaving" :disabled="demoMode" @click="saveRobot">保存机器人</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.price-control-page { display: grid; gap: 16px; }
.price-toolbar { align-items: flex-start; }
.price-filter-grid { flex: 1; display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 8px; }
.round-filter { grid-column: span 2; }
.round-quick-filter { grid-column: span 2; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border: 1px solid var(--ops-border-light); border-radius: var(--el-border-radius-base); background: var(--ops-surface); }
.round-quick-filter > span { flex: 0 0 auto; color: var(--ops-text-secondary); font-size: 12px; font-weight: 600; }
.round-quick-filter :deep(.el-radio-group) { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); flex: 1; }
.round-quick-filter :deep(.el-radio-button__inner) { width: 100%; min-height: 38px; }
.change-round-strip { display: grid; grid-template-columns: minmax(260px,1.6fr) repeat(4,minmax(100px,.65fr)) auto; align-items: center; gap: 0; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); overflow: hidden; }
.change-round-strip > div { min-height: 82px; display: grid; align-content: center; gap: 4px; padding: 12px 16px; border-right: 1px solid var(--ops-border-light); }
.change-round-strip > .round-title { grid-template-columns: 1fr; }.change-round-strip span,.change-round-strip small { color: var(--ops-text-secondary); font-size: 11px; }.change-round-strip strong { font-size: 19px; font-variant-numeric: tabular-nums; }.change-round-strip .round-title strong { font-size: 14px; }.change-round-strip strong.pending { color: var(--ops-warning); }.change-round-strip strong.completed { color: var(--ops-success); }.change-round-strip > .el-button { margin: 0 14px; min-height: 40px; }
.connection-strip { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)) auto; align-items: center; gap: 0; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); }
.connection-strip > div:not(.connection-actions) { min-height: 78px; display: grid; grid-template-columns: auto 1fr; align-content: center; gap: 3px 8px; padding: 12px 16px; border-right: 1px solid var(--ops-border-light); }
.connection-strip svg { grid-row: 1 / 3; color: var(--ops-primary); align-self: center; }
.connection-strip span { color: var(--ops-text-secondary); font-size: 11px; }.connection-strip strong { font-size: 13px; }
.connection-strip small { grid-column: 2; color: var(--ops-text-muted); font-size: 10px; }
.connection-actions { display: flex; gap: 8px; padding: 12px; }
.price-summary-strip { display: grid; grid-template-columns: repeat(5, .8fr) 1.4fr; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.price-summary-strip > div { min-height: 88px; display: grid; align-content: center; gap: 5px; padding: 13px 17px; border-right: 1px solid var(--ops-border-light); }
.price-summary-strip > div:last-child { border-right: 0; }.price-summary-strip span { color: var(--ops-text-secondary); font-size: 11px; }
.price-summary-strip strong { display: flex; align-items: center; gap: 4px; font-size: 22px; font-variant-numeric: tabular-nums; }.price-summary-strip strong.up { color: var(--ops-danger); }.price-summary-strip strong.down { color: var(--ops-success); }.price-summary-strip strong.date { font-size: 13px; }
.price-table-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); }
.table-heading-actions { display: flex; align-items: center; gap: 14px; }
.stacked-cell { display: grid; gap: 3px; }.stacked-cell span { color: var(--ops-text-secondary); font-size: 11px; }
.price-delta { display: flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }.price-delta span { color: var(--ops-text-secondary); text-decoration: line-through; }.price-delta b { color: var(--ops-text-muted); }.price-delta strong { color: var(--ops-text); }
.adjustment-state { display: grid; justify-items: start; gap: 5px; }.adjustment-state span { max-width: 140px; overflow: hidden; color: var(--ops-text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.price-pagination { display: flex; justify-content: flex-end; padding: 14px 16px; border-top: 1px solid var(--ops-border-light); }
.change-cards { display: none; }.change-text { padding: 16px; border-left: 3px solid var(--ops-primary); background: var(--ops-surface-muted); }.change-text p { margin: 0 0 14px; line-height: 1.8; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; }.adjustment-context { padding: 12px 14px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface-subtle); }.adjustment-context p { margin: 8px 0 0; color: var(--ops-text-secondary); font-size: 12px; line-height: 1.7; }.adjustment-form { margin-top: 18px; }.adjustment-form :deep(.el-radio-button__inner) { display: inline-flex; align-items: center; gap: 5px; min-height: 40px; }
.change-detail-grid { display: grid; grid-template-columns: 120px 1fr; margin: 20px 0 0; }.change-detail-grid dt, .change-detail-grid dd { margin: 0; padding: 11px 12px; border-bottom: 1px solid var(--ops-border-light); overflow-wrap: anywhere; }.change-detail-grid dt { color: var(--ops-text-secondary); font-size: 12px; }.change-detail-grid dd { font-weight: 600; }
.repricing-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-right: 28px; }.repricing-dialog-header h3 { margin: 3px 0 0; font-size: 20px; }.repricing-steps { display: flex; align-items: center; gap: 8px; margin: 0; padding: 0; list-style: none; }.repricing-steps li { display: flex; align-items: center; gap: 6px; color: var(--ops-text-muted); font-size: 12px; white-space: nowrap; }.repricing-steps li + li::before { width: 24px; height: 1px; margin-right: 2px; background: var(--ops-border); content: ""; }.repricing-steps b { display: grid; width: 24px; height: 24px; place-items: center; border: 1px solid var(--ops-border); border-radius: 50%; background: var(--ops-surface); font-size: 11px; }.repricing-steps li.active,.repricing-steps li.done { color: var(--ops-primary); }.repricing-steps li.active b,.repricing-steps li.done b { border-color: var(--ops-primary); background: var(--ops-primary); color: var(--el-color-white); }
.repricing-skeleton { min-height: 360px; padding: 24px 8px; }.repricing-scope-list { display: grid; gap: 12px; max-height: min(58vh, 620px); margin-top: 14px; padding-right: 4px; overflow-y: auto; }.repricing-scope-row { padding: 14px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); }.repricing-scope-row > header { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 12px; }.repricing-change-identity { display: grid; gap: 3px; }.repricing-change-identity strong { font-size: 14px; }.repricing-change-identity span { color: var(--ops-text-secondary); font-size: 11px; }.repricing-shop-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; }.repricing-shop-grid :deep(.el-checkbox) { width: 100%; min-height: 46px; margin: 0; padding: 7px 10px; }.repricing-shop-grid :deep(.el-checkbox__label) { min-width: 0; }.repricing-shop-label { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px; min-width: 0; }.repricing-shop-label b { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.repricing-shop-label small { color: var(--ops-text-muted); font-size: 10px; }
.repricing-preview-summary { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); margin-bottom: 12px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); overflow: hidden; }.repricing-preview-summary > div { display: grid; gap: 4px; min-height: 68px; padding: 11px 14px; border-right: 1px solid var(--ops-border-light); background: var(--ops-surface-subtle); }.repricing-preview-summary > div:last-child { border-right: 0; }.repricing-preview-summary span { color: var(--ops-text-secondary); font-size: 10px; }.repricing-preview-summary strong { font-size: 14px; font-variant-numeric: tabular-nums; }.repricing-warning-list { display: grid; grid-template-columns: auto 1fr; gap: 9px; margin: 10px 0; padding: 10px 12px; border: 1px solid var(--el-color-warning-light-5); border-radius: var(--ops-radius-md); background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); }.repricing-warning-list ul { display: grid; gap: 4px; margin: 0; padding-left: 17px; font-size: 12px; line-height: 1.5; }.repricing-selection-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding: 9px 12px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-sm); background: var(--ops-surface-subtle); }.repricing-selection-toolbar > span { color: var(--ops-text-secondary); font-size: 11px; }.repricing-preview-table { margin-top: 10px; border: 1px solid var(--ops-border-light); }.repricing-instruction-collapse { margin-top: 10px; }.repricing-instruction-collapse pre { max-height: 180px; margin: 0; padding: 12px; overflow: auto; border-radius: var(--ops-radius-sm); background: var(--ops-surface-muted); font: 12px/1.7 var(--ops-font-mono, monospace); white-space: pre-wrap; }.repricing-confirm-box { display: grid; grid-template-columns: minmax(280px,1.2fr) minmax(260px,.8fr); align-items: center; gap: 10px 16px; margin-top: 12px; padding: 14px; border: 1px solid var(--el-color-danger-light-5); border-radius: var(--ops-radius-md); background: var(--el-color-danger-light-9); }.repricing-confirm-box strong { font-size: 14px; }.repricing-confirm-box p { margin: 4px 0 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.5; }.repricing-confirm-box > .el-checkbox { grid-column: 1 / -1; white-space: normal; }.repricing-confirm-box :deep(.el-checkbox__label) { line-height: 1.5; white-space: normal; }
.repricing-execution-state { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; padding: 16px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface-subtle); }.repricing-execution-state > div { display: grid; gap: 3px; }.repricing-execution-state span { color: var(--ops-text-muted); font: 10px/1.4 var(--ops-font-mono,monospace); overflow-wrap: anywhere; }.repricing-execution-state strong { font-size: 20px; }.repricing-execution-state p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; }.repricing-execution-state.succeeded { border-color: var(--el-color-success-light-5); color: var(--el-color-success); }.repricing-execution-state.failed,.repricing-execution-state.partial,.repricing-execution-state.execution_unknown { border-color: var(--el-color-warning-light-5); color: var(--el-color-warning-dark-2); }.repricing-dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; }.repricing-dialog-footer > span { color: var(--ops-text-secondary); font-size: 11px; }.repricing-dialog-footer > div { display: flex; gap: 8px; }.spin { animation: repricing-spin 1s linear infinite; }@keyframes repricing-spin { to { transform: rotate(360deg); } }@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.automation-status-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; margin: 16px 0; }.automation-status-grid > div { display: grid; gap: 4px; padding: 12px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface-subtle); }.automation-status-grid span { color: var(--ops-text-secondary); font-size: 11px; }.automation-status-grid strong { font-size: 13px; overflow-wrap: anywhere; }.automation-form,.robot-form { margin-top: 18px; }.automation-form :deep(.el-select),.robot-picker :deep(.el-select) { width: 100%; }.robot-picker { width: 100%; display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 8px; }.automation-switches { display: flex; flex-wrap: wrap; gap: 16px; }
@media (max-width: 1180px) { .price-toolbar { align-items: stretch; flex-direction: column; }.price-filter-grid { grid-template-columns: repeat(3, minmax(0,1fr)); }.change-round-strip { grid-template-columns: repeat(3,minmax(0,1fr)); }.change-round-strip > .round-title { grid-column: span 2; }.change-round-strip > .el-button { margin: 12px; }.connection-strip { grid-template-columns: repeat(2, minmax(0,1fr)); }.connection-strip > div:nth-child(even):not(.connection-actions) { border-right: 0; }.connection-actions { grid-column: 1 / -1; justify-content: flex-end; }.price-summary-strip { grid-template-columns: repeat(3, minmax(0,1fr)); }.price-summary-strip > div:nth-child(3n) { border-right: 0; } }
@media (max-width: 720px) { .price-filter-grid { grid-template-columns: 1fr; }.round-filter,.round-quick-filter { grid-column: span 1; }.round-quick-filter { align-items: stretch; flex-direction: column; gap: 6px; padding: 8px; }.round-quick-filter :deep(.el-radio-button__inner) { min-height: 44px; }.change-round-strip { grid-template-columns: repeat(2,minmax(0,1fr)); }.change-round-strip > .round-title { grid-column: 1 / -1; }.change-round-strip > div { border-bottom: 1px solid var(--ops-border-light); }.change-round-strip > .el-button { grid-column: 1 / -1; min-height: 44px; }.connection-strip { grid-template-columns: 1fr; }.connection-strip > div:not(.connection-actions) { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }.connection-actions { display: grid; grid-template-columns: 1fr 1fr; }.connection-actions .el-button:first-child { grid-column: 1 / -1; }.price-summary-strip { grid-template-columns: repeat(2,minmax(0,1fr)); }.price-summary-strip > div { border-bottom: 1px solid var(--ops-border-light); }.price-summary-strip > div:nth-child(even) { border-right: 0; }.price-summary-strip > div:last-child { border-bottom: 0; }.table-heading-actions { align-items: flex-end; flex-direction: column; gap: 6px; }.desktop-table { display: none; }.change-cards { display: grid; gap: 8px; padding: 12px; }.change-cards article { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); cursor: pointer; }.change-cards article header, .change-cards article div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }.change-cards p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; }.change-cards article div { align-items: flex-end; }.change-cards article div span { font-size: 10px; color: var(--ops-text-muted); }.change-cards article div strong { font-variant-numeric: tabular-nums; }.change-cards .mobile-tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }.change-cards .mobile-card-actions { align-items: center; padding-top: 4px; border-top: 1px solid var(--ops-border-light); }.change-cards .mobile-card-actions small { color: var(--ops-text-secondary); overflow-wrap: anywhere; }.change-cards .mobile-card-actions .el-button { min-height: 44px; }.price-pagination { overflow-x: auto; justify-content: flex-start; }.change-detail-grid,.automation-status-grid,.robot-picker,.repricing-shop-grid,.repricing-preview-summary,.repricing-confirm-box { grid-template-columns: 1fr; }.repricing-dialog-header { align-items: flex-start; flex-direction: column; padding-right: 20px; }.repricing-steps { width: 100%; overflow-x: auto; }.repricing-steps li + li::before { width: 10px; }.repricing-scope-row > header,.repricing-dialog-footer,.repricing-selection-toolbar { align-items: stretch; flex-direction: column; }.repricing-preview-summary > div { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }.repricing-preview-summary > div:last-child { border-bottom: 0; }.repricing-dialog-footer > div { display: grid; width: 100%; }.repricing-dialog-footer .el-button { min-height: 44px; margin: 0; } }
</style>
