<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import {
  Braces,
  CheckCircle2,
  Clipboard,
  Download,
  KeyRound,
  Play,
  RefreshCw,
  ShieldCheck,
  Store,
  TriangleAlert,
  XCircle,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import ShopeeOfficialDocs from "@/components/shopee/ShopeeOfficialDocs.vue";
import {
  SHOPEE_SHOPS,
  SHOPEE_SHOP_STATUS_LABELS,
  type ShopeeShopRecord,
} from "@/data/shopee-shops";
import {
  ShopeeConsoleRequestError,
  callShopeeRelay,
  loadShopeeTokenShops,
  type ShopeeMethod,
  type ShopeeRelayRequest,
} from "@/services/shopee-console";

type ResultState = "pending" | "success" | "business_error" | "http_error";

interface ApiPreset {
  id: string;
  label: string;
  description: string;
  method: ShopeeMethod;
  path: string;
  params: () => Record<string, unknown>;
  body: () => Record<string, unknown>;
}

interface ConsoleResult {
  id: string;
  shop: ShopeeShopRecord;
  state: ResultState;
  durationMs: number | null;
  httpStatus: number | null;
  payload: unknown;
  message: string;
}

const DAY_SECONDS = 24 * 60 * 60;
const standaloneShopee = new URLSearchParams(window.location.search).get("standalone") === "shopee";
const keyScopedShops = ref<ShopeeShopRecord[]>([]);
const shopCatalog = computed(() => standaloneShopee ? keyScopedShops.value : SHOPEE_SHOPS);
const boundShops = computed(() => shopCatalog.value.filter((shop) => shop.status === "bound" && shop.shopId));
const unboundCount = computed(() => shopCatalog.value.filter((shop) => shop.status === "unbound").length);
const missingIdCount = computed(() => shopCatalog.value.filter((shop) => shop.status === "missing_id").length);

const presets: ApiPreset[] = [
  {
    id: "shop-info",
    label: "查询店铺信息",
    description: "验证授权并返回店铺名称、站点和状态。",
    method: "GET",
    path: "/api/v2/shop/get_shop_info",
    params: () => ({}),
    body: () => ({}),
  },
  {
    id: "item-list",
    label: "查询商品列表",
    description: "读取正常商品，每页最多 100 条。",
    method: "GET",
    path: "/api/v2/product/get_item_list",
    params: () => ({ offset: 0, page_size: 100, item_status: ["NORMAL"] }),
    body: () => ({}),
  },
  {
    id: "order-list",
    label: "查询最近订单",
    description: "按更新时间读取最近 24 小时订单。",
    method: "GET",
    path: "/api/v2/order/get_order_list",
    params: () => {
      const now = Math.floor(Date.now() / 1000);
      return {
        time_range_field: "update_time",
        time_from: now - DAY_SECONDS,
        time_to: now,
        page_size: 100,
        cursor: "",
      };
    },
    body: () => ({}),
  },
  {
    id: "order-detail",
    label: "查询订单详情",
    description: "请把示例订单号替换为真实 order_sn。",
    method: "GET",
    path: "/api/v2/order/get_order_detail",
    params: () => ({ order_sn_list: ["请替换为真实订单号"] }),
    body: () => ({}),
  },
  {
    id: "tracking-info",
    label: "查询物流轨迹",
    description: "请填写一个真实订单号。",
    method: "GET",
    path: "/api/v2/logistics/get_tracking_info",
    params: () => ({ order_sn: "请替换为真实订单号" }),
    body: () => ({}),
  },
  {
    id: "custom",
    label: "自定义接口",
    description: "按官方 API Reference 填写路径和业务参数。",
    method: "GET",
    path: "/api/v2/shop/get_shop_info",
    params: () => ({}),
    body: () => ({}),
  },
];

const apiKey = ref("");
const selectedShopIds = ref<string[]>(standaloneShopee ? [] : [boundShops.value[0]?.shopId || ""]);
const presetId = ref("shop-info");
const method = ref<ShopeeMethod>("GET");
const apiPath = ref("/api/v2/shop/get_shop_info");
const paramsText = ref("{}");
const bodyText = ref("{}");
const paramsError = ref("");
const bodyError = ref("");
const scopeChecking = ref(false);
const scopeChecked = ref(false);
const scopeResult = ref<unknown>(null);
const scopeShopIds = ref<Set<string>>(new Set());
const sending = ref(false);
const results = ref<ConsoleResult[]>([]);
const activeResultId = ref("");

const selectedPreset = computed(() => presets.find((preset) => preset.id === presetId.value) || presets[0]);
const selectedShops = computed(() => selectedShopIds.value
  .map((shopId) => boundShops.value.find((shop) => shop.shopId === shopId))
  .filter((shop): shop is ShopeeShopRecord => Boolean(shop)));
const scopeRestricts = computed(() => scopeShopIds.value.size > 0);
const selectableBoundShops = computed(() => scopeRestricts.value
  ? boundShops.value.filter((shop) => scopeShopIds.value.has(String(shop.shopId)))
  : boundShops.value);
const activeResult = computed(() => results.value.find((result) => result.id === activeResultId.value) || results.value[0] || null);
const completedCount = computed(() => results.value.filter((result) => result.state !== "pending").length);
const successCount = computed(() => results.value.filter((result) => result.state === "success").length);
const failedCount = computed(() => results.value.filter((result) => ["business_error", "http_error"].includes(result.state)).length);
const canSend = computed(() => (
  Boolean(apiKey.value.trim())
  && selectedShops.value.length > 0
  && apiPath.value.startsWith("/api/v2/")
  && !paramsError.value
  && !bodyError.value
  && !sending.value
));

const shopGroups = computed(() => {
  const grouped = new Map<string, ShopeeShopRecord[]>();
  for (const shop of shopCatalog.value) {
    if (!grouped.has(shop.country)) grouped.set(shop.country, []);
    grouped.get(shop.country)?.push(shop);
  }
  return Array.from(grouped, ([country, shops]) => ({ country, shops }));
});

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function useOfficialApi(payload: { method: ShopeeMethod; path: string; name: string }) {
  presetId.value = "custom";
  method.value = payload.method;
  apiPath.value = payload.path;
  paramsText.value = "{}";
  bodyText.value = "{}";
  paramsError.value = "";
  bodyError.value = "";
}

function applyPreset() {
  const preset = selectedPreset.value;
  method.value = preset.method;
  apiPath.value = preset.path;
  paramsText.value = prettyJson(preset.params());
  bodyText.value = prettyJson(preset.body());
  paramsError.value = "";
  bodyError.value = "";
}

function parseEditorJson(text: string, field: "params" | "body") {
  try {
    const value = JSON.parse(text || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("必须是 JSON 对象");
    if (field === "params") paramsError.value = "";
    else bodyError.value = "";
    return value as Record<string, unknown>;
  } catch (error) {
    const message = `JSON 格式错误：${String((error as Error)?.message || error)}`;
    if (field === "params") paramsError.value = message;
    else bodyError.value = message;
    return null;
  }
}

function formatEditor(field: "params" | "body") {
  const current = field === "params" ? paramsText.value : bodyText.value;
  const parsed = parseEditorJson(current, field);
  if (!parsed) return;
  if (field === "params") paramsText.value = prettyJson(parsed);
  else bodyText.value = prettyJson(parsed);
}

function shopDisabled(shop: ShopeeShopRecord) {
  if (shop.status !== "bound" || !shop.shopId) return true;
  return scopeRestricts.value && !scopeShopIds.value.has(shop.shopId);
}

function shopOptionLabel(shop: ShopeeShopRecord) {
  const id = shop.shopId ? ` / ${shop.shopId}` : "";
  return `${shop.code} / ${shop.name}${id}`;
}

function selectAllAvailable() {
  selectedShopIds.value = selectableBoundShops.value.map((shop) => String(shop.shopId));
}

function collectShopRecords(value: unknown) {
  const records = new Map<string, ShopeeShopRecord>();
  function visit(current: unknown, depth = 0) {
    if (depth > 8 || current == null) return;
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof current !== "object") return;
    const item = current as Record<string, unknown>;
    const shopId = item.shop_id ?? item.shopId;
    if (["string", "number"].includes(typeof shopId)) {
      const id = String(shopId);
      const code = String(item.shop_code ?? item.shopCode ?? item.store_code ?? item.code ?? id);
      const name = String(item.shop_name ?? item.shopName ?? item.store_name ?? item.name ?? "当前 Key 授权店铺");
      const country = String(item.region ?? item.country ?? item.market ?? "已授权店铺");
      records.set(id, { code, name, country, shopId: id, status: "bound" });
    }
    Object.values(item).forEach((child) => visit(child, depth + 1));
  }
  visit(value);
  return Array.from(records.values());
}

function collectShopIds(value: unknown, output = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectShopIds(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["shop_id", "shopId"].includes(key) && ["string", "number"].includes(typeof item)) {
      output.add(String(item));
    } else {
      collectShopIds(item, output, depth + 1);
    }
  }
  return output;
}

