<script setup lang="ts">
import {
  AlertTriangle, BellRing, CheckCircle2, FileSpreadsheet, Play, Plus, RefreshCw, SearchCheck,
  ShieldAlert, Trash2,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  approveDiscountPreview, createDiscountPreview, executeDiscountPreview, loadDiscountActivities,
  discountPreviewAvailability, discountPreviewInputKey, DiscountPageFlowController, DiscountRequestGuard,
  loadDiscountIssues, loadDiscountPreviewItems, loadDiscountRuns, loadDiscountShops, loadDiscountStatus,
  requestDiscountScan, lookupDiscountOverrides, lookupDiscountOverrideBatch, reconcileDiscountIntent, loadDiscountSettings, saveDiscountSettings, verifyDiscountSettings,
  loadDiscountPreview, loadDiscountUnknownIntents,
  type ActivityTierSelection, type DiscountActivity, type DiscountIssue, type DiscountOverrideLookupRow, type DiscountSettings, type DiscountUnknownIntent,
  type DiscountPreview, type DiscountPreviewItem, type DiscountRun, type DiscountShop, type DiscountStatus,
  type CreateDiscountPreviewInput, type DiscountTier, type DiscountWorkflow, type LinkTierOverride, type TierOverride,
} from "@/services/shopee-discount";

const tiers: Array<{ value: DiscountTier; label: string }> = [
  { value: "DAILY", label: "日常价" }, { value: "EVENT", label: "活动价" }, { value: "MEGA", label: "大促价" },
];
const workflows: Array<{ value: DiscountWorkflow; label: string; hint: string }> = [
  { value: "CURRENT_CORRECTION", label: "修正当前活动", hint: "只调整已选择 Discount 活动中的折扣价" },
  { value: "NEXT_RENEWAL", label: "创建下一期活动", hint: "当前活动后重新开始完整 30 天周期" },
];

const loading = ref(true);
const previewing = ref(false);
const approving = ref(false);
const executing = ref(false);
const scanning = ref(false);
const errorMessage = ref("");
const status = ref<DiscountStatus | null>(null);
const shops = ref<DiscountShop[]>([]);
const country = ref("");
const selectedShopIds = ref<string[]>([]);
const useDefaultShops = ref(true);
const workflow = ref<DiscountWorkflow>("CURRENT_CORRECTION");
const defaultTier = ref<DiscountTier>("DAILY");
const category = ref("家具");
const renewalStart = ref<string | null>(defaultRenewalStart());
const shopOverrides = ref<TierOverride[]>([]);
const linkOverrides = ref<LinkTierOverride[]>([]);
const activitySelection = ref<ActivityTierSelection[]>([]);
const batchText = ref("");
const batchErrors = ref<string[]>([]);
const batchValidatedRows = ref<Array<DiscountOverrideLookupRow & { priceTier: DiscountTier; note: string }>>([]);
const batchValidating = ref(false);
const batchFileInput = ref<HTMLInputElement | null>(null);
const overrideQuery = ref("");
const overrideMatches = ref<DiscountOverrideLookupRow[]>([]);
const overrideSearching = ref(false);
const settings = ref<DiscountSettings | null>(null);
const settingsKey = ref("");
const preview = ref<DiscountPreview | null>(null);
const previewItems = ref<DiscountPreviewItem[]>([]);
const nextCursor = ref<string | number | null>(null);
const itemLoading = ref(false);
const operatorName = ref("");
const confirmationInput = ref("");
const runs = ref<DiscountRun[]>([]);
const activities = ref<DiscountActivity[]>([]);
const issues = ref<DiscountIssue[]>([]);
const unknownIntents = ref<DiscountUnknownIntent[]>([]);
const unknownIntentCursor = ref<string | null>(null);
const unknownIntentLoading = ref(false);
const activeTab = ref("preview");
let pollTimer: ReturnType<typeof setInterval> | null = null;
let assigningInitialCountry = false;
const requestGuard = new DiscountRequestGuard();
const pageFlow = new DiscountPageFlowController({
  get preview() { return preview.value; }, set preview(value) { preview.value = value; },
  get previewing() { return previewing.value; }, set previewing(value) { previewing.value = value; },
  get approving() { return approving.value; }, set approving(value) { approving.value = value; },
  get executing() { return executing.value; }, set executing(value) { executing.value = value; },
  get itemLoading() { return itemLoading.value; }, set itemLoading(value) { itemLoading.value = value; },
  get operatorName() { return operatorName.value; }, set operatorName(value) { operatorName.value = value; },
  get confirmationInput() { return confirmationInput.value; }, set confirmationInput(value) { confirmationInput.value = value; },
}, requestGuard);

const countries = computed(() => [...new Set(shops.value.map((shop) => shop.country))].sort());
const countryShops = computed(() => shops.value.filter((shop) => shop.country === country.value));
const effectiveShopIds = computed(() => useDefaultShops.value ? countryShops.value.map((shop) => shop.shopId) : selectedShopIds.value);
const selectedWorkflow = computed(() => workflows.find((entry) => entry.value === workflow.value));
const gateOpen = computed(() => Boolean(status.value?.enabled && status.value?.warehouseConfigured && status.value?.writeSecurity?.enabled));
const gateReason = computed(() => {
  if (!status.value) return "安全状态尚未加载";
  if (!status.value.enabled) return "折扣控价模块未启用";
  if (!status.value.warehouseConfigured) return "数仓控价连接未配置";
  if (!status.value.writeSecurity?.enabled) return status.value.writeSecurity?.reasonCode || "Shopee 写入安全闸门已关闭";
  return "写入闸门已通过，提交后仍需人工确认";
});
const scopeValid = computed(() => Boolean(country.value && category.value.trim() && effectiveShopIds.value.length));
const renewalStartValid = computed(() => workflow.value !== "NEXT_RENEWAL"
  || (typeof renewalStart.value === "string" && renewalStart.value.trim().length > 0 && Number.isFinite(new Date(renewalStart.value).getTime())));
const previewRequest = computed<CreateDiscountPreviewInput | null>(() => {
  const requestedStartAt = renewalStart.value;
  if (!renewalStartValid.value || (workflow.value === "NEXT_RENEWAL" && typeof requestedStartAt !== "string")) return null;
  return {
    country: country.value,
    shopIds: useDefaultShops.value ? [] : [...selectedShopIds.value],
    useDefaultShops: useDefaultShops.value,
    workflow: workflow.value,
    defaultTier: defaultTier.value,
    shopOverrides: shopOverrides.value.map((entry) => ({ ...entry })),
    linkOverrides: linkOverrides.value.map((entry) => ({ ...entry })),
    activitySelection: workflow.value === "CURRENT_CORRECTION" ? activitySelection.value.map((entry) => ({ ...entry })) : [],
    category: category.value.trim(),
    ...(workflow.value === "NEXT_RENEWAL" ? { renewal: { requestedStartAt: new Date(requestedStartAt as string).toISOString(), durationDays: 30 } } : {}),
  };
});
const previewRequestKey = computed(() => previewRequest.value
  ? discountPreviewInputKey(previewRequest.value)
  : `INVALID_RENEWAL:${renewalStart.value}`);
