<script setup lang="ts">
import {
  Bot,
  Ban,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  DatabaseZap,
  Headphones,
  Link2,
  MessageSquareText,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  Save,
  ServerCog,
  ShieldCheck,
  Sparkles,
  TextCursorInput,
  Truck,
  Wifi,
  WifiOff,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  confirmCustomerServiceShopBinding,
  createCustomerServiceAccount,
  loadCustomerServiceAccounts,
  loadCustomerServiceContext,
  loadCustomerServiceConversation,
  loadCustomerServiceInbox,
  loadCustomerServiceLocalRuntime,
  loadCustomerServiceQualityBreakdown,
  loadCustomerServiceStatus,
  markCustomerServiceConversationHandled,
  queueCustomerServiceReply,
  rebuildCustomerServiceContext,
  retryCustomerServiceLocalRuntime,
  reviewCustomerServiceSuggestion,
  startCustomerServiceLocalRuntime,
  stopCustomerServiceLocalRuntime,
  updateCustomerServiceAccountAutomation,
  type CommerceShopCandidate,
  type CustomerServiceAccount,
  type CustomerServiceAutomationMode,
  type CustomerServiceContextDetail,
  type CustomerServiceConversationDetail,
  type CustomerServiceInboxItem,
  type CustomerServiceLocalRuntime,
  type CustomerServiceLocalRuntimeStatus,
  type CustomerServiceQualityBreakdown,
  type CustomerServiceQualityDimension,
  type CustomerServiceRolloutBlocker,
  type CustomerServiceStatus,
  type CustomerServiceSuggestionStatus,
} from "@/services/customer-service";
import { ApiError } from "@/services/api";
import { useWorkspaceStore } from "@/stores/workspace";

const route = useRoute();
const router = useRouter();
const workspace = useWorkspaceStore();
const loading = ref(true);
const detailLoading = ref(false);
const actionLoading = ref(false);
const error = ref("");
const status = ref<CustomerServiceStatus | null>(null);
const qualityDimension = ref<CustomerServiceQualityDimension>("intent");
const qualityBreakdown = ref<CustomerServiceQualityBreakdown | null>(null);
const accounts = ref<CustomerServiceAccount[]>([]);
const conversations = ref<CustomerServiceInboxItem[]>([]);
const selectedId = ref("");
const detail = ref<CustomerServiceConversationDetail | null>(null);
const contextDetail = ref<CustomerServiceContextDetail | null>(null);
const search = ref("");
const accountId = ref("");
const inboxStatus = ref<"OPEN" | "HANDLED" | "ALL">("OPEN");
const accountDialogOpen = ref(false);
const accountDialogError = ref("");
const copiedAccountId = ref("");
const accountModeErrors = ref<Record<string, string>>({});
const rolloutStages: Array<{ mode: CustomerServiceAutomationMode; label: string }> = [
  { mode: "OBSERVE_ONLY", label: "仅观察" },
  { mode: "SUGGEST_ONLY", label: "生成建议" },
  { mode: "DRAFT_FILL", label: "回填输入框" },
];
const selectedShopCandidateId = ref("");
const draftText = ref("");
const savedDraftText = ref("");
const draftSuggestionId = ref("");
type ReviewFeedbackAction = "EDIT" | "REJECT";
const feedbackDialogOpen = ref(false);
const feedbackForm = reactive({
  action: "EDIT" as ReviewFeedbackAction,
  reasonCode: "",
  comment: "",
  queueFill: false,
});
const feedbackReasonCatalog: Record<ReviewFeedbackAction, Array<{ value: string; label: string }>> = {
  EDIT: [
    { value: "FACT_CORRECTION", label: "修正事实" },
    { value: "ADD_MISSING_CONTEXT", label: "补充缺失信息" },
    { value: "TONE_ADJUSTMENT", label: "调整语气" },
    { value: "LANGUAGE_CORRECTION", label: "修正语言或翻译" },
    { value: "POLICY_CORRECTION", label: "修正政策话术" },
    { value: "SHORTEN_REPLY", label: "回复过长，需要精简" },
    { value: "CLARIFY_REPLY", label: "表达不清，需要改写" },
    { value: "OTHER_EDIT", label: "其他修改" },
  ],
  REJECT: [
    { value: "FACT_ERROR", label: "事实错误" },
    { value: "MISSING_CONTEXT", label: "缺少关键上下文" },
    { value: "WRONG_INTENT", label: "理解错客户意图" },
    { value: "WRONG_LANGUAGE", label: "语言或翻译错误" },
    { value: "UNSAFE_PROMISE", label: "包含不安全承诺" },
    { value: "POLICY_MISMATCH", label: "不符合店铺政策" },
    { value: "POOR_TONE", label: "语气不合适" },
    { value: "TOO_VERBOSE", label: "内容冗长" },
    { value: "OTHER", label: "其他原因" },
  ],
};
const accountForm = reactive({
  displayName: "",
  countryCodes: [] as string[],
});
const accountDialogAccountId = ref("");
const accountDialogAccountName = ref("");
const accountLocalRuntime = ref<CustomerServiceLocalRuntime | null>(null);
const accountConnectLoading = ref(false);
const accountRuntimeCompletionAnnounced = ref(false);
let loadController: AbortController | null = null;
let detailController: AbortController | null = null;
let pollTimer: number | null = null;
let accountRuntimePollTimer: number | null = null;
let accountRuntimePollController: AbortController | null = null;

const filteredConversations = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase();
  if (!keyword) return conversations.value;
  return conversations.value.filter((item) => [
    item.customerDisplayName,
    item.shopName,
    item.accountName,
    item.latestMessage?.content,
  ].some((value) => String(value || "").toLocaleLowerCase().includes(keyword)));
});
const onlineWorkers = computed(() => status.value?.workers?.filter((worker) => worker.online).length || 0);
const openCount = computed(() => Number(status.value?.conversations?.OPEN || 0));
const waitingCount = computed(() => Number(status.value?.suggestions?.QUEUED || 0) + Number(status.value?.suggestions?.GENERATING || 0));
const confirmationCount = computed(() => ["READY", "ACCEPTED", "EDITED", "FILLED"]
  .reduce((total, key) => total + Number(status.value?.suggestions?.[key] || 0), 0));
const selectedSuggestion = computed(() => detail.value?.suggestions.find((item) => !["STALE", "REJECTED"].includes(item.status)) || detail.value?.suggestions[0] || null);
const selectedSuggestionSendObserved = computed(() => Boolean(selectedSuggestion.value?.id && (detail.value?.sendActions || []).some((item) => (
  item.action === "SEND_OBSERVED"
  && item.suggestionId === selectedSuggestion.value?.id
  && item.outcome === "MATCHED_AI_DRAFT"
))));
const draftDirty = computed(() => Boolean(draftSuggestionId.value) && draftText.value.trim() !== savedDraftText.value.trim());
const suggestionReviewable = computed(() => Boolean(selectedSuggestion.value?.draft)
  && ["READY", "ACCEPTED", "EDITED"].includes(String(selectedSuggestion.value?.status)));
const selectedAccount = computed(() => accounts.value.find((account) => (
  account.id === detail.value?.conversation.accountId
)) || null);
const draftFillAvailable = computed(() => status.value?.replyAutomation.draftFillEnabled === true
  && selectedAccount.value?.settings.automationMode === "DRAFT_FILL");
const draftFillAvailabilityMessage = computed(() => {
  if (status.value?.replyAutomation.draftFillEnabled !== true) {
    return "系统级输入框回填尚未开启；你仍可先采纳建议完成人工审核。";
  }
  const mode = selectedAccount.value?.settings.automationMode || "OBSERVE_ONLY";
  if (mode === "SUGGEST_ONLY") {
    return "当前账号为“只生成建议”。请先采纳建议或保存修改，再到账号管理升级为“生成并填入”。";
  }
  if (mode === "OBSERVE_ONLY") {
    return "当前账号仍为“仅观察”，需要按账号放行步骤先开启 AI 建议。";
  }
  return "正在确认账号的输入框回填权限。";
});
const suggestionHighRisk = computed(() => selectedSuggestion.value?.qualityFlags
  .some((item) => /HIGH_RISK|MONEY|COMPENSATION|COMPLIANCE|SAFETY/.test(item)) || false);
const suggestionAutoFillBlocked = computed(() => selectedSuggestion.value?.qualityFlags
  .some((item) => item === "DETERMINISTIC_QUALITY_GATE_BLOCKED"
    || item === "LOW_CONFIDENCE_AUTO_FILL_BLOCKED"
    || item.startsWith("HIGH_RISK_")
    || item === "UNRECOGNIZED_EVIDENCE_REFERENCE") || false);
const activeAccountLeases = computed(() => status.value?.accountLeases?.filter((lease) =>
  lease.status === "ACTIVE" && Date.parse(lease.leasedUntil) > Date.now()).length || 0);
const feedbackReasonOptions = computed(() => feedbackReasonCatalog[feedbackForm.action]);
const topReviewReason = computed(() => Object.entries(status.value?.quality?.reviewReasons || {})
  .sort((left, right) => right[1] - left[1])[0] || null);
const selectedEvidence = computed(() => {
  const id = selectedSuggestion.value?.id;
  return id ? detail.value?.evidence.filter((item) => item.suggestionId === id) || [] : [];
});
const shopCandidates = computed<CommerceShopCandidate[]>(() => contextDetail.value?.context.shop.registryResolution?.candidates || []);
const inventoryRows = computed(() => contextDetail.value?.context.inventory.snapshots || []);
const inventoryAvailable = computed(() => inventoryRows.value.reduce((total, row) => {
  const value = Number(row.availableQuantity);
  return total + (Number.isFinite(value) ? value : 0);
}, 0));
const logisticsRecords = computed(() => contextDetail.value?.context.logistics.records || []);
const logisticsSummary = computed(() => {
  const logistics = contextDetail.value?.context.logistics;
  if (logistics?.authoritative && logistics.resolutionStatus === "RESOLVED") {
    const trackingCodes = [...new Set(logisticsRecords.value
      .map((row) => String(row.trackingCode || "").trim()).filter(Boolean))];
    return trackingCodes.length
      ? `平台已核验 · 运单 ${trackingCodes.slice(0, 2).join(" / ")}`
      : "平台已核验 · 暂未分配运单号";
  }
  return logistics?.observed ? "仅有乐聊网页观察，尚未取得平台权威数据" : "尚未取得物流信息";
});
const knowledgeCount = computed(() => {
  const knowledge = contextDetail.value?.context.knowledge;
  return (knowledge?.claims?.length || 0)
    + (knowledge?.accessories?.length || 0)
    + (knowledge?.policies?.length || 0)
    + (knowledge?.playbooks?.length || 0);
});
const missingFields = computed(() => contextDetail.value?.snapshot.missingFields || []);
const accountCreationBlocked = computed(() => status.value?.ready !== true);
const accountRuntimeStatus = computed<CustomerServiceLocalRuntimeStatus>(() => accountLocalRuntime.value?.status || "IDLE");
const accountRuntimeBusy = computed(() => [
  "STARTING",
  "WAITING_FOR_LOGIN",
  "SESSION_READY",
  "MONITOR_STARTING",
  "STOPPING",
].includes(accountRuntimeStatus.value));
const accountDialogBusy = computed(() => accountConnectLoading.value || accountRuntimeBusy.value);
const accountWizardActive = computed(() => {
  if (accountRuntimeStatus.value === "MONITORING") return 3;
  if (["SESSION_READY", "MONITOR_STARTING", "STOPPING"].includes(accountRuntimeStatus.value)) return 2;
  if (accountDialogAccountId.value) return 1;
  return 0;
});

