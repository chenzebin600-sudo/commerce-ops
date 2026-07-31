<script setup lang="ts">
import { Bot, Check, Copy, Plus, RefreshCw, Save, Search, Send, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import MarketplaceImage from "@/components/MarketplaceImage.vue";
import {
  createDraftFromListing,
  createPublisherDraft,
  generatePublisherAiMaterial,
  loadListings,
  loadProductModels,
  loadPublisherCategories,
  loadPublisherCategorySchema,
  loadPublisherDrafts,
  loadPublisherEvents,
  refreshPublisherJob,
  runPublisherAction,
  updatePublisherDraft,
  type AiStatus,
  type ListingItem,
  type ListingShop,
  type ProductModel,
  type PublisherDraft,
  type PublisherDraftAsset,
  type PublisherDraftVariant,
} from "@/services/listing";

interface CategoryField {
  name?: string;
  label?: string;
  name_zh?: string;
  input_type?: string;
  is_mandatory?: boolean | number | string;
  options?: unknown[];
  values?: unknown[];
}

interface CategorySchema {
  normal: CategoryField[];
  sku: CategoryField[];
  public: CategoryField[];
  logics: CategoryField[];
}

interface DraftForm {
  platform: string;
  shop_id: string;
  shop_name: string;
  site: string;
  title: string;
  category_id: string;
  category_name: string;
  brand: string;
  description: string;
  attributes: Record<string, unknown>;
  extended: Record<string, unknown>;
  weight: string | number;
  package_length: string | number;
  package_width: string | number;
  package_height: string | number;
  variants: PublisherDraftVariant[];
  assets: PublisherDraftAsset[];
}

const props = defineProps<{ shops: ListingShop[]; seedListing: ListingItem | null; aiStatus: AiStatus | null }>();
const emit = defineEmits<{ returnManage: []; seedConsumed: [] }>();

const drafts = ref<PublisherDraft[]>([]);
const current = ref<PublisherDraft | null>(null);
const sourceMode = ref<"manual" | "listing" | "product">("manual");
const sourceQuery = ref("");
const listingTemplates = ref<ListingItem[]>([]);
const productModels = ref<ProductModel[]>([]);
const categories = ref<Array<Record<string, unknown>>>([]);
const categoryQuery = ref("");
const categorySchema = ref<CategorySchema | null>(null);
const events = ref<Array<{ id: number; event_type: string; status: string; message: string; created_at: string }>>([]);
const busy = ref("");
const sourceBusy = ref("");
const aiOpen = ref(false);
const aiPrompt = ref("");
const aiWarnings = ref<string[]>([]);
const seedKey = ref("");
const publishJob = ref<Record<string, unknown> | null>(null);
const publishedListing = ref<Record<string, unknown> | null>(null);
let publishTimer: number | null = null;

function emptyForm(): DraftForm {
  const shop = props.shops[0];
  return {
    platform: "lazada",
    shop_id: String(shop?.id || ""),
    shop_name: shop?.name || "",
    site: shop?.site || "",
    title: "",
    category_id: "",
    category_name: "",
    brand: "No Brand",
    description: "",
    attributes: {},
    extended: { source_mode: "manual" },
    weight: "0.1",
    package_length: "10",
    package_width: "10",
    package_height: "10",
    variants: [{ sku: "", specification_name: "规格", specification_value: "默认", price: "", special_price: "", stock: "" }],
    assets: [{ url: "" }],
  };
}

const form = reactive<DraftForm>(emptyForm());
const selectedShop = computed(() => props.shops.find((shop) => String(shop.id) === form.shop_id) || null);
const schemaFields = computed(() => [
  ...(categorySchema.value?.normal || []),
  ...(categorySchema.value?.public || []),
  ...(categorySchema.value?.logics || []),
]);

function replaceForm(next: DraftForm) {
  Object.assign(form, emptyForm(), next);
}

function draftToForm(draft: PublisherDraft): DraftForm {
  return {
    platform: draft.platform || "lazada",
    shop_id: String(draft.shop_id || ""),
    shop_name: draft.shop_name || "",
    site: draft.site || "",
    title: draft.title || "",
    category_id: String(draft.category_id || ""),
    category_name: draft.category_name || "",
    brand: draft.brand || "No Brand",
    description: draft.description || "",
    attributes: { ...(draft.attributes || {}) },
    extended: { ...(draft.extended || {}) },
    weight: draft.weight || "0.1",
    package_length: draft.package_length || "10",
    package_width: draft.package_width || "10",
    package_height: draft.package_height || "10",
    variants: (draft.variants || []).map((item) => ({ ...item })),
    assets: (draft.assets || []).map((item) => ({ ...item })),
  };
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    LOCAL_DRAFT: "本地草稿",
    SAVING_TO_MABANG: "正在保存",
    MABANG_DRAFT: "马帮草稿",
    READBACK_OK: "回读一致",
    VALIDATED: "校验通过",
    WAIT_CONFIRM: "等待确认",
    PUBLISH_SUBMITTED: "已提交",
    MABANG_ACCEPTED: "马帮已受理",
    PLATFORM_PROCESSING: "平台处理中",
    PUBLISHED: "已发布",
    FAILED: "需要处理",
  };
  return labels[value] || value || "本地草稿";
}

