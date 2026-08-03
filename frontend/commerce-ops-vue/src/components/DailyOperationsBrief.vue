<script setup lang="ts">
import { AlertTriangle, ArrowDownRight, Boxes, PackageSearch, Store } from "@lucide/vue";
import type { PriorityAlert, SalesDashboard } from "@/services/overview";

defineProps<{
  report?: SalesDashboard["dailyReport"];
  alerts: PriorityAlert[];
}>();

function iconFor(type: PriorityAlert["type"]) {
  if (type === "store_decline") return Store;
  if (type === "product_decline") return ArrowDownRight;
  if (type === "inventory_risk") return Boxes;
  return PackageSearch;
}

function tagType(priority: PriorityAlert["priority"]) {
  if (priority === "P0") return "danger";
  if (priority === "P1") return "warning";
  return "info";
}
</script>

<template>
  <section class="dashboard-panel daily-brief" aria-label="销售与货盘经营日报">
    <header>
      <div><span class="panel-kicker">DAILY OPERATIONS BRIEF</span><h3>{{ report?.title || "经营重点日报" }}</h3></div>
      <div class="brief-date"><AlertTriangle :size="15" /><span>{{ report?.reportDate || "等待订单数据" }}</span></div>
    </header>
    <div class="brief-summary">
      <div><span>P0 / P1 事项</span><strong>{{ report?.summary.priorityCount ?? 0 }}</strong></div>
      <div><span>店铺下滑</span><strong>{{ report?.summary.storeAnomalyCount ?? 0 }}</strong></div>
      <div><span>店铺增长</span><strong>{{ report?.summary.storeGrowthCount ?? 0 }}</strong></div>
      <div><span>款名下滑</span><strong>{{ report?.summary.styleAnomalyCount ?? 0 }}</strong></div>
      <div><span>款名增长</span><strong>{{ report?.summary.styleGrowthCount ?? 0 }}</strong></div>
      <div><span>重点库存变化</span><strong>{{ report?.summary.inventoryChangeCount ?? 0 }}</strong></div>
    </div>
    <div v-if="alerts.length" class="brief-items">
      <article v-for="item in alerts.slice(0, 8)" :key="item.id" :class="`priority-${item.priority.toLowerCase()}`">
        <component :is="iconFor(item.type)" :size="17" />
        <el-tag :type="tagType(item.priority)" size="small">{{ item.priority }}</el-tag>
        <div class="brief-copy"><strong>{{ item.title }}</strong><span>{{ item.summary }}</span><small>{{ item.action }}</small></div>
        <div class="brief-metric"><span>{{ item.metricLabel }}</span><strong>{{ item.metricValue }}</strong></div>
      </article>
    </div>
    <el-empty v-else :image-size="54" description="当前数据未发现需优先处理的确定性异常" />
  </section>
</template>

<style scoped>
.daily-brief > header { border-bottom: 0; }.brief-date { display: inline-flex; align-items: center; gap: 6px; color: var(--ops-text-secondary); }
.brief-summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-top: 1px solid var(--ops-border-light); border-bottom: 1px solid var(--ops-border-light); }
.brief-summary > div { display: grid; gap: 3px; padding: 12px 16px; border-right: 1px solid var(--ops-border-light); }.brief-summary > div:last-child { border-right: 0; }.brief-summary span { color: var(--ops-text-secondary); font-size: 10px; }.brief-summary strong { font-size: 22px; line-height: 1; font-variant-numeric: tabular-nums; }
.brief-items { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.brief-items article { min-width: 0; display: grid; grid-template-columns: 18px auto minmax(0,1fr) auto; align-items: start; gap: 9px; padding: 13px 16px; border-bottom: 1px solid var(--ops-border-light); border-left: 3px solid transparent; }.brief-items article:nth-child(odd) { border-right: 1px solid var(--ops-border-light); }.brief-items article.priority-p0 { border-left-color: #dc2626; }.brief-items article.priority-p1 { border-left-color: #f59e0b; }.brief-items article.priority-p2 { border-left-color: #2563eb; }
.brief-copy { min-width: 0; display: grid; gap: 3px; }.brief-copy strong { overflow: hidden; color: var(--ops-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.brief-copy span,.brief-copy small { color: var(--ops-text-secondary); font-size: 10px; line-height: 1.45; }.brief-copy small { color: var(--ops-text-muted); }
.brief-metric { display: grid; justify-items: end; gap: 2px; white-space: nowrap; }.brief-metric span { color: var(--ops-text-muted); font-size: 9px; }.brief-metric strong { color: var(--ops-danger); font-size: 17px; font-variant-numeric: tabular-nums; }
@media (max-width: 900px) { .brief-items { grid-template-columns: 1fr; }.brief-items article:nth-child(odd) { border-right: 0; } }
@media (max-width: 900px) { .brief-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }.brief-summary > div:nth-child(3n) { border-right: 0; }.brief-summary > div:nth-child(-n+3) { border-bottom: 1px solid var(--ops-border-light); } }
@media (max-width: 620px) { .brief-summary { grid-template-columns: repeat(2,1fr); }.brief-summary > div:nth-child(3n) { border-right: 1px solid var(--ops-border-light); }.brief-summary > div:nth-child(2n) { border-right: 0; }.brief-summary > div:nth-child(-n+4) { border-bottom: 1px solid var(--ops-border-light); }.brief-items article { grid-template-columns: 18px auto minmax(0,1fr); }.brief-metric { grid-column: 3; justify-items: start; } }
</style>
