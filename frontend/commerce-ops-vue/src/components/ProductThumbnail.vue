<script setup lang="ts">
import { ImageOff } from "@lucide/vue";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loadMabangAssetUrl } from "@/services/products";

const props = defineProps<{ assetId?: string | null; alt: string; count?: number }>();
const root = ref<HTMLElement | null>(null);
const source = ref("");
const failed = ref(false);
const visible = ref(false);
let observer: IntersectionObserver | null = null;
let loadVersion = 0;

function release() {
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = "";
}

async function load() {
  const version = ++loadVersion;
  release();
  failed.value = false;
  if (!props.assetId || !visible.value) return;
  try {
    const objectUrl = await loadMabangAssetUrl(props.assetId);
    if (version !== loadVersion) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    source.value = objectUrl;
  } catch {
    if (version === loadVersion) failed.value = true;
  }
}

watch(() => props.assetId, load);
watch(visible, load);
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
  loadVersion += 1;
  observer?.disconnect();
  release();
});
</script>

<template>
  <div ref="root" class="product-thumbnail" :class="{ empty: !source }">
    <img v-if="source" :src="source" :alt="alt" width="52" height="52" loading="lazy" />
    <ImageOff v-else :size="19" aria-hidden="true" />
    <span v-if="count">{{ count }} 张</span>
    <span v-else>{{ failed ? "加载失败" : "暂无图片" }}</span>
  </div>
</template>