function statusType(value: string) {
  if (value === "PUBLISHED") return "success";
  if (value === "FAILED") return "danger";
  if (["WAIT_CONFIRM", "MABANG_ACCEPTED", "PLATFORM_PROCESSING"].includes(value)) return "warning";
  return "info";
}

function fieldLabel(field: CategoryField) {
  return String(field.name_zh || field.label || field.name || "平台属性");
}

function fieldRequired(field: CategoryField) {
  return [true, 1, "1", "true", "yes", "required"].includes(field.is_mandatory as true | 1 | string);
}

function fieldOptions(field: CategoryField) {
  return (field.options || field.values || []).map((item) => {
    if (item && typeof item === "object") {
      const option = item as Record<string, unknown>;
      return { value: String(option.value || option.id || option.name || ""), label: String(option.label || option.name_zh || option.name || option.value || "") };
    }
    return { value: String(item || ""), label: String(item || "") };
  }).filter((item) => item.value);
}

function categoryLabel(item: Record<string, unknown>) {
  return String(item.name_zh || item.category_name_zh || item.name || item.category_name_en || item.category_name || item.label || "");
}

function categoryId(item: Record<string, unknown>) {
  return String(item.category_id || item.id || item.categoryId || "");
}

function shopChanged() {
  form.shop_name = selectedShop.value?.name || "";
  form.site = selectedShop.value?.site || "";
  form.category_id = "";
  form.category_name = "";
  categorySchema.value = null;
  categories.value = [];
}

async function loadDraftList() {
  try {
    drafts.value = (await loadPublisherDrafts()).drafts || [];
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "无法读取刊登草稿"));
  }
}

async function selectDraft(draft: PublisherDraft) {
  current.value = draft;
  replaceForm(draftToForm(draft));
  const mode = String(draft.extended?.source_mode || "manual");
  sourceMode.value = mode === "mabang_listing" ? "listing" : mode === "product_model" ? "product" : "manual";
  const schema = draft.extended?.category_schema;
  categorySchema.value = schema && typeof schema === "object" ? schema as unknown as CategorySchema : null;
  try {
    events.value = (await loadPublisherEvents(draft.id)).events || [];
  } catch {
    events.value = [];
  }
}

function newDraft() {
  current.value = null;
  replaceForm(emptyForm());
  sourceMode.value = "manual";
  categorySchema.value = null;
  events.value = [];
  aiWarnings.value = [];
}

async function searchSources() {
  sourceBusy.value = sourceMode.value;
  try {
    if (sourceMode.value === "listing") {
      const result = await loadListings({
        platform: "lazada",
        state: "online",
        page: 1,
        pageSize: 20,
        query: sourceQuery.value.trim(),
        searchType: "title",
        shopIds: form.shop_id ? [form.shop_id] : [],
      });
      listingTemplates.value = result.items || [];
    } else if (sourceMode.value === "product") {
      productModels.value = (await loadProductModels(sourceQuery.value)).models || [];
    }
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "无法读取来源数据"));
  } finally {
    sourceBusy.value = "";
  }
}

async function useListingTemplate(item: ListingItem) {
  sourceBusy.value = `listing-${item.internal_id}`;
  try {
    const result = await createDraftFromListing(item);
    await selectDraft(result.draft);
    await loadDraftList();
    ElMessage.success("已复制现有链接的完整资料");
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "复制现有链接失败"));
  } finally {
    sourceBusy.value = "";
  }
}

