<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { CalendarDays, FileSpreadsheet, RefreshCw, Store, WalletCards } from "@lucide/vue";
import {
  getProfitDashboard,
  importShopeeStatement,
  startProfitSync,
  type ProfitDashboard,
  type ProfitDataStatus,
  type ProfitDecimal,
  type ProfitPlatform,
  type ProfitPreset,
} from "@/services/profit";

function addDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function initialCustomRange(): [string, string] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const yesterday = addDays(`${values.year}-${values.month}-${values.day}`, -1);
  return [addDays(yesterday, -6), yesterday];
}

const platform = ref<ProfitPlatform>("ALL");
const preset = ref<ProfitPreset>("CURRENT_BILLING_PERIOD");
const customRange = ref<[string, string]>(initialCustomRange());
const country = ref("");
const shopId = ref("");
const loading = ref(false);
const syncing = ref(false);
const error = ref("");
const dashboard = ref<ProfitDashboard | null>(null);
const importOpen = ref(false);
const importCountry = ref("");
const importShopId = ref("");
const importFile = ref<File | null>(null);
const importing = ref(false);
let pollTimer: number | null = null;
let pollCount = 0;

const shopOptions = computed(() => (dashboard.value?.filters.shops || []).filter((shop) => (
  (platform.value === "ALL" || shop.platform === platform.value)
  && (!country.value || shop.countryCode === country.value)
)));
const shopeeShopOptions = computed(() => (dashboard.value?.filters.shops || []).filter((shop) => (
  shop.platform === "SHOPEE" && (!importCountry.value || shop.countryCode === importCountry.value)
)));
const metrics = computed(() => dashboard.value?.selection || null);
const displayMetrics = computed(() => metrics.value?.mixedCurrency ? dashboard.value?.cnySummary : metrics.value);
const displayCurrency = computed(() => metrics.value?.mixedCurrency ? "CNY" : metrics.value?.currency);
const fxNote = computed(() => {
  const rate = dashboard.value?.cnySummary.rateCoverage;
  if (!rate) return "人民币汇率待加载";
  const missing = [...rate.missingCountries, ...rate.ambiguousCountries];
  return missing.length
    ? `产品包国家汇率 · ${missing.join("、")} 待补`
    : `产品包国家汇率 · ${rate.convertedCountryCount}/${rate.countryCount} 国已匹配`;
});

function finiteNumber(value: ProfitDecimal | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: ProfitDecimal | null | undefined, currencyCode: string | null | undefined) {
  const parsed = finiteNumber(value);
  if (parsed === null || !currencyCode) return "待补数据";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency", currency: currencyCode, maximumFractionDigits: 3,
  }).format(parsed);
}

function percent(value: ProfitDecimal | null | undefined) {
  const parsed = finiteNumber(value);
  return parsed === null ? "待补数据" : `${parsed.toFixed(2)}%`;
}

function platformLabel(value: string) {
  return value === "SHOPEE" ? "Shopee" : value === "LAZADA" ? "Lazada" : "全部平台";
}

function statusLabel(status: ProfitDataStatus | undefined) {
  return status === "COMPLETE" ? "完整" : status === "PARTIAL" ? "待补" : status === "FAILED" ? "失败" : "暂无";
}

function statusType(status: ProfitDataStatus | undefined) {
  return status === "COMPLETE" ? "success" : status === "PARTIAL" ? "warning" : status === "FAILED" ? "danger" : "info";
}

function query() {
  return {
    platform: platform.value,
    preset: preset.value,
    ...(preset.value === "CUSTOM" ? { dateFrom: customRange.value[0], dateTo: customRange.value[1] } : {}),
    country: country.value || undefined,
    shopId: shopId.value || undefined,
  };
}

async function load({ quiet = false } = {}) {
  if (!quiet) loading.value = true;
  error.value = "";
  try {
    dashboard.value = await getProfitDashboard(query());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "利润数据读取失败";
  } finally {
    loading.value = false;
  }
}

function clearPoll() {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
}

async function pollSync() {
  pollCount += 1;
  await load({ quiet: true });
  const running = dashboard.value?.platforms.some((item) => item.run?.status === "RUNNING");
  if (running || pollCount < 3) {
    pollTimer = window.setTimeout(pollSync, 3500);
    return;
  }
  syncing.value = false;
  clearPoll();
  ElMessage.success("利润增量同步完成；缺失来源会保留为待补状态");
}

