<script setup lang="ts">
import { RefreshCw, Sparkles } from "@lucide/vue";
import type { AiModuleAnalysis } from "@/services/sales-automation";

withDefaults(defineProps<{
  title: string;
  analysis?: AiModuleAnalysis | null;
  configured: boolean;
  loading: boolean;
  error?: string;
  generatedAt?: string;
  cached?: boolean;
  tone?: "neutral" | "decline" | "growth" | "opportunity" | "inventory" | "report";
}>(), { tone: "neutral" });

defineEmits<{ refresh: [] }>();

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";
}

function emphasisSegments(value?: string) {
  const source = String(value || "");
  const pattern = /(P[0-3]|[+-]?\d[\d,.]*(?:\.\d+)?%?|¥\s?[\d,.]+|￥\s?[\d,.]+|增长|上涨|下滑|下降|急降|到货|风险|机会|异常|优先|库存不足|数据不足)/gi;
  const result: Array<{ text: string; emphasis: boolean }> = [];
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > cursor) result.push({ text: source.slice(cursor, index), emphasis: false });
    result.push({ text: match[0], emphasis: true });
    cursor = index + match[0].length;
  }
  if (cursor < source.length) result.push({ text: source.slice(cursor), emphasis: false });
  return result;
}
</script>

<template>
  <section class="module-ai" :data-tone="tone" :aria-label="`${title} DeepSeek 分析`">
    <header class="module-ai-heading">
      <div class="module-ai-title">
        <span class="module-ai-icon"><Sparkles :size="19" /></span>
        <div><span>DeepSeek 证据分析</span><strong>{{ title }}</strong></div>
      </div>
      <el-button
        plain
        :icon="RefreshCw"
        :loading="loading"
        :disabled="!configured"
        :aria-label="`重新生成${title}分析`"
        @click="$emit('refresh')"
      >
        重新分析
      </el-button>
    </header>

    <el-alert v-if="error" type="warning" :closable="false" show-icon :title="error" />
    <div v-else-if="loading && !analysis" class="module-ai-loading">
      <el-skeleton :rows="4" animated />
    </div>
    <div v-else-if="analysis" class="module-ai-content">
      <div class="module-ai-summary">
        <span>核心判断</span>
        <h3><template v-for="(part, index) in emphasisSegments(analysis.headline)" :key="index"><mark v-if="part.emphasis">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></h3>
        <p><template v-for="(part, index) in emphasisSegments(analysis.summary)" :key="index"><mark v-if="part.emphasis">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
      </div>

      <ol v-if="analysis.findings.length" class="module-ai-findings" aria-label="分析证据">
        <li v-for="(fact, index) in analysis.findings.slice(0, 4)" :key="`${fact.title}-${index}`">
          <span>{{ String(index + 1).padStart(2, "0") }}</span>
          <div><strong>{{ fact.title }}</strong><p>{{ fact.reason }}</p><small>{{ fact.evidence.slice(0, 3).join(" · ") }}</small></div>
        </li>
      </ol>

      <div v-if="analysis.recommendations.length" class="module-ai-actions">
        <article v-for="item in analysis.recommendations.slice(0, 3)" :key="`${item.priority}-${item.title}`">
          <el-tag :type="item.priority === 'P0' ? 'danger' : item.priority === 'P1' ? 'warning' : 'info'">{{ item.priority }}</el-tag>
          <div>
            <strong>{{ item.title }}</strong>
            <p><template v-for="(part, index) in emphasisSegments(item.action)" :key="index"><mark v-if="part.emphasis">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
            <small v-if="item.evidence.length">依据：{{ item.evidence.slice(0, 3).join("；") }}</small>
          </div>
        </article>
      </div>

      <div v-if="analysis.dataLimitations.length" class="module-ai-limit">数据边界：{{ analysis.dataLimitations.slice(0, 2).join("；") }}</div>
      <small class="module-ai-meta">{{ formatDate(generatedAt) }}<template v-if="generatedAt"> · </template>{{ cached ? "已保存分析，仅人工重新分析时更新" : "本次人工分析已保存" }}</small>
    </div>
    <div v-else-if="!configured" class="module-ai-empty">DeepSeek 尚未配置，本模块暂不生成智能分析。</div>
    <div v-else class="module-ai-empty">当前结果没有包含本模块分析，点击“重新分析”生成。</div>
  </section>
</template>

