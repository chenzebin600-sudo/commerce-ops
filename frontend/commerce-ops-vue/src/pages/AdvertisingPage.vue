<script setup lang="ts">
import { AlertCircle, CheckCircle2, Clock3, Database, FileSpreadsheet, Info, RefreshCw, Settings2, ShieldCheck, Trash2, Upload } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import {
  deleteShopeeAdvertisingBatch,
  importShopeeAdvertisingCsv,
  loadAdvertisingFiles,
  loadAdvertisingStatus,
  loadShopeeAdvertisingDashboard,
  saveShopeeAdvertisingTargets,
  type ShopeeAdvertisingDashboard,
  type ShopeeAdvertisingRow,
} from "@/services/advertising";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const importing = ref(false);
const importProgress = ref("");
const draggingFiles = ref(false);
let dragDepth = 0;
const deletingBatchId = ref("");
const savingTargets = ref(false);
const error = ref("");
const serviceUrl = ref("");
const files = ref<Array<Record<string, unknown>>>([]);
const total = ref(0);
const dashboard = ref<ShopeeAdvertisingDashboard | null>(null);
const selectedShopId = ref("");
const targetDialogVisible = ref(false);
const targetDrafts = reactive<Record<string, number | undefined>>({});
const fileInput = ref<HTMLInputElement | null>(null);
const serviceOnline = computed(() => Boolean(serviceUrl.value));
const summary = computed(() => dashboard.value?.summary || null);
const findings = computed(() => dashboard.value?.findings || []);
const hasImportedData = computed(() => Boolean(dashboard.value && !dashboard.value.empty));
const evidenceReady = computed(() => Boolean(dashboard.value?.evidenceReady));
const evidenceRows = computed(() => findings.value.length ? findings.value : (dashboard.value?.rows || []).slice(0, 12));
const coverageItems = computed(() => [
  { key: "day", label: "单日", note: "发现异常", ready: Boolean(dashboard.value?.coverage?.day) },
  { key: "seven", label: "7日", note: "观察方向", ready: Boolean(dashboard.value?.coverage?.seven) },
  { key: "fourteen", label: "14日", note: "主要决策", ready: Boolean(dashboard.value?.coverage?.fourteen), required: true },
  { key: "previousFourteen", label: "前14日", note: "环比验证", ready: Boolean(dashboard.value?.coverage?.previousFourteen) },
  { key: "long", label: "长期", note: "历史基线", ready: Boolean(dashboard.value?.coverage?.long) },
]);
const fourteenChange = computed(() => {
  const current = Number(summary.value?.fourteenProduct?.roas || 0);
  const previous = Number(summary.value?.previousFourteenProduct?.roas || 0);
  return current > 0 && previous > 0 ? ((current - previous) / previous) * 100 : null;
});

