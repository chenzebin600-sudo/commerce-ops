<script setup lang="ts">
import {
  BarChart3,
  BookOpenCheck,
  Boxes,
  Cable,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  CircleDollarSign,
  FileSearch,
  Headphones,
  LayoutDashboard,
  Megaphone,
  MonitorCog,
  Radar,
  ScanSearch,
  Send,
  ShoppingBag,
  Truck,
  WalletCards,
} from "@lucide/vue";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkspaceStore } from "@/stores/workspace";

defineProps<{ mobile?: boolean }>();
const route = useRoute();
const router = useRouter();
const workspace = useWorkspaceStore();

const groups = [
  { label: "经营", items: [
    { path: "/overview", label: "运营总览", icon: LayoutDashboard },
    { path: "/sales-assortment", label: "销售与货盘", icon: BarChart3 },
    { path: "/profit", label: "利润分析", icon: WalletCards },
    { path: "/price-control", label: "控价变更", icon: CircleDollarSign },
    { path: "/products", label: "产品中心", icon: Boxes },
    { path: "/product-knowledge", label: "产品知识库", icon: BookOpenCheck },
  ] },
  { label: "增长", items: [
    { path: "/link-analysis", label: "链接竞品", icon: ScanSearch },
    { path: "/keyword-analysis", label: "关键词竞品", icon: FileSearch },
    { path: "/growth-radar", label: "增长雷达", icon: Radar },
    { path: "/advertising", label: "广告分析", icon: Megaphone },
  ] },
  { label: "执行", items: [
    { path: "/mabang", label: "马帮数据", icon: ShoppingBag },
    { path: "/mabang-listing", label: "商品刊登", icon: Send },
    { path: "/fulfillment", label: "履约中心", icon: Truck },
    { path: "/customer-service", label: "客服中心", icon: Headphones },
  ] },
  { label: "治理", items: [
    { path: "/platform-connections", label: "平台 API 接入", icon: Cable },
    { path: "/agent-monitoring", label: "Agent 监控", icon: MonitorCog },
    { path: "/audit", label: "操作记录", icon: ClipboardCheck },
  ] },
];

const activePath = computed(() => route.path);
function navigate(path: string) {
  router.push(path);
  workspace.mobileNavigationOpen = false;
}
</script>

<template>
  <aside class="ops-sidebar" :class="{ mobile }" aria-label="主导航">
    <div class="brand-block">
      <div class="brand-mark">CO</div>
      <div class="brand-copy"><strong>Commerce Ops</strong><span>跨境运营工作台</span></div>
    </div>
    <nav class="sidebar-navigation">
      <section v-for="group in groups" :key="group.label" class="navigation-group">
        <span class="navigation-label">{{ group.label }}</span>
        <button
          v-for="item in group.items"
          :key="item.path"
          type="button"
          class="navigation-item"
          :class="{ active: activePath === item.path }"
          :aria-current="activePath === item.path ? 'page' : undefined"
          :title="workspace.sidebarCollapsed && !mobile ? item.label : undefined"
          @click="navigate(item.path)"
        >
          <component :is="item.icon" :size="19" />
          <span>{{ item.label }}</span>
        </button>
      </section>
    </nav>
    <button v-if="!mobile" class="sidebar-collapse" type="button" @click="workspace.sidebarCollapsed = !workspace.sidebarCollapsed">
      <ChevronRight v-if="workspace.sidebarCollapsed" :size="17" />
      <ChevronLeft v-else :size="17" />
      <span>收起导航</span>
    </button>
  </aside>
</template>
