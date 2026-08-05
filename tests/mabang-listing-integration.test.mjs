import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMabangListingServiceManager,
  mabangListingChildEnvironment,
  MABANG_LISTING_SERVICE_ID,
} from "../lib/mabang-listing-service-manager.mjs";
import {
  buildMabangListingTarget,
  createMabangListingProxy,
  MABANG_LISTING_INTERNAL_HEADER,
  resolveMabangListingProxyConfig,
} from "../lib/mabang-listing-proxy.mjs";
import { createMabangWpsAssistantManager } from "../lib/mabang-wps-assistant-manager.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const INTERNAL_TOKEN = "mabang-listing-test-token";
const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("main navigation groups SKU images under Mabang data and uses concise module names", async () => {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(APP_ROOT, "public", "index.html"), "utf8"),
    fs.readFile(path.join(APP_ROOT, "public", "app.js"), "utf8"),
  ]);
  assert.doesNotMatch(html, /data-page="mabang-images"/);
  assert.match(html, /data-mabang-view="images"[^>]*aria-controls="mabangImagesPanel"/);
  assert.match(html, /<span>马帮刊登<\/span>/);
  assert.match(html, /<span>广告分析<\/span>/);
  assert.match(html, /id="mabangImagesPanel"[^>]*role="tabpanel"/);
  assert.match(app, /mabangImagesPage\?\.load/);
  assert.match(app, /currentMabangView === "images"/);
});

