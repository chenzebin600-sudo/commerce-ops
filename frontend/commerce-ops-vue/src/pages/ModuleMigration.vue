<script setup lang="ts">
import { ArrowUpRight, Construction } from "@lucide/vue";
import { computed } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const modules: Record<string, { title: string; description: string; legacy: string; phase: string }> = {
  products: { title: "产品中心", description: "产品包导入、字段映射、质量校验与来源追踪。", legacy: "#products", phase: "第二阶段" },
  "sales-assortment": { title: "销售与货盘驾驶舱", description: "国家、类目、款名与店铺经营对比。", legacy: "#sales-assortment", phase: "第一阶段" },
  "link-analysis": { title: "链接维度竞品分析", description: "跨平台商品抓取、匹配与价格分析。", legacy: "#link", phase: "第三阶段" },
  "keyword-analysis": { title: "关键词竞品分析", description: "按国家和平台分析关键词头部商品。", legacy: "#keyword", phase: "第三阶段" },
  "growth-radar": { title: "增长雷达", description: "异常、机会与今日运营任务。", legacy: "#/growth-radar/today", phase: "第一阶段" },
  advertising: { title: "广告分析", description: "计划、产品系列与推广链接表现诊断。", legacy: "#ads", phase: "第三阶段" },
  mabang: { title: "马帮数据", description: "订单、库存、SKU 图片与标准化导出。", legacy: "#/mabang/orders", phase: "第二阶段" },
  "mabang-listing": { title: "商品刊登", description: "刊登资料、价格与库存变更工作台。", legacy: "#mabang-listing", phase: "第二阶段" },
  fulfillment: { title: "履约中心", description: "订单扫描、自动发货和异常恢复。", legacy: "#fulfillment", phase: "第一阶段" },
  audit: { title: "操作记录", description: "关键操作、失败原因与任务关联审计。", legacy: "#audit", phase: "第三阶段" },
};
const module = computed(() => modules[String(route.params.module)] || modules.products);
const legacyUrl = computed(() => `/legacy/${module.value.legacy}`);
</script>

<template>
  <section class="migration-state">
    <div class="migration-icon"><Construction :size="30" /></div>
    <span class="panel-kicker">{{ module.phase }}</span>
    <h2>{{ module.title }}</h2>
    <p>{{ module.description }}</p>
    <div class="migration-note">Vue 页面迁移中。当前生产功能保持不变，可继续使用稳定版入口。</div>
    <el-button type="primary" tag="a" :href="legacyUrl" :icon="ArrowUpRight">打开当前稳定版</el-button>
  </section>
</template>
