import { createRouter, createWebHashHistory } from "vue-router";

const routes = [
  { path: "/", redirect: "/overview" },
  {
    path: "/overview",
    name: "overview",
    component: () => import("@/pages/OperationsOverview.vue"),
    meta: { title: "运营总览", subtitle: "跨平台经营、货盘与履约状态集中查看。" },
  },
  {
    path: "/sales-assortment",
    name: "sales-assortment",
    component: () => import("@/pages/SalesAssortmentPage.vue"),
    meta: { title: "销售与货盘驾驶舱", subtitle: "按国家、类目、款名和店铺定位经营机会。" },
  },
  {
    path: "/products",
    name: "products",
    component: () => import("@/pages/ProductCenterPage.vue"),
    meta: { title: "产品中心", subtitle: "管理 SKU 主数据、图片覆盖、生命周期和人工维护记录。" },
  },
  {
    path: "/product-knowledge",
    name: "product-knowledge",
    component: () => import("@/pages/ProductKnowledgePage.vue"),
    meta: { title: "产品知识库", subtitle: "审核并发布跨客服、上架与运营复用的产品知识版本。" },
  },
  {
    path: "/profit",
    name: "profit",
    component: () => import("@/pages/ProfitPage.vue"),
    meta: { title: "利润分析", subtitle: "按国家、平台与店铺查看 Lazada / Shopee 标价收入、到账收入、成本和利润率。" },
  },
  {
    path: "/price-control",
    name: "price-control",
    component: () => import("@/pages/PriceControlPage.vue"),
    meta: { title: "控价变更", subtitle: "对比已审批控价，定位国家、类目、SKU 与平台价格变化。" },
  },
  {
    path: "/mabang-listing",
    name: "mabang-listing",
    component: () => import("@/pages/MabangListingPage.vue"),
    meta: { title: "商品刊登", subtitle: "连接马帮，管理跨平台刊登、店铺、SKU 变体和发布状态。" },
  },
  {
    path: "/advertising",
    name: "advertising",
    component: () => import("@/pages/AdvertisingPage.vue"),
    meta: { title: "广告分析", subtitle: "连接广告分析引擎并统一管理广告报表与分析结果。" },
  },
  {
    path: "/mabang",
    name: "mabang",
    component: () => import("@/pages/MabangPage.vue"),
    meta: { title: "马帮数据", subtitle: "管理即时采集、定时同步、执行记录和 SKU 图片任务。" },
  },
  {
    path: "/link-analysis",
    name: "link-analysis",
    component: () => import("@/pages/CompetitorAnalysisPage.vue"),
    props: { mode: "link" },
    meta: { title: "链接竞品", subtitle: "抓取并比较 Lazada、Shopee、TikTok Shop 商品链接。" },
  },
  {
    path: "/keyword-analysis",
    name: "keyword-analysis",
    component: () => import("@/pages/CompetitorAnalysisPage.vue"),
    props: { mode: "keyword" },
    meta: { title: "关键词竞品", subtitle: "发现目标市场关键词 TOP5 商品并生成运营洞察。" },
  },
  {
    path: "/growth-radar",
    name: "growth-radar",
    component: () => import("@/pages/GrowthRadarPage.vue"),
    meta: { title: "增长雷达", subtitle: "识别店铺异常、产品机会和可执行增长任务。" },
  },
  {
    path: "/platform-connections",
    name: "platform-connections",
    component: () => import("@/pages/PlatformConnectionsPage.vue"),
    meta: { title: "平台 API 接入", subtitle: "集中查看已接入平台 API、当前可调用的店铺与授权健康状态。" },
  },
  {
    path: "/audit",
    name: "audit",
    component: () => import("@/pages/AuditPage.vue"),
    meta: { title: "操作记录", subtitle: "追踪关键操作、接口状态、失败原因和关联任务。" },
  },
  {
    path: "/agent-monitoring",
    name: "agent-monitoring",
    component: () => import("@/pages/AgentMonitoringPage.vue"),
    meta: { title: "Agent 监控中心", subtitle: "查看 Agent 运行健康度、Tool 调用链、Token 与质量评估。" },
  },
  {
    path: "/fulfillment",
    name: "fulfillment",
    component: () => import("@/pages/FulfillmentPage.vue"),
    meta: { title: "履约中心", subtitle: "查看订单扫描、自动发货、异常恢复和店铺状态。" },
  },
  {
    path: "/sku-replacement",
    name: "sku-replacement",
    component: () => import("@/pages/SkuReplacementPage.vue"),
    meta: { title: "缺货 SKU 替换", subtitle: "检查订单缺货商品，复核同仓候选并安全执行批量替换。" },
  },
  {
    path: "/warehouse-transfer",
    name: "warehouse-transfer",
    component: () => import("@/pages/WarehouseTransferPage.vue"),
    meta: { title: "异常订单换仓", subtitle: "仅对异常订单按实时库存自动选仓，并安全执行批量换仓。" },
  },
  {
    path: "/customer-service",
    name: "customer-service",
    component: () => import("@/pages/CustomerServicePage.vue"),
    meta: { title: "客服中心", subtitle: "统一处理乐聊消息，结合业务上下文生成 AI 回复建议并由客服人工确认。" },
  },
  {
    path: "/:module",
    name: "module",
    component: () => import("@/pages/ModuleMigration.vue"),
  },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
