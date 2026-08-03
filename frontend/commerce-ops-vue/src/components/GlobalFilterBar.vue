<script setup lang="ts">
import { Download, Filter, RotateCcw } from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const periods = [7, 30, 60, 90];

function resetFilters() {
  workspace.country = "";
  workspace.platform = "";
  workspace.shop = "";
  workspace.periodDays = 30;
}
</script>

<template>
  <section class="global-filterbar" aria-label="全局业务筛选">
    <div class="filterbar-title"><Filter :size="17" /><span>全局口径</span></div>
    <el-select v-model="workspace.country" placeholder="全部国家" clearable aria-label="国家">
      <el-option label="印度尼西亚" value="ID" />
      <el-option label="菲律宾" value="PH" />
      <el-option label="泰国" value="TH" />
      <el-option label="马来西亚" value="MY" />
    </el-select>
    <el-select v-model="workspace.platform" placeholder="全部平台" clearable aria-label="平台">
      <el-option label="Shopee" value="Shopee" />
      <el-option label="Lazada" value="Lazada" />
      <el-option label="TikTok Shop" value="TikTok Shop" />
    </el-select>
    <el-select v-model="workspace.shop" placeholder="全部店铺" clearable aria-label="店铺" disabled>
      <el-option label="数据接入后可选" value="pending" />
    </el-select>
    <el-segmented v-model="workspace.periodDays" :options="periods" aria-label="统计周期">
      <template #default="{ item }">{{ item }} 天</template>
    </el-segmented>
    <div class="filterbar-actions">
      <el-button :icon="RotateCcw" aria-label="重置筛选" @click="resetFilters">重置</el-button>
      <el-button type="primary" :icon="Download" disabled>导出</el-button>
    </div>
  </section>
</template>
