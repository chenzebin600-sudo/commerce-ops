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
    path: "/fulfillment",
    name: "fulfillment",
    component: () => import("@/pages/FulfillmentPage.vue"),
    meta: { title: "履约中心", subtitle: "查看订单扫描、自动发货、异常恢复和店铺状态。" },
  },
  {
    path: "/:module(products|link-analysis|keyword-analysis|growth-radar|advertising|mabang|mabang-listing|audit)",
    name: "module",
    component: () => import("@/pages/ModuleMigration.vue"),
  },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