function countryMatches(country: string | null) {
  if (!country || !form.site) return false;
  const aliases: Record<string, string[]> = { TH: ["TH", "泰国"], PH: ["PH", "菲律宾"], ID: ["ID", "印度尼西亚", "印尼"], VN: ["VN", "越南"], MY: ["MY", "马来西亚", "马来"] };
  return (aliases[form.site.toUpperCase()] || [form.site]).some((value) => value.toLowerCase() === country.toLowerCase());
}

function useProductModel(model: ProductModel) {
  const matching = model.variants.filter((item) => countryMatches(item.country));
  const variants = matching.length ? matching : model.variants;
  const images = [...new Set(variants.map((item) => item.externalImageUrl).filter(Boolean))] as string[];
  const first = variants[0];
  form.title = model.name || form.title;
  form.category_name = [model.categoryL1, model.categoryL2].filter(Boolean).join(" / ");
  form.weight = first?.weightG ? String(first.weightG / 1000) : form.weight;
  form.package_length = first?.packageLengthCm || form.package_length;
  form.package_width = first?.packageWidthCm || form.package_width;
  form.package_height = first?.packageHeightCm || form.package_height;
  form.assets = images.map((url) => ({ url }));
  form.variants = variants.map((item) => ({
    sku: item.sku,
    product_sku_id: item.productSkuId,
    specification_name: "销售规格",
    specification_value: item.salesSpec || "默认",
    price: item.priceTier25 || item.priceTier20 || "",
    special_price: "",
    stock: item.stock,
    properties: { variation: item.salesSpec || "Default" },
    images: item.externalImageUrl ? [item.externalImageUrl] : [],
  }));
  form.extended = { ...form.extended, source_mode: "product_model", source_model_id: model.id, source_main_sku: model.mainSku };
  ElMessage.success(`已带入 ${variants.length} 个同款 SKU`);
}

async function searchCategories() {
  if (!form.shop_id || !form.site) {
    ElMessage.warning("请先选择目标店铺");
    return;
  }
  sourceBusy.value = "categories";
  try {
    categories.value = (await loadPublisherCategories({ shopId: form.shop_id, site: form.site, query: categoryQuery.value })).categories || [];
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "无法查询平台类目"));
  } finally {
    sourceBusy.value = "";
  }
}

async function selectCategory(item: Record<string, unknown>) {
  const id = categoryId(item);
  if (!id) return;
  sourceBusy.value = "schema";
  try {
    const result = await loadPublisherCategorySchema(form.site, id);
    categorySchema.value = result.schema as unknown as CategorySchema;
    form.category_id = id;
    form.category_name = categoryLabel(item);
    form.extended = { ...form.extended, category: item, category_schema: result.schema };
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "无法读取平台类目字段"));
  } finally {
    sourceBusy.value = "";
  }
}

function addVariant() {
  form.variants.push({ sku: "", specification_name: "规格", specification_value: "", price: "", special_price: "", stock: "" });
}

function removeVariant(index: number) {
  if (form.variants.length <= 1) return;
  form.variants.splice(index, 1);
}

function addAsset() {
  form.assets.push({ url: "" });
}

function removeAsset(index: number) {
  if (form.assets.length <= 1) form.assets[0].url = "";
  else form.assets.splice(index, 1);
}

function payload() {
  return {
    ...form,
    extended: { ...form.extended, source_mode: sourceMode.value, category_schema: categorySchema.value || form.extended.category_schema || {} },
  };
}

async function saveLocal() {
  busy.value = "save";
  try {
    const result = current.value
      ? await updatePublisherDraft(current.value.id, payload())
      : await createPublisherDraft(payload());
    await selectDraft(result.draft);
    await loadDraftList();
    ElMessage.success(current.value ? "本地草稿已更新" : "本地草稿已创建");
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "保存草稿失败"));
  } finally {
    busy.value = "";
  }
}

