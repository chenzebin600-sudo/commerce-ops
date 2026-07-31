<script setup lang="ts">
import { Boxes, Eye, FileSpreadsheet, ShoppingBag, Upload } from "@lucide/vue";
import type { SalesDashboard, SourceRecord } from "@/services/overview";
import type { SalesImportKind } from "@/services/sales-imports";

defineProps<{
  sources?: SalesDashboard["sourceStatus"];
  busyKind?: SalesImportKind | null;
}>();

defineEmits<{
  import: [kind: SalesImportKind];
  view: [kind: SalesImportKind];
}>();

const cards: Array<{
  kind: SalesImportKind;
  title: string;
  description: string;
  icon: typeof ShoppingBag;
  sourceKey: "order" | "inventory" | "productPackage";
}> = [
  { kind: "orders", title: "订单表", description: "人工追加有效订单", icon: ShoppingBag, sourceKey: "order" },
  { kind: "inventory", title: "库存表", description: "人工更新最新库存快照", icon: Boxes, sourceKey: "inventory" },
  { kind: "product-package", title: "产品包", description: "人工更新产品合同与标准价", icon: FileSpreadsheet, sourceKey: "productPackage" },
];

function sourceTime(source?: SourceRecord | null) {
  const value = source?.collected_at || source?.applied_at || source?.imported_at || source?.created_at;
  if (!value) return "等待首次导入";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
</script>

<template>
  <section class="source-imports" aria-label="销售与货盘人工数据导入">
    <header>
      <div><span class="panel-kicker">DATA SOURCES</span><h2>数据导入</h2></div>
      <p>人工导入与定时采集共用正式文件目录和事实数据表。</p>
    </header>
    <div class="source-card-grid">
      <article v-for="card in cards" :key="card.kind">
        <span class="source-icon"><component :is="card.icon" :size="19" /></span>
        <div>
          <strong>{{ card.title }}</strong>
          <span>{{ card.description }}</span>
          <small>
            {{ Number(sources?.[card.sourceKey]?.row_count || 0).toLocaleString("zh-CN") }} 行
            · {{ sourceTime(sources?.[card.sourceKey]) }}
          </small>
        </div>
        <div class="source-actions">
          <el-tooltip :content="`查看${card.title}数据`">
            <el-button :icon="Eye" circle :aria-label="`查看${card.title}数据`" @click="$emit('view', card.kind)" />
          </el-tooltip>
          <el-tooltip :content="`导入${card.title}`">
            <el-button
              :icon="Upload"
              circle
              :loading="busyKind === card.kind"
              :aria-label="`导入${card.title}`"
              @click="$emit('import', card.kind)"
            />
          </el-tooltip>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.source-imports { display: grid; gap: 10px; }.source-imports > header { display: flex; align-items: end; justify-content: space-between; gap: 16px; padding: 0 2px; }.source-imports h2 { margin: 2px 0 0; font-size: 14px; }.source-imports p { margin: 0; color: var(--ops-text-secondary); font-size: 10px; }
.source-card-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; }.source-card-grid article { min-width: 0; display: grid; grid-template-columns: 38px minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 12px 13px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }.source-icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 6px; color: #08735f; background: #e8f5f0; }.source-card-grid article > div { min-width: 0; display: grid; gap: 2px; }.source-card-grid strong { font-size: 12px; }.source-card-grid span,.source-card-grid small { overflow: hidden; color: var(--ops-text-secondary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.source-card-grid small { color: var(--ops-text-muted); }
.source-card-grid .source-actions { display: flex; grid-auto-flow: column; gap: 4px; }
@media (max-width: 900px) { .source-card-grid { grid-template-columns: 1fr; } }
@media (max-width: 620px) { .source-imports > header { align-items: flex-start; flex-direction: column; gap: 4px; }.source-imports p { line-height: 1.45; } }
</style>
