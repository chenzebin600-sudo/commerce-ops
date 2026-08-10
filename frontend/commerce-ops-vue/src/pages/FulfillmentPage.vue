<script setup lang="ts">
import { CircleAlert, FileUp, KeyRound, MessageSquareText, Pause, Play, RefreshCw, RotateCcw, Settings2, ShieldCheck, Sparkles, Store, Truck } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import MetricCard from "@/components/MetricCard.vue";
import { connectMabangAccount, loadMabangAccounts, type MabangAccount } from "@/services/mabang";
import {
  batchUpdateFulfillmentShopPolicies,
  confirmFulfillmentPolicySuggestions,
  confirmFulfillmentPolicyImport,
  loadFulfillmentSettings,
  loadFulfillmentScheduler,
  loadFulfillmentWorkspace,
  loadMessageReviewCandidates,
  pauseFulfillmentQueue,
  previewFulfillmentPolicyImport,
  recoverMessageReviewOrder,
  runFulfillmentScan,
  resumeFulfillmentQueue,
  saveMessageReviewMode,
  saveFulfillmentShopPolicy,
  scanFulfillmentPolicySuggestions,
  selectFulfillmentAccount,
  syncFulfillmentCatalog,
  type FulfillmentBatch,
  type FulfillmentDashboard,
  type FulfillmentHealth,
  type FulfillmentPolicyImportPreview,
  type FulfillmentPolicyImportRow,
  type FulfillmentRecovery,
  type FulfillmentScheduler,
  type FulfillmentSettings,
  type FulfillmentShopPolicy,
  type MessageReviewCandidate,
  type MessageReviewMode,
} from "@/services/overview";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const scanning = ref(false);
const controllingQueue = ref(false);
const syncing = ref(false);
const suggesting = ref(false);
const confirmingSuggestions = ref(false);
const updatingBatchPolicies = ref(false);
const importingPolicy = ref(false);
const confirmingPolicyImport = ref(false);
const connecting = ref(false);
const savingPolicy = ref(false);
const loadingMessageReviews = ref(false);
const savingMessageReviewMode = ref(false);
const recoveringMessageReviewOrderId = ref("");
const messageReviewError = ref("");
const error = ref("");
const activeTab = ref("recoveries");
const health = ref<FulfillmentHealth | null>(null);
const scheduler = ref<FulfillmentScheduler | null>(null);
const dashboard = ref<FulfillmentDashboard | null>(null);
const settings = ref<FulfillmentSettings | null>(null);
const batches = ref<FulfillmentBatch[]>([]);
const recoveries = ref<FulfillmentRecovery[]>([]);
const accounts = ref<MabangAccount[]>([]);
const messageReviewCandidates = ref<MessageReviewCandidate[]>([]);
const shopSearch = ref("");
const countryFilter = ref("");
const platformFilter = ref("");
const showNoHistoryShops = ref(false);
const accountDialog = ref(false);
const policyDrawer = ref(false);
const policyImportDialog = ref(false);
const policyImportPreview = ref<FulfillmentPolicyImportPreview | null>(null);
const policyImportOverwrite = ref(false);
const selectedPolicyImportRowIds = ref<string[]>([]);
const policyImportTable = ref<{ clearSelection: () => void; toggleRowSelection: (row: FulfillmentPolicyImportRow, selected: boolean) => void } | null>(null);
const shopTable = ref<{ clearSelection: () => void; toggleRowSelection: (row: FulfillmentSettings["shops"][number], selected: boolean) => void } | null>(null);
const selectedSuggestionShopIds = ref<string[]>([]);
const selectedShopIds = ref<string[]>([]);
const accountForm = reactive({ username: "", password: "" });
const policyForm = reactive({ shopId: "", shopName: "", mode: "manual" as FulfillmentShopPolicy["mode"], channelId: "",
  warehousePolicy: "allowlist" as FulfillmentShopPolicy["warehousePolicy"], allowedWarehouses: [] as string[],
  minOrderAgeMinutes: 10, maxBatchSize: 2 });
const batchPolicyForm = reactive({ mode: "" as "" | FulfillmentShopPolicy["mode"],
  minOrderAgeMinutes: "" as "" | number, maxBatchSize: "" as "" | number });
const messageReviewModes: Array<{ value: MessageReviewMode; label: string; description: string }> = [
  { value: "off", label: "关闭", description: "只展示候选，不允许恢复订单" },
  { value: "manual", label: "人工确认", description: "逐单确认后恢复并进入推单流程" },
  { value: "auto", label: "自动处理", description: "全部安全检查通过后自动恢复" },
];

interface FulfillmentTotals { total: number; success: number; running: number; exceptions: number }
const labels: Record<string, string> = {
  ORDER_NOT_MATURE: "等待自动发货", ORDER_AGE_UNKNOWN: "付款时间待确认", MULTI_WAREHOUSE: "订单商品来自多个仓库",
  MULTI_WAREHOUSE_REQUIRES_REVIEW: "普通商品来自多个履约仓库", GIFT_ONLY_ORDER_NOT_ALLOWED: "赠品不可单独销售", OUT_OF_STOCK: "商品库存不足", INVENTORY_UNKNOWN: "暂时无法确认库存",
  INVENTORY_UNKNOWN_BEFORE_SUBMIT: "发货前无法确认库存", WAREHOUSE_NOT_ALLOWED: "订单仓库未开启自动发货",
  PRODUCT_PREFIX_WAREHOUSE_MISMATCH: "商品前缀与分配仓库不匹配",
  PRODUCT_PREFIX_WAREHOUSE_MISMATCH_BEFORE_SUBMIT: "发货前发现商品前缀与仓库不匹配",
  CHANNEL_MISMATCH: "默认快递渠道不适用", CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT: "默认快递渠道暂不可用",
  SERVICE_RESTARTED_DURING_BATCH: "发货过程中服务重启", ALREADY_FULFILLED: "订单已经发货",
  preview_created: "检查完成，等待确认", auto_fulfillment_started: "自动发货已开始", no_eligible_orders: "暂无可自动发货订单",
  skipped_pending_preview: "已有检查结果等待确认", skipped_active_batch: "正在处理上一轮订单", scan_failed: "订单检查失败",
  partial_scan_failed: "部分店铺检查失败", queued: "等待发货", running: "正在发货", success: "发货成功", failed: "发货失败",
  needs_attention: "需要人工处理", manual_review: "需要人工处理", pending: "等待处理", completed: "处理完成", released: "已解除拦截",
  waiting_tracking: "等待马帮确认", awaiting_redistribution: "等待重新交运", checking: "正在重新检查", reset_pending: "准备重新处理",
  released_unsubmitted: "已确认未发货", recovered: "已恢复",
  MISSING_ORDER_ID: "订单编号缺失", SHOP_NOT_CONFIGURED: "店铺未配置", PLATFORM_MISMATCH: "平台不匹配",
  HAS_TRACKING_NUMBER: "已有运单号", NOT_MESSAGE_ONLY_ABNORMAL: "不止留言异常", INVENTORY_FLAG_UNSAFE: "库存标志不安全",
  ORDER_DETAILS_MISSING: "订单明细缺失", STATUS_NOT_REVIEW: "已不在待审核", MULTI_OR_UNKNOWN_WAREHOUSE: "多仓或仓库未知",
  INVENTORY_INSUFFICIENT_OR_UNKNOWN: "库存不足或无法确认",
};

const issueRules = [
  { keys: ["SERVICE_RESTARTED_DURING_BATCH"], title: "发货过程中服务重启", nextStep: "请先到马帮核对该订单是否已生成运单；不要重复发货。" },
  { keys: ["OUT_OF_STOCK"], title: "商品库存不足", nextStep: "请补充库存或在马帮调整订单，系统下次检查时会重新判断。" },
  { keys: ["INVENTORY_UNKNOWN"], title: "暂时无法确认库存", nextStep: "为避免错发，系统已停止；请核对马帮库存后等待系统重新检查。" },
  { keys: ["MULTI_WAREHOUSE"], title: "订单商品来自多个仓库", nextStep: "该订单不会自动发货，请到马帮拆分或人工处理。" },
  { keys: ["WAREHOUSE_NOT_ALLOWED"], title: "订单仓库未开启自动发货", nextStep: "请检查店铺的可自动发货仓库设置。" },
  { keys: ["PRODUCT_PREFIX_WAREHOUSE_MISMATCH"], title: "商品前缀与分配仓库不匹配", nextStep: "该订单不会自动发货，请先到马帮按商品前缀人工换仓。" },
  { keys: ["CHANNEL_MISMATCH", "CHANNEL_NOT_AVAILABLE"], title: "默认快递渠道暂不可用", nextStep: "请检查店铺的默认快递渠道，确认后等待系统重新检查。" },
  { keys: ["ORDER_NOT_MATURE"], title: "订单正在等待自动发货", nextStep: "无需操作，达到付款等待时间后系统会自动处理。" },
];

const totals = computed(() => (dashboard.value?.shops || []).reduce<FulfillmentTotals>((result, shop) => ({
  total: result.total + Number(shop.total || 0), success: result.success + Number(shop.success || 0),
  running: result.running + Number(shop.running || 0), exceptions: result.exceptions + Number(shop.exceptions || 0),
}), { total: 0, success: 0, running: 0, exceptions: 0 }));
const exceptionSummary = computed(() => Object.entries((dashboard.value?.exceptions || []).reduce<Record<string, number>>((result, item) => {
  const code = item.code || "UNKNOWN"; result[code] = (result[code] || 0) + Number(item.count || 0); return result;
}, {})).map(([code, count]) => ({ code, count })));
const deferredCount = computed(() => exceptionSummary.value.find((item) => item.code === "ORDER_NOT_MATURE")?.count || 0);
const attentionCount = computed(() => exceptionSummary.value.filter((item) => !["ORDER_NOT_MATURE", "ALREADY_FULFILLED"].includes(item.code))
  .reduce((sum, item) => sum + item.count, 0));