async function syncAll() {
  syncing.value = true;
  try {
    const result = await startProfitSync(query());
    ElMessage.info(result.accepted ? "已启动平台账期增量同步" : "当前没有新的可同步任务");
    pollCount = 0;
    clearPoll();
    pollTimer = window.setTimeout(pollSync, 1800);
  } catch (cause) {
    syncing.value = false;
    error.value = cause instanceof Error ? cause.message : "利润同步启动失败";
  }
}

function applyFilters() {
  if (shopId.value && !shopOptions.value.some((shop) => shop.id === shopId.value)) shopId.value = "";
  load();
}

function openImport() {
  importCountry.value = country.value || "";
  importShopId.value = "";
  importFile.value = null;
  importOpen.value = true;
}

function pickFile(event: Event) {
  importFile.value = (event.target as HTMLInputElement).files?.[0] || null;
}

async function submitImport() {
  if (!importCountry.value || !importShopId.value || !importFile.value) {
    ElMessage.warning("请选择国家、Shopee 店铺和账单文件");
    return;
  }
  importing.value = true;
  try {
    const result = await importShopeeStatement({
      file: importFile.value,
      countryCode: importCountry.value,
      shopId: importShopId.value,
    });
    importOpen.value = false;
    platform.value = "SHOPEE";
    country.value = importCountry.value;
    preset.value = "CUSTOM";
    customRange.value = [result.run.dateFrom, result.run.dateTo];
    shopId.value = importShopId.value;
    await load();
    ElMessage.success("Shopee 账单已计算并保存快照");
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : "Shopee 账单导入失败");
  } finally {
    importing.value = false;
  }
}

onMounted(load);
onBeforeUnmount(clearPoll);
</script>