const previewAvailability = computed(() => discountPreviewAvailability({
  status: status.value,
  settings: settings.value,
  scopeValid: scopeValid.value,
  renewalStartValid: renewalStartValid.value,
  hasBatchErrors: Boolean(batchErrors.value.length),
  previewing: previewing.value,
}));
const canPreview = computed(() => previewAvailability.value.allowed);
const previewBlockedReason = computed(() => previewAvailability.value.reason);
const canApprove = computed(() => pageFlow.canApprove(Boolean(preview.value?.state === "PREVIEWED" && preview.value.itemCount > 0 && gateOpen.value
  && operatorName.value.trim() && confirmationInput.value === preview.value.confirmationText && !approving.value)));
const currentRun = computed(() => preview.value ? runs.value.find((run) => run.planId === preview.value?.id) || null : null);
const runLeaseExpired = computed(() => Boolean(currentRun.value?.status === "RUNNING"
  && (!currentRun.value.leaseUntil || new Date(currentRun.value.leaseUntil).getTime() <= Date.now())));
const canExecute = computed(() => pageFlow.canExecute(Boolean(gateOpen.value && !executing.value
  && (preview.value?.state === "APPROVED" || (preview.value?.state === "EXECUTING" && runLeaseExpired.value)))));
const executeLabel = computed(() => preview.value?.state === "EXECUTING" ? "恢复 / 重新检查执行任务" : "提交人工确认后的执行任务");
const executionPercent = computed(() => {
  const run = currentRun.value;
  const total = preview.value?.itemCount || 0;
  if (!run || !total) return 0;
  const done = Object.entries(run.counters || {}).filter(([key]) => key !== "PENDING" && key !== "DISPATCHED")
    .reduce((sum, [, value]) => sum + Number(value || 0), 0);
  return Math.min(100, Math.round(done / total * 100));
});
const unknownCount = computed(() => unknownIntents.value.length);
const renewalReminders = computed(() => activities.value.filter((entry) => {
  if (!entry.endsAt || !["ACTIVE", "PLANNED", "PENDING"].includes(entry.status)) return false;
  return new Date(entry.endsAt).getTime() <= Date.now() + 24 * 60 * 60 * 1000;
}));

function defaultRenewalStart() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function resetPlan() {
  pageFlow.invalidateRequests();
  preview.value = null;
  previewItems.value = [];
  nextCursor.value = null;
  operatorName.value = "";
  confirmationInput.value = "";
  previewing.value = false;
  approving.value = false;
  executing.value = false;
  itemLoading.value = false;
  scanning.value = false;
  unknownIntentLoading.value = false;
  loading.value = false;
  activeTab.value = "preview";
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function scopeBinding() { return { scopeKey: previewRequestKey.value }; }
function planBinding(plan = preview.value) {
  return plan ? { scopeKey: previewRequestKey.value, planId: plan.id, merkleRoot: plan.merkleRoot } : null;
}

watch(country, (_next, previous) => {
  selectedShopIds.value = [];
  shopOverrides.value = [];
  linkOverrides.value = [];
  activitySelection.value = [];
  batchErrors.value = [];
  batchValidatedRows.value = [];
  if (previous && !assigningInitialCountry) resetPlan();
});
watch(previewRequestKey, (next, previous) => { if (next !== previous && !assigningInitialCountry) resetPlan(); });

function shopName(shopId: string) {
  return shops.value.find((shop) => shop.shopId === shopId)?.name || shopId;
}

function tierLabel(tier?: string) {
  return tiers.find((entry) => entry.value === tier)?.label || tier || "未指定";
}

function formatDate(value?: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function formatMinor(value?: string | null, currency = "", scale = 2) {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return "-";
  const padded = value.padStart(scale + 1, "0");
  const amount = scale ? `${padded.slice(0, -scale)}.${padded.slice(-scale)}` : padded;
  return `${currency} ${amount}`.trim();
}

function reasonOf(item: DiscountPreviewItem) {
  return item.executionReasonCode || (item.payload.activity ? "已绑定活动" : "无冲突");
}

function addShopOverride() {
  const used = new Set(shopOverrides.value.map((entry) => entry.shopId));
  const shop = countryShops.value.find((entry) => effectiveShopIds.value.includes(entry.shopId) && !used.has(entry.shopId));
  if (!shop) return ElMessage.warning("当前范围没有可添加的店铺覆盖");
  shopOverrides.value.push({ shopId: shop.shopId, priceTier: defaultTier.value });
  resetPlan();
}

function addLinkOverride() {
  const shopId = effectiveShopIds.value[0];
  if (!shopId) return ElMessage.warning("请先选择店铺范围");
  linkOverrides.value.push({ shopId, itemId: "", priceTier: defaultTier.value, note: "运营手动覆盖" });
  resetPlan();
}

function addActivitySelection() {
  const shopId = effectiveShopIds.value[0];
  if (!shopId) return ElMessage.warning("请先选择店铺范围");
  activitySelection.value.push({ shopId, discountId: "", priceTier: defaultTier.value });
  resetPlan();
}

async function validateBatch() {
  const candidates: Array<{ shopId: string; itemRef: string; priceTier: DiscountTier; note: string; line: number }> = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = batchText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hasHeader = Boolean(lines[0]?.split(/[,\t]/)[0]?.trim().toLowerCase().includes("shop"));
  const dataRowCount = lines.length - Number(hasHeader);
  if (dataRowCount > 1000) errors.push("单次最多校验 1000 条链接覆盖");
  lines.forEach((line, index) => {
    const cells = line.split(/[,\t]/).map((cell) => cell.trim());
    if (index === 0 && hasHeader) return;
    const [shopId = "", itemRef = "", rawTier = "", note = ""] = cells;
    const priceTier = rawTier.toUpperCase() as DiscountTier;
    const key = `${shopId}:${itemRef}`;
    if (!/^\d+$/.test(shopId) || !itemRef) errors.push(`第 ${index + 1} 行：Shop ID 必须为数字，Item ID 或商品链接不能为空`);
    else if (!effectiveShopIds.value.includes(shopId)) errors.push(`第 ${index + 1} 行：店铺不在当前范围`);
    else if (!tiers.some((entry) => entry.value === priceTier)) errors.push(`第 ${index + 1} 行：价格档位仅支持 DAILY、EVENT、MEGA`);
    else if (!note) errors.push(`第 ${index + 1} 行：必须填写备注`);
    else if (seen.has(key)) errors.push(`第 ${index + 1} 行：店铺与链接重复`);
    else { seen.add(key); candidates.push({ shopId, itemRef, priceTier, note, line: index + 1 }); }
  });
  batchErrors.value = errors;
  batchValidatedRows.value = [];
  if (!lines.length) { batchErrors.value = ["请粘贴或选择 CSV 内容"]; return; }
  if (errors.length) return;
  batchValidating.value = true;
  try {
    const lookup = await lookupDiscountOverrideBatch({ country: country.value, rows: candidates.map((candidate) => ({
      shopId: candidate.shopId, query: candidate.itemRef, priceTier: candidate.priceTier, note: candidate.note,
    })) });
    const echoes = [];
    for (const row of lookup.rows) {
      const candidate = candidates[row.index];
      if (row.status !== "READY" || !row.itemId) throw new Error(`第 ${candidate.line} 行：${row.errorCode || "商品无法唯一解析"}`);
      if (linkOverrides.value.some((entry) => entry.shopId === row.shopId && entry.itemId === row.itemId)) throw new Error(`第 ${candidate.line} 行：商品已经添加`);
      echoes.push({ ...row, priceTier: row.finalTier || candidate.priceTier, note: row.note || candidate.note });
    }
    batchValidatedRows.value = echoes;
    ElMessage.success(`已校验 ${echoes.length} 条，请确认回显后导入`);
  } catch (error) { batchErrors.value = [error instanceof Error ? error.message : "批量校验失败"]; }
  finally { batchValidating.value = false; }
}

function confirmBatchImport() {
  linkOverrides.value.push(...batchValidatedRows.value.map((row) => ({ shopId: row.shopId, itemId: row.itemId, priceTier: row.priceTier, note: row.note })));
  const count = batchValidatedRows.value.length;
  batchValidatedRows.value = [];
  batchText.value = "";
  resetPlan();
  ElMessage.success(`已导入 ${count} 条链接覆盖`);
}

async function searchOverrides() {
  if (!overrideQuery.value.trim() || !scopeValid.value) return;
  overrideSearching.value = true;
  try { overrideMatches.value = (await lookupDiscountOverrides({ country: country.value, shopIds: effectiveShopIds.value, query: overrideQuery.value.trim() })).rows; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "搜索链接失败"); }
  finally { overrideSearching.value = false; }
}
function chooseOverride(row: DiscountOverrideLookupRow) {
  if (linkOverrides.value.some((entry) => entry.shopId === row.shopId && entry.itemId === row.itemId)) return ElMessage.warning("该链接已经添加");
  linkOverrides.value.push({ shopId: row.shopId, itemId: row.itemId, priceTier: defaultTier.value, note: `搜索确认 SKU ${row.sku}` });
  resetPlan();
}
async function reconcileIssue(issue: DiscountIssue, resolution: "LINK_VERIFIED_OBJECT" | "CONFIRMED_NOT_SENT" | "ABANDONED") {
  const intentId = String(issue.intentId || issue.evidence?.intentId || "");
  if (!intentId) return ElMessage.error("该异常没有可协调的 Intent ID");
  try {
    let evidence: Record<string, unknown> | undefined;
    if (resolution === "ABANDONED") {
      const prompt = await ElMessageBox.prompt("请输入规范原因代码（大写字母、数字、下划线），该代码将写入审计证据。", "接受 UNKNOWN 风险并放弃", {
        inputPlaceholder: "例如：OPERATOR_CONFIRMED_PLATFORM_UNRESOLVED",
        inputValidator: (value) => /^[A-Z][A-Z0-9_]{2,100}$/.test(value) || "原因代码格式无效",
        confirmButtonText: "继续风险确认", cancelButtonText: "取消",
      });
      await ElMessageBox.confirm(`确认接受重复写或漏写风险并放弃该 UNKNOWN？\n原因：${prompt.value}`, "最终风险确认", {
        type: "warning", confirmButtonText: "确认接受并放弃", cancelButtonText: "返回检查",
      });
      evidence = { accepted: true, reasonCode: prompt.value, operatorNote: prompt.value };
    }
    await reconcileDiscountIntent(intentId, resolution, evidence);
    ElMessage.success("UNKNOWN 决策已记录审计"); await refreshOperationalData();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "UNKNOWN 协调失败"); }
}
async function reconcileUnknownIntent(intent: DiscountUnknownIntent, resolution: "LINK_VERIFIED_OBJECT" | "CONFIRMED_NOT_SENT" | "ABANDONED") {
  await reconcileIssue({ intentId: intent.intentId, evidence: {}, planId: intent.planId } as DiscountIssue, resolution);
}

