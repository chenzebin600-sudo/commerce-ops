<script setup lang="ts">
import { ArrowRight, CheckCircle2, CircleAlert, RefreshCw, ShieldCheck, Warehouse } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  createWarehouseTransferBatchPlan,
  executeWarehouseTransferBatch,
  getWarehouseTransferBatchTask,
  type WarehouseTransferBatchPlan,
  type WarehouseTransferBatchTask,
} from "@/services/warehouse-transfer";

const MAX_ORDERS = 100;
const TASK_KEY = "commerce-ops-warehouse-transfer-task-id";
const orderInput = ref("");
const loading = ref(false);
const executing = ref(false);
const plan = ref<WarehouseTransferBatchPlan | null>(null);
const task = ref<WarehouseTransferBatchTask | null>(null);
const errorMessage = ref("");
let pollTimer: number | undefined;

const orderReferences = computed(() => [...new Set(orderInput.value.split(/[\s,，;；]+/).map((value) => value.trim()).filter(Boolean))]);
const overflow = computed(() => Math.max(0,orderReferences.value.length - MAX_ORDERS));
const taskFinished = computed(() => ["COMPLETED","COMPLETED_WITH_FAILURES"].includes(task.value?.status || ""));
const locked = computed(() => loading.value || executing.value || ["QUEUED","RUNNING"].includes(task.value?.status || ""));
const progress = computed(() => task.value?.summary.total ? Math.round(task.value.summary.processed / task.value.summary.total * 100) : 0);

const anomalyLabels: Record<string,string> = {
  pending_review:"待审核",out_of_stock:"缺货",multi_warehouse:"多仓异常",
};
const statusLabels: Record<string,string> = {
  PENDING:"等待",RUNNING:"执行中",COMPLETED:"已完成",FAILED:"失败",MANUAL_REVIEW:"人工核对",NOT_EXECUTED:"未执行",
};

function schedulePoll(taskId: string) {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => void recoverTask(taskId,true),2000);
}

async function recoverTask(taskId: string,silent = false) {
  try {
    const current = await getWarehouseTransferBatchTask(taskId);
    task.value = current;
    executing.value = ["QUEUED","RUNNING"].includes(current.status);
    errorMessage.value = "";
    if (executing.value) schedulePoll(taskId);
    else if (!silent) ElMessage.success("批量换仓任务已结束");
  } catch (error) {
    executing.value = true;
    errorMessage.value = "后台任务暂时无法读取，页面将自动重连。";
    schedulePoll(taskId);
    if (!silent) ElMessage.error(String((error as Error)?.message || "无法读取换仓进度"));
  }
}

async function preview() {
  if (!orderReferences.value.length || overflow.value || locked.value) return;
  loading.value = true;
  plan.value = null;
  errorMessage.value = "";
  try { plan.value = await createWarehouseTransferBatchPlan(orderReferences.value); }
  catch (error) { errorMessage.value = String((error as Error)?.message || "换仓计划生成失败"); }
  finally { loading.value = false; }
}

async function executePlan() {
  if (!plan.value?.summary.executable || locked.value) return;
  try {
    const { value } = await ElMessageBox.prompt(
      `系统将按库存自动选择目标仓，并串行处理 ${plan.value.summary.executable} 个订单。单个订单失败后会继续处理其余订单。`,
      "不可撤销：确认批量换仓",
      { type:"warning",confirmButtonText:`确认执行 ${plan.value.summary.executable} 单`,cancelButtonText:"取消",
        inputPlaceholder:plan.value.approvalText,inputValidator:(input) => input === plan.value?.approvalText || `请输入完整确认文字：${plan.value?.approvalText}` },
    );
    executing.value = true;
    task.value = await executeWarehouseTransferBatch(plan.value.batchHash,value);
    sessionStorage.setItem(TASK_KEY,task.value.taskId);
    schedulePoll(task.value.taskId);
  } catch (error) {
    executing.value = false;
    if (error !== "cancel" && error !== "close") ElMessage.error(String((error as Error)?.message || "批量换仓启动失败"));
  }
}

function dismissTask() {
  if (executing.value) return;
  task.value = null;
  sessionStorage.removeItem(TASK_KEY);
}

onMounted(() => { const taskId = sessionStorage.getItem(TASK_KEY); if (taskId) void recoverTask(taskId,true); });
onUnmounted(() => { if (pollTimer !== undefined) window.clearTimeout(pollTimer); });
</script>