async function checkScope() {
  if (!apiKey.value.trim()) return ElMessage.warning("请先填写 API Key");
  scopeChecking.value = true;
  try {
    scopeResult.value = await loadShopeeTokenShops(apiKey.value.trim());
    scopeShopIds.value = collectShopIds(scopeResult.value);
    if (standaloneShopee) keyScopedShops.value = collectShopRecords(scopeResult.value);
    scopeChecked.value = true;
    if (scopeShopIds.value.size) {
      selectedShopIds.value = selectedShopIds.value.filter((id) => scopeShopIds.value.has(id));
      ElMessage.success(`Key 验证通过，可识别 ${scopeShopIds.value.size} 个 shop_id`);
    } else {
      ElMessage.success("Key 验证通过，已取得店铺范围响应");
    }
  } catch (error) {
    scopeChecked.value = false;
    scopeShopIds.value = new Set();
    scopeResult.value = error instanceof ShopeeConsoleRequestError ? error.payload : { error: String(error) };
    ElMessage.error(String((error as Error)?.message || error));
  } finally {
    scopeChecking.value = false;
  }
}

function businessError(payload: Record<string, unknown>) {
  const data = payload.data;
  if (!data || typeof data !== "object") return "";
  const error = (data as Record<string, unknown>).error;
  return typeof error === "string" ? error : error ? prettyJson(error) : "";
}

