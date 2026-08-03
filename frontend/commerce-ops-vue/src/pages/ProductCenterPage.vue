<script setup lang="ts">
import { Edit3, RefreshCw, RotateCcw, Search, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import ProductThumbnail from "@/components/ProductThumbnail.vue";
import {
  deleteProduct,
  getProduct,
  listProducts,
  loadProductWorkspace,
  restoreProduct,
  updateProduct,
  type ProductDetail,
  type ProductField,
  type ProductFilters,
  type ProductSummary,
} from "@/services/products";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const loading = ref(false);
const detailLoading = ref(false);
const saving = ref(false);
const error = ref("");
const products = ref<ProductSummary[]>([]);
const total = ref(0);
const totalPages = ref(1);
const filters = ref<ProductFilters>({ categories: [], lifecycleStatuses: [], countries: [] });
const permissions = ref<Record<string, boolean>>({});
const drawerVisible = ref(false);
const editVisible = ref(false);
const currentProduct = ref<ProductDetail | null>(null);
const editValues = reactive<Record<string, unknown>>({});
const clearOverrides = ref<string[]>([]);

const query = reactive({
  page: 1,
  pageSize: 30,
  keyword: "",
  country: "",
  categoryL1: "",
  lifecycleStatus: "",
  deleted: "active",
});

const lifecycleLabels: Record<string, string> = {
  ACTIVE: "在售",
  NEW: "新品",
  CLEARANCE: "清仓",
  INACTIVE: "停用",
  DISCONTINUED: "下架",
  UNKNOWN: "待确认",
};

const categoryOptions = computed(() => [...new Set(filters.value.categories.map((item) => item.categoryL1).filter(Boolean))] as string[]);
const currentOperational = computed(() => products.value.filter((item) => item.operationalEligible && !item.deletedAt).length);
const currentImageCoverage = computed(() => {
  if (!products.value.length) return "0.0%";
  return `${(products.value.filter((item) => item.image.count > 0).length / products.value.length * 100).toFixed(1)}%`;
});
const currentOverrides = computed(() => products.value.reduce((sum, item) => sum + item.manualOverrideCount, 0));

const detailGroups = computed(() => groupFields(
  (currentProduct.value?.fields || []).filter((field) => currentProduct.value?.visibleFields?.includes(field.code)),
));
const editableGroups = computed(() => groupFields((currentProduct.value?.fields || []).filter((field) => field.editable)));

function can(permission: string) {
  return permissions.value[permission] === true;
}

function groupFields(fields: ProductField[]) {
  const groups = new Map<string, ProductField[]>();
  for (const field of fields) {
    if (!groups.has(field.groupLabel)) groups.set(field.groupLabel, []);
    groups.get(field.groupLabel)?.push(field);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.length ? value.join("；") : "—";
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("zh-CN");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function lifecycleLabel(product: ProductSummary) {
  if (product.deletedAt) return "已删除";
  return lifecycleLabels[product.lifecycleStatus || "UNKNOWN"] || product.sourceStatus || "待确认";
}

function lifecycleType(product: ProductSummary) {
  if (product.deletedAt) return "danger";
  if (product.lifecycleStatus === "ACTIVE") return "success";
  if (product.lifecycleStatus === "NEW") return "primary";
  if (product.lifecycleStatus === "CLEARANCE") return "warning";
  return "info";
}

async function load({ resetPage = false } = {}) {
  if (resetPage) query.page = 1;
  loading.value = true;
  error.value = "";
  try {
    const result = await listProducts(query);
    products.value = result.products || [];
    total.value = Number(result.total || 0);
    query.page = Number(result.page || 1);
    query.pageSize = Number(result.pageSize || query.pageSize);
    totalPages.value = Number(result.totalPages || 1);
    workspace.lastSyncedAt = new Date();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "产品目录加载失败");
  } finally {
    loading.value = false;
  }
}

async function initialize() {
  loading.value = true;
  try {
    const workspaceData = await loadProductWorkspace();
    filters.value = workspaceData.filters;
    permissions.value = workspaceData.permissions;
    await load();
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "产品中心初始化失败");
    loading.value = false;
  }
}

function resetFilters() {
  Object.assign(query, { page: 1, keyword: "", country: "", categoryL1: "", lifecycleStatus: "", deleted: "active" });
  load();
}

async function openDetail(product: ProductSummary) {
  drawerVisible.value = true;
  detailLoading.value = true;
  currentProduct.value = null;
  try {
    currentProduct.value = await getProduct(product.id);
  } catch (loadError) {
    drawerVisible.value = false;
    ElMessage.error(String((loadError as Error)?.message || loadError || "产品详情加载失败"));
  } finally {
    detailLoading.value = false;
  }
}

async function openEdit(product?: ProductSummary) {
  detailLoading.value = true;
  try {
    const detail = product ? await getProduct(product.id) : currentProduct.value;
    if (!detail) return;
    currentProduct.value = detail;
    for (const key of Object.keys(editValues)) delete editValues[key];
    for (const field of detail.fields.filter((item) => item.editable)) {
      editValues[field.code] = detail.fieldValues[field.code] ?? "";
    }
    clearOverrides.value = [];
    editVisible.value = true;
  } catch (loadError) {
    ElMessage.error(String((loadError as Error)?.message || loadError || "编辑数据加载失败"));
  } finally {
    detailLoading.value = false;
  }
}

function comparable(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

async function saveEdit() {
  if (!currentProduct.value) return;
  const fields: Record<string, unknown> = {};
  for (const field of currentProduct.value.fields.filter((item) => item.editable)) {
    if (clearOverrides.value.includes(field.code)) continue;
    const nextValue = editValues[field.code];
    if (comparable(nextValue) !== comparable(currentProduct.value.fieldValues[field.code])) {
      fields[field.code] = field.type === "number" || field.type === "integer"
        ? (nextValue === "" ? null : Number(nextValue))
        : nextValue;
    }
  }
  if (!Object.keys(fields).length && !clearOverrides.value.length) {
    ElMessage.info("没有需要保存的修改");
    return;
  }
  saving.value = true;
  try {
    await updateProduct(currentProduct.value.id, fields, clearOverrides.value);
    currentProduct.value = await getProduct(currentProduct.value.id);
    editVisible.value = false;
    await load();
    ElMessage.success("产品资料已更新");
  } catch (saveError) {
    ElMessage.error(String((saveError as Error)?.message || saveError || "保存失败"));
  } finally {
    saving.value = false;
  }
}

async function removeProduct(product: ProductSummary) {
  try {
    const result = await ElMessageBox.prompt(
      `删除后 ${product.sku} 将退出运营池，但历史记录仍会保留。`,
      "确认删除产品",
      { confirmButtonText: "确认删除", cancelButtonText: "取消", inputPlaceholder: "可填写删除原因", type: "warning" },
    );
    await deleteProduct(product.id, result.value || "");
    if (currentProduct.value?.id === product.id) drawerVisible.value = false;
    await load();
    ElMessage.success("产品已软删除");
  } catch (action) {
    if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action || "删除失败"));
  }
}

