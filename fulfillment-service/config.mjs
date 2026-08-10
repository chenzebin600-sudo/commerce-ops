import fs from "node:fs";
import path from "node:path";

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function integer(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`配置值必须是 ${min}-${max} 的整数`);
  return parsed;
}

function requiredText(value, label, { pattern = null, max = 300 } = {}) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || (pattern && !pattern.test(text))) throw new Error(`发货配置 ${label} 无效`);
  return text;
}

function readShopCatalog(appRoot, env) {
  const catalogPath = path.resolve(appRoot, env.FULFILLMENT_SHOP_CONFIG_PATH || "config/fulfillment-shops.json");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8")); }
  catch (error) { throw new Error(`无法读取发货店铺配置 ${catalogPath}: ${error.message}`); }
  if (parsed?.version !== 1 || !Array.isArray(parsed.channels) || !Array.isArray(parsed.shops)) {
    throw new Error("发货店铺配置版本或数据结构无效");
  }
  if (!parsed.channels.length || !parsed.shops.length || parsed.channels.length > 100 || parsed.shops.length > 500) {
    throw new Error("发货店铺配置的渠道或店铺数量无效");
  }

  const channelProfiles = new Map();
  for (const raw of parsed.channels) {
    const profileId = requiredText(raw.profileId, "channel.profileId", { pattern: /^[a-z0-9][a-z0-9_-]{0,79}$/i, max: 80 });
    if (channelProfiles.has(profileId)) throw new Error(`发货渠道配置重复：${profileId}`);
    const channel = {
      profileId,
      countryCode: requiredText(raw.countryCode, `${profileId}.countryCode`, { pattern: /^[A-Z]{2,3}$/, max: 3 }),
      platformId: requiredText(raw.platformId, `${profileId}.platformId`, { pattern: /^\d{1,24}$/, max: 24 }),
      channelId: requiredText(raw.channelId, `${profileId}.channelId`, { pattern: /^\d{1,24}$/, max: 24 }),
      channelProviderId: requiredText(raw.channelProviderId, `${profileId}.channelProviderId`, { pattern: /^\d{1,24}$/, max: 24 }),
      channelLogisticsId: requiredText(raw.channelLogisticsId, `${profileId}.channelLogisticsId`, { pattern: /^\d{1,24}$/, max: 24 }),
      channelSource: requiredText(raw.channelSource ?? "1", `${profileId}.channelSource`, { pattern: /^\d{1,8}$/, max: 8 }),
      channelValue: requiredText(raw.channelValue, `${profileId}.channelValue`, { max: 500 }),
      channelName: requiredText(raw.channelName, `${profileId}.channelName`, { max: 300 }),
    };
    if (!channel.channelValue.startsWith(`${channel.channelId}_${channel.channelProviderId}_`)
      || !channel.channelValue.endsWith(`_${channel.channelLogisticsId}`)) {
      throw new Error(`发货渠道 ${profileId} 的 channelValue 与渠道 ID 不一致`);
    }
    channelProfiles.set(profileId, Object.freeze(channel));
  }

  const shopIds = new Set();
  const shopNames = new Set();
  const shops = parsed.shops.map((raw) => {
    const shopId = requiredText(raw.shopId, "shop.shopId", { pattern: /^\d{1,24}$/, max: 24 });
    const shopName = requiredText(raw.shopName, `${shopId}.shopName`, { max: 160 });
    if (shopIds.has(shopId)) throw new Error(`发货店铺 ID 重复：${shopId}`);
    if (shopNames.has(shopName)) throw new Error(`发货店铺名称重复：${shopName}`);
    shopIds.add(shopId); shopNames.add(shopName);
    const platform = requiredText(raw.platform, `${shopId}.platform`, { max: 80 });
    const platformId = requiredText(raw.platformId, `${shopId}.platformId`, { pattern: /^\d{1,24}$/, max: 24 });
    const countryCode = requiredText(raw.countryCode, `${shopId}.countryCode`, { pattern: /^[A-Z]{2,3}$/, max: 3 });
    const channelProfileId = requiredText(raw.channelProfileId, `${shopId}.channelProfileId`, { pattern: /^[a-z0-9][a-z0-9_-]{0,79}$/i, max: 80 });
    const channel = channelProfiles.get(channelProfileId);
    if (!channel) throw new Error(`店铺 ${shopName} 引用了不存在的渠道 ${channelProfileId}`);
    if (channel.countryCode !== countryCode || channel.platformId !== platformId) {
      throw new Error(`店铺 ${shopName} 与渠道 ${channelProfileId} 的国家或平台不一致`);
    }
    if (!Array.isArray(raw.allowedWarehouses || [])) throw new Error(`店铺 ${shopName} 的 allowedWarehouses 必须是数组`);
    const allowedWarehouses = [...new Set((raw.allowedWarehouses || [])
      .map((value) => requiredText(value, `${shopId}.allowedWarehouses`, { max: 160 })) )];
    return Object.freeze({ shopId, shopName, platform, platformId, countryCode, channelProfileId,
      allowedWarehouses: Object.freeze(allowedWarehouses), configuredAutoFulfillEnabled: raw.autoFulfillEnabled === true,
      ...channel });
  });
  const defaultShopId = requiredText(parsed.defaultShopId, "defaultShopId", { pattern: /^\d{1,24}$/, max: 24 });
  if (!shopIds.has(defaultShopId)) throw new Error("发货配置 defaultShopId 不属于已配置店铺");
  return { catalogPath, defaultShopId, shops };
}

