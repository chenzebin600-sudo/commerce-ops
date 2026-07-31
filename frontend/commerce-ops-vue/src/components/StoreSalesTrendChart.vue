<script setup lang="ts">
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed, ref, watch } from "vue";
import VChart from "vue-echarts";
import type { StoreSalesTrend } from "@/services/overview";

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent]);

const props = defineProps<{ rows: StoreSalesTrend[] }>();
const showAll = ref(false);
const selectedStores = ref<string[]>([]);

function rowKey(row: StoreSalesTrend) {
  return `${row.store}\u001f${row.country}\u001f${row.platform}`;
}

const priorityRows = computed(() => {
  const alerts = props.rows.filter((row) => row.priority === "P0" || row.priority === "P1");
  const selected = [...alerts, ...props.rows].filter((row, index, all) => (
    all.findIndex((candidate) => rowKey(candidate) === rowKey(row)) === index
  ));
  return selected.slice(0, 8);
});

watch(() => props.rows, () => {
  const available = new Set(props.rows.map(rowKey));
  selectedStores.value = selectedStores.value.filter((key) => available.has(key));
  if (!selectedStores.value.length) selectedStores.value = priorityRows.value.map(rowKey);
}, { immediate: true });

const visibleRows = computed(() => {
  if (showAll.value) return props.rows;
  const selected = new Set(selectedStores.value);
  return props.rows.filter((row) => selected.has(rowKey(row)));
});

const dates = computed(() => props.rows[0]?.points.map((point) => point.date) || []);
const palette = ["#2563eb", "#0f9f6e", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];
const option = computed(() => ({
  animationDuration: 240,
  color: palette,
  tooltip: {
    trigger: "axis",
    valueFormatter: (value: unknown) => `¥${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`,
  },
  legend: {
    type: "scroll",
    top: 0,
    left: 0,
    right: 8,
    itemWidth: 13,
    itemHeight: 7,
    textStyle: { color: "#64748b", fontSize: 10 },
  },
  grid: { left: 14, right: 16, top: 52, bottom: 44, containLabel: true },
  xAxis: {
    type: "category",
    boundaryGap: false,
    data: dates.value.map((date) => date.slice(5)),
    axisLine: { lineStyle: { color: "#dbe3ee" } },
    axisTick: { show: false },
    axisLabel: { color: "#64748b", fontSize: 10 },
  },
  yAxis: {
    type: "value",
    splitLine: { lineStyle: { color: "#eef2f7" } },
    axisLabel: { color: "#64748b", fontSize: 10, formatter: (value: number) => value >= 10000 ? `${Math.round(value / 1000)}k` : value },
  },
  dataZoom: dates.value.length > 14 ? [{ type: "inside", start: 0, end: 100 }, { type: "slider", height: 14, bottom: 6 }] : [],
  series: visibleRows.value.map((row) => ({
    name: row.store,
    type: "line",
    smooth: 0.25,
    showSymbol: dates.value.length <= 14,
    symbolSize: 5,
    lineStyle: { width: row.priority === "P0" || row.priority === "P1" ? 3 : 2 },
    data: row.points.map((point) => point.amount),
  })),
}));
</script>

<template>
  <div class="store-trend-view">
    <div class="chart-controls">
      <el-select v-model="selectedStores" multiple collapse-tags collapse-tags-tooltip filterable :disabled="showAll" placeholder="选择店铺">
        <el-option v-for="row in rows" :key="rowKey(row)" :label="`${row.store} · ${row.country}`" :value="rowKey(row)" />
      </el-select>
      <el-switch v-model="showAll" inline-prompt active-text="全部" inactive-text="重点" />
    </div>
    <VChart v-if="visibleRows.length" class="store-trend-chart" :option="option" autoresize />
    <el-empty v-else description="当前筛选无店铺趋势" />
    <div v-if="rows.some((row) => row.trendStatus === 'decline')" class="trend-alerts">
      <span v-for="row in rows.filter((item) => item.trendStatus === 'decline').slice(0, 4)" :key="rowKey(row)">
        <strong>{{ row.store }}</strong><b>{{ row.changeRate }}%</b>
      </span>
    </div>
  </div>
</template>

<style scoped>
.store-trend-view { position: relative; padding: 10px 14px 0; }
.chart-controls { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-height: 34px; }
.chart-controls :deep(.el-select) { width: min(430px, 72%); }
.store-trend-chart { height: 340px; }
.trend-alerts { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 9px 4px 12px; border-top: 1px solid var(--ops-border-light); color: var(--ops-text-secondary); font-size: 10px; }
.trend-alerts span { display: inline-flex; align-items: center; gap: 6px; }.trend-alerts strong { color: var(--ops-text); }.trend-alerts b { color: #087f5b; font-variant-numeric: tabular-nums; }
@media (max-width: 720px) { .chart-controls { align-items: stretch; flex-direction: column; }.chart-controls :deep(.el-select) { width: 100%; }.store-trend-chart { height: 300px; } }
</style>