function clearAccountRuntimePoll() {
  if (accountRuntimePollTimer !== null) window.clearTimeout(accountRuntimePollTimer);
  accountRuntimePollTimer = null;
  accountRuntimePollController?.abort();
  accountRuntimePollController = null;
}

function resetAccountDialogState() {
  clearAccountRuntimePoll();
  accountDialogError.value = "";
  accountDialogAccountId.value = "";
  accountDialogAccountName.value = "";
  accountLocalRuntime.value = null;
  accountConnectLoading.value = false;
  accountRuntimeCompletionAnnounced.value = false;
  Object.assign(accountForm, { displayName: "", countryCodes: [] });
}

function openAccountDialog() {
  resetAccountDialogState();
  accountDialogOpen.value = true;
}

function accountCreationUnavailableMessage() {
  return "客服数据库尚未完成部署，暂时不能接入账号。完成客服数据库迁移并刷新状态后，这里会自动开放。";
}

function localRuntimeStatusLabel(value: CustomerServiceLocalRuntimeStatus) {
  return ({
    IDLE: "尚未启动",
    STARTING: "正在启动本机浏览器",
    WAITING_FOR_LOGIN: "等待人工登录",
    SESSION_READY: "本机 Session 已保存",
    MONITOR_STARTING: "正在启动监控",
    MONITORING: "正在仅观察监控",
    STOPPING: "正在停止登录任务",
    STOPPED: "接入已暂停",
    FAILED: "接入失败",
  } as Record<CustomerServiceLocalRuntimeStatus, string>)[value];
}

function localRuntimeStatusMessage(value: CustomerServiceLocalRuntimeStatus) {
  return ({
    IDLE: "账号记录已保留。继续后将在这台客服电脑打开独立乐聊浏览器。",
    STARTING: "正在准备独立浏览器与本机数据目录，请稍候…",
    WAITING_FOR_LOGIN: "请在已打开的乐聊窗口中完成账号登录、扫码、验证码或二次验证。",
    SESSION_READY: "登录成功，Session 只保存在本机。正在切换到持续监控…",
    MONITOR_STARTING: "正在启动账号专属监控进程并验证中央连接…",
    MONITORING: "接入成功。账号正以“仅观察”模式监控；首次采集到客户消息后会自动激活。",
    STOPPING: "正在安全关闭本次登录任务…",
    STOPPED: "本次接入已停止。中央账号记录仍然保留，可随时继续。",
    FAILED: "中央账号记录已保留。请按下方提示重试，不会重复创建账号。",
  } as Record<CustomerServiceLocalRuntimeStatus, string>)[value];
}

