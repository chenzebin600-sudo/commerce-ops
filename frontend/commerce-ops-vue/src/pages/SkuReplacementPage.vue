<script setup lang="ts">
import { CheckCircle2, CircleAlert, Layers3, RefreshCw, ShieldCheck } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  createSkuReplacementBatchPlan,
  executeSkuReplacementBatch,
  getSkuReplacementBatchTask,
  previewSkuReplacementBatch,
  recoverSkuReplacementBatch,
  type SkuReplacementBatch,
  type SkuReplacementBatchTask,
  type SkuReplacementPlan,
} from "@/services/sku-replacement";
import {
  buildSkuReplacementSelections,
  executionStatusesFromTask,
  filterSkuReplacementPlans,
  replacementItemKey,
  replacementItemStatus,
  summarizeSkuSelections,
  toggleSkuSelection,
  type ReplacementFilters,
} from "@/services/sku-replacement-selection";

const MAX_ORDERS = 100;
const TASK_KEY = "commerce-ops-sku-replacement-task-id";
const orderInput = ref("");
const loading = ref(false);
const planning = ref(false);
const executing = ref(false);
const errorMessage = ref("");
const batch = ref<SkuReplacementBatch | null>(null);
const task = ref<SkuReplacementBatchTask | null>(null);
const selectedSkus = ref<Record<string,string>>({});
const filters = ref<ReplacementFilters>({ kind:"ALL",risk:"ALL",status:"ALL" });
let pollTimer: number | undefined;

const orderReferences = computed(() => [...new Set(orderInput.value.split(/[\s,，;；]+/)
  .map((value) => value.trim()).filter(Boolean))]);
const inputOverflow = computed(() => Math.max(0,orderReferences.value.length - MAX_ORDERS));
const executionStatuses = computed(() => executionStatusesFromTask(task.value));
const visiblePlans = computed(() => batch.value
  ? filterSkuReplacementPlans(batch.value.plans,filters.value,selectedSkus.value,executionStatuses.value) : []);
const selectionSummary = computed(() => batch.value
  ? summarizeSkuSelections(batch.value.plans,selectedSkus.value) : { selectedItems:0,selectedOrders:0 });
const taskFinished = computed(() => ["COMPLETED","COMPLETED_WITH_FAILURES"].includes(task.value?.status || ""));
const locked = computed(() => planning.value || executing.value || ["QUEUED","RUNNING"].includes(task.value?.status || ""));
const taskProgress = computed(() => task.value?.summary.total
  ? Math.round(task.value.summary.processed / task.value.summary.total * 100) : 0);

function shortageItems(plan: SkuReplacementPlan) {
  return plan.items.filter((item) => item.shortage > 0);
}

function statusFor(plan: SkuReplacementPlan,item: SkuReplacementPlan["items"][number]) {
  return replacementItemStatus(plan.order.platformOrderId,item,selectedSkus.value,executionStatuses.value);
}

function statusLabel(status: string) {
  return ({ UNSELECTED:"未选择",SELECTED:"已选择",NO_CANDIDATE:"无候选",RUNNING:"执行中",
    COMPLETED:"已完成",FAILED:"失败",MANUAL_REVIEW:"人工核对",NOT_EXECUTED:"未执行" } as Record<string,string>)[status] || status;
}

function choose(orderReference: string,itemId: string,replacementSku: string) {
  if (locked.value) return;
  const key = replacementItemKey(orderReference,itemId);
  selectedSkus.value = toggleSkuSelection(selectedSkus.value,key,replacementSku);
}

function schedulePoll(taskId: string) {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => void recoverTask(taskId,true),2000);
}

async function recoverTask(taskId: string,silent = false) {
  try {
    const current = await getSkuReplacementBatchTask(taskId);
    task.value = current;
    executing.value = ["QUEUED","RUNNING"].includes(current.status);
    errorMessage.value = "";
    if (executing.value) schedulePoll(taskId);
    else if (!silent) ElMessage.success("批量 SKU 更换任务已结束");
  } catch (error) {
    executing.value = true;
    errorMessage.value = "后台任务暂时无法读取，页面将自动重连。";
    schedulePoll(taskId);
    if (!silent) ElMessage.error(String((error as Error)?.message || "无法读取任务进度"));
  }
}

