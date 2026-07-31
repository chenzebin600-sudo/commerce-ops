<script setup lang="ts">
import { Download, ExternalLink, Play, RotateCcw } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, reactive, ref } from "vue";
import { analyzeKeyword, analyzeLinks, type CompetitorProduct, type CompetitorReport } from "@/services/competitor";
import { apiJson } from "@/services/api";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{ mode: "link" | "keyword" }>();
const workspace = useWorkspaceStore();
const loading = ref(false);
const error = ref("");
const report = ref<CompetitorReport | null>(null);
const activeTab = ref("products");
const linkForm = reactive({ myUrl: "", competitorUrls: "", model: "deepseek-chat" });
const keywordForm = reactive({ keyword: "", productDescription: "", country: "PH", site: "lazada", model: "deepseek-chat" });

const title = computed(() => props.mode === "link" ? "链接竞品分析" : "关键词 TOP5 研究");
const subtitle = computed(() => props.mode === "link" ? "抓取我的商品与竞品链接，统一比较价格、SKU、详情和主图。" : "按国家和平台发现关键词销量 TOP5，并生成商品与运营分析。" );
const products = computed(() => report.value?.products || []);
const insights = computed(() => {
  const modules = report.value?.analysis?.modules || {};
  const rows: Array<{ module: string; text: string }> = [];
  for (const [module, value] of Object.entries(modules)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (typeof entry === "string") rows.push({ module, text: entry });
      else if (entry && typeof entry === "object") rows.push({ module, text: Object.values(entry).filter((item) => typeof item === "string").join(" · ") });
    }
  }
  if (!rows.length && report.value?.analysis?.raw) rows.push({ module: "DeepSeek", text: report.value.analysis.raw });
  return rows;
});

function detectPlatform(url: string) {
  return /lazada\.|shopee\.|tiktokshop\.|shop\.tiktok/i.test(url);
}

function field(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return "—";
}

async function run() {
  error.value = "";
  if (props.mode === "link") {
    const competitorUrls = linkForm.competitorUrls.split(/\n+/).map((item) => item.trim()).filter(Boolean);
    const urls = [linkForm.myUrl.trim(), ...competitorUrls].filter(Boolean);
    if (!urls.length) { error.value = "请至少填写一个商品链接。"; return; }
    if (urls.some((url) => !detectPlatform(url))) { error.value = "仅支持 Lazada、Shopee 或 TikTok Shop 商品链接。"; return; }
    loading.value = true;
    try {
      report.value = await analyzeLinks({ myUrl: linkForm.myUrl.trim(), competitorUrls, model: linkForm.model });
      workspace.lastSyncedAt = new Date();
    } catch (runError) {
      error.value = String((runError as Error)?.message || runError || "竞品分析失败");
    } finally { loading.value = false; }
    return;
  }
  if (!keywordForm.keyword.trim() && !keywordForm.productDescription.trim()) { error.value = "请输入关键词或产品描述。"; return; }
  loading.value = true;
  try {
    report.value = await analyzeKeyword({ ...keywordForm, keyword: keywordForm.keyword.trim(), productDescription: keywordForm.productDescription.trim() });
    workspace.lastSyncedAt = new Date();
  } catch (runError) {
    error.value = String((runError as Error)?.message || runError || "关键词分析失败");
  } finally { loading.value = false; }
}

function reset() {
  report.value = null;
  error.value = "";
  if (props.mode === "link") Object.assign(linkForm, { myUrl: "", competitorUrls: "", model: "deepseek-chat" });
  else Object.assign(keywordForm, { keyword: "", productDescription: "", country: "PH", site: "lazada", model: "deepseek-chat" });
}

