<script setup lang="ts">
import { ExternalLink, FileSpreadsheet, RefreshCw } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { loadAdvertisingFiles, loadAdvertisingStatus } from "@/services/advertising";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const error = ref("");
const serviceUrl = ref("");
const files = ref<Array<Record<string, unknown>>>([]);
const total = ref(0);
const serviceOnline = computed(() => Boolean(serviceUrl.value));

function field(row: Record<string, unknown>, ...keys: string[]) { for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key]; return "—"; }
function formatDate(value: unknown) { return value ? new Date(String(value)).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function formatSize(value: unknown) { const bytes = Number(value || 0); return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`; }

async function load() {
  loading.value = true; error.value = "";
  const [statusResult, filesResult] = await Promise.allSettled([loadAdvertisingStatus(), loadAdvertisingFiles()]);
  if (statusResult.status === "fulfilled") serviceUrl.value = statusResult.value.url || "/ads/";
  else error.value = String(statusResult.reason?.message || statusResult.reason || "广告分析服务不可用");
  if (filesResult.status === "fulfilled") { files.value = filesResult.value.files || []; total.value = filesResult.value.total || files.value.length; }
  workspace.lastSyncedAt = new Date(); loading.value = false;
}

onMounted(load);
</script>

<template>
  <div class="advertising-vue-page" v-loading="loading">
    <section class="module-toolbar advertising-toolbar">
      <div class="service-summary"><span class="live-indicator" :class="{ active: serviceOnline }" /><div><strong>{{ serviceOnline ? "广告分析引擎在线" : "广告分析引擎离线" }}</strong><small>Lazada 广告报表分析侧车服务</small></div></div>
      <div class="module-toolbar-actions"><el-button :icon="RefreshCw" @click="load">重新连接</el-button><el-button v-if="serviceUrl" type="primary" :icon="ExternalLink" tag="a" :href="serviceUrl" target="_blank">打开分析器</el-button></div>
    </section>
    <el-alert v-if="error" type="warning" :closable="false" show-icon :title="error" description="广告分析引擎是独立服务；Vue 工作台会继续展示已登记的广告文件。" />
    <section class="advertising-overview">
      <article class="advertising-service-card"><div><span class="panel-kicker">ANALYZER</span><h2>广告经营诊断</h2><p>读取 Lazada 广告报表，诊断计划、产品系列和推广链接表现。分析计算仍由隔离的广告服务执行，主工作台负责认证、文件治理与结果追踪。</p></div><div class="service-path"><span>受控入口</span><strong>{{ serviceUrl || "等待服务启动" }}</strong></div></article>
      <article class="advertising-stat-card"><FileSpreadsheet :size="23" /><span>已登记广告文件</span><strong>{{ total.toLocaleString("zh-CN") }}</strong><small>源文件、分析结果与报告</small></article>
    </section>
    <section class="dashboard-panel advertising-files-panel">
      <header><div><span class="panel-kicker">CONTROLLED FILES</span><h3>广告文件记录</h3></div><span>统一文件治理</span></header>
      <el-table :data="files" stripe empty-text="暂无广告文件记录">
        <el-table-column label="文件" min-width="260"><template #default="scope"><div class="advertising-file-cell"><strong>{{ field(scope.row, "originalFilename", "filename", "name") }}</strong><span>{{ field(scope.row, "sourceType", "scope", "type") }}</span></div></template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="scope"><el-tag type="info">{{ field(scope.row, "status") }}</el-tag></template></el-table-column>
        <el-table-column label="大小" width="110" align="right"><template #default="scope">{{ formatSize(field(scope.row, "size", "fileSize")) }}</template></el-table-column>
        <el-table-column label="创建时间" width="180"><template #default="scope">{{ formatDate(field(scope.row, "createdAt", "created_at")) }}</template></el-table-column>
        <el-table-column label="文件 ID" min-width="220"><template #default="scope">{{ field(scope.row, "id") }}</template></el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.advertising-vue-page { display: grid; gap: 16px; }.advertising-overview { display: grid; grid-template-columns: minmax(0,1.8fr) minmax(230px,.55fr); gap: 14px; }.advertising-service-card,.advertising-stat-card { min-height: 180px; padding: 22px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }.advertising-service-card { display: flex; justify-content: space-between; gap: 24px; }.advertising-service-card h2 { margin: 5px 0 8px; }.advertising-service-card p { max-width: 670px; margin: 0; color: var(--ops-text-secondary); line-height: 1.7; }.service-path { min-width: 220px; display: grid; align-content: center; gap: 7px; padding: 14px; border-radius: 10px; background: var(--ops-surface-muted); }.service-path span { color: var(--ops-text-secondary); font-size: 11px; }.service-path strong { overflow-wrap: anywhere; font-size: 12px; }.advertising-stat-card { display: grid; align-content: center; gap: 7px; color: var(--ops-primary); }.advertising-stat-card span,.advertising-stat-card small { color: var(--ops-text-secondary); }.advertising-stat-card strong { color: var(--ops-text); font-size: 31px; }.advertising-files-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); }.advertising-file-cell { display: grid; gap: 4px; }.advertising-file-cell span { color: var(--ops-text-secondary); font-size: 11px; }
@media (max-width: 850px) { .advertising-overview { grid-template-columns: 1fr; }.advertising-service-card { flex-direction: column; } }
</style>
