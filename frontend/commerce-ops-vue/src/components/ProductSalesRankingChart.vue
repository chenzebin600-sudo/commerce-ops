<script setup lang="ts">
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed, ref } from "vue";
import VChart from "vue-echarts";
import type { ProductSalesRanking } from "@/services/overview";

use([CanvasRenderer, BarChart, GridComponent, TooltipComponent]);

const props = defineProps<{ rows: ProductSalesRanking[] }>();
const mode = ref<"amount" | "change">("amount");
const topRows = computed(() => props.rows.slice(0, 12));
const chartRows = computed(() => [...topRows.value].reverse());

function compactName(value: string) {
  return value.length > 13 ? `${value.slice(0, 13)}…` : value;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] || character));
}

const option = computed(() => ({
  animationDuration: 240,
  tooltip: {
    trigger: "item",
    formatter: (params: { dataIndex: number }) => {
      const row = chartRows.value[params.dataIndex];
      const change = row.changeRate === null ? "数据不足" : `${row.changeRate > 0 ? "+" : ""}${row.changeRate}%`;
      return [
        `<strong>${escapeHtml(row.productName)}</strong>`,
        `${escapeHtml(row.country)} · ${escapeHtml(row.categoryL1)}`,
        `标准化估值：¥${row.ownAmount.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`,
        `近7日变化：${change}`,
        `近7日排名：${row.current7dRank ?? "—"}（前7日 ${row.previous7dRank ?? "—"}）`,
      ].join("<br>");
    },
  },
  grid: { left: 12, right: 64, top: 12, bottom: 18, containLabel: true },
  xAxis: {
    type: "value",
    splitLine: { lineStyle: { color: "#eef2f7" } },
    axisLabel: { color: "#64748b", fontSize: 10, formatter: (value: number) => mode.value === "change" ? `${value}%` : value >= 10000 ? `${Math.round(value / 1000)}k` : value },
  },
  yAxis: {
    type: "category",
    data: chartRows.value.map((row) => `${row.rank}. ${compactName(row.productName)}`),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: "#334155", fontSize: 10 },
  },
  series: [{
    type: "bar",
    barMaxWidth: 18,
    data: chartRows.value.map((row) => ({
      value: mode.value === "amount" ? row.ownAmount : row.changeRate || 0,
      itemStyle: {
        color: mode.value === "amount"
          ? "#2563eb"
          : row.changeRate === null ? "#94a3b8" : row.changeRate < 0 ? "#087f5b" : "#d9485f",
        borderRadius: mode.value === "amount" || (row.changeRate || 0) >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3],
      },
    })),
    label: {
      show: true,
      position: "right",
      color: "#475569",
      fontSize: 10,
      formatter: (params: { dataIndex: number; value: number }) => mode.value === "amount"
        ? `¥${Number(params.value).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`
        : `${Number(params.value) > 0 ? "+" : ""}${params.value}%`,
    },
  }],
}));
</script>

<template>
  <div class="product-ranking-view">
    <div class="ranking-mode"><el-segmented v-model="mode" :options="[{ label: '标准化估值排行', value: 'amount' }, { label: '近7日变化', value: 'change' }]" /></div>
    <VChart v-if="topRows.length" class="product-ranking-chart" :option="option" autoresize />
    <el-empty v-else description="当前筛选无产品标准化估值排行" />
  </div>
</template>

<style scoped>
.product-ranking-view { padding: 10px 14px 0; }.ranking-mode { display: flex; justify-content: flex-end; min-height: 34px; }.product-ranking-chart { height: 340px; }
@media (max-width: 720px) { .product-ranking-chart { height: 360px; } }
</style>