<template>
  <main class="profit-page">
    <header class="profit-hero">
      <div>
        <span class="eyebrow">COMMERCE PROFIT CONTROL</span>
        <h1>利润分析</h1>
        <p>国家总览向下展开平台，统一核对标价、到账、成本与订单完整度。</p>
      </div>
      <div class="hero-actions">
        <el-button :icon="FileSpreadsheet" @click="openImport">导入 Shopee 账单</el-button>
        <el-button :icon="RefreshCw" :loading="loading" @click="load()">刷新</el-button>
        <el-button type="primary" :loading="syncing" @click="syncAll">增量同步</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />

    <section class="filter-panel" aria-label="利润筛选条件">
      <label>
        <span>账期</span>
        <el-select v-model="preset" @change="applyFilters">
          <el-option label="当前账期" value="CURRENT_BILLING_PERIOD" />
          <el-option label="上一账期" value="LAST_BILLING_PERIOD" />
          <el-option label="自定义日期" value="CUSTOM" />
        </el-select>
      </label>
      <label v-if="preset === 'CUSTOM'" class="date-filter">
        <span>交易日期</span>
        <el-date-picker v-model="customRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" :clearable="false" @change="applyFilters" />
      </label>
      <label>
        <span>平台</span>
        <el-select v-model="platform" @change="applyFilters">
          <el-option label="全部平台" value="ALL" />
          <el-option label="Lazada" value="LAZADA" />
          <el-option label="Shopee" value="SHOPEE" />
        </el-select>
      </label>
      <label>
        <span>国家</span>
        <el-select v-model="country" clearable placeholder="全部国家" @change="applyFilters">
          <el-option v-for="item in dashboard?.filters.countries || []" :key="item" :label="item" :value="item" />
        </el-select>
      </label>
      <label class="shop-filter">
        <span>店铺</span>
        <el-select v-model="shopId" clearable filterable placeholder="全部店铺" @change="applyFilters">
          <el-option v-for="shop in shopOptions" :key="`${shop.platform}:${shop.id}`" :label="`${platformLabel(shop.platform)} · ${shop.shopCode} · ${shop.shopName}`" :value="shop.id" />
        </el-select>
      </label>
    </section>

    <section v-if="dashboard" class="period-strip">
      <div v-for="item in dashboard.periods" :key="item.platform" class="period-item">
        <span class="platform-pill" :class="item.platform.toLowerCase()">{{ platformLabel(item.platform) }}</span>
        <div>
          <strong>交易日期 {{ item.transactionRange.dateFrom }} 至 {{ item.transactionRange.dateTo }}</strong>
          <small>核算账期 {{ item.accountingRange.dateFrom }} 至 {{ item.accountingRange.dateTo }}</small>
        </div>
      </div>
      <div class="automation-note"><CalendarDays :size="17" /><span>每日 {{ dashboard.automation.scheduleTime }} 增量刷新<br><small>{{ dashboard.automation.timeZone }} · 约 1 天延迟</small></span></div>
    </section>

    <el-skeleton v-if="loading && !dashboard" :rows="8" animated />
    <template v-else-if="dashboard">
      <section class="metric-grid" aria-label="利润核心指标">
        <article><span>标价收入</span><strong>{{ money(displayMetrics?.listRevenue, displayCurrency) }}</strong><small>{{ metrics?.mixedCurrency ? `跨币种按人民币展示 · ${fxNote}` : "账单标价项合计" }}</small></article>
        <article><span>真实到账收入</span><strong>{{ money(displayMetrics?.receivedRevenue, displayCurrency) }}</strong><small>按国家版本化到账公式</small></article>
        <article><span>总成本</span><strong>{{ money(displayMetrics?.totalCost, displayCurrency) }}</strong><small>马帮实发 SKU × 产品包原币成本</small></article>
        <article class="expense"><span>店铺费用</span><strong>{{ money(displayMetrics?.expenseValue, displayCurrency) }}</strong><small>广告钱包 + 账单费用，按店铺当地交易日期汇总 · {{ metrics?.completeExpenseShopCount || 0 }}/{{ metrics?.shopCount || 0 }} 店完整</small></article>
        <article class="gmv"><span>GMV</span><strong>{{ money(displayMetrics?.gmvValue, displayCurrency) }}</strong><small>马帮原始商品总金额 − 优惠金额（原币）· 订单头去重 · {{ metrics?.completeGmvShopCount || 0 }}/{{ metrics?.shopCount || 0 }} 店完整</small></article>
        <article class="rate expense-rate"><span>费用率</span><strong>{{ percent(displayMetrics?.expenseRate) }}</strong><small>总费用 ÷ GMV；国家按总费用 ÷ 国家总 GMV 加权计算</small></article>
        <article class="rate"><span>标价利润率</span><strong>{{ percent(displayMetrics?.listProfitMargin) }}</strong><small>(标价收入 − 总成本) ÷ 标价收入</small></article>
        <article class="rate"><span>到账利润率</span><strong>{{ percent(displayMetrics?.receivedProfitMargin) }}</strong><small>(到账收入 − 总成本) ÷ 到账收入</small></article>
        <article class="rate accent"><span>标价－到账利润率</span><strong>{{ percent(displayMetrics?.listToReceivedProfitMargin) }}</strong><small>(到账收入 − 总成本) ÷ 标价收入 · {{ metrics?.selectedOrderCount || 0 }} 单</small></article>
      </section>

      <section class="data-card">
        <div class="section-heading">
          <div><span class="section-icon"><WalletCards :size="19" /></span><div><h2>国家利润总览</h2><p>点击国家行展开 Lazada / Shopee 平台明细。</p></div></div>
          <el-tag effect="plain">{{ metrics?.shopCount || 0 }} 家店铺 · {{ metrics?.selectedOrderCount || 0 }} 单</el-tag>
        </div>
        <el-table :data="dashboard.countries" stripe row-key="countryCode" empty-text="当前账期暂无利润快照">
          <el-table-column type="expand" width="48">
            <template #default="{ row }">
              <div class="platform-breakdown">
                <article v-for="item in row.platforms" :key="item.platform">
                  <header><span class="platform-pill" :class="item.platform.toLowerCase()">{{ platformLabel(item.platform) }}</span><el-tag :type="statusType(item.dataStatus)" size="small">{{ statusLabel(item.dataStatus) }}</el-tag></header>
                  <div><span>标价</span><strong>{{ money(item.listRevenue, item.currency) }}</strong></div>
                  <div><span>到账</span><strong>{{ money(item.receivedRevenue, item.currency) }}</strong></div>
                  <div><span>成本</span><strong>{{ money(item.totalCost, item.currency) }}</strong></div>
                  <div><span>费用</span><strong>{{ money(item.expenseValue, item.currency) }}</strong></div>
                  <div><span>GMV</span><strong>{{ money(item.gmvValue, item.currency) }}</strong></div>
                  <div><span>费用率</span><strong>{{ percent(item.expenseRate) }}</strong></div>
                  <footer>{{ item.shopCount }} 店 · GMV {{ item.confirmedGmvOrderCount }}/{{ item.gmvOrderCount }} 单 · 到账利润率 {{ percent(item.receivedProfitMargin) }}</footer>
                </article>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="countryCode" label="国家" width="84" fixed />
          <el-table-column label="平台" width="132"><template #default="{ row }"><span class="platform-count">{{ row.platforms.map((item: { platform: string }) => platformLabel(item.platform)).join(" + ") }}</span></template></el-table-column>
          <el-table-column label="完整度" width="112"><template #default="{ row }"><el-tag :type="statusType(row.dataStatus)" size="small">{{ row.completeShopCount }}/{{ row.shopCount }} 完整</el-tag></template></el-table-column>
          <el-table-column label="标价收入" min-width="150" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.listRevenue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="真实到账" min-width="150" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.receivedRevenue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="总成本" min-width="150" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.totalCost, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="店铺费用" min-width="150" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.expenseValue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="GMV" min-width="150" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.gmvValue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="费用率" width="112" align="right"><template #default="{ row }"><strong class="table-number">{{ percent(row.expenseRate) }}</strong></template></el-table-column>
          <el-table-column label="标价利润率" width="126" align="right"><template #default="{ row }">{{ percent(row.listProfitMargin) }}</template></el-table-column>
          <el-table-column label="到账利润率" width="126" align="right"><template #default="{ row }">{{ percent(row.receivedProfitMargin) }}</template></el-table-column>
          <el-table-column label="标价－到账" width="126" align="right"><template #default="{ row }">{{ percent(row.listToReceivedProfitMargin) }}</template></el-table-column>
          <el-table-column label="订单" width="82" align="right"><template #default="{ row }"><strong class="table-number">{{ row.selectedOrderCount }}</strong></template></el-table-column>
        </el-table>
      </section>

      <section class="data-card">
        <div class="section-heading">
          <div><span class="section-icon neutral"><Store :size="19" /></span><div><h2>店铺利润明细</h2><p>缺订单、缺 SKU 成本或成本冲突时保持“待补”，不做估算。</p></div></div>
          <span class="result-count">{{ dashboard.shops.length }} 条</span>
        </div>
        <el-table :data="dashboard.shops" stripe empty-text="当前筛选条件没有店铺">
          <el-table-column label="店铺" min-width="220" fixed><template #default="{ row }"><div class="shop-cell"><strong>{{ row.shopCode }}</strong><span>{{ row.shopName }}</span></div></template></el-table-column>
          <el-table-column label="平台" width="90"><template #default="{ row }"><span class="platform-pill small" :class="row.platform.toLowerCase()">{{ platformLabel(row.platform) }}</span></template></el-table-column>
          <el-table-column prop="countryCode" label="国家" width="68" />
          <el-table-column label="状态" width="86"><template #default="{ row }"><el-tag :type="statusType(row.dataStatus)" size="small">{{ statusLabel(row.dataStatus) }}</el-tag></template></el-table-column>
          <el-table-column label="费用状态" width="96"><template #default="{ row }"><el-tag :type="statusType(row.expenseDataStatus)" size="small">{{ statusLabel(row.expenseDataStatus) }}</el-tag></template></el-table-column>
          <el-table-column label="GMV状态" width="96"><template #default="{ row }"><el-tag :type="statusType(row.gmvDataStatus)" size="small">{{ statusLabel(row.gmvDataStatus) }}</el-tag></template></el-table-column>
          <el-table-column label="标价收入" min-width="140" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.listRevenue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="真实到账" min-width="140" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.receivedRevenue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="总成本" min-width="140" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.totalCost, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="店铺费用" min-width="140" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.expenseValue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="GMV" min-width="140" align="right"><template #default="{ row }"><strong class="table-number">{{ money(row.gmvValue, row.currency) }}</strong></template></el-table-column>
          <el-table-column label="费用率" width="108" align="right"><template #default="{ row }"><strong class="table-number">{{ percent(row.expenseRate) }}</strong></template></el-table-column>
          <el-table-column label="到账利润率" width="118" align="right"><template #default="{ row }">{{ percent(row.receivedProfitMargin) }}</template></el-table-column>
          <el-table-column label="订单/成本" width="124" align="right"><template #default="{ row }"><span class="coverage">{{ row.linkedOrderCount }}/{{ row.selectedOrderCount }} 单<br>{{ row.matchedCostLineCount }}/{{ row.costLineCount }} 成本</span></template></el-table-column>
          <el-table-column label="费用日期" width="112" align="right"><template #default="{ row }"><span class="coverage">{{ row.completeExpenseDayCount }}/{{ row.expectedExpenseDayCount }} 天<br>{{ row.advertisingExpenseRowCount + row.billingExpenseRowCount }} 笔</span></template></el-table-column>
          <el-table-column label="GMV订单" width="118" align="right"><template #default="{ row }"><span class="coverage">{{ row.confirmedGmvOrderCount }}/{{ row.gmvOrderCount }} 单<br>{{ row.gmvSourceCoveredDayCount }}/{{ row.expectedGmvDayCount }} 天</span></template></el-table-column>
        </el-table>
      </section>

      <section class="snapshot-strip">
        <strong>最近快照</strong>
        <span v-for="run in dashboard.snapshots.slice(0, 8)" :key="run.id">{{ platformLabel(run.platform) }} · {{ run.dateFrom }}～{{ run.dateTo }} · {{ statusLabel(run.status as ProfitDataStatus) }}</span>
      </section>
    </template>

    <el-dialog v-model="importOpen" title="导入 Shopee Income Statement" width="min(520px, 92vw)">
      <div class="import-form">
        <label><span>国家</span><el-select v-model="importCountry" placeholder="选择账单国家"><el-option v-for="item in dashboard?.filters.countries || []" :key="item" :label="item" :value="item" /></el-select></label>
        <label><span>Shopee 店铺</span><el-select v-model="importShopId" filterable placeholder="选择店铺"><el-option v-for="shop in shopeeShopOptions" :key="shop.id" :label="`${shop.shopCode} · ${shop.shopName}`" :value="shop.id" /></el-select></label>
        <label><span>账单文件</span><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="pickFile"></label>
        <p>导入后会按国家公式计算，并匹配马帮实发 SKU、数量及产品包原币成本。</p>
      </div>
      <template #footer><el-button @click="importOpen = false">取消</el-button><el-button type="primary" :loading="importing" @click="submitImport">导入并计算</el-button></template>
    </el-dialog>
  </main>
