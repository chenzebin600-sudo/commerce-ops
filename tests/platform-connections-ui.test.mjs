import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8");

test("Vue exposes a real Platform API connections navigation destination", () => {
  const router = read("frontend/commerce-ops-vue/src/router/index.ts");
  const sidebar = read("frontend/commerce-ops-vue/src/components/OpsSidebar.vue");
  assert.match(router, /path:\s*["']\/platform-connections["']/);
  assert.match(router, /PlatformConnectionsPage\.vue/);
  assert.match(sidebar, /\/platform-connections/);
  assert.match(sidebar, /平台 API 接入/);
});

test("Platform connections page uses only the Commerce API Gateway control plane", () => {
  const service = read("frontend/commerce-ops-vue/src/services/platform-connections.ts");
  const page = read("frontend/commerce-ops-vue/src/pages/PlatformConnectionsPage.vue");
  for (const endpoint of ["/api/platform/status", "/api/platforms", "/api/platform/shops", "/api/platform/shops/sync"]) {
    assert.match(service, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(service, /method:\s*["']POST["']/);
  assert.doesNotMatch(service, /accessToken|refreshToken|appSecret/);
  assert.doesNotMatch(page, /authorization\?\.(?:accessToken|refreshToken)|metadata\?\.appSecret/);
  assert.match(service, /connectorRegistered/);
  assert.match(page, /authorizationStatus === "AUTHORIZED"/);
  assert.match(page, /scope\.row\.callable/);
});

test("Platform connections page uses the Platform API shop catalog and responsive controls", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/PlatformConnectionsPage.vue");
  for (const label of [
    "API 店铺",
    "当前可调用",
    "国家 / 地区",
    "同步 API 店铺投影",
    "Seller ID / 短码",
    "授权状态",
    "刷新实时状态",
  ]) {
    assert.match(page, new RegExp(label.replaceAll("/", "\\/")));
  }
  assert.match(page, /role="alert"/);
  assert.match(page, /PLATFORM API SHOP AUTHORITY/);
  assert.match(page, /siteDefaultCurrency/);
  assert.match(page, /min-height:\s*44px/);
  assert.doesNotMatch(page, /人工新增店铺|create-shop-form|createPlatformShop/);
  assert.doesNotMatch(page, /Math\.random|mock|fixture/i);
});