function resultMessage(payload: Record<string, unknown>, fallback: string) {
  const data = payload.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.error === "string" && record.error) return record.error;
  }
  if (typeof payload.message === "string" && payload.message) return payload.message;
  if (typeof payload.error === "string" && payload.error) return payload.error;
  return fallback;
}

async function executeOne(result: ConsoleResult, params: Record<string, unknown>, body: Record<string, unknown>) {
  const startedAt = performance.now();
  const payload: ShopeeRelayRequest = {
    shop_id: String(result.shop.shopId),
    api_path: apiPath.value.trim(),
    method: method.value,
    params,
    ...(method.value === "POST" ? { body } : {}),
  };
  try {
    const response = await callShopeeRelay(apiKey.value.trim(), payload);
    const error = businessError(response);
    result.payload = response;
    result.durationMs = Math.round(performance.now() - startedAt);
    if (response.ok === false || error) {
      result.state = "business_error";
      result.message = resultMessage(response, "Shopee 返回业务错误");
    } else {
      result.state = "success";
      result.message = "调用成功";
    }
  } catch (error) {
    result.durationMs = Math.round(performance.now() - startedAt);
    result.state = "http_error";
    result.message = String((error as Error)?.message || error);
    if (error instanceof ShopeeConsoleRequestError) {
      result.httpStatus = error.status;
      result.payload = error.payload;
    } else {
      result.payload = { error: result.message };
    }
  }
}

async function runRequests() {
  const params = parseEditorJson(paramsText.value, "params");
  const body = parseEditorJson(bodyText.value, "body");
  if (!params || !body || !canSend.value) {
    if (!apiPath.value.startsWith("/api/v2/")) ElMessage.error("API Path 必须以 /api/v2/ 开头");
    return;
  }
  if (method.value === "POST") {
    await ElMessageBox.confirm(
      `即将对 ${selectedShops.value.length} 家店执行 POST 写请求。请确认接口路径和 body 已按官方文档填写。`,
      "确认写操作",
      { type: "warning", confirmButtonText: "确认发送", cancelButtonText: "返回检查" },
    );
  }

  sending.value = true;
  const batchId = Date.now();
  results.value = selectedShops.value.map((shop, index) => ({
    id: `${batchId}-${index}-${shop.shopId}`,
    shop,
    state: "pending",
    durationMs: null,
    httpStatus: null,
    payload: null,
    message: "等待请求",
  }));
  activeResultId.value = results.value[0]?.id || "";
  await nextTick();

  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, results.value.length) }, async () => {
    while (cursor < results.value.length) {
      const index = cursor;
      cursor += 1;
      await executeOne(results.value[index], params, body);
    }
  });
  await Promise.all(workers);
  sending.value = false;
  const firstFailure = results.value.find((result) => result.state !== "success");
  if (firstFailure) activeResultId.value = firstFailure.id;
  ElMessage[failedCount.value ? "warning" : "success"](
    `已完成 ${results.value.length} 家店：成功 ${successCount.value}，失败 ${failedCount.value}`,
  );
}

function resultStateLabel(state: ResultState) {
  return {
    pending: "请求中",
    success: "成功",
    business_error: "业务失败",
    http_error: "连接失败",
  }[state];
}

async function copyActiveResult() {
  if (!activeResult.value) return;
  await navigator.clipboard.writeText(prettyJson(activeResult.value.payload));
  ElMessage.success("响应 JSON 已复制");
}