function field(row: Record<string, unknown>, ...keys: string[]) { for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key]; return "—"; }
function formatDate(value: unknown) { return value ? new Date(String(value)).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function formatSize(value: unknown) { const bytes = Number(value || 0); return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`; }
function formatNumber(value: unknown) { return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 }); }
function formatMoney(value: unknown) { return `Rp ${Number(value || 0).toLocaleString("id-ID", { maximumFractionDigits: 0 })}`; }
function shortName(value: string) { return value.length > 70 ? `${value.slice(0, 70)}…` : value; }
function priorityLabel(value: ShopeeAdvertisingRow["priority"]) { return ({ P0: "立即核查", P1: "需要诊断", WAITING: "暂不调整", NORMAL: "保持投放" })[value]; }
function priorityType(value: ShopeeAdvertisingRow["priority"]) { return value === "P0" ? "danger" : value === "P1" ? "warning" : value === "WAITING" ? "info" : "success"; }
function confidenceLabel(value: ShopeeAdvertisingRow["confidence"]) { return ({ high: "高置信", medium: "中置信", low: "低置信" })[value] || "低置信"; }
function formatSigned(value: number | null) { return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`; }
function campaignTypeLabel(value: ShopeeAdvertisingRow["detail"]["campaignType"]) { return ({ individual: "单品广告", ad_group: "广告组", shop_gmv_max: "全店推", new_product: "新品广告" })[value] || "商品广告"; }
function stageLabel(value: ShopeeAdvertisingRow["detail"]["stage"]) { return ({ learning: "7天学习期", stabilizing: "稳定观察期", new_product: "新品冷启动", mature: "成熟投放" })[value] || "阶段待确认"; }

function syncTargetDrafts() {
  for (const key of Object.keys(targetDrafts)) delete targetDrafts[key];
  for (const row of dashboard.value?.rows || []) targetDrafts[row.adKey] = row.targetRoas || undefined;
}

async function load(shopId = selectedShopId.value) {
  loading.value = true; error.value = "";
  const [shopeeResult, statusResult, filesResult] = await Promise.allSettled([
    loadShopeeAdvertisingDashboard(shopId), loadAdvertisingStatus(), loadAdvertisingFiles(),
  ]);
  if (shopeeResult.status === "fulfilled") {
    dashboard.value = shopeeResult.value;
    selectedShopId.value = shopeeResult.value.selectedShopId || shopId || "";
    syncTargetDrafts();
  } else error.value = String(shopeeResult.reason?.message || shopeeResult.reason || "Shopee广告巡检数据读取失败");
  if (statusResult.status === "fulfilled") serviceUrl.value = statusResult.value.url || "/ads/";
  if (filesResult.status === "fulfilled") { files.value = filesResult.value.files || []; total.value = filesResult.value.total || files.value.length; }
  workspace.lastSyncedAt = new Date(); loading.value = false;
}

async function onShopChange() { await load(selectedShopId.value); }

async function importSelectedFiles(selectedFiles: File[]) {
  if (!selectedFiles.length) return;
  if (selectedFiles.length > 30) { ElMessage.error("单次最多选择30份CSV，请分批导入"); return; }
  importing.value = true;
  let importedCount = 0;
  let duplicateCount = 0;
  const failures: Array<{ filename: string; reason: string }> = [];
  try {
    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      importProgress.value = `${index + 1}/${selectedFiles.length}`;
      if (!file.name.toLowerCase().endsWith(".csv")) {
        failures.push({ filename: file.name, reason: "不是CSV文件" });
        continue;
      }
      try {
        const result = await importShopeeAdvertisingCsv(file.name, await file.text());
        if (result.duplicate) duplicateCount += 1;
        else importedCount += 1;
      } catch (reason) {
        failures.push({ filename: file.name, reason: String((reason as Error)?.message || reason || "导入失败") });
      }
    }
    if (importedCount || duplicateCount) await load();
    const summaryText = `共处理 ${selectedFiles.length} 份：成功 ${importedCount}，重复 ${duplicateCount}，失败 ${failures.length}`;
    if (!failures.length) ElMessage.success(summaryText);
    else {
      const details = failures.slice(0, 8).map((item) => `${item.filename}：${item.reason}`).join("\n");
      const omitted = failures.length > 8 ? `\n另有 ${failures.length - 8} 份失败未展开` : "";
      await ElMessageBox.alert(`${summaryText}\n\n${details}${omitted}`, "批量导入完成", {
        type: importedCount || duplicateCount ? "warning" : "error",
        confirmButtonText: "知道了",
      }).catch(() => {});
    }
  } finally {
    importing.value = false;
    importProgress.value = "";
  }
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const selectedFiles = Array.from(input.files || []);
  input.value = "";
  await importSelectedFiles(selectedFiles);
}

function openFilePicker() {
  if (!importing.value) fileInput.value?.click();
}

function onDragEnter() {
  if (importing.value) return;
  dragDepth += 1;
  draggingFiles.value = true;
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) draggingFiles.value = false;
}

function onDragOver(event: DragEvent) {
  if (event.dataTransfer) event.dataTransfer.dropEffect = importing.value ? "none" : "copy";
}

async function onFilesDropped(event: DragEvent) {
  dragDepth = 0;
  draggingFiles.value = false;
  if (importing.value) return;
  await importSelectedFiles(Array.from(event.dataTransfer?.files || []));
}

async function removeBatch(batch: Record<string, unknown>) {
  const batchId = String(batch.id || "");
  if (!batchId || deletingBatchId.value) return;
  const filename = String(batch.originalFilename || "未命名报表");
  const period = `${String(batch.periodFrom || "—")} 至 ${String(batch.periodTo || "—")}`;
  try {
    await ElMessageBox.confirm(
      `将删除“${filename}”及其 ${Number(batch.rowCount || 0)} 行广告数据（${period}）。目标ROAS不会被删除，之后仍可重新导入该文件。`,
      "确认删除报表批次",
      { type: "warning", confirmButtonText: "删除这份报表", cancelButtonText: "取消", distinguishCancelAndClose: true },
    );
  } catch { return; }
  deletingBatchId.value = batchId;
  try {
    const result = await deleteShopeeAdvertisingBatch(batchId);
    ElMessage.success(`已删除报表及 ${result.deletedFacts} 行广告数据`);
    await load(selectedShopId.value);
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "删除报表失败"));
  } finally { deletingBatchId.value = ""; }
}

function openTargetDialog() { syncTargetDrafts(); targetDialogVisible.value = true; }