function readAutoFulfillAuthorization(appRoot, env) {
  const authorizationPath = path.resolve(appRoot,
    env.FULFILLMENT_AUTO_FULFILL_SHOP_CONFIG_PATH || "config/fulfillment-auto-fulfill-shops.json");
  if (!fs.existsSync(authorizationPath)) return { authorizationPath, shopIds: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(authorizationPath, "utf8")); }
  catch (error) { throw new Error(`无法读取自动发货授权配置 ${authorizationPath}: ${error.message}`); }
  if (parsed?.version !== 1 || !Array.isArray(parsed.shopIds) || parsed.shopIds.length > 500) {
    throw new Error("自动发货授权配置版本或店铺列表无效");
  }
  const shopIds = [...new Set(parsed.shopIds.map((value) => requiredText(value,
    "autoFulfillAuthorization.shopId", { pattern: /^\d{1,24}$/, max: 24 })))];
  if (shopIds.length !== parsed.shopIds.length) throw new Error("自动发货授权配置包含重复店铺 ID");
  return { authorizationPath, shopIds };
}

export function resolveFulfillmentConfig({ rootDir, env = process.env } = {}) {
  const appRoot = path.resolve(rootDir || process.cwd());
  const catalog = readShopCatalog(appRoot, env);
  const authorization = readAutoFulfillAuthorization(appRoot, env);
  const autoFulfillEnabled = flag(env.FULFILLMENT_AUTO_FULFILL_ENABLED);
  const fulfillmentV2Enabled = flag(env.FULFILLMENT_V2_ENABLED);
  const fulfillmentV2ShadowWriteEnabled = flag(env.FULFILLMENT_V2_SHADOW_WRITE_ENABLED);
  const fulfillmentV2DatabaseUrl = String(env.FULFILLMENT_V2_DATABASE_URL || "").trim();
  const fulfillmentActorAssertionSecret = String(env.FULFILLMENT_ACTOR_ASSERTION_SECRET || "");
  if (fulfillmentV2ShadowWriteEnabled && !fulfillmentV2Enabled) {
    throw new Error("FULFILLMENT_V2_SHADOW_WRITE_ENABLED requires FULFILLMENT_V2_ENABLED");
  }
  if (fulfillmentV2Enabled) {
    let databaseUrl;
    try { databaseUrl = new URL(fulfillmentV2DatabaseUrl); }
    catch { throw new Error("FULFILLMENT_V2_DATABASE_URL is invalid"); }
    if (!new Set(["postgres:", "postgresql:"]).has(databaseUrl.protocol)) {
      throw new Error("FULFILLMENT_V2_DATABASE_URL must use PostgreSQL");
    }
    if (Buffer.byteLength(fulfillmentActorAssertionSecret, "utf8") < 32) {
      throw new Error("FULFILLMENT_ACTOR_ASSERTION_SECRET must contain at least 32 bytes");
    }
  }
  const autoFulfillShopIds = new Set([
    ...String(env.FULFILLMENT_AUTO_FULFILL_SHOP_IDS || "").split(",").map((value) => value.trim()).filter(Boolean),
    ...authorization.shopIds,
  ]);
  const shops = Object.freeze(catalog.shops.map((shop) => Object.freeze({ ...shop,
    autoFulfillEnabled: autoFulfillEnabled && shop.configuredAutoFulfillEnabled && autoFulfillShopIds.has(shop.shopId) })));
  const defaultShop = shops.find((shop) => shop.shopId === catalog.defaultShopId);
  return Object.freeze({
    host: String(env.FULFILLMENT_HOST || "127.0.0.1"),
    port: integer(env.FULFILLMENT_PORT, 3112, { max: 65535 }),
    apiToken: String(env.FULFILLMENT_API_TOKEN || "").trim(),
    databasePath: path.resolve(appRoot, env.FULFILLMENT_DB_PATH || "storage/mabang-fulfillment.sqlite"),
    shopConfigPath: catalog.catalogPath,
    ...defaultShop,
    shops,
    pendingStatus: "待处理",
    pendingStatusId: "2",
    maxBatchSize: integer(env.FULFILLMENT_MAX_BATCH_SIZE, 10, { max: 10 }),
    backlogBatchesPerScan: integer(env.FULFILLMENT_BACKLOG_BATCHES_PER_SCAN, 5, { min: 1, max: 10 }),
    minOrderAgeMinutes: integer(env.FULFILLMENT_MIN_ORDER_AGE_MINUTES, 10, { min: 2, max: 60 }),
    orderConcurrency: integer(env.FULFILLMENT_ORDER_CONCURRENCY, 1, { min: 1, max: 2 }),
    previewTtlSeconds: integer(env.FULFILLMENT_PREVIEW_TTL_SECONDS, 600, { min: 60, max: 3600 }),
    realSubmitEnabled: flag(env.FULFILLMENT_REAL_SUBMIT_ENABLED),
    mabangUsername: String(env.FULFILLMENT_MABANG_USERNAME || "").trim(),
    mabangPassword: String(env.FULFILLMENT_MABANG_PASSWORD || ""),
    lookbackDays: integer(env.FULFILLMENT_LOOKBACK_DAYS, 7, { max: 30 }),
    scanMaxPages: integer(env.FULFILLMENT_SCAN_MAX_PAGES, 500, { min: 100, max: 1000 }),
    verificationTimeoutSeconds: integer(env.FULFILLMENT_VERIFY_TIMEOUT_SECONDS, 90, { min: 15, max: 300 }),
    trackingWaitTimeoutSeconds: integer(env.FULFILLMENT_TRACKING_WAIT_TIMEOUT_SECONDS, 30, { min: 10, max: 120 }),
    distributionVerifyTimeoutSeconds: integer(env.FULFILLMENT_DISTRIBUTION_VERIFY_TIMEOUT_SECONDS, 12, { min: 5, max: 60 }),
    trackingRecoveryCheckSeconds: integer(env.FULFILLMENT_TRACKING_RECOVERY_CHECK_SECONDS, 300, { min: 60, max: 3600 }),
    trackingRecoveryResetMinutes: integer(env.FULFILLMENT_TRACKING_RECOVERY_RESET_MINUTES, 30, { min: 15, max: 720 }),
    trackingRecoveryDeadlineHours: integer(env.FULFILLMENT_TRACKING_RECOVERY_DEADLINE_HOURS, 24, { min: 1, max: 72 }),
    trackingRecoveryResetEnabled: flag(env.FULFILLMENT_TRACKING_RECOVERY_RESET_ENABLED),
    messageReviewRecoveryEnabled: flag(env.FULFILLMENT_MESSAGE_REVIEW_RECOVERY_ENABLED),
    messageReviewRecoveryLimit: integer(env.FULFILLMENT_MESSAGE_REVIEW_RECOVERY_LIMIT, 3, { min: 1, max: 10 }),
    messageReviewRecoveryIntervalMinutes: integer(env.FULFILLMENT_MESSAGE_REVIEW_RECOVERY_INTERVAL_MINUTES, 30, { min: 5, max: 1440 }),
    messageReviewFollowUpDelaySeconds: integer(env.FULFILLMENT_MESSAGE_REVIEW_FOLLOW_UP_DELAY_SECONDS, 30, { min: 5, max: 300 }),
    schedulerEnabled: flag(env.FULFILLMENT_SCHEDULER_ENABLED),
    schedulerIntervalSeconds: integer(env.FULFILLMENT_SCHEDULER_INTERVAL_SECONDS, 300, { min: 60, max: 86400 }),
    catchUpEnabled: flag(env.FULFILLMENT_CATCH_UP_ENABLED ?? "true"),
    catchUpThresholdOrders: integer(env.FULFILLMENT_CATCH_UP_THRESHOLD_ORDERS, 20, { min: 10, max: 500 }),
    catchUpLowWaterOrders: integer(env.FULFILLMENT_CATCH_UP_LOW_WATER_ORDERS, 10, { min: 0, max: 100 }),
    catchUpMaxWaitMinutes: integer(env.FULFILLMENT_CATCH_UP_MAX_WAIT_MINUTES, 30, { min: 5, max: 1440 }),
    catchUpRefillDelaySeconds: integer(env.FULFILLMENT_CATCH_UP_REFILL_DELAY_SECONDS, 3, { min: 1, max: 60 }),
    dispatchFailureCircuitThreshold: integer(env.FULFILLMENT_DISPATCH_FAILURE_CIRCUIT_THRESHOLD, 3, { min: 2, max: 10 }),
    autoFulfillEnabled,
    autoFulfillShopIds: Object.freeze([...autoFulfillShopIds]),
    autoFulfillAuthorizationPath: authorization.authorizationPath,
    windowsNotificationsEnabled: flag(env.FULFILLMENT_WINDOWS_NOTIFICATIONS_ENABLED),
    fulfillmentAgentEnabled: flag(env.FULFILLMENT_AGENT_ENABLED ?? "true"),
    fulfillmentAgentModel: String(env.FULFILLMENT_AGENT_MODEL || env.DEEPSEEK_MODEL || "deepseek-chat").trim(),
    fulfillmentAgentMaxSteps: integer(env.FULFILLMENT_AGENT_MAX_STEPS, 6, { min: 1, max: 8 }),
    fulfillmentV2Enabled,
    fulfillmentV2ShadowWriteEnabled,
    fulfillmentV2DatabaseUrl,
    fulfillmentActorAssertionSecret,
  });
}

export function isShopAutoFulfillAuthorized(config, shopId) {
  const normalizedShopId = String(shopId || "").trim();
  return Boolean(config?.autoFulfillEnabled && normalizedShopId
    && config.autoFulfillShopIds?.includes(normalizedShopId));
}
