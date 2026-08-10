<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Copy,
  FileJson,
  Radio,
  Search,
  ShieldCheck,
  TerminalSquare,
} from "@lucide/vue";
import { ElMessage } from "element-plus";

type ApiMethod = "GET" | "POST";
type DocsTab = "apis" | "guides" | "push" | "calling" | "terms";

interface DocParam {
  name?: string;
  type?: string;
  required?: boolean | null;
  sample?: unknown;
  description?: string;
  children?: DocParam[];
}

interface ApiDocument {
  id: number;
  name: string;
  moduleId: number;
  moduleName: string;
  method: ApiMethod;
  path: string;
  url?: string;
  descriptionHtml?: string;
  commonParameters?: DocParam[];
  parameters?: { request_params?: DocParam[]; response_params?: DocParam[] };
  requestSample?: unknown;
  responseSample?: unknown;
  errors?: Array<{ name: string; description: string; solution?: string | null }>;
  commonErrors?: Array<{ name: string; description: string; solution?: string | null }>;
  permissions?: string[];
  rateLimit?: string;
  updateLogs?: Array<{ date: string; content: string }>;
}

interface ApiModule {
  id: number;
  name: string;
  items: ApiDocument[];
}

interface GuideItem {
  id: number;
  name: string;
  type: number;
}

interface PushDocument {
  categoryId: number;
  categoryName: string;
  update_logs?: Array<{ ctime: number; description: string }>;
  push_api?: {
    push_api_id: number;
    push_api_name: string;
    push_code: number;
    description: string;
    push_timeout: number;
    retry_strategy?: number[];
    push_params?: string;
    push_content?: string;
  };
}

interface OfficialDocs {
  fetchedAt: string;
  stats: { modules: number; apis: number; guideSections: number; pushCategories: number; pushEvents: number };
  guideModules: Array<{ id: number; name: string; items: GuideItem[] }>;
  modules: ApiModule[];
  pushDocuments: PushDocument[];
}

interface FlatParam extends DocParam { depth: number }

const emit = defineEmits<{
  apiSelected: [payload: { method: ApiMethod; path: string; name: string }];
}>();

const docs = ref<OfficialDocs | null>(null);
const loading = ref(true);
const loadError = ref("");
const activeTab = ref<DocsTab>("apis");
const query = ref("");
const selectedModuleId = ref<number | null>(null);
const selectedApiName = ref("");
const selectedPushId = ref<number | null>(null);
const detailSection = ref<"request" | "response" | "examples" | "errors" | "updates">("request");

const guideNotes: Record<string, { title: string; summary: string; points: string[] }> = {
  Introduction: { title: "平台简介", summary: "了解 Shopee Open Platform 的定位、适用对象和能力边界。", points: ["用于第三方系统与 Shopee 店铺、商户数据对接", "生产调用需创建应用并取得相应权限", "接口、授权和 Push 均以 OpenAPI 2.0 为准"] },
  "OpenAPI 2.0 Overview": { title: "OpenAPI 2.0 总览", summary: "接口域名、公共参数、签名、Token 与标准响应结构。", points: ["签名使用 partner_id、path、timestamp、access_token、shop_id/merchant_id", "access_token 通常有效 4 小时，refresh_token 用于换新", "timestamp 与服务器时间偏差不可超过 5 分钟"] },
  "[中文版] OpenAPI 2.0 Overview": { title: "OpenAPI 2.0 中文总览", summary: "官方中文版本的公共调用规范。", points: ["优先阅读该章节确认签名拼接顺序", "区分店铺级、商户级接口的公共参数", "业务错误需检查响应 error 与 request_id"] },
  "[中文版]CNSC API对接用户手册": { title: "CNSC 对接手册", summary: "跨境卖家中心相关的店铺、商品与订单对接说明。", points: ["关注 merchant_id 与 shop_id 的层级关系", "全球商品与本地商品使用不同模块", "按实际店铺类型选择 GlobalProduct 或 Product"] },
  "KRSC API Integration Guide": { title: "KRSC 对接指南", summary: "韩国跨境卖家中心 API 集成要求。", points: ["适用于 KRSC 业务形态", "核对站点和商户权限", "字段适用性以接口详情为准"] },
  "Developer Guide": { title: "开发者指南", summary: "从应用创建、测试到发布与运营的完整流程。", points: ["创建应用并配置回调地址", "完成店铺或商户授权", "保存授权关系并实施 Token 自动刷新"] },
  "API Call Flows": { title: "API 调用流程", summary: "授权、签名、发起请求和处理响应的标准步骤。", points: ["先取得授权 code，再换取 access_token", "每次请求生成 timestamp 与 sign", "记录 request_id，便于错误追踪"] },
  "Developer Types and APP Types": { title: "开发者与应用类型", summary: "不同开发者身份、应用类型及可申请权限。", points: ["应用类型决定可申请的 API 权限", "权限不足会返回 auth/permission 类错误", "新增业务能力前需确认应用审核状态"] },
  "Data Definition": { title: "数据定义", summary: "店铺、商户、商品、订单等核心对象的层级关系。", points: ["shop_id 是店铺唯一标识", "merchant_id 是商户唯一标识", "item_id、model_id 与 order_sn 是常用业务主键"] },
  "Push Mechanism(WebHook)": { title: "Push / WebHook 机制", summary: "事件订阅、验签、超时与重试规则。", points: ["回调服务必须能被 Shopee 公网访问", "在超时时间内快速返回成功响应", "处理重复推送时必须做幂等"] },
};