async function saveTargets() {
  if (!dashboard.value?.selectedShopId) return;
  const targets = dashboard.value.rows.filter((row) => Number(targetDrafts[row.adKey]) > 0).map((row) => ({
    targetKey: row.adKey, productId: row.productId, adName: row.adName, targetRoas: Number(targetDrafts[row.adKey]),
  }));
  if (!targets.length) { ElMessage.warning("请至少填写一条目标ROAS"); return; }
  savingTargets.value = true;
  try {
    await saveShopeeAdvertisingTargets({
      shopId: dashboard.value.selectedShopId,
      effectiveFrom: dashboard.value.summary?.reportDate || new Date().toISOString().slice(0, 10),
      sourceType: "screenshot",
      targets,
    });
    targetDialogVisible.value = false;
    ElMessage.success(`已保存 ${targets.length} 条只读目标ROAS`);
    await load();
  } catch (reason) { ElMessage.error(String((reason as Error)?.message || reason || "保存失败")); }
  finally { savingTargets.value = false; }
}

onMounted(load);
</script>

<template>
  <div class="advertising-vue-page" v-loading="loading">
    <section class="module-toolbar advertising-toolbar">
      <div class="service-summary">
        <span class="readonly-badge"><ShieldCheck :size="16" />只读巡检</span>
        <div><strong>Shopee 广告决策台</strong><small>先验证证据成熟度，再定位流量、转化与效率问题</small></div>
      </div>
      <div class="module-toolbar-actions">
        <el-select v-if="dashboard?.shops?.length" v-model="selectedShopId" aria-label="选择Shopee店铺" class="shop-select" @change="onShopChange">
          <el-option v-for="shop in dashboard.shops" :key="shop.shopId" :label="`${shop.shopName} · ${shop.shopId}`" :value="shop.shopId" />
        </el-select>
        <el-button :icon="Settings2" :disabled="!hasImportedData" @click="openTargetDialog">目标ROAS</el-button>
        <el-button :icon="RefreshCw" @click="load()">刷新</el-button>
        <el-button type="primary" :icon="Upload" :loading="importing" @click="openFilePicker">{{ importing ? `导入中 ${importProgress}` : "批量导入CSV" }}</el-button>
        <input ref="fileInput" class="visually-hidden" type="file" accept=".csv,text/csv" multiple @change="onFileSelected" />
      </div>
    </section>

    <section
      class="batch-upload-zone" :class="{ dragging: draggingFiles, importing }" role="button" tabindex="0"
      :aria-disabled="importing" aria-label="拖拽或选择Shopee广告CSV文件"
      @click="openFilePicker" @keydown.enter="openFilePicker" @keydown.space.prevent="openFilePicker"
      @dragenter.prevent="onDragEnter" @dragover.prevent="onDragOver" @dragleave.prevent="onDragLeave" @drop.prevent="onFilesDropped"
    >
      <span class="upload-zone-icon"><Upload :size="20" aria-hidden="true" /></span>
      <div>
        <strong>{{ draggingFiles ? "松开鼠标开始导入" : importing ? `正在处理第 ${importProgress} 份` : "拖拽CSV到这里，或点击选择文件" }}</strong>
        <small>逐份校验与去重，单张失败不会中断其余文件</small>
      </div>
      <span class="upload-limit">单次最多30份</span>
    </section>

    <el-alert v-if="error" type="warning" :closable="false" show-icon :title="error" description="请检查主服务和数据库迁移状态后重试。" />

    <section v-if="hasImportedData" class="evidence-gate" :class="{ ready: evidenceReady }" aria-live="polite">
      <component :is="evidenceReady ? CheckCircle2 : AlertCircle" :size="22" aria-hidden="true" />
      <div>
        <span>决策证据</span>
        <strong>{{ evidenceReady ? "已具备14天主判断窗口" : "当前不能形成正式调整建议" }}</strong>
        <p>{{ evidenceReady ? "系统将按14天累计表现和100点击门槛判断；单日与7日只用于解释变化。" : "缺少精确14天报表。现有结果统一降级为观察项，不生成停投、改预算或改目标建议。" }}</p>
      </div>
      <span class="gate-date">数据截至 {{ summary?.reportDate || "—" }}</span>
    </section>

    <section v-if="summary" class="decision-overview" aria-label="广告判断概览">
      <article class="primary-metric">
        <span>14日商品 ROAS</span>
        <strong>{{ summary.fourteenProduct ? formatNumber(summary.fourteenProduct.roas) : "待导入" }}</strong>
        <small v-if="summary.fourteenProduct">{{ formatMoney(summary.fourteenProduct.expense) }} 花费 · 环比 {{ formatSigned(fourteenChange) }}</small>
        <small v-else>主要决策指标尚不可用</small>
      </article>
      <article><span>成熟样本</span><strong>{{ summary.matureCount }}<em>/ {{ dashboard?.rows?.length || 0 }}</em></strong><small>14日点击达到100次</small></article>
      <article><span>暂不调整</span><strong>{{ summary.waitingCount }}</strong><small>学习期、样本不足或证据缺口</small></article>
      <article><span>需要诊断</span><strong>{{ summary.p0Count + summary.p1Count }}</strong><small>{{ summary.p0Count }} 项需立即核查</small></article>
      <article><span>目标覆盖</span><strong>{{ summary.targetCoverage }}%</strong><small>{{ summary.holdCount }} 项建议保持投放</small></article>
    </section>

    <section v-if="!hasImportedData" class="dashboard-panel empty-import-panel">
      <FileSpreadsheet :size="34" />
      <h2>导入第一份Shopee广告报表</h2>
      <p>优先导入同一家店的精确14天和前14天 Overall Data CSV；单日、7日与长期报表用于解释异常和历史基线。</p>
    </section>

    <section v-if="hasImportedData" class="evidence-layout">
      <article class="dashboard-panel coverage-panel">
        <header><div><span class="panel-kicker">EVIDENCE COVERAGE</span><h3>数据证据链</h3></div><Database :size="20" aria-hidden="true" /></header>
        <div class="coverage-track">
          <div v-for="item in coverageItems" :key="item.key" :class="['coverage-step', { complete: item.ready, required: item.required }]">
            <span><CheckCircle2 v-if="item.ready" :size="15" /><Clock3 v-else :size="15" />{{ item.label }}</span>
            <strong>{{ item.ready ? "已导入" : "缺失" }}</strong>
            <small>{{ item.note }}</small>
          </div>
        </div>
      </article>
      <aside class="dashboard-panel method-panel">
        <header><div><span class="panel-kicker">DECISION RULE</span><h3>本页如何判断</h3></div><Info :size="20" aria-hidden="true" /></header>
        <ol>
          <li><span>01</span><div><strong>类型与阶段</strong><small>区分学习、稳定与成熟投放</small></div></li>
          <li><span>02</span><div><strong>14天与100点击</strong><small>确认数据能否形成结论</small></div></li>
          <li><span>03</span><div><strong>商品 × 竞价 × 预算</strong><small>定位真正瓶颈后再给动作</small></div></li>
        </ol>
      </aside>
    </section>

    <section v-if="hasImportedData" class="dashboard-panel findings-panel">
      <header><div><span class="panel-kicker">DECISION QUEUE</span><h3>详细诊断与建议</h3></div><span>展开每一行查看执行方案 · 所有动作需人工确认</span></header>
      <el-table :data="evidenceRows" stripe empty-text="成熟广告均建议保持投放">
        <el-table-column type="expand" width="48">
          <template #default="scope">
            <article class="diagnosis-report">
              <header class="diagnosis-report-head">
                <div><span>诊断结论</span><h4>{{ scope.row.detail.bottleneck }}</h4></div>
                <div class="report-flags"><span>{{ campaignTypeLabel(scope.row.detail.campaignType) }}</span><span>{{ stageLabel(scope.row.detail.stage) }}</span><span>{{ confidenceLabel(scope.row.confidence) }}</span></div>
              </header>
              <div class="diagnosis-grid">
                <section class="report-block evidence-block">
                  <span class="report-label">判断证据</span>
                  <ul><li v-for="item in scope.row.detail.evidence" :key="item">{{ item }}</li></ul>
                </section>
                <section class="report-block action-plan-block">
                  <span class="report-label">建议执行顺序</span>
                  <ol><li v-for="(item, index) in scope.row.detail.actionSteps" :key="item"><b>{{ index + 1 }}</b><span>{{ item }}</span></li></ol>
                </section>
                <section class="report-block adjustment-block">
                  <span class="report-label">参数建议</span>
                  <strong>{{ scope.row.detail.suggestedAdjustment }}</strong>
                  <small>{{ scope.row.detail.observationWindow }}</small>
                </section>
                <section class="report-block validation-block">
                  <span class="report-label">验证与止损</span>
                  <p><b>成功信号</b>{{ scope.row.detail.successSignal }}</p>
                  <p><b>升级条件</b>{{ scope.row.detail.stopSignal }}</p>
                </section>
                <details class="report-block checklist-block">
                  <summary>商品健康度检查清单</summary>
                  <ul><li v-for="item in scope.row.detail.healthChecklist" :key="item">{{ item }}</li></ul>
                </details>
                <details class="report-block missing-block">
                  <summary>仍需后台确认的数据</summary>
                  <ul><li v-for="item in scope.row.detail.missingData" :key="item">{{ item }}</li></ul>
                </details>
              </div>
            </article>
          </template>
        </el-table-column>
        <el-table-column label="判断" width="118"><template #default="scope"><div class="decision-tag"><el-tag :type="priorityType(scope.row.priority)" effect="light">{{ priorityLabel(scope.row.priority) }}</el-tag><small>{{ confidenceLabel(scope.row.confidence) }}</small></div></template></el-table-column>
        <el-table-column label="广告、类型与阶段" min-width="285"><template #default="scope"><div class="ad-name-cell"><strong :title="scope.row.adName">{{ shortName(scope.row.adName) }}</strong><span>{{ campaignTypeLabel(scope.row.detail.campaignType) }} · {{ stageLabel(scope.row.detail.stage) }} · {{ scope.row.mode === 'auto' ? '自动竞价' : scope.row.mode === 'custom' ? '自定义ROAS' : '模式待确认' }}</span><small>{{ scope.row.productId && scope.row.productId !== '-' ? `Item ${scope.row.productId}` : '缺少 Product ID' }}</small></div></template></el-table-column>
        <el-table-column label="14日证据" width="150" align="right"><template #default="scope"><div class="metric-cell"><strong>{{ scope.row.fourteen ? `${formatNumber(scope.row.fourteen.clicks)} 点击` : "未导入" }}</strong><span v-if="scope.row.fourteen">{{ scope.row.fourteen.conversions }} 转化 · CTR {{ scope.row.fourteen.ctr }}%</span><span v-else>7日 {{ scope.row.seven?.clicks ?? 0 }} 点击，仅供参考</span></div></template></el-table-column>
        <el-table-column label="效率" width="150" align="right"><template #default="scope"><div class="metric-cell"><strong>{{ scope.row.fourteen ? `ROAS ${scope.row.fourteen.roas}` : "—" }}</strong><span>目标 {{ scope.row.targetRoas ?? "未录入" }} · 达成 {{ scope.row.targetAttainment !== null ? `${scope.row.targetAttainment}%` : "—" }}</span></div></template></el-table-column>
        <el-table-column label="结论与第一动作" min-width="370"><template #default="scope"><div class="action-cell"><strong>{{ scope.row.detail.bottleneck }}</strong><span>{{ scope.row.action }}</span><small><ShieldCheck :size="13" />{{ scope.row.detail.suggestedAdjustment }} · 点击左侧展开完整方案</small></div></template></el-table-column>
      </el-table>
    </section>

    <section v-if="hasImportedData" class="dashboard-panel batch-panel">
      <header><div><span class="panel-kicker">SOURCE REPORTS</span><h3>已导入报表</h3></div><span>{{ dashboard?.batches?.length || 0 }} 个数据批次</span></header>
      <div class="batch-list">
        <article v-for="batch in dashboard?.batches" :key="String(batch.id)">
          <CheckCircle2 :size="17" />
          <div><strong>{{ field(batch, 'originalFilename') }}</strong><span>{{ field(batch, 'periodFrom') }} 至 {{ field(batch, 'periodTo') }}</span></div>
          <div class="batch-actions">
            <small>{{ field(batch, 'periodDays') }}天 · {{ field(batch, 'rowCount') }}行</small>
            <el-button text type="danger" :icon="Trash2" :loading="deletingBatchId === String(batch.id)" :disabled="Boolean(deletingBatchId)" :aria-label="`删除报表 ${String(batch.originalFilename || '')}`" @click="removeBatch(batch)">删除</el-button>
          </div>
        </article>
      </div>
    </section>

    <details class="legacy-advertising-panel">
      <summary><span>Lazada 广告分析侧车</span><small>{{ serviceOnline ? "在线" : "离线" }} · {{ total }} 个已登记文件</small></summary>
      <section class="dashboard-panel advertising-files-panel">
        <header><div><span class="panel-kicker">LEGACY ANALYZER</span><h3>原广告分析服务</h3></div><a v-if="serviceUrl" :href="serviceUrl" target="_blank" rel="noreferrer">打开分析器</a></header>
        <el-table :data="files" stripe empty-text="暂无广告文件记录">
          <el-table-column label="文件" min-width="260"><template #default="scope"><div class="advertising-file-cell"><strong>{{ field(scope.row, 'originalFilename', 'filename', 'name') }}</strong><span>{{ field(scope.row, 'sourceType', 'scope', 'type') }}</span></div></template></el-table-column>
          <el-table-column label="状态" width="120"><template #default="scope"><el-tag type="info">{{ field(scope.row, 'status') }}</el-tag></template></el-table-column>
          <el-table-column label="大小" width="110" align="right"><template #default="scope">{{ formatSize(field(scope.row, 'size', 'fileSize')) }}</template></el-table-column>
          <el-table-column label="创建时间" width="180"><template #default="scope">{{ formatDate(field(scope.row, 'createdAt', 'created_at')) }}</template></el-table-column>
        </el-table>
      </section>
    </details>

    <el-dialog v-model="targetDialogVisible" title="配置只读目标ROAS" width="min(920px, 94vw)" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon title="这些数值只用于诊断" description="保存不会写回Shopee。请按后台截图填写当前目标ROAS，系统会记录生效日期和来源。" />
      <el-table class="target-table" :data="dashboard?.rows || []" max-height="520">
        <el-table-column label="广告链接" min-width="430"><template #default="scope"><div class="ad-name-cell"><strong>{{ scope.row.adName }}</strong><span>{{ scope.row.productId && scope.row.productId !== '-' ? scope.row.productId : '缺少 Product ID，暂按广告名称匹配' }}</span></div></template></el-table-column>
        <el-table-column label="当前14日ROAS" width="130" align="right"><template #default="scope">{{ scope.row.fourteen?.roas ?? "—" }}</template></el-table-column>
        <el-table-column label="目标ROAS" width="180"><template #default="scope"><el-input-number v-model="targetDrafts[scope.row.adKey]" :min="0.1" :max="1000" :precision="1" :step="0.1" controls-position="right" aria-label="目标ROAS" /></template></el-table-column>
      </el-table>
      <template #footer><el-button @click="targetDialogVisible = false">取消</el-button><el-button type="primary" :loading="savingTargets" @click="saveTargets">保存只读目标</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.advertising-vue-page { display: grid; gap: 16px; max-width: 1480px; margin: 0 auto; }
