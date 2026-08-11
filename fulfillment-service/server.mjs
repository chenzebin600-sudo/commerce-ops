import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { isShopAutoFulfillAuthorized, resolveFulfillmentConfig } from "./config.mjs";
import { FulfillmentRepository } from "./repository.mjs";
import { FulfillmentError, FulfillmentService } from "./service.mjs";
import { createDisabledFulfillmentExecutor, createMabangFulfillmentCatalogSource, createMabangFulfillmentExecutor, createMabangFulfillmentPreflight, createMabangFulfillmentScanSource, createMabangFulfillmentSource, createMabangMessageReviewRecovery, createMabangPolicySuggestionSource, createMabangTrackingRecoveryAdapter, planFulfillmentPolicySuggestionConfirmations } from "./mabang-source.mjs";
import { createApiDocsHtml, createOpenApiDocument } from "./api-docs.mjs";
import { FulfillmentPreviewScheduler } from "./scheduler.mjs";
import { createWindowsNotifier } from "./notifier.mjs";
import { AiGateway } from "../lib/ai/ai-gateway.mjs";
import { DeepSeekProvider, resolveDeepSeekEndpoint } from "../lib/ai/providers/deepseek-provider.mjs";
import { FulfillmentAgent } from "./agent.mjs";
import { FulfillmentAgentTools } from "./agent-tools.mjs";
import { decryptSecret, maskUsername } from "../lib/mabang-scheduler/crypto.mjs";
import { FULFILLMENT_ACTOR_ASSERTION_HEADER, verifyFulfillmentActorAssertion } from "../lib/security/fulfillment-actor-assertion.mjs";
import { FulfillmentV2PostgresqlProvider } from "./v2/postgresql-provider.mjs";
import { FulfillmentV2Repository } from "./v2/repository.mjs";
import { buildFulfillmentPolicyImportPreview, parseFulfillmentPolicyWorkbook } from "./policy-import.mjs";
import { authorizationSettingsForIdentity, authorizedShopIdsForIdentity,
  fulfillmentAccountIdentityKey } from "./account-authorization.mjs";
import { WarehouseTransferService } from "./warehouse-transfer.mjs";
import { SkuReplacementService } from "./sku-replacement.mjs";
import { SkuReplacementBatchService } from "./sku-replacement-batch.mjs";
import { PreviewTaskStore } from "./preview-task-store.mjs";
import { OperationDrainController } from "../lib/operation-drain.mjs";
import { presentFulfillmentError } from "./http-error.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const config = resolveFulfillmentConfig({ rootDir });
const repository = new FulfillmentRepository(config.databasePath);
const fulfillmentV2Provider = config.fulfillmentV2Enabled
  ? new FulfillmentV2PostgresqlProvider({ connectionString: config.fulfillmentV2DatabaseUrl })
  : null;
const fulfillmentV2Repository = fulfillmentV2Provider ? new FulfillmentV2Repository({ provider: fulfillmentV2Provider }) : null;
const fulfillmentV2Status = fulfillmentV2Provider
  ? await fulfillmentV2Provider.readiness()
  : Object.freeze({ ready: false, schemaVersion: null });
repository.initializeOperationalConfig(config.shops);
const recoveredBatches = repository.recoverInterruptedBatches(new Date().toISOString());
if (recoveredBatches.length) console.warn(`Recovered ${recoveredBatches.length} interrupted fulfillment batch(es) as needs_attention.`);
const recoveredDispatches = repository.recoverInterruptedDispatches(new Date().toISOString());
if (recoveredDispatches) console.warn(`Recovered ${recoveredDispatches} interrupted fulfillment dispatch(es) as failed.`);
const quarantinedInventoryOrders = repository.quarantineFailedOrders("INVENTORY_UNKNOWN_BEFORE_SUBMIT", new Date().toISOString());
if (quarantinedInventoryOrders) console.warn(`Moved ${quarantinedInventoryOrders} inventory-unknown order(s) to needs_attention.`);
const migratedTrackingRecoveries = repository.migratePendingTrackingRecoveries({ nowIso: new Date().toISOString(),
  checkSeconds: config.trackingRecoveryCheckSeconds, deadlineHours: config.trackingRecoveryDeadlineHours });
if (migratedTrackingRecoveries) console.warn(`Migrated ${migratedTrackingRecoveries} pending tracking order(s) to recovery queue.`);
const notifier = createWindowsNotifier({ enabled: config.windowsNotificationsEnabled });
const shopConfigs = config.shops.map((shop) => ({ ...config, ...shop }));
const staticAutoFulfillAuthorizedShopIds = new Set((config.autoFulfillShopIds || [])
  .filter((shopId) => isShopAutoFulfillAuthorized(config, shopId)));
let autoFulfillAuthorizedShopIds = new Set(staticAutoFulfillAuthorizedShopIds);
const platformLabel = (platformId) => ({ "7": "Lazada", "17": "Shopee", "8": "Lazada", "18": "TikTok Shop" }[String(platformId)] || `平台 ${platformId || "未知"}`);
function upsertSyncedShopConfigs(catalogShops) {
  const existing = new Map(shopConfigs.map((shop) => [String(shop.shopId), shop]));
  const added = [];
  for (const shop of catalogShops || []) {
    const shopId = String(shop.shopId || "").trim();
    if (!shopId) continue;
    const platformId = String(shop.platformId || "").trim();
    if (existing.has(shopId)) {
      const current = existing.get(shopId);
      current.shopName = String(shop.shopName || current.shopName || shopId).trim();
      current.platformId = platformId || current.platformId;
      current.platform = platformLabel(current.platformId);
      current.countryCode = String(shop.countryCode || current.countryCode || "").trim().toUpperCase();
      continue;
    }
    const shopConfig = { ...config, shopId, shopName: String(shop.shopName || shopId).trim(),
      platformId, platform: platformLabel(platformId), countryCode: String(shop.countryCode || "").trim().toUpperCase(),
      channelId: "", channelName: "", channelValue: "", channelProviderId: "", channelLogisticsId: "",
      configuredAutoFulfillEnabled: false, autoFulfillEnabled: false, mode: "paused", allowedWarehouses: Object.freeze([]) };
    shopConfigs.push(shopConfig); existing.set(shopId, shopConfig); added.push(shopConfig);
  }
  return added;
}
const restoredSyncedShops = repository.getRuntimeSetting("mabangShops", []);
let catalogLastSyncedAt = repository.getRuntimeSetting("catalogLastSyncedAt", null);
let assignedShopIds = new Set((catalogLastSyncedAt ? restoredSyncedShops : config.shops)
  .map((shop) => String(shop.shopId || "").trim()).filter(Boolean));
const hasShopAccess = (shopId) => assignedShopIds.has(String(shopId || ""));
repository.initializeSyncedShops(restoredSyncedShops);
const restoredPolicies = new Map(repository.listShopPolicies().map((policy) => [policy.shopId, policy]));
upsertSyncedShopConfigs(restoredSyncedShops.filter((shop) => restoredPolicies.get(String(shop.shopId))?.mode !== "paused"));
if (catalogLastSyncedAt) repository.pauseShopPoliciesOutside(assignedShopIds, { updatedBy: "startup_access_reconcile" });

function loadSelectedMabangAccount(accountProfileId = repository.getRuntimeSetting("mabangAccountProfileId", "")) {
  const selectedId = String(accountProfileId || "").trim();
  if (!selectedId) return config.mabangUsername && config.mabangPassword
    ? { ok: true, source: "environment", id: "", username: config.mabangUsername, password: config.mabangPassword,
      usernameMasked: maskUsername(config.mabangUsername), lastVerifiedAt: null, lastVerifyStatus: "environment" }
    : { ok: false, source: "none", id: "", username: "", password: "", usernameMasked: "",
      code: "MABANG_ACCOUNT_NOT_CONNECTED", message: "请先在网页中连接马帮账号" };
  const databasePath = path.resolve(rootDir, process.env.DATABASE_PATH || process.env.SCHEDULER_DB_PATH || "storage/commerce-ops.sqlite");
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare(`SELECT id,name,username,encrypted_password,enabled,last_verified_at,last_verify_status,last_verify_message
      FROM mabang_account_profiles WHERE id=?`).get(selectedId);
    if (!row || !Number(row.enabled) || !row.encrypted_password) throw Object.assign(new Error("所选马帮账号不存在、已停用或没有可用密码"), { code: "MABANG_ACCOUNT_UNAVAILABLE" });
    return { ok: true, source: "account_profile", id: row.id, name: row.name, username: row.username,
      password: decryptSecret(row.encrypted_password), usernameMasked: maskUsername(row.username),
      lastVerifiedAt: row.last_verified_at || null, lastVerifyStatus: row.last_verify_status || null,
      lastVerifyMessage: row.last_verify_message || null };
  } catch (error) {
    return { ok: false, source: "account_profile", id: selectedId, username: "", password: "", usernameMasked: "",
      code: error.code || "MABANG_ACCOUNT_LOAD_FAILED", message: String(error.message || "马帮账号读取失败").slice(0, 300) };
  } finally { try { database?.close(); } catch {} }
}