async function restorePlan(planId: string, prerequisite?: { ticket: ReturnType<DiscountRequestGuard["begin"]>; binding: Record<string, string> }) {
  if (prerequisite && !requestGuard.isCurrent(prerequisite.ticket, prerequisite.binding)) return;
  const binding = { scopeKey: previewRequestKey.value, planId };
  const ticket = requestGuard.begin("restore", binding);
  try {
    const restored = await loadDiscountPreview(planId);
    if (!requestGuard.isCurrent(ticket, binding)) return;
    const page = await loadDiscountPreviewItems(planId, { pageSize: 100 });
    if (!requestGuard.isCurrent(ticket, binding)) return;
    preview.value = restored;
    previewItems.value = page.items;
    nextCursor.value = page.nextCursor;
    activeTab.value = "execution";
  } catch (error) { if (requestGuard.isCurrent(ticket, binding)) ElMessage.error(error instanceof Error ? error.message : "恢复执行方案失败"); }
}
async function loadSettingsPanel() { try { settings.value = await loadDiscountSettings(); } catch { settings.value = null; } }
async function saveSettingsPanel() {
  try { settings.value = await saveDiscountSettings({ enabled: settings.value?.enabled, timezone: settings.value?.timezone, ...(settingsKey.value ? { warehouseKey: settingsKey.value } : {}) }); settingsKey.value = ""; ElMessage.success("设置已保存，旧审批已失效"); await loadDashboard(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存设置失败"); }
}
async function verifySettingsPanel() { try { settings.value = await verifyDiscountSettings(); ElMessage.success("数仓 Key 验证通过"); } catch (error) { ElMessage.error(error instanceof Error ? error.message : "验证失败"); } }

function readBatchFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 512 * 1024) { batchErrors.value = ["文件不能超过 512 KB"]; return; }
  const reader = new FileReader();
  reader.onload = () => { batchText.value = String(reader.result || ""); void validateBatch(); };
  reader.onerror = () => { batchErrors.value = ["文件读取失败，请检查文件编码"]; };
  reader.readAsText(file);
  input.value = "";
}

async function loadDashboard() {
  const dashboardBinding = {};
  const dashboardTicket = requestGuard.begin("dashboard", dashboardBinding);
  const snapshotTicket = pageFlow.beginOperationalSnapshot();
  requestGuard.invalidate("unknownIntents");
  unknownIntentLoading.value = false;
  loading.value = true;
  errorMessage.value = "";
  try {
    const [nextStatus, nextShops, nextRuns, nextActivities, nextIssues, nextUnknownIntents] = await Promise.all([
      loadDiscountStatus(), loadDiscountShops(), loadDiscountRuns({ limit: 50 }),
      loadDiscountActivities({ limit: 50 }), loadDiscountIssues({ limit: 50 }), loadDiscountUnknownIntents({ limit: 50 }),
    ]);
    pageFlow.commitOperationalSnapshot(snapshotTicket, () => {
      runs.value = nextRuns;
      activities.value = nextActivities;
      issues.value = nextIssues;
      unknownIntents.value = nextUnknownIntents.items;
      unknownIntentCursor.value = nextUnknownIntents.nextCursor;
    });
    if (requestGuard.isCurrent(dashboardTicket, {})) {
      status.value = nextStatus;
      shops.value = nextShops;
      if (!country.value) {
        assigningInitialCountry = true;
        country.value = countries.value[0] || "";
      }
    }
    await nextTick();
    assigningInitialCountry = false;
    if (!requestGuard.isCurrent(dashboardTicket, dashboardBinding)
      || !pageFlow.isOperationalSnapshotCurrent(snapshotTicket)) return;
    if (!preview.value) {
      const recoverable = nextRuns.find((run) => ["RUNNING", "PENDING"].includes(run.status));
      if (recoverable) await restorePlan(recoverable.planId, { ticket: dashboardTicket, binding: dashboardBinding });
    }
  } catch (error) {
    if (requestGuard.isCurrent(dashboardTicket, {}) && pageFlow.isOperationalSnapshotCurrent(snapshotTicket)) {
      errorMessage.value = error instanceof Error ? error.message : "折扣控价数据加载失败";
    }
  } finally {
    assigningInitialCountry = false;
    if (requestGuard.isCurrent(dashboardTicket, {})) loading.value = false;
  }
}