const pendingRecoveries = computed(() => recoveries.value.filter((item) => !/^(completed|released|success|recovered)/.test(String(item.status || ""))));
const dispatchQueue = computed(() => scheduler.value?.dispatchQueue || null);
const catchUp = computed(() => scheduler.value?.catchUp || null);
const queueActive = computed(() => Number(dispatchQueue.value?.queued || 0) + Number(dispatchQueue.value?.running || 0) > 0);
const queueStateText = computed(() => dispatchQueue.value?.paused ? "安全暂停"
  : catchUp.value?.active ? "积压恢复中" : dispatchQueue.value?.draining || queueActive.value ? "连续处理中" : "等待新订单");
const queueTagType = computed(() => dispatchQueue.value?.paused ? "danger" : catchUp.value?.active || queueActive.value ? "warning" : "success");
const restartReconciledCount = computed(() => (scheduler.value?.lastRestartReconciliations || [])
  .reduce((sum, item) => sum + Number(item.completed?.length || 0) + Number(item.trackingRecovery?.length || 0), 0));
const messageReviewMode = computed<MessageReviewMode>(() => settings.value?.messageReviewRecovery?.mode
  || (health.value?.messageReviewRecoveryEnabled ? "auto" : "manual"));
const eligibleMessageReviews = computed(() => messageReviewCandidates.value.filter((item) => item.eligible));
const blockedMessageReviews = computed(() => messageReviewCandidates.value.filter((item) => !item.eligible));
const connected = computed(() => Boolean(settings.value?.account.connected));
const currentPolicyShop = computed(() => settings.value?.shops.find((shop) => shop.id === policyForm.shopId));
const policyModeOptions = computed(() => [
  { label: "暂停自动发货", value: "paused" },
  { label: "只检查不发货", value: "manual" },
  { label: "自动发货", value: "auto", disabled: !currentPolicyShop.value?.autoFulfillAuthorized },
]);
const availableChannels = computed(() => (settings.value?.channels || []).filter((channel) => channel.active));
const pendingSuggestionCount = computed(() => (settings.value?.shops || []).filter((shop) => shop.suggestion?.needsReview).length);
const noHistoryShop = (shop: FulfillmentSettings["shops"][number]) => shop.policy.updatedBy === "catalog_sync"
  && shop.suggestion?.status === "insufficient_history";
const noHistoryShopCount = computed(() => (settings.value?.shops || []).filter(noHistoryShop).length);
const shopCountries = computed(() => [...new Set((settings.value?.shops || []).map((shop) => shop.countryCode || "__UNKNOWN__"))].sort());
const shopPlatforms = computed(() => [...new Set((settings.value?.shops || []).map((shop) => shop.platform).filter(Boolean))].sort());
const matchingShops = computed(() => (settings.value?.shops || []).filter((shop) => {
  const keyword = shopSearch.value.trim().toLocaleLowerCase();
  return (!countryFilter.value || (countryFilter.value === "__UNKNOWN__" ? !shop.countryCode : shop.countryCode === countryFilter.value))
    && (!platformFilter.value || shop.platform === platformFilter.value)
    && (showNoHistoryShops.value || !noHistoryShop(shop))
    && (!keyword || `${shop.name} ${shop.id}`.toLocaleLowerCase().includes(keyword));
}));
const visibleShops = computed(() => matchingShops.value.slice(0, 200));
const suggestionSelectable = (shop: FulfillmentSettings["shops"][number]) => Boolean(shop.suggestion?.needsReview
  && shop.suggestion.channel?.matched && shop.suggestion.warehouses?.length);
const selectableSuggestionCount = computed(() => visibleShops.value.filter(suggestionSelectable).length);
const shopName = (shopId?: string) => settings.value?.shops.find((shop) => shop.id === shopId)?.name
  || health.value?.shops?.find((shop) => shop.id === shopId)?.name || shopId || "—";
const time = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const duration = (milliseconds?: number | null) => {
  const value = Math.max(0, Number(milliseconds || 0));
  if (!value) return "—";
  if (value < 60000) return `${Math.max(1, Math.round(value / 1000))} 秒`;
  const minutes = Math.round(value / 60000);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};
const queuedFor = computed(() => dispatchQueue.value?.oldestQueuedAt
  ? duration(Date.now() - Date.parse(dispatchQueue.value.oldestQueuedAt)) : "—");
const text = (value?: string) => labels[value || ""] || value || "—";
const policySavedMessage = (message: string, nextSettings?: FulfillmentSettings | null) => nextSettings?.runtimeConfigUpdate?.pending
  ? `${message}；当前批次继续使用旧配置，新配置将在队列结束后自动生效`
  : `${message}；新配置将用于下一轮扫描`;
const issueGuidance = (value?: string, status?: string) => {
  const source = String(value || "");
  const matched = issueRules.find((rule) => rule.keys.some((key) => source.includes(key)));
  if (matched) return matched;
  if (/指定订单不存在|不在最近/.test(source)) return { title: "马帮暂时找不到该订单", nextStep: "请核对订单编号和当前状态；系统稍后还会继续检查。" };
  if (/运单|tracking/i.test(source) || status === "waiting_tracking") return { title: "正在等待马帮确认发货结果", nextStep: "无需重复操作；系统确认运单状态后会自动更新结果。" };
  if (!source) return { title: "正在等待系统确认结果", nextStep: "暂时无需操作，系统会继续检查该订单。" };
  return { title: source, nextStep: "请到马帮核对订单状态，确认无误后等待系统重新检查。" };
};
const batchDisplayName = (batch: FulfillmentBatch) => `${time(batch.createdAt)} 自动发货`;
const countryText = (value?: string) => value || "待识别";
const modeText = (value: string) => ({ paused: "暂停自动发货", manual: "只检查不发货", auto: "自动发货" }[value] || value);
const modeTag = (value: string) => value === "auto" ? "success" : value === "paused" ? "info" : "warning";
const configuredChannelText = (shop: FulfillmentSettings["shops"][number]) => settings.value?.channels
  .find((channel) => channel.channelId === shop.policy.channelId)?.channelName
  || shop.suggestion?.channel?.name
  || (shop.policy.updatedBy === "catalog_sync" && shop.suggestion?.status === "insufficient_history" ? "近 30 天无订单" : "未设置");
const configuredWarehouseText = (shop: FulfillmentSettings["shops"][number]) => shop.policy.allowedWarehouses.length
  ? shop.policy.allowedWarehouses.join("、")
  : shop.suggestion?.warehouses?.map((warehouse) => warehouse.name).join("、")
    || (shop.policy.updatedBy === "catalog_sync" && shop.suggestion?.status === "insufficient_history" ? "近 30 天无订单"
      : shop.policy.warehousePolicy === "any_single_warehouse" ? "所有单仓订单" : "未选择");

async function load() {
  loading.value = true; error.value = "";
  try {
    const [result, settingsResult, accountResult] = await Promise.all([
      loadFulfillmentWorkspace(), loadFulfillmentSettings(), loadMabangAccounts().catch(() => []),
    ]);
    health.value = result.health; scheduler.value = result.scheduler; dashboard.value = result.dashboard;
    batches.value = Array.isArray(result.batches) ? result.batches : [];
    recoveries.value = Array.isArray(result.recoveries) ? result.recoveries : [];
    settings.value = settingsResult; accounts.value = accountResult; workspace.lastSyncedAt = new Date();
    await refreshMessageReviewCandidates();
  } catch (loadError) { error.value = String((loadError as Error)?.message || loadError || "自动发货数据加载失败"); }
  finally { loading.value = false; }
}

async function refreshMessageReviewCandidates(showFeedback = false) {
  loadingMessageReviews.value = true; messageReviewError.value = "";
  try {
    messageReviewCandidates.value = await loadMessageReviewCandidates(10);
    if (showFeedback) ElMessage.success(`已检查 ${messageReviewCandidates.value.length} 笔待审核留言订单`);
  } catch (candidateError) {
    messageReviewError.value = String((candidateError as Error)?.message || candidateError || "待审核留言订单读取失败");
  } finally { loadingMessageReviews.value = false; }
}

async function changeMessageReviewMode(mode: MessageReviewMode) {
  if (mode === messageReviewMode.value || savingMessageReviewMode.value) return;
  const selected = messageReviewModes.find((item) => item.value === mode);
  if (mode === "auto") {
    try {
      await ElMessageBox.confirm(
        "系统将自动处理仅含留言异常、单仓、有货且无运单号的待审核订单。恢复为待处理后还会再次安全检查，通过后可能自动推单。是否开启？",
        "开启待审核自动处理",
        { confirmButtonText: "确认开启", cancelButtonText: "暂不开启", type: "warning" },
      );
    } catch { return; }
  }
  savingMessageReviewMode.value = true;
  try {
    settings.value = await saveMessageReviewMode(mode);
    ElMessage.success(`待审核留言订单已切换为“${selected?.label || mode}”`);
    await load();
  } catch (modeError) { ElMessage.error(String((modeError as Error)?.message || modeError || "处理模式保存失败")); }
  finally { savingMessageReviewMode.value = false; }
}