async function restore(product: ProductSummary) {
  try {
    await ElMessageBox.confirm(`确定恢复产品 ${product.sku}？`, "恢复产品", { type: "info" });
    await restoreProduct(product.id);
    await load();
    ElMessage.success("产品已恢复");
  } catch (action) {
    if (action !== "cancel" && action !== "close") ElMessage.error(String((action as Error)?.message || action || "恢复失败"));
  }
}

onMounted(initialize);
</script>

<template>
  <div class="product-center-vue-page" v-loading="loading">
    <section class="product-commandbar">
      <div>
        <span class="panel-kicker">PRODUCT CATALOG</span>
        <h2>产品目录</h2>
        <p>统一查看产品包主数据、生命周期、图片覆盖与人工维护记录。</p>
      </div>
      <div class="product-command-actions">
        <el-button :icon="RefreshCw" :loading="loading" @click="load()">刷新</el-button>
        <el-button type="primary" tag="a" href="/legacy/#products">产品包导入（旧版）</el-button>
      </div>
    </section>

    <section class="module-toolbar product-toolbar">
      <div class="product-search-field">
        <el-input v-model="query.keyword" clearable placeholder="搜索 SKU、主 SKU、款名或商品名称" @keyup.enter="load({ resetPage: true })">
          <template #prefix><Search :size="16" /></template>
        </el-input>
      </div>
      <div class="product-filter-grid">
        <el-select v-model="query.country" placeholder="全部国家" clearable filterable>
          <el-option v-for="item in filters.countries" :key="item" :label="item" :value="item" />
        </el-select>
        <el-select v-model="query.categoryL1" placeholder="全部类目" clearable filterable>
          <el-option v-for="item in categoryOptions" :key="item" :label="item" :value="item" />
        </el-select>
        <el-select v-model="query.lifecycleStatus" placeholder="全部状态" clearable>
          <el-option v-for="item in filters.lifecycleStatuses" :key="item" :label="lifecycleLabels[item] || item" :value="item" />
        </el-select>
        <el-select v-model="query.deleted" placeholder="删除状态">
          <el-option label="正常产品" value="active" />
          <el-option v-if="can('product.restore')" label="已删除" value="deleted" />
          <el-option v-if="can('product.restore')" label="全部" value="all" />
        </el-select>
      </div>
      <div class="module-toolbar-actions">
        <el-button @click="resetFilters">重置</el-button>
        <el-button type="primary" :icon="Search" @click="load({ resetPage: true })">查询</el-button>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error">
      <template #default><el-button link type="danger" @click="initialize">重新加载</el-button></template>
    </el-alert>

    <section class="product-summary-strip" aria-label="当前产品结果摘要">
      <div><span>符合条件 SKU</span><strong>{{ total.toLocaleString("zh-CN") }}</strong><small>全部查询结果</small></div>
      <div><span>当前页运营池</span><strong>{{ currentOperational }}</strong><small>在售 / 新品 / 清仓</small></div>
      <div><span>当前页图片覆盖</span><strong>{{ currentImageCoverage }}</strong><small>含用户图与马帮图片</small></div>
      <div><span>当前页人工修改</span><strong>{{ currentOverrides }}</strong><small>字段覆盖记录</small></div>
    </section>

    <section class="dashboard-panel product-table-panel">
      <header>
        <div><span class="panel-kicker">MASTER DATA</span><h3>SKU 主数据</h3></div>
        <span>第 {{ query.page }} / {{ totalPages }} 页</span>
      </header>
      <el-table :data="products" stripe empty-text="没有符合条件的产品" row-key="id">
        <el-table-column label="图片" width="92" fixed>
          <template #default="scope">
            <ProductThumbnail :asset-id="scope.row.image.mabangAssetId" :count="scope.row.image.mabangCount" :alt="`${scope.row.sku} 产品图片`" />
          </template>
        </el-table-column>
        <el-table-column label="SKU / 商品" min-width="250" fixed>
          <template #default="scope"><div class="product-name-cell"><strong>{{ scope.row.sku }}</strong><span>{{ scope.row.productName }}</span></div></template>
        </el-table-column>
        <el-table-column label="国家 / 主 SKU" min-width="150">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ scope.row.country || "—" }}</strong><span>{{ scope.row.mainSku || "无主 SKU" }}</span></div></template>
        </el-table-column>
        <el-table-column label="类目 / 规格" min-width="230">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ [scope.row.categoryL1, scope.row.categoryL2].filter(Boolean).join(" / ") || "—" }}</strong><span>{{ scope.row.salesSpec || "暂无规格" }}</span></div></template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="scope"><div class="product-stack-cell"><el-tag size="small" :type="lifecycleType(scope.row)">{{ lifecycleLabel(scope.row) }}</el-tag><span>{{ scope.row.operationalEligible ? "运营池" : "历史查询" }}</span></div></template>
        </el-table-column>
        <el-table-column label="数据状态" width="140">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ scope.row.manualOverrideCount }} 处人工修改</strong><span>{{ scope.row.aiContentCount }} 条 AI 内容</span></div></template>
        </el-table-column>
        <el-table-column label="更新" width="170">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ formatDate(scope.row.updatedAt) }}</strong><span>{{ scope.row.sourcePeriod || "—" }}</span></div></template>
        </el-table-column>
        <el-table-column label="操作" width="184" fixed="right">
          <template #default="scope">
            <div class="product-row-actions">
              <el-button link type="primary" @click="openDetail(scope.row)">详情</el-button>
              <el-button v-if="can('product.edit') && !scope.row.deletedAt" link :icon="Edit3" @click="openEdit(scope.row)">编辑</el-button>
              <el-button v-if="can('product.delete') && !scope.row.deletedAt" link type="danger" :icon="Trash2" @click="removeProduct(scope.row)">删除</el-button>
              <el-button v-if="can('product.restore') && scope.row.deletedAt" link type="success" :icon="RotateCcw" @click="restore(scope.row)">恢复</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <footer class="product-pagination">
        <span>共 {{ total.toLocaleString("zh-CN") }} 个 SKU</span>
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[20, 30, 50, 100]"
          layout="sizes, prev, pager, next"
          background
          @current-change="load()"
          @size-change="load({ resetPage: true })"
        />
      </footer>
    </section>

    <el-drawer v-model="drawerVisible" class="product-detail-drawer" size="min(720px, 96vw)" :with-header="false">
      <div v-loading="detailLoading" class="product-detail-content">
        <template v-if="currentProduct">
          <header class="product-detail-header">
            <div><span class="panel-kicker">SKU DETAIL</span><h2>{{ currentProduct.productName || currentProduct.sku }}</h2><p>{{ currentProduct.country || "—" }} · {{ currentProduct.sku }} · {{ lifecycleLabel(currentProduct) }}</p></div>
            <el-button v-if="can('product.edit') && !currentProduct.deletedAt" type="primary" :icon="Edit3" @click="openEdit()">编辑资料</el-button>
          </header>
          <section v-for="group in detailGroups" :key="group.label" class="product-detail-section">
            <h3>{{ group.label }}</h3>
            <dl class="product-detail-grid">
              <div v-for="field in group.items" :key="field.code">
                <dt>{{ field.label }} <el-tag v-if="Object.hasOwn(currentProduct.manualOverrides || {}, field.code)" size="small" type="warning">人工维护</el-tag></dt>
                <dd>{{ formatValue(currentProduct.fieldValues[field.code]) }}</dd>
              </div>
            </dl>
          </section>
          <section class="product-detail-section">
            <h3>仓库明细</h3>
            <el-table :data="currentProduct.inventories || []" size="small" empty-text="暂无仓库记录">
              <el-table-column prop="warehouse" label="仓库" min-width="160" />
              <el-table-column prop="stock" label="库存" width="110" align="right" />
              <el-table-column prop="plannedWarehouse" label="计划仓" min-width="160" />
            </el-table>
          </section>
          <section class="product-detail-section">
            <h3>已确认 AI 内容</h3>
            <div v-if="currentProduct.confirmedAiContent?.outputContent" class="confirmed-ai-card">
              <p>{{ currentProduct.confirmedAiContent.outputContent.product_summary || "暂无产品摘要" }}</p>
              <ul><li v-for="item in currentProduct.confirmedAiContent.outputContent.selling_points || []" :key="item.title"><strong>{{ item.title }}</strong><span>{{ item.description }}</span></li></ul>
            </div>
            <el-empty v-else :image-size="72" description="暂无已确认的 AI 内容" />
          </section>
          <section class="product-detail-section">
            <h3>来源与记录</h3>
            <dl class="product-detail-grid compact">
              <div><dt>来源文件</dt><dd>{{ currentProduct.sourceFilename || "—" }}</dd></div>
              <div><dt>来源周期</dt><dd>{{ currentProduct.sourcePeriod || "—" }}</dd></div>
              <div><dt>更新时间</dt><dd>{{ formatDate(currentProduct.updatedAt) }}</dd></div>
              <div><dt>人工变更</dt><dd>{{ currentProduct.overrideEvents?.length || 0 }} 条</dd></div>
            </dl>
          </section>
        </template>
        <el-empty v-else :image-size="96" description="正在加载产品详情" />
      </div>
    </el-drawer>

    <el-dialog v-model="editVisible" width="min(780px, 94vw)" title="编辑产品资料" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon title="仅保存实际修改的字段；可清除人工覆盖并恢复产品包原值。" />
      <div v-if="currentProduct" class="product-edit-form">
        <section v-for="group in editableGroups" :key="group.label">
          <h3>{{ group.label }}</h3>
          <div class="product-edit-grid">
            <label v-for="field in group.items" :key="field.code" class="product-edit-field" :class="{ wide: field.code === 'sales_spec' }">
              <span>{{ field.label }} <el-tag v-if="Object.hasOwn(currentProduct.manualOverrides || {}, field.code)" size="small" type="warning">人工维护</el-tag></span>
              <el-input
                v-model="editValues[field.code]"
                :type="field.code === 'sales_spec' ? 'textarea' : field.type === 'number' || field.type === 'integer' ? 'number' : 'text'"
                :rows="field.code === 'sales_spec' ? 3 : undefined"
                :disabled="clearOverrides.includes(field.code)"
              />
              <small>产品包原值：{{ formatValue(currentProduct.sourceFieldValues[field.code]) }}</small>
              <el-checkbox v-if="Object.hasOwn(currentProduct.manualOverrides || {}, field.code)" v-model="clearOverrides" :value="field.code">清除人工覆盖</el-checkbox>
            </label>
          </div>
        </section>
      </div>
      <template #footer><el-button @click="editVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveEdit">保存修改</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.product-center-vue-page { display: grid; gap: 16px; }