async function generatePreview() {
  const request = previewRequest.value;
  if (!canPreview.value || !request) return;
  const binding = scopeBinding();
  const ticket = pageFlow.beginPreview(binding.scopeKey);
  previewItems.value = [];
  nextCursor.value = null;
  errorMessage.value = "";
  try {
    const next = await createDiscountPreview(request);
    if (!pageFlow.acceptPreview(ticket, scopeBinding().scopeKey, next)) return;
    await loadMoreItems();
    if (!requestGuard.isCurrent(ticket, scopeBinding())) return;
    activeTab.value = "preview";
    ElMessage.success("价格预览已生成，尚未执行任何 Shopee 写入");
  } catch (error) {
    if (requestGuard.isCurrent(ticket, scopeBinding())) {
      const message = error instanceof Error ? error.message : "生成预览失败";
      errorMessage.value = message;
      ElMessage.error(message);
    }
  } finally { pageFlow.finishPreview(ticket, scopeBinding().scopeKey); }
}

async function loadMoreItems() {
  const plan = preview.value;
  const binding = planBinding(plan);
  if (!plan || !binding || itemLoading.value) return;
  const ticket = requestGuard.begin("items", binding);
  itemLoading.value = true;
  try {
    const page = await loadDiscountPreviewItems(plan.id, { cursor: nextCursor.value, pageSize: 50 });
    const current = planBinding();
    if (!current || !requestGuard.isCurrent(ticket, current)) return;
    previewItems.value.push(...page.items);
    nextCursor.value = page.nextCursor;
  } catch (error) {
    const current = planBinding();
    if (current && requestGuard.isCurrent(ticket, current)) ElMessage.error(error instanceof Error ? error.message : "加载预览明细失败");
  } finally {
    const current = planBinding();
    if (current && requestGuard.isCurrent(ticket, current)) itemLoading.value = false;
  }
}

async function approvePlan() {
  const plan = preview.value;
  const binding = planBinding(plan);
  if (!plan || !binding || !canApprove.value) return;
  const ticket = requestGuard.begin("approve", binding);
  approving.value = true;
  try {
    const approved = await approveDiscountPreview({ planId: plan.id, merkleRoot: plan.merkleRoot,
      operatorName: operatorName.value.trim(), confirmationText: confirmationInput.value,
      ...(status.value?.writeSecurity.mode === "separate_execute_identity" && plan.expiresAt ? {
        privilegedApproval: { planId: plan.id, merkleRoot: plan.merkleRoot,
          policyHash: plan.policyHash, expiresAt: plan.expiresAt },
      } : {}),
    });
    const current = planBinding();
    if (!current || !requestGuard.isCurrent(ticket, current)) return;
    preview.value = approved;
    ElMessage.success("价格方案已由运营确认，尚未提交执行任务");
  } catch (error) {
    const current = planBinding();
    if (current && requestGuard.isCurrent(ticket, current)) ElMessage.error(error instanceof Error ? error.message : "确认价格方案失败");
  } finally {
    const current = planBinding();
    if (current && requestGuard.isCurrent(ticket, current)) approving.value = false;
  }
}

async function executePlan() {
  const plan = preview.value;
  const binding = planBinding(plan);
  if (!plan || !binding || !canExecute.value) return;
  const ticket = requestGuard.begin("execute", binding);
  executing.value = true;
  try {
    const job = await executeDiscountPreview({ planId: plan.id, merkleRoot: plan.merkleRoot });
    const current = planBinding();
    if (!current || !requestGuard.isCurrent(ticket, current)) return;
    const snapshotTicket = pageFlow.beginOperationalSnapshot();
    pageFlow.commitOperationalSnapshot(snapshotTicket, () => {
      runs.value = [job, ...runs.value.filter((entry) => entry.id !== job.id)];
    });
    activeTab.value = "execution";
    startPolling();
    ElMessage.success("已提交人工确认后的执行任务");
  } catch (error) {
    const current = planBinding();
    if (current && requestGuard.isCurrent(ticket, current)) ElMessage.error(error instanceof Error ? error.message : "提交执行任务失败");
  } finally {
    const current = planBinding();
    if (current && requestGuard.isCurrent(ticket, current)) executing.value = false;
  }
}

async function refreshOperationalData() {
  const ticket = pageFlow.beginOperationalSnapshot();
  requestGuard.invalidate("unknownIntents");
  unknownIntentLoading.value = false;
  try {
    const [nextRuns, nextActivities, nextIssues, nextUnknownIntents] = await Promise.all([
      loadDiscountRuns({ limit: 50 }), loadDiscountActivities({ limit: 50 }), loadDiscountIssues({ limit: 50 }), loadDiscountUnknownIntents({ limit: 50 }),
    ]);
    pageFlow.commitOperationalSnapshot(ticket, () => {
      [runs.value, activities.value, issues.value] = [nextRuns, nextActivities, nextIssues];
      unknownIntents.value = nextUnknownIntents.items;
      unknownIntentCursor.value = nextUnknownIntents.nextCursor;
    });
  } catch (error) {
    if (pageFlow.isOperationalSnapshotCurrent(ticket)) ElMessage.error(error instanceof Error ? error.message : "刷新执行状态失败");
  }
}

async function loadMoreUnknownIntents() {
  const expectedCursor = unknownIntentCursor.value;
  if (!expectedCursor || unknownIntentLoading.value) return;
  const binding = { scopeKey: previewRequestKey.value, cursor: expectedCursor };
  const ticket = requestGuard.begin("unknownIntents", binding);
  unknownIntentLoading.value = true;
  try {
    const page = await loadDiscountUnknownIntents({ limit: 50, cursor: expectedCursor });
    if (!requestGuard.isCurrent(ticket, binding) || unknownIntentCursor.value !== expectedCursor
      || previewRequestKey.value !== binding.scopeKey) return;
    const seen = new Set(unknownIntents.value.map(({ intentId }) => intentId));
    unknownIntents.value.push(...page.items.filter(({ intentId }) => !seen.has(intentId)));
    unknownIntentCursor.value = page.nextCursor;
  } catch (error) {
    if (requestGuard.isCurrent(ticket, binding)) ElMessage.error(error instanceof Error ? error.message : "加载 UNKNOWN Intent 失败");
  } finally {
    if (requestGuard.isCurrent(ticket, binding)) unknownIntentLoading.value = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void refreshOperationalData();
    if (currentRun.value && !["PENDING", "RUNNING"].includes(currentRun.value.status)) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 5000);
}