const descriptionTranslations: Record<string, string> = {
  "Video information collection, no more than 5.": "视频信息集合，最多提交 5 条。",
  "ID of uploaded video. Obtain from v2.media.get_video_upload_result.": "已上传视频的 ID，可通过 v2.media.get_video_upload_result 接口获得。",
  "Description of the Shopee Video.": "Shopee 视频的描述文字。",
  "Selected cover image url of the Shopee Video. Obtain from v2.video.get_cover_list.": "Shopee 视频选中的封面图片地址，可通过 v2.video.get_cover_list 接口获得。",
  "List of products to be linked with the Shopee Video, no more than 6.": "需要关联到 Shopee 视频的商品列表，最多 6 个。",
  "Shopee's unique identifier for an item.": "Shopee 商品的唯一标识 item_id。",
  "Product display name in Shopee Video.": "商品在 Shopee 视频中显示的名称。",
  "Whether allow stitch and duet.": "是否允许合拍和二创拼接。",
  "Whether allow duet.": "是否允许合拍。",
  "Whether allow stitch.": "是否允许二创拼接。",
  "When scheduled_post is true, scheduled_post_time must not empty.When scheduled_post is false, scheduled_post_time must empty.": "当 scheduled_post 为 true 时必须填写 scheduled_post_time；为 false 时 scheduled_post_time 必须留空。",
  "Whether post it to Shopee Video at scheduled time.": "是否在预定时间发布到 Shopee 视频。",
  "Scheduled post time, millisecond timestamp. When scheduled_post is true, scheduled_post_time must not empty.": "定时发布时间，使用毫秒级时间戳；scheduled_post 为 true 时必填。",
  "Partner ID is assigned upon registration is successful. Required for all requests.": "应用注册成功后分配的 Partner ID，所有请求必填。",
  "This is to indicate the timestamp of the request. Required for all requests. Expires in 5 minutes.": "请求发起时的秒级时间戳，所有请求必填，5 分钟后失效。",
  "The token for API access, using to identify your permission to the api. Valid for multiple use and expires in 4 hours.": "API 访问令牌，用于识别接口权限，可重复使用，通常 4 小时后过期。",
  "Shopee's unique identifier for a user.": "Shopee 用户的唯一标识 user_id。",
  "Signature generated by(depends on different APIs) partner_id, api path, timestamp, access_token, user_id and partner_key via HMAC-SHA256 hashing algorithm.": "使用 partner_id、接口路径、timestamp、access_token、user_id 和 partner_key 按 HMAC-SHA256 算法生成的签名；实际参与字段取决于接口类型。",
  "Name of the shop.": "店铺名称。",
  "Shop's area.": "店铺所属地区或站点。",
  "The identifier for an API request for error tracking.": "API 请求唯一标识，用于错误追踪。",
  "The timestamp when the shop was authorized to the partner.": "店铺授权给当前合作伙伴的时间戳。",
  "Use this field to indicate the expiration date for shop authorization.": "店铺授权的到期时间。",
};

const tabs: Array<{ id: DocsTab; label: string; icon: typeof BookOpen }> = [
  { id: "apis", label: "API Reference", icon: FileJson },
  { id: "guides", label: "开发指南", icon: BookOpen },
  { id: "push", label: "Push / WebHook", icon: Radio },
  { id: "calling", label: "调用规范", icon: TerminalSquare },
  { id: "terms", label: "使用与安全", icon: ShieldCheck },
];

const modules = computed(() => docs.value?.modules || []);
const selectedModule = computed(() => modules.value.find((item) => item.id === selectedModuleId.value) || modules.value[0]);
const allApis = computed(() => modules.value.flatMap((module) => module.items));
const matchedApis = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const source = keyword ? allApis.value : (selectedModule.value?.items || []);
  if (!keyword) return source;
  return source.filter((api) => [api.name, api.path, api.moduleName, stripHtml(api.descriptionHtml || "")]
    .some((value) => value.toLowerCase().includes(keyword)));
});
const selectedApi = computed(() => allApis.value.find((item) => item.name === selectedApiName.value) || matchedApis.value[0] || null);
const guideItems = computed(() => docs.value?.guideModules.flatMap((module) => module.items) || []);
const pushGroups = computed(() => {
  const map = new Map<string, PushDocument[]>();
  for (const item of docs.value?.pushDocuments || []) {
    if (!map.has(item.categoryName)) map.set(item.categoryName, []);
    map.get(item.categoryName)?.push(item);
  }
  return Array.from(map, ([name, items]) => ({ name, items }));
});
const selectedPush = computed(() => docs.value?.pushDocuments.find((item) => item.push_api?.push_api_id === selectedPushId.value) || docs.value?.pushDocuments[0] || null);
const pushParams = computed(() => {
  try { return JSON.parse(selectedPush.value?.push_api?.push_params || "[]") as DocParam[]; } catch { return []; }
});

function stripHtml(value: string) {
  if (!value) return "";
  const container = document.createElement("div");
  container.innerHTML = value;
  return (container.textContent || "").replace(/\s+/g, " ").trim();
}

