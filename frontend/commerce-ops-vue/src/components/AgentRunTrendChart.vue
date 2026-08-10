<script setup lang="ts">
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed } from "vue";
import VChart from "vue-echarts";
import type { AgentRun } from "@/services/agent-observability";

use([CanvasRenderer, BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent]);

const props = defineProps<{ runs: AgentRun[] }>();

const option = computed(() => {
  const buckets = new Map<string, { succeeded: number; failed: number; running: number }>();
  for (const run of props.runs) {
    const date = String(run.startedAt || "").slice(0, 10);
    if (!date) continue;
    const bucket = buckets.get(date) || { succeeded: 0, failed: 0, running: 0 };
    bucket[run.status] += 1;
    buckets.set(date, bucket);
  }
  const rows = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right));
  const successRates = rows.map(([, row]) => {
    const completed = row.succeeded + row.failed;
    return completed ? Number((row.succeeded / completed * 100).toFixed(1)) : null;
  });
  return {
    animationDuration: 220,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { top: 0, left: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: "#5f6f86", fontSize: 11 } },
    grid: { left: 16, right: 18, top: 48, bottom: 10, containLabel: true },
    xAxis: {
      type: "category",
      data: rows.map(([date]) => date.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#dbe3ee" } },
      axisLabel: { color: "#64748b" },
    },
    yAxis: [
      {
        type: "value",
        minInterval: 1,
        splitLine: { lineStyle: { color: "#eef2f7" } },
        axisLabel: { color: "#64748b" },
      },
      {
        type: "value",
        min: 0,
        max: 100,
        splitLine: { show: false },
        axisLabel: { color: "#64748b", formatter: "{value}%" },
      },
    ],
    series: [
      {
        name: "成功",
        type: "bar",
        stack: "runs",
        barMaxWidth: 24,
        itemStyle: { color: "#16875d", borderRadius: [0, 0, 3, 3] },
        data: rows.map(([, row]) => row.succeeded),
      },
      {
        name: "失败",
        type: "bar",
        stack: "runs",
        barMaxWidth: 24,
        itemStyle: { color: "#d14a4a", borderRadius: [3, 3, 0, 0] },
        data: rows.map(([, row]) => row.failed),
      },
      {
        name: "运行中",
        type: "bar",
        stack: "runs",
        barMaxWidth: 24,
        itemStyle: { color: "#d69020", borderRadius: [3, 3, 0, 0] },
        data: rows.map(([, row]) => row.running),
      },
      {
        name: "成功率",
        type: "line",
        yAxisIndex: 1,
        smooth: 0.2,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2.5, color: "#2563eb" },
        itemStyle: { color: "#2563eb", borderColor: "#ffffff", borderWidth: 2 },
        data: successRates,
      },
    ],
  };
});
</script>

<template><VChart class="agent-run-trend-chart" :option="option" autoresize /></template>

<style scoped>
.agent-run-trend-chart { width: 100%; height: 300px; }
</style>
