import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vueRoot = path.join(rootDir, "frontend", "commerce-ops-vue");

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

test("Vue workspace uses the approved operations dashboard stack", () => {
  const packageJson = JSON.parse(read("frontend/commerce-ops-vue/package.json"));
  assert.ok(packageJson.dependencies.vue);
  assert.ok(packageJson.dependencies["element-plus"]);
  assert.ok(packageJson.dependencies.pinia);
  assert.ok(packageJson.dependencies["vue-router"]);
  assert.ok(packageJson.dependencies.echarts);
  assert.equal(packageJson.dependencies.react, undefined);
  assert.equal(packageJson.dependencies["react-dom"], undefined);
  assert.ok(fs.existsSync(path.join(vueRoot, "src", "App.vue")));
});

test("Vue shell builds to production with a legacy fallback", () => {
  const viteConfig = read("frontend/commerce-ops-vue/vite.config.ts");
  const rootPackage = JSON.parse(read("package.json"));
  assert.match(viteConfig, /public\/vue-preview/);
  assert.match(viteConfig, /base:\s*["']\/vue-preview\//);
  assert.match(rootPackage.scripts["build:vue"], /commerce-ops-vue/);
  assert.match(rootPackage.scripts.build, /build:vue/);
  const server = read("server.mjs");
  assert.match(server, /url\.pathname === ["']\/["'][\s\S]*vue-preview\/index\.html/);
  assert.match(server, /decodedPath === ["']\/legacy["'][\s\S]*["']\/index\.html["']/);
});

test("Vue shell reuses the production authentication contract", () => {
  const app = read("frontend/commerce-ops-vue/src/App.vue");
  const api = read("frontend/commerce-ops-vue/src/services/api.ts");
  assert.match(app, /getAuthenticationStatus/);
  assert.match(app, /AuthGate/);
  assert.match(api, /commerce-ops-access-token/);
  assert.match(api, /\/api\/auth\/status/);
  assert.match(api, /\/api\/auth\/verify/);
  assert.match(api, /\/api\/auth\/logout/);
  assert.match(api, /typeof payload\.message === ["']string["']/);
});

test("Vue overview reads real sales and fulfillment APIs", () => {
  const overviewService = read("frontend/commerce-ops-vue/src/services/overview.ts");
  const overviewPage = read("frontend/commerce-ops-vue/src/pages/OperationsOverview.vue");
  assert.match(overviewService, /\/api\/sales-assortment\/dashboard/);
  assert.match(overviewService, /\/api\/fulfillment-dashboard\/dashboard/);
  assert.match(overviewService, /Promise\.allSettled/);
  assert.doesNotMatch(overviewPage, /Math\.random|mock|fixture/i);
  assert.match(read("frontend/commerce-ops-vue/src/pages/SalesAssortmentPage.vue"), /loadSalesDashboard/);
  assert.match(read("frontend/commerce-ops-vue/src/pages/FulfillmentPage.vue"), /runFulfillmentScan/);
});

test("every active navigation destination has a Vue page and real API contract", () => {
  const router = read("frontend/commerce-ops-vue/src/router/index.ts");
  const sidebar = read("frontend/commerce-ops-vue/src/components/OpsSidebar.vue");
  const expectedPages = [
    ["/overview", "OperationsOverview.vue"],
    ["/sales-assortment", "SalesAssortmentPage.vue"],
    ["/products", "ProductCenterPage.vue"],
    ["/link-analysis", "CompetitorAnalysisPage.vue"],
    ["/keyword-analysis", "CompetitorAnalysisPage.vue"],
    ["/growth-radar", "GrowthRadarPage.vue"],
    ["/advertising", "AdvertisingPage.vue"],
    ["/mabang", "MabangPage.vue"],
    ["/mabang-listing", "MabangListingPage.vue"],
    ["/fulfillment", "FulfillmentPage.vue"],
    ["/audit", "AuditPage.vue"],
  ];
  for (const [route, page] of expectedPages) {
    assert.match(sidebar, new RegExp(route.replace("/", "\\/")));
    assert.match(router, new RegExp(page.replace(".", "\\.")));
    assert.ok(fs.existsSync(path.join(vueRoot, "src", "pages", page)));
  }
  assert.doesNotMatch(router, /:module\(products|:module\(link-analysis|:module\(advertising/);

  const serviceSources = ["products.ts", "competitor.ts", "growth.ts", "advertising.ts", "mabang.ts", "listing.ts", "audit.ts"]
    .map((file) => read(`frontend/commerce-ops-vue/src/services/${file}`)).join("\n");
  for (const api of ["/api/product-center/", "/api/extract-and-analyze", "/api/growth-radar/v2/", "/api/ad-analyzer/status", "/api/mabang/", "/api/mabang-listing", "/api/audit/"]) {
    assert.match(serviceSources, new RegExp(api.replaceAll("/", "\\/")));
  }
});

test("Vue design system includes responsive and accessibility gates", () => {
  const styles = read("frontend/commerce-ops-vue/src/styles/global.css");
  const design = read("docs/design/COMMERCE-OPS-VUE-MIGRATION-DESIGN.md");
  assert.match(styles, /max-width:\s*430px/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /min-height:\s*42px/);
  assert.match(design, /375、768、1024 和 1440/);
  assert.match(design, /后端生成正式文件/);
});

test("Vue is the only active frontend and new modules are policy-gated", () => {
  const policy = JSON.parse(read("frontend/frontend-policy.json"));
  const rootPackage = JSON.parse(read("package.json"));
  const activePackage = JSON.parse(read("frontend/commerce-ops-vue/package.json"));
  const checker = read("scripts/check-frontend-framework.mjs");
  assert.equal(policy.activeWorkspace, "commerce-ops-vue");
  assert.equal(activePackage.dependencies.react, undefined);
  assert.equal(activePackage.dependencies["react-dom"], undefined);
  assert.match(rootPackage.scripts.build, /check:frontend/);
  assert.match(rootPackage.scripts.build, /build:vue/);
  assert.doesNotMatch(rootPackage.scripts.build, /build:growth-radar:v2|build:sales-assortment|build:mabang-listing/);
  assert.match(checker, /React source is not allowed/);
  assert.match(checker, /New modules belong in/);
});

test("Vue sales assortment page owns scheduler, DingTalk and DeepSeek workflows", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/SalesAssortmentPage.vue");
  const shell = read("frontend/commerce-ops-vue/src/layouts/OpsShell.vue");
  const sourceImports = read("frontend/commerce-ops-vue/src/components/SalesSourceImports.vue");
  const moduleInsight = read("frontend/commerce-ops-vue/src/components/ModuleAiInsight.vue");
  const trendChart = read("frontend/commerce-ops-vue/src/components/TrendChart.vue");
  const service = read("frontend/commerce-ops-vue/src/services/sales-automation.ts");
  for (const label of ["数据自动化设置", "订单定时", "库存定时", "日报推送", "钉钉机器人", "异常数据", "商业机会", "库存行动", "数据准备度"]) {
    assert.match(page, new RegExp(label));
  }
  assert.doesNotMatch(page, /订单与库存定时采集|DeepSeek 经营分析/);
  assert.match(page, /analysis\.modules/);
  assert.match(page, /SalesSourceImports/);
  assert.match(page, /近7天/);
  assert.match(page, /近14天/);
  assert.match(page, /近30天/);
  assert.match(page, /本月/);
  assert.match(page, /上月/);
  assert.match(page, /dateRangeFilter = ref<\[string, string\] \| null>\(yesterdayRange\(\)\)/);
  assert.match(page, /本月与上月同期趋势/);
  assert.match(page, /本月与上月同期 GMV 对比/);
  assert.match(page, /:comparison-rows="previousMonthTrend"/);
  assert.doesNotMatch(page, /monthly-trend-grid/);
  for (const seriesName of ["我方 GMV · 本月", "我方 GMV · 上月同期", "货盘金额 · 本月", "货盘金额 · 上月同期"]) {
    assert.match(trendChart, new RegExp(seriesName));
  }
  assert.match(trendChart, /comparisonRows/);
  assert.ok(page.indexOf('class="movement-panel decline-panel"') < page.indexOf('title="店铺下滑重点诊断"'));
  assert.ok(page.indexOf('class="movement-panel growth-panel"') < page.indexOf('title="店铺增长重点诊断"'));
  assert.ok(page.indexOf('class="dashboard-panel opportunity-panel"') < page.indexOf('title="高价值商业机会"'));
  assert.match(moduleInsight, /data-tone="decline"[^}]+#087f5b/s);
  assert.match(moduleInsight, /data-tone="growth"[^}]+#c73545/s);
  assert.match(page, /订单立即导出/);
  assert.match(page, /const shouldLoadTaskDefaults = immediateForm\.taskId !== task\.id/);
  assert.match(page, /if \(shouldLoadTaskDefaults\)/);
  assert.doesNotMatch(shell, /GlobalFilterBar/);
  for (const label of ["订单表", "库存表", "产品包", "查看"]) assert.match(sourceImports, new RegExp(label));
  assert.match(moduleInsight, /DeepSeek/);
  assert.match(moduleInsight, /核心判断/);
  assert.match(moduleInsight, /font-size:\s*21px/);
  for (const label of ["店铺下滑重点诊断", "店铺增长重点诊断", "款名下滑重点诊断", "款名增长重点诊断", "机会缺口", "库存标价金额", "上次库存"]) {
    assert.match(page, new RegExp(label));
  }
  for (const endpoint of [
    "/api/mabang/scheduled-tasks",
    "/api/notifications/dingtalk/configs",
    "/api/sales-assortment/ai-status",
    "/api/sales-assortment/analyze",
  ]) {
    assert.match(service, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(page, /return `\$\{number\.toFixed\(1\)\}%`/);
  assert.doesNotMatch(page, /Math\.abs\(number\) <= 1 \? number \* 100 : number/);
});

test("Vue Mabang publishing restores the complete online-management contract", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/MabangListingPage.vue");
  const service = read("frontend/commerce-ops-vue/src/services/listing.ts");
  const image = read("frontend/commerce-ops-vue/src/components/MarketplaceImage.vue");

  for (const label of [
    "AI 批量修改助手",
    "选择全部",
    "批量编辑",
    "SKU 变体明细",
    "原价",
    "促销价",
    "多仓库存",
    "规格",
    "确认并同步",
  ]) {
    assert.match(page, new RegExp(label));
  }
  for (const endpoint of [
    "/ai/status",
    "/ai/preview",
    "/batch/warehouse-options",
    "/batch/preview",
    "/batch/execute",
    "/jobs/",
  ]) {
    assert.match(service, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(page, /deepseek-v4-flash/);
  assert.match(page, /defaultPriceField/);
  assert.match(page, /platform === ['"]shopee['"] \? ['"]售价['"] : ['"]促销价['"]/);
  assert.match(page, /warehouse_stock/);
  assert.match(image, /\/api\/image\?url=/);
  assert.match(image, /IntersectionObserver/);
  assert.doesNotMatch(image, /:src="source"/);
});

test("Vue Mabang publishing restores the Lazada draft and publish workbench", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/MabangListingPage.vue");
  const workbench = read("frontend/commerce-ops-vue/src/components/MabangPublisherWorkbench.vue");
  const service = read("frontend/commerce-ops-vue/src/services/listing.ts");

  assert.match(page, /新建商品刊登/);
  for (const label of [
    "手动创建",
    "复制现有链接",
    "产品中心款式",
    "平台类目与属性",
    "SKU 变体",
    "保存到马帮",
    "人工确认",
    "提交刊登",
    "DeepSeek 商品资料助手",
  ]) {
    assert.match(workbench, new RegExp(label));
  }
  for (const endpoint of [
    "/publisher/drafts",
    "/publisher/categories",
    "/publisher/category-schema",
    "/publisher/ai/generate",
    "/api/product-center/product-models",
  ]) {
    assert.match(service, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
});