.product-commandbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.product-commandbar h2 { margin: 4px 0; font-size: 20px; }
.product-commandbar p { margin: 0; color: var(--ops-text-secondary); font-size: 13px; }
.product-command-actions { display: flex; gap: 8px; }
.product-toolbar { align-items: center; }
.product-search-field { flex: 1.3; min-width: 260px; }
.product-filter-grid { flex: 2; display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 8px; }
.product-summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.product-summary-strip > div { min-height: 94px; display: grid; align-content: center; gap: 4px; padding: 14px 18px; border-right: 1px solid var(--ops-border-light); }
.product-summary-strip > div:last-child { border-right: 0; }
.product-summary-strip span, .product-summary-strip small { color: var(--ops-text-secondary); font-size: 11px; }
.product-summary-strip strong { font-size: 23px; font-variant-numeric: tabular-nums; }
.product-table-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); --el-table-border-color: var(--ops-border-light); }
.product-thumbnail { width: 62px; display: grid; justify-items: center; gap: 4px; color: var(--ops-text-muted); }
.product-thumbnail img { width: 52px; height: 52px; object-fit: cover; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface-muted); }
.product-thumbnail.empty { min-height: 52px; align-content: center; border: 1px dashed var(--ops-border); border-radius: 8px; background: var(--ops-surface-muted); }
.product-thumbnail span { font-size: 10px; white-space: nowrap; }
.product-name-cell, .product-stack-cell { display: grid; gap: 4px; min-width: 0; }
.product-name-cell strong { color: var(--ops-primary); font-variant-numeric: tabular-nums; }
.product-name-cell span, .product-stack-cell span { overflow: hidden; color: var(--ops-text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.product-stack-cell strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.product-row-actions { display: flex; flex-wrap: wrap; gap: 2px; }
.product-row-actions :deep(.el-button + .el-button) { margin-left: 0; }
.product-pagination { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-top: 1px solid var(--ops-border-light); color: var(--ops-text-secondary); font-size: 12px; }
.product-detail-content { min-height: 420px; padding: 8px 4px 28px; }
.product-detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 8px 12px 20px; border-bottom: 1px solid var(--ops-border-light); }
.product-detail-header h2 { margin: 5px 0; font-size: 22px; }
.product-detail-header p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; }
.product-detail-section { padding: 20px 12px; border-bottom: 1px solid var(--ops-border-light); }
.product-detail-section h3, .product-edit-form h3 { margin: 0 0 12px; font-size: 14px; }
.product-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; }
.product-detail-grid > div { min-height: 70px; display: grid; align-content: center; gap: 7px; padding: 12px; border-radius: 9px; background: var(--ops-surface-muted); }
.product-detail-grid dt { display: flex; align-items: center; gap: 6px; color: var(--ops-text-secondary); font-size: 11px; }
.product-detail-grid dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 650; line-height: 1.5; }
.product-detail-grid.compact > div { min-height: 60px; }
.confirmed-ai-card { padding: 14px; border: 1px solid #bfdbfe; border-radius: 10px; background: #eff6ff; }
.confirmed-ai-card p { margin: 0 0 12px; line-height: 1.6; }
.confirmed-ai-card ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.confirmed-ai-card li { display: grid; gap: 3px; }
.confirmed-ai-card li span { color: var(--ops-text-secondary); font-size: 12px; }
.product-edit-form { max-height: 62vh; margin-top: 14px; overflow-y: auto; }
.product-edit-form section { padding: 16px 2px; border-bottom: 1px solid var(--ops-border-light); }
.product-edit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.product-edit-field { display: grid; gap: 7px; align-content: start; }
.product-edit-field.wide { grid-column: 1 / -1; }
.product-edit-field > span { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; }
.product-edit-field > small { color: var(--ops-text-muted); font-size: 10px; overflow-wrap: anywhere; }
@media (max-width: 1280px) {
  .product-toolbar { align-items: stretch; flex-wrap: wrap; }
  .product-search-field { flex-basis: 100%; }
  .product-filter-grid { grid-template-columns: repeat(4, minmax(120px, 1fr)); }
}
@media (max-width: 820px) {
  .product-commandbar { align-items: stretch; flex-direction: column; }
  .product-command-actions .el-button { flex: 1; }
  .product-toolbar { display: grid; grid-template-columns: minmax(0, 1fr); }
  .product-search-field, .product-filter-grid, .product-toolbar .module-toolbar-actions { width: 100%; min-width: 0; }
  .product-toolbar .module-toolbar-actions { justify-content: flex-end; }
  .product-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .product-summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .product-summary-strip > div:nth-child(2) { border-right: 0; }
  .product-summary-strip > div:nth-child(-n+2) { border-bottom: 1px solid var(--ops-border-light); }
  .product-pagination { align-items: flex-start; flex-direction: column; }
}
@media (max-width: 480px) {
  .product-command-actions { display: grid; grid-template-columns: 1fr; }
  .product-filter-grid { grid-template-columns: 1fr; }
  .product-summary-strip { grid-template-columns: 1fr; }
  .product-summary-strip > div { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }
  .product-summary-strip > div:last-child { border-bottom: 0; }
  .product-detail-grid, .product-edit-grid { grid-template-columns: 1fr; }
  .product-edit-field.wide { grid-column: 1; }
  .product-pagination :deep(.el-pagination__sizes), .product-pagination :deep(.el-pager) { display: none; }
}
</style>