async function recoverMessageReview(candidate: MessageReviewCandidate) {
  if (!candidate.eligible || messageReviewMode.value !== "manual" || recoveringMessageReviewOrderId.value) return;
  try {
    await ElMessageBox.confirm(
      `确认恢复订单 ${candidate.platformOrderId}？系统会重新校验留言异常、仓库、库存和运单状态，转为待处理后等待 ${settings.value?.messageReviewRecovery?.followUpDelaySeconds || 30} 秒再进行推单安全检查。`,
      "恢复并进入推单流程",
      { confirmButtonText: "确认恢复这一单", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  recoveringMessageReviewOrderId.value = candidate.platformOrderId;
  try {
    await recoverMessageReviewOrder(candidate.platformOrderId);
    ElMessage.success(`${candidate.platformOrderId} 已恢复为待处理，正在等待定向安全检查`);
    await load();
  } catch (recoveryError) { ElMessage.error(String((recoveryError as Error)?.message || recoveryError || "订单恢复失败")); }
  finally { recoveringMessageReviewOrderId.value = ""; }
}

async function scan() {
  await ElMessageBox.confirm("本次只会检查待发货订单并生成结果，不会立即提交发货。是否继续？", "检查待发货订单", {
    confirmButtonText: "开始检查", cancelButtonText: "取消", type: "warning",
  });
  scanning.value = true;
  try { const result = await runFulfillmentScan(); ElMessage.success(result.message || "订单扫描已完成"); await load(); }
  catch (scanError) { ElMessage.error(String((scanError as Error)?.message || scanError || "订单扫描失败")); }
  finally { scanning.value = false; }
}

async function toggleQueue() {
  controllingQueue.value = true;
  try {
    scheduler.value = dispatchQueue.value?.paused ? await resumeFulfillmentQueue() : await pauseFulfillmentQueue();
    ElMessage.success(dispatchQueue.value?.paused ? "自动发货队列已暂停" : "自动发货队列已恢复");
  } catch (queueError) { ElMessage.error(String((queueError as Error)?.message || queueError || "队列状态修改失败")); }
  finally { controllingQueue.value = false; }
}

async function chooseAccount(accountId: string) {
  try {
    settings.value = await selectFulfillmentAccount(accountId);
    settings.value = await syncFulfillmentCatalog();
    ElMessage.success("自动发货账号、店铺白名单和仓库目录已同步");
  }
  catch (selectError) { ElMessage.error(String((selectError as Error)?.message || selectError)); }
}

async function connectAccount() {
  if (!accountForm.username.trim() || !accountForm.password) return ElMessage.warning("请输入马帮账号和密码");
  connecting.value = true;
  try {
    const profile = await connectMabangAccount(accountForm.username.trim(), accountForm.password,
      settings.value?.account.source === "account_profile" ? settings.value.account.id : "");
    settings.value = await selectFulfillmentAccount(profile.id);
    settings.value = await syncFulfillmentCatalog();
    accounts.value = await loadMabangAccounts(); accountDialog.value = false; accountForm.password = "";
    ElMessage.success("登录验证成功，店铺白名单和仓库目录已同步");
  } catch (connectError) { ElMessage.error(String((connectError as Error)?.message || connectError || "马帮登录失败")); }
  finally { accountForm.password = ""; connecting.value = false; }
}

async function syncCatalog() {
  if (!connected.value) return ElMessage.warning("请先连接马帮账号");
  syncing.value = true;
  try { settings.value = await syncFulfillmentCatalog(); ElMessage.success("店铺与物流渠道已从马帮同步"); }
  catch (syncError) { ElMessage.error(String((syncError as Error)?.message || syncError || "同步失败")); }
  finally { syncing.value = false; }
}

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
async function waitForPolicySuggestions(startedAt: string) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    await wait(5000);
    const latest = await loadFulfillmentSettings(); settings.value = latest;
    const job = latest.policySuggestionScanJob;
    if (job?.startedAt === startedAt && job.status === "failed") throw new Error(job.errorMessage || "历史订单分析失败");
    if (job?.startedAt === startedAt && job.status === "completed") return latest;
    if (latest.lastPolicySuggestionScanAt && latest.lastPolicySuggestionScanAt >= startedAt && job?.status !== "running") return latest;
  }
  throw new Error("历史订单仍在后台分析，请稍后刷新查看结果");
}

async function scanPolicySuggestions() {
  if (!connected.value) return ElMessage.warning("请先连接马帮账号");
  try {
    await ElMessageBox.confirm("系统将读取最近 30 天 Shopee 与 Lazada 历史订单，生成渠道和仓库建议；不会保存配置或开启自动发货。是否继续？", "智能补全店铺配置", {
      confirmButtonText: "开始分析", cancelButtonText: "取消", type: "info",
    });
  } catch { return; }
  suggesting.value = true;
  try {
    settings.value = await scanFulfillmentPolicySuggestions();
    const startedAt = settings.value.policySuggestionScanJob?.startedAt;
    if (settings.value.policySuggestionScanJob?.status === "running" && startedAt) {
      ElMessage.info("历史订单较多，系统正在后台分析，完成后会自动刷新结果");
      settings.value = await waitForPolicySuggestions(startedAt);
    }
    if (settings.value.policySuggestionScan?.warehouseCatalogComplete === false) {
      ElMessage.warning(`历史订单分析完成，${pendingSuggestionCount.value} 家店铺有建议；完整仓库目录读取失败，当前展示历史订单中已发现的仓库`);
    } else ElMessage.success(`分析完成，${pendingSuggestionCount.value} 家店铺有配置建议待审查`);
  } catch (suggestionError) { ElMessage.error(String((suggestionError as Error)?.message || suggestionError || "历史订单分析失败")); }
  finally { suggesting.value = false; }
}

function updateShopSelection(rows: FulfillmentSettings["shops"]) {
  selectedShopIds.value = rows.map((shop) => shop.id);
  selectedSuggestionShopIds.value = rows.filter(suggestionSelectable).map((shop) => shop.id);
}

function selectAllSuggested() {
  shopTable.value?.clearSelection();
  for (const shop of visibleShops.value.filter(suggestionSelectable)) shopTable.value?.toggleRowSelection(shop, true);
}

async function confirmSelectedSuggestions() {
  const shopIds = [...selectedSuggestionShopIds.value];
  if (!shopIds.length) return ElMessage.warning("请先勾选要确认的店铺");
  const selected = (settings.value?.shops || []).filter((shop) => shopIds.includes(shop.id));
  const warehouseCount = new Set(selected.flatMap((shop) => shop.suggestion?.warehouses?.map((warehouse) => warehouse.name) || [])).size;
  try {
    await ElMessageBox.confirm(
      `将确认 ${shopIds.length} 家店铺的建议渠道和仓库（涉及 ${warehouseCount} 个仓库）。店铺仍保持当前暂停/只检查状态，不会开启自动发货。是否继续？`,
      "批量确认店铺配置", { confirmButtonText: "确认写入配置", cancelButtonText: "返回核查", type: "warning" },
    );
  } catch { return; }
  confirmingSuggestions.value = true;
  try {
    const response = await confirmFulfillmentPolicySuggestions(shopIds);
    settings.value = response.settings; selectedSuggestionShopIds.value = []; shopTable.value?.clearSelection();
    if (response.result.skippedCount) ElMessage.warning(`已确认 ${response.result.confirmed} 家，${response.result.skippedCount} 家因配置变化或建议不完整被跳过`);
    else ElMessage.success(policySavedMessage(`已批量确认 ${response.result.confirmed} 家店铺配置`, response.settings));
  } catch (confirmationError) { ElMessage.error(String((confirmationError as Error)?.message || confirmationError || "批量确认失败")); }
  finally { confirmingSuggestions.value = false; }
}

async function applyBatchPolicy() {
  const shopIds = [...selectedShopIds.value];
  const patch: { mode?: FulfillmentShopPolicy["mode"]; minOrderAgeMinutes?: number; maxBatchSize?: number } = {};
  if (batchPolicyForm.mode) patch.mode = batchPolicyForm.mode;
  if (batchPolicyForm.minOrderAgeMinutes) patch.minOrderAgeMinutes = Number(batchPolicyForm.minOrderAgeMinutes);
  if (batchPolicyForm.maxBatchSize) patch.maxBatchSize = Number(batchPolicyForm.maxBatchSize);
  if (!shopIds.length) return ElMessage.warning("请先勾选要批量设置的店铺");
  if (!Object.keys(patch).length) return ElMessage.warning("请选择要批量修改的自动发货方式、付款等待或每次上限");
  const modeLabel = patch.mode ? modeText(patch.mode) : "保持原方式";
  const waitLabel = patch.minOrderAgeMinutes ? `${patch.minOrderAgeMinutes} 分钟` : "保持原等待时间";
  const limitLabel = patch.maxBatchSize ? `${patch.maxBatchSize} 单` : "保持原上限";
  try {
    await ElMessageBox.confirm(
      `将对 ${shopIds.length} 家店铺应用：${modeLabel}、付款等待 ${waitLabel}、${limitLabel}。选择“自动发货”时，仅静态白名单内且渠道、仓库配置完整的店铺会成功，其余将跳过。是否继续？`,
      "批量设置店铺", { confirmButtonText: "确认应用", cancelButtonText: "取消", type: patch.mode === "auto" ? "warning" : "info" },
    );
  } catch { return; }
  updatingBatchPolicies.value = true;
  try {
    const response = await batchUpdateFulfillmentShopPolicies(shopIds, patch);
    settings.value = response.settings; batchPolicyForm.mode = ""; batchPolicyForm.minOrderAgeMinutes = ""; batchPolicyForm.maxBatchSize = "";
    selectedShopIds.value = []; selectedSuggestionShopIds.value = []; shopTable.value?.clearSelection();
    if (response.result.skippedCount) {
      const firstReason = response.result.skipped[0]?.reason;
      ElMessage.warning(`已更新 ${response.result.updated} 家，跳过 ${response.result.skippedCount} 家${firstReason ? `（${firstReason}）` : ""}`);
    } else ElMessage.success(policySavedMessage(`已批量更新 ${response.result.updated} 家店铺`, response.settings));
  } catch (batchError) { ElMessage.error(String((batchError as Error)?.message || batchError || "批量设置失败")); }
  finally { updatingBatchPolicies.value = false; }
}

function fileBase64(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
    }
    return window.btoa(binary);
  });
}

