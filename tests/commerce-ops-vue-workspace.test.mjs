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

test("Vue shell preserves production while building an isolated preview", () => {
  const viteConfig = read("frontend/commerce-ops-vue/vite.config.ts");
  const rootPackage = JSON.parse(read("package.json"));
  assert.match(viteConfig, /public\/vue-preview/);
  assert.match(viteConfig, /base:\s*["']\/vue-preview\//);
  assert.match(rootPackage.scripts["build:vue"], /commerce-ops-vue/);
  assert.match(rootPackage.scripts.build, /build:vue/);
  assert.match(read("server.mjs"), /decodedPath\.endsWith\(["']\/["']\)/);
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

test("Vue design system includes responsive and accessibility gates", () => {
  const styles = read("frontend/commerce-ops-vue/src/styles/global.css");
  const design = read("docs/design/COMMERCE-OPS-VUE-MIGRATION-DESIGN.md");
  assert.match(styles, /max-width:\s*430px/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /min-height:\s*42px/);
  assert.match(design, /375、768、1024 和 1440/);
  assert.match(design, /后端生成正式文件/);
});
