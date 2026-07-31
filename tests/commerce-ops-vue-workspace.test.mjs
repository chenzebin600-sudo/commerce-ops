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
  const service = read("frontend/commerce-ops-vue/src/services/sales-automation.ts");
  for (const label of ["自动采集与智能分析", "订单定时", "库存定时", "钉钉机器人", "DeepSeek 经营分析"]) {
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
  assert.match(page, /Math\.abs\(number\) <= 1 \? number \* 100 : number/);
});
