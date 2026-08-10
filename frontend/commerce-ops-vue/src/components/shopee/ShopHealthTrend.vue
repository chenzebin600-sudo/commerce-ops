<script setup lang="ts">
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed } from "vue";
import VChart from "vue-echarts";

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent]);

const props = defineProps<{ rows: Array<{ date: string; healthy: number; warning: number; critical: number }> }>();
const option = computed(() => ({
  animationDuration: 220,
  color: ["#16a34a", "#d97706", "#dc2626"],
  tooltip: { trigger: "axis", backgroundColor: "#172033", borderWidth: 0, textStyle: { color: "#fff" } },
  legend: { top: 0, right: 0, itemWidth: 18, itemHeight: 8, textStyle: { color: "#5f6f86", fontSize: 11 } },
  grid: { left: 12, right: 8, top: 42, bottom: 8, containLabel: true },
  xAxis: { type: "category", boundaryGap: false, data: props.rows.map((row) => row.date.slice(5)), axisTick: { show: false }, axisLine: { lineStyle: { color: "#dbe3ee" } }, axisLabel: { color: "#8a99ad" } },
  yAxis: { type: "value", minInterval: 1, splitLine: { lineStyle: { color: "#eaf0f6" } }, axisLabel: { color: "#8a99ad" } },
  series: [
    { name: "健康", type: "line", smooth: 0.25, symbolSize: 6, lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.05 }, data: props.rows.map((row) => row.healthy) },
    { name: "预警", type: "line", smooth: 0.25, symbolSize: 6, lineStyle: { width: 2.5 }, data: props.rows.map((row) => row.warning) },
    { name: "异常", type: "line", smooth: 0.25, symbolSize: 6, lineStyle: { width: 2.5 }, data: props.rows.map((row) => row.critical) },
  ],
}));
</script>

<template><VChart class="shop-health-trend" :option="option" autoresize /></template>

<style scoped>
.shop-health-trend { height: 330px; width: 100%; }
</style>
