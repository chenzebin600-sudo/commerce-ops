<script setup lang="ts">
import { RefreshCw, Search } from "@lucide/vue";
import { computed, onMounted, reactive, ref } from "vue";
import { loadAuditDetail, loadAuditEvents, loadAuditSummary, type AuditEvent, type AuditSummary } from "@/services/audit";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const error = ref("");
const events = ref<AuditEvent[]>([]);
const summary = ref<AuditSummary>({ total: 0, byStatus: {}, byModule: [] });
const total = ref(0);
const detailVisible = ref(false);
const detail = ref<AuditEvent | null>(null);
const query = reactive({ page: 1, pageSize: 50, start: "", end: "", module: "", status: "", action: "" });

const moduleSummary = computed(() => summary.value.byModule.slice(0, 4).map((item) => `${item.module} ${item.count}`).join(" · ") || "暂无模块数据");

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function relation(event: AuditEvent) {
  return event.taskId ? `任务 ${event.taskId}` : event.runId ? `执行 ${event.runId}` : event.fileId ? `文件 ${event.fileId}` : "—";
}

async function load({ resetPage = false } = {}) {
  if (resetPage) query.page = 1;
  loading.value = true;
  error.value = "";
  try {
    const [eventResult, summaryResult] = await Promise.all([loadAuditEvents(query), loadAuditSummary()]);
    events.value = eventResult.events || [];
    total.value = eventResult.total || 0;
    summary.value = summaryResult;
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "操作记录加载失败");
  } finally {
    loading.value = false;
  }
}

async function showDetail(event: AuditEvent) {
  detailVisible.value = true;
  detail.value = await loadAuditDetail(event.id).catch(() => event);
}

function reset() {
  Object.assign(query, { page: 1, start: "", end: "", module: "", status: "", action: "" });
  load();
}

onMounted(load);
</script>

<template>
  <div class="audit-vue-page" v-loading="loading">
    <section class="module-toolbar audit-toolbar">
      <div class="audit-filter-grid">
        <el-date-picker v-model="query.start" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" clearable />
        <el-date-picker v-model="query.end" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" clearable />
        <el-input v-model="query.module" placeholder="模块" clearable />
        <el-select v-model="query.status" placeholder="全部状态" clearable><el-option label="成功" value="success" /><el-option label="失败" value="failed" /></el-select>
        <el-input v-model="query.action" placeholder="操作代码" clearable @keyup.enter="load({ resetPage: true })" />
      </div>
      <div class="module-toolbar-actions"><el-button @click="reset">重置</el-button><el-button :icon="Search" type="primary" @click="load({ resetPage: true })">查询</el-button><el-button :icon="RefreshCw" @click="load()">刷新</el-button></div>
    </section>
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <section class="audit-summary-strip">
      <div><span>记录总数</span><strong>{{ Number(summary.total || 0).toLocaleString("zh-CN") }}</strong></div>
      <div><span>成功</span><strong class="success">{{ Number(summary.byStatus.success || 0).toLocaleString("zh-CN") }}</strong></div>
      <div><span>失败</span><strong class="danger">{{ Number(summary.byStatus.failed || 0).toLocaleString("zh-CN") }}</strong></div>
      <div><span>主要模块</span><strong class="modules">{{ moduleSummary }}</strong></div>
    </section>
    <section class="dashboard-panel audit-table-panel">
      <header><div><span class="panel-kicker">AUDIT TRAIL</span><h3>操作流水</h3></div><span>共 {{ total.toLocaleString("zh-CN") }} 条</span></header>
      <el-table :data="events" stripe empty-text="暂无符合条件的操作记录">
        <el-table-column label="时间" width="170"><template #default="scope">{{ formatDate(scope.row.occurredAt) }}</template></el-table-column>
        <el-table-column prop="module" label="模块" width="130" />
        <el-table-column label="操作" min-width="220"><template #default="scope"><div class="audit-action"><strong>{{ scope.row.actionLabel || scope.row.action }}</strong><span>{{ scope.row.action }}</span></div></template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.status === 'success' ? 'success' : 'danger'">{{ scope.row.status === "success" ? "成功" : "失败" }}</el-tag></template></el-table-column>
        <el-table-column label="耗时" width="100" align="right"><template #default="scope">{{ scope.row.durationMs !== undefined ? `${scope.row.durationMs} ms` : "—" }}</template></el-table-column>
        <el-table-column prop="source" label="来源" width="120" />
        <el-table-column label="关联" min-width="150"><template #default="scope">{{ relation(scope.row) }}</template></el-table-column>
        <el-table-column prop="errorSummary" label="错误摘要" min-width="190" show-overflow-tooltip />
        <el-table-column label="操作" width="80" fixed="right"><template #default="scope"><el-button link type="primary" @click="showDetail(scope.row)">详情</el-button></template></el-table-column>
      </el-table>
      <footer class="audit-pagination"><el-pagination v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total" :page-sizes="[20, 50, 100]" layout="sizes, prev, pager, next" background @current-change="load()" @size-change="load({ resetPage: true })" /></footer>
    </section>
    <el-drawer v-model="detailVisible" title="操作详情" size="min(620px, 96vw)">
      <dl v-if="detail" class="audit-detail-grid">
        <template v-for="item in [
          ['时间', formatDate(detail.occurredAt)], ['操作', detail.actionLabel || detail.action], ['请求', [detail.httpMethod, detail.requestPath].filter(Boolean).join(' ') || '—'],
          ['请求 ID', detail.requestId || '—'], ['状态', detail.status], ['耗时', detail.durationMs !== undefined ? `${detail.durationMs} ms` : '—'],
          ['来源', detail.source || '—'], ['主体', detail.actorIdentifier || '—'], ['关联', relation(detail)], ['错误码', detail.errorCode || '—'], ['错误摘要', detail.errorSummary || '—'],
        ]" :key="String(item[0])"><dt>{{ item[0] }}</dt><dd>{{ item[1] }}</dd></template>
      </dl>
      <section v-if="detail && Object.keys(detail.metadata || {}).length" class="audit-metadata"><h3>元数据</h3><pre>{{ JSON.stringify(detail.metadata, null, 2) }}</pre></section>
    </el-drawer>
  </div>