async function preview() {
  if (!orderReferences.value.length || inputOverflow.value) return;
  loading.value = true;
  errorMessage.value = "";
  batch.value = null;
  selectedSkus.value = {};
  filters.value = { kind:"ALL",risk:"ALL",status:"ALL" };
  try {
    batch.value = await previewSkuReplacementBatch(orderReferences.value);
  } catch (error) {
    try {
      batch.value = await recoverSkuReplacementBatch(orderReferences.value);
      ElMessage.warning("预览响应中断，已恢复后台完成的结果");
    } catch {
      errorMessage.value = String((error as Error)?.message || "SKU 替换建议生成失败");
    }
  } finally {
    loading.value = false;
  }
}

async function executeSelected() {
  if (!batch.value || locked.value) return;
  const selections = buildSkuReplacementSelections(batch.value.plans,selectedSkus.value);
  if (!selections.length) return ElMessage.warning("请先选择需要替换的 SKU");
  planning.value = true;
  try {
    const plan = await createSkuReplacementBatchPlan(selections);
    if (!plan.summary.executable) return ElMessage.error(plan.failures[0]?.message || "所选商品未通过执行前检查");
    const { value } = await ElMessageBox.prompt(
      `将串行更换 ${plan.summary.executable} 个商品行。每项写入后回读验证，单项失败不会阻断后续项目。`,
      "不可撤销：确认批量更换马帮 SKU",
      { type:"warning",confirmButtonText:`确认执行 ${plan.summary.executable} 项`,cancelButtonText:"取消",
        inputPlaceholder:plan.approvalText,inputValidator:(input) => input === plan.approvalText || `请输入完整确认文字：${plan.approvalText}` },
    );
    executing.value = true;
    task.value = await executeSkuReplacementBatch(plan.batchHash,value);
    sessionStorage.setItem(TASK_KEY,task.value.taskId);
    schedulePoll(task.value.taskId);
  } catch (error) {
    executing.value = false;
    if (error !== "cancel" && error !== "close") ElMessage.error(String((error as Error)?.message || "批量任务启动失败"));
  } finally {
    planning.value = false;
  }
}

function dismissTask() {
  if (executing.value) return;
  task.value = null;
  sessionStorage.removeItem(TASK_KEY);
}

onMounted(() => {
  const taskId = sessionStorage.getItem(TASK_KEY);
  if (taskId) void recoverTask(taskId,true);
});
onUnmounted(() => { if (pollTimer !== undefined) window.clearTimeout(pollTimer); });
</script>

