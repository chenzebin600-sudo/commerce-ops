<script setup lang="ts">
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed } from "vue";
import VChart from "vue-echarts";

use([CanvasRenderer, LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent]);
type TrendRow = { date: string; ownAmount: number; assortmentDailyAmount: number };

const props = defineProps<{
  rows: TrendRow[];
  comparisonRows?: TrendRow[];
}>();

const chartData = computed(() => {
  const hasComparison = Boolean(props.comparisonRows?.length);
  if (!hasComparison) {
    return {
      hasComparison,
      categories: props.rows.map((row) => row.date.slice(5)),
      current: props.rows,
      previous: [] as Array<TrendRow | null>,
    };
  }

  const currentByDay = new Map(props.rows.map((row) => [Number(row.date.slice(8, 10)), row]));
  const previousByDay = new Map((props.comparisonRows || []).map((row) => [Number(row.date.slice(8, 10)), row]));
  const days = [...new Set([...currentByDay.keys(), ...previousByDay.keys()])].sort((left, right) => left - right);
  return {
    hasComparison,
    categories: days.map((day) => `${day}日`),
    current: days.map((day) => currentByDay.get(day) || null),
    previous: days.map((day) => previousByDay.get(day) || null),
  };
});

const option = computed(() => {
  const data = chartData.value;
  const currentOwn = data.current.map((row) => row?.ownAmount ?? null);
  const currentAssortment = data.current.map((row) => row?.assortmentDailyAmount ?? null);
  const series: Array<Record<string, unknown>> = [
    {
      name: data.hasComparison ? "我方 GMV · 本月" : "我方销售额",
      type: "line",
      yAxisIndex: 0,
      smooth: 0.24,
      symbol: "circle",
      symbolSize: 7,
      showSymbol: true,
      connectNulls: false,
      lineStyle: { width: 3, color: "#2563eb" },
      itemStyle: { color: "#2563eb", borderColor: "#ffffff", borderWidth: 2 },
      data: currentOwn,
      z: 5,
    },
    {
      name: data.hasComparison ? "货盘金额 · 本月" : "货盘日均额",
      type: "bar",
      yAxisIndex: 1,
      barMaxWidth: 18,
      itemStyle: { color: "#64748b", borderRadius: [3, 3, 0, 0] },
      data: currentAssortment,
      z: 2,
    },
  ];

  if (data.hasComparison) {
    series.splice(1, 0, {
      name: "我方 GMV · 上月同期",
      type: "line",
      yAxisIndex: 0,
      smooth: 0.24,
      symbol: "diamond",
      symbolSize: 7,
      showSymbol: true,
      connectNulls: false,
      lineStyle: { width: 2.5, type: "dashed", color: "#0f9f8f" },
      itemStyle: { color: "#0f9f8f", borderColor: "#ffffff", borderWidth: 2 },
      data: data.previous.map((row) => row?.ownAmount ?? null),
      z: 4,
    });
    series.push({
      name: "货盘金额 · 上月同期",
      type: "bar",
      yAxisIndex: 1,
      barMaxWidth: 18,
      itemStyle: { color: "#c5d0df", borderRadius: [3, 3, 0, 0] },
      data: data.previous.map((row) => row?.assortmentDailyAmount ?? null),
      z: 1,
    });
  }

  return {
    animationDuration: 220,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "#94a3b8", type: "dashed" } },
      valueFormatter: (value: unknown) => Number(value || 0).toLocaleString("zh-CN"),
    },
    legend: {
      top: 0,
      left: "center",
      itemWidth: 18,
      itemHeight: 8,
      itemGap: 18,
      textStyle: { color: "#475569", fontSize: 11 },
    },
    grid: { left: 18, right: 20, top: data.hasComparison ? 68 : 54, bottom: 10, containLabel: true },
    xAxis: {
      type: "category",
      data: data.categories,
      axisLine: { lineStyle: { color: "#dbe3ee" } },
      axisTick: { show: false },
      axisLabel: { color: "#64748b" },
    },
    yAxis: [
      {
        type: "value",
        name: "我方 GMV",
        nameTextStyle: { color: "#2563eb", fontSize: 10 },
        splitLine: { lineStyle: { color: "#eef2f7" } },
        axisLabel: { color: "#64748b", formatter: (value: number) => value >= 10000 ? `${Math.round(value / 1000)}k` : value },
      },
      {
        type: "value",
        name: "货盘金额",
        nameTextStyle: { color: "#64748b", fontSize: 10 },
        splitLine: { show: false },
        axisLabel: { color: "#94a3b8", formatter: (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : value >= 10000 ? `${Math.round(value / 1000)}k` : value },
      },
    ],
    series,
  };
});
</script>

<template><VChart class="trend-chart" :option="option" autoresize /></template>