function fact(record: Record<string, unknown> | undefined | null, key: string, fallback = "—") {
  const value = record?.[key];
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDuration(value?: number | null) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

function suggestionLabel(value?: CustomerServiceSuggestionStatus | null) {
  return ({
    QUEUED: "等待生成",
    GENERATING: "生成中",
    READY: "系统待确认",
    STALE: "已被新消息替代",
    FAILED: "生成失败",
    ACCEPTED: "已采纳",
    EDITED: "已编辑",
    REJECTED: "已拒绝",
    FILLED: "已填入乐聊",
  } as Record<string, string>)[String(value || "")] || "尚未生成";
}

function suggestionType(value?: CustomerServiceSuggestionStatus | null) {
  if (value === "READY" || value === "FILLED" || value === "ACCEPTED") return "success";
  if (value === "FAILED" || value === "STALE") return "danger";
  if (value === "GENERATING" || value === "QUEUED") return "warning";
  return "info";
}

function qualityFlagLabel(value: string) {
  return ({
    LOW_CONFIDENCE_AUTO_FILL_BLOCKED: "置信度低，仅人工审核",
    UNRECOGNIZED_EVIDENCE_REFERENCE: "引用了不存在的证据",
    HIGH_RISK_FINANCIAL_OR_COMPENSATION: "退款或赔偿承诺",
    HIGH_RISK_UNSUPPORTED_DELIVERY_COMMITMENT: "无依据的时效承诺",
    HIGH_RISK_UNKNOWN_TRACKING_IDENTIFIER: "运单号未经证据核验",
    HIGH_RISK_UNSUPPORTED_LOGISTICS_STATUS: "物流状态缺少权威依据",
    HIGH_RISK_UNSUPPORTED_ORDER_STATUS: "订单状态缺少权威依据",
    HIGH_RISK_UNSUPPORTED_STOCK_STATUS: "库存状态缺少权威依据",
    DETERMINISTIC_QUALITY_GATE_BLOCKED: "已阻止自动回填",
  } as Record<string, string>)[value] || value;
}

function qualityFlagType(value: string) {
  if (value.startsWith("HIGH_RISK_") || value === "UNRECOGNIZED_EVIDENCE_REFERENCE") return "danger";
  if (value.includes("BLOCKED") || value.includes("CONFIDENCE")) return "warning";
  return "info";
}

function reviewReasonLabel(value: string) {
  const option = [...feedbackReasonCatalog.EDIT, ...feedbackReasonCatalog.REJECT]
    .find((item) => item.value === value);
  return option?.label || (value === "AI_REPLY_APPROVED" ? "直接采用" : value);
}

function evidenceType(sourceType: string) {
  if (sourceType === "MABANG_ORDER" || sourceType === "MABANG_INVENTORY") return "success";
  if (sourceType === "PRODUCT_KNOWLEDGE_RELEASE") return "primary";
  return "info";
}

function automationModeLabel(mode?: CustomerServiceAutomationMode) {
  return ({
    OBSERVE_ONLY: "仅观察",
    SUGGEST_ONLY: "只生成建议",
    DRAFT_FILL: "生成并填入",
  } as Record<string, string>)[String(mode || "OBSERVE_ONLY")] || "仅观察";
}

function automationModeOptionDisabled(account: CustomerServiceAccount, target: CustomerServiceAutomationMode) {
  const rank: Record<CustomerServiceAutomationMode, number> = {
    OBSERVE_ONLY: 0,
    SUGGEST_ONLY: 1,
    DRAFT_FILL: 2,
  };
  const current = account.settings.automationMode || "OBSERVE_ONLY";
  if (rank[target] <= rank[current]) return false;
  if (!account.rollout) return true;
  return target !== account.rollout.nextMode || !account.rollout.canAdvance;
}

function rolloutStageReached(account: CustomerServiceAccount, stage: number) {
  return Number(account.rollout?.stageIndex || 1) >= stage;
}

function rolloutBlockerLabel(code: CustomerServiceRolloutBlocker | "CS_ROLLOUT_STATUS_UNAVAILABLE") {
  return ({
    CS_AUTOMATION_TRANSITION_INVALID: "必须按阶段逐级开启，不能跳级",
    CS_REPLY_AGENT_NOT_CONFIGURED: "回复模型尚未配置",
    CS_AI_ROLLOUT_DISABLED: "系统级 AI 建议开关尚未开启",
    CS_PRODUCT_KNOWLEDGE_NOT_READY: "共享产品知识库尚未完成迁移",
    CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED: "需要先审核并发布至少 1 个客服知识版本",
    CS_ACCOUNT_ACTIVE_REQUIRED: "浏览器账号尚未成功采集并激活",
    CS_ACCOUNT_OBSERVATION_REQUIRED: "需要先采集至少 1 条客户消息",
    CS_DRAFT_FILL_DISABLED: "系统级输入框回填开关尚未开启",
    CS_SUGGESTION_GENERATION_REQUIRED: "需要先成功生成至少 1 条建议",
    CS_SUGGESTION_REVIEW_REQUIRED: "需要先人工接受或编辑至少 1 条建议",
    CS_ROLLOUT_STATUS_UNAVAILABLE: "放行状态不可用，请部署并重启最新客服服务",
  } as Record<string, string>)[code] || code;
}

function accountRolloutBlockers(account: CustomerServiceAccount) {
  if (account.rollout) return account.rollout.blockers;
  return account.settings.automationMode === "DRAFT_FILL"
    ? []
    : ["CS_ROLLOUT_STATUS_UNAVAILABLE" as const];
}

function accountNextMode(account: CustomerServiceAccount): CustomerServiceAutomationMode | null {
  if (account.rollout) return account.rollout.nextMode;
  return account.settings.automationMode === "OBSERVE_ONLY"
    ? "SUGGEST_ONLY"
    : account.settings.automationMode === "SUGGEST_ONLY" ? "DRAFT_FILL" : null;
}

function accountCanAdvance(account: CustomerServiceAccount) {
  return account.rollout?.canAdvance === true;
}

function missingLabel(value: string) {
  return ({
    confirmed_commerce_shop_identity: "店铺尚未绑定到系统店铺",
    liaoliao_right_panel_snapshot: "尚未读取乐聊右侧详情",
    product_sku_observation: "未识别到商品 SKU",
    product_core_exact_match: "SKU 未精确匹配产品中心",
    published_product_knowledge: "没有已发布的产品知识",
    authoritative_order_context: "没有权威订单信息",
    authoritative_logistics_context: "权威物流轨迹尚未接入",
    authoritative_inventory_context: "没有可确认的库存信息",
    product_package_snapshot: "没有产品包快照",
  } as Record<string, string>)[value] || value;
}

async function loadDetail(id: string, focus = true) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  detailLoading.value = true;
  try {
    const [nextDetail, nextContext] = await Promise.all([
      loadCustomerServiceConversation(id, controller.signal),
      loadCustomerServiceContext(id, controller.signal).catch(() => null),
    ]);
    if (controller.signal.aborted) return;
    detail.value = nextDetail;
    contextDetail.value = nextContext;
    selectedShopCandidateId.value = nextContext?.context.shop.registryResolution?.shop?.id
      || nextContext?.context.shop.registryResolution?.candidates?.[0]?.id
      || "";
    if (focus) {
      await nextTick();
      document.querySelector<HTMLElement>(".conversation-title")?.focus();
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : "会话详情加载失败";
  } finally {
    if (detailController === controller) {
      detailController = null;
      detailLoading.value = false;
    }
  }
}

async function selectConversation(id: string) {
  if (!id || selectedId.value === id && detail.value) return;
  selectedId.value = id;
  await router.replace({ query: { ...route.query, conversation: id } });
  await loadDetail(id);
}

async function load({ preserveSelection = true, silent = false } = {}) {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  if (!silent) loading.value = true;
  error.value = "";
  try {
    const [nextStatus, nextAccounts, nextConversations] = await Promise.all([
      loadCustomerServiceStatus(controller.signal),
      loadCustomerServiceAccounts(controller.signal),
      loadCustomerServiceInbox({ accountId: accountId.value, status: inboxStatus.value }, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    const nextQuality = nextStatus.ready
      ? await loadCustomerServiceQualityBreakdown({
        dimension: qualityDimension.value,
        accountId: accountId.value || undefined,
        limit: 12,
      }, controller.signal)
      : null;
    if (controller.signal.aborted) return;
    status.value = nextStatus;
    qualityBreakdown.value = nextQuality;
    accounts.value = nextAccounts;
    conversations.value = nextConversations;
    const routeConversation = String(route.query.conversation || "");
    const retained = preserveSelection && conversations.value.some((item) => item.id === selectedId.value)
      ? selectedId.value
      : conversations.value.some((item) => item.id === routeConversation)
        ? routeConversation
        : conversations.value[0]?.id || "";
    if (retained) {
      if (selectedId.value !== retained) {
        selectedId.value = retained;
        await router.replace({ query: { ...route.query, conversation: retained } });
      }
      await loadDetail(retained, !silent);
    } else {
      selectedId.value = "";
      detail.value = null;
      contextDetail.value = null;
    }
    workspace.lastSyncedAt = new Date();
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : "客服中心加载失败";
  } finally {
    if (loadController === controller) {
      loadController = null;
      loading.value = false;
    }
  }
}

function schedulePoll() {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => {
    if (!document.hidden && !actionLoading.value) await load({ preserveSelection: true, silent: true });
    schedulePoll();
  }, 5_000);
}

function idleLocalRuntime(accountId: string): CustomerServiceLocalRuntime {
  return {
    accountId,
    status: "IDLE",
    workerId: null,
    sessionReady: false,
    monitoring: false,
    retryable: true,
    errorCode: null,
    errorMessage: null,
    message: null,
    startedAt: null,
    updatedAt: null,
    pollAfterMs: null,
  };
}

function localRuntimeErrorMessage(code: string | null, fallback: string) {
  if (!code) return fallback;
  return ({
    CS_LOCAL_LOGIN_BUSY: "另一账号正在这台客服电脑上等待人工登录。请先完成或退出该登录任务，再重试。",
    CS_LOCAL_MONITOR_CAPACITY_REACHED: "这台客服电脑已达到浏览器账号上限，请停止其他账号或改用另一台客服电脑。",
    CS_LOCAL_LOGIN_TIMEOUT: "等待登录超时。中央账号记录已保留，请重新打开登录窗口。",
    CS_LOCAL_LOGIN_START_FAILED: "未能启动乐聊登录浏览器，请检查本机运行环境后重试。",
    CS_LOCAL_LOGIN_PROCESS_ERROR: "乐聊登录进程异常退出，请重新打开登录窗口。",
    CS_LOCAL_LOGIN_EXITED: "登录窗口在完成登录前已关闭，请重新打开。",
    CS_LOCAL_SESSION_MISSING: "登录结束但未检测到本机 Session，请重新登录并等待系统自动完成。",
    CS_LOCAL_MONITOR_START_FAILED: "Session 已保存，但监控进程启动失败。请重试接入。",
    CS_LOCAL_MONITOR_PROCESS_ERROR: "账号监控进程异常退出，请重试接入。",
    CS_LOCAL_MONITOR_EXITED: "账号监控已意外停止，请重试接入。",
    CS_LOCAL_RUNTIME_PYTHON_UNAVAILABLE: "本机 Python 运行环境不可用，请先修复 Commerce Ops 运行环境。",
    CS_LOCAL_RUNTIME_INTEGRATION_UNAVAILABLE: "本机缺少乐聊连接器，请先完成 Commerce Ops 安装或部署。",
    CS_LOCAL_RUNTIME_WORKER_AUTH_NOT_CONFIGURED: "本机 Worker 认证尚未配置，请先完成客服运行环境配置。",
    CS_LOCAL_RUNTIME_NOT_CONFIGURED: "本机乐聊运行时尚未配置，请在这台客服电脑完成部署后重试。",
    CS_LOCAL_RETRY_REQUIRED: "该账号上次接入失败，请使用“重试接入”继续，不要重复创建账号。",
    CS_ACCOUNT_LEASE_CONFLICT: "该乐聊账号已在另一浏览器节点运行。请先停止原节点，再重试接入。",
  } as Record<string, string>)[code] || fallback;
}

function accountConnectionError(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    if (cause.code === "CS_SCHEMA_NOT_READY") return accountCreationUnavailableMessage();
    return localRuntimeErrorMessage(cause.code, cause.message || fallback);
  }
  return cause instanceof Error ? cause.message : fallback;
}

async function applyAccountLocalRuntime(runtime: CustomerServiceLocalRuntime) {
  accountLocalRuntime.value = runtime;
  accountDialogError.value = runtime.errorMessage
    || (runtime.errorCode ? localRuntimeErrorMessage(runtime.errorCode, "本机接入失败，请重试。") : "");
  if (runtime.status === "MONITORING" && !accountRuntimeCompletionAnnounced.value) {
    accountRuntimeCompletionAnnounced.value = true;
    ElMessage.success("乐聊账号已接入，正在仅观察监控");
    await load({ preserveSelection: true, silent: true });
  }
}

function scheduleAccountRuntimePoll(delay = accountLocalRuntime.value?.pollAfterMs || 1_200) {
  if (accountRuntimePollTimer !== null) window.clearTimeout(accountRuntimePollTimer);
  if (!accountDialogOpen.value || !accountDialogAccountId.value) return;
  if (["IDLE", "STOPPED", "FAILED", "MONITORING"].includes(accountRuntimeStatus.value)) return;
  accountRuntimePollTimer = window.setTimeout(() => { void pollAccountLocalRuntime(); }, Math.max(500, delay));
}

async function pollAccountLocalRuntime() {
  const id = accountDialogAccountId.value;
  if (!id || !accountDialogOpen.value) return;
  accountRuntimePollController?.abort();
  const controller = new AbortController();
  accountRuntimePollController = controller;
  try {
    const runtime = await loadCustomerServiceLocalRuntime(id, controller.signal);
    if (controller.signal.aborted || id !== accountDialogAccountId.value) return;
    await applyAccountLocalRuntime(runtime);
    scheduleAccountRuntimePoll();
  } catch (cause) {
    if (!controller.signal.aborted) {
      accountDialogError.value = accountConnectionError(cause, "本机接入状态读取失败，请稍后重试。");
      scheduleAccountRuntimePoll(2_500);
    }
  } finally {
    if (accountRuntimePollController === controller) accountRuntimePollController = null;
  }
}

async function startAccountConnection({ retry = false } = {}) {
  const id = accountDialogAccountId.value;
  if (!id) return;
  clearAccountRuntimePoll();
  accountDialogError.value = "";
  accountConnectLoading.value = true;
  try {
    const runtime = retry
      ? await retryCustomerServiceLocalRuntime(id)
      : await startCustomerServiceLocalRuntime(id);
    await applyAccountLocalRuntime(runtime);
    scheduleAccountRuntimePoll();
  } catch (cause) {
    const actionError = accountConnectionError(cause, "未能启动本机乐聊登录，请重试。");
    let synchronizedRunning = false;
    try {
      const runtime = await loadCustomerServiceLocalRuntime(id);
      await applyAccountLocalRuntime(runtime);
      synchronizedRunning = !["IDLE", "STOPPED", "FAILED"].includes(runtime.status);
      scheduleAccountRuntimePoll();
    } catch { /* Keep the actionable error from the requested action. */ }
    accountDialogError.value = synchronizedRunning ? "" : actionError;
  } finally {
    accountConnectLoading.value = false;
  }
}

async function resumeAccountConnection() {
  await startAccountConnection({ retry: ["FAILED", "STOPPED"].includes(accountRuntimeStatus.value) });
}

async function saveAccount() {
  accountDialogError.value = "";
  if (accountCreationBlocked.value) {
    accountDialogError.value = accountCreationUnavailableMessage();
    return;
  }
  const displayName = accountForm.displayName.trim();
  if (!displayName) {
    accountDialogError.value = "请填写用于识别该客服账号的名称。";
    return;
  }
  accountConnectLoading.value = true;
  try {
    const account = await createCustomerServiceAccount({
      displayName,
      countryCodes: accountForm.countryCodes,
    });
    accountDialogAccountId.value = account.id;
    accountDialogAccountName.value = account.displayName;
    accountLocalRuntime.value = idleLocalRuntime(account.id);
    if (!accounts.value.some((item) => item.id === account.id)) accounts.value = [...accounts.value, account];
    ElMessage.success("中央账号记录已创建，正在打开本机登录窗口");
  } catch (cause) {
    accountDialogError.value = accountConnectionError(cause, "中央账号记录创建失败，请重试。");
    return;
  } finally {
    accountConnectLoading.value = false;
  }
  await startAccountConnection();
}

async function continueAccountConnection(account: CustomerServiceAccount) {
  resetAccountDialogState();
  accountDialogAccountId.value = account.id;
  accountDialogAccountName.value = account.displayName;
  accountLocalRuntime.value = idleLocalRuntime(account.id);
  accountDialogOpen.value = true;
  accountConnectLoading.value = true;
  try {
    const runtime = await loadCustomerServiceLocalRuntime(account.id);
    await applyAccountLocalRuntime(runtime);
    scheduleAccountRuntimePoll();
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 404)) {
      accountDialogError.value = accountConnectionError(cause, "暂时无法读取该账号的本机接入状态。");
    }
  } finally {
    accountConnectLoading.value = false;
  }
}

function accountIsMonitoring(account: CustomerServiceAccount) {
  const lease = status.value?.accountLeases?.find((item) => (
    item.accountId === account.id
    && item.status === "ACTIVE"
    && Date.parse(item.leasedUntil) > Date.now()
  ));
  return Boolean(lease && status.value?.workers?.some((worker) => worker.id === lease.workerId && worker.online));
}

function accountStatusLabel(account: CustomerServiceAccount) {
  if (accountIsMonitoring(account)) return account.status === "SETUP_REQUIRED" ? "监控中，等待首条消息" : "监控中";
  return ({
    SETUP_REQUIRED: "待完成本机接入",
    ACTIVE: "浏览器节点离线",
    PAUSED: "已暂停",
    ERROR: "需要重新接入",
    DISABLED: "已停用",
  } as Record<CustomerServiceAccount["status"], string>)[account.status];
}

async function stopAndCloseAccountDialog(done?: () => void) {
  if (accountConnectLoading.value) return;
  if (accountRuntimeBusy.value && accountDialogAccountId.value) {
    try {
      await ElMessageBox.confirm(
        "退出会关闭本次本机登录任务；中央账号记录会保留，可稍后继续接入。",
        "退出接入向导",
        { type: "warning", confirmButtonText: "退出并关闭登录窗口", cancelButtonText: "继续登录" },
      );
    } catch { return; }
    accountConnectLoading.value = true;
    try {
      await stopCustomerServiceLocalRuntime(accountDialogAccountId.value);
    } catch (cause) {
      accountDialogError.value = accountConnectionError(cause, "未能停止本机登录任务，请稍后重试。");
      accountConnectLoading.value = false;
      return;
    }
  }
  clearAccountRuntimePoll();
  if (done) done();
  else accountDialogOpen.value = false;
}

function accountDialogClosed() {
  resetAccountDialogState();
}

async function refreshAccountDeploymentStatus() {
  await load({ preserveSelection: true });
  if (status.value?.ready) accountDialogError.value = "";
}

