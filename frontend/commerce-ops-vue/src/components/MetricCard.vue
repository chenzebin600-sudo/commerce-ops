<script setup lang="ts">
import { ArrowDownRight, ArrowUpRight, Minus } from "@lucide/vue";

withDefaults(defineProps<{
  label: string;
  value: string;
  hint?: string;
  trend?: number | null;
  tone?: "default" | "success" | "warning" | "danger";
}>(), { hint: "", trend: null, tone: "default" });
</script>

<template>
  <article class="metric-card" :class="`tone-${tone}`">
    <span class="metric-label">{{ label }}</span>
    <strong>{{ value }}</strong>
    <div class="metric-foot">
      <span v-if="trend !== null" class="metric-trend" :class="trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'">
        <ArrowUpRight v-if="trend > 0" :size="14" />
        <ArrowDownRight v-else-if="trend < 0" :size="14" />
        <Minus v-else :size="14" />
        {{ Math.abs(trend).toFixed(1) }}%
      </span>
      <span>{{ hint }}</span>
    </div>
  </article>
</template>