</template>

<style scoped>
.profit-page { width: 100%; display: grid; gap: 18px; color: #172033; }
.profit-hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 6px 0 2px; }
.eyebrow { display: block; margin-bottom: 6px; color: #6655d9; font-size: 11px; font-weight: 850; letter-spacing: .14em; }
.profit-hero h1 { margin: 0; font-size: clamp(30px, 3vw, 42px); letter-spacing: -.045em; }
.profit-hero p { margin: 8px 0 0; color: #677189; font-size: 14px; }
.hero-actions { display: flex; gap: 9px; flex-wrap: wrap; justify-content: flex-end; }
.filter-panel { display: grid; grid-template-columns: 170px minmax(240px, 1.25fr) 150px 150px minmax(240px, 1fr); gap: 12px; align-items: end; padding: 15px 16px; background: #fff; border: 1px solid #e3e7ef; border-radius: 14px; box-shadow: 0 8px 24px rgba(31, 38, 67, .045); }
.filter-panel:not(:has(.date-filter)) { grid-template-columns: 180px 180px 180px minmax(260px, 1fr); }
.filter-panel label, .import-form label { display: grid; gap: 7px; color: #5f687b; font-size: 12px; font-weight: 750; }
.filter-panel :deep(.el-select), .filter-panel :deep(.el-date-editor), .import-form :deep(.el-select) { width: 100%; }
.period-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) auto; gap: 10px; align-items: stretch; }
.period-item, .automation-note { display: flex; align-items: center; gap: 11px; min-height: 60px; padding: 11px 14px; background: #f8f9fc; border: 1px solid #e4e8ef; border-radius: 12px; }
.period-item div { display: grid; gap: 3px; }.period-item strong { font-size: 13px; }.period-item small, .automation-note small { color: #838da0; font-size: 11px; }
.automation-note { color: #6655d9; white-space: nowrap; }.automation-note > span { color: #394255; font-size: 12px; font-weight: 750; }
.platform-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 66px; padding: 5px 9px; color: #285e9c; background: #eaf3ff; border-radius: 999px; font-size: 11px; font-weight: 850; letter-spacing: .02em; }
.platform-pill.shopee { color: #b64225; background: #fff0eb; }.platform-pill.small { min-width: 0; padding: 4px 7px; }
.metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.metric-grid article { min-height: 132px; display: flex; flex-direction: column; justify-content: space-between; padding: 18px 20px; background: #fff; border: 1px solid #e3e7ef; border-radius: 15px; box-shadow: 0 8px 24px rgba(31, 38, 67, .04); }
.metric-grid article > span { color: #667085; font-size: 13px; font-weight: 800; }.metric-grid strong { overflow-wrap: anywhere; font-size: clamp(25px, 2.35vw, 38px); line-height: 1.04; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }.metric-grid small { color: #8a94a7; font-size: 11px; line-height: 1.5; }
.metric-grid .rate { background: linear-gradient(145deg, #fff 35%, #f5f3ff); }.metric-grid .accent { color: #fff; background: linear-gradient(145deg, #7060dc, #4b3aaa); border-color: transparent; }.metric-grid .accent > span, .metric-grid .accent small { color: rgba(255,255,255,.78); }
.metric-grid .expense { background: linear-gradient(145deg, #fff 35%, #eef8f6); border-color: #d5ebe6; }
.metric-grid .gmv { background: linear-gradient(145deg, #fff 35%, #eef5ff); border-color: #d6e5f8; }
.metric-grid .expense-rate { background: linear-gradient(145deg, #fff 35%, #fff4e8); border-color: #f0dfc8; }
.data-card { overflow: hidden; background: #fff; border: 1px solid #e3e7ef; border-radius: 14px; box-shadow: 0 8px 24px rgba(31, 38, 67, .04); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 17px 18px; border-bottom: 1px solid #eceef3; }.section-heading > div { display: flex; align-items: center; gap: 12px; }.section-heading h2 { margin: 0; font-size: 17px; }.section-heading p { margin: 3px 0 0; color: #858da0; font-size: 12px; }
.section-icon { display: grid; place-items: center; width: 38px; height: 38px; color: #6655d9; background: #f0edff; border-radius: 10px; }.section-icon.neutral { color: #367098; background: #edf5fb; }
.platform-breakdown { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 12px; padding: 16px 54px; background: #f7f8fb; }
.platform-breakdown article { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; padding: 15px 16px; background: #fff; border: 1px solid #e2e6ee; border-radius: 12px; }.platform-breakdown header, .platform-breakdown footer { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; }.platform-breakdown div { display: grid; gap: 3px; }.platform-breakdown div span { color: #8a93a6; font-size: 10px; }.platform-breakdown div strong { font-size: 16px; font-variant-numeric: tabular-nums; }.platform-breakdown footer { color: #727d91; font-size: 11px; }
.platform-count { color: #59647a; font-size: 12px; }.table-number { font-size: 14px; font-variant-numeric: tabular-nums; }.shop-cell { display: grid; gap: 3px; }.shop-cell strong { font-size: 13px; }.shop-cell span { overflow: hidden; color: #80899b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.coverage { color: #697286; font-size: 11px; line-height: 1.45; font-variant-numeric: tabular-nums; }.result-count { color: #7d8598; font-size: 12px; }
.snapshot-strip { display: flex; gap: 8px; align-items: center; overflow-x: auto; padding: 2px 0 8px; color: #707a8e; font-size: 11px; }.snapshot-strip strong { flex: 0 0 auto; color: #3d4658; }.snapshot-strip span { flex: 0 0 auto; padding: 6px 9px; background: #f3f5f8; border-radius: 8px; }
.import-form { display: grid; gap: 15px; }.import-form input { padding: 10px; border: 1px solid #d7dce6; border-radius: 8px; }.import-form p { margin: 0; color: #7d8799; font-size: 12px; line-height: 1.55; }
:deep(.el-table) { --el-table-header-bg-color: #f7f8fb; --el-table-border-color: #eceef3; color: #2e374a; font-size: 13px; }:deep(.el-table th.el-table__cell) { color: #657084; font-size: 12px; font-weight: 850; }:deep(.el-table .cell) { font-variant-numeric: tabular-nums; }:deep(.el-table td.el-table__cell) { padding: 12px 0; }
@media (max-width: 1180px) { .filter-panel, .filter-panel:not(:has(.date-filter)) { grid-template-columns: repeat(2, minmax(0, 1fr)); }.shop-filter { grid-column: span 2; }.period-strip { grid-template-columns: 1fr 1fr; }.automation-note { grid-column: 1 / -1; }.metric-grid strong { font-size: clamp(23px, 3vw, 32px); } }
@media (max-width: 760px) { .profit-hero { align-items: flex-start; flex-direction: column; }.hero-actions { width: 100%; justify-content: flex-start; }.filter-panel, .filter-panel:not(:has(.date-filter)) { grid-template-columns: 1fr; }.shop-filter { grid-column: auto; }.period-strip, .metric-grid { grid-template-columns: 1fr; }.automation-note { grid-column: auto; }.platform-breakdown { grid-template-columns: 1fr; padding: 12px; }.metric-grid article { min-height: 120px; } }
</style>
