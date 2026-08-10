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
    path: "/mabang-listing",
    name: "mabang-listing",
    component: () => import("@/pages/MabangListingPage.vue"),
    meta: { title: "商品刊登", subtitle: "连接马帮，管理跨平台刊登、店铺、SKU 变体和发布状态。" },
  },
  {
    path: "/inventory-sync",
    name: "inventory-sync",
    component: () => import("@/pages/InventorySyncPage.vue"),
    meta: { title: "库存同步", subtitle: "读取马帮仓库库存，预览并安全同步 Shopee / Lazada 在线库存。" },
  },
  {
    path: "/shopee-api",
    name: "shopee-api",
    component: () => import("@/pages/ShopeeApiConsolePage.vue"),
    meta: { title: "Shopee API 控制台", subtitle: "选择店铺和接口，安全执行单店或批量 Shopee V2 请求。" },
  },
  {
    path: "/returns-collection",
    name: "returns-collection",
    component: () => import("@/pages/ReturnsCollectionPage.vue"),
    meta: { title: "售后数据采集", subtitle: "监控多店铺退货退款数据的覆盖、延迟、任务与补漏状态。" },
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
    path: "/shop-health",
    name: "shop-health",
    component: () => import("@/pages/ShopHealthPage.vue"),
    meta: { title: "店铺健康", subtitle: "每日监控 Shopee 店铺表现、扣分、处罚与人工申诉进度。" },
  },
  {
    path: "/audit",
    name: "audit",
    component: () => import("@/pages/AuditPage.vue"),
    meta: { title: "操作记录", subtitle: "追踪关键操作、接口状态、失败原因和关联任务。" },
  },
  {
    path: "/fulfillment",
    name: "fulfillment",
    component: () => import("@/pages/FulfillmentPage.vue"),
    meta: { title: "自动发货", subtitle: "查看待处理订单、发货记录和店铺自动发货设置。" },
  },
  {
    path: "/warehouse-transfer",
    name: "warehouse-transfer",
    component: () => import("@/pages/WarehouseTransferPage.vue"),
    meta: { title: "缺货处理", subtitle: "优先换仓；无法换仓时推荐同款换色或更小规格 SKU。" },
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