function policyImportSelectable(row: FulfillmentPolicyImportRow) { return row.ready; }

function updatePolicyImportSelection(rows: FulfillmentPolicyImportRow[]) {
  selectedPolicyImportRowIds.value = rows.filter(policyImportSelectable).map((row) => row.id);
}

async function selectReadyPolicyImportRows() {
  await nextTick(); policyImportTable.value?.clearSelection();
  for (const row of policyImportPreview.value?.rows.filter(policyImportSelectable) || []) {
    policyImportTable.value?.toggleRowSelection(row, true);
  }
}

async function handlePolicyImportFile(uploadFile: { raw?: File }) {
  const file = uploadFile.raw;
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) return ElMessage.warning("请选择 .xlsx 或 .csv 配置表");
  if (file.size > 1024 * 1024) return ElMessage.warning("配置表不能超过 1MB");
  importingPolicy.value = true; policyImportPreview.value = null; selectedPolicyImportRowIds.value = [];
  try {
    policyImportPreview.value = await previewFulfillmentPolicyImport(file.name, await fileBase64(file), policyImportOverwrite.value);
    await selectReadyPolicyImportRows();
    const summary = policyImportPreview.value.summary;
    if (summary.needsReview) ElMessage.warning(`已识别 ${summary.total} 家店铺，${summary.ready} 家可直接配置，${summary.needsReview} 家需要核查`);
    else ElMessage.success(`已识别 ${summary.total} 家店铺，全部可配置`);
  } catch (importError) { ElMessage.error(String((importError as Error)?.message || importError || "配置表解析失败")); }
  finally { importingPolicy.value = false; }
}

function resetPolicyImport() {
  policyImportPreview.value = null; selectedPolicyImportRowIds.value = []; policyImportOverwrite.value = false;
}

async function confirmPolicyImport() {
  const preview = policyImportPreview.value; const rowIds = [...selectedPolicyImportRowIds.value];
  if (!preview || !rowIds.length) return ElMessage.warning("请先勾选要配置的店铺");
  try {
    await ElMessageBox.confirm(
      `将写入 ${rowIds.length} 家店铺的渠道和仓库配置。店铺仍保持当前暂停/只检查状态，不会开启自动发货。是否继续？`,
      "确认导入店铺配置", { confirmButtonText: "确认写入", cancelButtonText: "返回核查", type: "warning" },
    );
  } catch { return; }
  confirmingPolicyImport.value = true;
  try {
    const response = await confirmFulfillmentPolicyImport(preview.previewId, rowIds);
    settings.value = response.settings; policyImportDialog.value = false; resetPolicyImport();
    if (response.result.skippedCount) ElMessage.warning(`已配置 ${response.result.confirmed} 家，${response.result.skippedCount} 家因配置变化被跳过`);
    else ElMessage.success(policySavedMessage(`已批量配置 ${response.result.confirmed} 家店铺`, response.settings));
  } catch (confirmationError) { ElMessage.error(String((confirmationError as Error)?.message || confirmationError || "导入配置失败")); }
  finally { confirmingPolicyImport.value = false; }
}

function editPolicy(shop: FulfillmentSettings["shops"][number]) {
  const useSuggestion = Boolean(shop.suggestion?.needsReview);
  const suggestedWarehouses = useSuggestion ? (shop.suggestion?.warehouses || []).map((item) => item.name) : [];
  Object.assign(policyForm, { shopId: shop.id, shopName: shop.name, mode: shop.policy.mode,
    channelId: shop.policy.channelId || (useSuggestion && shop.suggestion?.channel?.matched ? shop.suggestion.channel.channelId : ""),
    warehousePolicy: suggestedWarehouses.length ? "allowlist" : shop.policy.warehousePolicy,
    allowedWarehouses: shop.policy.allowedWarehouses.length ? [...shop.policy.allowedWarehouses] : suggestedWarehouses,
    minOrderAgeMinutes: shop.policy.minOrderAgeMinutes, maxBatchSize: shop.policy.maxBatchSize });
  policyDrawer.value = true;
}

async function persistPolicy() {
  if (policyForm.mode === "auto" && !currentPolicyShop.value?.autoFulfillAuthorized) {
    return ElMessage.warning("该店铺尚未完成静态白名单授权，只能使用暂停或只检查模式");
  }
  if (policyForm.mode === "auto" && !policyForm.channelId) return ElMessage.warning("开启自动发货前，请先选择默认快递渠道");
  if (policyForm.warehousePolicy === "allowlist" && !policyForm.allowedWarehouses.length) return ElMessage.warning("请至少选择一个可自动发货的仓库");
  if (policyForm.mode === "auto") {
    await ElMessageBox.confirm("系统只会自动处理来自同一仓库、达到付款等待时间且检查通过的订单；跨仓订单一定会转人工。确认保存？", "开启自动发货", {
      confirmButtonText: "确认保存", cancelButtonText: "返回检查", type: "warning",
    });
  }
  savingPolicy.value = true;
  try {
    settings.value = await saveFulfillmentShopPolicy(policyForm.shopId, { mode: policyForm.mode, channelId: policyForm.channelId,
      warehousePolicy: policyForm.warehousePolicy, allowedWarehouses: policyForm.warehousePolicy === "allowlist" ? policyForm.allowedWarehouses : [],
      minOrderAgeMinutes: policyForm.minOrderAgeMinutes, maxBatchSize: policyForm.maxBatchSize });
    policyDrawer.value = false; ElMessage.success(policySavedMessage(`${policyForm.shopName} 配置已保存`, settings.value));
  } catch (saveError) { ElMessage.error(String((saveError as Error)?.message || saveError || "配置保存失败")); }
  finally { savingPolicy.value = false; }
}

let schedulerRefreshTimer: number | undefined;
async function refreshScheduler() {
  try { scheduler.value = await loadFulfillmentScheduler(); } catch { /* 完整刷新会展示服务错误；轻量轮询保留最近状态。 */ }
}
onMounted(() => {
  void load();
  schedulerRefreshTimer = window.setInterval(refreshScheduler, 15000);
});
onBeforeUnmount(() => { if (schedulerRefreshTimer) window.clearInterval(schedulerRefreshTimer); });
</script>