function downloadResults() {
  if (!results.value.length) return;
  const payload = results.value.map((result) => ({
    店编: result.shop.code,
    店铺名称: result.shop.name,
    shop_id: result.shop.shopId,
    状态: resultStateLabel(result.state),
    耗时ms: result.durationMs,
    响应: result.payload,
  }));
  const blob = new Blob([prettyJson(payload)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `shopee-api-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="shopee-console-page">
    <section class="console-metrics" aria-label="店铺授权概况">
      <div><span>{{ standaloneShopee ? '当前 Key 店铺' : 'Excel 店铺' }}</span><strong>{{ shopCatalog.length }}</strong><small>{{ standaloneShopee ? '验证后自动载入' : '本地 Excel 店铺清单' }}</small></div>
      <div class="metric-success"><span>可调用</span><strong>{{ boundShops.length }}</strong><small>{{ standaloneShopee ? '以 Key 返回范围为准' : '已验证 get_shop_info' }}</small></div>
      <div class="metric-warning"><span>待授权</span><strong>{{ unboundCount }}</strong><small>已有 shop_id</small></div>
      <div class="metric-danger"><span>缺少 ID</span><strong>{{ missingIdCount }}</strong><small>需先完成授权回调</small></div>
    </section>

    <section class="security-notice" aria-label="安全说明">
      <ShieldCheck :size="20" />
      <div>
        <strong>同源安全代理已启用</strong>
        <span>API Key 只在当前页面内存中使用，不写入文件、日志、localStorage 或 sessionStorage。</span>
      </div>
    </section>

    <div v-if="false" class="console-workbench">
      <section class="console-panel request-panel">
        <header class="console-panel-header">
          <div>
            <span class="panel-kicker">REQUEST BUILDER</span>
            <h2>请求配置</h2>
          </div>
          <span class="read-only-chip">默认只读</span>
        </header>

        <div class="console-form">
          <div class="form-section">
            <div class="section-title">
              <KeyRound :size="17" />
              <div><strong>访问密钥</strong><small>不会保存，刷新页面后自动清空</small></div>
            </div>
            <label class="field-label" for="shopee-api-key">X-Token-Key</label>
            <div class="credential-row">
              <el-input
                id="shopee-api-key"
                v-model="apiKey"
                type="password"
                show-password
                autocomplete="off"
                placeholder="粘贴当前有效的 API Key"
                @keyup.enter="checkScope"
              />
              <el-button :loading="scopeChecking" :disabled="!apiKey.trim()" @click="checkScope">
                <RefreshCw :size="16" />
                验证范围
              </el-button>
            </div>
            <div v-if="scopeChecked" class="scope-status" role="status">
              <CheckCircle2 :size="16" />
              <span v-if="scopeShopIds.size">已识别 {{ scopeShopIds.size }} 个 shop_id，选择器已按当前 Key 过滤。</span>
              <span v-else>Key 已验证，并取得店铺范围响应。</span>
              <details v-if="scopeResult">
                <summary>查看原始响应</summary>
                <pre>{{ prettyJson(scopeResult) }}</pre>
              </details>
            </div>
          </div>

          <div class="form-section">
            <div class="section-title">
              <Store :size="17" />
              <div><strong>目标店铺</strong><small>支持单店和多店批量请求，并发数固定为 3</small></div>
            </div>
            <label class="field-label" for="target-shops">店铺</label>
            <el-select
              id="target-shops"
              v-model="selectedShopIds"
              multiple
              filterable
              collapse-tags
              :max-collapse-tags="3"
              placeholder="按店编、店名或 shop_id 搜索"
              class="full-width"
            >
              <el-option-group v-for="group in shopGroups" :key="group.country" :label="group.country">
                <el-option
                  v-for="shop in group.shops"
                  :key="shop.code"
                  :label="shopOptionLabel(shop)"
                  :value="shop.shopId || shop.code"
                  :disabled="shopDisabled(shop)"
                >
                  <div class="shop-option">
                    <span><b>{{ shop.code }}</b>{{ shop.name }}</span>
                    <small :class="`status-${shop.status}`">{{ SHOPEE_SHOP_STATUS_LABELS[shop.status] }}</small>
                  </div>
                </el-option>
              </el-option-group>
            </el-select>
            <div class="selection-actions">
              <span>已选 {{ selectedShops.length }} 家</span>
              <button type="button" @click="selectAllAvailable">选择全部可用</button>
              <button type="button" @click="selectedShopIds = []">清空</button>
            </div>
          </div>

          <div class="form-section">
            <div class="section-title">
              <Braces :size="17" />
              <div><strong>接口与参数</strong><small>{{ selectedPreset.description }}</small></div>
            </div>
            <div class="two-column-fields">
              <div>
                <label class="field-label" for="api-preset">接口模板</label>
                <el-select id="api-preset" v-model="presetId" class="full-width" @change="applyPreset">
                  <el-option v-for="preset in presets" :key="preset.id" :label="preset.label" :value="preset.id" />
                </el-select>
              </div>
              <div>
                <span class="field-label">Method</span>
                <el-segmented v-model="method" :options="['GET', 'POST']" class="method-segmented" />
              </div>
            </div>
            <label class="field-label" for="api-path">API Path</label>
            <el-input id="api-path" v-model="apiPath" placeholder="/api/v2/shop/get_shop_info" />
            <p v-if="!apiPath.startsWith('/api/v2/')" class="field-error" role="alert">必须以 /api/v2/ 开头</p>

            <div class="json-editor-grid" :class="{ 'single-editor': method === 'GET' }">
              <div class="json-editor">
                <div class="editor-label"><label for="params-json">params JSON</label><button type="button" @click="formatEditor('params')">格式化</button></div>
                <textarea id="params-json" v-model="paramsText" spellcheck="false" @blur="parseEditorJson(paramsText, 'params')" />
                <p v-if="paramsError" class="field-error" role="alert">{{ paramsError }}</p>
              </div>
              <div v-if="method === 'POST'" class="json-editor">
                <div class="editor-label"><label for="body-json">body JSON</label><button type="button" @click="formatEditor('body')">格式化</button></div>
                <textarea id="body-json" v-model="bodyText" spellcheck="false" @blur="parseEditorJson(bodyText, 'body')" />
                <p v-if="bodyError" class="field-error" role="alert">{{ bodyError }}</p>
              </div>
            </div>
          </div>
        </div>

        <footer class="request-actions">
          <div>
            <strong>{{ sending ? `${completedCount} / ${results.length}` : `${selectedShops.length} 家店` }}</strong>
            <span>{{ method === 'POST' ? '写操作会再次确认' : '读取操作' }}</span>
          </div>
          <el-button type="primary" size="large" :disabled="!canSend" :loading="sending" @click="runRequests">
            <Play :size="17" />
            {{ sending ? '正在请求' : '发送请求' }}
          </el-button>
        </footer>
      </section>

      <section class="console-panel response-panel">
        <header class="console-panel-header">
          <div>
            <span class="panel-kicker">RESPONSE INSPECTOR</span>
            <h2>响应结果</h2>
          </div>
          <div class="response-actions">
            <el-button text :disabled="!activeResult" aria-label="复制当前响应" @click="copyActiveResult"><Clipboard :size="17" /></el-button>
            <el-button text :disabled="!results.length" aria-label="下载全部结果" @click="downloadResults"><Download :size="17" /></el-button>
          </div>
        </header>

        <div v-if="!results.length" class="response-empty">
          <div class="empty-icon"><Braces :size="28" /></div>
          <h3>等待第一次请求</h3>
          <p>填写 Key、选择店铺和接口后，响应会按店铺分组显示在这里。</p>
          <ul>
            <li>外层检查 HTTP 状态和 ok</li>
            <li>内层继续检查 data.error</li>
            <li>失败时保留 request_id 便于追踪</li>
          </ul>
        </div>

        <template v-else>
          <div class="result-summary" aria-live="polite">
            <span><b>{{ results.length }}</b> 总数</span>
            <span class="summary-success"><b>{{ successCount }}</b> 成功</span>
            <span class="summary-danger"><b>{{ failedCount }}</b> 失败</span>
            <span v-if="sending"><b>{{ results.length - completedCount }}</b> 进行中</span>
          </div>

          <div class="response-workspace">
            <div class="result-list" aria-label="各店铺调用结果">
              <button
                v-for="result in results"
                :key="result.id"
                type="button"
                :class="['result-row', { active: activeResult?.id === result.id }]"
                @click="activeResultId = result.id"
              >
                <span :class="['result-state', `state-${result.state}`]">
                  <RefreshCw v-if="result.state === 'pending'" :size="15" class="spin" />
                  <CheckCircle2 v-else-if="result.state === 'success'" :size="15" />
                  <XCircle v-else :size="15" />
                </span>
                <span class="result-shop"><b>{{ result.shop.code }}</b><small>{{ result.shop.name }}</small></span>
                <span class="result-meta"><b>{{ resultStateLabel(result.state) }}</b><small>{{ result.durationMs == null ? '' : `${result.durationMs}ms` }}</small></span>
              </button>
            </div>

            <div v-if="activeResult" class="response-detail">
              <div class="detail-heading">
                <div>
                  <strong>{{ activeResult.shop.code }} / {{ activeResult.shop.name }}</strong>
                  <span>shop_id {{ activeResult.shop.shopId }}</span>
                </div>
                <span :class="['detail-status', `state-${activeResult.state}`]">{{ resultStateLabel(activeResult.state) }}</span>
              </div>
              <div v-if="activeResult.state !== 'success' && activeResult.state !== 'pending'" class="error-banner" role="alert">
                <TriangleAlert :size="17" />
                <span>{{ activeResult.message }}</span>
              </div>
              <pre class="json-response">{{ activeResult.payload == null ? '等待响应…' : prettyJson(activeResult.payload) }}</pre>
            </div>
          </div>
        </template>
      </section>
    </div>

    <ShopeeOfficialDocs @api-selected="useOfficialApi">
      <template #tester="{ api }">
        <div class="inline-tester">
          <header class="tester-header">
            <span class="panel-kicker">接口调用测试</span>
            <h3>查看说明的同时测试</h3>
            <p>切换左侧接口后，这里会自动同步请求方式和路径。</p>
          </header>

          <div class="method-explainer" :class="method.toLowerCase()">
            <strong>{{ method }}</strong>
            <div v-if="method === 'GET'">
              <b>GET＝读取/查询</b>
              <span>通常只获取数据，不修改店铺内容；业务参数填写在 params。</span>
            </div>
            <div v-else>
              <b>POST＝提交/修改</b>
              <span>用于新增、编辑、删除或执行动作；业务数据通常填写在 body，发送前会再次确认。</span>
            </div>
          </div>

          <div class="tester-form">
            <label class="field-label" for="inline-api-key">X-Token-Key</label>
            <div class="inline-key-row">
              <el-input id="inline-api-key" v-model="apiKey" type="password" show-password autocomplete="off" placeholder="粘贴当前有效的 API Key" />
              <el-button :loading="scopeChecking" :disabled="!apiKey.trim()" @click="checkScope">验证</el-button>
            </div>
            <p class="helper-text">只在当前页面内存使用，刷新后清空。</p>

            <label class="field-label" for="inline-shops">调用店铺</label>
            <el-select id="inline-shops" v-model="selectedShopIds" multiple filterable collapse-tags :max-collapse-tags="2" placeholder="选择店铺" class="full-width">
              <el-option-group v-for="group in shopGroups" :key="group.country" :label="group.country">
                <el-option v-for="shop in group.shops" :key="shop.code" :label="shopOptionLabel(shop)" :value="shop.shopId || shop.code" :disabled="shopDisabled(shop)" />
              </el-option-group>
            </el-select>
            <div class="selection-actions"><span>已选 {{ selectedShops.length }} 家</span><button type="button" @click="selectAllAvailable">全选可用</button><button type="button" @click="selectedShopIds = []">清空</button></div>

            <label class="field-label">当前接口</label>
            <div class="tester-path"><span :class="['tester-method', method.toLowerCase()]">{{ method }}</span><code>{{ api?.path || apiPath }}</code></div>

            <div class="json-editor compact-editor">
              <div class="editor-label"><label for="inline-params">查询参数 params</label><button type="button" @click="formatEditor('params')">格式化</button></div>
              <textarea id="inline-params" v-model="paramsText" spellcheck="false" @blur="parseEditorJson(paramsText, 'params')" />
              <p v-if="paramsError" class="field-error">{{ paramsError }}</p>
            </div>

            <div v-if="method === 'POST'" class="json-editor compact-editor">
              <div class="editor-label"><label for="inline-body">提交数据 body</label><button type="button" @click="formatEditor('body')">格式化</button></div>
              <textarea id="inline-body" v-model="bodyText" spellcheck="false" @blur="parseEditorJson(bodyText, 'body')" />
              <p v-if="bodyError" class="field-error">{{ bodyError }}</p>
            </div>

            <el-button type="primary" class="tester-send" :disabled="!canSend" :loading="sending" @click="runRequests">
              <Play :size="16" />{{ sending ? `${completedCount}/${results.length} 请求中` : `调用 ${selectedShops.length} 家店` }}
            </el-button>
          </div>

          <div class="tester-result">
            <div class="tester-result-title"><strong>响应结果</strong><span v-if="results.length">成功 {{ successCount }} · 失败 {{ failedCount }}</span></div>
            <div v-if="!results.length" class="tester-empty">选择店铺、填写 Key 和参数后即可测试当前接口。</div>
            <template v-else>
              <div class="tester-result-tabs">
                <button v-for="result in results" :key="result.id" type="button" :class="{ active: activeResult?.id === result.id }" @click="activeResultId = result.id">{{ result.shop.code }}<span :class="`state-${result.state}`">{{ resultStateLabel(result.state) }}</span></button>
              </div>
              <pre v-if="activeResult">{{ activeResult.payload == null ? '等待响应…' : prettyJson(activeResult.payload) }}</pre>
            </template>
          </div>

          <details class="method-glossary">
            <summary>字段类型是什么意思？</summary>
            <dl><div><dt>string</dt><dd>文本，例如订单号、名称</dd></div><div><dt>int / int64</dt><dd>整数，例如 shop_id、item_id</dd></div><div><dt>boolean</dt><dd>布尔值，只能是 true 或 false</dd></div><div><dt>object</dt><dd>JSON 对象，用大括号表示</dd></div><div><dt>object[]</dt><dd>对象数组，用中括号表示，可包含多条记录</dd></div><div><dt>timestamp</dt><dd>Unix 时间戳，通常精确到秒</dd></div></dl>
          </details>
        </div>
      </template>
    </ShopeeOfficialDocs>
  </div>
</template>

<style scoped>
.shopee-console-page { display: grid; gap: 16px; }
.console-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.console-metrics > div { min-height: 104px; display: grid; grid-template-columns: 1fr auto; align-content: start; gap: 6px 12px; padding: 15px 16px; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.console-metrics span { color: var(--ops-text-secondary); font-size: 12px; font-weight: 650; }
.console-metrics strong { grid-row: 1 / 3; grid-column: 2; align-self: center; font-size: 31px; line-height: 1; font-variant-numeric: tabular-nums; }
.console-metrics small { color: var(--ops-text-muted); font-size: 11px; }
.console-metrics .metric-success strong { color: var(--ops-success); }
.console-metrics .metric-warning strong { color: var(--ops-warning); }
.console-metrics .metric-danger strong { color: var(--ops-danger); }
.security-notice { min-height: 54px; display: flex; align-items: center; gap: 11px; padding: 10px 14px; border: 1px solid #bfdbfe; border-radius: var(--ops-radius-md); color: #1e40af; background: #eff6ff; }
.security-notice > div { display: grid; gap: 2px; }
.security-notice strong { font-size: 12px; }
.security-notice span { font-size: 11px; line-height: 1.5; }
.console-workbench { display: grid; grid-template-columns: minmax(470px, .88fr) minmax(520px, 1.12fr); gap: 14px; align-items: start; }
.console-panel { min-width: 0; overflow: hidden; border: 1px solid var(--ops-border-light); border-radius: var(--ops-radius-md); background: var(--ops-surface); box-shadow: var(--ops-shadow-sm); }
.console-panel-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 16px; border-bottom: 1px solid var(--ops-border-light); }
.console-panel-header h2 { margin: 3px 0 0; font-size: 16px; }
.read-only-chip { display: inline-flex; align-items: center; min-height: 28px; padding: 0 9px; border: 1px solid #bfdbfe; border-radius: 8px; color: #1d4ed8; background: #eff6ff; font-size: 11px; font-weight: 700; }
.console-form { display: grid; }
.form-section { display: grid; gap: 9px; padding: 16px; border-bottom: 1px solid var(--ops-border-light); }
.section-title { display: flex; align-items: center; gap: 9px; margin-bottom: 3px; color: var(--ops-primary); }
.section-title > div { display: grid; gap: 2px; }
.section-title strong { color: var(--ops-text); font-size: 13px; }
.section-title small { color: var(--ops-text-muted); font-size: 11px; font-weight: 400; line-height: 1.4; }
.field-label { display: block; color: var(--ops-text-secondary); font-size: 11px; font-weight: 700; }
.credential-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.credential-row .el-button { min-height: 40px; }
.full-width { width: 100%; }
.scope-status { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 7px; padding: 9px 10px; border-radius: 8px; color: #166534; background: #f0fdf4; font-size: 11px; }
.scope-status details { width: 100%; }
.scope-status summary { cursor: pointer; font-weight: 650; }
.scope-status pre { max-height: 180px; overflow: auto; margin: 8px 0 0; padding: 10px; border-radius: 8px; color: #dbeafe; background: #172033; font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
.shop-option { width: 100%; display: flex; justify-content: space-between; gap: 12px; }
.shop-option span { display: flex; gap: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shop-option small { flex: 0 0 auto; font-size: 10px; font-weight: 700; }
.status-bound { color: var(--ops-success); }
.status-unbound { color: var(--ops-warning); }
.status-missing_id { color: var(--ops-danger); }
.selection-actions { display: flex; align-items: center; gap: 12px; color: var(--ops-text-muted); font-size: 11px; }
.selection-actions button, .editor-label button { min-height: 30px; padding: 0; border: 0; color: var(--ops-primary); background: transparent; cursor: pointer; font-size: 11px; font-weight: 700; }
.selection-actions button:hover, .editor-label button:hover { color: var(--ops-primary-strong); text-decoration: underline; }
.two-column-fields { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(150px, .65fr); gap: 10px; }
.two-column-fields > div { display: grid; gap: 7px; }
.method-segmented { width: 100%; }
.json-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 2px; }
.json-editor-grid.single-editor { grid-template-columns: 1fr; }
.json-editor { min-width: 0; }
.editor-label { min-height: 31px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.editor-label label { color: var(--ops-text-secondary); font-size: 11px; font-weight: 700; }
.json-editor textarea { width: 100%; min-height: 172px; resize: vertical; padding: 11px 12px; border: 1px solid var(--ops-border); border-radius: 9px; outline: none; color: #dbeafe; background: #172033; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; transition: border-color var(--ops-transition), box-shadow var(--ops-transition); }
.json-editor textarea:focus { border-color: var(--ops-primary); box-shadow: 0 0 0 3px rgba(37,99,235,.14); }
.field-error { margin: -2px 0 0; color: var(--ops-danger); font-size: 11px; line-height: 1.45; }
.request-actions { min-height: 70px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; background: var(--ops-surface-muted); }
.request-actions > div { display: grid; gap: 2px; }
.request-actions strong { font-size: 13px; }
.request-actions span { color: var(--ops-text-muted); font-size: 11px; }
.request-actions .el-button { min-width: 138px; }
.response-actions { display: flex; }
.response-actions .el-button { width: 40px; min-height: 40px; margin: 0; }
.response-empty { min-height: 642px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 36px; text-align: center; }
.empty-icon { display: grid; place-items: center; width: 60px; height: 60px; border-radius: 16px; color: var(--ops-primary); background: #eff6ff; }
.response-empty h3 { margin: 17px 0 6px; font-size: 17px; }
.response-empty p { max-width: 390px; margin: 0; color: var(--ops-text-secondary); font-size: 12px; line-height: 1.6; }
.response-empty ul { display: grid; gap: 6px; margin: 20px 0 0; padding: 0; color: var(--ops-text-muted); font-size: 11px; text-align: left; list-style-position: inside; }
.result-summary { min-height: 54px; display: flex; align-items: center; gap: 20px; padding: 10px 16px; border-bottom: 1px solid var(--ops-border-light); color: var(--ops-text-secondary); font-size: 11px; }
.result-summary span { display: inline-flex; align-items: baseline; gap: 5px; }
.result-summary b { color: var(--ops-text); font-size: 17px; font-variant-numeric: tabular-nums; }
.result-summary .summary-success b { color: var(--ops-success); }
.result-summary .summary-danger b { color: var(--ops-danger); }
.response-workspace { min-height: 588px; display: grid; grid-template-columns: minmax(205px, .7fr) minmax(0, 1.3fr); }
.result-list { max-height: 650px; overflow: auto; border-right: 1px solid var(--ops-border-light); }
.result-row { width: 100%; min-height: 64px; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 7px; padding: 10px 11px; border: 0; border-bottom: 1px solid var(--ops-border-light); color: var(--ops-text); background: transparent; cursor: pointer; text-align: left; transition: background var(--ops-transition); }
.result-row:hover { background: var(--ops-surface-muted); }
.result-row.active { background: #eff6ff; box-shadow: inset 3px 0 var(--ops-primary); }
.result-state { display: grid; place-items: center; }
.state-pending { color: var(--ops-primary); }
.state-success { color: var(--ops-success); }
.state-business_error, .state-http_error { color: var(--ops-danger); }
.result-shop, .result-meta { display: grid; gap: 3px; min-width: 0; }
.result-shop b, .result-meta b { font-size: 11px; }
.result-shop small { overflow: hidden; color: var(--ops-text-secondary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.result-meta { justify-items: end; }
.result-meta small { color: var(--ops-text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.response-detail { min-width: 0; display: flex; flex-direction: column; }
.detail-heading { min-height: 62px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; border-bottom: 1px solid var(--ops-border-light); }
.detail-heading > div { display: grid; gap: 3px; min-width: 0; }
.detail-heading strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.detail-heading span { color: var(--ops-text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.detail-status { flex: 0 0 auto; font-size: 11px; font-weight: 750; }
.error-banner { display: flex; align-items: flex-start; gap: 8px; padding: 10px 13px; color: #991b1b; background: #fff1f2; font-size: 11px; line-height: 1.5; }
.error-banner svg { flex: 0 0 auto; }
.json-response { flex: 1; min-height: 520px; max-height: 650px; overflow: auto; margin: 0; padding: 15px; color: #dbeafe; background: #172033; font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.inline-tester { color: #334155; }
.tester-header { padding: 18px 16px 14px; border-bottom: 1px solid #dbe3ed; background: #fff; }
.tester-header h3 { margin: 4px 0; color: #0f172a; font-size: 15px; }.tester-header p { margin: 0; color: #64748b; font-size: 10px; line-height: 1.55; }
.method-explainer { display: grid; grid-template-columns: 48px 1fr; gap: 9px; margin: 12px; padding: 11px; border: 1px solid #a7f3d0; border-radius: 7px; background: #ecfdf5; }.method-explainer.post { border-color: #bfdbfe; background: #eff6ff; }.method-explainer > strong { display: grid; height: 28px; place-items: center; border-radius: 5px; color: #047857; background: #d1fae5; font-size: 10px; }.method-explainer.post > strong { color: #1d4ed8; background: #dbeafe; }.method-explainer div { display: grid; gap: 3px; }.method-explainer b { color: #1e293b; font-size: 11px; }.method-explainer span { color: #64748b; font-size: 9px; line-height: 1.5; }
.tester-form { display: grid; gap: 8px; padding: 4px 12px 14px; }.inline-key-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; }.inline-key-row .el-button { padding-inline: 10px; }.helper-text { margin: -4px 0 4px; color: #94a3b8; font-size: 9px; }.tester-path { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 7px; padding: 8px; border: 1px solid #dbe3ed; border-radius: 6px; background: #fff; }.tester-path code { overflow: hidden; color: #4338ca; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.tester-method { display: inline-grid; height: 20px; padding: 0 6px; place-items: center; border-radius: 4px; color: #047857; background: #d1fae5; font-size: 9px; font-weight: 850; }.tester-method.post { color: #1d4ed8; background: #dbeafe; }.compact-editor textarea { min-height: 92px; max-height: 180px; }.tester-send { width: 100%; margin-top: 2px; }
.tester-result { border-top: 1px solid #dbe3ed; background: #fff; }.tester-result-title { display: flex; align-items: center; justify-content: space-between; padding: 12px; }.tester-result-title strong { font-size: 12px; }.tester-result-title span { color: #64748b; font-size: 9px; }.tester-empty { padding: 22px 16px; color: #94a3b8; font-size: 10px; line-height: 1.6; text-align: center; }.tester-result-tabs { display: flex; gap: 4px; overflow-x: auto; padding: 0 12px 8px; }.tester-result-tabs button { flex: 0 0 auto; display: grid; gap: 2px; padding: 5px 7px; border: 1px solid #dbe3ed; border-radius: 5px; color: #475569; background: #fff; font: inherit; font-size: 9px; cursor: pointer; }.tester-result-tabs button.active { border-color: #2563eb; background: #eff6ff; }.tester-result-tabs span { font-size: 8px; }.tester-result pre { max-height: 320px; overflow: auto; margin: 0; padding: 12px; color: #dbeafe; background: #0f172a; font: 9px/1.55 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.method-glossary { margin: 12px; padding: 10px; border: 1px solid #dbe3ed; border-radius: 6px; background: #fff; }.method-glossary summary { color: #2563eb; font-size: 10px; font-weight: 750; cursor: pointer; }.method-glossary dl { display: grid; gap: 6px; margin: 10px 0 0; }.method-glossary dl div { display: grid; grid-template-columns: 72px 1fr; gap: 7px; }.method-glossary dt { color: #4338ca; font-family: ui-monospace, monospace; font-size: 9px; }.method-glossary dd { margin: 0; color: #64748b; font-size: 9px; }
.spin { animation: shopee-console-spin .8s linear infinite; }
@keyframes shopee-console-spin { to { transform: rotate(360deg); } }
@media (max-width: 1280px) {
  .console-workbench { grid-template-columns: 1fr; }
  .response-empty { min-height: 420px; }
  .response-workspace { min-height: 520px; }
}
@media (max-width: 760px) {
  .console-metrics { grid-template-columns: 1fr 1fr; }
  .credential-row, .two-column-fields, .json-editor-grid { grid-template-columns: 1fr; }
  .credential-row .el-button { width: 100%; }
  .response-workspace { grid-template-columns: 1fr; }
  .result-list { max-height: 240px; border-right: 0; border-bottom: 1px solid var(--ops-border-light); }
  .json-response { min-height: 360px; }
}
@media (max-width: 430px) {
  .console-metrics { grid-template-columns: 1fr; }
  .security-notice { align-items: flex-start; }
  .console-panel-header { padding: 12px; }
  .form-section { padding: 14px 12px; }
  .selection-actions { flex-wrap: wrap; }
  .request-actions { align-items: stretch; flex-direction: column; }
  .request-actions .el-button { width: 100%; }
  .result-summary { gap: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
}
</style>
