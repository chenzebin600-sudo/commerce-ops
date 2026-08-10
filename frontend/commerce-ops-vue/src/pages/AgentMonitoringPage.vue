<script setup lang="ts">
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  Coins,
  RefreshCw,
  Search,
  ShieldCheck,
  Wrench,
  XCircle,
} from "@lucide/vue";
import dayjs from "dayjs";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import AgentRunTrendChart from "@/components/AgentRunTrendChart.vue";
import AgentToolUsageChart from "@/components/AgentToolUsageChart.vue";
import {
  loadAgentObservabilityStatus,
  loadAgentObservabilitySummary,
  loadAgentRunDetail,
  loadAgentRuns,
  type AgentObservabilityStatus,
  type AgentObservabilitySummary,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunFilters,
  type AgentRunStatus,
} from "@/services/agent-observability";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(true);
const detailLoading = ref(false);
const error = ref("");
const status = ref<AgentObservabilityStatus | null>(null);
const summary = ref<AgentObservabilitySummary>({
  totalRuns: 0,
  runningRuns: 0,
  succeededRuns: 0,
  failedRuns: 0,
  successRate: null,
  averageDurationMs: null,
  toolCalls: 0,
  totalTokens: 0,
});
const runs = ref<AgentRun[]>([]);
const trendRuns = ref<AgentRun[]>([]);
const total = ref(0);
const detailVisible = ref(false);
const detail = ref<AgentRunDetail | null>(null);
const agentOptions = ref<string[]>([]);
const dateRange = ref<[string, string]>([
  dayjs().subtract(6, "day").format("YYYY-MM-DD"),
  dayjs().format("YYYY-MM-DD"),
]);
const query = reactive({
  page: 1,
  pageSize: 25,
  agent: "",
  status: "" as AgentRunStatus | "",
  requestId: "",
});
let loadController: AbortController | null = null;
let detailController: AbortController | null = null;

const isReady = computed(() => Boolean(status.value?.ready));
const evaluationVersion = computed(() => {
  const value = String(status.value?.evaluationModel?.contractVersion || status.value?.evaluationModel?.version || "1.0.0");
  return value.match(/\d+\.\d+\.\d+$/)?.[0] || value;
});
const toolFailureRate = computed(() => {
  const calls = trendRuns.value.reduce((sum, run) => sum + Number(run.toolCalls.total || 0), 0);
  const failed = trendRuns.value.reduce((sum, run) => sum + Number(run.toolCalls.failed || 0), 0);
  return calls ? failed / calls * 100 : null;
});

function filters(includePage = true): AgentRunFilters {
  const [start, end] = dateRange.value || [];
  return {
    agent: query.agent || undefined,
    status: query.status || undefined,
    requestId: query.requestId.trim() || undefined,
    start: start ? dayjs(start).startOf("day").toISOString() : undefined,
    end: end ? dayjs(end).endOf("day").toISOString() : undefined,
    page: includePage ? query.page : undefined,
    pageSize: includePage ? query.pageSize : undefined,
  };
}

function statusLabel(value: AgentRunStatus) {
  return value === "succeeded" ? "成功" : value === "failed" ? "失败" : "运行中";
}

function statusType(value: AgentRunStatus) {
  return value === "succeeded" ? "success" : value === "failed" ? "danger" : "warning";
}

function formatDate(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "—";
}

function formatDuration(value?: number | null) {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return `${value.toLocaleString("zh-CN")} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} 秒`;
  return `${Math.floor(value / 60_000)}分 ${Math.round(value % 60_000 / 1_000)}秒`;
}

function formatNumber(value?: number | null) {
  return value === null || value === undefined ? "—" : value.toLocaleString("zh-CN");
}

function compactId(value?: string | null) {
  if (!value) return "—";
  return value.length > 22 ? `${value.slice(0, 9)}…${value.slice(-8)}` : value;
}

function appendAgentOptions(items: AgentRun[]) {
  const names = new Set(agentOptions.value);
  for (const run of items) if (run.agent.name) names.add(run.agent.name);
  agentOptions.value = [...names].sort();
}