test("Mabang publishing renders platform selection in the top command bar", async () => {
  const [dashboard, styles] = await Promise.all([
    fs.readFile(
      path.join(APP_ROOT, "frontend", "mabang-listing", "src", "ListingDashboard.tsx"),
      "utf8",
    ),
    fs.readFile(
      path.join(APP_ROOT, "frontend", "mabang-listing", "src", "styles.css"),
      "utf8",
    ),
  ]);
  assert.match(dashboard, /className="listing-commandbar"/);
  assert.match(dashboard, /className="platform-nav" role="tablist"/);
  assert.match(dashboard, /aria-selected=\{activePlatform === item\.key\}/);
  assert.doesNotMatch(dashboard, /<aside/);
  assert.match(styles, /\.listing-commandbar\s*\{/);
  assert.match(styles, /--brand:\s*#0f766e/);
});

test("Mabang publishing preserves platform snapshots and proxies marketplace images", async () => {
  const dashboard = await fs.readFile(
    path.join(APP_ROOT, "frontend", "mabang-listing", "src", "ListingDashboard.tsx"),
    "utf8",
  );

  assert.match(dashboard, /platformViewsRef/);
  assert.match(dashboard, /dynamicRequestIdRef/);
  assert.match(dashboard, /forceRefresh:\s*true/);
  assert.match(dashboard, /\/api\/image\?url=/);
  assert.match(dashboard, /IntersectionObserver/);
  assert.doesNotMatch(dashboard, /src=\{image\}/);
});

test("new listing workbench supports optional templates, product models and live category fields", async () => {
  const [workbench, dashboard, service, client, api] = await Promise.all([
    fs.readFile(path.join(APP_ROOT, "frontend", "mabang-listing", "src", "PublisherWorkbench.tsx"), "utf8"),
    fs.readFile(path.join(APP_ROOT, "frontend", "mabang-listing", "src", "ListingDashboard.tsx"), "utf8"),
    fs.readFile(path.join(APP_ROOT, "integrations", "mabang-getdata", "mabang_listing_service.py"), "utf8"),
    fs.readFile(path.join(APP_ROOT, "integrations", "mabang-getdata", "mabang_listing_client.py"), "utf8"),
    fs.readFile(path.join(APP_ROOT, "lib", "product-center", "product-center-api.mjs"), "utf8"),
  ]);

  assert.match(workbench, /复制现有链接/);
  assert.match(workbench, /产品中心款式/);
  assert.match(workbench, /使用整款/);
  assert.match(workbench, /publisher\/category-schema/);
  assert.match(workbench, /平台必填与类目属性/);
  assert.match(dashboard, /productApiFetch=\{productApiFetch\}/);
  assert.match(service, /\/api\/publisher\/categories/);
  assert.match(service, /\/api\/publisher\/category-schema/);
  assert.match(client, /\/kandeng\/api\/v2\/common\/task\/save/);
  assert.match(client, /\/kandeng\/api\/v2\/common\/task\/detail/);
  assert.match(api, /\/api\/product-center\/product-models/);
});

test("Shopee and Lazada stock edits expose warehouse-aware write contracts", async () => {
  const [dashboard, service, client] = await Promise.all([
    fs.readFile(
      path.join(APP_ROOT, "frontend", "mabang-listing", "src", "ListingDashboard.tsx"),
      "utf8",
    ),
    fs.readFile(
      path.join(APP_ROOT, "integrations", "mabang-getdata", "mabang_listing_service.py"),
      "utf8",
    ),
    fs.readFile(
      path.join(APP_ROOT, "integrations", "mabang-getdata", "mabang_listing_client.py"),
      "utf8",
    ),
  ]);

  assert.match(dashboard, /\/batch\/warehouse-options/);
  assert.match(dashboard, /aria-label="目标仓库"/);
  assert.match(dashboard, /!item\.warehouse_key/);
  assert.match(dashboard, /AI 库存仓库确认/);
  assert.match(dashboard, /setAIBatchTargetScope\(\{ targets \}\)/);
  assert.match(dashboard, /recommended_warehouse_key/);
  assert.match(dashboard, /dismissAIWarehouseConfirmation/);
  assert.match(dashboard, /warehouse_selection_required/);
  assert.match(service, /def _shopee_warehouse_detail_for_listing/);
  assert.match(service, /def _lazada_warehouse_detail_for_listing/);
  assert.match(service, /recommended_warehouse_key/);
  assert.match(service, /warehouse_selection_required/);
  assert.match(service, /client\.get_online_detail\("shopee", internal_id\)/);
  assert.match(service, /client\.get_shopee_warehouse_list\(shop_id\)/);
  assert.match(service, /_warehouse_name/);
  assert.match(service, /selected\["stock"\] = target_stock/);
  assert.match(client, /SHOPEE_SITE_PRODUCT_TYPE = 3/);
  assert.match(client, /product_type=SHOPEE_SITE_PRODUCT_TYPE/);
  assert.match(client, /\/shopee\/getWarehouseList/);
  assert.match(client, /\/lazada\/warehouse\/list/);
  assert.match(client, /\/lazada\/warehouse\/stock\/update/);
  assert.match(client, /prepare_lazada_warehouse_stock_payload/);
  assert.match(client, /str\(item\)\.startswith\("_warehouse_"\)/);
  assert.match(client, /\/public\/sync\/product/);
});

test("Shopee price and SKU rules follow the captured editor contract", async () => {
  const [dashboard, service, client] = await Promise.all([
    fs.readFile(
      path.join(APP_ROOT, "frontend", "mabang-listing", "src", "ListingDashboard.tsx"),
      "utf8",
    ),
    fs.readFile(
      path.join(APP_ROOT, "integrations", "mabang-getdata", "mabang_listing_service.py"),
      "utf8",
    ),
    fs.readFile(
      path.join(APP_ROOT, "integrations", "mabang-getdata", "mabang_listing_client.py"),
      "utf8",
    ),
  ]);

  assert.match(dashboard, /if \(field === "price"\) return "原价"/);
  assert.match(dashboard, /if \(field === "special_price"\) return "售价"/);
  assert.match(service, /"shopee": "original_price"/);
  assert.match(service, /variation\["price"\] = new_value/);
  assert.match(service, /platform != "shopee"/);
  assert.match(
    dashboard,
    /function defaultPriceFieldForPlatform\(platform: string\)/,
  );
  assert.match(
    dashboard,
    /platform === "shopee" \|\| platform === "lazada"/,
  );
  assert.match(dashboard, /appendOperation\(defaultPriceFieldForPlatform\(key\)\)/);
  assert.match(dashboard, /: "未获取"/);
  assert.match(service, /if platform == "shopee":\s+return/);
  assert.match(client, /price = _first_value\(raw, \("original_price",\)\)/);
  assert.match(client, /self\._enrich_shopee_listing_prices\(payload\)/);
  assert.match(client, /\("discount_price", "price", "sale_price", "special_price"\)/);
});

test("AI previews inherit the currently selected publishing platform", async () => {
  const [dashboard, service, aiService] = await Promise.all([
    fs.readFile(
      path.join(APP_ROOT, "frontend", "mabang-listing", "src", "ListingDashboard.tsx"),
      "utf8",
    ),
    fs.readFile(
      path.join(APP_ROOT, "integrations", "mabang-getdata", "mabang_listing_service.py"),
      "utf8",
    ),
    fs.readFile(
      path.join(APP_ROOT, "integrations", "mabang-getdata", "ai_service.py"),
      "utf8",
    ),
  ]);

  assert.match(dashboard, /active_platform:\s*activePlatform/);
  assert.match(dashboard, /function applyPreviewPricesToListingPage/);
  assert.match(dashboard, /synchronizePreviewPrices\(payload\.batch_preview\)/);
  assert.match(dashboard, /synchronizePreviewPrices\(payload\)/);
  assert.match(dashboard, /Shopee 的“价格修改”默认修改售价/);
  assert.match(dashboard, /Lazada 的“价格修改”默认修改促销价/);
  assert.match(service, /def _apply_ai_default_price_fields/);
  assert.match(service, /command\["action"\] = "promotion_update"/);
  assert.match(aiService, /Shopee 的“价格修改”“改价”/);
  assert.match(aiService, /Lazada 的“价格修改”“改价”/);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForPortToClose(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const closed = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Mabang listing child did not stop");
}

function request(method = "GET", headers = {}, body = []) {
  return Object.assign(Readable.from(body), { method, headers });
}

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = Buffer.alloc(0)) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test("Mabang listing runtime defaults stay inside Commerce Ops", () => {
  const appRoot = path.join(os.tmpdir(), "commerce-mabang-listing-fixture");
  const config = resolveRuntimeConfig({ bootstrapRoot: appRoot, env: {} });
  assert.equal(
    config.mabangListingServiceDir,
    path.join(appRoot, "integrations", "mabang-getdata"),
  );
  assert.equal(
    config.mabangListingStorageRoot,
    path.join(appRoot, "storage", "integrations", "mabang-listing"),
  );
  assert.equal(config.mabangListingPort, 8877);
  assert.equal(config.mabangListingServiceMode, "managed");
});

test("Mabang listing proxy only accepts loopback targets", () => {
  assert.deepEqual(resolveMabangListingProxyConfig({}), {
    host: "127.0.0.1",
    port: 8877,
    baseUrl: "http://127.0.0.1:8877",
  });
  assert.throws(
    () => resolveMabangListingProxyConfig({
      MABANG_LISTING_BASE_URL: "http://192.168.1.50:8877",
    }),
    /loopback/,
  );
});

test("Mabang listing API paths map to the fixed local service", () => {
  const target = buildMabangListingTarget(
    "http://127.0.0.1:8877",
    new URL(
      "http://office-host:3101/api/mabang-listing/listings?platform=lazada",
    ),
  );
  assert.equal(target.origin, "http://127.0.0.1:8877");
  assert.equal(target.pathname, "/api/listings");
  assert.equal(target.searchParams.get("platform"), "lazada");
});

test("Mabang listing proxy replaces browser credentials with internal auth", async () => {
  let captured;
  const proxy = createMabangListingProxy({
    baseUrl: "http://127.0.0.1:8877",
    internalToken: INTERNAL_TOKEN,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const req = request(
    "POST",
    {
      authorization: "Bearer browser-session",
      "content-type": "application/json",
    },
    [Buffer.from('{"preview_token":"preview"}')],
  );
  const res = responseRecorder();

  await proxy(
    req,
    res,
    new URL("http://office-host:3101/api/mabang-listing/batch/execute"),
  );

  assert.equal(captured.url.href, "http://127.0.0.1:8877/api/batch/execute");
  assert.equal(captured.init.headers.get("authorization"), null);
  assert.equal(
    captured.init.headers.get(MABANG_LISTING_INTERNAL_HEADER),
    INTERNAL_TOKEN,
  );
  assert.equal(res.status, 200);
});

test("Mabang listing child gets isolated storage and no formal database path", () => {
  const childEnv = mabangListingChildEnvironment({
    env: {
      APP_ROOT: "main",
      STORAGE_ROOT: "main-storage",
      DATABASE_PATH: "formal.sqlite",
      SAFE_VALUE: "kept",
    },
    serviceDir: "integration",
    storageRoot: "integration-storage",
    host: "127.0.0.1",
    port: 8877,
    internalToken: INTERNAL_TOKEN,
    aiGatewayUrl: "http://127.0.0.1:3101/api/internal/ai/mabang-listing/complete",
  });
  assert.equal(childEnv.APP_ROOT, undefined);
  assert.equal(childEnv.DATABASE_PATH, undefined);
  assert.equal(childEnv.MABANG_LISTING_STORAGE_ROOT, "integration-storage");
  assert.equal(childEnv.MABANG_LISTING_INTERNAL_TOKEN, INTERNAL_TOKEN);
  assert.equal(childEnv.COMMERCE_OPS_AI_GATEWAY_TOKEN, INTERNAL_TOKEN);
  assert.equal(
    childEnv.COMMERCE_OPS_AI_GATEWAY_URL,
    "http://127.0.0.1:3101/api/internal/ai/mabang-listing/complete",
  );
  assert.equal(childEnv.SAFE_VALUE, "kept");
});

test("managed Mabang listing service starts and stops a verified child", async () => {
  let probes = 0;
  const child = fakeChild();
  const manager = createMabangListingServiceManager({
    mode: "managed",
    serviceDir: "integration",
    storageRoot: "integration-storage",
    baseUrl: "http://127.0.0.1:8877",
    host: "127.0.0.1",
    port: 8877,
    internalToken: INTERNAL_TOKEN,
    pythonExecutable: "python",
    existsSyncImpl: () => true,
    spawnImpl: () => child,
    fetchImpl: async () => {
      probes += 1;
      if (probes === 1) throw new Error("offline");
      return new Response(JSON.stringify({
        success: true,
        service: MABANG_LISTING_SERVICE_ID,
        commerce_ops_proxy: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    attempts: 1,
    wait: async () => {},
  });

  assert.equal((await manager.ensure()).ok, true);
  assert.equal(manager.ownsChild(), true);
  await manager.stop();
  assert.equal(child.killed, true);
});

test("WPS assistant preserves one visible managed desktop process", async () => {
  const child = fakeChild();
  let spawnCount = 0;
  const manager = createMabangWpsAssistantManager({
    serviceDir: "integration",
    pythonExecutable: "python",
    existsSyncImpl: () => true,
    spawnImpl: (_executable, _args, options) => {
      spawnCount += 1;
      assert.equal(options.windowsHide, false);
      return child;
    },
  });

  assert.deepEqual(manager.status(), { available: true, running: false });
  assert.equal(manager.launch().started, true);
  assert.equal(manager.launch().started, false);
  assert.equal(spawnCount, 1);
  await manager.stop();
  assert.equal(child.killed, true);
});

test("Mabang listing proxy enforces method and body limits", async () => {
  let forwarded = false;
  const proxy = createMabangListingProxy({
    baseUrl: "http://127.0.0.1:8877",
    internalToken: INTERNAL_TOKEN,
    requestLimitBytes: 4,
    fetchImpl: async () => {
      forwarded = true;
      return new Response("ok");
    },
  });

  const oversized = responseRecorder();
  await proxy(
    request("POST", { "content-length": "5" }, [Buffer.from("12345")]),
    oversized,
    new URL("http://host/api/mabang-listing/batch/preview"),
  );
  assert.equal(oversized.status, 413);
  assert.equal(forwarded, false);

  const invalidMethod = responseRecorder();
  await proxy(
    request("PATCH"),
    invalidMethod,
    new URL("http://host/api/mabang-listing/listings"),
  );
  assert.equal(invalidMethod.status, 405);
});

test("managed integration starts the real Python service with isolated storage", { timeout: 20_000 }, async () => {
  const python = resolvePythonRuntime({
    appRoot: APP_ROOT,
    requiredModules: ["requests"],
  });
  assert.equal(python.ok, true, python.errorCode);

  const port = await freePort();
  const storageRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "commerce-mabang-listing-"),
  );
  const serviceDir = path.join(APP_ROOT, "integrations", "mabang-getdata");
  const manager = createMabangListingServiceManager({
    mode: "managed",
    serviceDir,
    storageRoot,
    baseUrl: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    internalToken: INTERNAL_TOKEN,
    pythonExecutable: python.executable,
    attempts: 30,
    intervalMs: 100,
  });

  try {
    const started = await manager.ensure();
    assert.equal(started.ok, true, started.error);
    assert.equal(started.started, true);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { [MABANG_LISTING_INTERNAL_HEADER]: INTERNAL_TOKEN },
    }).then((response) => response.json());
    assert.equal(health.service, MABANG_LISTING_SERVICE_ID);
    assert.equal(health.commerce_ops_proxy, true);
    assert.equal("local_token" in health, false);
    assert.equal(health.publisher.status, "ok");
    await fs.access(path.join(storageRoot, "publisher.db"));

    const platforms = await fetch(`http://127.0.0.1:${port}/api/platforms`, {
      headers: { [MABANG_LISTING_INTERNAL_HEADER]: INTERNAL_TOKEN },
    }).then((response) => response.json());
    assert.equal(platforms.success, true);
    assert.deepEqual(
      platforms.platforms.map((platform) => platform.key),
      ["lazada", "shopee", "tiktokshop"],
    );
  } finally {
    await manager.stop();
    await waitForPortToClose(port);
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
});
