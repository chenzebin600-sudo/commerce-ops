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
    ["/price-control", "PriceControlPage.vue"],
    ["/products", "ProductCenterPage.vue"],
    ["/product-knowledge", "ProductKnowledgePage.vue"],
    ["/link-analysis", "CompetitorAnalysisPage.vue"],
    ["/keyword-analysis", "CompetitorAnalysisPage.vue"],
    ["/growth-radar", "GrowthRadarPage.vue"],
    ["/advertising", "AdvertisingPage.vue"],
    ["/mabang", "MabangPage.vue"],
    ["/mabang-listing", "MabangListingPage.vue"],
    ["/fulfillment", "FulfillmentPage.vue"],
    ["/agent-monitoring", "AgentMonitoringPage.vue"],
    ["/audit", "AuditPage.vue"],
  ];
  for (const [route, page] of expectedPages) {
    assert.match(sidebar, new RegExp(route.replace("/", "\\/")));
    assert.match(router, new RegExp(page.replace(".", "\\.")));
    assert.ok(fs.existsSync(path.join(vueRoot, "src", "pages", page)));
  }
  assert.doesNotMatch(router, /:module\(products|:module\(link-analysis|:module\(advertising/);

  const serviceSources = ["products.ts", "product-knowledge.ts", "price-control.ts", "competitor.ts", "growth.ts", "advertising.ts", "mabang.ts", "listing.ts", "audit.ts", "agent-observability.ts"]
    .map((file) => read(`frontend/commerce-ops-vue/src/services/${file}`)).join("\n");
  for (const api of ["/api/product-center/", "/api/product-knowledge/", "/api/price-control/", "/api/extract-and-analyze", "/api/growth-radar/v2/", "/api/ad-analyzer/status", "/api/mabang/", "/api/mabang-listing", "/api/audit/", "/api/ai/observability/"]) {
    assert.match(serviceSources, new RegExp(api.replaceAll("/", "\\/")));
  }
});

test("Vue Product Knowledge governance stays fail-closed and separates review from publication", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/ProductKnowledgePage.vue");
  const service = read("frontend/commerce-ops-vue/src/services/product-knowledge.ts");
  for (const label of ["候选审核台", "Release 发布记录", "审核人 ID", "发布人 ID", "人工发布", "合规审核角色"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /!status\.governance\.enabled/);
  assert.match(page, /expectedContentDigest/);
  assert.match(page, /acknowledgeHumanReview:\s*true/);
  assert.match(service, /x-user-id/);
  assert.match(service, /\/api\/product-knowledge\/candidates\/\$\{encodeURIComponent\(candidateId\)\}\/reviews/);
  assert.match(service, /\/api\/product-knowledge\/releases\/\$\{encodeURIComponent\(releaseId\)\}\/publish/);
  assert.doesNotMatch(page, /自动批准|一键批准全部/);
});

test("Vue Customer Service onboards local LiaoLiao accounts and never exposes automatic send", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/CustomerServicePage.vue");
  const service = read("frontend/commerce-ops-vue/src/services/customer-service.ts");
  const api = read("frontend/commerce-ops-vue/src/services/api.ts");
  for (const label of ["仅观察", "只生成建议", "生成并填入", "填入乐聊输入框", "采纳建议（不填入）", "拒绝建议", "保存修改"]) {
    assert.match(page, new RegExp(label));
  }
  for (const label of ["接入乐聊账号", "账号信息", "本机人工登录", "启动监控", "创建记录并打开乐聊", "等待你完成登录", "正在仅观察监控"]) {
    assert.match(page, new RegExp(label));
  }
  for (const state of ["IDLE", "STARTING", "WAITING_FOR_LOGIN", "SESSION_READY", "MONITOR_STARTING", "MONITORING", "STOPPING", "STOPPED", "FAILED"]) {
    assert.match(service, new RegExp(state));
  }
  assert.match(page, /接入后固定从.*仅观察.*开始/);
  assert.match(page, /三阶段放行进度/);
  assert.match(page, /必须按阶段逐级开启/);
  assert.match(page, /automationModeOptionDisabled/);
  assert.match(page, /共享知识库/);
  assert.match(page, /已发布 SUPPORT/);
  assert.match(page, /account\.rollout\?\.observedMessageTotal/);
  assert.match(page, /accountRolloutBlockers/);
  assert.match(page, /客服数据库尚未部署，账号接入暂未开放/);
  assert.match(page, /status\.value\?\.ready !== true/);
  assert.match(page, /accountCreationBlocked \|\| !accountForm\.displayName\.trim\(\)/);
  assert.match(page, /continueAccountConnection\(account\)/);
  assert.match(page, /role="status" aria-live="polite"/);
  assert.match(page, /role="alert"/);
  assert.match(service, /CustomerServiceAccountRollout/);
  assert.doesNotMatch(page, /accountForm\.automationMode/);
  assert.doesNotMatch(page, /type="password"/);
  assert.match(page, /acknowledgeRisk/);
  assert.match(page, /未通过自动回填门禁/);
  assert.match(page, /@click="reviewSuggestion\('ACCEPT', false\)"/);
  assert.match(page, /:disabled="!draftFillAvailable"/);
  assert.match(page, /replyAutomation\.draftFillEnabled === true/);
  assert.match(page, /settings\.automationMode === "DRAFT_FILL"/);
  assert.match(page, /本次不会填入乐聊输入框/);
  assert.match(page, /低于.*minimumAutoFillConfidence/);
  assert.match(page, /主控租约/);
  assert.match(page, /说明拒绝原因/);
  assert.match(page, /FACT_ERROR/);
  assert.match(page, /TONE_ADJUSTMENT/);
  assert.match(page, /质量分层/);
  assert.match(page, /qualityDimension/);
  assert.match(service, /accountLeases:\s*CustomerServiceAccountLease\[\]/);
  assert.match(service, /\/api\/customer-service\/quality-breakdown/);
  assert.match(service, /\/api\/customer-service\/accounts\/\$\{encodeURIComponent\(id\)\}\/automation/);
  assert.match(service, /\/api\/customer-service\/suggestions\/\$\{encodeURIComponent\(id\)\}\/review/);
  assert.match(service, /\/local-runtime/);
  assert.match(service, /"x-commerce-ops-local-action": "1"/);
  assert.match(service, /startCustomerServiceLocalRuntime/);
  assert.match(service, /stopCustomerServiceLocalRuntime/);
  assert.match(service, /retryCustomerServiceLocalRuntime/);
  assert.match(api, /readonly code: string \| null/);
  assert.match(api, /typeof payload\.code === "string"/);
  assert.doesNotMatch(page, />\s*发送\s*</);
  assert.doesNotMatch(service, /automaticSend:\s*true/);
});