<template>
  <div class="fulfillment-vue-page" v-loading="loading">
    <section class="account-strip">
      <div class="account-identity">
        <span class="account-icon" :class="{ connected }"><KeyRound :size="18" /></span>
        <div><span class="eyebrow">马帮连接</span><strong>{{ connected ? settings?.account.name || "马帮账号已连接" : "尚未连接马帮" }}</strong>
          <small>{{ connected ? `${settings?.account.usernameMasked || ""} · 凭据仅在服务端加密使用` : "登录后可同步店铺和物流渠道，无需修改配置文件" }}</small></div>
      </div>
      <div class="account-actions">
        <el-select v-if="accounts.length" :model-value="settings?.account.id" placeholder="切换账号" style="width: 176px" @change="chooseAccount">
          <el-option v-for="account in accounts" :key="account.id" :label="`${account.name} ${account.usernameMasked || ''}`" :value="account.id" />
        </el-select>
        <el-button @click="accountDialog = true">{{ connected ? "重新登录" : "登录马帮" }}</el-button>
        <el-button type="primary" plain :loading="syncing" :disabled="!connected" @click="syncCatalog">同步店铺与渠道</el-button>
      </div>
    </section>

    <section class="module-toolbar fulfillment-toolbar">
      <div class="service-summary"><span class="live-indicator" :class="{ active: !error }"></span>
        <div><strong>{{ error ? "自动发货服务暂不可用" : "自动发货服务正常" }}</strong><small>最近检查 {{ time(scheduler?.lastScanAt) }} · {{ text(scheduler?.lastOutcome) }}</small></div>
      </div>
      <div class="module-toolbar-actions"><el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Play" :loading="scanning" :disabled="!connected" @click="scan">检查待发货订单</el-button></div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-else-if="settings?.safety.realSubmitEnabled" type="warning" :closable="false" show-icon title="自动发货已开启：订单通过库存、仓库、快递渠道和付款等待时间检查后，系统会提交到马帮。" />
    <el-alert v-else type="info" :closable="false" show-icon title="当前为演示模式：系统会检查真实订单，但不会向马帮提交发货。" />

    <section v-if="dispatchQueue" class="fulfillment-queue-panel" aria-labelledby="fulfillment-queue-title" aria-live="polite">
      <header class="queue-panel-header">
        <div><span class="panel-icon"><Truck :size="18" /></span><div><span class="panel-kicker">实时调度</span>
          <h3 id="fulfillment-queue-title">自动发货队列</h3></div></div>
        <div class="queue-panel-actions"><el-tag :type="queueTagType" effect="plain">{{ queueStateText }}</el-tag>
          <el-button v-if="dispatchQueue.paused" :icon="RotateCcw" :loading="controllingQueue" @click="toggleQueue">恢复队列</el-button>
          <el-button v-else-if="queueActive || catchUp?.active" :icon="Pause" :loading="controllingQueue" @click="toggleQueue">暂停队列</el-button>
        </div>
      </header>
      <div class="queue-stat-grid">
        <div><span>等待订单</span><strong>{{ Number(dispatchQueue.queuedOrders || 0).toLocaleString("zh-CN") }}</strong><small>{{ dispatchQueue.queued || 0 }} 个店铺批次</small></div>
        <div><span>正在处理</span><strong>{{ Number(dispatchQueue.runningOrders || 0).toLocaleString("zh-CN") }}</strong><small>{{ scheduler?.activeBatch ? "真实发货批次执行中" : "当前无活动批次" }}</small></div>
        <div><span>最早等待</span><strong>{{ queuedFor }}</strong><small>{{ dispatchQueue.oldestQueuedAt ? `入队于 ${time(dispatchQueue.oldestQueuedAt)}` : "暂无等待订单" }}</small></div>
        <div><span>预计清空</span><strong>{{ time(dispatchQueue.estimatedClearAt) }}</strong><small>按最近 20 个批次动态估算</small></div>
        <div><span>平均每批</span><strong>{{ duration(dispatchQueue.averageBatchMs) }}</strong><small>完成一店批次的平均耗时</small></div>
        <div><span>积压恢复</span><strong>{{ catchUp?.active ? `${Number(catchUp.detectedOrders || 0)} 单` : "正常" }}</strong><small>{{ catchUp?.active ? `已自动补队列 ${catchUp.refillCount || 0} 次` : "按正常周期检查" }}</small></div>
      </div>
      <p v-if="dispatchQueue.paused" class="queue-pause-reason"><CircleAlert :size="16" />{{ dispatchQueue.pauseReason || "队列因安全原因暂停，请核查马帮登录和订单状态。" }}</p>
      <p v-else-if="catchUp?.active" class="queue-catchup-message"><RotateCcw :size="16" />积压恢复已开启：旧单优先，队列低于安全水位后立即补充；连续失败 {{ catchUp.consecutiveDispatchFailures || 0 }}/{{ catchUp.circuitThreshold || 3 }} 次将自动暂停。</p>
      <p v-else class="queue-last-message">{{ scheduler?.lastMessage || "系统会在发货执行期间继续只读扫描，并把新订单追加到队尾。" }}<span v-if="restartReconciledCount"> 本轮已安全对账 {{ restartReconciledCount }} 笔宕机订单。</span></p>
    </section>

    <section class="dashboard-panel message-review-panel" aria-labelledby="message-review-title">
      <header class="message-review-header">
        <div class="message-review-title"><span class="panel-icon"><MessageSquareText :size="18" /></span><div>
          <span class="panel-kicker">待审核留言订单</span><h3 id="message-review-title">恢复与推单控制</h3>
          <p>仅处理“留言”单一异常，并在转为待处理前后重复核对店铺、仓库、库存和运单。</p>
        </div></div>
        <div class="message-review-header-actions"><el-tag :type="messageReviewMode === 'auto' ? 'success' : messageReviewMode === 'manual' ? 'warning' : 'info'" effect="plain">
          当前：{{ messageReviewModes.find(item => item.value === messageReviewMode)?.label }}
        </el-tag><el-button :icon="RefreshCw" :loading="loadingMessageReviews" @click="refreshMessageReviewCandidates(true)">刷新候选</el-button></div>
      </header>

      <div class="message-review-modes" role="group" aria-label="待审核留言订单处理方式" v-loading="savingMessageReviewMode">
        <button v-for="mode in messageReviewModes" :key="mode.value" type="button" class="message-review-mode"
          :class="{ active: messageReviewMode === mode.value, danger: mode.value === 'auto' }"
          :aria-pressed="messageReviewMode === mode.value" :disabled="savingMessageReviewMode" @click="changeMessageReviewMode(mode.value)">
          <span>{{ mode.label }}</span><small>{{ mode.description }}</small>
        </button>
      </div>

      <div class="message-review-summary" aria-live="polite">
        <span><ShieldCheck :size="16" /><b>{{ eligibleMessageReviews.length }}</b> 笔通过全部检查</span>
        <span v-if="blockedMessageReviews.length"><CircleAlert :size="16" /><b>{{ blockedMessageReviews.length }}</b> 笔已安全拦截</span>
        <small v-if="messageReviewMode === 'auto'">系统每 {{ settings?.messageReviewRecovery.intervalMinutes || 30 }} 分钟检查一次；恢复后等待 {{ settings?.messageReviewRecovery.followUpDelaySeconds || 30 }} 秒再推单。</small>
        <small v-else-if="messageReviewMode === 'manual'">点击单笔“恢复并推单”后仍会重新执行全部安全检查。</small>
        <small v-else>当前只读展示候选，任何恢复操作都不会执行。</small>
      </div>

      <el-alert v-if="messageReviewError" type="error" :closable="false" show-icon :title="messageReviewError" />
      <div v-else class="message-review-list" v-loading="loadingMessageReviews">
        <el-empty v-if="!messageReviewCandidates.length && !loadingMessageReviews" :image-size="48" description="当前没有待审核留言订单" />
        <article v-for="candidate in messageReviewCandidates" :key="candidate.internalOrderId" class="message-review-order" :class="{ blocked: !candidate.eligible }">
          <div class="order-primary"><strong>{{ candidate.platformOrderId }}</strong><span>{{ candidate.shopName }}</span></div>
          <div class="order-detail"><span>仓库</span><strong>{{ candidate.warehouse || "待确认" }}</strong></div>
          <div class="order-detail"><span>商品</span><strong>{{ candidate.skuCount }} 个 SKU</strong></div>
          <div class="order-check"><el-tag :type="candidate.eligible ? 'success' : 'danger'" size="small">{{ candidate.eligible ? "可安全恢复" : "已拦截" }}</el-tag>
            <small v-if="!candidate.eligible">{{ candidate.exclusions.map(text).join("、") }}</small><small v-else>单仓、有货、无运单号</small></div>
          <el-button type="primary" :disabled="!candidate.eligible || messageReviewMode !== 'manual' || Boolean(recoveringMessageReviewOrderId)"
            :loading="recoveringMessageReviewOrderId === candidate.platformOrderId" @click="recoverMessageReview(candidate)">
            {{ messageReviewMode === "off" ? "处理已关闭" : messageReviewMode === "auto" ? "系统自动处理" : candidate.eligible ? "恢复并推单" : "未通过检查" }}
          </el-button>
        </article>
      </div>
    </section>

    <section class="metric-grid fulfillment-metrics">
      <MetricCard label="今日已自动发货" :value="totals.success.toLocaleString('zh-CN')" hint="已完成并确认结果" tone="success" />
      <MetricCard label="正在发货" :value="totals.running.toLocaleString('zh-CN')" hint="系统正在处理" tone="warning" />
      <MetricCard label="等待自动发货" :value="deferredCount.toLocaleString('zh-CN')" hint="达到付款等待时间后处理" />
      <MetricCard label="需要人工处理" :value="attentionCount.toLocaleString('zh-CN')" hint="请优先查看下方订单" :tone="attentionCount ? 'danger' : 'default'" />
    </section>

    <section class="fulfillment-summary-grid">
      <article class="dashboard-panel"><header><div><span class="panel-kicker">自动检查</span><h3>系统运行情况</h3></div><Truck :size="18" /></header>
        <div class="compact-stat-list"><div><span>下次检查订单</span><strong>{{ time(scheduler?.nextScanAt) }}</strong></div>
          <div><span>上次检查结果</span><strong>{{ text(scheduler?.lastOutcome) }}</strong></div><div><span>待处理订单</span><strong>{{ pendingRecoveries.length }}</strong></div>
          <div><span>已管理店铺</span><strong>{{ settings?.shops.length || 0 }}</strong></div></div></article>
      <article class="dashboard-panel"><header><div><span class="panel-kicker">需要处理</span><h3>未自动发货原因</h3></div><CircleAlert :size="18" /></header>
        <div class="exception-chip-list"><span v-for="item in exceptionSummary" :key="item.code"><b>{{ item.count }}</b>{{ text(item.code) }}</span>
          <el-empty v-if="!exceptionSummary.length" :image-size="46" description="暂无异常" /></div></article>
    </section>

    <section class="dashboard-panel data-workbench fulfillment-workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="待处理订单" name="recoveries"><el-table class="desktop-recovery-table" :data="pendingRecoveries" stripe empty-text="很好，当前没有需要人工处理的订单">
          <el-table-column prop="orderReference" label="订单" min-width="180" /><el-table-column label="店铺" min-width="150"><template #default="scope">{{ shopName(scope.row.shopId) }}</template></el-table-column>
          <el-table-column label="当前状态" width="130"><template #default="scope"><el-tag type="warning">{{ text(scope.row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="为什么没有自动发货" min-width="320"><template #default="scope"><div class="issue-guidance"><strong>{{ issueGuidance(scope.row.reason, scope.row.status).title }}</strong><span>{{ issueGuidance(scope.row.reason, scope.row.status).nextStep }}</span></div></template></el-table-column>
          <el-table-column label="发现时间" width="150"><template #default="scope">{{ time(scope.row.updatedAt) }}</template></el-table-column>
          <el-table-column label="详情" width="100" fixed="right"><template #default="scope"><el-popover placement="left" :width="360" trigger="click">
            <template #reference><el-button text type="primary">技术详情</el-button></template><div class="technical-detail"><span>仅供开发排查</span><code>订单记录：{{ scope.row.id || '—' }}</code><code>原始原因：{{ scope.row.reason || '—' }}</code></div>
          </el-popover></template></el-table-column>
        </el-table>
          <div class="mobile-recovery-list">
            <el-empty v-if="!pendingRecoveries.length" :image-size="54" description="很好，当前没有需要人工处理的订单" />
            <article v-for="item in pendingRecoveries" :key="item.id" class="mobile-recovery-card">
              <header><div><strong>{{ item.orderReference || '订单号待确认' }}</strong><span>{{ shopName(item.shopId) }}</span></div><el-tag type="warning" size="small">{{ text(item.status) }}</el-tag></header>
              <div class="issue-guidance"><strong>{{ issueGuidance(item.reason, item.status).title }}</strong><span>{{ issueGuidance(item.reason, item.status).nextStep }}</span></div>
              <footer><span>发现于 {{ time(item.updatedAt) }}</span><el-popover placement="top" :width="300" trigger="click"><template #reference><el-button text type="primary">技术详情</el-button></template>
                <div class="technical-detail"><span>仅供开发排查</span><code>订单记录：{{ item.id || '—' }}</code><code>原始原因：{{ item.reason || '—' }}</code></div>
              </el-popover></footer>
            </article>
          </div>
        </el-tab-pane>
        <el-tab-pane label="发货记录" name="batches"><el-table :data="batches" stripe empty-text="暂无自动发货记录">
          <el-table-column label="发货时间" min-width="190"><template #default="scope">{{ batchDisplayName(scope.row) }}</template></el-table-column><el-table-column label="店铺" min-width="160"><template #default="scope">{{ shopName(scope.row.shopId) }}</template></el-table-column>
          <el-table-column label="订单号" min-width="190"><template #default="scope"><div class="batch-order-ids"><span v-for="orderId in scope.row.orderIds" :key="orderId">{{ orderId }}</span><span v-if="!scope.row.orderIds?.length">—</span></div></template></el-table-column>
          <el-table-column label="处理结果" width="120"><template #default="scope">{{ text(scope.row.status) }}</template></el-table-column>
          <el-table-column prop="orderCount" label="处理订单" width="100" align="right" /><el-table-column prop="successCount" label="发货成功" width="100" align="right" />
          <el-table-column prop="failedCount" label="需要处理" width="100" align="right" /><el-table-column label="详情" width="100"><template #default="scope"><el-popover placement="left" :width="340" trigger="click">
            <template #reference><el-button text type="primary">技术详情</el-button></template><div class="technical-detail"><span>仅供开发排查</span><code>批次编号：{{ scope.row.id || '—' }}</code></div>
          </el-popover></template></el-table-column>
        </el-table></el-tab-pane>
        <el-tab-pane name="shops"><template #label><span class="tab-label"><Store :size="15" />店铺配置</span></template>
          <el-alert v-if="settings?.policySuggestionScanJob?.status === 'running'" type="info" :closable="false" show-icon
            title="正在后台分析最近 30 天的历史订单和仓库目录，完成后会自动刷新，不会修改或开启自动发货。" />
          <div v-if="pendingSuggestionCount" class="suggestion-batchbar">
            <div><Sparkles :size="17" /><span>当前有 <b>{{ pendingSuggestionCount }}</b> 家建议待审查，当前筛选结果中 <b>{{ selectableSuggestionCount }}</b> 家可批量确认。</span></div>
            <div><el-button :disabled="!selectableSuggestionCount || confirmingSuggestions" @click="selectAllSuggested">全选当前建议</el-button>
              <el-button type="primary" :loading="confirmingSuggestions" :disabled="!selectedSuggestionShopIds.length" @click="confirmSelectedSuggestions">批量确认选中（{{ selectedSuggestionShopIds.length }}）</el-button></div>
          </div>
          <div v-if="selectedShopIds.length" class="shop-batchbar" aria-live="polite">
            <div class="shop-batch-summary"><strong>已选 {{ selectedShopIds.length }} 家店铺</strong><span>只修改下方已选择的项目，其他配置保持不变。</span></div>
            <div class="shop-batch-controls">
              <el-select v-model="batchPolicyForm.mode" clearable placeholder="自动发货方式（不修改）" aria-label="批量设置自动发货方式" style="width: 190px">
                <el-option label="暂停自动发货" value="paused" /><el-option label="只检查不发货" value="manual" /><el-option label="自动发货" value="auto" />
              </el-select>
              <el-select v-model="batchPolicyForm.minOrderAgeMinutes" clearable placeholder="付款等待（不修改）" aria-label="批量设置付款等待时间" style="width: 170px">
                <el-option v-for="value in [2, 5, 10, 15, 30, 60]" :key="value" :label="`${value} 分钟`" :value="value" />
              </el-select>
              <el-select v-model="batchPolicyForm.maxBatchSize" clearable placeholder="每次上限（不修改）" aria-label="批量设置每次发货上限" style="width: 170px">
                <el-option v-for="value in [1, 2, 5, 10]" :key="value" :label="`${value} 单`" :value="value" />
              </el-select>
              <el-button type="primary" :loading="updatingBatchPolicies" :disabled="!batchPolicyForm.mode && !batchPolicyForm.minOrderAgeMinutes && !batchPolicyForm.maxBatchSize" @click="applyBatchPolicy">批量应用</el-button>
              <el-button :disabled="updatingBatchPolicies" @click="shopTable?.clearSelection()">取消选择</el-button>
            </div>
          </div>
          <div class="table-caption shop-filterbar"><span>已同步 {{ settings?.shops.length || 0 }} 家，当前匹配 {{ matchingShops.length }} 家；{{ pendingSuggestionCount }} 家建议待审查。</span>
            <div><el-select v-model="countryFilter" clearable placeholder="全部国家" aria-label="按国家筛选店铺" style="width: 130px"><el-option v-for="country in shopCountries" :key="country" :label="country === '__UNKNOWN__' ? '待识别' : country" :value="country" /></el-select>
              <el-select v-model="platformFilter" clearable placeholder="全部平台" aria-label="按平台筛选店铺" style="width: 130px"><el-option v-for="platform in shopPlatforms" :key="platform" :label="platform" :value="platform" /></el-select>
              <el-checkbox v-model="showNoHistoryShops">显示近 30 天无订单（{{ noHistoryShopCount }}）</el-checkbox>
              <el-input v-model="shopSearch" clearable placeholder="搜索店铺名称 / ID" style="width: 210px" />
              <el-button :icon="FileUp" plain @click="policyImportDialog = true">导入配置表</el-button>
              <el-button :icon="Sparkles" type="primary" plain :loading="suggesting" :disabled="!connected" @click="scanPolicySuggestions">智能补全空配置</el-button>
              <el-button :icon="RefreshCw" text :loading="syncing" @click="syncCatalog">重新同步</el-button></div></div>
          <el-alert v-if="matchingShops.length > visibleShops.length" type="info" :closable="false" :title="`结果较多，当前展示前 ${visibleShops.length} 家，请使用国家或店铺搜索缩小范围。`" />
          <el-table ref="shopTable" :data="visibleShops" row-key="id" stripe empty-text="请先同步马帮店铺" @selection-change="updateShopSelection">
            <el-table-column type="selection" width="44" reserve-selection />
            <el-table-column label="国家" width="80"><template #default="scope">{{ countryText(scope.row.countryCode) }}</template></el-table-column><el-table-column prop="platform" label="平台" width="120" />
            <el-table-column prop="name" label="店铺" min-width="170"><template #default="scope"><span>{{ scope.row.name }}</span><el-tag v-if="scope.row.suggestion?.needsReview" type="warning" size="small">建议待审查</el-tag></template></el-table-column><el-table-column label="自动发货方式" width="150"><template #default="scope"><el-tag :type="modeTag(scope.row.policy.mode)">{{ modeText(scope.row.policy.mode) }}</el-tag></template></el-table-column>
            <el-table-column label="默认快递渠道" min-width="190" show-overflow-tooltip><template #default="scope">{{ configuredChannelText(scope.row) }}<el-tag v-if="scope.row.policy.channelId && !scope.row.channelValid" type="danger" size="small">需要重新设置</el-tag><el-tag v-else-if="!scope.row.policy.channelId && scope.row.suggestion?.channel" type="warning" size="small">系统建议</el-tag></template></el-table-column>
            <el-table-column label="可自动发货仓库" min-width="190"><template #default="scope">{{ configuredWarehouseText(scope.row) }}<el-tag v-if="!scope.row.policy.allowedWarehouses.length && scope.row.suggestion?.warehouses?.length" type="warning" size="small">系统建议</el-tag></template></el-table-column>
            <el-table-column label="付款等待 / 每次上限" width="170"><template #default="scope">{{ scope.row.policy.minOrderAgeMinutes }} 分钟 / {{ scope.row.policy.maxBatchSize }} 单</template></el-table-column>
            <el-table-column width="96" fixed="right"><template #default="scope"><el-button :icon="Settings2" text type="primary" @click="editPolicy(scope.row)">配置</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>

    <el-dialog v-model="accountDialog" title="登录马帮账号" width="460px" destroy-on-close>
      <el-alert type="info" :closable="false" title="网页登录会先验证马帮登录，再将凭据加密保存到服务端；浏览器不会保存密码。" />
      <el-form label-position="top" class="dialog-form" @submit.prevent="connectAccount"><el-form-item label="马帮账号"><el-input v-model="accountForm.username" autocomplete="username" placeholder="请输入登录账号" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="accountForm.password" type="password" show-password autocomplete="current-password" placeholder="请输入登录密码" @keyup.enter="connectAccount" /></el-form-item></el-form>
      <template #footer><el-button @click="accountDialog = false">取消</el-button><el-button type="primary" :loading="connecting" @click="connectAccount">验证并连接</el-button></template>
    </el-dialog>

    <el-dialog v-model="policyImportDialog" title="导入渠道与仓库配置" width="min(1120px, 94vw)" destroy-on-close @closed="resetPolicyImport">
      <div class="policy-import-head">
        <div><strong>上传配置表并核查匹配结果</strong><span>支持 .xlsx / .csv，需包含“马帮店名、平台、国家、对应物流渠道、对应仓库”。确认前不会写入配置。</span></div>
        <el-upload accept=".xlsx,.csv" :auto-upload="false" :show-file-list="false" :on-change="handlePolicyImportFile" :disabled="importingPolicy">
          <el-button :icon="FileUp" type="primary" plain :loading="importingPolicy">{{ policyImportPreview ? '重新选择文件' : '选择配置表' }}</el-button>
        </el-upload>
      </div>
      <el-checkbox v-model="policyImportOverwrite" :disabled="Boolean(policyImportPreview) || importingPolicy">允许覆盖已人工确认的渠道与仓库配置</el-checkbox>
      <p class="field-help import-help">默认只配置未人工确认的店铺；无论是否覆盖，都会保留当前暂停/只检查/自动发货模式。</p>
      <template v-if="policyImportPreview">
        <div class="policy-import-summary">
          <span>{{ policyImportPreview.filename }} · {{ policyImportPreview.sheetName }}</span>
          <el-tag type="success">可配置 {{ policyImportPreview.summary.ready }}</el-tag>
          <el-tag v-if="policyImportPreview.summary.needsReview" type="warning">需核查 {{ policyImportPreview.summary.needsReview }}</el-tag>
          <small>已勾选 {{ selectedPolicyImportRowIds.length }} 家</small>
        </div>
        <el-table ref="policyImportTable" :data="policyImportPreview.rows" row-key="id" height="480" stripe
          @selection-change="updatePolicyImportSelection">
          <el-table-column type="selection" width="44" :selectable="policyImportSelectable" />
          <el-table-column prop="sourceRow" label="行" width="58" />
          <el-table-column label="表内店铺" min-width="170"><template #default="scope"><strong>{{ scope.row.shopName }}</strong><small>{{ scope.row.shopCode }} · {{ scope.row.platform }} / {{ scope.row.countryCode }}</small></template></el-table-column>
          <el-table-column label="系统店铺" min-width="160"><template #default="scope">{{ scope.row.matchedShopName || '未匹配' }}<small v-if="scope.row.shopId">{{ scope.row.shopId }}</small></template></el-table-column>
          <el-table-column label="匹配渠道" min-width="210" show-overflow-tooltip><template #default="scope">{{ scope.row.channelName || scope.row.sourceChannel || '—' }}</template></el-table-column>
          <el-table-column label="匹配仓库" min-width="230"><template #default="scope"><span class="import-warehouse">{{ scope.row.warehouses.join('、') || scope.row.sourceWarehouses.join('、') || '—' }}</span></template></el-table-column>
          <el-table-column label="校验结果" min-width="200"><template #default="scope"><el-tag :type="scope.row.ready ? 'success' : 'warning'">{{ scope.row.ready ? '可配置' : '需核查' }}</el-tag><span v-if="scope.row.issues.length" class="import-issues">{{ scope.row.issues.join('；') }}</span></template></el-table-column>
        </el-table>
      </template>
      <template #footer><el-button @click="policyImportDialog = false">取消</el-button><el-button v-if="policyImportPreview" @click="selectReadyPolicyImportRows">全选可配置</el-button>
        <el-button type="primary" :loading="confirmingPolicyImport" :disabled="!selectedPolicyImportRowIds.length" @click="confirmPolicyImport">确认写入（{{ selectedPolicyImportRowIds.length }}）</el-button></template>
    </el-dialog>

    <el-drawer v-model="policyDrawer" class="policy-drawer" :title="`${policyForm.shopName} · 自动发货设置`" size="520px" destroy-on-close>
      <el-form label-position="top" class="policy-form">
        <el-alert v-if="currentPolicyShop?.suggestion?.needsReview" type="warning" :closable="false" show-icon
          :title="`已根据最近 ${currentPolicyShop.suggestion.lookbackDays} 天的 ${currentPolicyShop.suggestion.orderCount} 笔历史订单自动填充，请审查后保存`" />
        <el-form-item label="系统如何处理这个店铺"><el-segmented v-model="policyForm.mode" :options="policyModeOptions" /></el-form-item>
        <p class="field-help">暂停：不检查新订单；只检查不发货：生成检查结果，由店长决定；自动发货：全部检查通过后提交马帮。</p>
        <el-alert v-if="!currentPolicyShop?.autoFulfillAuthorized" type="info" :closable="false" show-icon
          title="该店铺尚未完成静态白名单授权，目前只能暂停或只检查，不会自动提交发货。" />
        <el-form-item label="默认快递渠道"><el-select v-model="policyForm.channelId" filterable clearable placeholder="选择从马帮同步的快递渠道" style="width: 100%">
          <el-option v-for="channel in availableChannels" :key="channel.channelId" :value="channel.channelId" :label="`${channel.channelName}${channel.logisticsName ? ` · ${channel.logisticsName}` : ''}`" />
        </el-select></el-form-item>
        <p v-if="currentPolicyShop?.suggestion?.channel" class="field-help">历史订单中 {{ currentPolicyShop.suggestion.channel.orderCount }} / {{ currentPolicyShop.suggestion.orderCount }} 笔使用“{{ currentPolicyShop.suggestion.channel.name }}”，置信度 {{ Math.round(currentPolicyShop.suggestion.channel.confidence * 100) }}%。</p>
        <p v-if="!availableChannels.length" class="field-help warning">当前没有已同步的渠道，请先同步。</p>
        <el-divider />
        <el-form-item label="哪些仓库的订单可以自动发货"><el-radio-group v-model="policyForm.warehousePolicy"><el-radio value="allowlist">仅以下仓库</el-radio><el-radio value="any_single_warehouse">所有单仓订单</el-radio></el-radio-group></el-form-item>
        <el-form-item v-if="policyForm.warehousePolicy === 'allowlist'" label="可自动发货仓库"><el-select v-model="policyForm.allowedWarehouses" multiple filterable allow-create default-first-option
          collapse-tags collapse-tags-tooltip popper-class="warehouse-select-popper" placeholder="选择最近扫描到的仓库，或输入准确名称" style="width: 100%">
          <el-option v-for="warehouse in settings?.warehouseOptions || currentPolicyShop?.warehouseOptions || []" :key="warehouse" :label="warehouse" :value="warehouse">
            <span class="warehouse-option-text" :title="warehouse">{{ warehouse }}</span>
          </el-option>
        </el-select></el-form-item>
        <div v-if="policyForm.warehousePolicy === 'allowlist' && policyForm.allowedWarehouses.length" class="selected-warehouse-list" aria-label="已选择仓库完整名称">
          <span v-for="warehouse in policyForm.allowedWarehouses" :key="warehouse" :title="warehouse">{{ warehouse }}</span>
        </div>
        <el-alert type="warning" :closable="false" show-icon title="同一订单包含两个普通履约仓时会转人工；“赠品SKU仓”不计入多仓，但纯赠品订单会被拦截。" />
        <div class="form-grid"><el-form-item label="付款后等待多久"><el-select v-model="policyForm.minOrderAgeMinutes"><el-option v-for="value in [2, 5, 10, 15, 30, 60]" :key="value" :label="`${value} 分钟`" :value="value" /></el-select></el-form-item>
          <el-form-item label="每次最多发货"><el-select v-model="policyForm.maxBatchSize"><el-option v-for="value in [1, 2, 5, 10]" :key="value" :label="`${value} 单`" :value="value" /></el-select></el-form-item></div>
      </el-form>
      <template #footer><el-button @click="policyDrawer = false">取消</el-button><el-button type="primary" :loading="savingPolicy" @click="persistPolicy">保存配置</el-button></template>
    </el-drawer>
  </div>
