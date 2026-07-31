<script setup lang="ts">
import { ImageOff } from "@lucide/vue";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loadMabangAssetUrl } from "@/services/products";

const props = defineProps<{ assetId?: string | null; alt: string; count?: number }>();
const source = ref("");
const failed = ref(false);

function release() {
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = "";
}

async function load() {
  release();
  failed.value = false;
  if (!props.assetId) return;
  try {
    source.value = await loadMabangAssetUrl(props.assetId);
  } catch {
    failed.value = true;
  }
}

watch(() => props.assetId, load);
onMounted(load);
onBeforeUnmount(release);
</script>

<template>
  <div class="product-thumbnail" :class="{ empty: !source }">
    <img v-if="source" :src="source" :alt="alt" width="52" height="52" loading="lazy" />
    <ImageOff v-else :size="19" aria-hidden="true" />
    <span v-if="count">{{ count }} 张</span>
    <span v-else>{{ failed ? "加载失败" : "暂无图片" }}</span>
  </div>
</template>
