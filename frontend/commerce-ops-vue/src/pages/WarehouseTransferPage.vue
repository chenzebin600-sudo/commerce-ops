<script setup lang="ts">
import { ArrowRight, CheckCircle2, CircleAlert, Clock3, Layers3, ShieldCheck } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { createSkuReplacementBatchPlan, executeSkuReplacementBatch, executeWarehouseTransferBatch, getSkuReplacementBatchTask, previewSkuReplacementBatch, previewWarehouseTransferBatch, probeFulfillmentHealth, recoverSkuReplacementBatch, recoverWarehouseTransferBatch,
  type SkuReplacementBatch, type SkuReplacementBatchTask, type SkuReplacementCandidate, type SkuReplacementPlan, type WarehouseTransferBatch } from "@/services/warehouse-transfer";
import { ApiError } from "@/services/api";
import { createFulfillmentConnectionRecovery } from "@/services/fulfillment-connection-recovery";
import { buildSkuReplacementSelections, executionStatusesFromTask, filterSkuReplacementPlans, replacementItemKey, replacementItemStatus,
  diagnosticRows, setSkuSelectionWarehouse, summarizeSkuSelections, taskItemFor, toggleSkuSelection,
  type ReplacementFilters, type SkuSelections } from "@/services/sku-replacement-selection";