<style scoped>
.module-ai {
  --ai-accent: #2457c5;
  --ai-soft: #eef4ff;
  --ai-border: #b9cdf5;
  display: grid;
  gap: 16px;
  min-width: 0;
  padding: 19px 20px 17px;
  border: 1px solid var(--ai-border);
  border-left: 5px solid var(--ai-accent);
  border-radius: 8px;
  background: #fbfdff;
  box-shadow: 0 10px 26px rgba(30, 64, 175, .08);
}
.module-ai[data-tone="decline"] { --ai-accent: #087f5b; --ai-soft: #edf9f4; --ai-border: #a8d9c7; background: #f9fdfa; }
.module-ai[data-tone="growth"] { --ai-accent: #c73545; --ai-soft: #fff0f1; --ai-border: #efb6bd; background: #fffafa; }
.module-ai[data-tone="opportunity"] { --ai-accent: #9a5b00; --ai-soft: #fff6e5; --ai-border: #efcf91; background: #fffdf8; }
.module-ai[data-tone="inventory"] { --ai-accent: #086f83; --ai-soft: #eaf8fb; --ai-border: #a9d9e2; background: #f9fdfe; }
.module-ai[data-tone="report"] { --ai-accent: #4a4fb1; --ai-soft: #f1f1ff; --ai-border: #c4c6ef; background: #fbfbff; }
.module-ai-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.module-ai-title { display: flex; align-items: center; gap: 11px; min-width: 0; }
.module-ai-icon { width: 38px; height: 38px; display: grid; place-items: center; flex: 0 0 auto; color: #fff; border-radius: 7px; background: var(--ai-accent); }
.module-ai-title > div { display: grid; gap: 2px; }
.module-ai-title span { color: var(--ai-accent); font-size: 11px; font-weight: 750; }
.module-ai-title strong { color: var(--ops-text); font-size: 16px; line-height: 1.25; }
.module-ai-content { display: grid; gap: 16px; }
.module-ai-summary { display: grid; gap: 7px; max-width: 1060px; }
.module-ai-summary > span { color: var(--ai-accent); font-size: 11px; font-weight: 800; }
.module-ai-summary h3 { margin: 0; color: var(--ops-text); font-size: 21px; line-height: 1.38; text-wrap: balance; }
.module-ai-summary p { margin: 0; color: var(--ops-text-secondary); font-size: 14px; line-height: 1.75; text-wrap: pretty; }
.module-ai mark { padding: 1px 3px; color: var(--ai-accent); background: var(--ai-soft); border-radius: 2px; font-weight: 800; }
.module-ai-findings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; padding: 0; border-top: 1px solid var(--ai-border); list-style: none; }
.module-ai-findings li { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 9px; padding: 13px 14px 13px 0; border-bottom: 1px solid var(--ai-border); }
.module-ai-findings li:nth-child(odd) { margin-right: 14px; }
.module-ai-findings li > span { color: var(--ai-accent); font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
.module-ai-findings li > div { display: grid; gap: 4px; min-width: 0; }
.module-ai-findings strong { font-size: 13px; line-height: 1.4; }
.module-ai-findings p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; line-height: 1.55; }
.module-ai-findings small { color: var(--ai-accent); font-size: 11px; line-height: 1.5; font-weight: 650; }
.module-ai-actions { display: grid; gap: 0; border-top: 1px solid var(--ai-border); }
.module-ai-actions article { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 11px; padding: 13px 0; border-bottom: 1px solid var(--ai-border); }
.module-ai-actions article > div { display: grid; gap: 4px; }
.module-ai-actions strong { font-size: 13px; }
.module-ai-actions p { margin: 0; color: var(--ops-text); font-size: 12.5px; line-height: 1.6; }
.module-ai-actions small { color: var(--ops-text-muted); font-size: 11px; line-height: 1.5; }
.module-ai-limit { padding: 9px 11px; color: var(--ops-text-secondary); border-left: 3px solid var(--ai-border); background: var(--ai-soft); font-size: 11px; line-height: 1.55; }
.module-ai-meta { color: var(--ops-text-muted); font-size: 10px; }
.module-ai-empty { padding: 13px 0; color: var(--ops-text-muted); font-size: 13px; }
.module-ai-loading { max-width: 720px; }
@media (max-width: 720px) {
  .module-ai { padding: 16px 15px; }
  .module-ai-heading { align-items: flex-start; }
  .module-ai-title strong { font-size: 15px; }
  .module-ai-summary h3 { font-size: 18px; }
  .module-ai-summary p { font-size: 13px; }
  .module-ai-findings { grid-template-columns: 1fr; }
  .module-ai-findings li:nth-child(odd) { margin-right: 0; }
}
</style>