<template>
  <main class="sku-page">
    <header class="sku-hero">
      <div><span>FULFILLMENT SAFETY</span><h1>缺货 SKU 替换</h1><p>批量检查订单缺货商品，只推荐同仓、同款且库存充足的候选。执行只修改马帮履约 SKU，不改变买家订单商品。</p></div>
      <div class="safety"><ShieldCheck :size="25" /><div><strong>写入前二次核验</strong><small>逐项执行 · 回读验证 · 失败隔离</small></div></div>
    </header>

    <section class="input-panel">
      <div class="section-title"><div><span>STEP 01</span><h2>输入待检查订单</h2></div><small>最多 {{ MAX_ORDERS }} 单，支持换行、逗号或空格分隔</small></div>
      <div class="input-row">
        <el-input v-model="orderInput" type="textarea" :rows="4" resize="vertical" placeholder="每行输入一个马帮订单号" :disabled="loading || locked" />
        <div class="input-actions"><div :class="['order-count',{ danger:inputOverflow }]">{{ orderReferences.length }}<span>/ {{ MAX_ORDERS }}</span></div>
          <el-button type="primary" size="large" :loading="loading" :disabled="!orderReferences.length || Boolean(inputOverflow) || locked" @click="preview"><RefreshCw :size="16" />生成替换建议</el-button></div>
      </div>
      <p v-if="inputOverflow" class="inline-error">超出 {{ inputOverflow }} 个订单，请缩减后重试。</p>
    </section>

    <el-alert v-if="errorMessage" type="warning" :closable="false" show-icon :title="errorMessage" />

    <section v-if="task" class="task-panel" aria-live="polite" :aria-busy="!taskFinished">
      <div><span v-if="!taskFinished" class="pulse"></span><CheckCircle2 v-else :size="20" /><div><strong>{{ taskFinished ? '批量任务已结束' : '正在串行执行批量更换' }}</strong><small>已处理 {{ task.summary.processed }} / {{ task.summary.total }} · 成功 {{ task.summary.completed }} · 待处理 {{ task.summary.failed + task.summary.manualReview + task.summary.notExecuted + task.summary.prevalidationFailed }}</small></div></div>
      <el-progress :percentage="taskProgress" :status="taskFinished ? (task.status === 'COMPLETED' ? 'success' : 'warning') : undefined" />
      <el-button v-if="taskFinished" size="small" @click="dismissTask">关闭结果</el-button>
    </section>

    <template v-if="batch">
      <section class="summary-panel">
        <div><span>已检查订单</span><strong>{{ batch.summary.inspected }}</strong></div><div><span>发现缺货商品</span><strong>{{ batch.summary.replaceableItems }}</strong></div><div><span>可选候选</span><strong>{{ batch.summary.candidateCount }}</strong></div><div><span>读取失败</span><strong>{{ batch.summary.failed }}</strong></div>
      </section>

      <section class="replacement-panel">
        <header><div><span>STEP 02</span><h2>选择替换 SKU</h2><p>换色与更小规格会显示更高风险；组合或分包商品必须人工核对。</p></div><strong>{{ visiblePlans.length }} 单</strong></header>
        <div class="filters">
          <el-select v-model="filters.kind" aria-label="替换类型"><el-option label="全部类型" value="ALL" /><el-option label="完全同款" value="SAME" /><el-option label="同款换色" value="COLOR" /><el-option label="更小规格" value="SMALLER" /><el-option label="更小规格并换色" value="SMALLER_COLOR" /></el-select>
          <el-select v-model="filters.risk" aria-label="风险等级"><el-option label="全部风险" value="ALL" /><el-option label="低风险" value="LOW" /><el-option label="中风险" value="MEDIUM" /><el-option label="高风险" value="HIGH" /></el-select>
          <el-select v-model="filters.status" aria-label="处理状态"><el-option label="全部状态" value="ALL" /><el-option label="未选择" value="UNSELECTED" /><el-option label="已选择" value="SELECTED" /><el-option label="无候选" value="NO_CANDIDATE" /><el-option label="执行中" value="RUNNING" /><el-option label="已完成" value="COMPLETED" /><el-option label="失败" value="FAILED" /><el-option label="人工核对" value="MANUAL_REVIEW" /></el-select>
        </div>
        <div v-if="!visiblePlans.length" class="empty"><Layers3 :size="22" />当前筛选下没有可显示的订单</div>
        <article v-for="plan in visiblePlans" :key="plan.order.platformOrderId" class="order-card">
          <header><div><strong>{{ plan.order.platformOrderId }}</strong><span>{{ plan.replaceableItemCount }} 个商品有候选 · {{ plan.unresolvedItemCount }} 个需人工处理</span></div><el-tag :type="plan.candidateCount ? 'warning' : 'info'" effect="plain">{{ plan.candidateCount ? '待复核' : '无候选' }}</el-tag></header>
          <div v-for="item in shortageItems(plan)" :key="item.itemId" class="shortage-row">
            <div class="original"><div><span>缺货 SKU</span><el-tag size="small" effect="plain">{{ statusLabel(statusFor(plan,item)) }}</el-tag></div><strong>{{ item.originalSku }}</strong><p>{{ item.chineseName || '未读取到中文名' }}</p><small>{{ item.currentWarehouse }} · 需要 {{ item.quantity }} / 可用 {{ item.available }}</small><em v-if="item.requiresBundleReview">组合/分包商品，禁止自动选择</em></div>
            <div v-if="item.candidates.length" class="candidates"><button v-for="candidate in item.candidates" :key="candidate.sku" type="button" :class="['candidate',candidate.riskLevel.toLowerCase(),{ selected:selectedSkus[replacementItemKey(plan.order.platformOrderId,item.itemId)] === candidate.sku }]" :disabled="locked || item.requiresBundleReview || ['COMPLETED','MANUAL_REVIEW','RUNNING'].includes(statusFor(plan,item))" @click="choose(plan.order.platformOrderId,item.itemId,candidate.sku)"><div><el-tag size="small" :type="candidate.riskLevel === 'LOW' ? 'success' : candidate.riskLevel === 'MEDIUM' ? 'warning' : 'danger'">{{ candidate.label }}</el-tag><span>可用 {{ candidate.available }}</span></div><strong>{{ candidate.sku }}</strong><p>{{ candidate.chineseName }}</p><small>{{ candidate.warehouse }}</small></button></div>
            <div v-else class="no-candidate"><CircleAlert :size="18" />当前仓没有库存充足的同款候选</div>
          </div>
        </article>
        <footer><div><ShieldCheck :size="18" />已选择 <strong>{{ selectionSummary.selectedItems }}</strong> 个商品，涉及 <strong>{{ selectionSummary.selectedOrders }}</strong> 个订单</div><el-button type="danger" size="large" :loading="planning || executing" :disabled="locked || !selectionSummary.selectedItems" @click="executeSelected">批量替换 {{ selectionSummary.selectedItems }} 个 SKU</el-button></footer>
      </section>
    </template>

    <section v-else-if="!loading && !task" class="empty-guide"><Layers3 :size="28" /><div><strong>等待订单检查</strong><span>输入订单号后，系统会读取订单商品与同仓库存，并生成可人工复核的替换候选。</span></div></section>
  </main>