</template>

<style scoped>
.audit-vue-page { display: grid; gap: 16px; }
.audit-filter-grid { flex: 1; display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 8px; }
.audit-summary-strip { display: grid; grid-template-columns: .7fr .7fr .7fr 2fr; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); }
.audit-summary-strip > div { display: grid; gap: 5px; min-height: 90px; align-content: center; padding: 14px 18px; border-right: 1px solid var(--ops-border-light); }
.audit-summary-strip > div:last-child { border-right: 0; }
.audit-summary-strip span { color: var(--ops-text-secondary); font-size: 11px; }
.audit-summary-strip strong { font-size: 22px; }
.audit-summary-strip strong.success { color: var(--ops-success); }.audit-summary-strip strong.danger { color: var(--ops-danger); }
.audit-summary-strip strong.modules { font-size: 13px; line-height: 1.6; }
.audit-table-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); }
.audit-action { display: grid; gap: 3px; }.audit-action span { color: var(--ops-text-muted); font-size: 10px; }
.audit-pagination { display: flex; justify-content: flex-end; padding: 14px 16px; border-top: 1px solid var(--ops-border-light); }
.audit-detail-grid { display: grid; grid-template-columns: 120px 1fr; margin: 0; }
.audit-detail-grid dt, .audit-detail-grid dd { margin: 0; padding: 12px; border-bottom: 1px solid var(--ops-border-light); overflow-wrap: anywhere; }
.audit-detail-grid dt { color: var(--ops-text-secondary); font-size: 12px; }.audit-detail-grid dd { font-weight: 600; }
.audit-metadata { margin-top: 20px; }.audit-metadata pre { overflow: auto; padding: 14px; border-radius: 10px; background: #0f172a; color: #e2e8f0; font-size: 11px; }
@media (max-width: 1100px) { .audit-toolbar { align-items: stretch; flex-direction: column; }.audit-filter-grid { grid-template-columns: repeat(3, minmax(0,1fr)); }.audit-summary-strip { grid-template-columns: repeat(2, minmax(0,1fr)); } }
@media (max-width: 600px) { .audit-filter-grid { grid-template-columns: 1fr; }.audit-summary-strip { grid-template-columns: 1fr; }.audit-summary-strip > div { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }.audit-detail-grid { grid-template-columns: 1fr; } }
</style>
