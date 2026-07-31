<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { authorizedFetch } from "@/services/api";

const props = withDefaults(defineProps<{ source?: string; alt?: string; size?: number }>(), {
  source: "",
  alt: "商品图片",
  size: 56,
});

const root = ref<HTMLElement | null>(null);
const objectUrl = ref("");
const loading = ref(false);
const failed = ref(false);
const visible = ref(false);
let observer: IntersectionObserver | null = null;
let controller: AbortController | null = null;

const firstSource = computed(() => {
  const candidate = String(props.source || "").split(",")[0]?.trim() || "";
  return /^https?:\/\//i.test(candidate) ? candidate : "";
});

function disposeImage() {
  controller?.abort();
  controller = null;
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = "";
}

async function loadImage() {
  disposeImage();
  failed.value = false;
  if (!visible.value || !firstSource.value) {
    failed.value = !firstSource.value;
    return;
  }
  loading.value = true;
  controller = new AbortController();
  try {
    const response = await authorizedFetch(`/api/image?url=${encodeURIComponent(firstSource.value)}`, {
      cache: "force-cache",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`图片代理请求失败 (${response.status})`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("图片代理返回了非图片内容");
    objectUrl.value = URL.createObjectURL(blob);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) failed.value = true;
  } finally {
    loading.value = false;
  }
}

watch(firstSource, loadImage);
watch(visible, loadImage);

onMounted(() => {
  if (!root.value || !("IntersectionObserver" in window)) {
    visible.value = true;
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    visible.value = true;
    observer?.disconnect();
  }, { rootMargin: "240px" });
  observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  disposeImage();
});
</script>

<template>
  <span ref="root" class="marketplace-image" :style="{ width: `${size}px`, height: `${size}px` }">
    <img v-if="objectUrl" :src="objectUrl" :alt="alt" />
    <span v-else>{{ loading ? "加载中" : "暂无图片" }}</span>
  </span>
</template>

<style scoped>
.marketplace-image {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--ops-border-light);
  border-radius: 6px;
  background: var(--ops-surface-muted);
  color: var(--ops-text-secondary);
  font-size: 10px;
  text-align: center;
}
.marketplace-image img { width: 100%; height: 100%; object-fit: cover; }
</style>