async function action(name: "clone" | "validate" | "save-to-mabang" | "confirm" | "publish") {
  if (!current.value) return;
  if (name === "publish") {
    await ElMessageBox.confirm("确认把当前已校验草稿提交到马帮刊登？", "确认刊登", { type: "warning", confirmButtonText: "确认提交" });
  }
  busy.value = name;
  try {
    const result = await runPublisherAction(current.value.id, name, name === "confirm" ? { expected_version: current.value.version } : {});
    const draft = result.draft as PublisherDraft | undefined;
    if (draft) await selectDraft(draft);
    publishJob.value = (result.job as Record<string, unknown> | undefined) || publishJob.value;
    publishedListing.value = (result.listing as Record<string, unknown> | undefined) || publishedListing.value;
    if (name === "publish" && publishJob.value) schedulePublishPoll();
    await loadDraftList();
    ElMessage.success(name === "save-to-mabang" ? "马帮草稿已保存并回读" : name === "publish" ? "刊登任务已提交" : name === "confirm" ? "草稿版本已确认" : name === "clone" ? "草稿副本已创建" : "校验完成");
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "刊登流程操作失败"));
  } finally {
    busy.value = "";
  }
}

function schedulePublishPoll() {
  const id = String(publishJob.value?.id || "");
  if (!id || ["PUBLISHED", "FAILED"].includes(String(current.value?.status || ""))) return;
  if (publishTimer !== null) window.clearTimeout(publishTimer);
  publishTimer = window.setTimeout(async () => {
    try {
      const result = await refreshPublisherJob(id);
      publishJob.value = result.job;
      publishedListing.value = result.listing;
      await selectDraft(result.draft);
      await loadDraftList();
      schedulePublishPoll();
    } catch {
      schedulePublishPoll();
    }
  }, 1600);
}

async function generateMaterial() {
  if (!props.aiStatus?.configured) {
    ElMessage.warning("DeepSeek 尚未配置");
    return;
  }
  if (!aiPrompt.value.trim()) {
    ElMessage.warning("请输入商品资料要求");
    return;
  }
  busy.value = "ai";
  try {
    const result = await generatePublisherAiMaterial(aiPrompt.value.trim());
    const material = result.material as {
      title?: string; brand?: string; category_name?: string; description?: string;
      attributes?: Record<string, unknown>; images?: string[]; warnings?: string[];
      variants?: Array<{ sku?: string; specification_name?: string; specification_value?: string; price?: number | null; stock?: number | null }>;
    };
    form.title = material.title || form.title;
    form.brand = material.brand || form.brand;
    form.category_name = material.category_name || form.category_name;
    form.description = material.description || form.description;
    form.attributes = material.attributes || form.attributes;
    if (material.images?.length) form.assets = material.images.map((url) => ({ url }));
    if (material.variants?.length) {
      form.variants = material.variants.map((item) => ({
        sku: item.sku || "",
        specification_name: item.specification_name || "规格",
        specification_value: item.specification_value || "默认",
        price: item.price || "",
        special_price: "",
        stock: item.stock || "",
      }));
    }
    aiWarnings.value = material.warnings || [];
    aiOpen.value = false;
    ElMessage.success("AI 商品资料已填入表单，请人工检查后保存");
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "AI 商品资料生成失败"));
  } finally {
    busy.value = "";
  }
}

watch(() => props.seedListing, async (seed) => {
  if (!seed) return;
  const key = `${seed.platform}:${seed.internal_id}`;
  if (seedKey.value === key) return;
  seedKey.value = key;
  busy.value = "copy";
  try {
    const result = await createDraftFromListing(seed);
    await selectDraft(result.draft);
    await loadDraftList();
    ElMessage.success("已复制在线链接为本地刊登草稿");
  } catch (reason) {
    ElMessage.error(String((reason as Error)?.message || reason || "复制商品模板失败"));
  } finally {
    busy.value = "";
    emit("seedConsumed");
  }
}, { immediate: true });

onMounted(loadDraftList);
onBeforeUnmount(() => {
  if (publishTimer !== null) window.clearTimeout(publishTimer);
});
</script>