const MAX_BATCH_ORDERS = 100;
const orderInput = ref("");
const approvalText = ref("");
const loading = ref(false);
const recovering = ref(false);
const previewError = ref("");
const previewErrorCode = ref("");
const executing = ref(false);
const batch = ref<WarehouseTransferBatch | null>(null);
const replacementBatch = ref<SkuReplacementBatch | null>(null);
const replacementError = ref("");
const replacementLoading = ref(false);
const selectedReplacementSkus = ref<SkuSelections>({});
const replacementFilters = ref<ReplacementFilters>({ kind:"ALL",risk:"ALL",status:"ALL" });
const replacementTask = ref<SkuReplacementBatchTask | null>(null);
const replacementPlanning = ref(false);
const replacementExecuting = ref(false);
const completed = ref<WarehouseTransferBatch | null>(null);
const selectedHashes = ref<string[]>([]);
const executingCount = ref(0);
const elapsedSeconds = ref(0);
const previewElapsedSeconds = ref(0);
const previewOrderReferences = ref<string[]>([]);
const nowMs = ref(Date.now());
let elapsedTimer: number | undefined;
let previewElapsedTimer: number | undefined;
let clockTimer: number | undefined;
let replacementPollTimer: number | undefined;
const fulfillmentRecovery = createFulfillmentConnectionRecovery({
  probe: probeFulfillmentHealth,
  onRecovered: () => {
    if (!["FULFILLMENT_UNAVAILABLE", "FULFILLMENT_TIMEOUT"].includes(previewErrorCode.value)) return;
    previewError.value = "";
    previewErrorCode.value = "";
    ElMessage.success("履约服务已恢复连接");
  },
});
const SKU_REPLACEMENT_TASK_KEY = "commerce-ops-sku-replacement-task-id";
const orderReferences = computed(() => [...new Set(orderInput.value.split(/[\s,，;；]+/).map((value) => value.trim()).filter(Boolean))]);
const inputOverflow = computed(() => Math.max(0, orderReferences.value.length - MAX_BATCH_ORDERS));
const selectedCount = computed(() => selectedHashes.value.length);
const requiredApproval = computed(() => `确认批量换仓 ${selectedCount.value} 单`);
const batchExpired = computed(() => Boolean(batch.value && nowMs.value >= Date.parse(batch.value.expiresAt)));
const confirmReady = computed(() => selectedCount.value > 0 && !batchExpired.value && approvalText.value.trim() === requiredApproval.value);
const allSelected = computed(() => Boolean(batch.value?.plans.length) && selectedCount.value === batch.value?.plans.length);
const expiry = computed(() => batch.value ? new Date(batch.value.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—");
const skuCandidateSummary = computed(() => replacementLoading.value ? "SKU 候选检查中" : replacementBatch.value
  ? `${replacementBatch.value.summary.ordersWithCandidates} 单有 SKU 候选` : "SKU 候选待第二步检查");
const replacementExecutionStatuses = computed(() => executionStatusesFromTask(replacementTask.value));
const filteredReplacementPlans = computed(() => replacementBatch.value
  ? filterSkuReplacementPlans(replacementBatch.value.plans, replacementFilters.value, selectedReplacementSkus.value, replacementExecutionStatuses.value) : []);
const replacementSelectionSummary = computed(() => replacementBatch.value
  ? summarizeSkuSelections(replacementBatch.value.plans, selectedReplacementSkus.value) : { selectedItems:0,selectedOrders:0 });
const replacementLocked = computed(() => replacementPlanning.value || replacementExecuting.value
  || ["QUEUED", "RUNNING"].includes(replacementTask.value?.status || ""));
const replacementTaskFinished = computed(() => ["COMPLETED", "COMPLETED_WITH_FAILURES"].includes(replacementTask.value?.status || ""));
function formatElapsed(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒` : `${seconds} 秒`;
}
const elapsedLabel = computed(() => formatElapsed(elapsedSeconds.value));
const previewElapsedLabel = computed(() => formatElapsed(previewElapsedSeconds.value));
const activeResolutionStep = computed(() => batch.value?.plans.length ? 1 : replacementLoading.value || replacementBatch.value ? 2 : 1);

function startPreviewTimer() {
  previewElapsedSeconds.value = 0;
  previewElapsedTimer = window.setInterval(() => { previewElapsedSeconds.value += 1; }, 1000);
}
function stopPreviewTimer() {
  if (previewElapsedTimer !== undefined) window.clearInterval(previewElapsedTimer);
  previewElapsedTimer = undefined;
}

function startElapsedTimer() {
  executingCount.value = selectedCount.value;
  elapsedSeconds.value = 0;
  elapsedTimer = window.setInterval(() => { elapsedSeconds.value += 1; }, 1000);
}
function stopElapsedTimer() {
  if (elapsedTimer !== undefined) window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}
onMounted(() => {
  clockTimer = window.setInterval(() => { nowMs.value = Date.now(); }, 1000);
  const taskId = sessionStorage.getItem(SKU_REPLACEMENT_TASK_KEY);
  if (taskId) void recoverReplacementTask(taskId, true);
});
onUnmounted(() => {
  stopElapsedTimer(); stopPreviewTimer();
  fulfillmentRecovery.stop();
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  if (replacementPollTimer !== undefined) window.clearTimeout(replacementPollTimer);
});

function currentWarehouses(plan: WarehouseTransferBatch["plans"][number]) {
  return [...new Set(plan.items.map((item) => item.currentWarehouse).filter(Boolean))].join(" / ") || "待确认";
}
function toggleAll(value: unknown) {
  selectedHashes.value = Boolean(value) ? (batch.value?.plans || []).map((plan) => plan.planHash) : [];
  approvalText.value = "";
}
function selectionChanged() { approvalText.value = ""; }
function shortageItems(plan: SkuReplacementPlan) { return plan.items.filter((item) => item.shortage > 0); }
function replacementPlan(orderReference: string) {
  return replacementBatch.value?.plans.find((plan) => plan.order.platformOrderId === orderReference);
}
function selectReplacement(orderReference: string, itemId: string, candidate: SkuReplacementCandidate) {
  if (replacementLocked.value) return;
  const key = replacementItemKey(orderReference, itemId);
  selectedReplacementSkus.value = toggleSkuSelection(selectedReplacementSkus.value, key, candidate);
  selectionChanged();
}
function selectReplacementWarehouse(orderReference: string, itemId: string, targetWarehouse: unknown) {
  if (replacementLocked.value) return;
  const key = replacementItemKey(orderReference, itemId);
  selectedReplacementSkus.value = setSkuSelectionWarehouse(selectedReplacementSkus.value, key, String(targetWarehouse || ""));
  selectionChanged();
}
function replacementWarehouseModeLabel(mode: SkuReplacementCandidate["warehouseMode"]) {
  return mode === "KEEP_CURRENT" ? "保持原仓" : "整单换仓";
}
function automaticWarehouseRemaining(candidate: SkuReplacementCandidate) {
  return candidate.warehouseAlternatives.find((alternative) => alternative.warehouse === candidate.targetWarehouse)?.remaining ?? 0;
}
function replacementStatus(plan: SkuReplacementPlan, item: SkuReplacementPlan["items"][number]) {
  return replacementItemStatus(plan.order.platformOrderId, item, selectedReplacementSkus.value, replacementExecutionStatuses.value);
}
function replacementTaskItem(orderReference: string, itemId: string) {
  return taskItemFor(orderReference, itemId, replacementTask.value);
}
function replacementStatusLabel(status: string) {
  return ({ UNSELECTED:"未选择",SELECTED:"已选择",NO_CANDIDATE:"无候选",RUNNING:"执行中",COMPLETED:"已完成",FAILED:"失败",MANUAL_REVIEW:"人工核对" } as Record<string,string>)[status] || status;
}
function dismissReplacementTask() {
  if (replacementExecuting.value) return;
  replacementTask.value = null;
  sessionStorage.removeItem(SKU_REPLACEMENT_TASK_KEY);
}
function scheduleReplacementPoll(taskId: string) {
  if (replacementPollTimer !== undefined) window.clearTimeout(replacementPollTimer);
  replacementPollTimer = window.setTimeout(() => { void recoverReplacementTask(taskId, true); }, 2000);
}
async function recoverReplacementTask(taskId: string, silent = false) {
  try {
    const task = await getSkuReplacementBatchTask(taskId);
    replacementError.value = "";
    replacementTask.value = task;
    replacementExecuting.value = ["QUEUED", "RUNNING"].includes(task.status);
    if (replacementExecuting.value) scheduleReplacementPoll(taskId);
    else if (!silent) {
      if (task.status === "COMPLETED") ElMessage.success(`批量 SKU 更换完成：成功 ${task.summary.completed} 项`);
      else ElMessage.warning(`批量 SKU 更换结束：成功 ${task.summary.completed} 项，需处理 ${task.summary.failed + task.summary.manualReview + task.summary.notExecuted + task.summary.prevalidationFailed} 项`);
    }
  } catch (error) {
    if (sessionStorage.getItem(SKU_REPLACEMENT_TASK_KEY) === taskId) {
      replacementExecuting.value = true;
      replacementError.value = "批量任务仍在后台运行，但当前暂时无法读取进度；页面会自动重连。";
      scheduleReplacementPoll(taskId);
    } else replacementExecuting.value = false;
    if (!silent) ElMessage.error(String((error as Error)?.message || "无法读取批量 SKU 更换进度"));
  }
}
async function executeSelectedReplacements() {
  if (!replacementBatch.value || replacementLocked.value) return;
  const selections = buildSkuReplacementSelections(replacementBatch.value.plans, selectedReplacementSkus.value);
  if (!selections.length) return ElMessage.warning("请先选择需要替换的 SKU");
  replacementPlanning.value = true;
  try {
    const plan = await createSkuReplacementBatchPlan(selections);
    if (!plan.summary.executable) {
      ElMessage.error(plan.failures[0]?.message || "所选商品均未通过执行前检查，请重新预览");
      return;
    }
    const { value } = await ElMessageBox.prompt(
      `将串行更换 ${plan.summary.executable} 个商品行，涉及 ${replacementSelectionSummary.value.selectedOrders} 个订单。每项最多会执行两次经校验的马帮操作（更换 SKU、必要时整单换仓），操作后都会回读验证；单项失败不会阻断后续项目。虾皮买家订单商品不会改变。`,
      "不可撤销：确认批量更换马帮 SKU",
      { confirmButtonText: `确认执行 ${plan.summary.executable} 项`, cancelButtonText: "取消", type: "warning", inputPlaceholder: plan.approvalText,
        inputValidator: (input) => input === plan.approvalText || `请输入完整确认文字：${plan.approvalText}` },
    );
    replacementExecuting.value = true;
    const task = await executeSkuReplacementBatch(plan.batchHash, value);
    replacementTask.value = task;
    sessionStorage.setItem(SKU_REPLACEMENT_TASK_KEY, task.taskId);
    scheduleReplacementPoll(task.taskId);
  } catch (error) {
    replacementExecuting.value = false;
    if (error !== "cancel" && error !== "close") ElMessage.error(String((error as Error)?.message || "批量 SKU 更换启动失败，请先在马帮核对订单"));
  } finally { replacementPlanning.value = false; }
}
async function loadReplacementSuggestionsForReferences(orderReferences: string[]) {
  replacementBatch.value = null; replacementError.value = "";
  selectedReplacementSkus.value = {};
  replacementFilters.value = { kind:"ALL",risk:"ALL",status:"ALL" };
  const references = [...new Set(orderReferences.map((reference) => reference.trim()).filter(Boolean))];
  if (!references.length) return;
  replacementLoading.value = true;
  try { replacementBatch.value = await previewSkuReplacementBatch(references); }
  catch (error) {
    try {
      replacementBatch.value = await recoverSkuReplacementBatch(references);
      ElMessage.warning("第二步响应中断，已恢复后台完成的 SKU 预览结果");
    } catch { replacementError.value = String((error as Error)?.message || "替换 SKU 建议生成失败"); }
  } finally { replacementLoading.value = false; }
}
async function focusReplacementPanel() {
  await nextTick();
  document.querySelector<HTMLElement>(".replacement-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function applyBatch(result: WarehouseTransferBatch) {
  batch.value = result;
  nowMs.value = Date.now();
  selectedHashes.value = nowMs.value < Date.parse(result.expiresAt) ? result.plans.map((plan) => plan.planHash) : [];
  approvalText.value = "";
  previewError.value = "";
  previewErrorCode.value = "";
  fulfillmentRecovery.stop();
}

async function recoverRecentBatch(silent = false) {
  if (!orderReferences.value.length || inputOverflow.value) return false;
  recovering.value = true;
  try {
    const result = await recoverWarehouseTransferBatch(orderReferences.value);
    applyBatch(result);
    completed.value = null;
    if (!silent) ElMessage.success("已恢复这批订单最近完成的预览结果");
    return true;
  } catch (error) {
    if (!silent) {
      previewError.value = String((error as Error)?.message || "没有找到可恢复的批次结果");
      previewErrorCode.value = error instanceof ApiError ? error.code : "";
    }
    return false;
  } finally { recovering.value = false; }
}

async function previewBatch() {
  if (replacementLocked.value) return ElMessage.warning("批量 SKU 更换仍在运行，请等待任务完成");
  if (!orderReferences.value.length) return ElMessage.warning("请输入至少一个订单号");
  if (inputOverflow.value) return ElMessage.warning(`每批最多处理 ${MAX_BATCH_ORDERS} 个订单`);
  previewOrderReferences.value = [...orderReferences.value];
  previewError.value = "";
  previewErrorCode.value = "";
  fulfillmentRecovery.stop();
  loading.value = true; completed.value = null; batch.value = null; replacementBatch.value = null; replacementError.value = "";
  dismissReplacementTask(); selectedReplacementSkus.value = {};
  startPreviewTimer();
  try {
    const result = await previewWarehouseTransferBatch(orderReferences.value);
    applyBatch(result);
    if (result.plans.length) ElMessage.success(`已生成 ${result.plans.length} 单换仓计划，尚未修改马帮订单`);
    else {
      ElMessage.warning("第一步无可换仓订单，已自动进入 SKU 替换预览");
      const secondStepReferences = result.failures.map((failure) => failure.orderReference);
      await loadReplacementSuggestionsForReferences(secondStepReferences.length ? secondStepReferences : orderReferences.value);
      await focusReplacementPanel();
    }
  } catch (error) {
    const message = String((error as Error)?.message || "批量换仓预览失败");
    if (await recoverRecentBatch(true)) ElMessage.warning("本次结果回传中断，已恢复最近完成的同批结果");
    else {
      previewError.value = message;
      previewErrorCode.value = error instanceof ApiError ? error.code : "";
      if (["FULFILLMENT_UNAVAILABLE", "FULFILLMENT_TIMEOUT"].includes(previewErrorCode.value)) fulfillmentRecovery.start();
      ElMessage.error(message);
    }
  }
  finally { loading.value = false; stopPreviewTimer(); }
}

async function executeBatch() {
  if (!batch.value) return;
  if (batchExpired.value) {
    ElMessage.error("本批预览已过期，请重新点击“智能规划缺货方案”");
    return;
  }
  if (!confirmReady.value) return;
  const sourceBatch = batch.value;
  try {
    await ElMessageBox.confirm(
      `将按列表顺序执行 ${selectedCount.value} 个订单。每单都会重新检查库存、SKU、数量与仓库权限；单笔失败不会继续重试该笔。是否继续？`,
      "确认批量写入马帮",
      { confirmButtonText: `确认执行 ${selectedCount.value} 单`, cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  executing.value = true;
  startElapsedTimer();
  try {
    completed.value = await executeWarehouseTransferBatch(sourceBatch.batchHash, selectedHashes.value, approvalText.value.trim());
    const secondStepReferences = [...sourceBatch.failures.map((failure) => failure.orderReference),
      ...(completed.value.results || []).filter((result) => result.status === "FAILED").map((result) => result.orderReference)];
    batch.value = null; selectedHashes.value = []; approvalText.value = "";
    await loadReplacementSuggestionsForReferences(secondStepReferences);
    const summary = completed.value.summary || { completed: 0, failed: 0 };
    if (secondStepReferences.length) {
      ElMessage.warning(`第一步完成：成功换仓 ${summary.completed} 单，其余订单已自动进入 SKU 替换预览`);
      await focusReplacementPanel();
    } else ElMessage.success(`批量换仓完成 ${summary.completed} 单`);
  } catch (error) { ElMessage.error(String((error as Error)?.message || "批量换仓执行失败，请先在马帮核对订单")); }
  finally { executing.value = false; stopElapsedTimer(); }
}
</script>

<template>
  <main class="warehouse-transfer-page">
    <section class="transfer-hero">
      <div class="hero-copy"><span class="eyebrow">OUT-OF-STOCK RESOLUTION · SAFE CHANGE</span><h1>缺货处理工作台</h1><p>先寻找能满足整单的有货仓；确实无法换仓时，再按当前仓库存推荐同款换色或更小规格 SKU。</p></div>
      <div class="safety-seal"><ShieldCheck :size="22" /><div><strong>风险分层处理</strong><span>换仓可执行 · 换 SKU 逐项确认</span></div></div>
    </section>

    <section class="resolution-ladder" aria-label="缺货处理优先级">
      <div class="ladder-title"><span>处理顺序</span><strong>系统优先选择对买家影响更小的方案</strong></div>
      <article :class="{ active: activeResolutionStep === 1, completed: activeResolutionStep > 1 }"><b>1</b><div><strong>整单换仓</strong><span>商品不变，可安全回读验证</span></div></article>
      <ArrowRight :size="17" />
      <article :class="{ active: activeResolutionStep === 2 }"><b>2</b><div><strong>替换 SKU</strong><span>同款换色 / 更小规格，需人工确认</span></div></article>
      <ArrowRight :size="17" />
      <article><b>3</b><div><strong>人工处理</strong><span>无可靠候选时不自动操作</span></div></article>
    </section>

    <el-alert v-if="previewError" class="preview-error" type="error" :closable="false" show-icon :title="previewError">
      <template #default><el-button :loading="recovering" size="small" @click="recoverRecentBatch()">恢复最近结果</el-button></template>
    </el-alert>

    <section class="search-panel">
      <div class="step-number">01</div>
      <div class="panel-heading"><div><span>批量查找</span><h2>粘贴平台订单号</h2></div><small>每行一个，也支持空格、逗号分隔 · 最多 {{ MAX_BATCH_ORDERS }} 单</small></div>
      <div class="batch-input-row">
        <el-input v-model="orderInput" type="textarea" :rows="4" resize="vertical" :disabled="loading || executing || replacementLocked" placeholder="250808XXXXXXXX&#10;250808YYYYYYYY&#10;250808ZZZZZZZZ" />
        <div class="input-side">
          <div class="order-count" :class="{ danger: inputOverflow }"><strong>{{ orderReferences.length }}</strong><span>/ {{ MAX_BATCH_ORDERS }} 单</span></div>
          <el-button type="primary" size="large" :loading="loading" :disabled="loading || executing || replacementLocked || !orderReferences.length || Boolean(inputOverflow)" @click="previewBatch">智能规划缺货方案</el-button>
        </div>
      </div>
      <p v-if="inputOverflow" class="inline-error">已超出 {{ inputOverflow }} 单，请拆分为多个批次。</p>
    </section>

    <section v-if="loading" class="preview-progress" role="status" aria-live="polite" aria-busy="true">
      <div class="progress-heading">
        <div><span class="progress-pulse" aria-hidden="true"></span><div><strong>正在读取并规划 {{ previewOrderReferences.length }} 单</strong><small>系统正在逐单读取马帮；全部完成后会在这里替换为可执行与失败结果。</small></div></div>
        <span class="elapsed-time">已用时 {{ previewElapsedLabel }}</span>
      </div>
      <el-progress :percentage="100" :indeterminate="true" :duration="2" :show-text="false" />
      <div class="preview-queue" aria-label="本批待读取订单">
        <article v-for="(reference, index) in previewOrderReferences" :key="reference">
          <span>{{ String(index + 1).padStart(2, '0') }}</span><strong>{{ reference }}</strong><small>已加入本批</small>
        </article>
      </div>
    </section>

    <section v-if="completed" class="result-panel" role="status">
      <header><div><CheckCircle2 :size="23" /><div><span>批次执行完成</span><strong>成功 {{ completed.summary?.completed || 0 }} 单 · 失败 {{ completed.summary?.failed || 0 }} 单</strong></div></div><small>{{ new Date(completed.executedAt || '').toLocaleString('zh-CN') }}</small></header>
      <div class="execution-results">
        <article v-for="item in completed.results" :key="item.planHash" :class="item.status.toLowerCase()"><div><CheckCircle2 v-if="item.status === 'COMPLETED'" :size="17" /><CircleAlert v-else :size="17" /><strong>{{ item.orderReference }}</strong></div><span>{{ item.status === 'COMPLETED' ? '换仓并回读成功' : item.message }}</span></article>
      </div>
    </section>

    <template v-if="batch">
      <section class="batch-summary">
        <div><span class="eyebrow">RESOLUTION PREVIEW</span><h2>{{ batch.plans.length }} 单可换仓，{{ skuCandidateSummary }}</h2><small>换仓计划在 {{ expiry }} 前有效；所有结果当前仍未写入马帮。</small></div>
        <el-checkbox :model-value="allSelected" :indeterminate="selectedCount > 0 && !allSelected" :disabled="executing || batchExpired" @change="toggleAll">全选可执行订单</el-checkbox>
      </section>

      <el-alert v-if="batchExpired && batch.plans.length" class="expired-alert" type="error" :closable="false" show-icon title="本批预览已过期，不能继续执行">
        <template #default><span>库存和订单状态可能已变化，请重新生成方案。</span><el-button type="danger" plain size="small" :loading="loading" @click="previewBatch">重新智能规划</el-button></template>
      </el-alert>

      <section class="plan-list" aria-label="批量换仓计划">
        <article v-for="(plan, index) in batch.plans" :key="plan.planHash" class="plan-row" :class="{ selected: selectedHashes.includes(plan.planHash) }">
          <el-checkbox v-model="selectedHashes" :value="plan.planHash" :disabled="executing || batchExpired" :aria-label="`选择订单 ${plan.order.platformOrderId}`" @change="selectionChanged" />
          <div class="plan-order"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ plan.order.platformOrderId }}</strong><small>{{ plan.items.length }} 个商品行 · {{ plan.stock.length }} 个 SKU</small></div></div>
          <div class="route-mini"><div><span>当前</span><strong>{{ currentWarehouses(plan) }}</strong></div><ArrowRight :size="18" /><div class="target"><span>目标</span><strong>{{ plan.targetWarehouse }}</strong></div></div>
          <div class="stock-proof"><span>库存核对</span><strong>{{ plan.stock.every(item => item.available >= item.quantity) ? '全部满足' : '库存变化' }}</strong><small>{{ plan.stock.map(item => `${item.sku} ${item.available}/${item.quantity}`).join(' · ') }}</small></div>
        </article>
        <article v-for="failure in batch.failures" :key="failure.orderReference" class="plan-row failed" :class="{ routed: replacementPlan(failure.orderReference)?.candidateCount }">
          <CircleAlert :size="18" /><div class="plan-order"><span>—</span><div><strong>{{ failure.orderReference }}</strong><small>{{ replacementPlan(failure.orderReference)?.candidateCount ? '已转入 SKU 替换建议' : '未生成换仓计划' }}</small></div></div><div class="failure-reason"><strong>{{ failure.message }}</strong><small>{{ failure.code }}</small></div>
        </article>
      </section>
    </template>

      <el-alert v-if="replacementError" type="warning" :closable="false" show-icon title="换仓结果可正常使用，但 SKU 替换建议读取失败">
        <template #default>{{ replacementError }}</template>
      </el-alert>

      <section v-if="replacementLoading" class="execution-progress replacement-progress" role="status" aria-live="polite" aria-busy="true">
        <div class="progress-heading"><div><span class="progress-pulse" aria-hidden="true"></span><div><strong>第一步已完成，正在批量生成第二步 SKU 预览</strong><small>剩余订单共用一次马帮登录会话；完成后自动显示候选，中断时会尝试恢复已落盘结果。</small></div></div></div>
        <el-progress :percentage="100" :indeterminate="true" :duration="2" :show-text="false" />
      </section>

      <section v-if="replacementTask && !replacementBatch" class="execution-progress" role="status" aria-live="polite" :aria-busy="!replacementTaskFinished">
        <div class="progress-heading"><div><span v-if="!replacementTaskFinished" class="progress-pulse" aria-hidden="true"></span><CheckCircle2 v-else :size="20" /><div><strong>{{ replacementTaskFinished ? '批量 SKU 更换已结束' : '已恢复后台批量 SKU 更换任务' }}</strong><small>已处理 {{ replacementTask.summary.processed }} / {{ replacementTask.summary.total }} 项 · 成功 {{ replacementTask.summary.completed }} · 失败/核对 {{ replacementTask.summary.failed + replacementTask.summary.manualReview + replacementTask.summary.notExecuted + replacementTask.summary.prevalidationFailed }}</small></div></div><el-button v-if="replacementTaskFinished" size="small" @click="dismissReplacementTask">关闭结果</el-button></div>
        <el-progress :percentage="replacementTask.summary.total ? Math.round(replacementTask.summary.processed / replacementTask.summary.total * 100) : 0" :status="replacementTaskFinished ? (replacementTask.status === 'COMPLETED' ? 'success' : 'warning') : undefined" />
      </section>

      <section v-if="replacementBatch" class="replacement-panel" aria-label="SKU 替换建议">
        <header>
          <div><span class="step-chip">02</span><div><span>第二层方案</span><h2>SKU 替换建议</h2><p>仅显示订单当前仓内库存足够的同款候选；换色和更小规格均标出风险等级。</p></div></div>
          <div class="replacement-stats"><strong>{{ replacementBatch.summary.candidateCount }}</strong><span>个候选 / {{ replacementBatch.summary.replaceableItems }} 个缺货商品</span></div>
        </header>
        <div class="replacement-filters" aria-label="SKU 候选分类筛选">
          <label><span>替换类型</span><el-select v-model="replacementFilters.kind" aria-label="按替换类型筛选">
            <el-option label="全部类型" value="ALL" /><el-option label="完全同款" value="SAME" /><el-option label="同款换色" value="COLOR" /><el-option label="更小规格" value="SMALLER" /><el-option label="更小规格并换色" value="SMALLER_COLOR" />
          </el-select></label>
          <label><span>风险等级</span><el-select v-model="replacementFilters.risk" aria-label="按风险等级筛选">
            <el-option label="全部风险" value="ALL" /><el-option label="低风险" value="LOW" /><el-option label="中风险" value="MEDIUM" /><el-option label="高风险" value="HIGH" />
          </el-select></label>
          <label><span>处理状态</span><el-select v-model="replacementFilters.status" aria-label="按处理状态筛选">
            <el-option label="全部状态" value="ALL" /><el-option label="未选择" value="UNSELECTED" /><el-option label="已选择" value="SELECTED" /><el-option label="无候选" value="NO_CANDIDATE" /><el-option label="执行中" value="RUNNING" /><el-option label="已完成" value="COMPLETED" /><el-option label="失败" value="FAILED" /><el-option label="人工核对" value="MANUAL_REVIEW" />
          </el-select></label>
          <div class="filter-result"><strong>{{ filteredReplacementPlans.length }}</strong><span>个订单符合当前筛选</span></div>
        </div>
        <div class="replacement-orders">
          <div v-if="replacementTask" class="replacement-task" role="status" aria-live="polite" :aria-busy="!replacementTaskFinished">
            <div><span class="progress-pulse" v-if="!replacementTaskFinished" aria-hidden="true"></span><CheckCircle2 v-else :size="17" /><div><strong>{{ replacementTaskFinished ? '批量更换已结束' : '正在串行执行批量更换' }}</strong><small>已处理 {{ replacementTask.summary.processed }} / {{ replacementTask.summary.total }} 项 · 成功 {{ replacementTask.summary.completed }} · 失败/核对 {{ replacementTask.summary.failed + replacementTask.summary.manualReview + replacementTask.summary.notExecuted }}</small></div></div>
            <el-progress :percentage="replacementTask.summary.total ? Math.round(replacementTask.summary.processed / replacementTask.summary.total * 100) : 0" :status="replacementTaskFinished ? (replacementTask.status === 'COMPLETED' ? 'success' : 'warning') : undefined" />
          </div>
          <div v-if="!filteredReplacementPlans.length" class="replacement-empty"><Layers3 :size="20" /><span>当前筛选下没有候选商品，已选择内容不会被清除。</span></div>
          <article v-for="plan in filteredReplacementPlans" :key="plan.order.platformOrderId" class="replacement-order">
            <div class="replacement-order-head"><div><strong>{{ plan.order.platformOrderId }}</strong><span>{{ plan.replaceableItemCount }} 个商品有候选 · {{ plan.unresolvedItemCount }} 个仍需人工处理</span></div><el-tag :type="plan.candidateCount ? 'warning' : 'info'" effect="plain">{{ plan.candidateCount ? '待复核' : '无候选' }}</el-tag></div>
            <div v-for="item in shortageItems(plan)" :key="item.itemId" class="shortage-item">
              <div class="original-sku"><div><span>缺货 SKU</span><el-tag size="small" effect="plain">{{ replacementStatusLabel(replacementStatus(plan, item)) }}</el-tag></div><strong>{{ item.originalSku }}</strong><p>{{ item.chineseName || '未读取到中文名' }}</p><small>{{ item.currentWarehouse }} · 需要 {{ item.quantity }} / 可用 {{ item.available }}</small><em v-if="item.requiresBundleReview">组合/分包商品，需核对整套关系</em>
                <div v-if="['FAILED','MANUAL_REVIEW'].includes(replacementStatus(plan, item))" class="sku-failure-detail" role="status">
                  <strong>{{ replacementTaskItem(plan.order.platformOrderId, item.itemId)?.code || 'SKU_REPLACEMENT_EXECUTE_FAILED' }}</strong>
                  <p>{{ replacementTaskItem(plan.order.platformOrderId, item.itemId)?.message || 'SKU 更换失败，请人工核对' }}</p>
                  <details v-if="diagnosticRows(replacementTaskItem(plan.order.platformOrderId, item.itemId)?.diagnostic).length" class="sku-diagnostic">
                    <summary>查看接口诊断</summary>
                    <dl><template v-for="row in diagnosticRows(replacementTaskItem(plan.order.platformOrderId, item.itemId)?.diagnostic)" :key="row.label">
                      <dt>{{ row.label }}</dt><dd>{{ row.value }}</dd>
                    </template></dl>
                  </details>
                </div>
              </div>
              <div v-if="item.candidates.length" class="candidate-area">
                <div class="candidate-list">
                <div v-for="candidate in item.candidates" :key="candidate.sku" class="candidate-option">
                  <button type="button" class="candidate-card" :class="[candidate.riskLevel.toLowerCase(), { selected: selectedReplacementSkus[replacementItemKey(plan.order.platformOrderId, item.itemId)]?.sku === candidate.sku }]"
                    :aria-pressed="selectedReplacementSkus[replacementItemKey(plan.order.platformOrderId, item.itemId)]?.sku === candidate.sku" :disabled="replacementLocked || item.requiresBundleReview || ['COMPLETED','MANUAL_REVIEW','RUNNING'].includes(replacementStatus(plan, item))"
                    @click="selectReplacement(plan.order.platformOrderId, item.itemId, candidate)">
                    <div><span class="candidate-tags"><el-tag size="small" :type="candidate.riskLevel === 'LOW' ? 'success' : candidate.riskLevel === 'MEDIUM' ? 'warning' : 'danger'" effect="light">{{ candidate.label }}</el-tag><el-tag size="small" :type="candidate.warehouseMode === 'KEEP_CURRENT' ? 'success' : 'warning'" effect="plain">{{ replacementWarehouseModeLabel(candidate.warehouseMode) }}</el-tag></span><span>可用 {{ candidate.available }}</span></div>
                    <strong>{{ candidate.sku }}</strong><p>{{ candidate.chineseName }}</p><small>自动仓 {{ candidate.targetWarehouse }} · 剩余 {{ automaticWarehouseRemaining(candidate) }}<template v-if="candidate.productStatus"> · {{ candidate.productStatus }}</template></small>
                  </button>
                  <label v-if="selectedReplacementSkus[replacementItemKey(plan.order.platformOrderId, item.itemId)]?.sku === candidate.sku" class="warehouse-selector">
                    <span>目标仓库</span>
                    <el-select :model-value="selectedReplacementSkus[replacementItemKey(plan.order.platformOrderId, item.itemId)]?.targetWarehouse" :disabled="replacementLocked" aria-label="选择目标仓库"
                      @change="selectReplacementWarehouse(plan.order.platformOrderId, item.itemId, $event)">
                      <el-option v-for="alternative in candidate.warehouseAlternatives" :key="alternative.warehouse" :value="alternative.warehouse"
                        :label="`${alternative.warehouse} · ${replacementWarehouseModeLabel(alternative.mode)} · 剩余 ${alternative.remaining}`" />
                    </el-select>
                  </label>
                </div>
                </div>
              </div>
              <div v-else class="no-candidate"><CircleAlert :size="17" /><span>当前仓没有符合“同款换色或更小规格”且库存足够的候选</span></div>
            </div>
          </article>
        </div>
        <footer class="replacement-batch-action"><div><ShieldCheck :size="18" /><span>已选择 <strong>{{ replacementSelectionSummary.selectedItems }}</strong> 个商品，涉及 <strong>{{ replacementSelectionSummary.selectedOrders }}</strong> 个订单。仅修改马帮履约 SKU，虾皮买家订单商品不变。</span></div><el-button type="danger" size="large" :loading="replacementPlanning || replacementExecuting" :disabled="replacementLocked || !replacementSelectionSummary.selectedItems" @click="executeSelectedReplacements">{{ replacementExecuting ? '正在批量执行' : `批量替换 ${replacementSelectionSummary.selectedItems} 个 SKU` }}</el-button></footer>
      </section>

      <section v-if="executing && batch" class="execution-progress" role="status" aria-live="polite" aria-busy="true">
        <div class="progress-heading">
          <div><span class="progress-pulse" aria-hidden="true"></span><div><strong>正在依次执行 {{ executingCount }} 单换仓</strong><small>请保持页面打开，全部订单处理完后会自动显示逐单结果。</small></div></div>
          <span class="elapsed-time">已用时 {{ elapsedLabel }}</span>
        </div>
        <el-progress :percentage="100" :indeterminate="true" :duration="2" :show-text="false" />
      </section>

      <section v-if="batch?.plans.length" class="confirm-panel" :class="{ executing }" :aria-busy="executing">
        <div class="step-number">03</div>
        <div class="confirm-copy"><Clock3 :size="20" /><div><strong>已选择 {{ selectedCount }} 单，确认后串行执行</strong><span>每单写入前都会重新读取库存和订单。部分失败时，其余已选择订单会继续执行并分别记录结果。</span><code>{{ requiredApproval }}</code></div></div>
        <div class="confirm-action"><el-input v-model="approvalText" :disabled="executing || batchExpired || !selectedCount" placeholder="输入上方确认文字" /><el-button type="primary" :disabled="executing || batchExpired || !confirmReady" :loading="executing" @click="executeBatch">{{ batchExpired ? '预览已过期' : executing ? '正在执行' : `执行 ${selectedCount} 单换仓` }}</el-button></div>
      </section>
    <section v-if="!batch && !completed && !loading && !replacementBatch && !replacementTask" class="empty-guide"><Layers3 :size="26" /><div><strong>等待批量订单</strong><span>系统会去重订单号，并为每单独立规划目标仓。无法换仓的订单会保留在结果中说明原因，不影响其他订单预览。</span><el-button v-if="orderReferences.length" :loading="recovering" size="small" @click="recoverRecentBatch()">恢复最近结果</el-button></div></section>
  </main>
</template>

<style scoped>
.warehouse-transfer-page{display:grid;gap:16px;max-width:1360px;margin:0 auto}.transfer-hero{display:flex;justify-content:space-between;gap:32px;align-items:flex-end;padding:30px 32px 34px;border-radius:18px;background:radial-gradient(circle at 86% 8%,rgba(33,102,89,.16),transparent 36%),#102b28;color:#f4fbf8;box-shadow:0 18px 45px rgba(13,52,46,.16)}.hero-copy{max-width:720px}.eyebrow{font-size:11px;letter-spacing:.14em;font-weight:700;color:#79b9a8}.hero-copy h1{margin:9px 0 10px;font-size:34px;line-height:1.15;letter-spacing:-.03em}.hero-copy p{margin:0;max-width:62ch;color:#bed6cf;line-height:1.7}.safety-seal{display:flex;gap:12px;align-items:center;padding:14px 16px;border:1px solid rgba(173,220,207,.2);border-radius:12px;background:rgba(255,255,255,.055)}.safety-seal div{display:grid;gap:3px}.safety-seal span{font-size:12px;color:#a9c7bf}.search-panel,.confirm-panel,.result-panel{position:relative;background:var(--surface,#fff);border:1px solid #e2e9e6;border-radius:14px;padding:22px;box-shadow:0 8px 24px rgba(28,60,54,.055)}.step-number{position:absolute;right:20px;top:16px;font:700 34px/1 ui-monospace,monospace;color:#e4ebe8}.panel-heading,.batch-summary{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.panel-heading span{font-size:12px;color:#6d7f79}.panel-heading h2,.batch-summary h2{margin:4px 0 0;font-size:20px}.panel-heading small,.batch-summary small{color:#80908b}.batch-input-row{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:12px;margin-top:18px}.input-side{display:flex;flex-direction:column;justify-content:space-between;gap:12px}.input-side :deep(.el-button){margin:0;width:100%;white-space:normal}.order-count{display:flex;align-items:baseline;justify-content:center;padding:13px;border-radius:10px;background:#f1f5f3;color:#54726a}.order-count strong{font:700 28px/1 ui-monospace,monospace;color:#245f51}.order-count.danger,.inline-error{color:#b44646}.order-count.danger strong{color:#b44646}.inline-error{margin:9px 0 0;font-size:12px}.batch-summary{align-items:center;padding:18px 20px;border-radius:13px;background:#eef5f2;border-left:4px solid #347763}.plan-list{display:grid;gap:9px}.plan-row{display:grid;grid-template-columns:auto minmax(210px,.8fr) minmax(300px,1.2fr) minmax(240px,1fr);gap:18px;align-items:center;padding:16px 18px;border:1px solid #e2e9e6;border-radius:12px;background:#fff;transition:border-color .2s,box-shadow .2s,transform .2s}.plan-row:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(28,60,54,.06)}.plan-row.selected{border-color:#89b7aa;box-shadow:inset 3px 0 #3c806d}.plan-order{display:flex;gap:12px;align-items:center}.plan-order>span{font:600 12px ui-monospace,monospace;color:#8b9995}.plan-order div,.route-mini div,.stock-proof,.failure-reason{display:grid;gap:3px}.plan-order strong{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px}.plan-order small,.route-mini span,.stock-proof span,.stock-proof small,.failure-reason small{font-size:11px;color:#84918d}.route-mini{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center}.route-mini strong{font-size:12px;color:#50645e}.route-mini .target strong{color:#216652}.stock-proof strong{font-size:12px;color:#28705e}.stock-proof small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.plan-row.failed{grid-template-columns:auto minmax(210px,.8fr) 1fr;color:#a14b4b;background:#fffafa;border-color:#eddada}.failure-reason strong{font-size:12px}.execution-progress{display:grid;gap:15px;padding:18px 20px;border:1px solid #b8d6cc;border-radius:13px;background:#f1f8f5;box-shadow:0 8px 24px rgba(28,60,54,.055)}.progress-heading,.progress-heading>div{display:flex;align-items:center;justify-content:space-between;gap:14px}.progress-heading>div>div{display:grid;gap:4px}.progress-heading small,.elapsed-time{font-size:12px;color:#6f827b}.elapsed-time{font-variant-numeric:tabular-nums;white-space:nowrap}.progress-pulse{width:10px;height:10px;border-radius:50%;background:#347763;box-shadow:0 0 0 0 rgba(52,119,99,.3);animation:progress-pulse 1.6s ease-out infinite}.execution-progress :deep(.el-progress-bar__outer){background:#dceae5}.execution-progress :deep(.el-progress-bar__inner){background:#347763}.confirm-panel{display:grid;grid-template-columns:1fr minmax(320px,440px);gap:24px;align-items:end;transition:opacity .2s}.confirm-panel.executing{opacity:.68}.confirm-copy{display:flex;gap:12px}.confirm-copy div{display:grid;gap:6px}.confirm-copy span{font-size:13px;color:#6f7f7a;line-height:1.5}.confirm-copy code{margin-top:4px;padding:9px 11px;border-radius:7px;background:#f3f6f5;color:#255f51}.confirm-action{display:grid;grid-template-columns:1fr auto;gap:9px}.result-panel header{display:flex;justify-content:space-between;gap:16px;align-items:center;padding-bottom:16px;border-bottom:1px solid #edf0ef}.result-panel header>div{display:flex;gap:10px;align-items:center;color:#286f5c}.result-panel header div div{display:grid;gap:3px}.result-panel header span,.result-panel header small{font-size:12px;color:#72847e}.execution-results{display:grid;gap:7px;margin-top:14px}.execution-results article{display:grid;grid-template-columns:minmax(180px,.4fr) 1fr;gap:14px;padding:11px 12px;border-radius:8px;background:#f1f7f4}.execution-results article>div{display:flex;gap:8px;align-items:center}.execution-results article>span{font-size:12px;color:#62736e}.execution-results article.failed{background:#fff2f2;color:#a14949}.empty-guide{display:flex;gap:13px;align-items:center;justify-content:center;min-height:180px;padding:28px;border:1px dashed #cfdad6;border-radius:14px;color:#75857f}.empty-guide div{display:grid;gap:5px;max-width:580px}.empty-guide span{font-size:13px;line-height:1.6}@keyframes progress-pulse{70%,100%{box-shadow:0 0 0 9px rgba(52,119,99,0)}}@media(max-width:980px){.plan-row{grid-template-columns:auto 1fr}.route-mini,.stock-proof,.failure-reason{grid-column:2}.confirm-panel{grid-template-columns:1fr}}@media(max-width:700px){.transfer-hero{align-items:flex-start;flex-direction:column;padding:24px}.hero-copy h1{font-size:27px}.safety-seal{width:100%;box-sizing:border-box}.panel-heading,.batch-summary{display:grid}.batch-input-row{grid-template-columns:1fr}.input-side{display:grid;grid-template-columns:100px 1fr}.progress-heading{align-items:flex-start;flex-direction:column}.confirm-action{grid-template-columns:1fr}.plan-row{gap:11px}.route-mini{grid-template-columns:1fr}.execution-results article{grid-template-columns:1fr}}
.preview-progress{display:grid;gap:15px;padding:18px 20px;border:1px solid #b8d6cc;border-radius:13px;background:#f1f8f5;box-shadow:0 8px 24px rgba(28,60,54,.055)}
.expired-alert :deep(.el-alert__content){width:100%}.expired-alert :deep(.el-alert__description){display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%}.expired-alert :deep(.el-button){flex:none;margin-left:auto}
.order-count{gap:2px}.order-count span{white-space:nowrap}
.preview-progress :deep(.el-progress-bar__outer){background:#dceae5}.preview-progress :deep(.el-progress-bar__inner){background:#347763}
.preview-queue{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:7px;max-height:360px;overflow:auto;padding:2px}
.preview-queue article{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px 11px;border:1px solid #dce9e4;border-radius:8px;background:rgba(255,255,255,.72)}
.preview-queue article>span{color:#91a19c;font:600 11px ui-monospace,monospace}.preview-queue article strong{overflow:hidden;font:600 12px ui-monospace,SFMono-Regular,monospace;text-overflow:ellipsis;white-space:nowrap}.preview-queue article small{color:#6f827b;font-size:11px}
.resolution-ladder{display:grid;grid-template-columns:minmax(230px,1fr) minmax(180px,.72fr) auto minmax(210px,.82fr) auto minmax(180px,.72fr);gap:12px;align-items:center;padding:15px 18px;border:1px solid #dfe7e4;border-radius:13px;background:#fff}.ladder-title{display:grid;gap:3px}.ladder-title span,.resolution-ladder article span{font-size:11px;color:#82918c}.resolution-ladder article{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:#f5f7f6}.resolution-ladder article.active{background:#eaf4f0;color:#216652}.resolution-ladder article.completed{color:#44736a;background:#f0f6f4}.resolution-ladder article.completed b{color:#fff;background:#4e8b7b}.resolution-ladder article b{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#fff;font:700 11px ui-monospace,monospace}.resolution-ladder article div{display:grid;gap:2px}.resolution-ladder article strong{font-size:12px}.resolution-ladder>svg{color:#9aa9a4}
.plan-row.failed.routed{color:#895c21;background:#fffaf0;border-color:#ead9b7}.replacement-panel{display:grid;gap:18px;padding:22px;border:1px solid #eadcbf;border-radius:14px;background:#fffdf8;box-shadow:0 8px 24px rgba(82,61,20,.05)}.replacement-panel>header,.replacement-panel>header>div,.replacement-order-head,.replacement-panel>footer,.replacement-panel>footer>div{display:flex;align-items:center;justify-content:space-between;gap:14px}.replacement-panel>header>div>div{display:grid;gap:3px}.replacement-panel h2{margin:0;font-size:20px}.replacement-panel header p{margin:2px 0 0;color:#7d7a70;font-size:12px}.replacement-panel header span{font-size:11px;color:#8d826c}.step-chip{display:grid!important;place-items:center;width:36px;height:36px;border-radius:10px;background:#f2e7ce;color:#7f5a19!important;font:700 13px ui-monospace,monospace!important}.replacement-stats{display:grid!important;justify-items:end;white-space:nowrap}.replacement-stats strong{font:700 24px ui-monospace,monospace;color:#805d20}.replacement-filters{display:grid;grid-template-columns:repeat(3,minmax(150px,220px)) 1fr;gap:10px;align-items:end;padding:13px;border:1px solid #e9e1d2;border-radius:11px;background:#faf7f0}.replacement-filters label{display:grid;gap:6px}.replacement-filters label>span,.filter-result span{font-size:11px;color:#847b6b}.filter-result{display:grid;justify-items:end;gap:2px}.filter-result strong{font:700 18px ui-monospace,monospace;color:#705324}.replacement-orders{display:grid;gap:12px}.replacement-order{overflow:hidden;border:1px solid #e8e2d5;border-radius:12px;background:#fff}.replacement-order-head{padding:13px 15px;border-bottom:1px solid #eee8dc;background:#faf7f0}.replacement-order-head>div{display:grid;gap:3px}.replacement-order-head strong{font:700 13px ui-monospace,SFMono-Regular,monospace}.replacement-order-head span{font-size:11px;color:#857e70}.shortage-item{display:grid;grid-template-columns:minmax(210px,.7fr) minmax(0,2fr);gap:18px;padding:15px}.shortage-item+.shortage-item{border-top:1px solid #f0ece4}.original-sku{display:grid;align-content:start;gap:4px}.original-sku>div{display:flex;align-items:center;justify-content:space-between;gap:8px}.original-sku>div>span{font-size:10px;letter-spacing:.08em;color:#a05d52}.original-sku strong,.candidate-card>strong{font:700 12px ui-monospace,SFMono-Regular,monospace}.original-sku p,.candidate-card p{margin:0;color:#5f625f;font-size:12px;line-height:1.45}.original-sku small,.candidate-card small{font-size:11px;color:#8b8f8b}.original-sku em{margin-top:3px;color:#a76a2b;font-size:11px;font-style:normal}.candidate-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}.candidate-card{display:grid;gap:5px;padding:11px 12px;border:1px solid #e4e7e4;border-left:3px solid #58917f;border-radius:9px;background:#fbfcfb}.candidate-card.medium{border-left-color:#d29b42}.candidate-card.high{border-left-color:#cf7565}.candidate-card>div{display:flex;justify-content:space-between;gap:8px;align-items:center}.candidate-card>div>span{font-size:10px;color:#778079}.no-candidate,.replacement-empty{display:flex;gap:8px;align-items:center;min-height:70px;padding:12px;border-radius:9px;background:#f7f4ef;color:#8b7961;font-size:12px}.replacement-empty{justify-content:center;border:1px dashed #ddd2bf}.replacement-task{display:grid;gap:10px;padding:13px 14px;border:1px solid #c7ddd5;border-radius:10px;background:#f1f8f5}.replacement-task>div{display:flex;align-items:center;gap:10px}.replacement-task>div>div{display:grid;gap:3px}.replacement-task small{font-size:11px;color:#657b73}.replacement-panel>footer{padding-top:13px;border-top:1px solid #ebe2d3}.replacement-panel>footer>div{justify-content:flex-start;max-width:900px;color:#7b6d54}.replacement-panel>footer span{font-size:12px;line-height:1.5}.replacement-batch-action{position:sticky;bottom:12px;z-index:3;padding:13px 14px!important;border:1px solid #dfd0b4!important;border-radius:11px;background:rgba(255,253,248,.96);box-shadow:0 10px 28px rgba(82,61,20,.12);backdrop-filter:blur(8px)}.replacement-batch-action :deep(.el-button){flex:none;min-height:44px;margin:0}
.candidate-area{display:grid;gap:9px}.candidate-option{display:grid;align-content:start;gap:8px}.candidate-card{width:100%;min-height:44px;text-align:left;font:inherit;color:inherit;cursor:pointer;transition:border-color .16s,box-shadow .16s,transform .16s}.candidate-card:hover:not(:disabled){transform:translateY(-1px);border-color:#91b8ac}.candidate-card:focus-visible{outline:3px solid rgba(52,119,99,.24);outline-offset:2px}.candidate-card.selected{border-color:#347763;box-shadow:0 0 0 2px rgba(52,119,99,.15);background:#f2f8f5}.candidate-card:disabled{cursor:not-allowed;opacity:.6}.candidate-tags{display:flex;flex-wrap:wrap;gap:5px}.warehouse-selector{display:grid;gap:5px;padding:8px 10px;border:1px solid #cfe0d9;border-radius:8px;background:#f3f8f6}.warehouse-selector>span{font-size:10px;color:#60766e}.warehouse-selector :deep(.el-select){width:100%}
.sku-failure-detail{display:grid;gap:5px;margin-top:8px;padding:10px;border:1px solid #efd8d3;border-radius:8px;background:#fff6f4}.sku-failure-detail>strong{overflow-wrap:anywhere;color:#9b443c;font-size:11px}.sku-failure-detail>p{color:#744f4a;font-size:11px}.sku-diagnostic{border-top:1px solid #efdeda;padding-top:6px}.sku-diagnostic summary{min-height:44px;display:flex;align-items:center;color:#714a43;font-size:12px;font-weight:600;cursor:pointer}.sku-diagnostic summary:focus-visible{outline:3px solid rgba(155,68,60,.2);outline-offset:2px;border-radius:4px}.sku-diagnostic dl{display:grid;grid-template-columns:minmax(74px,auto) minmax(0,1fr);gap:5px 10px;margin:2px 0 4px}.sku-diagnostic dt{color:#8b6a65;font-size:11px}.sku-diagnostic dd{margin:0;overflow-wrap:anywhere;color:#4f4745;font:11px/1.55 ui-monospace,SFMono-Regular,monospace}
@media(max-width:1100px){.resolution-ladder{grid-template-columns:1fr 1fr 1fr}.ladder-title{grid-column:1/-1}.resolution-ladder>svg{display:none}.shortage-item{grid-template-columns:1fr}.replacement-filters{grid-template-columns:repeat(3,1fr)}.filter-result{grid-column:1/-1;justify-items:start}}
@media(max-width:700px){.resolution-ladder{grid-template-columns:1fr}.replacement-panel>header,.replacement-panel>footer{align-items:flex-start;flex-direction:column}.replacement-stats{justify-items:start}.candidate-list,.replacement-filters{grid-template-columns:1fr}.filter-result{grid-column:auto}.replacement-batch-action :deep(.el-button){width:100%}}
@media(max-width:700px){.expired-alert :deep(.el-alert__description){align-items:flex-start;flex-direction:column}.expired-alert :deep(.el-button){width:100%;min-height:44px;margin:0}}
</style>