function translateDescription(value: string, fieldName = "") {
  const source = stripHtml(value);
  if (!source) return "-";
  if (descriptionTranslations[source]) return descriptionTranslations[source];
  const uniqueId = source.match(/^Shopee(?:'s|’s) unique identifier for (?:an?|the) ([^.]+)\.?$/i);
  if (uniqueId) return `Shopee ${uniqueId[1]}的唯一标识。`;
  const list = source.match(/^List of (.+?)(?:, no more than (\d+))?\.?$/i);
  if (list) return `${list[1]}列表${list[2] ? `，最多 ${list[2]} 条` : ""}。`;
  const whether = source.match(/^Whether (.+?)\.?$/i);
  if (whether) return `是否${whether[1]}。`;
  const name = source.match(/^Name of (?:the )?(.+?)\.?$/i);
  if (name) return `${name[1]}的名称。`;
  const url = source.match(/^URL of (?:the )?(.+?)\.?$/i);
  if (url) return `${url[1]}的访问地址。`;
  const time = source.match(/^(?:The )?(?:time|timestamp) (?:of|when) (.+?)\.?$/i);
  if (time) return `${time[1]}的时间戳。`;
  const localized = source
    .replace(/Use this (?:field|filed) to indicate/gi, "用于表示")
    .replace(/This field indicates/gi, "该字段表示")
    .replace(/The applicable values are/gi, "可用值为")
    .replace(/Required for all requests/gi, "所有请求必填")
    .replace(/no more than/gi, "不超过")
    .replace(/true or false/gi, "true 或 false");
  if (/[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(localized)) {
    return fieldName
      ? `用于传递 ${fieldName} 对应的业务数据；具体限制请结合类型、示例，并将鼠标停留在此处查看官方原文。`
      : "用于执行当前接口对应的业务操作，具体限制请结合参数表和官方原文。";
  }
  return localized;
}

function flattenParams(params: DocParam[] = [], depth = 0): FlatParam[] {
  return params.flatMap((param) => [{ ...param, depth }, ...flattenParams(param.children || [], depth + 1)]);
}

function selectModule(id: number) {
  selectedModuleId.value = id;
  query.value = "";
  const first = modules.value.find((module) => module.id === id)?.items[0];
  selectedApiName.value = first?.name || "";
  if (first) emit("apiSelected", { method: first.method, path: first.path, name: first.name });
}

function selectApi(api: ApiDocument) {
  selectedModuleId.value = api.moduleId;
  selectedApiName.value = api.name;
  detailSection.value = "request";
  emit("apiSelected", { method: api.method, path: api.path, name: api.name });
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).then(() => ElMessage.success("已复制"));
}

function officialApiUrl(api: ApiDocument) {
  return `https://open.shopee.com/documents/v2/${encodeURIComponent(api.name)}?module=${api.moduleId}&type=1`;
}

function formatDate(timestamp: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

onMounted(async () => {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/shopee-official-docs.generated.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    docs.value = await response.json() as OfficialDocs;
    selectedModuleId.value = docs.value.modules[0]?.id || null;
    selectedApiName.value = docs.value.modules[0]?.items[0]?.name || "";
    selectedPushId.value = docs.value.pushDocuments[0]?.push_api?.push_api_id || null;
    const firstApi = docs.value.modules[0]?.items[0];
    if (firstApi) emit("apiSelected", { method: firstApi.method, path: firstApi.path, name: firstApi.name });
  } catch (error) {
    loadError.value = `文档数据加载失败：${String(error)}`;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="docs-shell" aria-labelledby="official-docs-title">
    <header class="docs-hero">
      <div>
        <span class="docs-kicker">SHOPEE OPEN PLATFORM · V2.0</span>
        <h2 id="official-docs-title">官方文档中心（中文版整理）</h2>
        <p>完整同步 Shopee 左侧目录、接口字段、错误码、权限、更新记录与 Push 事件；接口名和字段名保留官方原文，操作说明使用中文。</p>
      </div>
      <div v-if="docs" class="docs-stats" aria-label="文档统计">
        <span><b>{{ docs.stats.modules }}</b> 模块</span>
        <span><b>{{ docs.stats.apis }}</b> 接口</span>
        <span><b>{{ docs.stats.pushEvents }}</b> Push</span>
        <small>同步于 {{ formatDate(docs.fetchedAt) }}</small>
      </div>
    </header>

    <nav class="docs-tabs" aria-label="文档分类">
      <button v-for="tab in tabs" :key="tab.id" type="button" :class="{ active: activeTab === tab.id }" @click="activeTab = tab.id">
        <component :is="tab.icon" :size="16" />{{ tab.label }}
      </button>
      <a href="https://open.shopee.com/documents" target="_blank" rel="noopener noreferrer">打开官方文档<ArrowUpRight :size="15" /></a>
    </nav>

    <div v-if="loading" class="docs-state">正在加载完整官方文档…</div>
    <div v-else-if="loadError" class="docs-state docs-error" role="alert">{{ loadError }}</div>

    <div v-else-if="docs && activeTab === 'apis'" class="reference-layout">
      <div class="endpoint-column">
        <label class="module-picker">
          <span>接口分类</span>
          <select :value="selectedModuleId || undefined" @change="selectModule(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="module in modules" :key="module.id" :value="module.id">{{ module.name }}（{{ module.items.length }}）</option>
          </select>
        </label>
        <label class="docs-search">
          <Search :size="17" />
          <input v-model="query" type="search" placeholder="搜索 443 个接口：名称、路径、模块…" />
          <kbd>/</kbd>
        </label>
        <div class="endpoint-summary">
          <div><strong>{{ query ? '全局搜索' : selectedModule?.name }}</strong><span>{{ matchedApis.length }} 个接口</span></div>
          <small v-if="query">匹配所有模块</small>
        </div>
        <div class="endpoint-list">
          <button v-for="api in matchedApis" :key="api.id" type="button" :class="{ active: selectedApi?.name === api.name }" @click="selectApi(api)">
            <span :class="['method-badge', api.method.toLowerCase()]">{{ api.method }}</span>
            <span><b>{{ api.name.replace(/^v2\./, '') }}</b><small>{{ api.path }}</small></span>
          </button>
          <div v-if="!matchedApis.length" class="empty-list">没有匹配的接口</div>
        </div>
      </div>

      <article v-if="selectedApi" class="api-detail">
        <header class="api-heading">
          <div class="api-breadcrumb">API Reference / {{ selectedApi.moduleName }}</div>
          <div class="api-title-row">
            <div><span :class="['method-badge', selectedApi.method.toLowerCase()]">{{ selectedApi.method }}</span><h3>{{ selectedApi.name }}</h3></div>
            <div class="heading-actions">
              <button type="button" title="复制路径" @click="copyText(selectedApi.path)"><Copy :size="16" /></button>
              <a :href="officialApiUrl(selectedApi)" target="_blank" rel="noopener noreferrer" title="查看官方原文"><ArrowUpRight :size="16" /></a>
            </div>
          </div>
          <code>{{ selectedApi.path }}</code>
          <p>{{ translateDescription(selectedApi.descriptionHtml || '') || '官方未提供接口描述。' }}</p>
          <div class="api-meta">
            <span>模块 <b>{{ selectedApi.moduleName }}</b></span>
            <span>频率限制 <b>{{ selectedApi.rateLimit || '以应用权限为准' }}</b></span>
            <span>权限类型 <b>{{ selectedApi.permissions?.length || 0 }}</b></span>
          </div>
        </header>

        <nav class="detail-tabs" aria-label="接口详情">
          <button v-for="item in [
            ['request','请求参数'],['response','响应参数'],['examples','示例'],['errors','错误码'],['updates','更新记录']
          ]" :key="item[0]" type="button" :class="{ active: detailSection === item[0] }" @click="detailSection = item[0] as typeof detailSection">{{ item[1] }}</button>
        </nav>

        <div v-if="detailSection === 'request'" class="detail-body">
          <h4>业务请求参数 <span>{{ selectedApi.parameters?.request_params?.length || 0 }}</span></h4>
          <div class="param-table">
            <div class="param-head"><span>字段</span><span>类型</span><span>必填</span><span>示例</span><span>中文说明</span></div>
            <div v-for="(param, index) in flattenParams(selectedApi.parameters?.request_params)" :key="`${param.name}-${index}`" class="param-row">
              <code :style="{ paddingLeft: `${12 + param.depth * 18}px` }">{{ param.depth ? '↳ ' : '' }}{{ param.name }}</code><span>{{ param.type || '-' }}</span><span>{{ param.required ? '是' : '否' }}</span><span class="sample">{{ param.sample ?? '-' }}</span><p :title="stripHtml(param.description || '')">{{ translateDescription(param.description || '', param.name) }}</p>
            </div>
            <div v-if="!selectedApi.parameters?.request_params?.length" class="param-empty">该接口没有业务请求参数，只需公共参数。</div>
          </div>
          <details class="common-params"><summary>查看公共参数（{{ selectedApi.commonParameters?.length || 0 }}）</summary>
            <div class="param-table compact"><div v-for="(param, index) in selectedApi.commonParameters" :key="`${param.name}-${index}`" class="param-row"><code>{{ param.name }}</code><span>{{ param.type }}</span><span>是</span><span class="sample">{{ param.sample }}</span><p :title="stripHtml(param.description || '')">{{ translateDescription(param.description || '', param.name) }}</p></div></div>
          </details>
        </div>

        <div v-else-if="detailSection === 'response'" class="detail-body">
          <h4>响应字段 <span>{{ selectedApi.parameters?.response_params?.length || 0 }}</span></h4>
          <div class="param-table">
            <div class="param-head"><span>字段</span><span>类型</span><span>必填</span><span>示例</span><span>中文说明</span></div>
            <div v-for="(param, index) in flattenParams(selectedApi.parameters?.response_params)" :key="`${param.name}-${index}`" class="param-row"><code :style="{ paddingLeft: `${12 + param.depth * 18}px` }">{{ param.depth ? '↳ ' : '' }}{{ param.name }}</code><span>{{ param.type || '-' }}</span><span>-</span><span class="sample">{{ param.sample ?? '-' }}</span><p :title="stripHtml(param.description || '')">{{ translateDescription(param.description || '', param.name) }}</p></div>
          </div>
        </div>

        <div v-else-if="detailSection === 'examples'" class="detail-body example-grid">
          <div><h4>请求示例</h4><pre>{{ JSON.stringify(selectedApi.requestSample, null, 2) }}</pre></div>
          <div><h4>响应示例</h4><pre>{{ JSON.stringify(selectedApi.responseSample, null, 2) }}</pre></div>
        </div>

        <div v-else-if="detailSection === 'errors'" class="detail-body">
          <h4>接口错误码 <span>{{ selectedApi.errors?.length || 0 }}</span></h4>
          <div class="error-list"><div v-for="(error, index) in selectedApi.errors" :key="`${error.name}-${index}`"><code>{{ error.name }}</code><p>{{ error.description }}</p><small v-if="error.solution">处理：{{ error.solution }}</small></div></div>
          <details class="common-params"><summary>查看公共错误码（{{ selectedApi.commonErrors?.length || 0 }}）</summary><div class="error-list"><div v-for="(error, index) in selectedApi.commonErrors" :key="`${error.name}-${index}`"><code>{{ error.name }}</code><p>{{ error.description }}</p></div></div></details>
        </div>

        <div v-else class="detail-body">
          <h4>官方更新记录 <span>{{ selectedApi.updateLogs?.length || 0 }}</span></h4>
          <div class="update-list"><div v-for="log in selectedApi.updateLogs" :key="`${log.date}-${log.content}`"><time>{{ log.date }}</time><p>{{ log.content }}</p></div><p v-if="!selectedApi.updateLogs?.length">暂无更新记录。</p></div>
          <h4>可用应用权限</h4><div class="permission-list"><span v-for="permission in selectedApi.permissions" :key="permission"><Check :size="13" />{{ permission }}</span></div>
        </div>
      </article>

      <aside class="test-dock" aria-label="当前接口调用测试">
        <slot name="tester" :api="selectedApi" />
      </aside>
    </div>

    <div v-else-if="docs && activeTab === 'guides'" class="guide-page">
      <div class="section-intro"><span>DEVELOPER GUIDE</span><h3>开发者指南全目录</h3><p>官方共 {{ guideItems.length }} 个章节。下面按实际接入顺序给出中文重点，点击标题可前往官方章节。</p></div>
      <div class="guide-grid"><article v-for="(guide, index) in guideItems" :key="guide.id"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><h4>{{ guideNotes[guide.name]?.title || guide.name }}</h4><small>{{ guide.name }}</small><p>{{ guideNotes[guide.name]?.summary }}</p><ul><li v-for="point in guideNotes[guide.name]?.points" :key="point">{{ point }}</li></ul></div></article></div>
    </div>

    <div v-else-if="docs && activeTab === 'push'" class="push-layout">
      <aside class="push-sidebar"><div v-for="group in pushGroups" :key="group.name"><h4>{{ group.name }} <span>{{ group.items.length }}</span></h4><button v-for="item in group.items" :key="item.push_api?.push_api_id" type="button" :class="{ active: selectedPush?.push_api?.push_api_id === item.push_api?.push_api_id }" @click="selectedPushId = item.push_api?.push_api_id || null">{{ item.push_api?.push_api_name }}</button></div></aside>
      <article v-if="selectedPush?.push_api" class="push-detail"><span class="docs-kicker">PUSH CODE {{ selectedPush.push_api.push_code }}</span><h3>{{ selectedPush.push_api.push_api_name }}</h3><p>{{ translateDescription(selectedPush.push_api.description) }}</p><div class="push-meta"><span>分类 <b>{{ selectedPush.categoryName }}</b></span><span>超时 <b>{{ selectedPush.push_api.push_timeout }} 秒</b></span><span>重试 <b>{{ selectedPush.push_api.retry_strategy?.join(' / ') || '-' }} 秒</b></span></div><h4>推送字段</h4><div class="param-table"><div class="param-head"><span>字段</span><span>类型</span><span>必填</span><span>示例</span><span>中文说明</span></div><div v-for="(param, index) in flattenParams(pushParams)" :key="`${param.name}-${index}`" class="param-row"><code :style="{ paddingLeft: `${12 + param.depth * 18}px` }">{{ param.depth ? '↳ ' : '' }}{{ param.name }}</code><span>{{ param.type }}</span><span>-</span><span class="sample">{{ param.sample ?? '-' }}</span><p :title="stripHtml(param.description || '')">{{ translateDescription(param.description || '', param.name) }}</p></div></div></article>
    </div>

    <div v-else-if="activeTab === 'calling'" class="article-page">
      <div class="section-intro"><span>API CALL FLOW</span><h3>通过你们的中转 API 调用</h3><p>中转服务已代管 Shopee 的签名和 Token；当前网页只需要提供店铺、官方接口路径和业务参数。</p></div>
      <ol class="flow-list"><li><b>1</b><div><h4>验证 Key 的店铺范围</h4><code>GET /api/token/shops</code><p>请求头放入 X-Token-Key。返回当前 Key 可访问的 shop_id 清单。</p></div></li><li><b>2</b><div><h4>选择店铺与官方路径</h4><code>/api/v2/shop/get_shop_info</code><p>可以从 API Reference 点“带入请求区”，无需手抄路径。</p></div></li><li><b>3</b><div><h4>调用中转接口</h4><code>POST /api/shopee/call</code><p>提交 shop_id、api_path、method、params 和 body。批量店铺由网页控制并发。</p></div></li><li><b>4</b><div><h4>同时检查两层错误</h4><code>HTTP status + data.error</code><p>HTTP 200 不代表业务成功；保留 request_id 用于定位 Shopee 侧问题。</p></div></li></ol>
    </div>

    <div v-else class="article-page">
      <div class="section-intro"><span>TERMS & SECURITY</span><h3>使用条款与安全边界</h3><p>这里汇总实际操作必须遵守的边界；法律效力以 Shopee 官方 Terms of Use 和应用协议为准。</p></div>
      <div class="safety-grid"><article><ShieldCheck :size="20" /><h4>密钥不落盘</h4><p>API Key 仅保存在当前页面内存，不写入项目文件、浏览器存储或日志。</p></article><article><ShieldCheck :size="20" /><h4>默认只读</h4><p>查询类接口可直接执行；改价、改库存、发货、取消等写操作必须再次确认。</p></article><article><ShieldCheck :size="20" /><h4>最小权限</h4><p>只给应用和操作人员开通业务必需权限，定期复核授权店铺范围。</p></article><article><ShieldCheck :size="20" /><h4>数据合规</h4><p>订单、买家与物流信息属于敏感业务数据，不得无授权导出或转交。</p></article></div>
    </div>
  </section>
</template>

<style scoped>
.docs-shell { min-width: 0; overflow: hidden; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.docs-hero { display: flex; align-items: center; justify-content: space-between; gap: 32px; min-height: 148px; padding: 26px 28px; color: #f8fafc; background: linear-gradient(120deg, #172554 0%, #1e3a8a 56%, #1d4ed8 100%); }
.docs-kicker, .section-intro > span { color: #93c5fd; font-size: 11px; font-weight: 800; letter-spacing: .13em; }
.docs-hero h2 { margin: 8px 0 6px; font-size: 25px; letter-spacing: -.02em; }
.docs-hero p { max-width: 760px; margin: 0; color: #cbd5e1; font-size: 12px; line-height: 1.7; }
.docs-stats { display: grid; grid-template-columns: repeat(3, auto); gap: 8px; min-width: 260px; }
.docs-stats span { padding: 10px 12px; border: 1px solid rgb(255 255 255 / 16%); border-radius: 8px; background: rgb(15 23 42 / 28%); font-size: 11px; text-align: center; }
.docs-stats b { display: block; color: white; font-size: 20px; }
.docs-stats small { grid-column: 1 / -1; color: #bfdbfe; text-align: right; }
.docs-tabs { display: flex; align-items: center; gap: 2px; min-height: 50px; padding: 0 18px; border-bottom: 1px solid var(--ops-border-light); background: #fff; }
.docs-tabs button, .docs-tabs a { display: inline-flex; align-items: center; gap: 7px; min-height: 50px; padding: 0 13px; border: 0; border-bottom: 2px solid transparent; color: #64748b; background: transparent; font: inherit; font-size: 12px; font-weight: 650; text-decoration: none; cursor: pointer; }
.docs-tabs button:hover, .docs-tabs button.active { color: #1d4ed8; border-bottom-color: #2563eb; }
.docs-tabs a { margin-left: auto; color: #2563eb; }
.docs-state { display: grid; min-height: 360px; place-items: center; color: #64748b; }.docs-error { color: #b91c1c; }
.reference-layout { display: grid; grid-template-columns: 300px minmax(420px, 1fr) 350px; min-height: 760px; }
.module-sidebar, .endpoint-column { min-height: 0; border-right: 1px solid var(--ops-border-light); background: #f8fafc; }
.module-sidebar { max-height: 900px; overflow-y: auto; padding: 10px 8px 18px; }
.sidebar-title { display: flex; align-items: center; justify-content: space-between; padding: 9px 10px 12px; color: #334155; font-size: 12px; font-weight: 800; }.sidebar-title b { color: #94a3b8; }
.module-sidebar button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 34px; padding: 0 9px; border: 0; border-radius: 6px; color: #64748b; background: transparent; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
.module-sidebar button:hover { background: #eef2ff; }.module-sidebar button.active { color: #1d4ed8; background: #dbeafe; font-weight: 750; }.module-sidebar small { color: #94a3b8; font-variant-numeric: tabular-nums; }
.endpoint-column { display: flex; max-height: 900px; flex-direction: column; background: #fff; }
.module-picker { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 10px; padding: 12px 12px 0; color: #64748b; font-size: 10px; font-weight: 750; }
.module-picker select { min-width: 0; height: 34px; padding: 0 28px 0 9px; border: 1px solid #cbd5e1; border-radius: 6px; outline: 0; color: #1e293b; background: #fff; font: inherit; font-size: 11px; cursor: pointer; }
.module-picker select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px #dbeafe; }
.docs-search { display: flex; align-items: center; gap: 8px; margin: 12px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 7px; color: #94a3b8; background: #fff; }
.docs-search:focus-within { border-color: #2563eb; box-shadow: 0 0 0 3px #dbeafe; }.docs-search input { width: 100%; height: 38px; border: 0; outline: 0; color: #0f172a; font: inherit; font-size: 12px; }.docs-search kbd { padding: 1px 5px; border: 1px solid #dbe3ed; border-radius: 4px; background: #f8fafc; font-size: 10px; }
.endpoint-summary { display: flex; align-items: end; justify-content: space-between; padding: 2px 14px 10px; }.endpoint-summary div { display: grid; gap: 2px; }.endpoint-summary strong { color: #0f172a; font-size: 13px; }.endpoint-summary span, .endpoint-summary small { color: #94a3b8; font-size: 10px; }
.endpoint-list { overflow-y: auto; border-top: 1px solid #edf0f4; }.endpoint-list button { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 8px; width: 100%; padding: 10px 12px; border: 0; border-bottom: 1px solid #f1f5f9; background: #fff; text-align: left; cursor: pointer; }.endpoint-list button:hover { background: #f8fafc; }.endpoint-list button.active { background: #eff6ff; box-shadow: inset 3px 0 #2563eb; }.endpoint-list button > span:last-child { min-width: 0; display: grid; gap: 4px; }.endpoint-list b { overflow: hidden; color: #334155; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.endpoint-list small { overflow: hidden; color: #94a3b8; font-family: ui-monospace, monospace; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.empty-list { padding: 32px; color: #94a3b8; font-size: 12px; text-align: center; }
.method-badge { display: inline-grid; min-width: 38px; height: 21px; place-items: center; border-radius: 4px; font-size: 9px; font-weight: 850; letter-spacing: .03em; }.method-badge.get { color: #047857; background: #d1fae5; }.method-badge.post { color: #1d4ed8; background: #dbeafe; }
.api-detail { min-width: 0; max-height: 900px; overflow-y: auto; background: #fff; }.test-dock { min-width: 0; max-height: 900px; overflow-y: auto; border-left: 1px solid #dbe3ed; background: #f8fafc; }.api-heading { padding: 22px 24px 18px; }.api-breadcrumb { margin-bottom: 12px; color: #94a3b8; font-size: 10px; }.api-title-row, .api-title-row > div, .heading-actions { display: flex; align-items: center; gap: 9px; }.api-title-row { justify-content: space-between; }.api-title-row h3 { margin: 0; color: #0f172a; font-family: ui-monospace, monospace; font-size: 18px; overflow-wrap: anywhere; }.heading-actions button, .heading-actions a { display: inline-grid; width: 32px; height: 32px; place-items: center; border: 1px solid #dbe3ed; border-radius: 6px; color: #475569; background: #fff; cursor: pointer; }.heading-actions .use-api-button { width: auto; padding: 0 12px; border-color: #2563eb; color: #fff; background: #2563eb; font-size: 11px; font-weight: 750; }.api-heading > code { display: inline-block; margin: 12px 0; padding: 6px 9px; border-radius: 5px; color: #4338ca; background: #eef2ff; font-size: 11px; }.api-heading > p { margin: 0; color: #475569; font-size: 12px; line-height: 1.65; }.api-meta { display: flex; flex-wrap: wrap; gap: 15px; margin-top: 15px; color: #94a3b8; font-size: 10px; }.api-meta b { color: #475569; }
.detail-tabs { position: sticky; top: 0; z-index: 2; display: flex; padding: 0 24px; border-block: 1px solid #e8edf3; background: #fff; }.detail-tabs button { min-height: 42px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; color: #64748b; background: transparent; font: inherit; font-size: 11px; cursor: pointer; }.detail-tabs button.active { color: #2563eb; border-bottom-color: #2563eb; font-weight: 750; }
.detail-body { padding: 20px 24px 30px; }.detail-body h4, .push-detail h4 { margin: 0 0 11px; color: #334155; font-size: 13px; }.detail-body h4 span { color: #94a3b8; font-size: 10px; font-weight: 500; }
.param-table { overflow: hidden; border: 1px solid #e2e8f0; border-radius: 7px; }.param-head, .param-row { display: grid; grid-template-columns: minmax(120px, 1.2fr) 74px 44px minmax(80px, .8fr) minmax(180px, 2fr); align-items: start; }.param-head { color: #64748b; background: #f8fafc; font-size: 10px; font-weight: 750; }.param-head span { padding: 9px 8px; }.param-row { border-top: 1px solid #edf0f4; color: #64748b; font-size: 10px; line-height: 1.5; }.param-row > * { min-width: 0; margin: 0; padding: 9px 8px; overflow-wrap: anywhere; }.param-row code { color: #334155; font-size: 10px; }.param-row .sample { max-height: 72px; overflow: auto; color: #7c3aed; font-family: ui-monospace, monospace; }.param-empty { padding: 24px; color: #94a3b8; font-size: 11px; text-align: center; }.common-params { margin-top: 15px; }.common-params summary { color: #2563eb; font-size: 11px; font-weight: 700; cursor: pointer; }.common-params[open] summary { margin-bottom: 10px; }
.example-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.example-grid > div { min-width: 0; }.example-grid pre { min-height: 240px; max-height: 540px; margin: 0; overflow: auto; padding: 13px; border-radius: 7px; color: #dbeafe; background: #0f172a; font-size: 10px; line-height: 1.6; white-space: pre-wrap; }.error-list { display: grid; gap: 7px; }.error-list > div { padding: 10px 12px; border: 1px solid #fee2e2; border-radius: 6px; background: #fffafa; }.error-list code { color: #b91c1c; font-size: 10px; }.error-list p { margin: 4px 0 0; color: #475569; font-size: 10px; }.error-list small { color: #7f1d1d; }.update-list { display: grid; gap: 0; margin-bottom: 24px; border-left: 1px solid #cbd5e1; }.update-list > div { position: relative; display: grid; grid-template-columns: 86px 1fr; gap: 10px; padding: 0 0 13px 14px; }.update-list > div::before { position: absolute; top: 3px; left: -4px; width: 7px; height: 7px; border-radius: 50%; background: #2563eb; content: ""; }.update-list time { color: #64748b; font-size: 10px; }.update-list p { margin: 0; color: #334155; font-size: 10px; }.permission-list { display: flex; flex-wrap: wrap; gap: 6px; }.permission-list span { display: inline-flex; align-items: center; gap: 4px; padding: 5px 7px; border-radius: 5px; color: #166534; background: #dcfce7; font-size: 9px; }
.guide-page, .article-page { padding: 28px; background: #f8fafc; }.section-intro { max-width: 760px; margin-bottom: 22px; }.section-intro > span { color: #2563eb; }.section-intro h3 { margin: 7px 0; color: #0f172a; font-size: 22px; }.section-intro p { margin: 0; color: #64748b; font-size: 12px; line-height: 1.7; }.guide-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }.guide-grid article { display: grid; grid-template-columns: 38px 1fr; gap: 12px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; }.guide-grid article > span { color: #93c5fd; font-size: 21px; font-weight: 800; }.guide-grid h4 { margin: 0; color: #1e293b; font-size: 14px; }.guide-grid small { color: #94a3b8; font-size: 9px; }.guide-grid p, .guide-grid li { color: #64748b; font-size: 10px; line-height: 1.6; }.guide-grid p { margin: 8px 0 5px; }.guide-grid ul { margin: 0; padding-left: 17px; }
.push-layout { display: grid; grid-template-columns: 270px minmax(0, 1fr); min-height: 700px; }.push-sidebar { max-height: 840px; overflow-y: auto; padding: 16px 10px; border-right: 1px solid #e2e8f0; background: #f8fafc; }.push-sidebar h4 { display: flex; justify-content: space-between; margin: 12px 9px 5px; color: #334155; font-size: 11px; }.push-sidebar h4 span { color: #94a3b8; }.push-sidebar button { width: 100%; min-height: 31px; padding: 6px 9px; border: 0; border-radius: 5px; color: #64748b; background: transparent; font: inherit; font-family: ui-monospace, monospace; font-size: 9px; text-align: left; cursor: pointer; }.push-sidebar button:hover, .push-sidebar button.active { color: #1d4ed8; background: #dbeafe; }.push-detail { min-width: 0; max-height: 840px; overflow-y: auto; padding: 24px; }.push-detail .docs-kicker { color: #2563eb; }.push-detail h3 { margin: 7px 0; color: #0f172a; font-family: ui-monospace, monospace; font-size: 20px; }.push-detail > p { color: #64748b; font-size: 12px; }.push-meta { display: flex; gap: 18px; margin: 14px 0 22px; padding: 12px; border-radius: 7px; background: #eff6ff; color: #64748b; font-size: 10px; }.push-meta b { color: #1e40af; }
.flow-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }.flow-list li { display: grid; grid-template-columns: 40px 1fr; gap: 14px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; }.flow-list li > b { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 7px; color: #fff; background: #1d4ed8; }.flow-list h4 { margin: 0 0 6px; color: #1e293b; font-size: 13px; }.flow-list code { color: #4338ca; font-size: 11px; }.flow-list p { margin: 6px 0 0; color: #64748b; font-size: 11px; }.safety-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }.safety-grid article { padding: 18px; border: 1px solid #bfdbfe; border-radius: 8px; color: #1d4ed8; background: #fff; }.safety-grid h4 { margin: 10px 0 5px; color: #1e293b; }.safety-grid p { margin: 0; color: #64748b; font-size: 11px; line-height: 1.6; }
@media (max-width: 1250px) { .reference-layout { grid-template-columns: 270px minmax(390px, 1fr) 320px; }.param-head, .param-row { grid-template-columns: minmax(100px, 1.2fr) 62px 38px minmax(70px, .7fr) minmax(140px, 1.6fr); } }
@media (max-width: 980px) { .docs-hero { align-items: flex-start; flex-direction: column; }.reference-layout { grid-template-columns: minmax(260px, .75fr) minmax(420px, 1.25fr); }.test-dock { grid-column: 1 / -1; max-height: none; border-top: 1px solid #dbe3ed; border-left: 0; }.module-sidebar, .endpoint-column { max-height: 540px; }.push-layout { grid-template-columns: 220px 1fr; }.guide-grid { grid-template-columns: 1fr; } }
@media (max-width: 700px) { .docs-hero { padding: 20px; }.docs-stats { width: 100%; min-width: 0; }.docs-tabs { overflow-x: auto; }.docs-tabs button, .docs-tabs a { flex: 0 0 auto; }.reference-layout { display: block; }.endpoint-column { max-height: 520px; }.api-detail, .test-dock { max-height: none; }.api-title-row { align-items: flex-start; flex-direction: column; }.heading-actions { flex-wrap: wrap; }.param-table { overflow-x: auto; }.param-head, .param-row { min-width: 680px; }.example-grid, .safety-grid { grid-template-columns: 1fr; }.push-layout { display: block; }.push-sidebar { max-height: 300px; }.push-detail { max-height: none; }.guide-page, .article-page { padding: 20px; } }
</style>