<template>
  <section class="publisher-workbench" v-loading="Boolean(busy)">
    <aside class="draft-rail">
      <header><div><span class="panel-kicker">刊登草稿</span><strong>{{ drafts.length }} 个</strong></div><el-button circle text :icon="RefreshCw" title="刷新草稿" @click="loadDraftList" /></header>
      <el-button type="primary" :icon="Plus" @click="newDraft">手动创建商品</el-button>
      <div class="draft-list">
        <button v-for="draft in drafts" :key="draft.id" type="button" :class="{ active: current?.id === draft.id }" @click="selectDraft(draft)">
          <strong>{{ draft.title || "未命名草稿" }}</strong><span>{{ draft.shop_name || "未选择店铺" }}</span><el-tag :type="statusType(draft.status)" size="small">{{ statusLabel(draft.status) }}</el-tag>
        </button>
      </div>
      <el-button text @click="emit('returnManage')">返回在线商品管理</el-button>
    </aside>

    <div class="publisher-main">
      <header class="publisher-head">
        <div><span class="panel-kicker">LAZADA PUBLISHER</span><h2>{{ current ? "编辑刊登草稿" : "新建 Lazada 商品" }}</h2></div>
        <div><el-button :icon="Bot" @click="aiOpen = true">AI 生成资料</el-button><el-button type="primary" :icon="Save" :loading="busy === 'save'" @click="saveLocal">保存草稿</el-button></div>
      </header>

      <section class="source-panel">
        <el-segmented v-model="sourceMode" :options="[{ label: '手动创建', value: 'manual' }, { label: '复制现有链接', value: 'listing' }, { label: '产品中心款式', value: 'product' }]" />
        <div v-if="sourceMode !== 'manual'" class="source-search"><el-input v-model="sourceQuery" clearable :placeholder="sourceMode === 'listing' ? '搜索现有 Lazada 链接' : '搜索款名、主 SKU 或商品名'" @keyup.enter="searchSources" /><el-button :icon="Search" :loading="Boolean(sourceBusy)" @click="searchSources">查询</el-button></div>
        <div v-if="sourceMode === 'listing' && listingTemplates.length" class="source-results">
          <button v-for="item in listingTemplates" :key="item.internal_id" type="button" @click="useListingTemplate(item)"><MarketplaceImage :source="item.image" :alt="item.title" :size="42" /><span><strong>{{ item.title }}</strong><small>{{ item.shop_name }} · {{ item.variants.length }} 个变体</small></span><Copy :size="15" /></button>
        </div>
        <div v-if="sourceMode === 'product' && productModels.length" class="source-results">
          <button v-for="model in productModels" :key="model.id" type="button" @click="useProductModel(model)"><span><strong>{{ model.name }}</strong><small>{{ model.mainSku }} · {{ model.variantCount }} 个 SKU · {{ model.categoryL1 }} / {{ model.categoryL2 }}</small></span><Plus :size="15" /></button>
        </div>
      </section>

      <section class="form-section">
        <header><div><span class="section-index">01</span><h3>目标店铺与基本信息</h3></div></header>
        <div class="form-grid">
          <label><span>目标店铺 *</span><el-select v-model="form.shop_id" filterable @change="shopChanged"><el-option v-for="shop in shops" :key="shop.id" :label="`${shop.name} · ${shop.site}`" :value="String(shop.id)" /></el-select></label>
          <label class="span-2"><span>商品标题 *</span><el-input v-model="form.title" maxlength="500" show-word-limit /></label>
          <label><span>品牌</span><el-input v-model="form.brand" /></label>
          <label class="span-2"><span>商品描述 *</span><el-input v-model="form.description" type="textarea" :rows="5" /></label>
        </div>
      </section>

      <section class="form-section">
        <header><div><span class="section-index">02</span><h3>平台类目与属性</h3></div><span>{{ form.category_name || '尚未选择类目' }}</span></header>
        <div class="category-search"><el-input v-model="categoryQuery" clearable placeholder="按平台类目名称搜索" @keyup.enter="searchCategories" /><el-button :icon="Search" :loading="sourceBusy === 'categories'" @click="searchCategories">查询类目</el-button></div>
        <div v-if="categories.length" class="category-results"><button v-for="item in categories" :key="categoryId(item)" type="button" :class="{ active: form.category_id === categoryId(item) }" @click="selectCategory(item)">{{ categoryLabel(item) }}</button></div>
        <div v-if="schemaFields.length" class="schema-grid">
          <label v-for="field in schemaFields" :key="field.name"><span>{{ fieldLabel(field) }} <b v-if="fieldRequired(field)">*</b></span>
            <el-select v-if="fieldOptions(field).length" v-model="form.attributes[String(field.name)]" filterable clearable><el-option v-for="option in fieldOptions(field)" :key="option.value" :label="option.label" :value="option.value" /></el-select>
            <el-input v-else v-model="form.attributes[String(field.name)]" />
          </label>
        </div>
      </section>

      <section class="form-section">
        <header><div><span class="section-index">03</span><h3>SKU 变体</h3></div><el-button :icon="Plus" @click="addVariant">添加变体</el-button></header>
        <el-table :data="form.variants" border>
          <el-table-column label="变体 SKU" min-width="150"><template #default="scope"><el-input v-model="scope.row.sku" /></template></el-table-column>
          <el-table-column label="规格名" min-width="120"><template #default="scope"><el-input v-model="scope.row.specification_name" /></template></el-table-column>
          <el-table-column label="规格值" min-width="140"><template #default="scope"><el-input v-model="scope.row.specification_value" /></template></el-table-column>
          <el-table-column label="售价" width="130"><template #default="scope"><el-input v-model="scope.row.price" /></template></el-table-column>
          <el-table-column label="促销价" width="130"><template #default="scope"><el-input v-model="scope.row.special_price" /></template></el-table-column>
          <el-table-column label="库存" width="110"><template #default="scope"><el-input v-model="scope.row.stock" /></template></el-table-column>
          <el-table-column width="52"><template #default="scope"><el-button circle text type="danger" :icon="Trash2" title="删除变体" @click="removeVariant(scope.$index)" /></template></el-table-column>
        </el-table>
      </section>

      <section class="form-section">
        <header><div><span class="section-index">04</span><h3>商品素材与物流</h3></div><el-button :icon="Plus" @click="addAsset">添加图片</el-button></header>
        <div class="asset-list"><div v-for="(asset,index) in form.assets" :key="index"><MarketplaceImage v-if="asset.url" :source="asset.url" alt="刊登图片" :size="58" /><el-input v-model="asset.url" placeholder="https://..." /><el-button circle text type="danger" :icon="Trash2" title="删除图片" @click="removeAsset(index)" /></div></div>
        <div class="logistics-grid"><label><span>重量 kg</span><el-input v-model="form.weight" /></label><label><span>长 cm</span><el-input v-model="form.package_length" /></label><label><span>宽 cm</span><el-input v-model="form.package_width" /></label><label><span>高 cm</span><el-input v-model="form.package_height" /></label></div>
      </section>

      <section v-if="current" class="publish-actions">
        <div><el-tag :type="statusType(current.status)">{{ statusLabel(current.status) }}</el-tag><span>版本 {{ current.version }}</span><span v-if="current.last_error" class="error-text">{{ current.last_error }}</span></div>
        <div><el-button :icon="Copy" @click="action('clone')">复制草稿</el-button><el-button :icon="Check" @click="action('validate')">校验</el-button><el-button @click="action('save-to-mabang')">保存到马帮</el-button><el-button @click="action('confirm')">人工确认</el-button><el-button type="primary" :icon="Send" @click="action('publish')">提交刊登</el-button></div>
      </section>

      <el-alert
        v-if="publishedListing"
        type="success"
        :closable="false"
        :title="`平台刊登已生成：${String(publishedListing.platform_product_id || publishedListing.product_url || '')}`"
      />

      <section v-if="events.length" class="event-list"><header><span class="panel-kicker">AUDIT TRAIL</span><h3>刊登记录</h3></header><div v-for="event in events" :key="event.id"><el-tag size="small">{{ event.status }}</el-tag><strong>{{ event.event_type }}</strong><span>{{ event.message }}</span><time>{{ event.created_at }}</time></div></section>
    </div>

    <el-dialog v-model="aiOpen" title="DeepSeek 商品资料助手" width="min(680px, 94vw)">
      <el-alert type="info" :closable="false" :title="`模型 ${aiStatus?.model || 'deepseek-v4-flash'} 只生成候选资料，不会直接发布`" />
      <el-input v-model="aiPrompt" type="textarea" :rows="8" placeholder="输入产品、站点、受众、卖点、SKU 规格及期望价格等资料" />
      <el-alert v-for="warning in aiWarnings" :key="warning" type="warning" :closable="false" :title="warning" />
      <template #footer><el-button @click="aiOpen = false">取消</el-button><el-button type="primary" :icon="Bot" :loading="busy === 'ai'" @click="generateMaterial">生成并填入表单</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.publisher-workbench { display: grid; grid-template-columns: 230px minmax(0,1fr); min-height: 720px; border: 1px solid var(--ops-border-light); border-radius: 8px; background: var(--ops-surface); overflow: hidden; }