async function load({ resetPage = false } = {}) {
  if (resetPage) query.page = 1;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  error.value = "";
  try {
    const baseFilters = filters(false);
    const [statusResult, summaryResult, pageResult, trendResult] = await Promise.all([
      loadAgentObservabilityStatus(controller.signal),
      loadAgentObservabilitySummary(baseFilters, controller.signal),
      loadAgentRuns(filters(true), controller.signal),
      loadAgentRuns({ ...baseFilters, page: 1, pageSize: 100 }, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    status.value = statusResult;
    summary.value = summaryResult;
    runs.value = pageResult.items || [];
    trendRuns.value = trendResult.items || [];
    total.value = pageResult.total || 0;
    appendAgentOptions(trendResult.items || []);
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    if (controller.signal.aborted) return;
    error.value = String((loadError as Error)?.message || loadError || "Agent 监控数据加载失败");
  } finally {
    if (loadController === controller) {
      loadController = null;
      loading.value = false;
    }
  }
}

async function showDetail(run: AgentRun) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await loadAgentRunDetail(run.runId, controller.signal);
  } catch (loadError) {
    if (!controller.signal.aborted) {
      error.value = String((loadError as Error)?.message || loadError || "Agent 运行详情加载失败");
    }
  } finally {
    if (detailController === controller) {
      detailController = null;
      detailLoading.value = false;
    }
  }
}

function reset() {
  Object.assign(query, { page: 1, pageSize: 25, agent: "", status: "", requestId: "" });
  dateRange.value = [dayjs().subtract(6, "day").format("YYYY-MM-DD"), dayjs().format("YYYY-MM-DD")];
  load();
}

onMounted(load);
onBeforeUnmount(() => {
  loadController?.abort();
  detailController?.abort();
});
</script>

<template>
  <div class="agent-monitor-page" v-loading="loading">
    <section class="agent-commandbar">
      <div class="runtime-state">
        <span class="runtime-indicator" :class="{ ready: isReady }" aria-hidden="true" />
        <div>
          <strong>{{ isReady ? "Agent Runtime 可观测" : "观测存储暂不可用" }}</strong>
          <span>{{ status?.storage || "operation_audit_events" }} · Evaluation {{ evaluationVersion }}</span>
        </div>
      </div>
      <div class="runtime-actions">
        <span class="active-run-count"><Activity :size="16" /> 活跃运行 {{ status?.activeRuns || 0 }}</span>
        <el-button :icon="RefreshCw" :loading="loading" @click="load()">刷新</el-button>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error">
      <template #default><el-button size="small" @click="load()">重新加载</el-button></template>
    </el-alert>

    <section class="agent-filterbar" aria-label="Agent 运行筛选">
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        unlink-panels
        :clearable="false"
      />
      <el-select v-model="query.agent" placeholder="全部 Agent" clearable filterable>
        <el-option v-for="agent in agentOptions" :key="agent" :label="agent" :value="agent" />
      </el-select>
      <el-select v-model="query.status" placeholder="全部状态" clearable>
        <el-option label="成功" value="succeeded" />
        <el-option label="失败" value="failed" />
        <el-option label="运行中" value="running" />
      </el-select>
      <el-input v-model="query.requestId" placeholder="Request ID" clearable @keyup.enter="load({ resetPage: true })" />
      <div class="agent-filter-actions">
        <el-button @click="reset">重置</el-button>
        <el-button type="primary" :icon="Search" @click="load({ resetPage: true })">查询</el-button>
      </div>
    </section>

    <section class="agent-metric-band" aria-label="Agent 运行核心指标">
      <div class="agent-metric-cell">
        <span class="metric-icon total"><Bot :size="19" /></span>
        <div><span>运行总数</span><strong>{{ formatNumber(summary.totalRuns) }}</strong><small>当前筛选范围</small></div>
      </div>
      <div class="agent-metric-cell">
        <span class="metric-icon success"><CheckCircle2 :size="19" /></span>
        <div><span>成功率</span><strong>{{ summary.successRate === null ? "—" : `${summary.successRate.toFixed(1)}%` }}</strong><small>{{ summary.succeededRuns }} 成功 / {{ summary.failedRuns }} 失败</small></div>
      </div>
      <div class="agent-metric-cell">
        <span class="metric-icon danger"><XCircle :size="19" /></span>
        <div><span>失败运行</span><strong>{{ formatNumber(summary.failedRuns) }}</strong><small>需检查错误码与 Tool 链路</small></div>
      </div>
      <div class="agent-metric-cell">
        <span class="metric-icon duration"><Clock3 :size="19" /></span>
        <div><span>平均耗时</span><strong>{{ formatDuration(summary.averageDurationMs) }}</strong><small>仅已完成运行</small></div>
      </div>
      <div class="agent-metric-cell">
        <span class="metric-icon tool"><Wrench :size="19" /></span>
        <div><span>Tool 调用</span><strong>{{ formatNumber(summary.toolCalls) }}</strong><small>最近 {{ trendRuns.length }} 次运行失败率 {{ toolFailureRate === null ? "—" : `${toolFailureRate.toFixed(1)}%` }}</small></div>
      </div>
      <div class="agent-metric-cell">
        <span class="metric-icon tokens"><Coins :size="19" /></span>
        <div><span>Token 总量</span><strong>{{ formatNumber(summary.totalTokens) }}</strong><small>由 Tool usage 汇总</small></div>
      </div>
    </section>

    <section class="agent-chart-grid">
      <article class="dashboard-panel agent-chart-panel">
        <header>
          <div><span class="panel-kicker">RUN HEALTH</span><h3>运行量与成功率</h3></div>
          <span>最近 {{ trendRuns.length }} 次运行</span>
        </header>
        <AgentRunTrendChart v-if="trendRuns.length" :runs="trendRuns" />
        <el-empty v-else description="当前范围内暂无 Agent 运行" />
      </article>
      <article class="dashboard-panel agent-chart-panel">
        <header>
          <div><span class="panel-kicker">TOOL USAGE</span><h3>Tool 调用分布</h3></div>
          <ShieldCheck :size="18" />
        </header>
        <AgentToolUsageChart v-if="trendRuns.some((run) => run.toolCalls.total)" :runs="trendRuns" />
        <el-empty v-else description="暂无 Tool 调用记录" />
      </article>
    </section>

    <section class="dashboard-panel agent-run-panel">
      <header>
        <div><span class="panel-kicker">RUN EXPLORER</span><h3>Agent 运行记录</h3></div>
        <span>共 {{ total.toLocaleString("zh-CN") }} 条</span>
      </header>
      <el-table :data="runs" stripe table-layout="fixed" empty-text="暂无符合条件的 Agent 运行">
        <el-table-column label="开始时间" width="170"><template #default="scope">{{ formatDate(scope.row.startedAt) }}</template></el-table-column>
        <el-table-column label="Agent" min-width="205">
          <template #default="scope"><div class="agent-identity"><strong>{{ scope.row.agent.name || "未知 Agent" }}</strong><span>v{{ scope.row.agent.version || "—" }}</span></div></template>
        </el-table-column>
        <el-table-column label="状态" width="92"><template #default="scope"><el-tag :type="statusType(scope.row.status)" effect="light">{{ statusLabel(scope.row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="耗时" width="116" align="right"><template #default="scope">{{ formatDuration(scope.row.durationMs) }}</template></el-table-column>
        <el-table-column label="Tool" width="105" align="right"><template #default="scope"><strong class="tabular">{{ scope.row.toolCalls.total }}</strong><span v-if="scope.row.toolCalls.failed" class="tool-failure"> / {{ scope.row.toolCalls.failed }} 失败</span></template></el-table-column>
        <el-table-column label="Token" width="115" align="right"><template #default="scope">{{ formatNumber(scope.row.tokens.total) }}</template></el-table-column>
        <el-table-column label="Context" min-width="180" show-overflow-tooltip><template #default="scope">{{ scope.row.resolvedContextVersions.join(" · ") || scope.row.contextVersions.join(" · ") || "—" }}</template></el-table-column>
        <el-table-column label="Request ID" min-width="185"><template #default="scope"><code :title="scope.row.requestId">{{ compactId(scope.row.requestId) }}</code></template></el-table-column>
        <el-table-column label="操作" width="78" fixed="right"><template #default="scope"><el-button link type="primary" @click="showDetail(scope.row)">链路</el-button></template></el-table-column>
      </el-table>
      <footer class="agent-pagination">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[10, 25, 50, 100]"
          layout="sizes, prev, pager, next"
          background
          @current-change="load()"
          @size-change="load({ resetPage: true })"
        />
      </footer>
    </section>

    <el-drawer v-model="detailVisible" title="Agent 运行链路" size="min(760px, 100vw)" destroy-on-close>
      <div v-loading="detailLoading" class="agent-detail">
        <template v-if="detail">
          <section class="detail-hero">
            <div>
              <el-tag :type="statusType(detail.status)" effect="dark">{{ statusLabel(detail.status) }}</el-tag>
              <span>{{ formatDate(detail.startedAt) }}</span>
            </div>
            <h2>{{ detail.agent.name || "未知 Agent" }}</h2>
            <p>v{{ detail.agent.version || "—" }} · {{ formatDuration(detail.durationMs) }}</p>
          </section>

          <dl class="detail-facts">
            <div><dt>Run ID</dt><dd>{{ detail.runId }}</dd></div>
            <div><dt>Request ID</dt><dd>{{ detail.requestId }}</dd></div>
            <div><dt>Context</dt><dd>{{ detail.resolvedContextVersions.join(" · ") || detail.contextVersions.join(" · ") || "—" }}</dd></div>
            <div><dt>Token</dt><dd>{{ formatNumber(detail.tokens.total) }}（输入 {{ formatNumber(detail.tokens.input) }} / 输出 {{ formatNumber(detail.tokens.output) }}）</dd></div>
            <div><dt>结果摘要</dt><dd>{{ detail.result.status || "—" }} · {{ formatNumber(detail.result.bytes) }} bytes</dd></div>
            <div v-if="detail.errorCode"><dt>错误码</dt><dd class="danger-text">{{ detail.errorCode }}</dd></div>
          </dl>

          <section class="detail-section">
            <header><div><span class="panel-kicker">TOOL TRACE</span><h3>Tool 调用链</h3></div><span>{{ detail.toolInvocations.length }} 次</span></header>
            <el-timeline v-if="detail.toolInvocations.length" class="tool-timeline">
              <el-timeline-item
                v-for="tool in detail.toolInvocations"
                :key="tool.id"
                :timestamp="formatDate(tool.occurredAt)"
                placement="top"
                :type="tool.status === 'succeeded' ? 'success' : 'danger'"
              >
                <div class="tool-trace-item">
                  <div class="tool-trace-heading"><strong>{{ tool.tool.name || "未知 Tool" }}</strong><el-tag size="small" :type="tool.status === 'succeeded' ? 'success' : 'danger'">{{ tool.status === "succeeded" ? "成功" : "失败" }}</el-tag></div>
                  <span>v{{ tool.tool.version || "—" }} · {{ formatDuration(tool.durationMs) }} · {{ tool.access || "—" }}</span>
                  <span>Token {{ formatNumber(tool.tokens.total) }} · 输入字段 {{ tool.input.keys.join("、") || "无" }}</span>
                  <code v-if="tool.errorCode">{{ tool.errorCode }}</code>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else :image-size="68" description="本次运行没有 Tool 调用" />
          </section>

          <section class="detail-section">
            <header><div><span class="panel-kicker">EVALUATION</span><h3>质量评估</h3></div><span>{{ detail.evaluations.length }} 项</span></header>
            <div v-if="detail.evaluations.length" class="evaluation-list">
              <article v-for="evaluation in detail.evaluations" :key="evaluation.id">
                <div><strong>{{ evaluation.metric || "未命名指标" }}</strong><el-tag size="small" :type="evaluation.verdict === 'pass' ? 'success' : evaluation.verdict === 'fail' ? 'danger' : 'warning'">{{ evaluation.verdict || "未评估" }}</el-tag></div>
                <b>{{ evaluation.score === null ? "—" : evaluation.score.toFixed(1) }}</b>
                <span>{{ evaluation.evaluator.name || "—" }} · {{ evaluation.reasonCode || "无原因码" }}</span>
              </article>
            </div>
            <el-empty v-else :image-size="68" description="尚未记录质量评估" />
          </section>

          <p class="privacy-note"><ShieldCheck :size="16" /> 仅展示摘要、Digest 与字段名；原始 Prompt、Context 和 Tool 载荷不会写入观测记录。</p>
        </template>
        <el-empty v-else-if="!detailLoading" description="运行详情不可用" />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.agent-monitor-page { display: grid; gap: 16px; }
.agent-commandbar, .agent-filterbar { border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.agent-commandbar { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
.runtime-state, .runtime-actions, .active-run-count { display: flex; align-items: center; }
.runtime-state { gap: 11px; min-width: 0; }
.runtime-state > div { min-width: 0; display: grid; gap: 3px; }
.runtime-state strong { font-size: 14px; }
.runtime-state span:not(.runtime-indicator) { overflow: hidden; color: var(--ops-text-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.runtime-indicator { flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%; background: var(--ops-danger); box-shadow: 0 0 0 5px rgba(220, 38, 38, .08); }
.runtime-indicator.ready { background: var(--ops-success); box-shadow: 0 0 0 5px rgba(22, 163, 74, .09); }
.runtime-actions { gap: 12px; }
.active-run-count { gap: 6px; color: var(--ops-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.agent-filterbar { display: grid; grid-template-columns: minmax(280px, 1.35fr) repeat(3, minmax(150px, .8fr)) auto; gap: 10px; padding: 12px; }
.agent-filterbar :deep(.el-date-editor), .agent-filterbar :deep(.el-select) { width: 100%; }
.agent-filter-actions { display: flex; gap: 8px; }
.agent-metric-band { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.agent-metric-cell { min-height: 112px; display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: center; gap: 10px; padding: 14px; border-right: 1px solid var(--ops-border-light); }
.agent-metric-cell:last-child { border-right: 0; }
.agent-metric-cell > div { min-width: 0; display: grid; gap: 4px; }
.agent-metric-cell span:not(.metric-icon) { color: var(--ops-text-secondary); font-size: 11px; }
.agent-metric-cell strong { overflow: hidden; font-size: clamp(19px, 1.5vw, 25px); font-variant-numeric: tabular-nums; letter-spacing: 0; text-overflow: ellipsis; white-space: nowrap; }
.agent-metric-cell small { overflow: hidden; color: var(--ops-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.metric-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; color: #2563eb; background: #eff6ff; }
.metric-icon.success { color: #087f5b; background: #ecfdf5; }.metric-icon.danger { color: #c73545; background: #fff1f2; }
.metric-icon.duration { color: #8a5a00; background: #fff8e8; }.metric-icon.tool { color: #036f8b; background: #ecfeff; }.metric-icon.tokens { color: #6d4bc3; background: #f5f3ff; }
.agent-chart-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(340px, .85fr); gap: 16px; }
.agent-chart-panel { min-height: 365px; }
.agent-chart-panel :deep(.el-empty) { min-height: 300px; }
.agent-run-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); --el-table-border-color: var(--ops-border-light); }
.agent-identity { display: grid; gap: 3px; }.agent-identity span { color: var(--ops-text-muted); font-size: 11px; }
.tabular { font-variant-numeric: tabular-nums; }.tool-failure, .danger-text { color: var(--ops-danger); font-size: 10px; font-weight: 700; }
.agent-run-panel code { color: #475569; font-family: "Cascadia Code", Consolas, monospace; font-size: 11px; }
.agent-pagination { display: flex; justify-content: flex-end; padding: 14px 16px; border-top: 1px solid var(--ops-border-light); }
.agent-detail { min-height: 360px; }
.detail-hero { padding: 18px; border: 1px solid #dbeafe; border-radius: 10px; background: #f7fbff; }
.detail-hero > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--ops-text-secondary); font-size: 12px; }
.detail-hero h2 { margin: 16px 0 4px; font-size: 22px; letter-spacing: 0; overflow-wrap: anywhere; }.detail-hero p { margin: 0; color: var(--ops-text-secondary); }
.detail-facts { display: grid; grid-template-columns: 1fr 1fr; margin: 16px 0 0; border: 1px solid var(--ops-border-light); border-radius: 10px; }
.detail-facts > div { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--ops-border-light); border-bottom: 1px solid var(--ops-border-light); }
.detail-facts > div:nth-child(even) { border-right: 0; }.detail-facts > div:nth-last-child(-n + 2) { border-bottom: 0; }
.detail-facts dt { color: var(--ops-text-muted); font-size: 10px; }.detail-facts dd { margin: 5px 0 0; color: var(--ops-text); font-size: 12px; font-weight: 650; overflow-wrap: anywhere; }
.detail-section { margin-top: 18px; border-top: 1px solid var(--ops-border-light); }
.detail-section > header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--ops-text-secondary); font-size: 12px; }
.detail-section h3 { margin: 3px 0 0; color: var(--ops-text); font-size: 15px; }
.tool-timeline { padding: 8px 8px 0 4px; }
.tool-trace-item { display: grid; gap: 5px; padding: 12px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface-muted); }
.tool-trace-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.tool-trace-item span { color: var(--ops-text-secondary); font-size: 11px; overflow-wrap: anywhere; }.tool-trace-item code { color: var(--ops-danger); font-size: 11px; }
.evaluation-list { display: grid; gap: 8px; }.evaluation-list article { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; padding: 12px 14px; border: 1px solid var(--ops-border-light); border-radius: 8px; }.evaluation-list article > div { display: flex; align-items: center; gap: 8px; }.evaluation-list b { font-size: 20px; font-variant-numeric: tabular-nums; }.evaluation-list span { grid-column: 1 / -1; color: var(--ops-text-secondary); font-size: 11px; }
.privacy-note { display: flex; align-items: flex-start; gap: 8px; margin: 18px 0 0; padding: 12px 14px; border-radius: 8px; color: #365f55; background: #f0f9f6; font-size: 11px; line-height: 1.6; }
@media (max-width: 1380px) { .agent-metric-band { grid-template-columns: repeat(3, minmax(0, 1fr)); }.agent-metric-cell:nth-child(3) { border-right: 0; }.agent-metric-cell:nth-child(-n + 3) { border-bottom: 1px solid var(--ops-border-light); }.agent-filterbar { grid-template-columns: repeat(4, minmax(0, 1fr)); }.agent-filterbar > :first-child { grid-column: span 2; }.agent-filter-actions { justify-content: flex-end; } }
@media (max-width: 1024px) { .agent-chart-grid { grid-template-columns: 1fr; }.agent-chart-panel { min-height: 350px; } }
@media (max-width: 760px) { .agent-commandbar { align-items: stretch; flex-direction: column; }.runtime-actions { justify-content: space-between; }.agent-filterbar { grid-template-columns: 1fr 1fr; }.agent-filterbar > :first-child { grid-column: 1 / -1; }.agent-filter-actions { grid-column: 1 / -1; }.agent-filter-actions .el-button { flex: 1; }.agent-metric-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }.agent-metric-cell:nth-child(3) { border-right: 1px solid var(--ops-border-light); }.agent-metric-cell:nth-child(even) { border-right: 0; }.agent-metric-cell:nth-child(-n + 4) { border-bottom: 1px solid var(--ops-border-light); }.detail-facts { grid-template-columns: 1fr; }.detail-facts > div { border-right: 0; }.detail-facts > div:nth-last-child(2) { border-bottom: 1px solid var(--ops-border-light); } }
@media (max-width: 430px) { .agent-filterbar, .agent-metric-band { grid-template-columns: 1fr; }.agent-filterbar > :first-child, .agent-filter-actions { grid-column: 1; }.agent-metric-cell, .agent-metric-cell:nth-child(3) { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }.agent-metric-cell:last-child { border-bottom: 0; }.agent-pagination { justify-content: center; overflow: hidden; }.agent-pagination :deep(.el-pagination__sizes), .agent-pagination :deep(.el-pager) { display: none; } }
</style>
