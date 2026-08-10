<script setup lang="ts">
import { Clock3, Database, Edit3, Image as ImageIcon, Link2, RefreshCw, RotateCcw, Search, Settings2, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import ProductThumbnail from "@/components/ProductThumbnail.vue";
import {
  deleteProduct,
  getProduct,
  listProducts,
  loadMabangImageCapabilities,
  loadProductWorkspace,
  matchMabangProductImages,
  restoreProduct,
  saveProductTableFieldPreference,
  updateMabangImageLink,
  updateProduct,
  uploadMabangProductImage,
  type ProductDetail,
  type ProductField,
  type ProductFilters,
  type ProductSummary,
  type ProductTableField,
} from "@/services/products";
import {
  loadProductPackageChanges,
  loadProductPackageSyncRuns,
  loadProductPackageSyncStatus,
  runProductPackageSync,
  type ProductPackageChange,
  type ProductPackageSyncRun,
  type ProductPackageSyncStatus,
} from "@/services/product-package-sync";
import { useWorkspaceStore } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const router = useRouter();
const loading = ref(false);
const detailLoading = ref(false);
const saving = ref(false);
const syncing = ref(false);
const changeLoading = ref(false);
const error = ref("");
const syncError = ref("");
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
const syncStatus = ref<ProductPackageSyncStatus | null>(null);
const syncRuns = ref<ProductPackageSyncRun[]>([]);
const packageChanges = ref<ProductPackageChange[]>([]);
const changeTotal = ref(0);
const changeTotalPages = ref(1);
const changeQueryInitialized = ref(false);
const tableFields = ref<ProductTableField[]>([]);
const visibleTableFields = ref<string[]>([]);
const tableFieldDraft = ref<string[]>([]);
const tableFieldKeyword = ref("");
const tableFieldPopoverVisible = ref(false);
const tableFieldSaving = ref(false);
const mabangImagePermissions = ref<Record<string, boolean>>({});
const matchingMabangImages = ref(false);
const imageManagerVisible = ref(false);
const imageManagerLoading = ref(false);
const imageManagerProduct = ref<ProductDetail | null>(null);
const mabangUploadInput = ref<HTMLInputElement | null>(null);
const uploadingMabangImages = ref(false);

const query = reactive({
  page: 1,
  pageSize: 30,
  keyword: "",
  country: "",
  categoryL1: "",
  lifecycleStatus: "",
  deleted: "active",
});
const changeQuery = reactive({
  runId: "",
  page: 1,
  pageSize: 50,
  country: "",
  sku: "",
  field: "",
  changeType: "",
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
const latestSyncRun = computed(() => syncRuns.value[0] || syncStatus.value?.latestRun || null);
const changedRuns = computed(() => syncRuns.value.filter((run) => run.importBatchId));
const visibleTableFieldSet = computed(() => new Set(visibleTableFields.value));
const summaryTableFieldOptions = computed(() => tableFields.value.filter((field) => field.group === "summary"));
const sourceTableFieldOptions = computed(() => tableFields.value.filter((field) => field.group === "source_database"));
const filteredSourceTableFieldOptions = computed(() => {
  const keyword = tableFieldKeyword.value.trim().toLocaleLowerCase("zh-CN");
  if (!keyword) return sourceTableFieldOptions.value;
  return sourceTableFieldOptions.value.filter((field) => `${field.label} ${field.sourceColumn || ""}`.toLocaleLowerCase("zh-CN").includes(keyword));
});
const selectedSourceTableFields = computed(() => sourceTableFieldOptions.value.filter((field) => visibleTableFieldSet.value.has(field.code)));

const detailGroups = computed(() => groupFields(
  (currentProduct.value?.fields || []).filter((field) => currentProduct.value?.visibleFields?.includes(field.code)),
));
const editableGroups = computed(() => groupFields((currentProduct.value?.fields || []).filter((field) => field.editable)));

function can(permission: string) {
  return permissions.value[permission] === true;
}

function canMabang(permission: string) {
  return mabangImagePermissions.value[permission] === true;
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

function tableFieldVisible(code: string) {
  return visibleTableFieldSet.value.has(code);
}

function prepareTableFieldPicker() {
  tableFieldDraft.value = [...visibleTableFields.value];
  tableFieldKeyword.value = "";
}

function restoreDefaultTableFields() {
  tableFieldDraft.value = summaryTableFieldOptions.value.map((field) => field.code);
}

function selectAllSourceTableFields() {
  tableFieldDraft.value = [...new Set([
    ...tableFieldDraft.value,
    ...sourceTableFieldOptions.value.map((field) => field.code),
  ])];
}

async function saveTableFields() {
  tableFieldSaving.value = true;
  try {
    const response = await saveProductTableFieldPreference(tableFieldDraft.value);
    visibleTableFields.value = [...(response.preference.visibleFields || [])];
    tableFieldPopoverVisible.value = false;
    ElMessage.success("主表展示字段已保存");
  } catch (saveError) {
    ElMessage.error(String((saveError as Error)?.message || saveError || "展示字段保存失败"));
  } finally {
    tableFieldSaving.value = false;
  }
}

async function loadSyncWorkspace({ resetPage = false } = {}) {
  if (resetPage) changeQuery.page = 1;
  changeLoading.value = true;
  syncError.value = "";
  try {
    const [statusResult, runResult] = await Promise.all([
      loadProductPackageSyncStatus(),
      loadProductPackageSyncRuns(),
    ]);
    syncStatus.value = statusResult;
    syncRuns.value = runResult.runs || [];
    if (!changeQueryInitialized.value) {
      changeQuery.runId = syncRuns.value.find((run) => run.importBatchId)?.id || "";
      changeQueryInitialized.value = true;
    }
    if (changeQuery.runId) {
      const result = await loadProductPackageChanges(changeQuery);
      packageChanges.value = result.changes || [];
      changeTotal.value = Number(result.total || 0);
      changeQuery.page = Number(result.page || 1);
      changeTotalPages.value = Number(result.totalPages || 1);
    } else {
      packageChanges.value = [];
      changeTotal.value = 0;
      changeTotalPages.value = 1;
    }
  } catch (loadError) {
    syncError.value = String((loadError as Error)?.message || loadError || "产品包同步状态加载失败");
  } finally {
    changeLoading.value = false;
  }
}

async function refreshAll() {
  await Promise.all([load(), loadSyncWorkspace()]);
}

async function syncNow() {
  syncing.value = true;
  try {
    const result = await runProductPackageSync();
    ElMessage.success(result.changed ? "产品包已同步，字段变化已生成" : "源产品包没有变化，本地数据未替换");
    changeQueryInitialized.value = false;
    await refreshAll();
  } catch (syncFailure) {
    ElMessage.error(String((syncFailure as Error)?.message || syncFailure || "产品包同步失败"));
  } finally {
    syncing.value = false;
  }
}

async function matchMabangImages() {
  try {
    await ElMessageBox.confirm(
      "将按已采集记录中的 SKU 精确匹配马帮图片。不会覆盖人工图片，是否继续？",
      "匹配马帮图片",
      { type: "warning", confirmButtonText: "开始匹配", cancelButtonText: "取消" },
    );
  } catch (action) {
    if (action === "cancel" || action === "close") return;
    throw action;
  }
  matchingMabangImages.value = true;
  try {
    const { result } = await matchMabangProductImages();
    ElMessage.success(`匹配完成：${result.matchedSkus.toLocaleString("zh-CN")} 个 SKU，新增 ${result.linksCreated.toLocaleString("zh-CN")} 条图片关联`);
    await load();
  } catch (matchError) {
    ElMessage.error(String((matchError as Error)?.message || matchError || "马帮图片匹配失败"));
  } finally {
    matchingMabangImages.value = false;
  }
}

async function openImageManager(product: ProductSummary) {
  imageManagerVisible.value = true;
  imageManagerLoading.value = true;
  imageManagerProduct.value = null;
  try {
    imageManagerProduct.value = await getProduct(product.id);
  } catch (loadError) {
    imageManagerVisible.value = false;
    ElMessage.error(String((loadError as Error)?.message || loadError || "图片资料加载失败"));
  } finally {
    imageManagerLoading.value = false;
  }
}

async function refreshImageManager() {
  if (!imageManagerProduct.value) return;
  imageManagerProduct.value = await getProduct(imageManagerProduct.value.id);
  if (currentProduct.value?.id === imageManagerProduct.value.id) currentProduct.value = imageManagerProduct.value;
  await load();
}

function chooseMabangImages() {
  mabangUploadInput.value?.click();
}

async function uploadSelectedMabangImages(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])];
  if (!imageManagerProduct.value || !files.length) return;
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
  const invalid = files.find((file) => !allowed.has(file.type) || file.size > 10 * 1024 * 1024);
  if (invalid) {
    input.value = "";
    ElMessage.error(`${invalid.name} 格式不支持或超过 10MB`);
    return;
  }
  uploadingMabangImages.value = true;
  try {
    for (const file of files) await uploadMabangProductImage(imageManagerProduct.value.id, file);
    input.value = "";
    await refreshImageManager();
    ElMessage.success(`已上传 ${files.length} 张图片`);
  } catch (uploadError) {
    ElMessage.error(String((uploadError as Error)?.message || uploadError || "图片上传失败"));
  } finally {
    uploadingMabangImages.value = false;
  }
}

async function changeMabangImageLink(linkId: string, action: "confirm-gallery" | "reject") {
  if (action === "reject") {
    try {
      await ElMessageBox.confirm("确认解除这张图片与当前 SKU 的关联吗？", "移除图片关联", { type: "warning" });
    } catch (decision) {
      if (decision === "cancel" || decision === "close") return;
      throw decision;
    }
  }
  try {
    await updateMabangImageLink(linkId, action);
    await refreshImageManager();
    ElMessage.success(action === "confirm-gallery" ? "已加入产品图片" : "图片关联已移除");
  } catch (updateError) {
    ElMessage.error(String((updateError as Error)?.message || updateError || "图片操作失败"));
  }
}

async function initialize() {
  loading.value = true;
  try {
    const [workspaceData, mabangCapabilities] = await Promise.all([
      loadProductWorkspace(),
      loadMabangImageCapabilities().catch(() => ({ permissions: {} })),
    ]);
    filters.value = workspaceData.filters;
    permissions.value = workspaceData.permissions;
    tableFields.value = workspaceData.tableFields.fields || [];
    visibleTableFields.value = workspaceData.tableFields.visibleFields || [];
    mabangImagePermissions.value = mabangCapabilities.permissions || {};
    await Promise.all([load(), loadSyncWorkspace()]);
  } catch (loadError) {
    error.value = String((loadError as Error)?.message || loadError || "产品中心初始化失败");
    loading.value = false;
  }
}

function resetFilters() {
  Object.assign(query, { page: 1, keyword: "", country: "", categoryL1: "", lifecycleStatus: "", deleted: "active" });
  load();
}

function syncStatusLabel(status?: ProductPackageSyncRun["status"] | null) {
  const labels: Record<ProductPackageSyncRun["status"], string> = {
    RUNNING: "同步中",
    SUCCEEDED: "已更新",
    NO_CHANGES: "无变化",
    FAILED: "失败",
  };
  return status ? labels[status] : "尚未同步";
}

function syncStatusType(status?: ProductPackageSyncRun["status"] | null) {
  if (status === "SUCCEEDED") return "success";
  if (status === "RUNNING") return "warning";
  if (status === "FAILED") return "danger";
  return "info";
}

function changeTypeLabel(type: ProductPackageChange["changeType"]) {
  return ({ ADDED: "新增", UPDATED: "字段变化", REMOVED: "移除" } as const)[type];
}

function changeTypeTag(type: ProductPackageChange["changeType"]) {
  return type === "ADDED" ? "success" : type === "REMOVED" ? "danger" : "warning";
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
        <el-button v-if="canMabang('mabang_images.collect')" :icon="ImageIcon" @click="router.push('/mabang')">马帮图片同步</el-button>
        <el-button
          v-if="canMabang('mabang_images.link')"
          :icon="Link2"
          :loading="matchingMabangImages"
          @click="matchMabangImages"
        >匹配马帮图片</el-button>
        <el-button :icon="RefreshCw" :loading="loading || changeLoading" @click="refreshAll">刷新</el-button>
        <el-button
          v-if="can('product.edit')"
          type="primary"
          :icon="Database"
          :loading="syncing"
          :disabled="!syncStatus?.schemaReady || !syncStatus?.sourceConfigured || !syncStatus?.manualSyncEnabled"
          @click="syncNow"
        >立即同步</el-button>
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
        <div class="product-table-header-actions">
          <span>第 {{ query.page }} / {{ totalPages }} 页</span>
          <el-popover
            v-model:visible="tableFieldPopoverVisible"
            placement="bottom-end"
            :width="440"
            trigger="click"
            @show="prepareTableFieldPicker"
          >
            <template #reference>
              <el-button :icon="Settings2">展示字段（{{ visibleTableFields.length }}）</el-button>
            </template>
            <div class="table-field-picker">
              <div class="table-field-picker-heading">
                <strong>选择主表展示字段</strong>
                <span>图片、SKU / 商品、操作固定保留</span>
              </div>
              <section>
                <div class="table-field-picker-section-title"><span>主表组合字段</span><el-button link @click="restoreDefaultTableFields">恢复默认</el-button></div>
                <el-checkbox-group v-model="tableFieldDraft" class="table-field-picker-grid">
                  <el-checkbox v-for="field in summaryTableFieldOptions" :key="field.code" :value="field.code">{{ field.label }}</el-checkbox>
                </el-checkbox-group>
              </section>
              <section>
                <div class="table-field-picker-section-title"><span>数据库原始字段（62 个）</span><el-button link @click="selectAllSourceTableFields">全选</el-button></div>
                <el-input v-model="tableFieldKeyword" clearable size="small" placeholder="搜索字段名称或数据库列名">
                  <template #prefix><Search :size="14" /></template>
                </el-input>
                <el-checkbox-group v-model="tableFieldDraft" class="table-field-picker-grid source-fields">
                  <el-checkbox v-for="field in filteredSourceTableFieldOptions" :key="field.code" :value="field.code">
                    <span>{{ field.label }}</span><small>{{ field.sourceColumn }}</small>
                  </el-checkbox>
                </el-checkbox-group>
              </section>
              <footer>
                <span>已选 {{ tableFieldDraft.length }} 个可变字段</span>
                <div><el-button size="small" @click="tableFieldPopoverVisible = false">取消</el-button><el-button size="small" type="primary" :loading="tableFieldSaving" @click="saveTableFields">保存</el-button></div>
              </footer>
            </div>
          </el-popover>
        </div>
      </header>
      <el-table :data="products" stripe empty-text="没有符合条件的产品" row-key="id">
        <el-table-column label="图片" width="112" fixed>
          <template #default="scope">
            <button class="product-thumbnail-entry" type="button" title="打开图片管理" @click="openImageManager(scope.row)">
              <ProductThumbnail :asset-id="scope.row.image.mabangAssetId" :count="scope.row.image.mabangCount" :alt="`${scope.row.sku} 产品图片`" />
              <span>图片管理</span>
            </button>
          </template>
        </el-table-column>
        <el-table-column label="SKU / 商品" min-width="250" fixed>
          <template #default="scope"><div class="product-name-cell"><strong>{{ scope.row.sku }}</strong><span>{{ scope.row.productName }}</span></div></template>
        </el-table-column>
        <el-table-column v-if="tableFieldVisible('summary:country_main_sku')" label="国家 / 主 SKU" min-width="150">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ scope.row.country || "—" }}</strong><span>{{ scope.row.mainSku || "无主 SKU" }}</span></div></template>
        </el-table-column>
        <el-table-column v-if="tableFieldVisible('summary:category_sales_spec')" label="类目 / 规格" min-width="230">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ [scope.row.categoryL1, scope.row.categoryL2].filter(Boolean).join(" / ") || "—" }}</strong><span>{{ scope.row.salesSpec || "暂无规格" }}</span></div></template>
        </el-table-column>
        <el-table-column v-if="tableFieldVisible('summary:lifecycle_status')" label="状态" width="130">
          <template #default="scope"><div class="product-stack-cell"><el-tag size="small" :type="lifecycleType(scope.row)">{{ lifecycleLabel(scope.row) }}</el-tag><span>{{ scope.row.operationalEligible ? "运营池" : "历史查询" }}</span></div></template>
        </el-table-column>
        <el-table-column v-if="tableFieldVisible('summary:data_status')" label="数据状态" width="140">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ scope.row.manualOverrideCount }} 处人工修改</strong><span v-if="scope.row.latestChangeCount" class="latest-change-mark">本轮 {{ scope.row.latestChangeCount }} 项变化</span><span v-else>{{ scope.row.aiContentCount }} 条 AI 内容</span></div></template>
        </el-table-column>
        <el-table-column v-if="tableFieldVisible('summary:updated_at')" label="更新" width="170">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ formatDate(scope.row.updatedAt) }}</strong><span>{{ scope.row.sourcePeriod || "—" }}</span></div></template>
        </el-table-column>
        <el-table-column
          v-for="field in selectedSourceTableFields"
          :key="field.code"
          :label="field.label"
          min-width="160"
          show-overflow-tooltip
        >
          <template #default="scope">{{ formatValue(scope.row.sourceDatabaseValues?.[field.sourceColumn || ""]) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="scope">
            <div class="product-row-actions primary-actions">
              <el-button size="small" plain type="primary" data-testid="product-detail-button" @click="openDetail(scope.row)">详情</el-button>
              <el-button v-if="can('product.edit') && !scope.row.deletedAt" size="small" plain :icon="Edit3" data-testid="product-edit-button" @click="openEdit(scope.row)">编辑</el-button>
              <el-button v-if="canMabang('mabang_images.link') && !scope.row.deletedAt" size="small" plain :icon="ImageIcon" @click="openImageManager(scope.row)">图片</el-button>
              <el-button v-if="can('product.delete') && !scope.row.deletedAt" size="small" text type="danger" :icon="Trash2" @click="removeProduct(scope.row)">删除</el-button>
              <el-button v-if="can('product.restore') && scope.row.deletedAt" size="small" plain type="success" :icon="RotateCcw" @click="restore(scope.row)">恢复</el-button>
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

    <section class="dashboard-panel package-sync-panel" v-loading="changeLoading">
      <header class="package-sync-header">
        <div>
          <span class="panel-kicker">DATABASE SYNC</span>
          <h3>产品包同步与字段变化</h3>
          <p>每天 09:00（Asia/Shanghai）读取 AI_Project_A.product_package；无变化时不替换本地快照。</p>
        </div>
        <div class="package-sync-state">
          <el-tag :type="syncStatusType(latestSyncRun?.status)" effect="light">{{ syncStatusLabel(latestSyncRun?.status) }}</el-tag>
          <span><Clock3 :size="14" /> 下次固定检查 09:00</span>
        </div>
      </header>
      <el-alert v-if="syncError" type="error" :closable="false" show-icon :title="syncError" />
      <div class="package-sync-metrics">
        <div><span>当前快照</span><strong>{{ Number(syncStatus?.currentRowCount || 0).toLocaleString("zh-CN") }}</strong><small>仅保留最新产品包行</small></div>
        <div><span>本轮新增</span><strong>{{ Number(latestSyncRun?.newCount || 0).toLocaleString("zh-CN") }}</strong><small>新增源行</small></div>
        <div><span>本轮更新</span><strong>{{ Number(latestSyncRun?.updatedCount || 0).toLocaleString("zh-CN") }}</strong><small>内容发生变化的行</small></div>
        <div><span>本轮移除</span><strong>{{ Number(latestSyncRun?.removedCount || 0).toLocaleString("zh-CN") }}</strong><small>源端已不存在</small></div>
        <div><span>字段变化</span><strong>{{ Number(latestSyncRun?.fieldChangeCount || 0).toLocaleString("zh-CN") }}</strong><small>{{ formatDate(latestSyncRun?.finishedAt) }}</small></div>
      </div>
      <div class="package-change-toolbar">
        <el-select v-model="changeQuery.runId" placeholder="选择变化批次" @change="loadSyncWorkspace({ resetPage: true })">
          <el-option
            v-for="run in changedRuns"
            :key="run.id"
            :label="`${formatDate(run.finishedAt)} · ${run.fieldChangeCount.toLocaleString('zh-CN')} 条`"
            :value="run.id"
          />
        </el-select>
        <el-select v-model="changeQuery.changeType" clearable placeholder="全部变化类型">
          <el-option label="新增" value="ADDED" />
          <el-option label="字段变化" value="UPDATED" />
          <el-option label="移除" value="REMOVED" />
        </el-select>
        <el-select v-model="changeQuery.country" clearable filterable placeholder="全部国家">
          <el-option v-for="country in filters.countries" :key="country" :label="country" :value="country" />
        </el-select>
        <el-select v-model="changeQuery.field" clearable filterable placeholder="全部字段">
          <el-option v-for="field in syncStatus?.fields || []" :key="field.column" :label="field.label" :value="field.column" />
        </el-select>
        <el-input v-model="changeQuery.sku" clearable placeholder="搜索 SKU" @keyup.enter="loadSyncWorkspace({ resetPage: true })" />
        <el-button type="primary" :icon="Search" @click="loadSyncWorkspace({ resetPage: true })">查询变化</el-button>
      </div>
      <el-table :data="packageChanges" stripe empty-text="该批次没有字段变化">
        <el-table-column label="类型" width="104">
          <template #default="scope"><el-tag size="small" :type="changeTypeTag(scope.row.changeType)">{{ changeTypeLabel(scope.row.changeType) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="SKU / 商品" min-width="230">
          <template #default="scope"><div class="product-name-cell"><strong>{{ scope.row.sku || "—" }}</strong><span>{{ scope.row.productName || "—" }}</span></div></template>
        </el-table-column>
        <el-table-column label="国家 / 仓库" min-width="190">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ scope.row.countryCode || "—" }}</strong><span>{{ scope.row.warehouse || "—" }}</span></div></template>
        </el-table-column>
        <el-table-column label="变化字段" min-width="150">
          <template #default="scope"><div class="product-stack-cell"><strong>{{ scope.row.fieldLabel }}</strong><span>{{ scope.row.sourceColumn }}</span></div></template>
        </el-table-column>
        <el-table-column label="原值" min-width="210"><template #default="scope"><span class="change-value old">{{ formatValue(scope.row.oldValue) }}</span></template></el-table-column>
        <el-table-column label="新值" min-width="210"><template #default="scope"><span class="change-value next">{{ formatValue(scope.row.newValue) }}</span></template></el-table-column>
        <el-table-column label="检测时间" width="170"><template #default="scope">{{ formatDate(scope.row.changedAt) }}</template></el-table-column>
      </el-table>
      <footer class="product-pagination">
        <span>共 {{ changeTotal.toLocaleString("zh-CN") }} 条变化</span>
        <el-pagination
          v-model:current-page="changeQuery.page"
          :page-size="changeQuery.pageSize"
          :total="changeTotal"
          layout="prev, pager, next"
          background
          @current-change="loadSyncWorkspace()"
        />
      </footer>
    </section>

    <el-drawer v-model="drawerVisible" class="product-detail-drawer" size="min(720px, 96vw)" :with-header="false">
      <div v-loading="detailLoading" class="product-detail-content">
        <template v-if="currentProduct">
          <header class="product-detail-header">
            <div><span class="panel-kicker">SKU DETAIL</span><h2>{{ currentProduct.productName || currentProduct.sku }}</h2><p>{{ currentProduct.country || "—" }} · {{ currentProduct.sku }} · {{ lifecycleLabel(currentProduct) }}</p></div>
            <div class="product-detail-actions">
              <el-button v-if="canMabang('mabang_images.link') && !currentProduct.deletedAt" :icon="ImageIcon" @click="openImageManager(currentProduct)">图片管理</el-button>
              <el-button v-if="can('product.edit') && !currentProduct.deletedAt" type="primary" :icon="Edit3" @click="openEdit()">编辑资料</el-button>
            </div>
          </header>
          <section class="product-detail-section product-media-section">
            <div class="product-detail-section-heading">
              <div><h3>马帮图片</h3><p>沿用原来的 SKU 精确匹配与图片关联逻辑。</p></div>
              <el-button v-if="canMabang('mabang_images.link')" size="small" @click="openImageManager(currentProduct)">管理图片</el-button>
            </div>
            <div v-if="currentProduct.mabangImages?.length" class="product-media-grid">
              <article v-for="image in currentProduct.mabangImages" :key="image.linkId">
                <ProductThumbnail :asset-id="image.assetId" :count="1" :alt="image.originalFilename" />
                <div><strong>{{ image.originalFilename }}</strong><span>{{ image.mappingStatus === 'confirmed' ? '已加入产品图片' : '马帮参考图片' }}</span></div>
              </article>
            </div>
            <el-empty v-else :image-size="64" description="暂无马帮图片，可通过图片管理或马帮图片同步获取" />
          </section>
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
          <section v-if="currentProduct.sourceDatabaseFields?.length" class="product-detail-section">
            <el-collapse>
              <el-collapse-item title="数据库原始字段（AI_Project_A.product_package）" name="source-fields">
                <dl class="product-detail-grid source-database-grid">
                  <div v-for="field in currentProduct.sourceDatabaseFields" :key="field.code">
                    <dt>{{ field.label }} <small>{{ field.code }}</small></dt>
                    <dd>{{ formatValue(field.value) }}</dd>
                  </div>
                </dl>
              </el-collapse-item>
            </el-collapse>
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

    <el-dialog v-model="imageManagerVisible" width="min(820px, 94vw)" title="马帮图片管理" destroy-on-close>
      <div v-loading="imageManagerLoading" class="mabang-image-manager">
        <template v-if="imageManagerProduct">
          <div class="mabang-image-manager-toolbar">
            <div><strong>{{ imageManagerProduct.sku }}</strong><span>{{ imageManagerProduct.productName }}</span></div>
            <div>
              <el-button :icon="ImageIcon" @click="router.push('/mabang')">前往图片同步</el-button>
              <el-button v-if="canMabang('mabang_images.link')" type="primary" :loading="uploadingMabangImages" @click="chooseMabangImages">上传图片</el-button>
              <input ref="mabangUploadInput" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple @change="uploadSelectedMabangImages" />
            </div>
          </div>
          <el-alert type="info" :closable="false" show-icon title="马帮同步图片按 SKU 精确关联；上传图片沿用原来的马帮图片资产逻辑，不覆盖人工主图。" />
          <div v-if="imageManagerProduct.mabangImages?.length" class="mabang-image-manager-grid">
            <article v-for="image in imageManagerProduct.mabangImages" :key="image.linkId">
              <ProductThumbnail :asset-id="image.assetId" :count="1" :alt="image.originalFilename" />
              <div class="mabang-image-manager-copy">
                <strong>{{ image.originalFilename }}</strong>
                <span>{{ image.sourceSystem === 'manual_mabang' ? '本地上传' : '马帮采集' }} · {{ image.width }} × {{ image.height }}</span>
                <el-tag size="small" :type="image.mappingStatus === 'confirmed' ? 'success' : 'info'">{{ image.mappingStatus === 'confirmed' ? '已加入产品图片' : '参考素材' }}</el-tag>
              </div>
              <div class="mabang-image-manager-actions">
                <el-button v-if="image.mappingStatus !== 'confirmed'" size="small" type="primary" @click="changeMabangImageLink(image.linkId, 'confirm-gallery')">加入产品图片</el-button>
                <el-button size="small" type="danger" plain @click="changeMabangImageLink(image.linkId, 'reject')">移除关联</el-button>
              </div>
            </article>
          </div>
          <el-empty v-else :image-size="84" description="当前 SKU 暂无马帮图片，可前往同步或在此上传" />
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.product-center-vue-page { display: grid; gap: 16px; }
.product-commandbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.product-commandbar h2 { margin: 4px 0; font-size: 20px; }
.product-commandbar p { margin: 0; color: var(--ops-text-secondary); font-size: 13px; }
.product-command-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.product-toolbar { align-items: center; }
.product-search-field { flex: 1.3; min-width: 260px; }
.product-filter-grid { flex: 2; display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 8px; }
.product-summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.product-summary-strip > div { min-height: 94px; display: grid; align-content: center; gap: 4px; padding: 14px 18px; border-right: 1px solid var(--ops-border-light); }
.product-summary-strip > div:last-child { border-right: 0; }
.product-summary-strip span, .product-summary-strip small { color: var(--ops-text-secondary); font-size: 11px; }
.product-summary-strip strong { font-size: 23px; font-variant-numeric: tabular-nums; }
.package-sync-panel { overflow: hidden; }
.package-sync-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 18px 20px; border-bottom: 1px solid var(--ops-border-light); }
.package-sync-header h3 { margin: 4px 0; font-size: 16px; }
.package-sync-header p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; }
.package-sync-state { display: grid; justify-items: end; gap: 8px; color: var(--ops-text-secondary); font-size: 11px; white-space: nowrap; }
.package-sync-state span { display: flex; align-items: center; gap: 5px; }
.package-sync-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-bottom: 1px solid var(--ops-border-light); }
.package-sync-metrics > div { display: grid; gap: 4px; padding: 15px 18px; border-right: 1px solid var(--ops-border-light); }
.package-sync-metrics > div:last-child { border-right: 0; }
.package-sync-metrics span, .package-sync-metrics small { color: var(--ops-text-secondary); font-size: 10px; }
.package-sync-metrics strong { font-size: 19px; font-variant-numeric: tabular-nums; }
.package-change-toolbar { display: grid; grid-template-columns: minmax(210px, 1.3fr) repeat(3, minmax(130px, .8fr)) minmax(150px, 1fr) auto; gap: 8px; padding: 14px 16px; background: var(--ops-surface-muted); }
.change-value { display: block; max-height: 70px; overflow: auto; overflow-wrap: anywhere; font-size: 11px; line-height: 1.5; }
.change-value.old { color: var(--ops-text-secondary); text-decoration-color: #fca5a5; }
.change-value.next { color: var(--ops-text-primary); font-weight: 650; }
.latest-change-mark { color: #b45309 !important; font-weight: 650; }
.source-database-grid { margin-top: 12px; }
.source-database-grid dt small { color: var(--ops-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }
.product-table-panel :deep(.el-table) { --el-table-header-bg-color: var(--ops-surface-muted); --el-table-border-color: var(--ops-border-light); }
.product-table-header-actions { display: flex; align-items: center; gap: 12px; }
.table-field-picker { display: grid; gap: 14px; }
.table-field-picker-heading { display: grid; gap: 4px; }
.table-field-picker-heading strong { font-size: 14px; }
.table-field-picker-heading span, .table-field-picker footer { color: var(--ops-text-secondary); font-size: 11px; }
.table-field-picker section { display: grid; gap: 8px; }
.table-field-picker-section-title, .table-field-picker footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.table-field-picker-section-title > span { font-size: 12px; font-weight: 650; }
.table-field-picker-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; }
.table-field-picker-grid.source-fields { max-height: 270px; padding: 8px 2px; overflow-y: auto; }
.table-field-picker-grid :deep(.el-checkbox) { min-width: 0; height: auto; margin-right: 0; }
.table-field-picker-grid :deep(.el-checkbox__label) { min-width: 0; display: flex; align-items: baseline; gap: 5px; overflow: hidden; font-size: 11px; }
.table-field-picker-grid :deep(.el-checkbox__label span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-field-picker-grid :deep(.el-checkbox__label small) { color: var(--ops-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }
.table-field-picker footer { padding-top: 10px; border-top: 1px solid var(--ops-border-light); }
.product-thumbnail { width: 62px; display: grid; justify-items: center; gap: 4px; color: var(--ops-text-muted); }
.product-thumbnail img { width: 52px; height: 52px; object-fit: cover; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface-muted); }
.product-thumbnail.empty { min-height: 52px; align-content: center; border: 1px dashed var(--ops-border); border-radius: 8px; background: var(--ops-surface-muted); }
.product-thumbnail span { font-size: 10px; white-space: nowrap; }
.product-thumbnail-entry { width: 76px; display: grid; justify-items: center; gap: 3px; padding: 3px; border: 0; border-radius: 9px; background: transparent; color: var(--ops-primary); cursor: pointer; }
.product-thumbnail-entry:hover { background: var(--ops-surface-muted); }
.product-thumbnail-entry > span { font-size: 10px; font-weight: 650; }
.product-name-cell, .product-stack-cell { display: grid; gap: 4px; min-width: 0; }
.product-name-cell strong { color: var(--ops-primary); font-variant-numeric: tabular-nums; }
.product-name-cell span, .product-stack-cell span { overflow: hidden; color: var(--ops-text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.product-stack-cell strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.product-row-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.product-row-actions :deep(.el-button + .el-button) { margin-left: 0; }
.product-row-actions.primary-actions :deep(.el-button) { min-width: 52px; }
.product-pagination { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-top: 1px solid var(--ops-border-light); color: var(--ops-text-secondary); font-size: 12px; }
.product-detail-content { min-height: 420px; padding: 8px 4px 28px; }
.product-detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 8px 12px 20px; border-bottom: 1px solid var(--ops-border-light); }
.product-detail-header h2 { margin: 5px 0; font-size: 22px; }
.product-detail-header p { margin: 0; color: var(--ops-text-secondary); font-size: 12px; }
.product-detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.product-detail-section { padding: 20px 12px; border-bottom: 1px solid var(--ops-border-light); }
.product-detail-section h3, .product-edit-form h3 { margin: 0 0 12px; font-size: 14px; }
.product-detail-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.product-detail-section-heading h3 { margin-bottom: 4px; }
.product-detail-section-heading p { margin: 0; color: var(--ops-text-secondary); font-size: 11px; }
.product-media-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.product-media-grid article { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px; border: 1px solid var(--ops-border-light); border-radius: 10px; }
.product-media-grid article > div:last-child { min-width: 0; display: grid; gap: 4px; }
.product-media-grid article strong, .product-media-grid article span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.product-media-grid article strong { font-size: 12px; }
.product-media-grid article span { color: var(--ops-text-secondary); font-size: 10px; }
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
.mabang-image-manager { min-height: 260px; display: grid; gap: 14px; }
.mabang-image-manager-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mabang-image-manager-toolbar > div { min-width: 0; display: flex; align-items: center; gap: 8px; }
.mabang-image-manager-toolbar > div:first-child { display: grid; gap: 3px; }
.mabang-image-manager-toolbar span { overflow: hidden; color: var(--ops-text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.mabang-image-manager-grid { display: grid; gap: 10px; max-height: 54vh; overflow-y: auto; }
.mabang-image-manager-grid article { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--ops-border-light); border-radius: 10px; }
.mabang-image-manager-copy { min-width: 0; display: grid; justify-items: start; gap: 5px; }
.mabang-image-manager-copy strong, .mabang-image-manager-copy span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mabang-image-manager-copy span { color: var(--ops-text-secondary); font-size: 11px; }
.mabang-image-manager-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.mabang-image-manager-actions :deep(.el-button + .el-button) { margin-left: 0; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 1280px) {
  .product-toolbar { align-items: stretch; flex-wrap: wrap; }
  .product-search-field { flex-basis: 100%; }
  .product-filter-grid { grid-template-columns: repeat(4, minmax(120px, 1fr)); }
  .package-change-toolbar { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 820px) {
  .product-commandbar { align-items: stretch; flex-direction: column; }
  .product-command-actions .el-button { flex: 1; }
  .product-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .product-summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .product-summary-strip > div:nth-child(2) { border-right: 0; }
  .product-summary-strip > div:nth-child(-n+2) { border-bottom: 1px solid var(--ops-border-light); }
  .product-pagination { align-items: flex-start; flex-direction: column; }
  .product-detail-header, .mabang-image-manager-toolbar { align-items: stretch; flex-direction: column; }
  .product-detail-actions { justify-content: flex-start; }
  .package-sync-header { flex-direction: column; }
  .package-sync-state { justify-items: start; }
  .package-sync-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .package-sync-metrics > div { border-bottom: 1px solid var(--ops-border-light); }
  .package-change-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
  .product-command-actions { display: grid; grid-template-columns: 1fr; }
  .product-filter-grid { grid-template-columns: 1fr; }
  .product-summary-strip { grid-template-columns: 1fr; }
  .product-summary-strip > div { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }
  .product-summary-strip > div:last-child { border-bottom: 0; }
  .product-detail-grid, .product-edit-grid { grid-template-columns: 1fr; }
  .mabang-image-manager-grid article { grid-template-columns: 72px minmax(0, 1fr); }
  .mabang-image-manager-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .package-sync-metrics, .package-change-toolbar { grid-template-columns: 1fr; }
  .product-edit-field.wide { grid-column: 1; }
  .product-pagination :deep(.el-pagination__sizes), .product-pagination :deep(.el-pager) { display: none; }
}
</style>
