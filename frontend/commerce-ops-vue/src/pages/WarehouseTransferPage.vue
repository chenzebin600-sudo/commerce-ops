<script setup lang="ts">
import { ArrowRight, CheckCircle2, CircleAlert, Clock3, Layers3, ShieldCheck } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onUnmounted, ref } from "vue";
import { executeWarehouseTransferBatch, previewWarehouseTransferBatch, type WarehouseTransferBatch } from "@/services/warehouse-transfer";

const orderInput = ref("");
const approvalText = ref("");
const loading = ref(false);
const executing = ref(false);
const batch = ref<WarehouseTransferBatch | null>(null);
const completed = ref<WarehouseTransferBatch | null>(null);
const selectedHashes = ref<string[]>([]);
const executingCount = ref(0);
const elapsedSeconds = ref(0);
let elapsedTimer: number | undefined;
const orderReferences = computed(() => [...new Set(orderInput.value.split(/[\s,，;；]+/).map((value) => value.trim()).filter(Boolean))]);
const inputOverflow = computed(() => Math.max(0, orderReferences.value.length - 10));
const selectedCount = computed(() => selectedHashes.value.length);
const requiredApproval = computed(() => `确认批量换仓 ${selectedCount.value} 单`);
const confirmReady = computed(() => selectedCount.value > 0 && approvalText.value.trim() === requiredApproval.value);
const allSelected = computed(() => Boolean(batch.value?.plans.length) && selectedCount.value === batch.value?.plans.length);
const expiry = computed(() => batch.value ? new Date(batch.value.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—");
const elapsedLabel = computed(() => {
  const minutes = Math.floor(elapsedSeconds.value / 60);
  const seconds = elapsedSeconds.value % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒` : `${seconds} 秒`;
});

function startElapsedTimer() {
  executingCount.value = selectedCount.value;
  elapsedSeconds.value = 0;
  elapsedTimer = window.setInterval(() => { elapsedSeconds.value += 1; }, 1000);
}
function stopElapsedTimer() {
  if (elapsedTimer !== undefined) window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}
onUnmounted(stopElapsedTimer);

function currentWarehouses(plan: WarehouseTransferBatch["plans"][number]) {
  return [...new Set(plan.items.map((item) => item.currentWarehouse).filter(Boolean))].join(" / ") || "待确认";
}
function toggleAll(value: unknown) {
  selectedHashes.value = Boolean(value) ? (batch.value?.plans || []).map((plan) => plan.planHash) : [];
  approvalText.value = "";
}
function selectionChanged() { approvalText.value = ""; }

async function previewBatch() {
  if (!orderReferences.value.length) return ElMessage.warning("请输入至少一个订单号");
  if (inputOverflow.value) return ElMessage.warning("每批最多处理 10 个订单");
  loading.value = true; completed.value = null; batch.value = null;
  try {
    batch.value = await previewWarehouseTransferBatch(orderReferences.value);
    selectedHashes.value = batch.value.plans.map((plan) => plan.planHash);
    approvalText.value = "";
    if (batch.value.plans.length) ElMessage.success(`已生成 ${batch.value.plans.length} 单换仓计划，尚未修改马帮订单`);
    else ElMessage.warning("本批订单均未生成可执行计划");
  } catch (error) { ElMessage.error(String((error as Error)?.message || "批量换仓预览失败")); }
  finally { loading.value = false; }
}

async function executeBatch() {
  if (!batch.value || !confirmReady.value) return;
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
    completed.value = await executeWarehouseTransferBatch(batch.value.batchHash, selectedHashes.value, approvalText.value.trim());
    batch.value = null; selectedHashes.value = []; approvalText.value = "";
    const summary = completed.value.summary || { completed: 0, failed: 0 };
    summary.failed ? ElMessage.warning(`批量换仓完成：成功 ${summary.completed} 单，失败 ${summary.failed} 单`) : ElMessage.success(`批量换仓完成 ${summary.completed} 单`);
  } catch (error) { ElMessage.error(String((error as Error)?.message || "批量换仓执行失败，请先在马帮核对订单")); }
  finally { executing.value = false; stopElapsedTimer(); }
}
</script>

<template>
  <main class="warehouse-transfer-page">
    <section class="transfer-hero">
      <div class="hero-copy"><span class="eyebrow">BATCH ORDER ROUTING · SAFE CHANGE</span><h1>批量把缺货订单换到有货仓</h1><p>一次输入最多 10 个订单。系统为每单独立选择能满足整单 SKU 的仓库，预览后可勾选执行。</p></div>
      <div class="safety-seal"><ShieldCheck :size="22" /><div><strong>逐单安全门禁</strong><span>批量预览 · 串行写入 · 每单回读</span></div></div>
    </section>

    <section class="search-panel">
      <div class="step-number">01</div>
      <div class="panel-heading"><div><span>批量查找</span><h2>粘贴平台订单号</h2></div><small>每行一个，也支持空格、逗号分隔 · 最多 10 单</small></div>
      <div class="batch-input-row">
        <el-input v-model="orderInput" type="textarea" :rows="4" resize="vertical" :disabled="executing" placeholder="250808XXXXXXXX&#10;250808YYYYYYYY&#10;250808ZZZZZZZZ" />
        <div class="input-side">
          <div class="order-count" :class="{ danger: inputOverflow }"><strong>{{ orderReferences.length }}</strong><span>/ 10 单</span></div>
          <el-button type="primary" size="large" :loading="loading" :disabled="executing || !orderReferences.length || Boolean(inputOverflow)" @click="previewBatch">批量读取并规划</el-button>
        </div>
      </div>
      <p v-if="inputOverflow" class="inline-error">已超出 {{ inputOverflow }} 单，请拆分为多个批次。</p>
    </section>

    <section v-if="completed" class="result-panel" role="status">
      <header><div><CheckCircle2 :size="23" /><div><span>批次执行完成</span><strong>成功 {{ completed.summary?.completed || 0 }} 单 · 失败 {{ completed.summary?.failed || 0 }} 单</strong></div></div><small>{{ new Date(completed.executedAt || '').toLocaleString('zh-CN') }}</small></header>
      <div class="execution-results">
        <article v-for="item in completed.results" :key="item.planHash" :class="item.status.toLowerCase()"><div><CheckCircle2 v-if="item.status === 'COMPLETED'" :size="17" /><CircleAlert v-else :size="17" /><strong>{{ item.orderReference }}</strong></div><span>{{ item.status === 'COMPLETED' ? '换仓并回读成功' : item.message }}</span></article>
      </div>
    </section>

    <template v-if="batch">
      <section class="batch-summary">
        <div><span class="eyebrow">BATCH PREVIEW</span><h2>{{ batch.plans.length }} 单可执行，{{ batch.failures.length }} 单需处理</h2><small>批次计划在 {{ expiry }} 前有效，当前仍未写入马帮。</small></div>
        <el-checkbox :model-value="allSelected" :indeterminate="selectedCount > 0 && !allSelected" :disabled="executing" @change="toggleAll">全选可执行订单</el-checkbox>
      </section>

      <section class="plan-list" aria-label="批量换仓计划">
        <article v-for="(plan, index) in batch.plans" :key="plan.planHash" class="plan-row" :class="{ selected: selectedHashes.includes(plan.planHash) }">
          <el-checkbox v-model="selectedHashes" :value="plan.planHash" :disabled="executing" :aria-label="`选择订单 ${plan.order.platformOrderId}`" @change="selectionChanged" />
          <div class="plan-order"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ plan.order.platformOrderId }}</strong><small>{{ plan.items.length }} 个商品行 · {{ plan.stock.length }} 个 SKU</small></div></div>
          <div class="route-mini"><div><span>当前</span><strong>{{ currentWarehouses(plan) }}</strong></div><ArrowRight :size="18" /><div class="target"><span>目标</span><strong>{{ plan.targetWarehouse }}</strong></div></div>
          <div class="stock-proof"><span>库存核对</span><strong>{{ plan.stock.every(item => item.available >= item.quantity) ? '全部满足' : '库存变化' }}</strong><small>{{ plan.stock.map(item => `${item.sku} ${item.available}/${item.quantity}`).join(' · ') }}</small></div>
        </article>
        <article v-for="failure in batch.failures" :key="failure.orderReference" class="plan-row failed">
          <CircleAlert :size="18" /><div class="plan-order"><span>—</span><div><strong>{{ failure.orderReference }}</strong><small>未生成换仓计划</small></div></div><div class="failure-reason"><strong>{{ failure.message }}</strong><small>{{ failure.code }}</small></div>
        </article>
      </section>

      <section v-if="executing" class="execution-progress" role="status" aria-live="polite" aria-busy="true">
        <div class="progress-heading">
          <div><span class="progress-pulse" aria-hidden="true"></span><div><strong>正在依次执行 {{ executingCount }} 单换仓</strong><small>请保持页面打开，全部订单处理完后会自动显示逐单结果。</small></div></div>
          <span class="elapsed-time">已用时 {{ elapsedLabel }}</span>
        </div>
        <el-progress :percentage="100" :indeterminate="true" :duration="2" :show-text="false" />
      </section>

      <section class="confirm-panel" :class="{ executing }" :aria-busy="executing">
        <div class="step-number">03</div>
        <div class="confirm-copy"><Clock3 :size="20" /><div><strong>已选择 {{ selectedCount }} 单，确认后串行执行</strong><span>每单写入前都会重新读取库存和订单。部分失败时，其余已选择订单会继续执行并分别记录结果。</span><code>{{ requiredApproval }}</code></div></div>
        <div class="confirm-action"><el-input v-model="approvalText" :disabled="executing || !selectedCount" placeholder="输入上方确认文字" /><el-button type="primary" :disabled="executing || !confirmReady" :loading="executing" @click="executeBatch">{{ executing ? '正在执行' : `执行 ${selectedCount} 单换仓` }}</el-button></div>
      </section>
    </template>

    <section v-else-if="!completed" class="empty-guide"><Layers3 :size="26" /><div><strong>等待批量订单</strong><span>系统会去重订单号，并为每单独立规划目标仓。无法换仓的订单会保留在结果中说明原因，不影响其他订单预览。</span></div></section>
  </main>
</template>

<style scoped>
.warehouse-transfer-page{display:grid;gap:16px;max-width:1360px;margin:0 auto}.transfer-hero{display:flex;justify-content:space-between;gap:32px;align-items:flex-end;padding:30px 32px 34px;border-radius:18px;background:radial-gradient(circle at 86% 8%,rgba(33,102,89,.16),transparent 36%),#102b28;color:#f4fbf8;box-shadow:0 18px 45px rgba(13,52,46,.16)}.hero-copy{max-width:720px}.eyebrow{font-size:11px;letter-spacing:.14em;font-weight:700;color:#79b9a8}.hero-copy h1{margin:9px 0 10px;font-size:34px;line-height:1.15;letter-spacing:-.03em}.hero-copy p{margin:0;max-width:62ch;color:#bed6cf;line-height:1.7}.safety-seal{display:flex;gap:12px;align-items:center;padding:14px 16px;border:1px solid rgba(173,220,207,.2);border-radius:12px;background:rgba(255,255,255,.055)}.safety-seal div{display:grid;gap:3px}.safety-seal span{font-size:12px;color:#a9c7bf}.search-panel,.confirm-panel,.result-panel{position:relative;background:var(--surface,#fff);border:1px solid #e2e9e6;border-radius:14px;padding:22px;box-shadow:0 8px 24px rgba(28,60,54,.055)}.step-number{position:absolute;right:20px;top:16px;font:700 34px/1 ui-monospace,monospace;color:#e4ebe8}.panel-heading,.batch-summary{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.panel-heading span{font-size:12px;color:#6d7f79}.panel-heading h2,.batch-summary h2{margin:4px 0 0;font-size:20px}.panel-heading small,.batch-summary small{color:#80908b}.batch-input-row{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:12px;margin-top:18px}.input-side{display:flex;flex-direction:column;justify-content:space-between;gap:12px}.input-side :deep(.el-button){margin:0;width:100%;white-space:normal}.order-count{display:flex;align-items:baseline;justify-content:center;padding:13px;border-radius:10px;background:#f1f5f3;color:#54726a}.order-count strong{font:700 28px/1 ui-monospace,monospace;color:#245f51}.order-count.danger,.inline-error{color:#b44646}.order-count.danger strong{color:#b44646}.inline-error{margin:9px 0 0;font-size:12px}.batch-summary{align-items:center;padding:18px 20px;border-radius:13px;background:#eef5f2;border-left:4px solid #347763}.plan-list{display:grid;gap:9px}.plan-row{display:grid;grid-template-columns:auto minmax(210px,.8fr) minmax(300px,1.2fr) minmax(240px,1fr);gap:18px;align-items:center;padding:16px 18px;border:1px solid #e2e9e6;border-radius:12px;background:#fff;transition:border-color .2s,box-shadow .2s,transform .2s}.plan-row:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(28,60,54,.06)}.plan-row.selected{border-color:#89b7aa;box-shadow:inset 3px 0 #3c806d}.plan-order{display:flex;gap:12px;align-items:center}.plan-order>span{font:600 12px ui-monospace,monospace;color:#8b9995}.plan-order div,.route-mini div,.stock-proof,.failure-reason{display:grid;gap:3px}.plan-order strong{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px}.plan-order small,.route-mini span,.stock-proof span,.stock-proof small,.failure-reason small{font-size:11px;color:#84918d}.route-mini{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center}.route-mini strong{font-size:12px;color:#50645e}.route-mini .target strong{color:#216652}.stock-proof strong{font-size:12px;color:#28705e}.stock-proof small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.plan-row.failed{grid-template-columns:auto minmax(210px,.8fr) 1fr;color:#a14b4b;background:#fffafa;border-color:#eddada}.failure-reason strong{font-size:12px}.execution-progress{display:grid;gap:15px;padding:18px 20px;border:1px solid #b8d6cc;border-radius:13px;background:#f1f8f5;box-shadow:0 8px 24px rgba(28,60,54,.055)}.progress-heading,.progress-heading>div{display:flex;align-items:center;justify-content:space-between;gap:14px}.progress-heading>div>div{display:grid;gap:4px}.progress-heading small,.elapsed-time{font-size:12px;color:#6f827b}.elapsed-time{font-variant-numeric:tabular-nums;white-space:nowrap}.progress-pulse{width:10px;height:10px;border-radius:50%;background:#347763;box-shadow:0 0 0 0 rgba(52,119,99,.3);animation:progress-pulse 1.6s ease-out infinite}.execution-progress :deep(.el-progress-bar__outer){background:#dceae5}.execution-progress :deep(.el-progress-bar__inner){background:#347763}.confirm-panel{display:grid;grid-template-columns:1fr minmax(320px,440px);gap:24px;align-items:end;transition:opacity .2s}.confirm-panel.executing{opacity:.68}.confirm-copy{display:flex;gap:12px}.confirm-copy div{display:grid;gap:6px}.confirm-copy span{font-size:13px;color:#6f7f7a;line-height:1.5}.confirm-copy code{margin-top:4px;padding:9px 11px;border-radius:7px;background:#f3f6f5;color:#255f51}.confirm-action{display:grid;grid-template-columns:1fr auto;gap:9px}.result-panel header{display:flex;justify-content:space-between;gap:16px;align-items:center;padding-bottom:16px;border-bottom:1px solid #edf0ef}.result-panel header>div{display:flex;gap:10px;align-items:center;color:#286f5c}.result-panel header div div{display:grid;gap:3px}.result-panel header span,.result-panel header small{font-size:12px;color:#72847e}.execution-results{display:grid;gap:7px;margin-top:14px}.execution-results article{display:grid;grid-template-columns:minmax(180px,.4fr) 1fr;gap:14px;padding:11px 12px;border-radius:8px;background:#f1f7f4}.execution-results article>div{display:flex;gap:8px;align-items:center}.execution-results article>span{font-size:12px;color:#62736e}.execution-results article.failed{background:#fff2f2;color:#a14949}.empty-guide{display:flex;gap:13px;align-items:center;justify-content:center;min-height:180px;padding:28px;border:1px dashed #cfdad6;border-radius:14px;color:#75857f}.empty-guide div{display:grid;gap:5px;max-width:580px}.empty-guide span{font-size:13px;line-height:1.6}@keyframes progress-pulse{70%,100%{box-shadow:0 0 0 9px rgba(52,119,99,0)}}@media(max-width:980px){.plan-row{grid-template-columns:auto 1fr}.route-mini,.stock-proof,.failure-reason{grid-column:2}.confirm-panel{grid-template-columns:1fr}}@media(max-width:700px){.transfer-hero{align-items:flex-start;flex-direction:column;padding:24px}.hero-copy h1{font-size:27px}.safety-seal{width:100%;box-sizing:border-box}.panel-heading,.batch-summary{display:grid}.batch-input-row{grid-template-columns:1fr}.input-side{display:grid;grid-template-columns:100px 1fr}.progress-heading{align-items:flex-start;flex-direction:column}.confirm-action{grid-template-columns:1fr}.plan-row{gap:11px}.route-mini{grid-template-columns:1fr}.execution-results article{grid-template-columns:1fr}}
</style>