.draft-rail { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-right: 1px solid var(--ops-border-light); background: var(--ops-surface-muted); }.draft-rail header { display: flex; align-items: center; justify-content: space-between; }.draft-rail header > div { display: grid; gap: 3px; }.draft-list { display: grid; gap: 5px; overflow-y: auto; }.draft-list button { display: grid; gap: 4px; padding: 9px; border: 1px solid transparent; border-radius: 6px; background: transparent; text-align: left; cursor: pointer; }.draft-list button:hover,.draft-list button.active { border-color: var(--ops-border); background: var(--ops-surface); }.draft-list span { color: var(--ops-text-secondary); font-size: 10px; }.draft-list .el-tag { justify-self: start; }
.publisher-main { display: grid; align-content: start; gap: 14px; padding: 16px; min-width: 0; }.publisher-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }.publisher-head h2 { margin: 3px 0 0; font-size: 21px; }.publisher-head > div:last-child { display: flex; gap: 8px; }
.source-panel,.form-section,.publish-actions,.event-list { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--ops-border-light); border-radius: 7px; }.source-search,.category-search { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; }.source-results { display: grid; grid-template-columns: repeat(auto-fit,minmax(270px,1fr)); gap: 7px; }.source-results button { display: flex; align-items: center; gap: 9px; padding: 8px; border: 1px solid var(--ops-border-light); border-radius: 6px; background: var(--ops-surface); text-align: left; cursor: pointer; }.source-results button > span { flex: 1; display: grid; gap: 3px; min-width: 0; }.source-results small { color: var(--ops-text-secondary); }
.form-section > header,.event-list > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }.form-section > header > div { display: flex; align-items: center; gap: 8px; }.form-section h3,.event-list h3 { margin: 0; font-size: 15px; }.section-index { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 5px; background: #e0f2fe; color: #0369a1; font-size: 10px; font-weight: 800; }
.form-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 11px; }.form-grid label,.schema-grid label,.logistics-grid label { display: grid; gap: 5px; }.form-grid label > span,.schema-grid label > span,.logistics-grid label > span { font-size: 11px; font-weight: 650; }.form-grid .span-2 { grid-column: 1 / -1; }.category-results { display: flex; flex-wrap: wrap; gap: 6px; }.category-results button { padding: 6px 9px; border: 1px solid var(--ops-border-light); border-radius: 5px; background: var(--ops-surface); cursor: pointer; }.category-results button.active { border-color: var(--ops-primary); color: var(--ops-primary); }.schema-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; }.schema-grid b { color: #dc2626; }
.asset-list { display: grid; gap: 8px; }.asset-list > div { display: grid; grid-template-columns: 58px minmax(0,1fr) 34px; align-items: center; gap: 8px; }.logistics-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; }.publish-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }.publish-actions > div { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }.error-text { color: #b91c1c; font-size: 11px; }
.event-list > div { display: grid; grid-template-columns: 90px 140px minmax(0,1fr) 150px; align-items: start; gap: 8px; padding-top: 8px; border-top: 1px solid var(--ops-border-light); font-size: 11px; }.event-list time { color: var(--ops-text-secondary); }
:deep(.el-dialog__body) { display: grid; gap: 12px; }
@media (max-width: 1000px) { .publisher-workbench { grid-template-columns: 1fr; }.draft-rail { border-right: 0; border-bottom: 1px solid var(--ops-border-light); }.draft-list { grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); max-height: 220px; }.schema-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.publish-actions { align-items: flex-start; flex-direction: column; } }
@media (max-width: 640px) { .publisher-main { padding: 10px; }.publisher-head { flex-direction: column; }.form-grid,.schema-grid,.logistics-grid { grid-template-columns: 1fr; }.form-grid .span-2 { grid-column: auto; }.event-list > div { grid-template-columns: 80px 1fr; }.event-list > div span,.event-list > div time { grid-column: 1 / -1; } }
</style>