test("Vue price control opens the latest change round and exposes copy and adjustment actions", () => {
  const source = read("frontend/commerce-ops-vue/src/pages/PriceControlPage.vue");
  assert.match(source, /const viewMode = ref<"current" \| "changes">\("changes"\)/);
  assert.match(source, /type="selection"/);
  assert.match(source, /复制选中（\{\{ selectedChanges\.length \}\}）/);
  assert.match(source, /copyChanges\(changes, '本页'\).*复制本页/);
  assert.match(source, /复制本轮全部信息/);
  assert.match(source, /本轮变化/);
  assert.match(source, /上轮变化/);
  assert.match(source, /selectQuickRound/);
  assert.match(source, /query\.sync_run_id/);
  assert.match(source, /涉及 SKU.*selectedRound\.affectedSkuCount/s);
  assert.match(source, /未调整.*已调整/s);
  assert.match(source, /updatePriceChangeAdjustment/);
  assert.match(source, /Foundation 任务证据与 Operation Audit/);
  assert.match(source, /受影响 SKU.*overview\.affectedSkuCount/s);
  assert.match(source, /prop="sku" label="SKU"/);
  assert.match(source, /scope\.row\.oldPrice.*scope\.row\.newPrice/s);
});

test("Vue Agent monitoring center uses the read-only Foundation 1.4 observability contract", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/AgentMonitoringPage.vue");
  const service = read("frontend/commerce-ops-vue/src/services/agent-observability.ts");
  const trend = read("frontend/commerce-ops-vue/src/components/AgentRunTrendChart.vue");
  const tools = read("frontend/commerce-ops-vue/src/components/AgentToolUsageChart.vue");

  for (const endpoint of ["/status", "/summary", "/runs"]) {
    assert.match(service, new RegExp(`/api/ai/observability${endpoint}`.replaceAll("/", "\\/")));
  }
  for (const label of ["运行总数", "成功率", "失败运行", "平均耗时", "Tool 调用", "Token 总量", "Agent 运行记录", "Tool 调用链", "质量评估"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /v-loading="loading"/);
  assert.match(page, /el-alert v-if="error"/);
  assert.match(page, /el-empty/);
  assert.match(page, /原始 Prompt、Context 和 Tool 载荷不会写入/);
  assert.match(trend, /BarChart, LineChart/);
  assert.match(tools, /Tool 调用分布|调用次数/);
  assert.doesNotMatch(service, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
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
  const overview = read("frontend/commerce-ops-vue/src/services/overview.ts");
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
  assert.match(page, /gmvTrendRange = ref<\[string, string\]>/);
  assert.match(page, /标准化估值时间趋势/);
  assert.match(page, /v-model="gmvTrendRange"/);
  assert.match(page, /@change="loadGmvTrend\(false\)"/);
  assert.match(page, /:comparison-rows="comparisonGmvTrend"/);
  assert.match(page, /repeat\(auto-fit,minmax\(min\(100%,158px\),1fr\)\)/);
  assert.match(page, /店铺影响明细/);
  assert.match(page, /type="expand"/);
  assert.match(overview, /storeImpacts: StyleStoreImpact\[\]/);
  assert.doesNotMatch(page, /monthly-trend-grid/);
  for (const seriesName of ["我方标准化估值", "货盘标准化估值", "currentSeriesLabel", "comparisonSeriesLabel"]) {
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
    "/api/sales-assortment/analysis",
    "/api/sales-assortment/analyze",
  ]) {
    assert.match(service, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(page, /loadSavedSalesAnalysis/);
  assert.doesNotMatch(page, /void analyze\(false\)/);
  assert.match(page, /@refresh="analyze\(true\)"/);
  assert.match(moduleInsight, /已保存分析，仅人工重新分析时更新/);
  assert.ok(moduleInsight.indexOf('v-else-if="analysis"') < moduleInsight.indexOf('v-else-if="!configured"'));
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

test("Vue product center supports selectable database fields while preserving image, detail and edit workflows", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/ProductCenterPage.vue");
  const service = read("frontend/commerce-ops-vue/src/services/products.ts");
  const thumbnail = read("frontend/commerce-ops-vue/src/components/ProductThumbnail.vue");

  assert.match(page, /选择主表展示字段/);
  assert.match(page, /数据库原始字段（62 个）/);
  assert.match(page, /field in selectedSourceTableFields/);
  assert.match(page, /sourceDatabaseValues/);
  assert.match(page, /label="图片" width="112" fixed[\s\S]*ProductThumbnail/);
  assert.match(page, /label="SKU \/ 商品" min-width="250" fixed/);
  assert.match(page, /label="图片"[\s\S]*label="SKU \/ 商品"[\s\S]*label="国家 \/ 主 SKU"[\s\S]*label="类目 \/ 规格"[\s\S]*label="状态"[\s\S]*label="数据状态"[\s\S]*label="更新"[\s\S]*label="操作"/);
  assert.match(page, /label="操作" width="250" fixed="right"/);
  assert.ok(
    page.indexOf('class="dashboard-panel product-table-panel"') < page.indexOf('class="dashboard-panel package-sync-panel"'),
    "SKU 主数据必须展示在产品包同步变化之前",
  );
  assert.match(page, /data-testid="product-detail-button"/);
  assert.match(page, /data-testid="product-edit-button"/);
  assert.match(page, /匹配马帮图片/);
  assert.match(page, /马帮图片管理/);
  assert.match(page, /@click="openDetail\(scope\.row\)"[\s\S]*@click="openEdit\(scope\.row\)"/);
  assert.match(page, /await updateProduct\(currentProduct\.value\.id, fields, clearOverrides\.value\)/);
  assert.match(service, /\/api\/product-center\/products\/table-preferences/);
  assert.match(service, /\/api\/mabang-images\/match-products/);
  assert.match(service, /\/api\/mabang-images\/products\/\$\{encodeURIComponent\(productId\)\}\/assets/);
  assert.match(service, /\/api\/mabang-images\/assets\/\$\{encodeURIComponent\(assetId\)\}\/content/);
  assert.match(thumbnail, /loadMabangAssetUrl/);
});
