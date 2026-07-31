<script setup lang="ts">
import { Menu, RefreshCw } from "@lucide/vue";
import { computed } from "vue";
import { useRoute } from "vue-router";
import GlobalFilterBar from "@/components/GlobalFilterBar.vue";
import OpsSidebar from "@/components/OpsSidebar.vue";
import { useWorkspaceStore } from "@/stores/workspace";

const route = useRoute();
const workspace = useWorkspaceStore();
const title = computed(() => String(route.meta.title || "Commerce Ops"));
const subtitle = computed(() => String(route.meta.subtitle || "跨境电商运营工作台"));
</script>

<template>
  <div class="ops-shell" :class="{ 'sidebar-collapsed': workspace.sidebarCollapsed }">
    <OpsSidebar />
    <el-drawer v-model="workspace.mobileNavigationOpen" direction="ltr" size="280px" :with-header="false" class="mobile-navigation-drawer">
      <OpsSidebar mobile />
    </el-drawer>
    <main class="ops-main" id="main-content">
      <header class="ops-topbar">
        <button class="mobile-menu-button" type="button" aria-label="打开主导航" @click="workspace.mobileNavigationOpen = true">
          <Menu :size="20" />
        </button>
        <div class="page-heading">
          <span class="page-kicker">COMMERCE OPERATIONS</span>
          <h1>{{ title }}</h1>
          <p>{{ subtitle }}</p>
        </div>
        <div class="topbar-status" aria-live="polite">
          <RefreshCw :size="15" />
          <span>{{ workspace.lastSyncedAt ? `更新于 ${workspace.lastSyncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '等待首次同步' }}</span>
        </div>
      </header>
      <GlobalFilterBar />
      <section class="page-content" tabindex="-1">
        <RouterView />
      </section>
    </main>
  </div>
</template>