<template>
  <main class="transfer-page">
    <header class="transfer-hero">
      <div><span>FULFILLMENT SAFETY</span><h1>异常订单自动换仓</h1><p>仅处理待审核、缺货或多仓异常订单。系统根据店铺允许仓与实时库存自动选定目标仓，不允许人工指定。</p></div>
      <div class="safety"><ShieldCheck :size="25" /><div><strong>独立真实写入开关</strong><small>计划校验 · 串行执行 · 回读确认</small></div></div>
    </header>

    <section class="panel input-panel">
      <div class="section-title"><div><span>STEP 01</span><h2>输入待换仓订单</h2></div><small>最多 {{ MAX_ORDERS }} 单，支持换行、逗号或空格分隔</small></div>
      <div class="input-row"><el-input v-model="orderInput" type="textarea" :rows="4" placeholder="每行输入一个马帮订单号" :disabled="locked" />
        <div class="input-actions"><div :class="['order-count',{ danger:overflow }]">{{ orderReferences.length }}<span>/ {{ MAX_ORDERS }}</span></div>
          <el-button type="primary" size="large" :loading="loading" :disabled="!orderReferences.length || Boolean(overflow) || locked" @click="preview"><RefreshCw :size="16" />自动选择目标仓</el-button></div></div>
      <p v-if="overflow" class="danger">超出 {{ overflow }} 个订单，请缩减后重试。</p>
    </section>

    <el-alert v-if="errorMessage" type="warning" :closable="false" show-icon :title="errorMessage" />

    <section v-if="task" class="task-panel" aria-live="polite">
      <div><CheckCircle2 :size="20" /><div><strong>{{ taskFinished ? '批量换仓已结束' : '正在串行执行换仓' }}</strong><small>已处理 {{ task.summary.processed }} / {{ task.summary.total }} · 成功 {{ task.summary.completed }} · 异常 {{ task.summary.failed + task.summary.manualReview + task.summary.notExecuted + task.summary.prevalidationFailed }}</small></div></div>
      <el-progress :percentage="progress" :status="taskFinished ? (task.status === 'COMPLETED' ? 'success' : 'warning') : undefined" />
      <el-button v-if="taskFinished" size="small" @click="dismissTask">关闭结果</el-button>
    </section>
    <section v-if="task?.items.length" class="panel sku-list">
      <div v-for="item in task.items" :key="item.orderReference">
        <strong>{{ item.orderReference }}</strong><span>{{ item.targetWarehouse }}</span>
        <el-tag :type="item.status === 'COMPLETED' ? 'success' : item.status === 'RUNNING' ? 'warning' : ['FAILED','MANUAL_REVIEW'].includes(item.status) ? 'danger' : 'info'" effect="plain">{{ statusLabels[item.status] || item.status }}</el-tag>
        <small v-if="item.message">{{ item.message }}</small>
      </div>
    </section>

    <template v-if="plan">
      <section class="summary"><div><span>输入订单</span><strong>{{ plan.summary.requested }}</strong></div><div><span>可执行</span><strong>{{ plan.summary.executable }}</strong></div><div><span>检查未通过</span><strong>{{ plan.summary.failed }}</strong></div></section>
      <section class="panel plans">
        <header><div><span>STEP 02</span><h2>复核系统选仓结果</h2><p>目标仓按所有商品共同可用、库存充足且执行后剩余库存最多的规则自动选定。</p></div></header>
        <article v-for="entry in plan.items" :key="entry.orderReference" class="order-card">
          <header><div><strong>{{ entry.plan.order.platformOrderId }}</strong><span>{{ entry.plan.order.orderStatus }}</span></div><div class="tags"><el-tag v-for="reason in entry.plan.order.anomalyReasons" :key="reason" type="warning" effect="plain">{{ anomalyLabels[reason] || reason }}</el-tag></div></header>
          <div class="warehouse-flow"><div><small>当前仓</small><strong>{{ [...new Set(entry.plan.items.map((item) => item.currentWarehouse))].join(' / ') }}</strong></div><ArrowRight :size="20" /><div class="target"><small>系统目标仓</small><strong>{{ entry.plan.targetWarehouse }}</strong></div></div>
          <div class="sku-list"><div v-for="item in entry.plan.items" :key="item.itemId"><span>{{ item.stockSku }}</span><small>{{ item.title || '未读取商品名' }} · 数量 {{ item.quantity }}</small></div></div>
        </article>
        <article v-for="failure in plan.failures" :key="failure.orderReference" class="failure"><CircleAlert :size="18" /><div><strong>{{ failure.orderReference }}</strong><span>{{ failure.message }}</span></div></article>
        <footer><div><Warehouse :size="18" />系统已为 <strong>{{ plan.summary.executable }}</strong> 单锁定换仓计划</div><el-button type="danger" size="large" :loading="executing" :disabled="locked || !plan.summary.executable" @click="executePlan">确认并批量换仓</el-button></footer>
      </section>
    </template>
  </main>