let selectedMabangAccount = loadSelectedMabangAccount();
let selectedMabangAccountIdentityKey = fulfillmentAccountIdentityKey(selectedMabangAccount);
const restoredCatalogAccountIdentityKey = String(repository.getRuntimeSetting("mabangCatalogAccountIdentityKey", "") || "");
if (catalogLastSyncedAt && restoredCatalogAccountIdentityKey !== selectedMabangAccountIdentityKey) {
  const reconciledAt = new Date().toISOString();
  assignedShopIds = new Set();
  catalogLastSyncedAt = reconciledAt;
  repository.pauseShopPoliciesOutside(assignedShopIds, { updatedAt: reconciledAt, updatedBy: "startup_account_reconcile" });
  repository.clearChannelCatalog();
  repository.setRuntimeSetting("mabangShops", [], reconciledAt);
  repository.setRuntimeSetting("mabangWarehouses", [], reconciledAt);
  repository.setRuntimeSetting("fulfillmentPolicySuggestions", { suggestions: [] }, reconciledAt);
  repository.setRuntimeSetting("catalogLastSyncedAt", reconciledAt, reconciledAt);
  repository.setRuntimeSetting("mabangCatalogAccountIdentityKey", selectedMabangAccountIdentityKey, reconciledAt);
}
function accountAuthorizationSettings() {
  const stored = repository.getRuntimeSetting("mabangAutoFulfillAuthorizationByAccount", {});
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}
function authorizedShopIdsForAccount(account = selectedMabangAccount) {
  return authorizedShopIdsForIdentity(accountAuthorizationSettings(), account, staticAutoFulfillAuthorizedShopIds);
}
function saveAccountAuthorization(account, shopIds, updatedAt = new Date().toISOString()) {
  const settings = authorizationSettingsForIdentity(accountAuthorizationSettings(), account, shopIds);
  repository.setRuntimeSetting("mabangAutoFulfillAuthorizationByAccount", settings, updatedAt);
}
autoFulfillAuthorizedShopIds = authorizedShopIdsForAccount();
function applyOperationalConfig() {
  const policies = new Map(repository.listShopPolicies().map((policy) => [policy.shopId, policy]));
  const channels = new Map(repository.listChannelCatalog().map((channel) => [channel.channelId, channel]));
  for (const shopConfig of shopConfigs) {
    const accessActive = hasShopAccess(shopConfig.shopId);
    const policy = policies.get(shopConfig.shopId);
    const channel = channels.get(policy?.channelId);
    if (policy) {
      shopConfig.mode = policy.mode;
      shopConfig.warehousePolicy = policy.warehousePolicy;
      shopConfig.allowedWarehouses = Object.freeze([...(policy.allowedWarehouses || [])]);
      shopConfig.minOrderAgeMinutes = policy.minOrderAgeMinutes;
      shopConfig.maxBatchSize = policy.maxBatchSize;
    }
    const channelMatches = Boolean(channel?.active && (!channel.platformId || channel.platformId === shopConfig.platformId)
      && (!channel.countryCode || channel.countryCode === shopConfig.countryCode));
    shopConfig.channelId = policy?.channelId || "";
    shopConfig.channelName = channelMatches ? channel.channelName : "";
    shopConfig.channelValue = channelMatches ? channel.channelValue : "";
    shopConfig.channelProviderId = channelMatches ? channel.channelProviderId : "";
    shopConfig.channelLogisticsId = channelMatches ? channel.channelLogisticsId : "";
    shopConfig.channelSource = channelMatches ? channel.channelSource : "1";
    shopConfig.logisticsName = channelMatches ? channel.logisticsName : "";
    shopConfig.channelConfigured = channelMatches;
    if (!accessActive) shopConfig.mode = "paused";
    shopConfig.accessActive = accessActive;
    shopConfig.autoFulfillEnabled = Boolean(config.autoFulfillEnabled && accessActive
      && autoFulfillAuthorizedShopIds.has(shopConfig.shopId)
      && policy?.mode === "auto" && channelMatches);
    shopConfig.mabangUsername = selectedMabangAccount.ok ? selectedMabangAccount.username : "";
    shopConfig.mabangPassword = selectedMabangAccount.ok ? selectedMabangAccount.password : "";
  }
  if (typeof scanRuntimeConfig !== "undefined") {
    scanRuntimeConfig.mabangUsername = selectedMabangAccount.ok ? selectedMabangAccount.username : "";
    scanRuntimeConfig.mabangPassword = selectedMabangAccount.ok ? selectedMabangAccount.password : "";
  }
}
const scanRuntimeConfig = { ...config };
const messageReviewModes = new Set(["off", "manual", "auto"]);
function messageReviewMode() {
  const stored = String(repository.getRuntimeSetting("messageReviewRecoveryMode", "") || "").trim();
  if (messageReviewModes.has(stored)) return stored;
  return config.messageReviewRecoveryEnabled ? "auto" : "manual";
}
applyOperationalConfig();
const preflightsByShopId = new Map(shopConfigs.map((shopConfig) => [shopConfig.shopId,
  createMabangFulfillmentPreflight({ config: shopConfig, rootDir })]));
const services = shopConfigs.map((shopConfig) => new FulfillmentService({ config: shopConfig, repository,
  source: createMabangFulfillmentSource({ config: shopConfig, rootDir }),
  executor: shopConfig.realSubmitEnabled ? createMabangFulfillmentExecutor({ config: shopConfig, rootDir }) : createDisabledFulfillmentExecutor(),
  preflight: preflightsByShopId.get(shopConfig.shopId),
  trackingRecovery: createMabangTrackingRecoveryAdapter({ config: shopConfig, rootDir }), notifier }));
const servicesByShopId = new Map(services.map((shopService) => [shopService.config.shopId, shopService]));
function registerSyncedShopRuntimes(catalogShops) {
  const addedConfigs = upsertSyncedShopConfigs(catalogShops);
  for (const shopConfig of addedConfigs) {
    const preflight = createMabangFulfillmentPreflight({ config: shopConfig, rootDir });
    preflightsByShopId.set(shopConfig.shopId, preflight);
    const shopService = new FulfillmentService({ config: shopConfig, repository,
      source: createMabangFulfillmentSource({ config: shopConfig, rootDir }),
      executor: shopConfig.realSubmitEnabled ? createMabangFulfillmentExecutor({ config: shopConfig, rootDir }) : createDisabledFulfillmentExecutor(),
      preflight, trackingRecovery: createMabangTrackingRecoveryAdapter({ config: shopConfig, rootDir }), notifier });
    services.push(shopService); servicesByShopId.set(shopConfig.shopId, shopService);
  }
  return addedConfigs;
}
const service = servicesByShopId.get(config.shopId) || services[0];
const scanSource = createMabangFulfillmentScanSource({ config: scanRuntimeConfig, shops: shopConfigs, rootDir });
const catalogSource = createMabangFulfillmentCatalogSource({ config: shopConfigs[0], rootDir });
const policySuggestionSource = createMabangPolicySuggestionSource({ config: scanRuntimeConfig, shops: shopConfigs, rootDir });
const messageReviewRecovery = createMabangMessageReviewRecovery({ config: scanRuntimeConfig, shops: shopConfigs, rootDir });
scanRuntimeConfig.messageReviewRecoveryEnabled = messageReviewMode() === "auto";
const scheduler = new FulfillmentPreviewScheduler({ config: scanRuntimeConfig, service, services, scanSource, messageReviewRecovery, notifier });
scheduler.start();
let operationalConfigChanging = false;
let pendingPolicyRuntimeApply = false;
let pendingMessageReviewRuntimeApply = false;
let pendingPolicyRuntimeTimer = null;
const pendingPolicyRuntimeShops = new Map();
let policySuggestionScanJob = { status: "idle", startedAt: null, finishedAt: null, errorMessage: null };
const policyImportPreviews = new Map();

async function withOperationalConfigChange(callback) {
  if (operationalConfigChanging) {
    throw new FulfillmentError("FULFILLMENT_CONFIG_BUSY", "正在更新自动发货配置，请稍后重试", 409);
  }
  const before = scheduler.status();
  if (before.scanning || before.activeBatch || before.dispatchQueue?.running || before.dispatchQueue?.draining
    || before.messageReviewFollowUpPendingCount) {
    throw new FulfillmentError("FULFILLMENT_BUSY", before.messageReviewFollowUpPendingCount
      ? "待审核恢复订单正在等待定向安全检查，请完成后再切换账号或同步店铺渠道"
      : "当前正在扫描或执行发货批次，暂时不能切换账号或同步店铺渠道", 409);
  }
  operationalConfigChanging = true;
  scheduler.stop();
  try {
    const stopped = scheduler.status();
    if (stopped.scanning || stopped.activeBatch || stopped.dispatchQueue?.running || stopped.dispatchQueue?.draining) {
      throw new FulfillmentError("FULFILLMENT_BUSY", "当前正在扫描或执行发货批次，暂时不能切换账号或同步店铺渠道", 409);
    }
    return await callback();
  } finally {
    operationalConfigChanging = false;
    scheduler.start();
  }
}

