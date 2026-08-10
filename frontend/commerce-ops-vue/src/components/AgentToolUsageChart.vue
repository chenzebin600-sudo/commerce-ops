<script setup lang="ts">
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed } from "vue";
import VChart from "vue-echarts";
import type { AgentRun } from "@/services/agent-observability";

use([CanvasRenderer, BarChart, GridComponent, TooltipComponent]);

const props = defineProps<{ runs: AgentRun[] }>();

function parseToolCall(entry: string) {
  const separator = entry.lastIndexOf(":");
  if (separator < 1) return { name: entry, count: 1 };
  return {
    name: entry.slice(0, separator),
    count: Number(entry.slice(separator + 1)) || 0,
  };
}

const option = computed(() => {
  const totals = new Map<string, number>();
  for (const run of props.runs) {
    for (const entry of run.toolCalls.byTool || []) {
      const tool = parseToolCall(entry);
      totals.set(tool.name, (totals.get(tool.name) || 0) + tool.count);
    }
  }
  const rows = [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 7)
    .reverse();
  return {
    animationDuration: 220,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 12, right: 24, top: 10, bottom: 10, containLabel: true },
    xAxis: {
      type: "value",
      minInterval: 1,
      splitLine: { lineStyle: { color: "#eef2f7" } },
      axisLabel: { color: "#64748b" },
    },
    yAxis: {
      type: "category",
      data: rows.map(([name]) => name),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: "#475569", width: 150, overflow: "truncate" },
    },
    series: [{
      name: "调用次数",
      type: "bar",
      barMaxWidth: 18,
      itemStyle: { color: "#3b82c4", borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: "right", color: "#475569", fontWeight: 700 },
      data: rows.map(([, count]) => count),
    }],
  };
});
</script>

<template><VChart class="agent-tool-usage-chart" :option="option" autoresize /></template>

<style scoped>
.agent-tool-usage-chart { width: 100%; height: 300px; }
</style>