</template>

<style scoped>
.sku-page{display:grid;gap:16px;max-width:1360px;margin:0 auto}.sku-hero{display:flex;justify-content:space-between;gap:28px;align-items:flex-end;padding:30px 32px;border-radius:18px;background:radial-gradient(circle at 85% 5%,rgba(66,144,122,.24),transparent 38%),#102b28;color:#f5fbf9;box-shadow:0 18px 45px rgba(13,52,46,.15)}.sku-hero>div:first-child{max-width:760px}.sku-hero span,.section-title span,.replacement-panel>header span{font-size:11px;letter-spacing:.13em;font-weight:700;color:#71ae9e}.sku-hero h1{margin:8px 0 10px;font-size:34px;letter-spacing:-.03em}.sku-hero p{margin:0;color:#bed6cf;line-height:1.7}.safety{display:flex;gap:11px;align-items:center;padding:14px 16px;border:1px solid rgba(173,220,207,.22);border-radius:12px;background:rgba(255,255,255,.055)}.safety div{display:grid;gap:3px}.safety small{color:#aac8c0}.input-panel,.replacement-panel{background:#fff;border:1px solid #e2e9e6;border-radius:14px;padding:22px;box-shadow:0 8px 24px rgba(28,60,54,.055)}.section-title,.replacement-panel>header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.section-title h2,.replacement-panel h2{margin:4px 0 0;font-size:20px}.section-title small{color:#7b8b86}.input-row{display:grid;grid-template-columns:minmax(0,1fr) 150px;gap:12px;margin-top:18px}.input-actions{display:grid;gap:10px}.input-actions :deep(.el-button){margin:0;white-space:normal}.order-count{display:flex;justify-content:center;align-items:baseline;padding:13px;border-radius:10px;background:#f1f5f3;font:700 28px/1 ui-monospace,monospace;color:#245f51}.order-count span{font-size:12px;color:#71817c}.order-count.danger,.inline-error{color:#b44646}.inline-error{margin:9px 0 0;font-size:12px}.task-panel{display:grid;grid-template-columns:minmax(260px,1fr) minmax(220px,.7fr) auto;gap:18px;align-items:center;padding:18px 20px;border:1px solid #b8d6cc;border-radius:13px;background:#f1f8f5}.task-panel>div{display:flex;gap:12px;align-items:center}.task-panel>div>div{display:grid;gap:4px}.task-panel small{color:#6f827b}.pulse{width:10px;height:10px;border-radius:50%;background:#347763;animation:pulse 1.6s ease-out infinite}.summary-panel{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.summary-panel div{display:grid;gap:5px;padding:17px;border:1px solid #e1e9e6;border-radius:12px;background:#fff}.summary-panel span{font-size:12px;color:#72827d}.summary-panel strong{font-size:25px;color:#245f51}.replacement-panel{display:grid;gap:16px}.replacement-panel>header p{margin:5px 0 0;color:#75847f}.replacement-panel>header>strong{font-size:25px;color:#286f5c}.filters{display:grid;grid-template-columns:repeat(3,minmax(0,220px));gap:10px;padding:13px;border-radius:10px;background:#f3f7f5}.order-card{display:grid;gap:14px;padding:18px;border:1px solid #dfe8e5;border-radius:13px}.order-card>header{display:flex;justify-content:space-between;gap:14px}.order-card>header div{display:grid;gap:3px}.order-card>header span{font-size:12px;color:#768680}.shortage-row{display:grid;grid-template-columns:minmax(210px,.35fr) 1fr;gap:16px;padding-top:14px;border-top:1px solid #edf1ef}.original{display:grid;align-content:start;gap:4px}.original>div{display:flex;justify-content:space-between;gap:8px}.original span,.original small{font-size:11px;color:#7a8984}.original p,.candidate p{margin:0;color:#566762}.original em{font-size:11px;color:#a04b42}.candidates{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:9px}.candidate{display:grid;gap:7px;padding:13px;text-align:left;border:1px solid #dce6e2;border-radius:10px;background:#fff;cursor:pointer}.candidate>div{display:flex;justify-content:space-between;align-items:center}.candidate span,.candidate small{font-size:11px;color:#75857f}.candidate.selected{border-color:#34816c;box-shadow:inset 0 0 0 1px #34816c;background:#f2f8f5}.candidate.medium{border-left:3px solid #d79b39}.candidate.high{border-left:3px solid #c96055}.candidate:disabled{cursor:not-allowed;opacity:.62}.no-candidate,.empty,.empty-guide{display:flex;gap:10px;align-items:center;color:#778680}.replacement-panel>footer{display:flex;justify-content:space-between;gap:18px;align-items:center;padding-top:16px;border-top:1px solid #e9efec}.replacement-panel>footer>div{display:flex;gap:8px;align-items:center}.empty{justify-content:center;padding:28px;border:1px dashed #ccd8d4;border-radius:11px}.empty-guide{justify-content:center;min-height:180px;padding:30px;border:1px dashed #ccd8d4;border-radius:14px}.empty-guide div{display:grid;gap:5px;max-width:620px}@keyframes pulse{70%,100%{box-shadow:0 0 0 9px rgba(52,119,99,0)}}@media(max-width:900px){.sku-hero{align-items:flex-start;flex-direction:column}.summary-panel{grid-template-columns:repeat(2,1fr)}.shortage-row{grid-template-columns:1fr}.task-panel{grid-template-columns:1fr}}@media(max-width:650px){.sku-hero{padding:24px}.sku-hero h1{font-size:27px}.input-row,.filters{grid-template-columns:1fr}.replacement-panel>footer,.section-title,.replacement-panel>header{align-items:flex-start;flex-direction:column}.summary-panel{grid-template-columns:1fr}}
</style>