async function changeAccountMode(account: CustomerServiceAccount, rawMode: unknown) {
  const mode = String(rawMode || "") as CustomerServiceAutomationMode;
  if (!(["OBSERVE_ONLY", "SUGGEST_ONLY", "DRAFT_FILL"] as string[]).includes(mode)) return;
  if (mode === account.settings.automationMode) return;
  accountModeErrors.value = { ...accountModeErrors.value, [account.id]: "" };
  if (mode === "DRAFT_FILL") {
    try {
      await ElMessageBox.confirm(
        "启用后，低风险 AI 建议会自动填入该账号对应的乐聊输入框，但仍不会发送。确认继续吗？",
        "启用账号级草稿回填",
        { type: "warning", confirmButtonText: "确认启用", cancelButtonText: "取消" },
      );
    } catch { return; }
  }
  actionLoading.value = true;
  try {
    await updateCustomerServiceAccountAutomation(account.id, mode);
    ElMessage.success(`账号已切换为“${automationModeLabel(mode)}”`);
    await load({ preserveSelection: true, silent: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "账号运行模式更新失败";
    accountModeErrors.value = { ...accountModeErrors.value, [account.id]: message };
    error.value = message;
  } finally {
    actionLoading.value = false;
  }
}

async function advanceAccountMode(account: CustomerServiceAccount) {
  const nextMode = accountNextMode(account);
  if (!nextMode || !accountCanAdvance(account)) return;
  await changeAccountMode(account, nextMode);
}

async function copyAccountId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    copiedAccountId.value = id;
    window.setTimeout(() => { if (copiedAccountId.value === id) copiedAccountId.value = ""; }, 2_000);
  } catch {
    error.value = "无法访问剪贴板，请手动复制账号 ID";
  }
}

async function markHandled() {
  if (!selectedId.value) return;
  actionLoading.value = true;
  try {
    await markCustomerServiceConversationHandled(selectedId.value);
    ElMessage.success("会话已标记为处理完成");
    await load({ preserveSelection: false, silent: true });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "标记已处理失败";
  } finally {
    actionLoading.value = false;
  }
}

async function rebuildContext() {
  if (!selectedId.value) return;
  actionLoading.value = true;
  try {
    contextDetail.value = await rebuildCustomerServiceContext(selectedId.value);
    ElMessage.success("回复依据已重新汇总");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "回复依据重建失败";
  } finally {
    actionLoading.value = false;
  }
}

async function queueReply() {
  if (!selectedId.value) return;
  actionLoading.value = true;
  try {
    const result = await queueCustomerServiceReply(selectedId.value);
    ElMessage.success(result.duplicate ? "该消息正在生成中" : "已进入 AI 生成队列");
    await load({ preserveSelection: true, silent: true });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "回复生成任务创建失败";
  } finally {
    actionLoading.value = false;
  }
}

function openFeedbackDialog(action: ReviewFeedbackAction, queueFill = false) {
  feedbackForm.action = action;
  feedbackForm.reasonCode = "";
  feedbackForm.comment = "";
  feedbackForm.queueFill = queueFill;
  feedbackDialogOpen.value = true;
}

async function submitFeedback() {
  if (!feedbackForm.reasonCode) {
    ElMessage.warning("请选择本次修改或拒绝的原因");
    return;
  }
  const succeeded = await reviewSuggestion(feedbackForm.action, feedbackForm.queueFill, {
    reasonCode: feedbackForm.reasonCode,
    comment: feedbackForm.comment.trim() || undefined,
  });
  if (succeeded) feedbackDialogOpen.value = false;
}

async function reviewSuggestion(
  action: "ACCEPT" | "EDIT" | "REJECT",
  queueFill = false,
  feedback: { reasonCode?: string; comment?: string } = {},
) {
  const suggestion = selectedSuggestion.value;
  if (!suggestion) return false;
  const finalText = draftText.value.trim();
  const effectiveAction = action === "ACCEPT" && finalText !== String(suggestion.draft || "").trim()
    ? "EDIT"
    : action;
  if (effectiveAction === "EDIT" && !finalText) {
    ElMessage.warning("回复内容不能为空");
    return false;
  }
  let acknowledgeRisk = false;
  if (queueFill && suggestionHighRisk.value) {
    try {
      await ElMessageBox.confirm(
        "该建议包含赔偿、安全或合规风险。系统只会填入输入框，不会发送；请在乐聊中再次核对后手动发送。",
        "确认高风险草稿回填",
        { type: "warning", confirmButtonText: "已核对，填入输入框", cancelButtonText: "取消" },
      );
    } catch { return false; }
    acknowledgeRisk = true;
  }
  actionLoading.value = true;
  try {
    const reviewed = await reviewCustomerServiceSuggestion(suggestion.id, {
      action: effectiveAction,
      finalText: effectiveAction === "EDIT" ? finalText : undefined,
      queueFill,
      acknowledgeRisk,
      reasonCode: feedback.reasonCode,
      comment: feedback.comment,
    });
    savedDraftText.value = finalText;
    ElMessage.success(reviewed.commandCreated
      ? "草稿已提交到对应乐聊输入框，等待你人工检查"
      : effectiveAction === "REJECT"
        ? "该建议已拒绝"
        : queueFill
          ? "建议已审核，但未创建回填任务；请检查账号模式、浏览器连接和回填开关"
          : effectiveAction === "ACCEPT"
            ? "建议已采纳，本次不会填入乐聊输入框"
            : "人工修改已保存");
    await load({ preserveSelection: true, silent: true });
    return true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "建议审核失败";
    return false;
  } finally {
    actionLoading.value = false;
  }
}

async function confirmShop() {
  const bindingId = detail.value?.conversation.shopBindingId;
  if (!bindingId || !selectedShopCandidateId.value || !selectedId.value) return;
  actionLoading.value = true;
  try {
    await confirmCustomerServiceShopBinding(bindingId, selectedShopCandidateId.value);
    await rebuildCustomerServiceContext(selectedId.value);
    await queueCustomerServiceReply(selectedId.value);
    ElMessage.success("店铺已确认，正在按新的订单与商品依据重新生成");
    await load({ preserveSelection: true, silent: true });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "店铺绑定失败";
  } finally {
    actionLoading.value = false;
  }
}

watch([accountId, inboxStatus, qualityDimension], () => load({ preserveSelection: false }));
watch(selectedSuggestion, (next) => {
  if (!next?.id) {
    draftSuggestionId.value = "";
    draftText.value = "";
    savedDraftText.value = "";
    return;
  }
  if (draftSuggestionId.value !== next.id || !draftDirty.value) {
    draftSuggestionId.value = next.id;
    draftText.value = next.draft || "";
    savedDraftText.value = next.draft || "";
  }
}, { immediate: true });
onMounted(async () => {
  await load({ preserveSelection: false });
  schedulePoll();
});
onBeforeUnmount(() => {
  loadController?.abort();
  detailController?.abort();
  clearAccountRuntimePoll();
  if (pollTimer !== null) window.clearTimeout(pollTimer);
});
</script>