</template>

<style scoped>
.fulfillment-vue-page { display: grid; gap: 16px; }
.fulfillment-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.account-strip { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px 20px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-bg-color); }
.account-identity, .account-actions { display: flex; align-items: center; gap: 12px; }
.account-identity > div { display: grid; gap: 2px; }
.account-identity small, .eyebrow { color: var(--el-text-color-secondary); font-size: 12px; }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; }
.account-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; color: var(--el-text-color-secondary); background: var(--el-fill-color-light); }
.account-icon.connected { color: var(--el-color-success); background: var(--el-color-success-light-9); }
.fulfillment-queue-panel { display: grid; gap: 14px; padding: 18px 20px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-bg-color); }
.queue-panel-header, .queue-panel-header > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.queue-panel-actions { display: flex; align-items: center; gap: 8px; }
.queue-panel-header > div > div { display: grid; gap: 2px; }
.queue-panel-header h3 { margin: 0; }
.queue-stat-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; }
.queue-stat-grid > div { display: grid; gap: 3px; min-width: 0; padding: 13px 15px; border-right: 1px solid var(--el-border-color-lighter); }
.queue-stat-grid > div:last-child { border-right: 0; }
.queue-stat-grid span, .queue-stat-grid small { color: var(--el-text-color-secondary); font-size: 12px; }
.queue-stat-grid strong { overflow-wrap: anywhere; color: var(--el-text-color-primary); font-size: 20px; font-variant-numeric: tabular-nums; line-height: 1.25; }
.queue-catchup-message { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--el-color-warning-light-9); color: var(--el-text-color-primary); line-height: 1.5; }
.queue-catchup-message svg { flex: 0 0 auto; margin-top: 3px; color: var(--el-color-warning); }
.queue-last-message, .queue-pause-reason { margin: 0; padding: 9px 12px; border-radius: 8px; color: var(--el-text-color-regular); background: var(--el-fill-color-light); font-size: 13px; line-height: 1.5; }
.queue-pause-reason { display: flex; align-items: flex-start; gap: 7px; color: var(--el-color-danger-dark-2); background: var(--el-color-danger-light-9); }
.message-review-panel { display: grid; gap: 16px; }
.message-review-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.message-review-title, .message-review-header-actions, .message-review-summary, .message-review-summary > span { display: flex; align-items: center; gap: 10px; }
.message-review-title { align-items: flex-start; }
.message-review-title > div { display: grid; gap: 3px; }
.message-review-title h3, .message-review-title p { margin: 0; }
.message-review-title p { max-width: 720px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.55; }
.panel-icon { display: grid; place-items: center; flex: 0 0 auto; width: 38px; height: 38px; border-radius: 10px; color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.message-review-header-actions { flex: 0 0 auto; }
.message-review-modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.message-review-mode { display: grid; gap: 4px; min-height: 68px; padding: 12px 14px; border: 1px solid var(--el-border-color); border-radius: 10px; color: var(--el-text-color-primary); background: var(--el-bg-color); text-align: left; cursor: pointer; transition: border-color .2s ease, background-color .2s ease, box-shadow .2s ease; }
.message-review-mode:hover { border-color: var(--el-color-primary-light-5); background: var(--el-color-primary-light-9); }
.message-review-mode:focus-visible { outline: 3px solid var(--el-color-primary-light-5); outline-offset: 2px; }
.message-review-mode.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); box-shadow: 0 0 0 1px var(--el-color-primary-light-5); }
.message-review-mode.danger.active { border-color: var(--el-color-warning); background: var(--el-color-warning-light-9); box-shadow: 0 0 0 1px var(--el-color-warning-light-5); }
.message-review-mode:disabled { cursor: wait; opacity: .55; }
.message-review-mode span { font-weight: 650; }
.message-review-mode small { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.45; }
.message-review-summary { flex-wrap: wrap; min-height: 36px; padding: 8px 12px; border-radius: 8px; color: var(--el-text-color-regular); background: var(--el-fill-color-light); font-size: 13px; }
.message-review-summary > span { gap: 5px; }
.message-review-summary > small { margin-left: auto; color: var(--el-text-color-secondary); }
.message-review-list { display: grid; min-height: 72px; border-top: 1px solid var(--el-border-color-lighter); }
.message-review-order { display: grid; grid-template-columns: minmax(180px, 1.25fr) minmax(180px, 1fr) 110px minmax(210px, 1.2fr) 132px; align-items: center; gap: 14px; min-height: 76px; padding: 12px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.message-review-order.blocked { background: var(--el-fill-color-extra-light); }
.order-primary, .order-detail, .order-check { display: grid; gap: 4px; min-width: 0; }
.order-primary strong { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.order-primary span, .order-detail span, .order-check small { color: var(--el-text-color-secondary); font-size: 12px; }
.order-detail strong { overflow-wrap: anywhere; font-size: 13px; font-weight: 550; }
.order-check { justify-items: start; }
.message-review-order > .el-button { min-height: 44px; }
.table-caption { display: flex; align-items: center; justify-content: space-between; color: var(--el-text-color-secondary); font-size: 13px; margin-bottom: 8px; }
.shop-filterbar > div { display: flex; align-items: center; gap: 8px; }
.suggestion-batchbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 12px 0; padding: 12px 14px; border: 1px solid var(--el-color-warning-light-7); border-radius: 9px; background: var(--el-color-warning-light-9); }
.suggestion-batchbar > div { display: flex; align-items: center; gap: 8px; }
.suggestion-batchbar span { color: var(--el-text-color-regular); font-size: 13px; }
.shop-batchbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 12px 0; padding: 12px 14px; border: 1px solid var(--el-color-primary-light-7); border-radius: 9px; background: var(--el-color-primary-light-9); }
.shop-batch-summary { display: grid; gap: 2px; min-width: 180px; }
.shop-batch-summary strong { color: var(--el-text-color-primary); font-size: 13px; }
.shop-batch-summary span { color: var(--el-text-color-secondary); font-size: 12px; }
.shop-batch-controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.policy-import-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 14px; padding: 14px 16px; border-radius: 10px; background: var(--el-fill-color-light); }
.policy-import-head > div { display: grid; gap: 4px; }
.policy-import-head span, .policy-import-summary small, .policy-import-summary + .el-table small, .policy-import-summary + .el-table :deep(.cell) small { display: block; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.45; }
.import-help { margin: 2px 0 14px; }
.policy-import-summary { display: flex; align-items: center; gap: 8px; margin: 12px 0 8px; }
.policy-import-summary > span { margin-right: auto; color: var(--el-text-color-regular); font-size: 13px; }
.import-warehouse, .import-issues { display: block; overflow-wrap: anywhere; font-size: 12px; line-height: 1.45; }
.import-issues { margin-top: 5px; color: var(--el-color-warning-dark-2); }
.dialog-form, .policy-form { margin-top: 18px; }
.field-help { margin: -10px 0 18px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.field-help.warning { color: var(--el-color-warning); }
.issue-guidance { display: grid; gap: 4px; padding: 5px 0; line-height: 1.45; }
.issue-guidance strong { color: var(--el-text-color-primary); font-weight: 600; }
.issue-guidance span { color: var(--el-text-color-secondary); font-size: 13px; }
.technical-detail { display: grid; gap: 8px; overflow-wrap: anywhere; }
.technical-detail > span { color: var(--el-text-color-secondary); font-size: 12px; }
.technical-detail code { padding: 7px 9px; border-radius: 6px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); white-space: normal; }
.batch-order-ids { display: grid; gap: 3px; color: var(--el-text-color-primary); font-variant-numeric: tabular-nums; }
.mobile-recovery-list { display: none; }
.mobile-recovery-card { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; background: var(--el-bg-color); }
.mobile-recovery-card header, .mobile-recovery-card footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.mobile-recovery-card header > div { display: grid; gap: 3px; min-width: 0; }
.mobile-recovery-card header span, .mobile-recovery-card footer > span { color: var(--el-text-color-secondary); font-size: 12px; }
.mobile-recovery-card footer { align-items: center; padding-top: 4px; border-top: 1px solid var(--el-border-color-lighter); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 18px; }
.policy-form :deep(.el-segmented) { width: 100%; }
.selected-warehouse-list { display: grid; gap: 6px; margin: -10px 0 18px; }
.selected-warehouse-list span { overflow-wrap: anywhere; padding: 7px 10px; border-radius: 6px; color: var(--el-text-color-regular); background: var(--el-fill-color-light); font-size: 13px; line-height: 1.45; }
:global(.policy-drawer) { max-width: 100%; }
:global(.warehouse-select-popper) { min-width: min(560px, calc(100vw - 24px)) !important; max-width: min(680px, calc(100vw - 24px)); }
:global(.warehouse-select-popper .el-select-dropdown__item) { height: auto; min-height: 40px; padding-top: 8px; padding-bottom: 8px; white-space: normal; }
:global(.warehouse-select-popper .warehouse-option-text) { display: block; overflow-wrap: anywhere; white-space: normal; line-height: 1.5; }
@media (max-width: 1100px) { .message-review-order { grid-template-columns: 1.2fr 1fr 100px 1fr; } .message-review-order > .el-button { grid-column: 4; } }
@media (max-width: 1024px) { .fulfillment-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .queue-stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .queue-stat-grid > div { border-bottom: 1px solid var(--el-border-color-lighter); } }
@media (max-width: 760px) { .account-strip, .account-actions, .shop-filterbar, .shop-filterbar > div, .suggestion-batchbar, .suggestion-batchbar > div, .shop-batchbar, .shop-batch-controls, .message-review-header, .message-review-header-actions, .policy-import-head { align-items: stretch; flex-direction: column; } .suggestion-batchbar .el-button, .shop-batch-controls .el-button { width: 100%; margin-left: 0; } .account-actions :deep(.el-select), .shop-filterbar :deep(.el-select), .shop-filterbar :deep(.el-input), .shop-batch-controls :deep(.el-select) { width: 100% !important; } .form-grid, .fulfillment-metrics, .message-review-modes, .queue-stat-grid { grid-template-columns: 1fr; } .queue-stat-grid > div { border-right: 0; } .queue-stat-grid > div:last-child { border-bottom: 0; } .message-review-summary > small { width: 100%; margin-left: 0; } .message-review-order { grid-template-columns: 1fr 1fr; padding: 16px 0; } .order-primary, .order-check { grid-column: 1 / -1; } .message-review-order > .el-button { grid-column: 1 / -1; width: 100%; } .desktop-recovery-table { display: none; } .mobile-recovery-list { display: grid; gap: 10px; padding-top: 4px; } :global(.policy-drawer) { width: 100% !important; } }
@media (max-width: 760px) { .queue-panel-header { align-items: stretch; flex-direction: column; } .queue-panel-actions { justify-content: space-between; } .queue-panel-actions .el-button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .message-review-mode { transition: none; } }
</style>
