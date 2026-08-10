import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { createMabangWorkerRunner } from "../lib/mabang-worker-runner.mjs";
import { createMabangListingServiceManager } from "../lib/mabang-listing-service-manager.mjs";
import { resolveMabangListingInternalToken } from "../lib/mabang-listing-token.mjs";
import { resolveMabangListingProxyConfig } from "../lib/mabang-listing-proxy.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { MabangListingInternalClient } from "../lib/inventory-sync/mabang-listing-client.mjs";
import { createLazadaRunStatusWriter } from "../lib/inventory-sync/lazada-run-monitor.mjs";
import {
  buildLazadaInventoryPlan,
  executeLazadaInventoryPlan,
  normalizeLazadaSyncName,
  resolveLazadaShopMappings,
} from "../lib/inventory-sync/lazada-inventory-sync-runner.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXECUTION_CONFIRMATION = "CONFIRM_LAZADA_INVENTORY_SYNC";
let runStatus = null;

function parseArgs(argv) {
  const result = { execute: false, allowUnconfiguredShops: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") result.execute = true;
    else if (argument === "--allow-unconfigured-shops") result.allowUnconfiguredShops = true;
    else if (argument.startsWith("--confirm=")) result.confirm = argument.slice("--confirm=".length);
    else if (argument.startsWith("--config=")) result.config = argument.slice("--config=".length);
    else if (argument.startsWith("--report=")) result.report = argument.slice("--report=".length);
    else if (argument.startsWith("--safety-stock=")) result.safetyStock = Number(argument.slice("--safety-stock=".length));
    else if (argument.startsWith("--account-host=")) result.accountHost = argument.slice("--account-host=".length);
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return result;
}

function usage() {
  return [
    "Lazada 库存同步脚本（默认仅预览，不写入）",
    "",
    "预览：npm run sync:lazada-inventory",
    `执行：npm run sync:lazada-inventory -- --execute --confirm=${EXECUTION_CONFIRMATION}`,
    "",
    "可选参数：",
    "  --config=<配置 JSON 路径>",
    "  --report=<报告 JSON 路径>",
    "  --safety-stock=50",
    "  --account-host=<马帮私有域名>",
    "  --allow-unconfigured-shops",
  ].join("\n");
}

function requiredCredential(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

async function readConfig(configPath) {
  const payload = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (String(payload.platform || "").toLowerCase() !== "lazada") throw new Error("同步配置 platform 必须为 lazada。 ");
  if (!Array.isArray(payload.shops) || !payload.shops.length) throw new Error("同步配置没有店铺映射。 ");
  return payload;
}

function reportPath(runtimeConfig, configuredPath) {
  if (configuredPath) return path.resolve(rootDir, configuredPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(runtimeConfig.storageRoot, "inventory-sync", "lazada-reports", `${stamp}.json`);
}

async function writeReport(target, report) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function progress(update) {
  if (update.stage === "PREVIEW") {
    console.log(`正在预检第 ${update.batch}/${update.batchCount} 批，共 ${update.itemCount} 个变体。`);
  } else if (update.stage === "PROCESSING") {
    const job = update.job || {};
    console.log(`第 ${update.batch}/${update.batchCount} 批：${job.processed_products || 0}/${job.total_products || 0}。`);
  }
}

async function loginWhenListingServiceIsIdle(listingClient, credentials, { timeoutMs = 2 * 60 * 60_000, intervalMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let waits = 0;
  while (true) {
    try {
      return await listingClient.login(credentials);
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!message.includes("批量同步正在执行") || Date.now() >= deadline) throw error;
      waits += 1;
      console.log(`Shopee 写任务仍在执行，等待全局锁释放（已等待约 ${waits * intervalMs / 1000} 秒）。`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  loadLocalEnv(rootDir);
  const runtimeEnv = { ...process.env };
  const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: runtimeEnv });
  const configPath = path.resolve(rootDir, args.config || "config/lazada-inventory-sync-shops.json");
  const config = await readConfig(configPath);
  const safetyStock = args.safetyStock === undefined ? Number(config.safetyStock ?? 50) : args.safetyStock;
  if (!Number.isInteger(safetyStock) || safetyStock < 0) throw new Error("安全库存必须是大于或等于 0 的整数。 ");
  if (args.execute && args.confirm !== EXECUTION_CONFIRMATION) {
    throw new Error(`执行写入必须提供 --confirm=${EXECUTION_CONFIRMATION}`);
  }

  const username = requiredCredential(process.env.LAZADA_INVENTORY_MABANG_USERNAME, process.env.FULFILLMENT_MABANG_USERNAME);
  const password = requiredCredential(process.env.LAZADA_INVENTORY_MABANG_PASSWORD, process.env.FULFILLMENT_MABANG_PASSWORD);
  if (!username || !password) {
    throw new Error("缺少马帮账号。请配置 LAZADA_INVENTORY_MABANG_USERNAME 和 LAZADA_INVENTORY_MABANG_PASSWORD。 ");
  }

  const proxy = resolveMabangListingProxyConfig(runtimeEnv);
  const internalToken = await resolveMabangListingInternalToken({
    configuredToken: process.env.MABANG_LISTING_INTERNAL_TOKEN,
    tokenFile: runtimeConfig.mabangListingTokenFile,
  });
  const python = resolvePythonRuntime({
    appRoot: runtimeConfig.appRoot,
    env: { ...runtimeEnv, PYTHON_EXECUTABLE: runtimeConfig.pythonExecutable, PYTHON_VENV_DIR: runtimeConfig.pythonVenvDir },
    requiredModules: ["requests"],
  });
  const manager = createMabangListingServiceManager({
    mode: runtimeConfig.mabangListingServiceMode,
    serviceDir: runtimeConfig.mabangListingServiceDir,
    storageRoot: runtimeConfig.mabangListingStorageRoot,
    baseUrl: proxy.baseUrl,
    host: proxy.host,
    port: proxy.port,
    internalToken,
    pythonExecutable: python.ok ? python.executable : null,
    env: runtimeEnv,
  });
  const runWorker = createMabangWorkerRunner({
    rootDir: runtimeConfig.appRoot,
    exportRoot: runtimeConfig.tempRoot,
    runtimeConfig,
    env: runtimeEnv,
  });
  const listingClient = new MabangListingInternalClient({ baseUrl: proxy.baseUrl, internalToken });
  const targetReportPath = reportPath(runtimeConfig, args.report);
  runStatus = createLazadaRunStatusWriter({ storageRoot: runtimeConfig.storageRoot, mode: args.execute ? "execute" : "preview" });
  runStatus.update({ reportPath: targetReportPath, message: "正在启动马帮刊登服务。", stage: "SERVICE_STARTING" });

  try {
    await Promise.all([
      fs.mkdir(runtimeConfig.tempRoot, { recursive: true }),
      fs.mkdir(runtimeConfig.mabangListingStorageRoot, { recursive: true }),
    ]);
    const service = await manager.ensure();
    if (!service.ok) throw new Error(service.error || service.errorCode || "马帮刊登服务不可用。 ");
    runStatus.update({ stage: "LOGGING_IN", message: "刊登服务已就绪，正在登录马帮。" });
    await loginWhenListingServiceIsIdle(listingClient, {
      username,
      password,
      accountHost: args.accountHost || process.env.LAZADA_INVENTORY_MABANG_ACCOUNT_HOST || "900445.private.mabangerp.com",
    });

    const configuredWarehouseNames = [...new Set(config.shops.flatMap((shop) => shop.warehouseNames || []).map(String).map((value) => value.trim()).filter(Boolean))];
    console.log(`正在读取 ${config.shops.length} 家 Lazada 店铺和 ${configuredWarehouseNames.length} 个来源仓库。`);
    runStatus.update({
      stage: "READING_SOURCE_INVENTORY",
      message: `正在读取 ${config.shops.length} 家 Lazada 店铺和 ${configuredWarehouseNames.length} 个来源仓库。`,
      counts: { shops: config.shops.length, warehouses: configuredWarehouseNames.length },
    });
    const [visibleShops, inventory] = await Promise.all([
      listingClient.lazadaShops(),
      runWorker({ action: "inventory", compact: true, warehouseNames: configuredWarehouseNames, username, password }),
    ]);
    runStatus.update({ stage: "VALIDATING_MAPPINGS", message: "来源库存读取完成，正在校验店铺和仓库映射。", counts: { inventoryRows: Number(inventory.records?.length || 0) } });
    const resolved = resolveLazadaShopMappings(config.shops, visibleShops, inventory.warehouseCatalog?.options || []);
    if (resolved.errors.length) {
      throw Object.assign(new Error(`店铺或仓库映射校验失败，共 ${resolved.errors.length} 项。`), { details: resolved.errors });
    }
    const configuredIds = new Set(resolved.mappings.map((mapping) => mapping.shopId));
    const unconfiguredShops = visibleShops.filter((shop) => !configuredIds.has(String(shop.id ?? shop.shop_id ?? "").trim()));
    if (unconfiguredShops.length && !args.allowUnconfiguredShops) {
      throw Object.assign(new Error(`当前账号还有 ${unconfiguredShops.length} 家 Lazada 店铺未配置仓库，已停止。`), {
        details: unconfiguredShops.map((shop) => ({ id: shop.id, name: shop.name })),
      });
    }

    runStatus.update({ stage: "READING_LISTINGS", message: "映射校验通过，正在读取 Lazada 在线商品。" });
    const listings = await listingClient.lazadaListings(resolved.mappings.map((mapping) => mapping.shopId), {
      refresh: true,
      onProgress: (current) => {
        const message = `在线商品 ${current.fetched || 0}/${current.total || 0}，第 ${current.page || 0}/${current.pageCount || 0} 页。`;
        console.log(message);
        runStatus.update({ stage: "READING_LISTINGS", message, counts: { listingsFetched: Number(current.fetched || 0), listingsTotal: Number(current.total || 0), listingPage: Number(current.page || 0), listingPageCount: Number(current.pageCount || 0) } });
      },
    });
    let inventoryForPlan = inventory;
    if (args.execute) {
      console.log("执行模式：正在重新读取一次来源库存，使用最新库存生成最终写入计划。 ");
      runStatus.update({ stage: "REFRESHING_SOURCE_INVENTORY", message: "执行前正在重新读取来源库存，确保使用最新数量。" });
      inventoryForPlan = await runWorker({ action: "inventory", compact: true, warehouseNames: configuredWarehouseNames, username, password });
    }
    runStatus.update({ stage: "BUILDING_PLAN", message: "正在匹配在线商品与来源 SKU，并生成最终写入计划。" });
    const plan = buildLazadaInventoryPlan({
      mappings: resolved.mappings,
      listings,
      inventoryRecords: inventoryForPlan.records || [],
      safetyStock,
      multiWarehouseMode: config.multiWarehouseMode || "block",
    });
    const report = {
      mode: args.execute ? "execute" : "preview",
      configPath,
      inventoryCapturedAt: new Date().toISOString(),
      inventorySourceMode: inventoryForPlan.summary?.sourceMode || "",
      unconfiguredShops: unconfiguredShops.map((shop) => ({ id: shop.id, name: shop.name })),
      plan,
      execution: null,
    };
    await writeReport(targetReportPath, report);
    runStatus.update({
      stage: "BUILDING_PLAN",
      message: `计划完成：待更新 ${plan.summary.readyCount}，无需更新 ${plan.summary.unchangedCount}，阻断 ${plan.summary.blockedCount}。`,
      counts: { variants: plan.summary.variantCount, ready: plan.summary.readyCount, unchanged: plan.summary.unchangedCount, blocked: plan.summary.blockedCount },
    });
    console.log(`计划完成：${plan.summary.shopCount} 家店，${plan.summary.variantCount} 个变体，待更新 ${plan.summary.readyCount}，无需更新 ${plan.summary.unchangedCount}，阻断 ${plan.summary.blockedCount}。`);
    console.log(`报告：${targetReportPath}`);
    if (!args.execute) {
      console.log(`当前为预览模式；确认报告后再使用 --execute --confirm=${EXECUTION_CONFIRMATION}。`);
      runStatus.succeed({ message: "Lazada 库存同步预览已完成，没有执行写入。" });
      return;
    }
    if (!plan.summary.readyCount) {
      console.log("没有需要写入的 Lazada 库存变更。 ");
      runStatus.noChanges();
      return;
    }
    runStatus.update({ stage: "EXECUTING", message: `开始写入 ${plan.summary.readyCount} 个库存变更。` });
    report.execution = await executeLazadaInventoryPlan({ plan, listingClient, onProgress: (update) => {
      progress(update);
      const job = update.job || {};
      runStatus.update({
        stage: "EXECUTING",
        message: update.stage === "PREVIEW" ? `正在预检第 ${update.batch}/${update.batchCount} 批。` : `正在处理第 ${update.batch}/${update.batchCount} 批。`,
        counts: { batch: Number(update.batch || 0), batchCount: Number(update.batchCount || 0), processed: Number(job.processed_products || 0), total: Number(job.total_products || 0) },
      });
    } });
    report.finishedAt = new Date().toISOString();
    await writeReport(targetReportPath, report);
    const batchCount = Number(report.execution.plannedBatchCount || 0);
    const failureCount = Number(report.execution.failureCount || report.execution.failedProducts || 0);
    const successfulProducts = Number(report.execution.successfulProducts || 0);
    const resultCounts = { batch: batchCount, batchCount, successfulProducts, failedProducts: failureCount };
    if (failureCount && !successfulProducts) {
      throw Object.assign(new Error(`${failureCount} 个商品全部同步失败；首个原因：${report.execution.failures?.[0]?.message || "未知错误"}`), {
        code: "LAZADA_INVENTORY_ALL_PRODUCTS_FAILED", details: (report.execution.failures || []).slice(0, 100),
      });
    }
    if (failureCount) {
      const partialError = Object.assign(new Error(`库存同步部分完成：成功 ${successfulProducts} 个商品，失败 ${failureCount} 个。`), {
        code: "LAZADA_INVENTORY_PARTIAL_FAILURE", details: (report.execution.failures || []).slice(0, 100),
      });
      console.warn(partialError.message);
      runStatus.partial(partialError, { counts: resultCounts });
      return;
    }
    console.log(`Lazada 库存同步完成，共 ${batchCount} 批。`);
    runStatus.succeed({ message: `Lazada 库存同步完成，共 ${batchCount} 批。`, counts: resultCounts });
  } catch (error) {
    if (error?.details) console.error(JSON.stringify(error.details, null, 2));
    throw error;
  } finally {
    await manager.stop();
  }
}

main().catch((error) => {
  runStatus?.fail(error);
  console.error(`Lazada 库存同步失败：${error.message || error}`);
  process.exitCode = 1;
});