async function withPolicyConfigChange(callback) {
  if (operationalConfigChanging) {
    throw new FulfillmentError("FULFILLMENT_CONFIG_BUSY", "正在更新自动发货配置，请稍后重试", 409);
  }
  operationalConfigChanging = true;
  try { return await callback(); }
  finally { operationalConfigChanging = false; }
}

function policyRuntimeBusy() {
  const state = scheduler.status();
  return Boolean(state.scanning || state.activeBatch || state.messageReviewFollowUpPendingCount
    || Number(state.dispatchQueue?.queued || 0) || Number(state.dispatchQueue?.running || 0));
}

function schedulePendingPolicyRuntimeApply() {
  if (pendingPolicyRuntimeTimer) return;
  pendingPolicyRuntimeTimer = setTimeout(() => {
    pendingPolicyRuntimeTimer = null;
    if (!pendingPolicyRuntimeApply && !pendingMessageReviewRuntimeApply) return;
    if (policyRuntimeBusy()) return schedulePendingPolicyRuntimeApply();
    const shops = [...pendingPolicyRuntimeShops.values()];
    pendingPolicyRuntimeShops.clear();
    pendingPolicyRuntimeApply = false;
    if (pendingMessageReviewRuntimeApply) {
      scanRuntimeConfig.messageReviewRecoveryEnabled = messageReviewMode() === "auto";
      pendingMessageReviewRuntimeApply = false;
    }
    registerSyncedShopRuntimes(shops);
    applyOperationalConfig();
  }, 1000);
  pendingPolicyRuntimeTimer.unref?.();
}

function applyPolicyRuntimeConfig(catalogShops = []) {
  for (const shop of catalogShops) if (shop?.shopId) pendingPolicyRuntimeShops.set(String(shop.shopId), shop);
  if (policyRuntimeBusy()) {
    pendingPolicyRuntimeApply = true;
    schedulePendingPolicyRuntimeApply();
    return { deferred: true };
  }
  const shops = [...pendingPolicyRuntimeShops.values()];
  pendingPolicyRuntimeShops.clear();
  pendingPolicyRuntimeApply = false;
  registerSyncedShopRuntimes(shops);
  applyOperationalConfig();
  return { deferred: false };
}

function applyMessageReviewRuntimeConfig() {
  if (policyRuntimeBusy()) {
    pendingMessageReviewRuntimeApply = true;
    schedulePendingPolicyRuntimeApply();
    return { deferred: true };
  }
  scanRuntimeConfig.messageReviewRecoveryEnabled = messageReviewMode() === "auto";
  pendingMessageReviewRuntimeApply = false;
  return { deferred: false };
}

function serviceForShop(shopId) {
  const normalizedShopId = String(shopId || config.shopId);
  if (!hasShopAccess(normalizedShopId)) throw new FulfillmentError("SHOP_ACCESS_REVOKED", "店铺已不属于当前马帮账号权限范围", 403);
  const selected = servicesByShopId.get(normalizedShopId);
  if (!selected) throw new FulfillmentError("SHOP_NOT_CONFIGURED", "店铺未配置或不属于当前印尼店铺范围", 400);
  return selected;
}
function serviceForPreview(previewId) {
  const preview = repository.getPreview(previewId);
  if (!preview) throw new FulfillmentError("PREVIEW_NOT_FOUND", "预览不存在", 404);
  return serviceForShop(preview.shopId);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}
async function body(req, maxLength = 1024 * 1024) {
  let text = ""; for await (const chunk of req) { text += chunk; if (text.length > maxLength) throw new FulfillmentError("BODY_TOO_LARGE", "请求体过大", 413); }
  return text ? JSON.parse(text) : {};
}
function authorized(req) {
  if (!config.apiToken) return config.host === "127.0.0.1" || config.host === "localhost";
  return req.headers.authorization === `Bearer ${config.apiToken}`;
}

function trustedActor(req) {
  const assertion = req.headers[FULFILLMENT_ACTOR_ASSERTION_HEADER];
  if (!assertion) return null;
  try {
    return verifyFulfillmentActorAssertion(assertion, { secret: config.fulfillmentActorAssertionSecret });
  } catch {
    throw new FulfillmentError("FULFILLMENT_ACTOR_ASSERTION_INVALID", "操作人身份断言无效或已过期", 401);
  }
}

function suggestedChannelForShop(rawSuggestion, shop, channels) {
  const candidates = rawSuggestion?.channel ? channels.filter((item) => item.active && [item.channelName, item.logisticsName]
    .some((name) => String(name || "").trim().toLocaleLowerCase() === String(rawSuggestion.channel.name || "").trim().toLocaleLowerCase())) : [];
  return candidates.find((item) => (!item.platformId || item.platformId === String(shop.platformId || ""))
    && (!item.countryCode || item.countryCode === String(shop.countryCode || "").toUpperCase())) || null;
}

