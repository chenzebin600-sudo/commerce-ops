import { defineStore } from "pinia";
import { computed, ref } from "vue";

export const useWorkspaceStore = defineStore("workspace", () => {
  const country = ref("");
  const platform = ref("");
  const shop = ref("");
  const periodDays = ref(30);
  const sidebarCollapsed = ref(false);
  const mobileNavigationOpen = ref(false);
  const lastSyncedAt = ref<Date | null>(null);

  const activeFilterCount = computed(() => [country.value, platform.value, shop.value].filter(Boolean).length);

  return {
    country,
    platform,
    shop,
    periodDays,
    sidebarCollapsed,
    mobileNavigationOpen,
    lastSyncedAt,
    activeFilterCount,
  };
});