<template>
  <div class="customer-service-page" v-loading="loading">
    <section class="cs-commandbar">
      <div class="cs-runtime">
        <span class="runtime-dot" :class="{ ready: status?.ready && status?.replyAutomation.enabled }" aria-hidden="true" />
        <div>
          <strong>{{ status?.ready ? "客服控制中心已就绪" : "客服数据库尚未迁移" }}</strong>
          <span>
            {{ status?.replyAutomation.enabled ? `${status.replyAutomation.model || "AI"} 正在生成建议` : "AI 生成未启用" }}
            · 自动发送永久关闭
          </span>
        </div>
      </div>
      <div class="cs-command-actions">
        <el-button type="primary" :icon="Plus" @click="openAccountDialog">接入乐聊账号</el-button>
        <el-button :icon="RefreshCw" :loading="loading" @click="load()">刷新</el-button>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error">
      <template #default><el-button size="small" @click="load()">重新加载</el-button></template>
    </el-alert>

    <section class="rollout-contract" aria-label="客服模块上线条件">
      <span :class="{ ready: status?.ready }"><DatabaseZap :size="15" /><b>客服数据库</b>{{ status?.ready ? "已就绪" : "待迁移" }}</span>
      <span :class="{ ready: status?.dependencies?.productKnowledge.ready }">
        <PackageCheck :size="15" /><b>共享知识库</b>
        {{ status?.dependencies?.productKnowledge.ready ? `已发布 SUPPORT ${status.dependencies.productKnowledge.publishedSupportReleaseTotal}` : "待迁移或发布" }}
      </span>
      <span :class="{ active: status?.replyAutomation.enabled }"><Sparkles :size="15" /><b>AI 建议</b>{{ status?.replyAutomation.enabled ? "已开启" : "已关闭" }}</span>
      <span :class="{ active: status?.replyAutomation.draftFillEnabled }"><TextCursorInput :size="15" /><b>输入框回填</b>{{ status?.replyAutomation.draftFillEnabled ? "已开启" : "已关闭" }}</span>
      <span class="safe"><ShieldCheck :size="15" /><b>自动发送</b>永久关闭</span>
    </section>

    <section class="cs-metrics" aria-label="客服中心状态">
      <article>
        <span class="metric-symbol worker"><ServerCog :size="19" /></span>
        <div><small>在线浏览器节点</small><strong>{{ onlineWorkers }} / {{ status?.workers.length || 0 }}</strong><span>{{ activeAccountLeases }} 个账号持有主控租约</span></div>
      </article>
      <article>
        <span class="metric-symbol inbox"><MessageSquareText :size="19" /></span>
        <div><small>待处理会话</small><strong>{{ openCount }}</strong><span>按会话独立处理</span></div>
      </article>
      <article>
        <span class="metric-symbol waiting"><Clock3 :size="19" /></span>
        <div><small>AI 队列</small><strong>{{ waitingCount }}</strong><span>最多 {{ status?.replyAutomation.concurrency || 1 }} 条并行</span></div>
      </article>
      <article>
        <span class="metric-symbol ready"><CheckCircle2 :size="19" /></span>
        <div><small>待人工确认</small><strong>{{ confirmationCount }}</strong><span>只填草稿，不自动发送</span></div>
      </article>
    </section>

    <section v-if="status?.ready" class="quality-summary" aria-label="AI 回复质量反馈">
      <span>AI 质量反馈</span>
      <b>已生成 {{ status.quality.generatedTotal }}</b>
      <b>平均置信度 {{ status.quality.averageConfidence === null ? "—" : `${Math.round(status.quality.averageConfidence * 100)}%` }}</b>
      <b class="warning">低于 {{ Math.round(status.quality.minimumAutoFillConfidence * 100) }}%：{{ status.quality.belowThresholdTotal }}</b>
      <b>人工采用 {{ status.quality.reviews.ACCEPT || 0 }} / 编辑 {{ status.quality.reviews.EDIT || 0 }} / 拒绝 {{ status.quality.reviews.REJECT || 0 }}</b>
      <b>平均修改幅度 {{ status.quality.averageEditRatio === null ? "—" : `${Math.round(status.quality.averageEditRatio * 100)}%` }} · 大幅修改 {{ status.quality.majorEditTotal }}</b>
      <b>已观察人工回复 {{ status.quality.observedOutboundTotal || 0 }} · AI 原样采用 {{ status.quality.matchedAiDraftSendTotal || 0 }}<template v-if="status.quality.exactAiDraftShare !== null && status.quality.exactAiDraftShare !== undefined">（占已观察出站 {{ Math.round(status.quality.exactAiDraftShare * 100) }}%）</template></b>
      <b>首次响应 P50 {{ formatDuration(status.quality.firstResponseP50Ms) }} · P95 {{ formatDuration(status.quality.firstResponseP95Ms) }}（样本 {{ status.quality.firstResponseSampleTotal || 0 }}）</b>
      <b>显式标记已处理 {{ status.quality.explicitHandledTotal || 0 }}<template v-if="status.quality.explicitHandledRate !== null && status.quality.explicitHandledRate !== undefined">（当前处理率 {{ Math.round(status.quality.explicitHandledRate * 100) }}%）</template> · 处理耗时 P50 {{ formatDuration(status.quality.handlingP50Ms) }} / P95 {{ formatDuration(status.quality.handlingP95Ms) }}（样本 {{ status.quality.handlingSampleTotal || 0 }}）</b>
      <b>模型 Token {{ status.quality.totalTokens.toLocaleString() }}（输入 {{ status.quality.inputTokens.toLocaleString() }} / 输出 {{ status.quality.outputTokens.toLocaleString() }}）</b>
      <b v-if="topReviewReason">主要反馈 {{ reviewReasonLabel(topReviewReason[0]) }} × {{ topReviewReason[1] }}</b>
    </section>

    <section v-if="status?.ready" class="quality-breakdown" aria-label="AI 回复分维度质量">
      <header>
        <div><strong>质量分层</strong><span>按国家、类目、意图、风险、账号、店铺或模型定位问题</span></div>
        <el-select v-model="qualityDimension" aria-label="选择质量统计维度">
          <el-option label="客户意图" value="intent" />
          <el-option label="国家" value="country" />
          <el-option label="产品类目" value="category" />
          <el-option label="风险等级" value="risk" />
          <el-option label="乐聊账号" value="account" />
          <el-option label="系统店铺" value="shop" />
          <el-option label="AI 模型" value="model" />
        </el-select>
      </header>
      <div v-if="qualityBreakdown?.rows.length" class="quality-breakdown-list">
        <article v-for="row in qualityBreakdown.rows" :key="`${row.dimension}:${row.value}`">
          <strong>{{ row.value === "UNKNOWN" ? "尚未识别" : row.value }}</strong>
          <span>生成 {{ row.generatedTotal }} · 采用 {{ row.acceptedTotal }} · 编辑 {{ row.editedTotal }} · 拒绝 {{ row.rejectedTotal }}</span>
          <small>置信度 {{ row.averageConfidence === null ? "—" : `${Math.round(row.averageConfidence * 100)}%` }} · 修改 {{ row.averageEditRatio === null ? "—" : `${Math.round(row.averageEditRatio * 100)}%` }} · Token {{ row.totalTokens.toLocaleString() }}</small>
        </article>
      </div>
      <el-empty v-else :image-size="42" description="产生人工审核数据后，将在这里显示质量分层" />
    </section>

    <section class="cs-toolbar" aria-label="会话筛选">
      <el-select v-model="accountId" clearable placeholder="全部乐聊账号" aria-label="筛选乐聊账号">
        <el-option v-for="account in accounts" :key="account.id" :label="account.displayName" :value="account.id" />
      </el-select>
      <el-segmented v-model="inboxStatus" :options="[
        { label: '待处理', value: 'OPEN' },
        { label: '已处理', value: 'HANDLED' },
        { label: '全部', value: 'ALL' },
      ]" />
      <el-input v-model="search" clearable :prefix-icon="Search" placeholder="搜索客户、店铺或消息" aria-label="搜索客服会话" />
      <span class="toolbar-count">{{ filteredConversations.length }} 个会话</span>
    </section>

    <section class="cs-workbench">
      <aside class="inbox-pane dashboard-panel" aria-label="客服会话列表">
        <header><div><span class="panel-kicker">INBOX</span><h3>会话队列</h3></div><Headphones :size="18" /></header>
        <div v-if="filteredConversations.length" class="inbox-list">
          <button
            v-for="item in filteredConversations"
            :key="item.id"
            type="button"
            class="inbox-item"
            :class="{ active: item.id === selectedId }"
            :aria-current="item.id === selectedId ? 'true' : undefined"
            @click="selectConversation(item.id)"
          >
            <span class="customer-avatar" aria-hidden="true">{{ item.customerDisplayName.slice(0, 1).toUpperCase() }}</span>
            <span class="inbox-copy">
              <span class="inbox-line"><strong>{{ item.customerDisplayName }}</strong><time>{{ formatTime(item.latestMessageAt) }}</time></span>
              <span class="shop-line">{{ item.shopName || item.accountName || "未识别店铺" }}<b v-if="item.countryCode">{{ item.countryCode }}</b></span>
              <span class="message-preview">{{ item.latestMessage?.content || "等待读取消息内容" }}</span>
              <span class="inbox-meta">
                <el-tag size="small" :type="suggestionType(item.suggestion?.status)" effect="plain">{{ suggestionLabel(item.suggestion?.status) }}</el-tag>
                <b v-if="item.unreadCount" class="unread-badge">{{ item.unreadCount }}</b>
              </span>
            </span>
          </button>
        </div>
        <el-empty v-else :image-size="64" description="暂无符合条件的会话">
          <el-button v-if="!accounts.length" type="primary" @click="openAccountDialog">接入第一个乐聊账号</el-button>
        </el-empty>
      </aside>

      <main class="conversation-pane dashboard-panel" v-loading="detailLoading">
        <template v-if="detail">
          <header class="conversation-header">
            <div>
              <span class="conversation-title" tabindex="-1">{{ detail.conversation.customerDisplayName }}</span>
              <small>{{ detail.conversation.shopName || detail.conversation.accountName }} · {{ detail.conversation.countryCode || "国家待识别" }}</small>
            </div>
            <el-button v-if="detail.conversation.status === 'OPEN'" :icon="CheckCircle2" :loading="actionLoading" @click="markHandled">标记已处理</el-button>
            <el-tag v-else type="success" effect="plain">已处理</el-tag>
          </header>
          <div class="message-stream" aria-live="polite">
            <article v-for="message in detail.messages" :key="message.id" class="message-row" :class="message.direction.toLocaleLowerCase()">
              <span class="message-author">{{ message.direction === "INBOUND" ? detail.conversation.customerDisplayName : "客服" }}</span>
              <p>{{ message.content }}</p>
              <time>{{ formatTime(message.sentAt) }}</time>
            </article>
          </div>
          <section class="draft-panel" aria-label="AI 回复建议">
            <header>
              <div><Bot :size="18" /><strong>AI 回复建议</strong></div>
              <div class="draft-actions">
                <el-tag :type="suggestionType(selectedSuggestion?.status)" effect="plain">{{ selectedSuggestionSendObserved ? "已观察到人工发送" : suggestionLabel(selectedSuggestion?.status) }}</el-tag>
                <el-button size="small" :icon="Sparkles" :loading="actionLoading" @click="queueReply">重新生成</el-button>
              </div>
            </header>
            <template v-if="selectedSuggestion?.draft">
              <el-input
                v-model="draftText"
                type="textarea"
                :autosize="{ minRows: 4, maxRows: 9 }"
                :readonly="!suggestionReviewable"
                maxlength="8000"
                aria-label="AI 回复草稿"
              />
              <div class="draft-meta">
                <span><ShieldCheck :size="15" />{{ selectedSuggestionSendObserved ? "乐聊已观察到相同内容由人工发送；系统没有代你点击发送" : selectedSuggestion.status === "FILLED" ? "已写入乐聊输入框，等待你检查后手动发送" : "建议仅在系统展示，发送仍由人工确认" }}</span>
                <span>{{ selectedSuggestion.model || "模型待记录" }} · 置信度 {{ selectedSuggestion.confidence === null ? "—" : `${Math.round(selectedSuggestion.confidence * 100)}%` }} · Token {{ selectedSuggestion.totalTokens === null ? "—" : selectedSuggestion.totalTokens.toLocaleString() }}</span>
              </div>
              <div class="suggestion-dimensions">
                <el-tag v-if="selectedSuggestion.intentCode" size="small" effect="plain">意图 {{ selectedSuggestion.intentCode }}</el-tag>
                <el-tag v-if="selectedSuggestion.riskLevel" size="small" :type="selectedSuggestion.riskLevel === 'HIGH' ? 'danger' : selectedSuggestion.riskLevel === 'MEDIUM' ? 'warning' : 'success'" effect="plain">风险 {{ selectedSuggestion.riskLevel }}</el-tag>
                <el-tag v-if="selectedSuggestion.categoryName || selectedSuggestion.categoryId" size="small" type="info" effect="plain">类目 {{ selectedSuggestion.categoryName || selectedSuggestion.categoryId }}</el-tag>
                <el-tag v-if="selectedSuggestion.countryCode" size="small" type="info" effect="plain">国家 {{ selectedSuggestion.countryCode }}</el-tag>
              </div>
              <el-alert
                v-if="suggestionAutoFillBlocked"
                type="warning"
                :closable="false"
                show-icon
                title="该回复未通过自动回填门禁，请核对证据或修改内容后再手动填入"
              />
              <div v-if="suggestionReviewable" class="draft-review-actions">
                <span v-if="draftDirty" class="draft-dirty">内容已修改，尚未保存</span>
                <p v-if="!draftFillAvailable" class="draft-fill-guidance" role="status">{{ draftFillAvailabilityMessage }}</p>
                <el-button :icon="Ban" :loading="actionLoading" @click="openFeedbackDialog('REJECT')">拒绝建议</el-button>
                <el-button :icon="Save" :loading="actionLoading" :disabled="!draftDirty" @click="openFeedbackDialog('EDIT')">保存修改</el-button>
                <el-button
                  v-if="selectedSuggestion.status === 'READY'"
                  type="success"
                  plain
                  :icon="CheckCircle2"
                  :loading="actionLoading"
                  :disabled="draftDirty"
                  :title="draftDirty ? '内容已修改，请先保存修改完成审核' : '只记录本次人工采纳，不会操作乐聊输入框'"
                  @click="reviewSuggestion('ACCEPT', false)"
                >采纳建议（不填入）</el-button>
                <span class="draft-fill-action" :title="draftFillAvailable ? '只填入输入框，仍需人工检查并点击发送' : draftFillAvailabilityMessage">
                  <el-button
                    type="primary"
                    :icon="TextCursorInput"
                    :loading="actionLoading"
                    :disabled="!draftFillAvailable"
                    @click="draftDirty ? openFeedbackDialog('EDIT', true) : reviewSuggestion('ACCEPT', true)"
                  >填入乐聊输入框</el-button>
                </span>
              </div>
              <div v-if="selectedSuggestion.qualityFlags.length" class="quality-flags">
                <el-tag v-for="item in selectedSuggestion.qualityFlags" :key="item" size="small" :type="qualityFlagType(item)" effect="plain">{{ qualityFlagLabel(item) }}</el-tag>
              </div>
            </template>
            <div v-else class="draft-empty">
              <Bot :size="24" />
              <div>
                <strong>{{ selectedSuggestion?.status === "GENERATING" ? "正在结合业务依据生成" : selectedSuggestion?.status === "QUEUED" ? "消息已进入生成队列" : "暂无可用回复建议" }}</strong>
                <span>订单、库存、商品、知识库和上下文会在生成前汇总；缺少事实时只会追问或提示核实。</span>
              </div>
            </div>
          </section>
        </template>
        <div v-else class="conversation-empty">
          <MessageSquareText :size="34" /><strong>选择一个会话开始处理</strong><span>消息、AI 草稿与依据会在同一工作台显示。</span>
        </div>
      </main>

      <aside class="evidence-pane dashboard-panel" aria-label="回复依据">
        <header>
          <div><span class="panel-kicker">EVIDENCE</span><h3>回复依据</h3></div>
          <el-button text :icon="RefreshCw" :loading="actionLoading" @click="rebuildContext">重建</el-button>
        </header>
        <div class="evidence-content">
          <section v-if="detail && !detail.conversation.commerceShopId" class="shop-binding-card">
            <div><Link2 :size="18" /><strong>先确认系统店铺</strong></div>
            <p>订单和店铺政策必须建立在人工确认的店铺身份上，系统不会按名称自动绑定。</p>
            <el-select v-model="selectedShopCandidateId" placeholder="选择匹配店铺" :disabled="!shopCandidates.length">
              <el-option v-for="shop in shopCandidates" :key="shop.id" :value="shop.id" :label="`${shop.shopName} · ${shop.countryCode} · ${shop.platform}`" />
            </el-select>
            <el-button type="primary" :disabled="!selectedShopCandidateId" :loading="actionLoading" @click="confirmShop">确认绑定并重新生成</el-button>
          </section>

          <section class="source-card">
            <span class="source-icon"><PackageCheck :size="18" /></span>
            <div><strong>订单</strong><span>{{ contextDetail?.context.order.data ? `${fact(contextDetail.context.order.data, 'orderRef')} · ${fact(contextDetail.context.order.data, 'status')}` : "未取得权威订单" }}</span></div>
            <el-tag size="small" :type="contextDetail?.context.order.resolutionStatus === 'RESOLVED' ? 'success' : 'warning'" effect="plain">{{ contextDetail?.context.order.resolutionStatus || "待汇总" }}</el-tag>
          </section>
          <section class="source-card">
            <span class="source-icon"><Truck :size="18" /></span>
            <div><strong>物流</strong><span>{{ logisticsSummary }}</span></div>
            <el-tag
              size="small"
              :type="contextDetail?.context.logistics.authoritative ? 'success' : 'warning'"
              effect="plain"
            >{{ contextDetail?.context.logistics.authoritative ? "权威平台数据" : "非权威观察" }}</el-tag>
          </section>
          <section class="source-card">
            <span class="source-icon"><Boxes :size="18" /></span>
            <div><strong>商品与库存</strong><span>{{ inventoryRows.length ? `${inventoryRows.length} 个仓库 · 可用 ${inventoryAvailable}` : fact(contextDetail?.context.product, 'observedSku', 'SKU 待识别') }}</span></div>
            <el-tag size="small" :type="inventoryRows.length ? 'success' : 'info'" effect="plain">{{ contextDetail?.context.inventory.resolutionStatus || "待汇总" }}</el-tag>
          </section>
          <section class="source-card">
            <span class="source-icon"><DatabaseZap :size="18" /></span>
            <div><strong>已发布产品知识</strong><span>产品事实、配件、国家差异与客服要求</span></div>
            <el-tag size="small" :type="knowledgeCount ? 'success' : 'info'" effect="plain">{{ knowledgeCount }} 条</el-tag>
          </section>

          <div v-if="selectedEvidence.length" class="evidence-list">
            <article v-for="item in selectedEvidence" :key="item.id">
              <div><strong>{{ item.label }}</strong><el-tag size="small" :type="evidenceType(item.sourceType)" effect="plain">{{ item.sourceType }}</el-tag></div>
              <p>{{ item.excerpt || "该依据未提供摘要" }}</p>
              <small>{{ item.sourceVersion || "当前版本" }}</small>
            </article>
          </div>

          <section v-if="missingFields.length" class="missing-card">
            <div><CircleAlert :size="17" /><strong>本次仍缺少 {{ missingFields.length }} 项依据</strong></div>
            <ul><li v-for="item in missingFields" :key="item">{{ missingLabel(item) }}</li></ul>
          </section>
          <div class="safety-note">
            <ShieldCheck :size="17" />
            <p><strong>安全边界</strong><span>证据缺失或冲突时，模型只能说明正在核实或向客户追问，不能编造订单、库存、物流或赔付承诺。</span></p>
          </div>
          <div class="connection-state">
            <component :is="onlineWorkers ? Wifi : WifiOff" :size="17" />
            <span>{{ onlineWorkers ? `${onlineWorkers} 个浏览器节点在线` : "暂无浏览器节点在线" }}</span>
            <small v-if="contextDetail">依据更新于 {{ formatTime(contextDetail.snapshot.builtAt) }}</small>
          </div>
        </div>
      </aside>
    </section>

    <el-dialog
      v-model="feedbackDialogOpen"
      :title="feedbackForm.action === 'REJECT' ? '说明拒绝原因' : '说明修改原因'"
      width="min(520px, 94vw)"
      destroy-on-close
    >
      <el-form label-position="top" @submit.prevent="submitFeedback">
        <el-form-item label="主要原因" required>
          <el-select v-model="feedbackForm.reasonCode" placeholder="请选择一项，用于持续优化 AI 回复">
            <el-option v-for="item in feedbackReasonOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="补充说明（可选）">
          <el-input v-model="feedbackForm.comment" type="textarea" :rows="3" maxlength="2000" show-word-limit placeholder="不要填写客户电话、地址等敏感信息" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="feedbackDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="actionLoading" :disabled="!feedbackForm.reasonCode" @click="submitFeedback">
          {{ feedbackForm.queueFill ? "保存并填入输入框" : "确认记录" }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="accountDialogOpen"
      title="接入乐聊账号"
      width="min(820px, 96vw)"
      destroy-on-close
      :show-close="!accountConnectLoading"
      :close-on-click-modal="!accountDialogBusy"
      :close-on-press-escape="!accountDialogBusy"
      :before-close="stopAndCloseAccountDialog"
      @closed="accountDialogClosed"
    >
      <el-steps class="account-onboarding-steps" :active="accountWizardActive" finish-status="success" align-center>
        <el-step title="账号信息" description="创建中央记录" />
        <el-step title="本机人工登录" description="独立浏览器 Session" />
        <el-step title="启动监控" description="仅观察，不自动发送" />
      </el-steps>

      <section v-if="accountCreationBlocked" class="account-migration-gate" role="alert" aria-live="assertive">
        <span class="account-gate-icon" aria-hidden="true"><DatabaseZap :size="26" /></span>
        <div>
          <h3>客服数据库尚未部署，账号接入暂未开放</h3>
          <p>当前不是表单或按钮故障。需要先完成客服数据库迁移；迁移完成后刷新部署状态即可继续。</p>
        </div>
        <el-button :icon="RefreshCw" :loading="loading" @click="refreshAccountDeploymentStatus">刷新部署状态</el-button>
      </section>

      <template v-else>
        <el-alert
          v-if="accountDialogError"
          class="account-create-alert"
          type="error"
          :closable="false"
          show-icon
          role="alert"
          aria-live="assertive"
          :title="accountDialogError"
        />

        <section v-if="!accountDialogAccountId" class="account-onboarding-form">
          <div class="account-safety-contract">
            <ShieldCheck :size="20" aria-hidden="true" />
            <div>
              <strong>登录只在这台客服电脑完成</strong>
              <p>系统会打开独立的乐聊浏览器窗口。请在窗口内手动完成登录、扫码、验证码或二次验证；密码、Cookie 与 Session 不会上传到中央数据库。</p>
            </div>
          </div>

          <el-form id="account-connect-form" label-position="top" @submit.prevent="saveAccount">
            <el-form-item label="账号名称" required>
              <el-input
                v-model="accountForm.displayName"
                name="customer_service_account_name"
                autocomplete="off"
                :spellcheck="false"
                maxlength="120"
                show-word-limit
                placeholder="例如：泰国客服 01"
              />
            </el-form-item>
            <el-form-item label="负责国家">
              <el-select v-model="accountForm.countryCodes" multiple filterable allow-create default-first-option placeholder="选择或输入国家代码">
                <el-option v-for="country in ['TH','MY','PH','ID','VN','SG']" :key="country" :label="country" :value="country" />
              </el-select>
            </el-form-item>
            <el-alert type="info" :closable="false" show-icon title="接入后固定从“仅观察”开始；AI 最多生成建议或填入草稿，系统绝不会点击发送。" />
          </el-form>

          <details v-if="accounts.length" class="account-existing-list">
            <summary>查看与管理已有账号（{{ accounts.length }}）</summary>
            <section class="account-registry" aria-label="已有乐聊账号">
              <article v-for="account in accounts" :key="account.id">
                <header class="account-summary">
                  <div>
                    <strong>{{ account.displayName }}</strong>
                    <span>{{ accountStatusLabel(account) }} · {{ account.settings.countryCodes?.join(" / ") || "未限定国家" }} · 最近采集 {{ formatTime(account.lastObservedAt) }}</span>
                  </div>
                  <el-tag size="small" :type="accountIsMonitoring(account) ? 'success' : 'warning'" effect="plain">阶段 {{ account.rollout?.stageIndex || 1 }}/3 · {{ automationModeLabel(account.settings.automationMode) }}</el-tag>
                </header>

                <div class="account-stages" role="list" :aria-label="`${account.displayName} 的三阶段放行进度`">
                  <span
                    v-for="(stage, index) in rolloutStages"
                    :key="stage.mode"
                    role="listitem"
                    :class="{ reached: rolloutStageReached(account, index + 1), current: account.settings.automationMode === stage.mode }"
                  >
                    <CheckCircle2 v-if="rolloutStageReached(account, index + 1)" :size="14" aria-hidden="true" />
                    <Clock3 v-else :size="14" aria-hidden="true" />
                    <b>{{ index + 1 }}. {{ stage.label }}</b>
                  </span>
                </div>

                <div class="rollout-evidence" aria-label="放行证据计数">
                  <span>客户消息 <b>{{ account.rollout?.observedMessageTotal || 0 }}</b></span>
                  <span>已生成建议 <b>{{ account.rollout?.generatedSuggestionTotal || 0 }}</b></span>
                  <span>已人工审核 <b>{{ account.rollout?.reviewedSuggestionTotal || 0 }}</b></span>
                </div>

                <div class="rollout-guidance" :class="{ ready: accountCanAdvance(account), complete: !accountNextMode(account) }">
                  <template v-if="accountNextMode(account)">
                    <strong>下一阶段：{{ automationModeLabel(accountNextMode(account) || undefined) }}</strong>
                    <span v-if="accountCanAdvance(account)">条件已满足，可以安全开启。</span>
                    <ul v-else>
                      <li v-for="blocker in accountRolloutBlockers(account)" :key="blocker">{{ rolloutBlockerLabel(blocker) }}</li>
                    </ul>
                  </template>
                  <template v-else><strong>三个阶段已完成</strong><span>AI 仍只填输入框，发送必须由人工完成。</span></template>
                </div>

                <p v-if="accountModeErrors[account.id]" class="account-inline-error" role="alert">{{ accountModeErrors[account.id] }}</p>

                <footer class="account-controls">
                  <el-button
                    v-if="!accountIsMonitoring(account) && account.status !== 'DISABLED'"
                    type="primary"
                    plain
                    :icon="Wifi"
                    @click="continueAccountConnection(account)"
                  >{{ account.status === "SETUP_REQUIRED" ? "继续接入" : "重新连接" }}</el-button>
                  <el-select
                    :model-value="account.settings.automationMode || 'OBSERVE_ONLY'"
                    :disabled="actionLoading"
                    :aria-label="`${account.displayName} 的运行模式`"
                    @change="changeAccountMode(account, $event)"
                  >
                    <el-option label="仅观察" value="OBSERVE_ONLY" />
                    <el-option label="只生成建议" value="SUGGEST_ONLY" :disabled="automationModeOptionDisabled(account, 'SUGGEST_ONLY')" />
                    <el-option label="生成并填入" value="DRAFT_FILL" :disabled="automationModeOptionDisabled(account, 'DRAFT_FILL')" />
                  </el-select>
                  <el-button
                    v-if="accountNextMode(account)"
                    type="primary"
                    plain
                    :loading="actionLoading"
                    :disabled="!accountCanAdvance(account)"
                    @click="advanceAccountMode(account)"
                  >开启“{{ automationModeLabel(accountNextMode(account) || undefined) }}”</el-button>
                  <code :title="account.id">{{ account.id }}</code>
                  <el-button text :icon="Copy" :aria-label="`复制 ${account.displayName} 的中央账号 ID`" @click="copyAccountId(account.id)">{{ copiedAccountId === account.id ? "已复制" : "复制 ID" }}</el-button>
                </footer>
              </article>
            </section>
          </details>
        </section>

        <section v-else class="account-runtime-panel" role="status" aria-live="polite" aria-atomic="true">
          <div class="account-runtime-state" :class="accountRuntimeStatus.toLocaleLowerCase()">
            <span class="account-runtime-icon" aria-hidden="true">
              <CheckCircle2 v-if="accountRuntimeStatus === 'MONITORING'" :size="28" />
              <CircleAlert v-else-if="accountRuntimeStatus === 'FAILED'" :size="28" />
              <ServerCog v-else :size="28" />
            </span>
            <div>
              <small>{{ accountDialogAccountName }} · 中央记录已创建</small>
              <h3>{{ localRuntimeStatusLabel(accountRuntimeStatus) }}</h3>
              <p>{{ accountLocalRuntime?.message || localRuntimeStatusMessage(accountRuntimeStatus) }}</p>
            </div>
            <el-tag :type="accountRuntimeStatus === 'MONITORING' ? 'success' : accountRuntimeStatus === 'FAILED' ? 'danger' : 'warning'" effect="plain">
              {{ accountRuntimeStatus }}
            </el-tag>
          </div>

          <div v-if="accountRuntimeStatus === 'WAITING_FOR_LOGIN'" class="account-login-guidance">
            <strong>现在请切换到乐聊浏览器窗口</strong>
            <span>完成登录后无需返回点击确认，系统检测到登录成功会自动保存本机 Session 并启动监控。</span>
          </div>

          <div class="account-runtime-safety">
            <ShieldCheck :size="18" aria-hidden="true" />
            <p><strong>安全边界保持不变</strong><span>每个账号使用独立浏览器目录；登录信息只留在本机。监控只观察消息，任何回复都必须由人工检查后在乐聊中发送。</span></p>
          </div>
        </section>
      </template>

      <template #footer>
        <template v-if="accountCreationBlocked">
          <el-button @click="accountDialogOpen = false">关闭</el-button>
        </template>
        <template v-else-if="!accountDialogAccountId">
          <el-button :disabled="accountConnectLoading" @click="stopAndCloseAccountDialog()">取消</el-button>
          <el-button
            type="primary"
            :loading="accountConnectLoading"
            :disabled="accountCreationBlocked || !accountForm.displayName.trim()"
            @click="saveAccount"
          >创建记录并打开乐聊</el-button>
        </template>
        <template v-else>
          <el-button :disabled="accountConnectLoading" @click="stopAndCloseAccountDialog()">
            {{ accountRuntimeBusy ? "退出向导" : "关闭" }}
          </el-button>
          <el-button v-if="accountRuntimeStatus === 'MONITORING'" type="primary" @click="accountDialogOpen = false">完成</el-button>
          <el-button
            v-else-if="['IDLE', 'SESSION_READY', 'STOPPED', 'FAILED'].includes(accountRuntimeStatus)"
            type="primary"
            :loading="accountConnectLoading"
            :disabled="accountRuntimeStatus !== 'SESSION_READY' && accountLocalRuntime?.retryable === false"
            @click="resumeAccountConnection"
          >{{ accountRuntimeStatus === "SESSION_READY" ? "启动监控" : accountLocalRuntime?.retryable === false ? "本机运行环境不可用" : accountRuntimeStatus === "IDLE" ? "打开乐聊登录窗口" : "重试接入" }}</el-button>
          <el-button v-else type="primary" :loading="accountRuntimeStatus === 'STARTING' || accountRuntimeStatus === 'MONITOR_STARTING'" disabled>
            {{ accountRuntimeStatus === "WAITING_FOR_LOGIN" ? "等待你完成登录…" : localRuntimeStatusLabel(accountRuntimeStatus) }}
          </el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.customer-service-page { display: grid; gap: 16px; min-width: 0; }
.cs-commandbar, .cs-toolbar { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.cs-commandbar { justify-content: space-between; }
.cs-runtime { display: flex; align-items: center; gap: 11px; min-width: 0; }
.cs-runtime > div { display: grid; gap: 3px; }
.cs-runtime strong { font-size: 13px; }
.cs-runtime span { color: var(--ops-text-secondary); font-size: 11px; }
.runtime-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; background: var(--ops-danger); box-shadow: 0 0 0 5px rgba(220, 38, 38, .09); }
.runtime-dot.ready { background: var(--ops-success); box-shadow: 0 0 0 5px rgba(22, 163, 74, .09); }
.cs-command-actions, .draft-actions { display: flex; align-items: center; gap: 8px; }
.account-create-alert { margin-bottom: 16px; }
.account-onboarding-steps { margin: 2px 0 22px; }
.account-migration-gate { min-height: 260px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 26px; border-radius: 10px; background: #fff7ed; }
.account-gate-icon { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 10px; color: #9a3412; background: #ffedd5; }
.account-migration-gate h3, .account-runtime-state h3 { margin: 0; font-size: 17px; }
.account-migration-gate p { max-width: 64ch; margin: 6px 0 0; color: #7c2d12; font-size: 12px; line-height: 1.65; }
.account-onboarding-form { display: grid; gap: 18px; }
.account-safety-contract { display: flex; gap: 12px; padding: 14px 16px; border-radius: 10px; color: #1e40af; background: #eff6ff; }
.account-safety-contract > div { display: grid; gap: 4px; min-width: 0; }
.account-safety-contract strong { color: var(--ops-text); font-size: 13px; }
.account-safety-contract p { max-width: 72ch; margin: 0; color: #1e3a8a; font-size: 12px; line-height: 1.6; }
.account-existing-list { border-top: 1px solid var(--ops-border-light); }
.account-existing-list > summary { padding: 14px 2px 4px; color: var(--ops-primary); cursor: pointer; font-size: 12px; font-weight: 700; }
.account-existing-list[open] > summary { margin-bottom: 12px; }
.account-existing-list > summary:focus-visible { outline: 2px solid var(--ops-primary); outline-offset: 3px; }
.account-runtime-panel { min-height: 320px; display: grid; align-content: center; gap: 14px; }
.account-runtime-state { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 15px; padding: 22px; border-radius: 10px; background: var(--ops-surface-muted); }
.account-runtime-state.monitoring { background: #f0fdf4; }
.account-runtime-state.failed { background: #fef2f2; }
.account-runtime-icon { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 11px; color: var(--ops-primary); background: white; }
.account-runtime-state.monitoring .account-runtime-icon { color: var(--ops-success); }
.account-runtime-state.failed .account-runtime-icon { color: var(--ops-danger); }
.account-runtime-state > div { display: grid; gap: 5px; min-width: 0; }
.account-runtime-state small { color: var(--ops-text-secondary); font-size: 11px; }
.account-runtime-state p { max-width: 66ch; margin: 0; color: var(--ops-text-secondary); font-size: 12px; line-height: 1.6; }
.account-login-guidance { display: grid; gap: 4px; padding: 13px 15px; border-radius: 9px; color: #78350f; background: #fffbeb; }
.account-login-guidance strong { font-size: 12px; }
.account-login-guidance span { font-size: 11px; line-height: 1.55; }
.account-runtime-safety { display: flex; gap: 10px; padding: 13px 15px; border-radius: 9px; color: #166534; background: #f0fdf4; }
.account-runtime-safety p { display: grid; gap: 3px; margin: 0; }
.account-runtime-safety strong { font-size: 12px; }
.account-runtime-safety span { font-size: 11px; line-height: 1.55; }
.rollout-contract { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.rollout-contract span { min-height: 38px; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--ops-border-light); border-radius: 8px; color: var(--ops-text-secondary); background: var(--ops-surface); font-size: 10px; }
.rollout-contract b { color: var(--ops-text); font-size: 11px; }
.rollout-contract span.ready, .rollout-contract span.safe { color: #166534; border-color: #bbf7d0; background: #f0fdf4; }
.rollout-contract span.active { color: #1d4ed8; border-color: #bfdbfe; background: #eff6ff; }
.cs-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.cs-metrics article { min-height: 94px; display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.metric-symbol { flex: 0 0 auto; display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; color: var(--ops-primary); background: #eff6ff; }
.metric-symbol.waiting { color: var(--ops-warning); background: #fffbeb; }
.metric-symbol.ready { color: var(--ops-success); background: #f0fdf4; }
.metric-symbol.worker { color: #475569; background: #f1f5f9; }
.cs-metrics article div { display: grid; gap: 2px; min-width: 0; }
.cs-metrics small, .cs-metrics span { color: var(--ops-text-secondary); font-size: 11px; }
.cs-metrics strong { font-size: 22px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.quality-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 14px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); color: var(--ops-text-secondary); font-size: 11px; }
.quality-summary > span { color: var(--ops-text); font-weight: 700; }
.quality-summary b { font-weight: 600; font-variant-numeric: tabular-nums; }
.quality-summary b.warning { color: var(--ops-warning); }
.quality-breakdown { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); }
.quality-breakdown > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.quality-breakdown > header > div { display: grid; gap: 2px; }
.quality-breakdown > header strong { font-size: 13px; }
.quality-breakdown > header span { color: var(--ops-text-secondary); font-size: 11px; }
.quality-breakdown > header .el-select { width: 150px; }
.quality-breakdown-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
.quality-breakdown-list article { display: grid; gap: 3px; padding: 9px 10px; border-radius: 8px; background: var(--ops-surface-muted); }
.quality-breakdown-list article strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.quality-breakdown-list article span, .quality-breakdown-list article small { color: var(--ops-text-secondary); font-size: 10px; }
.cs-toolbar .el-select { width: 210px; }
.cs-toolbar .el-input { width: min(360px, 34vw); }
.toolbar-count { margin-left: auto; color: var(--ops-text-secondary); font-size: 12px; white-space: nowrap; }
.cs-workbench { display: grid; grid-template-columns: minmax(270px, 320px) minmax(420px, 1fr) minmax(300px, 350px); gap: 12px; min-height: 680px; }
.inbox-pane, .conversation-pane, .evidence-pane { min-width: 0; min-height: 0; }
.inbox-pane, .evidence-pane { display: flex; flex-direction: column; }
.inbox-list { flex: 1; max-height: 760px; overflow-y: auto; }
.inbox-item { width: 100%; min-height: 106px; display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 10px; padding: 13px; border: 0; border-bottom: 1px solid var(--ops-border-light); color: var(--ops-text); background: transparent; cursor: pointer; text-align: left; transition: background var(--ops-transition), box-shadow var(--ops-transition); }
.inbox-item:hover { background: var(--ops-surface-muted); }
.inbox-item:focus-visible { position: relative; z-index: 1; outline: 2px solid var(--ops-primary); outline-offset: -2px; }
.inbox-item.active { background: #eff6ff; box-shadow: inset 3px 0 0 var(--ops-primary); }
.customer-avatar { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; color: #1e40af; background: #dbeafe; font-size: 14px; font-weight: 800; }
.inbox-copy { display: grid; gap: 4px; min-width: 0; }
.inbox-line, .shop-line, .inbox-meta { display: flex; align-items: center; gap: 7px; min-width: 0; }
.inbox-line strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.inbox-line time { margin-left: auto; color: var(--ops-text-muted); font-size: 10px; white-space: nowrap; }
.shop-line { overflow: hidden; color: var(--ops-text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.shop-line b { padding: 1px 5px; border-radius: 4px; color: #475569; background: #e2e8f0; font-size: 9px; }
.message-preview { overflow: hidden; color: var(--ops-text-secondary); font-size: 12px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.inbox-meta { min-height: 24px; }
.unread-badge { min-width: 20px; height: 20px; display: grid; place-items: center; margin-left: auto; padding: 0 5px; border-radius: 99px; color: white; background: var(--ops-primary); font-size: 10px; }
.conversation-pane { display: flex; flex-direction: column; }
.conversation-header { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--ops-border-light); }
.conversation-header > div { display: grid; gap: 3px; min-width: 0; }
.conversation-title { overflow: hidden; outline: none; font-size: 15px; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
.conversation-title:focus-visible { outline: 2px solid var(--ops-primary); outline-offset: 3px; }
.conversation-header small { color: var(--ops-text-secondary); }
.message-stream { flex: 1; min-height: 360px; max-height: 500px; display: flex; flex-direction: column; gap: 14px; padding: 18px; overflow-y: auto; background: #f8fafc; }
.message-row { align-self: flex-start; max-width: min(78%, 620px); display: grid; gap: 5px; }
.message-row.outbound { align-self: flex-end; justify-items: end; }
.message-author, .message-row time { color: var(--ops-text-muted); font-size: 10px; }
.message-row p { margin: 0; padding: 10px 12px; border: 1px solid var(--ops-border-light); border-radius: 5px 12px 12px; background: white; font-size: 13px; line-height: 1.65; white-space: pre-wrap; }
.message-row.outbound p { border-color: #bfdbfe; border-radius: 12px 5px 12px 12px; background: #eff6ff; }
.draft-panel { display: grid; gap: 12px; padding: 14px 16px 16px; border-top: 1px solid var(--ops-border-light); }
.draft-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.draft-panel > header > div:first-child { display: flex; align-items: center; gap: 7px; color: var(--ops-primary); }
.draft-panel > header strong { color: var(--ops-text); font-size: 13px; }
.draft-empty { min-height: 96px; display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px dashed #cbd5e1; border-radius: 10px; color: var(--ops-primary); background: var(--ops-surface-muted); }
.draft-empty > div { display: grid; gap: 4px; }
.draft-empty strong { color: var(--ops-text); font-size: 13px; }
.draft-empty span, .draft-meta { color: var(--ops-text-secondary); font-size: 11px; }
.draft-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.draft-meta span { display: flex; align-items: center; gap: 6px; }
.draft-review-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.draft-review-actions .el-button { margin: 0; }
.draft-dirty { margin-right: auto; color: var(--ops-warning); font-size: 11px; }
.draft-fill-guidance { flex-basis: 100%; margin: 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.45; text-align: right; }
.draft-fill-action { display: inline-flex; }
.quality-flags { display: flex; flex-wrap: wrap; gap: 6px; }
.suggestion-dimensions { display: flex; flex-wrap: wrap; gap: 6px; }
.conversation-empty { flex: 1; min-height: 620px; display: grid; place-items: center; align-content: center; gap: 9px; color: var(--ops-text-muted); text-align: center; }
.conversation-empty strong { color: var(--ops-text); }
.conversation-empty span { font-size: 12px; }
.evidence-content { display: grid; gap: 10px; padding: 12px; overflow-y: auto; }
.source-card { min-height: 70px; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 9px; padding: 10px; border: 1px solid var(--ops-border-light); border-radius: 10px; }
.source-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: #475569; background: #f1f5f9; }
.source-card > div { display: grid; gap: 3px; }
.source-card strong { font-size: 12px; }
.source-card span { color: var(--ops-text-secondary); font-size: 10px; line-height: 1.4; }
.shop-binding-card, .missing-card { display: grid; gap: 9px; padding: 11px; border: 1px solid #bfdbfe; border-radius: 10px; background: #eff6ff; }
.shop-binding-card > div, .missing-card > div { display: flex; align-items: center; gap: 7px; color: #1d4ed8; }
.shop-binding-card strong, .missing-card strong { color: var(--ops-text); font-size: 12px; }
.shop-binding-card p { margin: 0; color: var(--ops-text-secondary); font-size: 10px; line-height: 1.5; }
.missing-card { border-color: #fde68a; background: #fffbeb; }
.missing-card > div { color: #92400e; }
.missing-card ul { display: grid; gap: 4px; margin: 0; padding-left: 18px; color: #78350f; font-size: 10px; line-height: 1.45; }
.evidence-list { display: grid; gap: 8px; }
.evidence-list article { padding: 10px; border-left: 3px solid var(--ops-primary); border-radius: 5px 9px 9px 5px; background: #f8fafc; }
.evidence-list article > div { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.evidence-list strong { font-size: 12px; }
.evidence-list p { margin: 5px 0; color: var(--ops-text-secondary); font-size: 11px; line-height: 1.5; }
.evidence-list small { color: var(--ops-text-muted); }
.safety-note { display: flex; gap: 8px; margin-top: 4px; padding: 11px; border: 1px solid #fde68a; border-radius: 9px; color: #92400e; background: #fffbeb; }
.safety-note p { display: grid; gap: 4px; margin: 0; }
.safety-note strong { font-size: 11px; }
.safety-note span { font-size: 10px; line-height: 1.5; }
.connection-state { display: flex; align-items: center; gap: 7px; padding: 10px; border-radius: 8px; color: var(--ops-text-secondary); background: var(--ops-surface-muted); font-size: 11px; }
.connection-state small { margin-left: auto; }
.form-helper { color: var(--ops-text-secondary); line-height: 1.5; }
.account-registry { display: grid; gap: 12px; }
.account-registry article { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface-muted); }
.account-summary, .account-controls { display: flex; align-items: center; gap: 10px; }
.account-summary { justify-content: space-between; }
.account-summary > div { display: grid; gap: 3px; min-width: 0; }
.account-registry strong { font-size: 12px; }
.account-registry span { color: var(--ops-text-secondary); font-size: 10px; }
.account-stages { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.account-stages span { min-height: 36px; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); }
.account-stages span.reached { color: var(--ops-success); border-color: #bbf7d0; background: #f0fdf4; }
.account-stages span.current { box-shadow: inset 0 0 0 1px currentColor; }
.account-stages b { color: inherit; font-size: 11px; font-weight: 650; }
.rollout-evidence { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.rollout-evidence span { font-size: 11px; }
.rollout-evidence b { color: var(--ops-text); font-variant-numeric: tabular-nums; }
.rollout-guidance { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid #fde68a; border-radius: 8px; color: #78350f; background: #fffbeb; }
.rollout-guidance.ready, .rollout-guidance.complete { border-color: #bbf7d0; color: #166534; background: #f0fdf4; }
.rollout-guidance span { color: inherit; font-size: 11px; }
.rollout-guidance ul { display: grid; gap: 3px; margin: 0; padding-left: 18px; font-size: 11px; line-height: 1.45; }
.account-inline-error { margin: 0; padding: 8px 10px; border-radius: 7px; color: #991b1b; background: #fef2f2; font-size: 11px; }
.account-controls { flex-wrap: wrap; }
.account-controls .el-select { width: 150px; }
.account-controls code { max-width: 240px; overflow: hidden; margin-left: auto; color: #475569; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1450px) {
  .cs-workbench { grid-template-columns: minmax(260px, 310px) minmax(420px, 1fr); }
  .evidence-pane { grid-column: 1 / -1; }
  .evidence-content { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .shop-binding-card, .safety-note, .connection-state, .evidence-list, .missing-card { grid-column: 1 / -1; }
}
@media (max-width: 1050px) {
  .rollout-contract { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cs-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cs-workbench { grid-template-columns: 1fr; }
  .inbox-list { max-height: 420px; }
  .evidence-pane { grid-column: auto; }
  .evidence-content { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .cs-commandbar, .cs-toolbar { align-items: stretch; flex-direction: column; }
  .cs-command-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .cs-command-actions .el-button { margin: 0; }
  .cs-toolbar .el-select, .cs-toolbar .el-input { width: 100%; }
  .toolbar-count { margin-left: 0; }
  .message-row { max-width: 90%; }
  .draft-panel > header, .draft-meta { align-items: stretch; flex-direction: column; }
  .draft-review-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .draft-fill-action, .draft-dirty { grid-column: 1 / -1; }
  .draft-fill-action .el-button { width: 100%; }
  .draft-dirty { margin-right: 0; }
  .account-summary, .account-controls { align-items: stretch; flex-direction: column; }
  .account-migration-gate, .account-runtime-state { grid-template-columns: 1fr; align-items: start; }
  .account-migration-gate .el-button, .account-runtime-state .el-tag { justify-self: start; }
  .account-summary .el-tag { align-self: flex-start; }
  .account-stages { grid-template-columns: 1fr; }
  .account-controls .el-select, .account-controls .el-button { width: 100%; }
  .account-controls code { max-width: 100%; margin-left: 0; }
}
@media (max-width: 480px) {
  .cs-metrics, .evidence-content, .rollout-contract { grid-template-columns: 1fr; }
  .shop-binding-card, .safety-note, .connection-state, .evidence-list, .missing-card { grid-column: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .inbox-item { transition: none; }
}
</style>