async function scanNow() {
  if (!scopeValid.value || scanning.value) return;
  const binding = scopeBinding();
  const ticket = requestGuard.begin("scan", binding);
  scanning.value = true;
  try {
    await requestDiscountScan(country.value, effectiveShopIds.value);
    if (requestGuard.isCurrent(ticket, scopeBinding())) ElMessage.success("立即检查已加入系统待办，不会自动确认或写入")
  } catch (error) {
    if (requestGuard.isCurrent(ticket, scopeBinding())) ElMessage.error(error instanceof Error ? error.message : "创建检查待办失败");
  } finally { if (requestGuard.isCurrent(ticket, scopeBinding())) scanning.value = false; }
}

onMounted(() => { void loadDashboard(); void loadSettingsPanel(); });
onBeforeUnmount(() => {
  pageFlow.dispose();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<template>
  <div class="discount-page" v-loading="loading">
    <section class="commandbar" aria-label="折扣控价操作">
      <div>
        <div class="title-row"><h2>Shopee 折扣控价</h2><el-tag type="info" effect="plain">人工确认</el-tag></div>
        <p>按国家与 SKU 匹配数仓目标价，预览后由运营确认，再提交折扣任务。</p>
      </div>
      <div class="command-actions">
        <el-button :icon="RefreshCw" :loading="loading" @click="loadDashboard">刷新</el-button>
        <el-button :icon="SearchCheck" :loading="scanning" :disabled="!scopeValid" @click="scanNow">立即检查</el-button>
      </div>
    </section>

    <div v-if="errorMessage" class="page-error" role="alert"><AlertTriangle :size="18" /><span>{{ errorMessage }}</span><el-button text @click="loadDashboard">重试</el-button></div>
    <section class="gate-strip" :class="gateOpen ? 'open' : 'closed'" aria-live="polite">
      <CheckCircle2 v-if="gateOpen" :size="18" /><ShieldAlert v-else :size="18" />
      <div><strong>{{ gateOpen ? '写入安全闸门已通过' : '当前为只读或阻断状态' }}</strong><span>{{ gateReason }}</span></div>
      <el-tag :type="gateOpen ? 'success' : 'danger'" effect="light">{{ gateOpen ? '可人工确认' : '禁止写入' }}</el-tag>
    </section>

    <section class="scope-panel" aria-label="价格匹配范围">
      <header><div><h3>匹配范围与价格策略</h3><p>默认覆盖所选国家全部健康店铺及其全部在售商品。</p></div></header>
      <div class="scope-grid">
        <label class="field"><span>选择国家</span><el-select v-model="country" aria-label="选择国家" placeholder="选择国家"><el-option v-for="entry in countries" :key="entry" :label="entry" :value="entry" /></el-select></label>
        <label class="field"><span>大品类</span><el-input v-model="category" aria-label="输入大品类" placeholder="例如：家具" /></label>
        <label class="field"><span>选择价格档位</span><el-select v-model="defaultTier" aria-label="选择价格档位"><el-option v-for="entry in tiers" :key="entry.value" :label="entry.label" :value="entry.value" /></el-select></label>
        <label class="field"><span>选择工作流</span><el-select v-model="workflow" aria-label="选择工作流"><el-option v-for="entry in workflows" :key="entry.value" :label="entry.label" :value="entry.value" /></el-select><small>{{ selectedWorkflow?.hint }}</small></label>
        <label v-if="workflow === 'NEXT_RENEWAL'" class="field"><span>下一期开始时间</span><el-date-picker v-model="renewalStart" type="datetime" value-format="YYYY-MM-DDTHH:mm" aria-label="选择下一期开始时间" /><small v-if="!renewalStartValid" class="danger-text" role="alert">请选择有效的开始时间</small></label>
      </div>
      <div class="shop-scope">
        <el-checkbox v-model="useDefaultShops">默认覆盖全部在售商品</el-checkbox>
        <label class="field grow"><span>选择店铺</span><el-select v-model="selectedShopIds" multiple collapse-tags :disabled="useDefaultShops" aria-label="选择店铺" placeholder="选择当前国家店铺"><el-option v-for="shop in countryShops" :key="shop.shopId" :label="`${shop.name} (${shop.shopId})`" :value="shop.shopId" /></el-select></label>
        <span class="scope-count">{{ effectiveShopIds.length }} 家店铺</span>
      </div>
    </section>

    <section v-if="settings" class="scope-panel" aria-label="折扣控价设置">
      <header><div><h3>安全设置</h3><p>密钥仅提交到服务端加密保存，页面只显示脱敏提示。</p></div></header>
      <div class="scope-grid">
        <label class="field"><span>启用模块</span><el-switch v-model="settings.enabled" /></label>
        <label class="field"><span>IANA 时区</span><el-input v-model="settings.timezone" /></label>
        <label class="field"><span>数仓 Key（留空不修改）</span><el-input v-model="settingsKey" type="password" show-password :placeholder="settings.warehouseKeyHint || 'zndr_…'" /></label>
        <div class="field"><span>验证状态</span><small>{{ settings.warehouseKeyVerifiedAt ? `已验证 ${formatDate(settings.warehouseKeyVerifiedAt)}` : '尚未验证' }}</small></div>
      </div>
      <div class="approval-actions"><el-button @click="saveSettingsPanel">保存设置</el-button><el-button @click="verifySettingsPanel">验证 Key</el-button></div>
    </section>

    <section class="override-grid">
      <article class="config-panel">
        <header><div><h3>店铺覆盖</h3><p>仅影响本期方案，下一期重新选择。</p></div><el-button text type="primary" :icon="Plus" @click="addShopOverride">添加</el-button></header>
        <div v-if="shopOverrides.length" class="edit-list">
          <div v-for="(entry, index) in shopOverrides" :key="`${entry.shopId}-${index}`" class="edit-row">
            <el-select v-model="entry.shopId" aria-label="店铺覆盖店铺"><el-option v-for="shop in countryShops.filter((item) => effectiveShopIds.includes(item.shopId))" :key="shop.shopId" :label="shop.name" :value="shop.shopId" /></el-select>
            <el-select v-model="entry.priceTier" aria-label="店铺覆盖价格档位"><el-option v-for="tier in tiers" :key="tier.value" :label="tier.label" :value="tier.value" /></el-select>
            <el-button text type="danger" :icon="Trash2" aria-label="删除店铺覆盖" @click="shopOverrides.splice(index, 1); resetPlan()" />
          </div>
        </div><el-empty v-else description="没有店铺级覆盖" :image-size="52" />
      </article>

      <article class="config-panel">
        <header><div><h3>链接覆盖</h3><p>按 Shop ID 与 Item ID 指定活动价或大促价。</p></div><el-button text type="primary" :icon="Plus" @click="addLinkOverride">添加</el-button></header>
        <div class="batch-actions"><el-input v-model="overrideQuery" aria-label="搜索链接、Item ID 或 SKU" placeholder="粘贴 Shopee 商品链接，或输入 Item ID / SKU" @keyup.enter="searchOverrides" /><el-button :loading="overrideSearching" @click="searchOverrides">搜索</el-button></div>
        <div v-if="overrideMatches.length" class="edit-list" aria-label="覆盖搜索结果"><div v-for="row in overrideMatches" :key="`${row.shopId}-${row.itemId}`" class="edit-row"><span>{{ row.shopName }} · {{ row.itemId }} · {{ row.sku }} · {{ row.variantCount }} 变体</span><el-button text type="primary" @click="chooseOverride(row)">选择</el-button></div></div>
        <div v-if="linkOverrides.length" class="edit-list">
          <div v-for="(entry, index) in linkOverrides" :key="`${entry.shopId}-${entry.itemId}-${index}`" class="edit-row link-row">
            <el-select v-model="entry.shopId" aria-label="链接覆盖店铺"><el-option v-for="shop in countryShops.filter((item) => effectiveShopIds.includes(item.shopId))" :key="shop.shopId" :label="shop.name" :value="shop.shopId" /></el-select>
            <el-input v-model="entry.itemId" aria-label="链接 Item ID" placeholder="Item ID" @change="resetPlan" />
            <el-select v-model="entry.priceTier" aria-label="链接覆盖价格档位"><el-option v-for="tier in tiers" :key="tier.value" :label="tier.label" :value="tier.value" /></el-select>
            <el-input v-model="entry.note" aria-label="链接覆盖备注" placeholder="必填：本期覆盖原因" @change="resetPlan" />
            <el-button text type="danger" :icon="Trash2" aria-label="删除链接覆盖" @click="linkOverrides.splice(index, 1); resetPlan()" />
          </div>
        </div><el-empty v-else description="默认使用店铺价格档位" :image-size="52" />
      </article>

      <article v-if="workflow === 'CURRENT_CORRECTION'" class="config-panel">
        <header><div><h3>当前 Discount 活动</h3><p>明确指定要修正的活动，不按名称猜测活动类型。</p></div><el-button text type="primary" :icon="Plus" @click="addActivitySelection">添加</el-button></header>
        <div v-if="activitySelection.length" class="edit-list">
          <div v-for="(entry, index) in activitySelection" :key="`${entry.shopId}-${entry.discountId}-${index}`" class="edit-row link-row">
            <el-select v-model="entry.shopId" aria-label="活动所属店铺"><el-option v-for="shop in countryShops.filter((item) => effectiveShopIds.includes(item.shopId))" :key="shop.shopId" :label="shop.name" :value="shop.shopId" /></el-select>
            <el-input v-model="entry.discountId" aria-label="Discount 活动 ID" placeholder="Discount ID" @change="resetPlan" />
            <el-select v-model="entry.priceTier" aria-label="活动价格档位"><el-option v-for="tier in tiers" :key="tier.value" :label="tier.label" :value="tier.value" /></el-select>
            <el-button text type="danger" :icon="Trash2" aria-label="删除活动选择" @click="activitySelection.splice(index, 1); resetPlan()" />
          </div>
        </div><el-empty v-else description="请添加本次要修正的 Discount 活动" :image-size="52" />
      </article>

      <article class="config-panel batch-panel">
        <header><div><h3>批量导入链接覆盖</h3><p>CSV 列：shop_id,item_id_or_product_link,price_tier,note。导入前回显店铺、Item、SKU、变体数、最终档位与规则来源。</p></div><FileSpreadsheet :size="19" /></header>
        <el-input v-model="batchText" type="textarea" :rows="4" aria-label="批量导入链接覆盖" placeholder="shop_id,item_id_or_product_link,price_tier,note" />
        <div class="batch-actions"><button type="button" class="file-button" @click="batchFileInput?.click()">选择 CSV</button><input ref="batchFileInput" class="visually-hidden" type="file" accept=".csv,text/csv,text/plain" aria-label="选择链接覆盖 CSV 文件" @change="readBatchFile" /><el-button :loading="batchValidating" @click="validateBatch">服务端校验并回显</el-button><el-button v-if="batchValidatedRows.length" type="primary" @click="confirmBatchImport">确认导入 {{ batchValidatedRows.length }} 条</el-button></div>
        <div v-if="batchErrors.length" class="validation-errors" role="alert"><strong>导入未通过</strong><span v-for="message in batchErrors.slice(0, 8)" :key="message">{{ message }}</span></div>
        <div v-if="batchValidatedRows.length" class="edit-list" aria-label="批量覆盖校验回显"><div v-for="row in batchValidatedRows" :key="`${row.shopId}-${row.itemId}`" class="edit-row"><span>{{ row.shopName }} · Item {{ row.itemId }} · SKU {{ row.sku }} · {{ row.variantCount }} 变体 · {{ tierLabel(row.priceTier) }} · {{ row.ruleSource || 'LINK_OVERRIDE' }} · {{ row.note }}</span></div></div>
      </article>
    </section>

    <section class="preview-action" aria-label="价格预览操作">
      <div><strong>所有价格均按站点最小货币单位向下取整</strong><span>数仓无有效目标价时，使用 Shopee 原价的 1% off；异常变体单独跳过。</span><span v-if="!canPreview" class="preview-action-error">{{ previewBlockedReason }}</span><span v-else-if="errorMessage" class="preview-action-error">{{ errorMessage }}</span></div>
      <el-button type="primary" :icon="SearchCheck" :loading="previewing" :disabled="!canPreview" @click="generatePreview">生成价格预览</el-button>
    </section>

    <section class="workbench">
      <el-tabs v-model="activeTab">
        <el-tab-pane name="preview" label="预览明细">
          <div v-if="preview" class="preview-content">
            <div class="metric-grid" aria-label="价格预览汇总">
              <article><span>发现变体</span><strong>{{ preview.summary.counts?.discovered || 0 }}</strong></article>
              <article class="success"><span>可执行</span><strong>{{ preview.summary.counts?.ready || 0 }}</strong></article>
              <article class="warning"><span>已跳过</span><strong>{{ preview.summary.counts?.skipped || 0 }}</strong></article>
              <article><span>覆盖店铺</span><strong>{{ preview.summary.shopCount || effectiveShopIds.length }}</strong></article>
            </div>
            <el-table :data="previewItems" class="discount-table" stripe empty-text="本次预览没有可执行变体">
              <el-table-column label="店铺" min-width="150"><template #default="scope"><div class="stack"><strong>{{ shopName(scope.row.shopId) }}</strong><small>{{ scope.row.shopId }}</small></div></template></el-table-column>
              <el-table-column prop="sku" label="SKU" min-width="150" />
              <el-table-column label="Item / Model" min-width="160"><template #default="scope"><div class="stack"><span>{{ scope.row.itemId }}</span><small>{{ scope.row.modelId }}</small></div></template></el-table-column>
              <el-table-column label="当前折扣价" width="130" align="right"><template #default="scope">{{ formatMinor(scope.row.currentPriceMinor, scope.row.currency, scope.row.scale) }}</template></el-table-column>
              <el-table-column label="目标折扣价" width="130" align="right"><template #default="scope"><strong class="target-price">{{ formatMinor(scope.row.targetPriceMinor, scope.row.currency, scope.row.scale) }}</strong></template></el-table-column>
              <el-table-column label="价格来源" width="120"><template #default="scope">{{ scope.row.payload.priceSource === 'WAREHOUSE' ? '数据仓库' : '原价 1% off' }}</template></el-table-column>
              <el-table-column label="匹配规则" width="140"><template #default="scope"><div class="stack"><span>{{ tierLabel(scope.row.payload.priceTier) }}</span><small>{{ scope.row.payload.ruleSource || '默认规则' }}</small></div></template></el-table-column>
              <el-table-column label="冲突原因" min-width="145"><template #default="scope"><span :class="scope.row.executionReasonCode ? 'danger-text' : 'muted-text'">{{ reasonOf(scope.row) }}</span></template></el-table-column>
            </el-table>
            <div class="pagination-row"><span>已加载 {{ previewItems.length }} 条</span><el-button v-if="nextCursor !== null" :loading="itemLoading" @click="loadMoreItems">加载下一页</el-button></div>
            <div class="approval-box">
              <header><div><h3>运营人工确认</h3><p>确认语句必须逐字一致。系统不会自动批准此方案。</p></div><el-tag :type="preview.state === 'APPROVED' ? 'success' : 'warning'">{{ preview.state }}</el-tag></header>
              <div class="approval-fields">
                <label class="field"><span>运营确认人</span><el-input v-model="operatorName" aria-label="运营确认人" placeholder="输入姓名" :disabled="preview.state !== 'PREVIEWED'" /></label>
                <label class="field wide"><span>输入完整确认语句</span><el-input v-model="confirmationInput" aria-label="输入完整确认语句" :placeholder="preview.confirmationText" :disabled="preview.state !== 'PREVIEWED'" /><small>应输入：{{ preview.confirmationText }}</small></label>
              </div>
              <div v-if="!gateOpen" class="inline-warning"><ShieldAlert :size="16" />{{ gateReason }}</div>
              <div class="approval-actions"><el-button :loading="approving" :disabled="!canApprove" @click="approvePlan">确认价格方案</el-button><el-button type="primary" :icon="Play" :loading="executing" :disabled="!canExecute" @click="executePlan">{{ executeLabel }}</el-button></div>
            </div>
          </div>
          <el-empty v-else description="设置范围后生成价格预览。此操作只读，不会修改 Shopee。" />
        </el-tab-pane>

        <el-tab-pane name="execution">
          <template #label><span class="tab-label"><Play :size="15" />执行进度</span></template>
          <div class="batch-actions" aria-label="恢复历史执行方案"><span>最近执行：</span><el-button v-for="run in runs.slice(0, 10)" :key="run.id" size="small" @click="restorePlan(run.planId)">{{ run.planId }} · {{ run.status }}</el-button></div>
          <div v-if="currentRun" class="execution-panel" aria-live="polite">
            <div class="execution-head"><div><strong>{{ currentRun.id }}</strong><span>{{ currentRun.status }}，更新于 {{ formatDate(currentRun.updatedAt) }}</span></div><el-button :icon="RefreshCw" @click="refreshOperationalData">刷新状态</el-button></div>
            <el-progress :percentage="executionPercent" :status="currentRun.status === 'SUCCEEDED' ? 'success' : currentRun.status === 'FAILED' ? 'exception' : undefined" />
            <div class="counter-grid"><div v-for="(value, key) in currentRun.counters" :key="key"><span>{{ key }}</span><strong>{{ value }}</strong></div></div>
            <el-alert v-if="currentRun.lastErrorCode" :title="currentRun.lastErrorCode" type="error" :closable="false" show-icon />
          </div><el-empty v-else description="没有当前方案的执行任务" />
        </el-tab-pane>

        <el-tab-pane name="issues">
          <template #label><span class="tab-label"><AlertTriangle :size="15" />异常与 UNKNOWN 协调 <el-badge v-if="unknownCount" :value="unknownCount" /></span></template>
          <el-alert v-if="unknownCount" title="UNKNOWN 表示平台请求结果无法确认。请先按待办回查，不要重复提交。" type="warning" :closable="false" show-icon />
          <el-table :data="unknownIntents" class="discount-table" empty-text="暂无需要协调的 UNKNOWN Intent">
            <el-table-column label="时间" width="170"><template #default="scope">{{ formatDate(scope.row.dispatchedAt) }}</template></el-table-column>
            <el-table-column prop="planId" label="方案" min-width="180" />
            <el-table-column prop="intentId" label="Intent ID" min-width="210" />
            <el-table-column label="问题代码" min-width="220"><template #default="scope"><strong>{{ scope.row.reasonCode || 'UNKNOWN' }}</strong></template></el-table-column>
            <el-table-column label="目标" min-width="260"><template #default="scope"><span class="evidence">{{ scope.row.targetType }} · {{ scope.row.targetKey }}</span></template></el-table-column>
            <el-table-column label="协调决策" min-width="330"><template #default="scope"><div class="batch-actions"><el-button size="small" @click="reconcileUnknownIntent(scope.row, 'LINK_VERIFIED_OBJECT')">关联已核验对象</el-button><el-button size="small" @click="reconcileUnknownIntent(scope.row, 'CONFIRMED_NOT_SENT')">确认未发送</el-button><el-button size="small" type="danger" @click="reconcileUnknownIntent(scope.row, 'ABANDONED')">接受并放弃</el-button></div></template></el-table-column>
          </el-table>
          <div class="pagination-row"><span>已加载 {{ unknownIntents.length }} 条 UNKNOWN Intent</span><el-button v-if="unknownIntentCursor" :loading="unknownIntentLoading" :disabled="unknownIntentLoading" @click="loadMoreUnknownIntents">加载下一页</el-button></div>
        </el-tab-pane>

        <el-tab-pane name="renewals">
          <template #label><span class="tab-label"><BellRing :size="15" />续期提醒</span></template>
          <el-alert title="正常续期无缝衔接；错过后从最近可用时间开始，不补历史空档。大促结束后重新开始完整 30 天周期。" type="info" :closable="false" show-icon />
          <el-table :data="renewalReminders" class="discount-table" empty-text="未来 24 小时没有需要运营处理的续期">
            <el-table-column label="店铺" min-width="180"><template #default="scope">{{ shopName(scope.row.shopId) }}</template></el-table-column>
            <el-table-column prop="activityType" label="活动类型" width="160" />
            <el-table-column prop="platformActivityId" label="Discount ID" width="150" />
            <el-table-column label="结束时间" min-width="180"><template #default="scope">{{ formatDate(scope.row.endsAt) }}</template></el-table-column>
            <el-table-column prop="status" label="状态" width="120" />
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>
  </div>
</template>

<style scoped>
.discount-page { display: grid; gap: 14px; min-height: 620px; }
.commandbar, .title-row, .command-actions, .gate-strip, .shop-scope, .preview-action, .approval-actions, .batch-actions, .execution-head, .tab-label { display: flex; align-items: center; }
.commandbar { justify-content: space-between; gap: 18px; }
.title-row { gap: 10px; }
.title-row h2 { margin: 0; font-size: 19px; letter-spacing: -.025em; }
.commandbar p, .scope-panel header p, .config-panel header p, .approval-box header p { margin: 5px 0 0; color: var(--ops-text-secondary); font-size: 12px; }
.command-actions { gap: 8px; }
.page-error { display: flex; align-items: center; gap: 9px; padding: 11px 13px; border: 1px solid #fecaca; border-radius: var(--ops-radius-sm); color: #991b1b; background: #fef2f2; font-size: 12px; }
.page-error .el-button { margin-left: auto; }
.gate-strip { gap: 10px; padding: 11px 14px; border: 1px solid; border-radius: var(--ops-radius-sm); }
.gate-strip.open { color: #166534; border-color: #bbf7d0; background: #f0fdf4; }
.gate-strip.closed { color: #991b1b; border-color: #fecaca; background: #fef2f2; }
.gate-strip > div { display: grid; flex: 1; gap: 2px; }
.gate-strip strong { font-size: 12px; }.gate-strip span { font-size: 11px; opacity: .82; }
.scope-panel, .config-panel, .workbench, .preview-action { border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.scope-panel { padding: 15px; }.scope-panel > header, .config-panel > header, .approval-box > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.scope-panel h3, .config-panel h3, .approval-box h3 { margin: 0; font-size: 14px; }
.scope-grid { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
.field { min-width: 0; display: grid; align-content: start; gap: 6px; }
.field > span { color: var(--ops-text-secondary); font-size: 11px; font-weight: 700; }.field small { color: var(--ops-text-muted); font-size: 10px; }
.field :deep(.el-select), .field :deep(.el-date-editor) { width: 100%; }.field.grow { flex: 1; }.field.wide { grid-column: span 2; }
.shop-scope { gap: 16px; margin-top: 13px; padding-top: 13px; border-top: 1px solid var(--ops-border-light); }.scope-count { color: var(--ops-text-muted); font-size: 11px; white-space: nowrap; }
.override-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }.config-panel { min-height: 180px; padding: 14px; }.config-panel > header { margin-bottom: 11px; }
.edit-list { display: grid; gap: 8px; }.edit-row { display: grid; grid-template-columns: 1fr 130px 34px; gap: 7px; }.edit-row.link-row { grid-template-columns: 1fr 1fr 120px 34px; }
.batch-panel textarea { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }.batch-actions { justify-content: flex-end; gap: 8px; margin-top: 9px; }
.file-button { display: inline-flex; align-items: center; min-height: 30px; padding: 0 12px; border: 1px solid var(--ops-border); border-radius: 5px; color: var(--ops-text-secondary); background: var(--ops-surface); cursor: pointer; font: inherit; font-size: 12px; }.file-button:hover, .file-button:focus-visible { color: var(--ops-primary); border-color: var(--ops-primary); outline: 2px solid color-mix(in srgb, var(--ops-primary) 24%, transparent); outline-offset: 2px; }.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.validation-errors { display: grid; gap: 3px; margin-top: 9px; padding: 9px 11px; border-radius: 7px; color: #991b1b; background: #fef2f2; font-size: 11px; }
.preview-action { justify-content: space-between; gap: 18px; padding: 13px 15px; }.preview-action > div { display: grid; gap: 3px; }.preview-action strong { font-size: 12px; }.preview-action span { color: var(--ops-text-secondary); font-size: 11px; }.preview-action .preview-action-error { color: var(--el-color-danger); font-weight: 600; }
.workbench { padding: 0 14px 14px; overflow: hidden; }.workbench :deep(.el-tabs__header) { margin-bottom: 13px; }.tab-label { gap: 6px; }
.preview-content { display: grid; gap: 13px; }.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }.metric-grid article { display: grid; gap: 4px; padding: 12px; border-left: 3px solid var(--ops-primary); border-radius: 7px; background: var(--ops-surface-muted); }.metric-grid article.success { border-color: var(--ops-success); }.metric-grid article.warning { border-color: var(--ops-warning); }.metric-grid span { color: var(--ops-text-secondary); font-size: 11px; }.metric-grid strong { font-size: 21px; font-variant-numeric: tabular-nums; }
.discount-table { --el-table-header-bg-color: var(--ops-surface-muted); --el-table-border-color: var(--ops-border-light); }.discount-table :deep(th.el-table__cell) { color: var(--ops-text-secondary); font-size: 11px; }.discount-table :deep(td.el-table__cell) { font-size: 12px; }.stack { display: grid; gap: 2px; }.stack small, .muted-text { color: var(--ops-text-muted); font-size: 10px; }.target-price { color: var(--ops-primary); font-variant-numeric: tabular-nums; }.danger-text { color: var(--ops-danger); }.evidence { display: block; overflow: hidden; color: var(--ops-text-secondary); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.pagination-row { display: flex; align-items: center; justify-content: flex-end; gap: 10px; color: var(--ops-text-muted); font-size: 11px; }
.approval-box { padding: 14px; border: 1px solid var(--ops-border); border-radius: var(--ops-radius-sm); background: var(--ops-surface-muted); }.approval-fields { display: grid; grid-template-columns: minmax(180px, .6fr) minmax(300px, 1.4fr); gap: 10px; margin-top: 12px; }.inline-warning { display: flex; align-items: center; gap: 7px; margin-top: 10px; color: var(--ops-danger); font-size: 11px; }.approval-actions { justify-content: flex-end; gap: 8px; margin-top: 12px; }
.execution-panel { display: grid; gap: 15px; padding: 4px 2px; }.execution-head { justify-content: space-between; gap: 12px; }.execution-head > div { display: grid; gap: 4px; }.execution-head strong { font-size: 13px; }.execution-head span { color: var(--ops-text-muted); font-size: 11px; }.counter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-sm); overflow: hidden; }.counter-grid div { display: grid; gap: 4px; padding: 11px; border-right: 1px solid var(--ops-border-light); }.counter-grid span { color: var(--ops-text-muted); font-size: 10px; }.counter-grid strong { font-size: 17px; }
@media (max-width: 1260px) { .scope-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }.edit-row.link-row { grid-template-columns: 1fr 1fr; }.edit-row.link-row .el-button { justify-self: end; } }
@media (max-width: 900px) { .commandbar { align-items: flex-start; }.command-actions { flex-wrap: wrap; justify-content: flex-end; }.override-grid { grid-template-columns: 1fr; }.scope-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.approval-fields { grid-template-columns: 1fr; }.field.wide { grid-column: auto; } }
@media (max-width: 620px) { .commandbar, .preview-action, .shop-scope { display: grid; }.command-actions, .approval-actions { justify-content: stretch; }.command-actions .el-button, .approval-actions .el-button, .preview-action .el-button { width: 100%; margin-left: 0; }.scope-grid, .metric-grid { grid-template-columns: 1fr; }.edit-row, .edit-row.link-row { grid-template-columns: 1fr; }.gate-strip { align-items: flex-start; }.gate-strip > .el-tag { margin-left: auto; }.workbench { padding-inline: 9px; } }
</style>