function downloadReport() {
  if (!report.value) return;
  const blob = new Blob([JSON.stringify(report.value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${props.mode}-competitor-report-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  apiJson("/api/audit/client-action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: props.mode === "link" ? "competitor.export.download" : "competitor.keyword_export.download", kind: props.mode }) }).catch(() => {});
  ElMessage.success("分析结果已导出");
}

function productUrl(product: CompetitorProduct) { return product.finalUrl || product.inputUrl || ""; }
</script>

<template>
  <div class="competitor-vue-page" v-loading="loading">
    <section class="competitor-hero">
      <div><span class="panel-kicker">MARKET INTELLIGENCE</span><h2>{{ title }}</h2><p>{{ subtitle }}</p></div>
      <div class="competitor-hero-actions"><el-button :icon="RotateCcw" @click="reset">重置</el-button><el-button :icon="Download" :disabled="!report" @click="downloadReport">导出结果</el-button><el-button type="primary" :icon="Play" :loading="loading" @click="run">开始分析</el-button></div>
    </section>

    <section class="dashboard-panel competitor-input-panel">
      <header><div><span class="panel-kicker">INPUT</span><h3>{{ mode === "link" ? "商品链接" : "搜索条件" }}</h3></div><span>真实平台数据</span></header>
      <div v-if="mode === 'link'" class="competitor-form-grid">
        <label class="field-block"><span>我的商品链接</span><el-input v-model="linkForm.myUrl" placeholder="https://..." clearable /></label>
        <label class="field-block"><span>竞品商品链接（每行一个）</span><el-input v-model="linkForm.competitorUrls" type="textarea" :rows="4" placeholder="支持 Lazada、Shopee、TikTok Shop" /></label>
        <label class="field-block compact"><span>分析模型</span><el-input v-model="linkForm.model" /></label>
      </div>
      <div v-else class="keyword-form-grid">
        <label class="field-block"><span>关键词</span><el-input v-model="keywordForm.keyword" placeholder="例如：收纳架" clearable /></label>
        <label class="field-block"><span>国家</span><el-select v-model="keywordForm.country"><el-option v-for="item in ['PH','TH','MY','SG','VN','ID']" :key="item" :label="item" :value="item" /></el-select></label>
        <label class="field-block"><span>平台</span><el-select v-model="keywordForm.site"><el-option label="Lazada" value="lazada" /><el-option label="Shopee" value="shopee" /><el-option label="TikTok Shop" value="tiktok" /></el-select></label>
        <label class="field-block"><span>分析模型</span><el-input v-model="keywordForm.model" /></label>
        <label class="field-block full"><span>参考产品描述</span><el-input v-model="keywordForm.productDescription" type="textarea" :rows="3" placeholder="可补充材质、用途、目标人群和核心卖点" /></label>
      </div>
    </section>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-else-if="report?.needsVerification" type="warning" :closable="false" show-icon title="平台触发了验证，请在主服务器浏览器完成验证后重新运行。" />

    <section v-if="report" class="dashboard-panel data-workbench competitor-results">
      <el-tabs v-model="activeTab">
        <el-tab-pane :label="`商品概览 ${products.length}`" name="products">
          <el-table :data="products" stripe empty-text="暂无商品数据">
            <el-table-column label="角色" width="90"><template #default="scope">{{ scope.row.rank ? `TOP ${scope.row.rank}` : scope.row.role || "商品" }}</template></el-table-column>
            <el-table-column prop="platform" label="平台" width="110" />
            <el-table-column prop="title" label="商品标题" min-width="260" show-overflow-tooltip />
            <el-table-column prop="shopName" label="店铺" min-width="170" />
            <el-table-column prop="rating" label="评分" width="90" align="right" />
            <el-table-column prop="reviewCount" label="评价" width="100" align="right" />
            <el-table-column prop="soldCount" label="销量" width="100" align="right" />
            <el-table-column label="链接" width="90" fixed="right"><template #default="scope"><el-button v-if="productUrl(scope.row)" link type="primary" :icon="ExternalLink" tag="a" :href="productUrl(scope.row)" target="_blank">打开</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`SKU 对比 ${report.skuComparison?.length || 0}`" name="sku">
          <el-table :data="report.skuComparison || []" stripe empty-text="暂无 SKU 对比">
            <el-table-column label="归一 SKU" min-width="160"><template #default="scope">{{ field(scope.row, "normalizedName", "normalized", "name") }}</template></el-table-column>
            <el-table-column label="我的 SKU" min-width="180"><template #default="scope">{{ field(scope.row, "mineName", "mySku", "mine") }}</template></el-table-column>
            <el-table-column label="我的价格" width="120" align="right"><template #default="scope">{{ field(scope.row, "minePrice", "myPrice") }}</template></el-table-column>
            <el-table-column label="竞品 SKU" min-width="180"><template #default="scope">{{ field(scope.row, "competitorName", "competitorSku", "competitor") }}</template></el-table-column>
            <el-table-column label="竞品价格" width="120" align="right"><template #default="scope">{{ field(scope.row, "competitorPrice") }}</template></el-table-column>
            <el-table-column label="差价" width="110" align="right"><template #default="scope">{{ field(scope.row, "priceDifference", "difference") }}</template></el-table-column>
            <el-table-column label="匹配依据" min-width="190"><template #default="scope">{{ field(scope.row, "matchReason", "basis") }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`详情差异 ${report.productDetailsComparison?.length || 0}`" name="details">
          <el-table :data="report.productDetailsComparison || []" stripe empty-text="暂无详情差异">
            <el-table-column label="属性" min-width="170"><template #default="scope">{{ field(scope.row, "attribute", "name", "key") }}</template></el-table-column>
            <el-table-column label="我的商品" min-width="240"><template #default="scope">{{ field(scope.row, "mine", "myValue") }}</template></el-table-column>
            <el-table-column label="竞品商品" min-width="240"><template #default="scope">{{ field(scope.row, "competitor", "competitorValue") }}</template></el-table-column>
            <el-table-column label="优势方" width="120"><template #default="scope">{{ field(scope.row, "advantage", "winner") }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`AI 洞察 ${insights.length}`" name="insights"><div v-if="insights.length" class="insight-list"><article v-for="(item,index) in insights" :key="`${item.module}-${index}`"><span>{{ item.module }}</span><p>{{ item.text }}</p></article></div><el-empty v-else description="暂无 AI 洞察" /></el-tab-pane>
      </el-tabs>
    </section>
    <section v-else class="competitor-empty"><div><Play :size="24" /></div><h3>等待分析任务</h3><p>填写输入条件后开始运行，结果会按商品、SKU、详情和 AI 洞察分层展示。</p></section>
  </div>
</template>

<style scoped>
.competitor-vue-page { display: grid; gap: 16px; }
.competitor-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; }.competitor-hero h2 { margin: 4px 0; font-size: 21px; }.competitor-hero p { margin: 0; color: var(--ops-text-secondary); font-size: 13px; }.competitor-hero-actions { display: flex; gap: 8px; }
.competitor-input-panel { overflow: visible; }.competitor-form-grid, .keyword-form-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; padding: 16px; }.competitor-form-grid { grid-template-columns: 1fr 1.3fr .5fr; }.field-block { display: grid; gap: 7px; }.field-block > span { color: var(--ops-text-secondary); font-size: 12px; font-weight: 650; }.field-block.full { grid-column: 1 / -1; }
.competitor-results { padding: 0 16px 16px; }.insight-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }.insight-list article { padding: 14px; border: 1px solid var(--ops-border-light); border-radius: 9px; background: var(--ops-surface-muted); }.insight-list span { color: var(--ops-primary); font-size: 10px; font-weight: 800; text-transform: uppercase; }.insight-list p { margin: 7px 0 0; line-height: 1.6; }
.competitor-empty { min-height: 320px; display: grid; place-items: center; align-content: center; gap: 8px; border: 1px dashed var(--ops-border); border-radius: var(--ops-radius-md); background: var(--ops-surface); text-align: center; }.competitor-empty > div { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 14px; color: var(--ops-primary); background: #eff6ff; }.competitor-empty h3 { margin: 6px 0 0; }.competitor-empty p { max-width: 520px; margin: 0; color: var(--ops-text-secondary); font-size: 12px; }
@media (max-width: 900px) { .competitor-hero { align-items: stretch; flex-direction: column; }.competitor-form-grid, .keyword-form-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.insight-list { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .competitor-hero-actions { display: grid; grid-template-columns: 1fr 1fr; }.competitor-hero-actions .el-button:last-child { grid-column: 1 / -1; }.competitor-form-grid, .keyword-form-grid { grid-template-columns: 1fr; }.field-block.full { grid-column: 1; } }
</style>