</template>

<style scoped>
.transfer-page{display:grid;gap:16px;max-width:1260px;margin:0 auto}.transfer-hero{display:flex;justify-content:space-between;gap:28px;align-items:flex-end;padding:30px 32px;border-radius:18px;background:radial-gradient(circle at 84% 4%,rgba(208,161,79,.26),transparent 38%),#263630;color:#f8fbfa;box-shadow:0 18px 45px rgba(19,46,37,.15)}.transfer-hero>div:first-child{max-width:760px}.transfer-hero span,.section-title span,.plans>header span{font-size:11px;letter-spacing:.13em;font-weight:700;color:#d8b16a}.transfer-hero h1{margin:8px 0 10px;font-size:34px}.transfer-hero p{margin:0;color:#c9d6d1;line-height:1.7}.safety{display:flex;gap:11px;align-items:center;padding:14px 16px;border:1px solid rgba(255,255,255,.18);border-radius:12px;background:rgba(255,255,255,.06)}.safety div{display:grid;gap:3px}.safety small{color:#bccac5}.panel{padding:22px;border:1px solid #e1e8e5;border-radius:14px;background:#fff;box-shadow:0 8px 24px rgba(28,60,54,.055)}.section-title,.plans>header{display:flex;justify-content:space-between;gap:16px}.section-title h2,.plans h2{margin:4px 0 0;font-size:20px}.section-title small,.plans p{color:#75847f}.input-row{display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:12px;margin-top:18px}.input-actions{display:grid;gap:10px}.input-actions :deep(.el-button){margin:0;white-space:normal}.order-count{display:flex;justify-content:center;align-items:baseline;padding:13px;border-radius:10px;background:#f1f5f3;font:700 28px/1 ui-monospace,monospace;color:#245f51}.order-count span{font-size:12px;color:#71817c}.danger{color:#b44646}.task-panel{display:grid;grid-template-columns:minmax(260px,1fr) minmax(220px,.7fr) auto;gap:18px;align-items:center;padding:18px 20px;border:1px solid #b8d6cc;border-radius:13px;background:#f1f8f5}.task-panel>div{display:flex;gap:12px;align-items:center}.task-panel>div>div{display:grid;gap:4px}.task-panel small{color:#6f827b}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.summary div{display:grid;gap:5px;padding:17px;border:1px solid #e1e9e6;border-radius:12px;background:#fff}.summary span{font-size:12px;color:#72827d}.summary strong{font-size:25px;color:#245f51}.plans{display:grid;gap:14px}.plans>header p{margin:5px 0 0}.order-card{display:grid;gap:14px;padding:18px;border:1px solid #dfe8e5;border-radius:13px}.order-card>header{display:flex;justify-content:space-between;gap:14px}.order-card>header>div:first-child{display:grid;gap:4px}.order-card>header span{font-size:12px;color:#75847f}.tags{display:flex;gap:6px;flex-wrap:wrap}.warehouse-flow{display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:center;padding:16px;border-radius:11px;background:#f4f7f5}.warehouse-flow div{display:grid;gap:5px}.warehouse-flow small{color:#73827d}.warehouse-flow .target{padding-left:14px;border-left:3px solid #c99743}.sku-list{display:grid;gap:6px}.sku-list div{display:flex;justify-content:space-between;gap:18px;padding:8px 0;border-top:1px solid #edf1ef}.sku-list small{color:#778680}.failure{display:flex;gap:10px;padding:14px;border:1px solid #ecd1cc;border-radius:11px;background:#fff7f5;color:#9d493e}.failure div{display:grid;gap:3px}.plans>footer{display:flex;justify-content:space-between;gap:18px;align-items:center;padding-top:16px;border-top:1px solid #e9efec}.plans>footer>div{display:flex;gap:8px;align-items:center}@media(max-width:800px){.transfer-hero{align-items:flex-start;flex-direction:column}.input-row,.task-panel{grid-template-columns:1fr}.summary{grid-template-columns:1fr}}@media(max-width:600px){.transfer-hero{padding:24px}.transfer-hero h1{font-size:27px}.plans>footer,.section-title,.plans>header{align-items:flex-start;flex-direction:column}.warehouse-flow{grid-template-columns:1fr}.sku-list div{align-items:flex-start;flex-direction:column}}
</style>