function allWarehouseOptions() {
  const warehouseCatalog = repository.getRuntimeSetting("mabangWarehouses", []);
  const suggestionScan = repository.getRuntimeSetting("fulfillmentPolicySuggestions", { suggestions: [] });
  return [...new Set([
    ...warehouseCatalog.map((warehouse) => String(warehouse?.warehouseName || warehouse?.name || warehouse || "").trim()),
    ...repository.listShopPolicies().flatMap((policy) => policy.allowedWarehouses || []),
    ...repository.listObservedWarehouses(),
    ...(suggestionScan.warehouses || []),
    ...(suggestionScan.suggestions || []).flatMap((item) => (item.warehouses || []).map((warehouse) => warehouse.name)),
  ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function prunePolicyImportPreviews(now = Date.now()) {
  for (const [id, preview] of policyImportPreviews) if (preview.expiresAtMs <= now) policyImportPreviews.delete(id);
}

function operationalSettings() {
  const channels = repository.listChannelCatalog();
  const policies = new Map(repository.listShopPolicies().map((policy) => [policy.shopId, policy]));
  const syncedShops = repository.getRuntimeSetting("mabangShops", []);
  const visibleShops = catalogLastSyncedAt ? syncedShops : config.shops;
  const suggestionScan = repository.getRuntimeSetting("fulfillmentPolicySuggestions", { suggestions: [] });
  const suggestions = new Map((suggestionScan.suggestions || []).map((item) => [String(item.shopId), item]));
  const warehouseOptions = allWarehouseOptions();
  return {
    account: { connected: Boolean(selectedMabangAccount.ok), id: selectedMabangAccount.id || "",
      name: selectedMabangAccount.name || "", usernameMasked: selectedMabangAccount.usernameMasked || "",
      source: selectedMabangAccount.source, lastVerifiedAt: selectedMabangAccount.lastVerifiedAt || null,
      lastVerifyStatus: selectedMabangAccount.lastVerifyStatus || null,
      errorCode: selectedMabangAccount.ok ? null : selectedMabangAccount.code,
      errorMessage: selectedMabangAccount.ok ? null : selectedMabangAccount.message },
    safety: { realSubmitEnabled: config.realSubmitEnabled, automaticFulfillmentAuthorized: config.autoFulfillEnabled,
      schedulerEnabled: config.schedulerEnabled, concurrencyHardLimit: 2 },
    runtimeConfigUpdate: { pending: pendingPolicyRuntimeApply || pendingMessageReviewRuntimeApply,
      message: pendingPolicyRuntimeApply || pendingMessageReviewRuntimeApply
        ? "配置已保存，将在当前扫描和发货队列结束后自动生效" : null },
    messageReviewRecovery: { mode: messageReviewMode(), limit: config.messageReviewRecoveryLimit,
      intervalMinutes: config.messageReviewRecoveryIntervalMinutes, followUpDelaySeconds: config.messageReviewFollowUpDelaySeconds },
    lastCatalogSyncAt: catalogLastSyncedAt,
    lastPolicySuggestionScanAt: suggestionScan.scannedAt || null,
    policySuggestionScan: suggestionScan.scannedAt ? { scannedAt: suggestionScan.scannedAt,
      lookbackDays: suggestionScan.lookbackDays, orderCount: suggestionScan.orderCount,
      warehouseCatalogComplete: suggestionScan.warehouseCatalogComplete !== false } : null,
    policySuggestionScanJob,
    syncedShops,
    channels: channels.map((channel) => ({ ...channel, channelValue: undefined })),
    warehouseOptions,
    shops: visibleShops.map((shop) => ({ id: String(shop.shopId), name: shop.shopName,
      platform: shop.platform || platformLabel(shop.platformId), platformId: String(shop.platformId || ""),
      countryCode: String(shop.countryCode || "").toUpperCase() })).map((shop) => {
      const policy = policies.get(shop.id);
      const channel = channels.find((item) => item.channelId === policy?.channelId);
      const channelValid = Boolean(channel?.active && (!channel.platformId || channel.platformId === shop.platformId)
        && (!channel.countryCode || channel.countryCode === shop.countryCode));
      const rawSuggestion = suggestions.get(shop.id) || null;
      const suggestedChannel = suggestedChannelForShop(rawSuggestion, shop, channels);
      const suggestion = rawSuggestion ? { ...rawSuggestion, channel: rawSuggestion.channel
        ? { ...rawSuggestion.channel, channelId: suggestedChannel?.channelId || "", matched: Boolean(suggestedChannel) } : null,
        needsReview: policy?.updatedBy === "catalog_sync" && Boolean(rawSuggestion.channel || rawSuggestion.warehouses?.length) } : null;
      return { ...shop, policy,
        warehouseOptions,
        suggestion,
        channelValid, autoFulfillAuthorized: autoFulfillAuthorizedShopIds.has(shop.id),
        autoFulfillEnabled: Boolean(config.autoFulfillEnabled && autoFulfillAuthorizedShopIds.has(shop.id)
          && policy?.mode === "auto" && channelValid) };
    }),
  };
}

function validatedPolicy(shopConfig, payload) {
  const mode = ["paused", "manual", "auto"].includes(payload.mode) ? payload.mode : null;
  if (!mode) throw new FulfillmentError("INVALID_FULFILLMENT_MODE", "请选择暂停、人工确认或自动履约", 400);
  const warehousePolicy = ["allowlist", "any_single_warehouse"].includes(payload.warehousePolicy)
    ? payload.warehousePolicy : null;
  if (!warehousePolicy) throw new FulfillmentError("INVALID_WAREHOUSE_POLICY", "请选择自动履约仓库范围", 400);
  const allowedWarehouses = [...new Set((Array.isArray(payload.allowedWarehouses) ? payload.allowedWarehouses : [])
    .map((value) => String(value || "").trim()).filter(Boolean))];
  if (allowedWarehouses.length > 20 || allowedWarehouses.some((value) => value.length > 160)) {
    throw new FulfillmentError("INVALID_ALLOWED_WAREHOUSES", "允许仓库配置无效", 400);
  }
  if (warehousePolicy === "allowlist" && !allowedWarehouses.length) {
    throw new FulfillmentError("WAREHOUSE_ALLOWLIST_EMPTY", "仅允许指定仓库时，请至少选择一个仓库", 400);
  }
  const minOrderAgeMinutes = Number(payload.minOrderAgeMinutes);
  if (![2, 5, 10, 15, 30, 60].includes(minOrderAgeMinutes)) {
    throw new FulfillmentError("INVALID_MIN_ORDER_AGE", "订单安全等待时间只能选择2、5、10、15、30或60分钟", 400);
  }
  const maxBatchSize = Number(payload.maxBatchSize);
  if (![1, 2, 5, 10].includes(maxBatchSize)) {
    throw new FulfillmentError("INVALID_MAX_BATCH_SIZE", "每轮订单数只能选择1、2、5或10", 400);
  }
  const channelId = String(payload.channelId || "").trim();
  const channel = repository.listChannelCatalog({ activeOnly: true }).find((item) => item.channelId === channelId);
  if (mode === "auto" && !autoFulfillAuthorizedShopIds.has(shopConfig.shopId)) {
    throw new FulfillmentError("SHOP_AUTO_FULFILL_NOT_AUTHORIZED",
      "该店铺尚未完成静态白名单授权，只能暂停或只检查不发货", 409);
  }
  if (mode === "auto" && !channel) throw new FulfillmentError("CHANNEL_NOT_CONFIGURED", "开启自动履约前必须选择有效物流渠道", 409);
  if (channel && ((channel.platformId && channel.platformId !== shopConfig.platformId)
    || (channel.countryCode && channel.countryCode !== shopConfig.countryCode))) {
    throw new FulfillmentError("CHANNEL_SCOPE_MISMATCH", "物流渠道与店铺平台或国家不匹配", 409);
  }
  return { shopId: shopConfig.shopId, mode, channelId, warehousePolicy, allowedWarehouses,
    minOrderAgeMinutes, maxBatchSize };
}

function dashboardWindows(now = new Date(), days = 7) {
  const boundedDays = Math.min(30, Math.max(1, Number(days) || 7));
  const offsetMs = 8 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const todayStartMs = Math.floor((nowMs + offsetMs) / dayMs) * dayMs - offsetMs;
  const dayWindows = Array.from({ length: boundedDays }, (_, index) => {
    const fromMs = todayStartMs - (boundedDays - 1 - index) * dayMs;
    return {
      date: new Date(fromMs + offsetMs).toISOString().slice(0, 10),
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(fromMs + dayMs).toISOString(),
    };
  });
  return {
    todayStartIso: new Date(todayStartMs).toISOString(),
    trendStartIso: dayWindows[0].fromIso,
    endIso: now.toISOString(), dayWindows,
  };
}

const currentAccountShopIds = () => [...assignedShopIds];
const fulfillmentAgentTools = new FulfillmentAgentTools({ repository, scheduler, serviceForShop, serviceForPreview,
  dashboardWindows, shopScope: currentAccountShopIds });
const fulfillmentAgentApiKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
const fulfillmentAgent = new FulfillmentAgent({
  enabled: config.fulfillmentAgentEnabled,
  model: config.fulfillmentAgentModel,
  maxSteps: config.fulfillmentAgentMaxSteps,
  repository,
  tools: fulfillmentAgentTools,
  gateway: fulfillmentAgentApiKey ? new AiGateway({
    provider: new DeepSeekProvider({ apiKey: fulfillmentAgentApiKey,
      endpoint: resolveDeepSeekEndpoint(process.env.DEEPSEEK_BASE_URL) }),
  }) : null,
});

const warehouseTransferService = new WarehouseTransferService({
  rootDir,
  credentials: () => selectedMabangAccount,
  hasShopAccess,
  allowedWarehouses: (shopId) => {
    const policy = repository.getShopPolicy(String(shopId || ""));
    return policy?.warehousePolicy === "any_single_warehouse" ? allWarehouseOptions() : policy?.allowedWarehouses || [];
  },
});
const skuReplacementService = new SkuReplacementService({
  rootDir,
  credentials: () => selectedMabangAccount,
  hasShopAccess,
  allowedWarehouses: (shopId) => {
    const policy = repository.getShopPolicy(String(shopId || ""));
    return policy?.warehousePolicy === "allowlist" ? policy.allowedWarehouses || [] : [];
  },
  warehouseTransferService,
});
const skuReplacementBatchService = new SkuReplacementBatchService({ rootDir, skuReplacementService });
const previewTaskStore = new PreviewTaskStore({ rootDir });
const recoveredSkuReplacementTasks = skuReplacementBatchService.reconcileInterruptedExecutions();
if (recoveredSkuReplacementTasks.length) {
  console.warn(`Recovered ${recoveredSkuReplacementTasks.length} interrupted SKU replacement task(s) for manual review.`);
}
const operationDrain = new OperationDrainController();
let shuttingDown = false;

function trackedOperation(kind, options, operation) {
  return operationDrain.run(kind, options, operation).catch((error) => {
    if (error?.code === "FULFILLMENT_DRAINING") throw new FulfillmentError(error.code, error.message, 503);
    throw error;
  });
}

function maintenanceRequestAllowed(req) {
  const address = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return new Set(["127.0.0.1", "::1"]).has(address)
    && req.headers["x-fulfillment-maintenance"] === "drain-and-restart";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { success: true, ...operationDrain.status(), realSubmitEnabled: config.realSubmitEnabled,
      schedulerEnabled: config.schedulerEnabled, schedulerIntervalSeconds: config.schedulerIntervalSeconds,
      autoFulfillEnabled: config.autoFulfillEnabled,
      messageReviewRecoveryEnabled: scanRuntimeConfig.messageReviewRecoveryEnabled,
      autoFulfillShops: shopConfigs.filter((shop) => shop.autoFulfillEnabled)
        .map((shop) => ({ id: shop.shopId, name: shop.shopName })),
      orderConcurrency: config.orderConcurrency,
      fulfillmentAgent: fulfillmentAgent.status(),
      fulfillmentV2: { enabled: config.fulfillmentV2Enabled,
        shadowWriteEnabled: config.fulfillmentV2ShadowWriteEnabled,
        ready: fulfillmentV2Status.ready,
        schemaVersion: fulfillmentV2Status.schemaVersion },
      windowsNotificationsEnabled: config.windowsNotificationsEnabled, supervised: process.env.FULFILLMENT_SUPERVISED === "1",
      shopCount: shopConfigs.filter((shop) => hasShopAccess(shop.shopId)).length,
      shops: shopConfigs.filter((shop) => hasShopAccess(shop.shopId)).map((shop) => ({ id: shop.shopId, name: shop.shopName,
        platform: shop.platform, platformId: shop.platformId, countryCode: shop.countryCode,
        channelProfileId: shop.channelProfileId, channelId: shop.channelId, channelName: shop.channelName,
        allowedWarehouses: shop.allowedWarehouses, configuredAutoFulfillEnabled: shop.configuredAutoFulfillEnabled,
        autoFulfillEnabled: shop.autoFulfillEnabled })) });
    if (req.method === "GET" && (url.pathname === "/docs" || url.pathname === "/docs/")) return sendHtml(res, 200, createApiDocsHtml(config));
    if (req.method === "GET" && url.pathname === "/openapi.json") return send(res, 200, createOpenApiDocument(config));
    if (req.method === "POST" && url.pathname === "/api/fulfillment/maintenance/restart") {
      if (!maintenanceRequestAllowed(req)) return send(res, 403, { success: false, error: { code: "MAINTENANCE_FORBIDDEN", message: "只允许本机安全维护程序调用" } });
      const state = operationDrain.beginDrain();
      send(res, 202, { success: true, data: { ...state, message: state.activeOperations ? "正在等待现有任务结束后重启" : "即将安全重启" } });
      setImmediate(() => shutdown());
      return;
    }
    if (!authorized(req)) return send(res, 401, { success: false, error: { code: "UNAUTHORIZED", message: "未授权访问" } });
    if (req.method === "POST" && url.pathname === "/api/fulfillment/warehouse-transfers/preview") {
      const payload = await body(req, 32 * 1024);
      try {
        return send(res, 201, { success: true, data: await trackedOperation("warehouse-preview", {}, () => warehouseTransferService.preview(payload)) });
      } catch (error) {
        throw new FulfillmentError(error.code || "WAREHOUSE_TRANSFER_PREVIEW_FAILED", error.message || "换仓预览失败", 409);
      }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/warehouse-transfers/execute") {
      trustedActor(req);
      const payload = await body(req, 32 * 1024);
      try {
        return send(res, 200, { success: true, data: await trackedOperation("warehouse-execute", { write: true }, () => warehouseTransferService.execute(payload)) });
      } catch (error) {
        throw new FulfillmentError(error.code || "WAREHOUSE_TRANSFER_EXECUTE_FAILED", error.message || "换仓执行失败", 409);
      }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/warehouse-transfers/batch-preview") {
      const payload = await body(req, 32 * 1024);
      try { return send(res, 201, { success: true, data: await trackedOperation("warehouse-batch-preview", {}, () => warehouseTransferService.previewBatch(payload)) }); }
      catch (error) { throw new FulfillmentError(error.code || "WAREHOUSE_BATCH_PREVIEW_FAILED", error.message || "批量换仓预览失败", 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/warehouse-transfers/batch-preview-tasks") {
      const payload = await body(req, 32 * 1024);
      const task = previewTaskStore.start({ kind: "warehouse-batch-preview", input: payload,
        run: () => trackedOperation("warehouse-batch-preview", {}, () => warehouseTransferService.previewBatch(payload)) });
      return send(res, 202, { success: true, data: task });
    }
    const warehousePreviewTaskMatch = url.pathname.match(/^\/api\/fulfillment\/warehouse-transfers\/batch-preview-tasks\/([A-Za-z0-9-]{1,80})$/);
    if (req.method === "GET" && warehousePreviewTaskMatch) {
      const task = previewTaskStore.get(warehousePreviewTaskMatch[1]);
      if (!task || task.kind !== "warehouse-batch-preview") throw new FulfillmentError("PREVIEW_TASK_NOT_FOUND", "换仓预览任务不存在", 404);
      return send(res, 200, { success: true, data: task });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/warehouse-transfers/batch-recover") {
      const payload = await body(req, 32 * 1024);
      try { return send(res, 200, { success: true, data: warehouseTransferService.recoverBatch(payload) }); }
      catch (error) { throw new FulfillmentError(error.code || "WAREHOUSE_BATCH_RECOVERY_FAILED", error.message || "恢复批量换仓结果失败", 404); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/warehouse-transfers/batch-execute") {
      trustedActor(req);
      const payload = await body(req, 32 * 1024);
      try { return send(res, 200, { success: true, data: await trackedOperation("warehouse-batch-execute", { write: true }, () => warehouseTransferService.executeBatch(payload)) }); }
      catch (error) { throw new FulfillmentError(error.code || "WAREHOUSE_BATCH_EXECUTE_FAILED", error.message || "批量换仓执行失败", 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-preview") {
      const payload = await body(req, 32 * 1024);
      try { return send(res, 201, { success: true, data: await trackedOperation("sku-batch-preview", {}, () => skuReplacementService.previewBatch(payload)) }); }
      catch (error) { throw new FulfillmentError(error.code || "SKU_REPLACEMENT_PREVIEW_FAILED", error.message || "替换 SKU 建议生成失败", 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-preview-tasks") {
      const payload = await body(req, 32 * 1024);
      const task = previewTaskStore.start({ kind: "sku-batch-preview", input: payload,
        run: () => trackedOperation("sku-batch-preview", {}, () => skuReplacementService.previewBatch(payload)) });
      return send(res, 202, { success: true, data: task });
    }
    const skuPreviewTaskMatch = url.pathname.match(/^\/api\/fulfillment\/sku-replacements\/batch-preview-tasks\/([A-Za-z0-9-]{1,80})$/);
    if (req.method === "GET" && skuPreviewTaskMatch) {
      const task = previewTaskStore.get(skuPreviewTaskMatch[1]);
      if (!task || task.kind !== "sku-batch-preview") throw new FulfillmentError("PREVIEW_TASK_NOT_FOUND", "SKU 预览任务不存在", 404);
      return send(res, 200, { success: true, data: task });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-recover") {
      const payload = await body(req, 32 * 1024);
      try { return send(res, 200, { success: true, data: skuReplacementService.recoverBatch(payload) }); }
      catch (error) { throw new FulfillmentError(error.code || "SKU_REPLACEMENT_RECOVERY_FAILED", error.message || "SKU 替换预览恢复失败", 404); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/plan") {
      const payload = await body(req, 16 * 1024);
      try { return send(res, 201, { success: true, data: await trackedOperation("sku-plan", {}, () => skuReplacementService.createPlan(payload)) }); }
      catch (error) { throw new FulfillmentError(error.code || "SKU_REPLACEMENT_PLAN_FAILED", error.message || "替换 SKU 计划生成失败", 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/execute") {
      trustedActor(req);
      const payload = await body(req, 16 * 1024);
      try { return send(res, 200, { success: true, data: await trackedOperation("sku-execute", { write: true }, () => skuReplacementService.execute(payload)) }); }
      catch (error) { throw new FulfillmentError(error.code || "SKU_REPLACEMENT_EXECUTE_FAILED",
        error.message || "替换 SKU 执行失败", 409,
        error.diagnostic ? { diagnostic: error.diagnostic } : undefined); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-plan") {
      const payload = await body(req, 32 * 1024);
      try { return send(res, 201, { success: true, data: await trackedOperation("sku-batch-plan", {}, () => skuReplacementBatchService.createPlan(payload)) }); }
      catch (error) { throw new FulfillmentError(error.code || "SKU_REPLACEMENT_BATCH_PLAN_FAILED", error.message || "批量替换 SKU 计划生成失败", 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-execute") {
      trustedActor(req);
      const payload = await body(req, 16 * 1024);
      let task;
      try {
        operationDrain.assertAccepting();
        task = skuReplacementBatchService.createExecution(payload);
      } catch (error) {
        throw new FulfillmentError(error.code || "SKU_REPLACEMENT_BATCH_EXECUTE_FAILED", error.message || "批量替换 SKU 执行失败",
          error.code === "FULFILLMENT_DRAINING" ? 503 : 409);
      }
      void trackedOperation("sku-batch-execute", { write: true }, () => skuReplacementBatchService.runExecution(task.taskId))
        .catch((error) => console.error(`SKU replacement task ${task.taskId} stopped with ${String(error?.code || "INTERNAL_ERROR").slice(0, 80)}.`));
      return send(res, 202, { success: true, data: task });
    }
    let skuBatchTaskMatch = url.pathname.match(/^\/api\/fulfillment\/sku-replacements\/batch-executions\/([a-zA-Z0-9-]{1,80})$/);
    if (req.method === "GET" && skuBatchTaskMatch) {
      try {
        const task = skuReplacementBatchService.getExecution(skuBatchTaskMatch[1]);
        if (!task) throw new FulfillmentError("SKU_REPLACEMENT_TASK_NOT_FOUND", "批量更换任务不存在", 404);
        return send(res, 200, { success: true, data: task });
      } catch (error) {
        if (error instanceof FulfillmentError) throw error;
        throw new FulfillmentError(error.code || "SKU_REPLACEMENT_TASK_NOT_FOUND", error.message || "批量更换任务不存在", 404);
      }
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/settings") {
      return send(res, 200, { success: true, data: operationalSettings() });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/settings/account") {
      const payload = await body(req);
      const accountProfileId = String(payload.accountProfileId || "").trim();
      const settings = await withOperationalConfigChange(async () => {
        const selected = loadSelectedMabangAccount(accountProfileId);
        if (!selected.ok) throw new FulfillmentError(selected.code, selected.message, 409);
        const nextAccountIdentityKey = fulfillmentAccountIdentityKey(selected);
        const accountChanged = selectedMabangAccountIdentityKey !== nextAccountIdentityKey;
        repository.setRuntimeSetting("mabangAccountProfileId", accountProfileId);
        selectedMabangAccount = selected;
        selectedMabangAccountIdentityKey = nextAccountIdentityKey;
        autoFulfillAuthorizedShopIds = authorizedShopIdsForAccount(selected);
        if (accountChanged) {
          const changedAt = new Date().toISOString();
          repository.cancelQueuedDispatches(changedAt);
          assignedShopIds = new Set();
          catalogLastSyncedAt = changedAt;
          repository.pauseShopPoliciesOutside(assignedShopIds, { updatedAt: changedAt, updatedBy: "account_switch" });
          repository.clearChannelCatalog();
          repository.setRuntimeSetting("mabangShops", [], changedAt);
          repository.setRuntimeSetting("mabangWarehouses", [], changedAt);
          repository.setRuntimeSetting("fulfillmentPolicySuggestions", { suggestions: [] }, changedAt);
          repository.setRuntimeSetting("catalogLastSyncedAt", changedAt, changedAt);
          repository.setRuntimeSetting("mabangCatalogAccountIdentityKey", nextAccountIdentityKey, changedAt);
        }
        applyOperationalConfig();
        return operationalSettings();
      });
      return send(res, 200, { success: true, data: settings });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/channels/sync") {
      const settings = await withOperationalConfigChange(async () => {
        if (!selectedMabangAccount.ok) throw new FulfillmentError(selectedMabangAccount.code,
          selectedMabangAccount.message || "请先连接马帮账号", 409);
        const catalog = await catalogSource.sync();
        const syncedAt = new Date().toISOString();
        repository.replaceChannelCatalog(catalog.channels, syncedAt);
        repository.initializeSyncedShops(catalog.shops, syncedAt);
        const nextAssignedShopIds = new Set(catalog.shops.map((shop) => String(shop.shopId || "").trim()).filter(Boolean));
        repository.pauseShopPoliciesOutside(nextAssignedShopIds, { updatedAt: syncedAt });
        repository.setRuntimeSetting("mabangShops", catalog.shops, syncedAt);
        repository.setRuntimeSetting("mabangWarehouses", catalog.warehouses || [], syncedAt);
        repository.setRuntimeSetting("catalogLastSyncedAt", syncedAt, syncedAt);
        repository.setRuntimeSetting("mabangCatalogAccountIdentityKey", selectedMabangAccountIdentityKey, syncedAt);
        assignedShopIds = nextAssignedShopIds;
        autoFulfillAuthorizedShopIds = new Set(nextAssignedShopIds);
        saveAccountAuthorization(selectedMabangAccount, nextAssignedShopIds, syncedAt);
        catalogLastSyncedAt = syncedAt;
        const activePolicies = new Map(repository.listShopPolicies().map((policy) => [policy.shopId, policy]));
        registerSyncedShopRuntimes(catalog.shops.filter((shop) => activePolicies.get(String(shop.shopId))?.mode !== "paused"));
        applyOperationalConfig();
        return operationalSettings();
      });
      return send(res, 200, { success: true, data: settings });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/policy-suggestions/scan") {
      if (!selectedMabangAccount.ok) throw new FulfillmentError(selectedMabangAccount.code,
        selectedMabangAccount.message || "请先连接马帮账号", 409);
      if (policySuggestionScanJob.status === "running") {
        return send(res, 202, { success: true, data: operationalSettings() });
      }
      const selectedShops = repository.getRuntimeSetting("mabangShops", config.shops).map((shop) => ({
        ...shop, shopId: String(shop.shopId), shopName: String(shop.shopName || ""),
        platform: shop.platform || platformLabel(shop.platformId),
      }));
      const startedAt = new Date().toISOString();
      policySuggestionScanJob = { status: "running", startedAt, finishedAt: null, errorMessage: null };
      void policySuggestionSource.scan({ lookbackDays: 30, selectedShops }).then((result) => {
        repository.setRuntimeSetting("fulfillmentPolicySuggestions", result, result.scannedAt);
        policySuggestionScanJob = { status: "completed", startedAt, finishedAt: result.scannedAt, errorMessage: null };
      }).catch((error) => {
        policySuggestionScanJob = { status: "failed", startedAt, finishedAt: new Date().toISOString(),
          errorMessage: String(error?.message || "历史订单分析失败").slice(0, 300) };
      });
      return send(res, 202, { success: true, data: operationalSettings() });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/policy-suggestions/confirm") {
      const payload = await body(req);
      const shopIds = [...new Set((Array.isArray(payload.shopIds) ? payload.shopIds : [])
        .map((value) => String(value || "").trim()).filter(Boolean))];
      if (!shopIds.length || shopIds.length > 200 || shopIds.some((value) => !/^\d{1,24}$/.test(value))) {
        throw new FulfillmentError("INVALID_POLICY_SUGGESTION_SHOPS", "请选择有效的待审查店铺", 400);
      }
      const actor = trustedActor(req);
      const response = await withPolicyConfigChange(async () => {
        const channels = repository.listChannelCatalog({ activeOnly: true });
        const policies = new Map(repository.listShopPolicies().map((policy) => [policy.shopId, policy]));
        const catalogShops = new Map(repository.getRuntimeSetting("mabangShops", [])
          .map((shop) => [String(shop.shopId), shop]));
        const suggestionScan = repository.getRuntimeSetting("fulfillmentPolicySuggestions", { suggestions: [] });
        const suggestions = new Map((suggestionScan.suggestions || []).map((item) => [String(item.shopId), item]));
        const plan = planFulfillmentPolicySuggestionConfirmations({ shopIds, shops: catalogShops, policies, suggestions, channels, hasAccess: hasShopAccess });
        const changes = plan.changes.map((candidate) => {
          const shop = catalogShops.get(candidate.shopId);
          const validationConfig = { ...config, shopId: candidate.shopId, shopName: shop.shopName,
            platformId: String(shop.platformId || ""), platform: shop.platform || platformLabel(shop.platformId),
            countryCode: String(shop.countryCode || "").toUpperCase() };
          return validatedPolicy(validationConfig, candidate);
        });
        repository.transaction(() => {
          for (const policy of changes) repository.saveShopPolicy(policy, {
            updatedBy: `suggestion_confirm:${actor?.displayName || "authenticated_session"}`,
          });
        });
        applyPolicyRuntimeConfig();
        return { settings: operationalSettings(), result: { requested: shopIds.length, confirmed: changes.length,
          skippedCount: plan.skipped.length, confirmedShopIds: changes.map((item) => item.shopId), skipped: plan.skipped } };
      });
      return send(res, 200, { success: true, data: response });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/shop-policies/batch") {
      const payload = await body(req, 16 * 1024);
      const shopIds = [...new Set((Array.isArray(payload.shopIds) ? payload.shopIds : [])
        .map((value) => String(value || "").trim()).filter(Boolean))];
      const patch = {};
      if (payload.patch?.mode != null && String(payload.patch.mode).trim()) patch.mode = String(payload.patch.mode).trim();
      if (payload.patch?.minOrderAgeMinutes != null && String(payload.patch.minOrderAgeMinutes).trim()) patch.minOrderAgeMinutes = Number(payload.patch.minOrderAgeMinutes);
      if (payload.patch?.maxBatchSize != null && String(payload.patch.maxBatchSize).trim()) patch.maxBatchSize = Number(payload.patch.maxBatchSize);
      if (!shopIds.length || shopIds.length > 200 || shopIds.some((value) => !/^\d{1,24}$/.test(value))
        || !Object.keys(patch).length || (patch.mode && !["paused", "manual", "auto"].includes(patch.mode))
        || (patch.minOrderAgeMinutes != null && ![2, 5, 10, 15, 30, 60].includes(patch.minOrderAgeMinutes))
        || (patch.maxBatchSize != null && ![1, 2, 5, 10].includes(patch.maxBatchSize))) {
        throw new FulfillmentError("INVALID_BATCH_SHOP_POLICY", "批量店铺配置参数无效", 400);
      }
      const actor = trustedActor(req);
      const response = await withPolicyConfigChange(async () => {
        const catalogShops = new Map(repository.getRuntimeSetting("mabangShops", []).map((shop) => [String(shop.shopId), shop]));
        const changes = []; const skipped = [];
        for (const shopId of shopIds) {
          const shop = catalogShops.get(shopId);
          const current = repository.getShopPolicy(shopId);
          if (!shop || !hasShopAccess(shopId)) { skipped.push({ shopId, reason: "店铺已不在当前账号权限范围" }); continue; }
          if (!current) { skipped.push({ shopId, reason: "店铺配置不存在" }); continue; }
          const validationConfig = { ...config, shopId, shopName: shop.shopName,
            platformId: String(shop.platformId || ""), platform: shop.platform || platformLabel(shop.platformId),
            countryCode: String(shop.countryCode || "").toUpperCase() };
          try { changes.push(validatedPolicy(validationConfig, { ...current, ...patch })); }
          catch (error) { skipped.push({ shopId, shopName: shop.shopName, reason: String(error?.message || "配置校验失败") }); }
        }
        repository.transaction(() => {
          for (const policy of changes) repository.saveShopPolicy(policy, {
            updatedBy: `batch_policy:${actor?.displayName || "authenticated_session"}`,
          });
        });
        applyPolicyRuntimeConfig(changes.filter((policy) => policy.mode !== "paused" && !servicesByShopId.has(policy.shopId))
          .map((policy) => catalogShops.get(policy.shopId)).filter(Boolean));
        return { settings: operationalSettings(), result: { requested: shopIds.length, updated: changes.length,
          skippedCount: skipped.length, updatedShopIds: changes.map((item) => item.shopId), skipped } };
      });
      return send(res, 200, { success: true, data: response });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/policy-imports/preview") {
      const payload = await body(req, 1536 * 1024);
      const filename = String(payload.filename || "").trim().slice(0, 180);
      const encoded = String(payload.fileBase64 || "").trim();
      const allowOverwrite = payload.allowOverwrite === true;
      if (!filename || !/\.(xlsx|csv)$/i.test(filename) || !encoded || encoded.length > 1400 * 1024
        || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) {
        throw new FulfillmentError("INVALID_POLICY_IMPORT_FILE", "请选择不超过 1MB 的 .xlsx 或 .csv 配置表", 400);
      }
      const file = Buffer.from(encoded, "base64");
      if (!file.length || file.length > 1024 * 1024) {
        throw new FulfillmentError("INVALID_POLICY_IMPORT_FILE", "配置表为空或超过 1MB", 400);
      }
      let parsed;
      try { parsed = parseFulfillmentPolicyWorkbook({ filename, buffer: file }); }
      catch (error) { throw new FulfillmentError("POLICY_IMPORT_PARSE_FAILED", String(error?.message || "配置表解析失败").slice(0, 300), 400); }
      if (!parsed.rows.length || parsed.rows.length > 500) {
        throw new FulfillmentError("INVALID_POLICY_IMPORT_ROWS", parsed.rows.length ? "配置表最多支持 500 家店铺" : "配置表没有可读取的店铺", 400);
      }
      prunePolicyImportPreviews();
      const catalogShops = new Map(repository.getRuntimeSetting("mabangShops", [])
        .map((shop) => [String(shop.shopId), shop]));
      const policies = new Map(repository.listShopPolicies().map((policy) => [policy.shopId, policy]));
      const rows = buildFulfillmentPolicyImportPreview({ rows: parsed.rows, shops: catalogShops,
        channels: repository.listChannelCatalog({ activeOnly: true }), warehouseOptions: allWarehouseOptions(), policies,
        allowOverwrite, hasAccess: hasShopAccess });
      const previewId = randomUUID();
      const expiresAtMs = Date.now() + 30 * 60 * 1000;
      policyImportPreviews.set(previewId, { previewId, filename, sheetName: parsed.sheetName, allowOverwrite,
        createdAt: new Date().toISOString(), expiresAtMs, rows });
      const ready = rows.filter((row) => row.ready).length;
      return send(res, 200, { success: true, data: { previewId, filename, sheetName: parsed.sheetName,
        allowOverwrite, expiresAt: new Date(expiresAtMs).toISOString(), summary: { total: rows.length, ready,
          needsReview: rows.length - ready }, rows } });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/policy-imports/confirm") {
      const payload = await body(req, 32 * 1024);
      const previewId = String(payload.previewId || "").trim();
      const rowIds = [...new Set((Array.isArray(payload.rowIds) ? payload.rowIds : []).map(String).map((value) => value.trim()).filter(Boolean))];
      if (!/^[a-f0-9-]{36}$/i.test(previewId) || !rowIds.length || rowIds.length > 500
        || rowIds.some((value) => !/^\d{1,4}$/.test(value))) {
        throw new FulfillmentError("INVALID_POLICY_IMPORT_CONFIRMATION", "请选择有效的导入配置行", 400);
      }
      prunePolicyImportPreviews();
      const preview = policyImportPreviews.get(previewId);
      if (!preview) throw new FulfillmentError("POLICY_IMPORT_PREVIEW_EXPIRED", "导入预览已过期，请重新上传配置表", 409);
      const actor = trustedActor(req);
      const response = await withPolicyConfigChange(async () => {
        const requested = new Set(rowIds);
        const selected = preview.rows.filter((row) => requested.has(row.id));
        const channels = new Map(repository.listChannelCatalog({ activeOnly: true }).map((channel) => [channel.channelId, channel]));
        const warehouses = new Set(allWarehouseOptions());
        const catalogShops = new Map(repository.getRuntimeSetting("mabangShops", []).map((shop) => [String(shop.shopId), shop]));
        const changes = []; const skipped = [];
        for (const row of selected) {
          const shop = catalogShops.get(row.shopId);
          const current = repository.getShopPolicy(row.shopId);
          const channel = channels.get(row.channelId);
          let reason = !row.ready ? "该行在预览中未通过校验" : !shop || !hasShopAccess(row.shopId)
            ? "店铺已不在当前账号权限范围" : !current ? "店铺配置不存在"
              : current.version !== row.policyVersion ? "预览后店铺配置已变化"
                : (!preview.allowOverwrite && current.updatedBy !== "catalog_sync") ? "已有人工确认配置"
                  : !channel ? "物流渠道已失效" : row.warehouses.some((name) => !warehouses.has(name)) ? "仓库目录已变化" : "";
          if (channel && shop && ((channel.platformId && String(channel.platformId) !== String(shop.platformId || ""))
            || (channel.countryCode && String(channel.countryCode).toUpperCase() !== String(shop.countryCode || "").toUpperCase()))) {
            reason = "物流渠道与店铺平台或国家不匹配";
          }
          if (reason) { skipped.push({ rowId: row.id, shopId: row.shopId, shopName: row.shopName, reason }); continue; }
          const validationConfig = { ...config, shopId: row.shopId, shopName: shop.shopName,
            platformId: String(shop.platformId || ""), platform: shop.platform || platformLabel(shop.platformId),
            countryCode: String(shop.countryCode || "").toUpperCase() };
          changes.push(validatedPolicy(validationConfig, { ...current, channelId: row.channelId,
            warehousePolicy: "allowlist", allowedWarehouses: row.warehouses }));
        }
        repository.transaction(() => {
          for (const policy of changes) repository.saveShopPolicy(policy, {
            updatedBy: `spreadsheet_import:${actor?.displayName || "authenticated_session"}`,
          });
        });
        applyPolicyRuntimeConfig();
        policyImportPreviews.delete(previewId);
        return { settings: operationalSettings(), result: { requested: rowIds.length, confirmed: changes.length,
          skippedCount: skipped.length + Math.max(0, rowIds.length - selected.length), skipped } };
      });
      return send(res, 200, { success: true, data: response });
    }
    let policyMatch = url.pathname.match(/^\/api\/fulfillment\/shops\/([^/]+)\/policy$/);
    if (req.method === "PUT" && policyMatch) {
      const shopId = decodeURIComponent(policyMatch[1]);
      const payload = await body(req);
      const actor = trustedActor(req);
      const settings = await withPolicyConfigChange(async () => {
        let shopService = servicesByShopId.get(shopId);
        const catalogShop = repository.getRuntimeSetting("mabangShops", []).find((shop) => String(shop.shopId) === shopId);
        if (!hasShopAccess(shopId) || (catalogLastSyncedAt && !catalogShop)) {
          throw new FulfillmentError("SHOP_ACCESS_REVOKED", "店铺已不属于当前马帮账号权限范围", 403);
        }
        if (!shopService && !catalogShop) throw new FulfillmentError("SHOP_NOT_CONFIGURED", "店铺不属于当前马帮账号", 404);
        const validationConfig = shopService?.config || { ...config, shopId, shopName: catalogShop.shopName,
          platformId: String(catalogShop.platformId || ""), platform: platformLabel(catalogShop.platformId),
          countryCode: String(catalogShop.countryCode || "").toUpperCase() };
        const policy = validatedPolicy(validationConfig, payload);
        repository.saveShopPolicy(policy, { updatedBy: actor?.displayName || "authenticated_session" });
        applyPolicyRuntimeConfig(!shopService && policy.mode !== "paused" ? [catalogShop] : []);
        return operationalSettings();
      });
      return send(res, 200, { success: true, data: settings });
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/agent/status") {
      return send(res, 200, { success: true, data: fulfillmentAgent.status() });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/agent/chat") {
      const payload = await body(req);
      return send(res, 200, { success: true, data: await fulfillmentAgent.chat(payload) });
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/dashboard") {
      const window = dashboardWindows(new Date(), url.searchParams.get("days"));
      return send(res, 200, { success: true, data: repository.getDashboardSummary(window, currentAccountShopIds()) });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/notifications/test") {
      const result = await notifier.notifyAndWait({ title: "马帮自动发货通知测试", message: "通知功能正常，后台服务可以向当前 Windows 桌面发送提醒。" });
      return send(res, result.delivered ? 200 : 409, { success: result.delivered, data: result.delivered ? result : undefined,
        error: result.delivered ? undefined : { code: result.code, message: result.message || "Windows 通知未启用" } });
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/scheduler") {
      return send(res, 200, { success: true, data: scheduler.status() });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/scheduler/scan") {
      if (operationalConfigChanging) {
        throw new FulfillmentError("FULFILLMENT_CONFIG_BUSY", "正在更新自动发货配置，请稍后再检查订单", 409);
      }
      try { return send(res, 200, { success: true, data: await scheduler.scanNow() }); }
      catch (error) { throw new FulfillmentError(error.code || "SCHEDULER_SCAN_FAILED", error.message || "定时扫描失败", 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/scheduler/pause") {
      return send(res, 200, { success: true, data: scheduler.pauseDispatch("已由操作员暂停；当前批次完成后不再处理后续队列。") });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/scheduler/resume") {
      return send(res, 200, { success: true, data: scheduler.resumeDispatch() });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/manual-reviews/recheck") {
      const payload = await body(req);
      const schedulerState = scheduler.status();
      if (schedulerState.scanning || schedulerState.activeBatch) {
        throw new FulfillmentError("FULFILLMENT_BUSY", "当前正在扫描或执行发货批次，请稍后重新核对", 409);
      }
      const shopService = serviceForShop(payload.shopId);
      try {
        const result = await shopService.recheckManualReview(payload.orderId, preflightsByShopId.get(shopService.config.shopId));
        return send(res, 200, { success: true, data: result });
      } catch (error) {
        if (error instanceof FulfillmentError) throw error;
        throw new FulfillmentError(error.code || "MANUAL_REVIEW_RECHECK_FAILED", error.message || "人工处理订单重新核对失败", 409);
      }
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/message-review-recoveries/candidates") {
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || config.messageReviewRecoveryLimit));
      return send(res, 200, { success: true, data: await messageReviewRecovery.listCandidates({ limit }) });
    }
    if (req.method === "PUT" && url.pathname === "/api/fulfillment/message-review-recoveries/mode") {
      const payload = await body(req);
      const mode = String(payload.mode || "").trim();
      if (!messageReviewModes.has(mode)) {
        throw new FulfillmentError("MESSAGE_REVIEW_MODE_INVALID", "待审核留言处理模式无效", 400);
      }
      const settings = await withPolicyConfigChange(async () => {
        if (mode !== "off" && !selectedMabangAccount.ok) {
          throw new FulfillmentError(selectedMabangAccount.code || "MABANG_ACCOUNT_NOT_CONNECTED",
            selectedMabangAccount.message || "请先连接马帮账号", 409);
        }
        repository.setRuntimeSetting("messageReviewRecoveryMode", mode);
        applyMessageReviewRuntimeConfig();
        return operationalSettings();
      });
      return send(res, 200, { success: true, data: settings });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/message-review-recoveries") {
      if (messageReviewMode() === "off") {
        throw new FulfillmentError("MESSAGE_REVIEW_RECOVERY_DISABLED", "待审核留言处理已关闭，请先切换到人工确认模式", 409);
      }
      const schedulerState = scheduler.status();
      if (schedulerState.scanning || schedulerState.activeBatch) {
        throw new FulfillmentError("FULFILLMENT_BUSY", "当前正在扫描或执行发货批次，请稍后处理待审核订单", 409);
      }
      const payload = await body(req);
      if (payload.confirmation !== "MESSAGE_REVIEW_RECOVERY_CONFIRMED") {
        throw new FulfillmentError("CONFIRMATION_INVALID", "确认标记无效", 400);
      }
      try {
        const recovered = await messageReviewRecovery.recover(payload.orderId);
        scheduler.queueMessageReviewFollowUp([recovered]);
        return send(res, 200, { success: true, data: recovered });
      } catch (error) {
        throw new FulfillmentError(error.code || "MESSAGE_REVIEW_RECOVERY_FAILED", error.message || "待审核留言订单处理失败", 409);
      }
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/batches") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      return send(res, 200, { success: true, data: repository.listRecentBatches(limit, currentAccountShopIds()) });
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/tracking-recoveries") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const items = repository.listTrackingRecoveries(limit, null, currentAccountShopIds());
      return send(res, 200, { success: true, data: items });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/tracking-recoveries/check") {
      const schedulerState = scheduler.status();
      if (schedulerState.scanning || schedulerState.activeBatch) {
        throw new FulfillmentError("FULFILLMENT_BUSY", "当前正在扫描或执行发货批次，请稍后回查运单号", 409);
      }
      const payload = await body(req);
      const selected = payload.shopId ? [serviceForShop(payload.shopId)] : services;
      const allowReset = payload.confirmation === "TRACKING_RECOVERY_CONFIRMED"
        && Boolean(String(payload.shopId || "").trim()) && Boolean(String(payload.orderId || "").trim());
      const results = [];
      for (const shopService of selected) results.push(await shopService.recoverPendingTrackingNumbers({
        limit: payload.orderId ? 1 : 5, orderId: payload.orderId || null, allowReset,
      }));
      return send(res, 200, { success: true, data: results });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/preflights") {
      const payload = await body(req);
      try { const shopService = serviceForShop(payload.shopId);
        return send(res, 200, { success: true, data: await shopService.runPreflight(payload.orderId, preflightsByShopId.get(shopService.config.shopId)) }); }
      catch (error) { throw new FulfillmentError(error.code || "PREFLIGHT_FAILED", error.message || "深度预检失败", error.code === "INVALID_ORDER_ID" ? 400 : 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/previews") {
      const payload = await body(req); const result = await serviceForShop(payload.shopId).createPreview(payload);
      return send(res, 201, { success: true, data: result });
    }
    let match = url.pathname.match(/^\/api\/fulfillment\/previews\/([^/]+)$/);
    if (req.method === "GET" && match) return send(res, 200, { success: true, data: serviceForPreview(match[1]).getPreview(match[1]) });
    match = url.pathname.match(/^\/api\/fulfillment\/previews\/([^/]+)\/confirmation-token$/);
    if (req.method === "POST" && match) return send(res, 200, { success: true, data: serviceForPreview(match[1]).issueConfirmationToken(match[1]) });
    match = url.pathname.match(/^\/api\/fulfillment\/previews\/([^/]+)\/confirm$/);
    if (req.method === "POST" && match) {
      const payload = await body(req); const result = serviceForPreview(match[1]).enqueuePreview(match[1], payload.confirmationToken);
      return send(res, 202, { success: true, data: result });
    }
    match = url.pathname.match(/^\/api\/fulfillment\/batches\/([^/]+)$/);
    if (req.method === "GET" && match) return send(res, 200, { success: true, data: service.getBatch(match[1]) });
    return send(res, 404, { success: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
  } catch (error) {
    const presented = presentFulfillmentError(error instanceof FulfillmentError ? error : null);
    send(res, presented.status, presented.body);
  }
});

server.listen(config.port, config.host, () => console.log(`Mabang fulfillment API listening on http://${config.host}:${config.port}`));
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  operationDrain.beginDrain();
  scheduler.stop();
  const operationsIdle = await operationDrain.waitForIdle();
  if (!operationsIdle) { console.error("Tracked fulfillment operations did not drain within 30 minutes; refusing forced shutdown."); shuttingDown = false; return; }
  await scheduler.waitForIdle();
  await Promise.all(services.map((shopService) => shopService.waitForIdle()));
  server.close(async () => { repository.close(); await fulfillmentV2Provider?.close(); process.exit(0); });
}
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
