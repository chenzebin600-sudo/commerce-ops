<script setup lang="ts">
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed } from "vue";
import VChart from "vue-echarts";

use([CanvasRenderer, LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent]);
const props = defineProps<{ rows: Array<{ date: string; ownAmount: number; assortmentDailyAmount: number }> }>();

const option = computed(() => ({
  animationDuration: 220,
  color: ["#2563eb", "#94a3b8"],
  tooltip: { trigger: "axis", valueFormatter: (value: unknown) => Number(value || 0).toLocaleString("zh-CN") },
  legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: "#64748b" } },
  grid: { left: 16, right: 12, top: 42, bottom: 8, containLabel: true },
  xAxis: { type: "category", data: props.rows.map((row) => row.date.slice(5)), axisLine: { lineStyle: { color: "#dbe3ee" } }, axisTick: { show: false } },
  yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef2f7" } }, axisLabel: { color: "#64748b" } },
  series: [
    { name: "我方销售额", type: "line", smooth: true, symbolSize: 7, data: props.rows.map((row) => row.ownAmount), areaStyle: { color: "rgba(37,99,235,.08)" } },
    { name: "货盘日均额", type: "bar", barMaxWidth: 20, data: props.rows.map((row) => row.assortmentDailyAmount) },
  ],
}));
</script>

<template><VChart class="trend-chart" :option="option" autoresize /></template>