.service-summary { display: flex; align-items: center; gap: 14px; }
.service-summary > div { display: grid; gap: 3px; }
.service-summary small { color: var(--ops-text-secondary); }
.readonly-badge { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 10px; border: 1px solid color-mix(in srgb,var(--ops-primary) 28%,transparent); border-radius: 8px; background: color-mix(in srgb,var(--ops-primary) 7%,var(--ops-surface)); color: var(--ops-primary); font-size: 12px; font-weight: 700; }
.shop-select { width: 250px; }
.visually-hidden { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.batch-upload-zone { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 12px; min-height: 68px; padding: 11px 15px; border: 1px dashed color-mix(in srgb,var(--ops-primary) 38%,var(--ops-border-light)); border-radius: 10px; background: color-mix(in srgb,var(--ops-primary) 3%,var(--ops-surface)); cursor: pointer; transition: border-color .2s ease,background-color .2s ease,transform .2s ease; }
.batch-upload-zone:hover { border-color: color-mix(in srgb,var(--ops-primary) 68%,var(--ops-border-light)); background: color-mix(in srgb,var(--ops-primary) 6%,var(--ops-surface)); }
.batch-upload-zone:active { transform: translateY(1px); }
.batch-upload-zone:focus-visible { outline: 3px solid color-mix(in srgb,var(--ops-primary) 28%,transparent); outline-offset: 2px; }
.batch-upload-zone.dragging { border-style: solid; border-color: var(--ops-primary); background: color-mix(in srgb,var(--ops-primary) 11%,var(--ops-surface)); transform: translateY(-1px); }
.batch-upload-zone.importing { cursor: progress; opacity: .72; }
.upload-zone-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 8px; background: color-mix(in srgb,var(--ops-primary) 10%,var(--ops-surface)); color: var(--ops-primary); }
.batch-upload-zone > div { display: grid; gap: 3px; min-width: 0; }
.batch-upload-zone strong { color: var(--ops-text); font-size: 13px; }
.batch-upload-zone small,.upload-limit { color: var(--ops-text-secondary); font-size: 11px; }
.upload-limit { white-space: nowrap; font-variant-numeric: tabular-nums; }
.evidence-gate { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 14px; padding: 17px 19px; border: 1px solid color-mix(in srgb,var(--el-color-warning) 28%,var(--ops-border-light)); border-left: 4px solid var(--el-color-warning); border-radius: 10px; background: color-mix(in srgb,var(--el-color-warning) 7%,var(--ops-surface)); }
.evidence-gate.ready { border-color: color-mix(in srgb,var(--el-color-success) 28%,var(--ops-border-light)); border-left-color: var(--el-color-success); background: color-mix(in srgb,var(--el-color-success) 6%,var(--ops-surface)); }
.evidence-gate > svg { color: var(--el-color-warning); }
.evidence-gate.ready > svg { color: var(--el-color-success); }
.evidence-gate div { display: grid; gap: 2px; }
.evidence-gate span,.evidence-gate p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; line-height: 1.55; }
.evidence-gate strong { color: var(--ops-text); font-size: 16px; letter-spacing: -.01em; }
.gate-date { white-space: nowrap; }
.decision-overview { display: grid; grid-template-columns: minmax(260px,1.45fr) repeat(4,minmax(150px,1fr)); gap: 10px; }
.decision-overview article { display: grid; align-content: center; gap: 5px; min-height: 108px; padding: 16px 17px; border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface); box-shadow: 0 8px 22px color-mix(in srgb,var(--ops-primary) 5%,transparent); }
.decision-overview .primary-metric { padding-inline: 21px; border-color: color-mix(in srgb,var(--ops-primary) 26%,var(--ops-border-light)); background: radial-gradient(circle at 100% 0,color-mix(in srgb,var(--ops-primary) 10%,transparent),transparent 48%),var(--ops-surface); }
.decision-overview span,.decision-overview small { color: var(--ops-text-secondary); font-size: 12px; }
.decision-overview strong { color: var(--ops-text); font-size: 27px; font-variant-numeric: tabular-nums; letter-spacing: -.025em; }
.decision-overview .primary-metric strong { font-size: 33px; }
.decision-overview em { color: var(--ops-text-secondary); font-size: 14px; font-style: normal; font-weight: 500; }
.evidence-layout { display: grid; grid-template-columns: minmax(0,1.65fr) minmax(290px,.7fr); gap: 12px; }
.coverage-track { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 1px; overflow: hidden; border: 1px solid var(--ops-border-light); border-radius: 9px; background: var(--ops-border-light); }
.coverage-step { display: grid; gap: 5px; min-height: 92px; padding: 13px; background: var(--ops-surface-muted); }
.coverage-step.complete { background: var(--ops-surface); }
.coverage-step.required:not(.complete) { background: color-mix(in srgb,var(--el-color-warning) 7%,var(--ops-surface)); }
.coverage-step > span { display: flex; align-items: center; gap: 6px; color: var(--ops-text-secondary); font-size: 12px; }
.coverage-step.complete > span svg { color: var(--el-color-success); }
.coverage-step strong { color: var(--ops-text); font-size: 14px; }
.coverage-step small { color: var(--ops-text-secondary); font-size: 11px; }
.method-panel ol { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.method-panel li { display: grid; grid-template-columns: 30px 1fr; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; background: var(--ops-surface-muted); }
.method-panel li > span { color: var(--ops-primary); font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums; }
.method-panel li div { display: grid; gap: 1px; }
.method-panel li strong { color: var(--ops-text); font-size: 13px; }
.method-panel li small { color: var(--ops-text-secondary); font-size: 11px; }
.empty-import-panel { display: grid; justify-items: center; gap: 10px; padding: 52px 24px; text-align: center; }
.empty-import-panel svg { color: var(--ops-primary); }
.empty-import-panel h2,.empty-import-panel p { margin: 0; }
.empty-import-panel p { max-width: 680px; color: var(--ops-text-secondary); line-height: 1.7; }
.findings-panel :deep(.el-table),.target-table { --el-table-header-bg-color: var(--ops-surface-muted); }
.decision-tag,.ad-name-cell,.metric-cell,.action-cell { display: grid; gap: 4px; }
.decision-tag { justify-items: start; }
.decision-tag small,.ad-name-cell span,.metric-cell span,.action-cell span,.action-cell small { color: var(--ops-text-secondary); font-size: 11px; line-height: 1.5; }
.ad-name-cell strong,.action-cell strong { color: var(--ops-text); }
.metric-cell strong { font-variant-numeric: tabular-nums; }
.action-cell small { display: flex; align-items: flex-start; gap: 5px; padding-top: 3px; color: color-mix(in srgb,var(--ops-text-secondary) 88%,var(--ops-primary)); }
.action-cell small svg { flex: 0 0 auto; margin-top: 1px; }
.ad-name-cell small { color: var(--ops-text-secondary); font-size: 10px; }
.findings-panel :deep(.el-table__expanded-cell) { padding: 0 !important; background: color-mix(in srgb,var(--ops-primary) 2.5%,var(--ops-surface)) !important; }
.diagnosis-report { padding: 22px 26px 25px 74px; }
.diagnosis-report-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
.diagnosis-report-head > div:first-child { display: grid; gap: 3px; }
.diagnosis-report-head span,.report-label { color: var(--ops-text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.diagnosis-report-head h4 { margin: 0; color: var(--ops-text); font-size: 20px; letter-spacing: -.02em; }
.report-flags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.report-flags span { padding: 5px 8px; border: 1px solid var(--ops-border-light); border-radius: 6px; background: var(--ops-surface); color: var(--ops-text-secondary); letter-spacing: 0; }
.diagnosis-grid { display: grid; grid-template-columns: minmax(0,1.05fr) minmax(0,1.35fr); gap: 10px; }
.report-block { min-width: 0; padding: 15px 16px; border-radius: 8px; background: var(--ops-surface); box-shadow: inset 0 0 0 1px var(--ops-border-light); }
.report-block ul,.report-block ol { display: grid; gap: 7px; margin: 10px 0 0; padding-left: 18px; }
.report-block li,.report-block p,.report-block small { color: var(--ops-text-secondary); font-size: 12px; line-height: 1.55; }
.action-plan-block ol { padding: 0; list-style: none; }
.action-plan-block li { display: grid; grid-template-columns: 22px minmax(0,1fr); gap: 8px; align-items: start; }
.action-plan-block li b { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 5px; background: color-mix(in srgb,var(--ops-primary) 10%,var(--ops-surface)); color: var(--ops-primary); font-size: 10px; }
.adjustment-block,.validation-block { display: grid; align-content: start; gap: 7px; }
.adjustment-block strong { color: var(--ops-text); font-size: 14px; line-height: 1.5; }
.validation-block p { display: grid; grid-template-columns: 64px minmax(0,1fr); gap: 7px; margin: 0; }
.validation-block p b { color: var(--ops-text); font-size: 11px; }
.checklist-block summary,.missing-block summary { cursor: pointer; color: var(--ops-text); font-size: 12px; font-weight: 700; }
.checklist-block summary:focus-visible,.missing-block summary:focus-visible { outline: 3px solid color-mix(in srgb,var(--ops-primary) 28%,transparent); outline-offset: 3px; }
.batch-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.batch-list article { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 10px 11px 10px 13px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface-muted); }
.batch-list svg { color: var(--el-color-success); }
.batch-list div { display: grid; gap: 3px; min-width: 0; }
.batch-list strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-list span,.batch-list small { color: var(--ops-text-secondary); font-size: 11px; }
.batch-actions { display: flex !important; align-items: center; justify-content: flex-end; gap: 6px !important; }
.batch-actions :deep(.el-button) { min-height: 32px; margin: 0; padding-inline: 8px; }
.legacy-advertising-panel { border: 1px solid var(--ops-border-light); border-radius: 10px; background: var(--ops-surface); }
.legacy-advertising-panel summary { display: flex; justify-content: space-between; gap: 16px; min-height: 48px; padding: 15px 18px; cursor: pointer; font-weight: 700; }
.legacy-advertising-panel summary small { color: var(--ops-text-secondary); font-weight: 400; }
.legacy-advertising-panel .dashboard-panel { border: 0; border-top: 1px solid var(--ops-border-light); border-radius: 0; box-shadow: none; }
.advertising-file-cell { display: grid; gap: 4px; }
.advertising-file-cell span { color: var(--ops-text-secondary); font-size: 11px; }
.advertising-toolbar :deep(.el-button),.legacy-advertising-panel summary { transition: border-color .2s ease,background-color .2s ease,color .2s ease; }
.advertising-toolbar :deep(.el-button:focus-visible),.legacy-advertising-panel summary:focus-visible { outline: 3px solid color-mix(in srgb,var(--ops-primary) 28%,transparent); outline-offset: 2px; }
@media (max-width: 1180px) { .decision-overview { grid-template-columns: repeat(4,minmax(0,1fr)); }.decision-overview .primary-metric { grid-column: span 2; }.evidence-layout { grid-template-columns: 1fr; }.module-toolbar-actions { flex-wrap: wrap; }.shop-select { width: 220px; } }
@media (max-width: 760px) { .decision-overview { grid-template-columns: repeat(2,minmax(0,1fr)); }.decision-overview .primary-metric { grid-column: 1/-1; }.coverage-track { grid-template-columns: 1fr; }.coverage-step { grid-template-columns: 1fr auto; min-height: auto; }.coverage-step small { grid-column: 1/-1; }.batch-list { grid-template-columns: 1fr; }.advertising-toolbar,.service-summary { align-items: flex-start; }.module-toolbar-actions,.shop-select { width: 100%; }.module-toolbar-actions :deep(.el-button) { min-height: 44px; }.batch-upload-zone { grid-template-columns: auto minmax(0,1fr); }.upload-limit { grid-column: 2; }.evidence-gate { grid-template-columns: auto 1fr; }.gate-date { grid-column: 2; }.legacy-advertising-panel summary { flex-direction: column; }.diagnosis-report { padding: 18px; }.diagnosis-report-head { flex-direction: column; }.report-flags { justify-content: flex-start; }.diagnosis-grid { grid-template-columns: 1fr; } }
@media (max-width: 430px) { .decision-overview { grid-template-columns: 1fr; }.decision-overview .primary-metric { grid-column: auto; }.evidence-gate { grid-template-columns: 1fr; }.gate-date { grid-column: auto; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
</style>
