import { createHash, randomUUID } from "node:crypto";
import { normalizeCanonicalShopName } from "../data-foundation/unified-normalizers.mjs";

const PRICE_FIELDS = Object.freeze({ REGULAR: "price", CAMPAIGN: "special_price" });
const PLATFORM_KEYS = Object.freeze({ LAZADA: "lazada", SHOPEE: "shopee", TIKTOK: "tiktokshop" });
const CONFIRMED_SHOP_IDENTITY = "CONFIRMED";
const MAX_SOURCE_CHANGES = 25;
const MAX_SHOP_ASSIGNMENTS = 100;

function text(value) { return String(value ?? "").trim(); }
function normalizedName(value) { return normalizeCanonicalShopName(value); }
function unique(values) { return [...new Set(values)]; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function fingerprint(value) { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function decimal(value) {
  const raw = text(value);
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = String(match[3] || "").replace(/0+$/, "");
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
}
function positiveDecimal(value) {
  const normalized = decimal(value);
  if (normalized === null) return false;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0;
}
function sameSet(left, right) {
  const a = unique(left.map(text).filter(Boolean)).sort();
  const b = unique(right.map(text).filter(Boolean)).sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
function acceptedProviderSkuMatch(raw, sourceSku) {
  const requested = text(raw?.requested_sku);
  const matched = text(raw?.matched_sku);
  const matchType = text(raw?.sku_match_type).toLowerCase();
  if (requested.toLowerCase() !== sourceSku.toLowerCase()) return false;
  if (matchType === "exact") return matched.toLowerCase() === sourceSku.toLowerCase();
  if (matchType !== "virtual") return false;
  const escaped = sourceSku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}S[1-9]$`, "i").test(matched);
}
function publicPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    sourceRoundId: plan.sourceRoundId,
    executionProvider: plan.executionProvider,
    status: plan.status,
    instructionText: plan.instructionText,
    previewFingerprint: plan.previewFingerprint,
    previewCreatedAt: plan.previewCreatedAt,
    previewExpiresAt: plan.previewExpiresAt,
    targetShopCount: plan.targetShopCount,
    listingChangeCount: plan.listingChangeCount,
    warnings: plan.warnings || [],
    selectedItemIds: plan.selectedItemIds || [],
    executionJobId: plan.executionJobId || null,
    executionState: plan.executionState || null,
    errorCode: plan.errorCode || null,
    errorMessage: plan.errorMessage || null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    items: (plan.items || []).map((item) => ({
      id: item.id,
      sourceChangeId: item.sourceChangeId,
      registryShopId: item.registryShopId,
      platform: item.platform,
      countryCode: item.countryCode,
      sku: item.sku,
      matchedSku: item.matchedSku,
      skuMatchType: item.skuMatchType,
      controlShopType: item.controlShopType,
      priceType: item.priceType,
      targetField: item.targetField,
      shopName: item.shopName,
      oldValue: item.oldValue,
      newValue: item.newValue,
      selected: item.selected,
      status: item.status,
    })),
  };
}

export class PriceControlRepricingError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "PriceControlRepricingError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status, message) { throw new PriceControlRepricingError(code, status, message); }

function assertConfirmedShopIdentities(shops, actionLabel) {
  const blocked = (shops || []).filter((shop) => shop?.identityStatus !== CONFIRMED_SHOP_IDENTITY);
  if (!blocked.length) return;
  const details = blocked.slice(0, 3).map((shop) =>
    `“${text(shop?.shopName) || text(shop?.id) || "未知店铺"}”(${text(shop?.identityStatus) || "身份状态缺失"})`).join("、");
  const remaining = blocked.length > 3 ? `等 ${blocked.length} 家店铺` : "";
  fail(
    "PRICE_CONTROL_REPRICING_SHOP_IDENTITY_UNCONFIRMED",
    409,
    `${details}${remaining}尚未完成平台、国家和店铺 ID 的唯一身份确认，已阻断${actionLabel}。请先在店铺配置中解决身份冲突并确认身份。`,
  );
}

function instructionFor(spec, index) {
  const platform = spec.change.platform === "SHOPEE" ? "Shopee" : "Lazada";
  const fieldLabel = spec.targetField === "price"
    ? (spec.change.platform === "SHOPEE" ? "原价（price）" : "售价（price）")
    : "促销价（special_price）";
  const shops = spec.shops.map((shop) => `“${shop.shopName.replace(/[“”]/g, "\"")}”`).join("、");
  return `${index + 1}. 在 ${platform} 平台、国家代码 ${spec.change.countryCode} 的 ${shops} 店铺中，`
    + `将 SKU“${spec.change.sku}”的${fieldLabel}设置为 ${spec.change.newPrice}；只生成差异预览，必须人工确认后才能同步。`;
}

function validateParsedCommands(commands, specs) {
  if (!Array.isArray(commands) || commands.length !== specs.length) {
    fail("PRICE_CONTROL_AI_COMMAND_COUNT_MISMATCH", 409, "AI 解析出的指令数量与所选控价变更不一致，已停止生成预览。");
  }
  const remaining = new Set(specs.map((_, index) => index));
  const ordered = [];
  for (const command of commands) {
    if (command?.need_confirm !== true || (command?.clarifications || []).length) {
      fail("PRICE_CONTROL_AI_COMMAND_UNSAFE", 409, "AI 指令未保留人工确认要求，或仍有待澄清信息。");
    }
    const platformValues = (command?.scope?.platforms || []).map((value) => text(value).toLowerCase());
    const countryValues = (command?.scope?.countries || []).map((value) => text(value).toUpperCase());
    const parsedNames = (command?.scope?.shop_names || []).map(normalizedName);
    const parsedIds = (command?.scope?.shop_ids || []).map(text);
    const matchIndex = [...remaining].find((index) => {
      const spec = specs[index];
      const expectedNames = spec.shops.map((shop) => normalizedName(shop.shopName));
      const expectedIds = spec.shops.map((shop) => text(shop.providerShopId));
      const scopeMatches = sameSet(parsedNames, expectedNames) || sameSet(parsedIds, expectedIds);
      const expectedAction = spec.targetField === "price" ? "price_update" : "promotion_update";
      return text(command?.action) === expectedAction
        && text(command?.target?.sku).toLowerCase() === spec.change.sku.toLowerCase()
        && sameSet(platformValues, [PLATFORM_KEYS[spec.change.platform]])
        && sameSet(countryValues, [spec.change.countryCode])
        && scopeMatches
        && text(command?.operation?.field) === spec.targetField
        && text(command?.operation?.mode) === "set"
        && decimal(command?.operation?.value) === decimal(spec.change.newPrice);
    });
    if (matchIndex === undefined) {
      fail("PRICE_CONTROL_AI_COMMAND_DRIFT", 409, "AI 解析结果偏离了已选择的国家、店铺、SKU、字段或目标价格，已阻断预览。");
    }
    remaining.delete(matchIndex);
    ordered.push(specs[matchIndex]);
  }
  return ordered;
}

export class PriceControlRepricingService {
  constructor({
    repository,
    priceControlRepository,
    shopRepository,
    executors,
    priceControlService = null,
    audit = null,
    now = () => new Date(),
  }) {
    if (!repository || !priceControlRepository || !shopRepository) throw new TypeError("Repricing repositories are required");
    this.repository = repository;
    this.priceControlRepository = priceControlRepository;
    this.shopRepository = shopRepository;
    this.executors = executors instanceof Map ? executors : new Map(Object.entries(executors || {}));
    this.priceControlService = priceControlService;
    this.audit = audit;
    this.now = now;
  }

  async assertReady() {
    if (!await this.repository.isReady()) {
      fail("PRICE_CONTROL_REPRICING_MIGRATION_REQUIRED", 503, "调价预览工作流迁移尚未应用。");
    }
  }

  async status() {
    return {
      workflowReady: await this.repository.isReady(),
      executionProviders: [...this.executors.keys()],
      limits: { maxSourceChanges: MAX_SOURCE_CHANGES, maxShopAssignments: MAX_SHOP_ASSIGNMENTS },
    };
  }

  async listShops(filters = {}) {
    const shops = await this.shopRepository.list({ ...filters, status: filters.status || "ACTIVE" });
    return shops.filter((shop) => shop.identityStatus === CONFIRMED_SHOP_IDENTITY);
  }

  async createPreview(input, { requestedBy = "commerce-ops" } = {}) {
    await this.assertReady();
    const assignments = Array.isArray(input?.assignments) ? input.assignments : [];
    if (!assignments.length || assignments.length > MAX_SOURCE_CHANGES) {
      fail("PRICE_CONTROL_REPRICING_SELECTION_INVALID", 400, `每次必须选择 1 到 ${MAX_SOURCE_CHANGES} 条控价变更。`);
    }
    const normalizedAssignments = assignments.map((assignment) => ({
      changeId: text(assignment?.changeId),
      shopIds: unique((assignment?.shopIds || []).map(text).filter(Boolean)),
    }));
    if (normalizedAssignments.some((item) => !item.changeId || !item.shopIds.length)
      || unique(normalizedAssignments.map((item) => item.changeId)).length !== normalizedAssignments.length) {
      fail("PRICE_CONTROL_REPRICING_ASSIGNMENT_INVALID", 400, "每条控价变更必须且只能配置一次非空店铺范围。");
    }
    const allShopIds = unique(normalizedAssignments.flatMap((item) => item.shopIds));
    if (normalizedAssignments.reduce((sum, item) => sum + item.shopIds.length, 0) > MAX_SHOP_ASSIGNMENTS) {
      fail("PRICE_CONTROL_REPRICING_SCOPE_TOO_LARGE", 413, `单次预览最多允许 ${MAX_SHOP_ASSIGNMENTS} 个变更/店铺组合。`);
    }

    const changeIds = normalizedAssignments.map((item) => item.changeId);
    const [changes, shops, latestRound] = await Promise.all([
      this.priceControlRepository.getChangesByIds(changeIds),
      this.shopRepository.getByIds(allShopIds),
      this.priceControlRepository.getLatestChangeRound(),
    ]);
    if (changes.length !== changeIds.length) fail("PRICE_CONTROL_REPRICING_CHANGE_NOT_FOUND", 404, "部分控价变更不存在。");
    if (shops.length !== allShopIds.length) fail("PRICE_CONTROL_REPRICING_SHOP_NOT_FOUND", 404, "部分目标店铺不存在。");
    assertConfirmedShopIdentities(shops, "调价预览");
    const roundId = text(input?.roundId || changes[0]?.syncRunId);
    if (!latestRound || roundId !== latestRound.id || changes.some((change) => change.syncRunId !== roundId)) {
      fail("PRICE_CONTROL_REPRICING_LATEST_ROUND_REQUIRED", 409, "只能基于最新一轮有效控价变更生成调价预览。");
    }
    if (changes.some((change) => change.validityStatus !== "VALID" || change.adjustmentStatus === "ADJUSTED")) {
      fail("PRICE_CONTROL_REPRICING_CHANGE_NOT_ACTIONABLE", 409, "所选变更包含失效或已处理记录。");
    }

    const changeMap = new Map(changes.map((change) => [change.id, change]));
    const shopMap = new Map(shops.map((shop) => [shop.id, shop]));
    const specs = [];
    const targetKeys = new Map();
    const warnings = [];
    for (const assignment of normalizedAssignments) {
      const change = changeMap.get(assignment.changeId);
      const targetField = PRICE_FIELDS[change.priceType];
      if (!targetField) {
        fail("PRICE_CONTROL_REPRICING_PRICE_TYPE_UNSUPPORTED", 409, `价格类型 ${change.priceType} 尚未映射到平台可写字段，不能猜测执行。`);
      }
      if (!PLATFORM_KEYS[change.platform] || change.platform === "TIKTOK") {
        fail("PRICE_CONTROL_REPRICING_PLATFORM_UNSUPPORTED", 409, `${change.platform} 当前没有可用的安全调价执行器。`);
      }
      if (!positiveDecimal(change.newPrice)) {
        fail("PRICE_CONTROL_REPRICING_TARGET_PRICE_INVALID", 409, "控价目标价格无效，不能生成调价预览。");
      }
      const assignedShops = assignment.shopIds.map((id) => shopMap.get(id));
      for (const shop of assignedShops) {
        if (shop.status !== "ACTIVE" || shop.platform !== change.platform || shop.countryCode !== change.countryCode) {
          fail("PRICE_CONTROL_REPRICING_SCOPE_MISMATCH", 409, `店铺“${shop.shopName}”与控价变更的平台或国家不一致。`);
        }
        if (!new Set(["UNKNOWN", "ALL", change.shopType]).has(shop.controlShopType)) {
          fail("PRICE_CONTROL_REPRICING_SHOP_TYPE_MISMATCH", 409, `店铺“${shop.shopName}”的控价类型与所选变更不一致。`);
        }
        if (shop.controlShopType === "UNKNOWN") {
          warnings.push(`店铺“${shop.shopName}”尚未标注 Standard/Mall；本次为人工明确选店，确认前必须再次承认该风险。`);
        }
        const targetKey = `${shop.id}\u001f${change.sku.toLowerCase()}\u001f${targetField}`;
        const prior = targetKeys.get(targetKey);
        if (prior) {
          fail("PRICE_CONTROL_REPRICING_SHOP_TARGET_AMBIGUOUS", 409,
            `店铺“${shop.shopName}”的 SKU ${change.sku} 同一价格字段被多个控价类型选中，请只保留正确的一条。`);
        }
        targetKeys.set(targetKey, change.id);
      }
      specs.push({ assignment, change, shops: assignedShops, targetField });
    }

    const providers = unique(shops.map((shop) => shop.executionProvider));
    if (providers.length !== 1) fail("PRICE_CONTROL_REPRICING_EXECUTOR_MIXED", 409, "一次预览不能混用不同的店铺执行器。");
    const executionProvider = providers[0];
    const executor = this.executors.get(executionProvider);
    if (!executor) fail("PRICE_CONTROL_REPRICING_EXECUTOR_UNAVAILABLE", 503, `${executionProvider} 调价执行器尚未配置。`);
    const sourceSystem = executionProvider === "MABANG_LISTING" ? "mabang" : "platform_gateway";
    const requiredCapabilities = unique(specs.map((spec) => spec.targetField));
    const accountId = await this.shopRepository.findCommonActiveAccount(
      allShopIds,
      sourceSystem,
      requiredCapabilities,
    );
    if (!accountId) {
      const accountWithoutCapabilityCheck = await this.shopRepository.findCommonActiveAccount(allShopIds, sourceSystem);
      if (accountWithoutCapabilityCheck) {
        fail("PRICE_CONTROL_REPRICING_ACCOUNT_CAPABILITY_MISSING", 409,
          "所选店铺的共同执行账户缺少本次价格字段写入能力。");
      }
      fail("PRICE_CONTROL_REPRICING_ACCOUNT_AMBIGUOUS", 409, "所选店铺没有唯一、共同且有效的执行账户。");
    }

    const instructionText = specs.map(instructionFor).join("\n");
    const createProviderPreview = async () => {
      const parsed = await executor.parseInstruction(instructionText);
      const parsedCommands = parsed?.commands || (parsed?.command ? [parsed.command] : []);
      const orderedSpecs = validateParsedCommands(parsedCommands, specs);
      const previewResponse = await executor.createPreview(instructionText, parsedCommands);
      return { parsed, parsedCommands, orderedSpecs, previewResponse };
    };
    const providerPreview = typeof executor.withAccount === "function"
      ? await executor.withAccount(accountId, createProviderPreview)
      : await (async () => {
        await executor.prepare(accountId);
        return createProviderPreview();
      })();
    const { parsed, parsedCommands, orderedSpecs, previewResponse } = providerPreview;
    const preview = previewResponse?.batch_preview;
    if (!preview?.preview_token || !Array.isArray(preview?.changes) || !preview.changes.length) {
      fail("PRICE_CONTROL_REPRICING_EMPTY_PREVIEW", 409, "马帮未生成任何可执行价格差异。");
    }
    const resolvedScopes = Array.isArray(previewResponse?.resolved_scopes) ? previewResponse.resolved_scopes : [];
    if (resolvedScopes.length !== orderedSpecs.length) {
      fail("PRICE_CONTROL_REPRICING_RESOLVED_SCOPE_MISMATCH", 409, "马帮实际解析的作用域数量发生变化，已阻断预览。");
    }
    for (let index = 0; index < resolvedScopes.length; index += 1) {
      const scope = resolvedScopes[index] || {};
      const spec = orderedSpecs[index];
      const expectedIds = spec.shops.map((shop) => text(shop.providerShopId));
      const resolvedIds = (scope.shops || []).map((shop) => text(shop?.id));
      if (text(scope.platform).toLowerCase() !== PLATFORM_KEYS[spec.change.platform]
        || !sameSet((scope.countries || []).map((value) => text(value).toUpperCase()), [spec.change.countryCode])
        || !sameSet(resolvedIds, expectedIds)) {
        fail("PRICE_CONTROL_REPRICING_RESOLVED_SCOPE_DRIFT", 409, "马帮最终解析的国家或店铺范围与人工选择不一致，已阻断预览。");
      }
    }

    const itemDrafts = [];
    const actualAssignmentKeys = new Set();
    const actualTargetKeys = new Set();
    for (const raw of preview.changes) {
      const rawCommandIndex = raw?.source_command_index;
      const commandIndex = rawCommandIndex === undefined || rawCommandIndex === null || rawCommandIndex === ""
        ? (orderedSpecs.length === 1 ? 1 : Number.NaN)
        : Number(rawCommandIndex);
      if (!Number.isInteger(commandIndex) || commandIndex < 1 || commandIndex > orderedSpecs.length) {
        fail("PRICE_CONTROL_REPRICING_PREVIEW_COMMAND_INVALID", 409, "马帮差异缺少有效的源指令序号，无法安全关联控价变更。");
      }
      const spec = orderedSpecs[commandIndex - 1];
      const providerShopId = text(raw?.shop_id);
      const shop = spec.shops.find((item) => text(item.providerShopId) === providerShopId);
      if (!shop || text(raw?.platform).toLowerCase() !== PLATFORM_KEYS[spec.change.platform]
        || text(raw?.field) !== spec.targetField
        || !acceptedProviderSkuMatch(raw, spec.change.sku)
        || decimal(raw?.old_value) === null
        || decimal(raw?.new_value) !== decimal(spec.change.newPrice)) {
        fail("PRICE_CONTROL_REPRICING_PREVIEW_DRIFT", 409, "马帮实际差异包含未授权的店铺、SKU、字段或目标价格，已阻断预览。");
      }
      if (!text(raw?.change_id) || !text(raw?.internal_id) || !text(raw?.variation_key)) {
        fail("PRICE_CONTROL_REPRICING_PREVIEW_INCOMPLETE", 409, "马帮差异缺少执行所需的唯一标识。");
      }
      const actualTargetKey = [spec.change.platform, providerShopId, text(raw.internal_id),
        text(raw.variation_key), spec.targetField].join("\u001f").toLowerCase();
      if (actualTargetKeys.has(actualTargetKey)) {
        fail("PRICE_CONTROL_REPRICING_PREVIEW_TARGET_DUPLICATED", 409,
          "马帮差异重复指向同一商品、变体和价格字段，已阻断预览。");
      }
      actualTargetKeys.add(actualTargetKey);
      actualAssignmentKeys.add(`${spec.change.id}\u001f${shop.id}`);
      if (text(raw?.sku_match_type).toLowerCase() === "virtual") {
        warnings.push(`控价 SKU“${spec.change.sku}”在店铺“${shop.shopName}”匹配到实际虚拟 SKU“${text(raw.matched_sku)}”；执行前必须逐条人工核对。`);
      }
      itemDrafts.push({
        id: randomUUID(),
        sourceChangeId: spec.change.id,
        sourceCommandIndex: commandIndex,
        registryShopId: shop.id,
        providerChangeId: text(raw.change_id),
        platform: spec.change.platform,
        countryCode: spec.change.countryCode,
        sku: spec.change.sku,
        controlShopType: shop.controlShopType,
        priceType: spec.change.priceType,
        targetField: spec.targetField,
        providerShopId,
        shopName: shop.shopName,
        internalListingId: text(raw.internal_id),
        variationKey: text(raw.variation_key),
        oldValue: raw.old_value,
        newValue: raw.new_value,
        rawPreview: raw,
      });
    }
    for (const spec of specs) {
      for (const shop of spec.shops) {
        if (!actualAssignmentKeys.has(`${spec.change.id}\u001f${shop.id}`)) {
          warnings.push(`店铺“${shop.shopName}”未找到控价 SKU“${spec.change.sku}”，因此本次没有生成该店铺的执行差异。`);
        }
      }
    }
    warnings.push(...(preview.warnings || []).map(text).filter(Boolean));

    const createdAt = this.now();
    const providerExpiresIn = Number(preview.expires_in_seconds);
    if (!Number.isFinite(providerExpiresIn) || providerExpiresIn <= 0) {
      fail("PRICE_CONTROL_REPRICING_PREVIEW_EXPIRED", 409, "马帮返回的实时差异预览已经过期，请重新读取商品价格。");
    }
    const expiresIn = Math.min(providerExpiresIn, 15 * 60);
    const planId = randomUUID();
    const previewCreatedAt = text(preview.created_at) || createdAt.toISOString();
    const previewExpiresAt = new Date(createdAt.getTime() + expiresIn * 1000).toISOString();
    const previewFingerprint = fingerprint({
      planId, roundId, executionProvider, accountId, instructionText, parsedCommands,
      changes: itemDrafts.map((item) => ({
        sourceChangeId: item.sourceChangeId, registryShopId: item.registryShopId,
        providerChangeId: item.providerChangeId, oldValue: item.oldValue, newValue: item.newValue,
      })),
      previewCreatedAt, previewExpiresAt,
    });
    const plan = await this.repository.createPreviewPlan({
      plan: {
        id: planId,
        sourceRoundId: roundId,
        accountId,
        executionProvider,
        instructionText,
        sourceAssignments: normalizedAssignments,
        aiProvider: parsed?.provider || previewResponse?.provider || {},
        parsedCommands,
        previewToken: preview.preview_token,
        previewFingerprint,
        previewCreatedAt,
        previewExpiresAt,
        targetShopCount: allShopIds.length,
        warnings: unique(warnings),
        createdBy: text(requestedBy).slice(0, 128) || "commerce-ops",
        createdAt: createdAt.toISOString(),
      },
      items: itemDrafts,
    });
    await this.audit?.recordSafely({
      module: "price_control",
      action: "product.price_control.repricing.previewed",
      status: "success",
      actorType: "user",
      actorIdentifier: requestedBy,
      runId: roundId,
      metadata: { syncRunId: roundId, provider: executionProvider.toLowerCase(), changeCount: itemDrafts.length, rowCount: allShopIds.length },
    });
    return publicPlan(plan);
  }

  async getPlan(id) {
    await this.assertReady();
    const plan = await this.repository.getPlan(text(id));
    if (!plan) fail("PRICE_CONTROL_REPRICING_PLAN_NOT_FOUND", 404, "调价预览不存在。");
    if (plan.status === "PREVIEW_READY" && plan.previewExpiresAt <= this.now().toISOString()) {
      return publicPlan(await this.repository.markExpired(plan.id, this.now()));
    }
    return publicPlan(plan);
  }

  async listPlans(filters = {}) {
    await this.assertReady();
    return { plans: (await this.repository.listPlans(filters)).map(publicPlan) };
  }

  async confirm(id, input, { requestedBy = "commerce-ops" } = {}) {
    await this.assertReady();
    if (input?.confirmed !== true || text(input?.confirmationText) !== "确认同步到店铺") {
      fail("PRICE_CONTROL_REPRICING_EXPLICIT_CONFIRMATION_REQUIRED", 400, "必须明确输入“确认同步到店铺”才能执行。");
    }
    const plan = await this.repository.getPlan(text(id), { includeCapability: true });
    if (!plan) fail("PRICE_CONTROL_REPRICING_PLAN_NOT_FOUND", 404, "调价预览不存在。");
    if (plan.status !== "PREVIEW_READY") fail("PRICE_CONTROL_REPRICING_STATE_INVALID", 409, "该调价预览当前不能再次确认执行。");
    if (plan.previewExpiresAt <= this.now().toISOString()) {
      await this.repository.markExpired(plan.id, this.now());
      fail("PRICE_CONTROL_REPRICING_PREVIEW_EXPIRED", 409, "调价预览已过期，请重新读取店铺实时价格并生成预览。");
    }
    if (text(input?.previewFingerprint) !== plan.previewFingerprint) {
      fail("PRICE_CONTROL_REPRICING_PREVIEW_CHANGED", 409, "确认指纹与当前预览不一致，请重新核对差异。");
    }
    const selectedItemIds = unique((input?.selectedItemIds || []).map(text).filter(Boolean));
    const selectable = new Map(plan.items.filter((item) => item.status === "PREVIEWED").map((item) => [item.id, item]));
    if (!selectedItemIds.length || selectedItemIds.some((itemId) => !selectable.has(itemId))) {
      fail("PRICE_CONTROL_REPRICING_ITEM_SELECTION_INVALID", 400, "必须从当前预览中至少选择一条有效差异。");
    }
    const selectedItems = selectedItemIds.map((itemId) => selectable.get(itemId));
    if (selectedItems.some((item) => item.controlShopType === "UNKNOWN")
      && input?.acknowledgeUnknownShopTypes !== true) {
      fail("PRICE_CONTROL_REPRICING_SHOP_TYPE_ACK_REQUIRED", 400, "所选店铺尚未标注 Standard/Mall，必须明确承认后才能同步。");
    }
    const sourceChangeIds = unique(selectedItems.map((item) => item.sourceChangeId));
    const registryShopIds = unique(selectedItems.map((item) => item.registryShopId));
    const sourceSystem = plan.executionProvider === "MABANG_LISTING" ? "mabang" : "platform_gateway";
    const [latestRound, currentChanges, currentShops, currentAccountId] = await Promise.all([
      this.priceControlRepository.getLatestChangeRound(),
      this.priceControlRepository.getChangesByIds(sourceChangeIds),
      this.shopRepository.getByIds(registryShopIds),
      this.shopRepository.findCommonActiveAccount(
        registryShopIds,
        sourceSystem,
        unique(selectedItems.map((item) => item.targetField)),
      ),
    ]);
    assertConfirmedShopIdentities(currentShops, "调价确认与执行");
    if (!latestRound || latestRound.id !== plan.sourceRoundId) {
      fail("PRICE_CONTROL_REPRICING_PREVIEW_SUPERSEDED", 409, "预览生成后已出现新的控价变更轮次，请基于最新轮次重新生成实际差异。");
    }
    if (currentChanges.length !== sourceChangeIds.length
      || currentChanges.some((change) => change.syncRunId !== plan.sourceRoundId
        || change.validityStatus !== "VALID" || change.adjustmentStatus === "ADJUSTED")) {
      fail("PRICE_CONTROL_REPRICING_CHANGE_NO_LONGER_ACTIONABLE", 409, "部分控价变更已失效或已处理，请重新生成预览。");
    }
    const currentShopMap = new Map(currentShops.map((shop) => [shop.id, shop]));
    if (currentShops.length !== registryShopIds.length
      || selectedItems.some((item) => {
        const shop = currentShopMap.get(item.registryShopId);
        return !shop || shop.status !== "ACTIVE" || shop.platform !== item.platform
          || shop.countryCode !== item.countryCode || shop.executionProvider !== plan.executionProvider
          || text(shop.providerShopId) !== text(item.providerShopId)
          || shop.controlShopType !== item.controlShopType;
      })
      || currentAccountId !== plan.accountId) {
      fail("PRICE_CONTROL_REPRICING_SHOP_SCOPE_CHANGED", 409, "店铺范围、类型、授权账户或执行通道已变化，请重新生成预览。");
    }
    const claimed = await this.repository.claimConfirmation({
      id: plan.id,
      previewFingerprint: plan.previewFingerprint,
      selectedItemIds,
      confirmedBy: text(requestedBy).slice(0, 128) || "commerce-ops",
      now: this.now(),
    });
    if (!claimed) fail("PRICE_CONTROL_REPRICING_CONFIRMATION_CONFLICT", 409, "调价预览已过期、已确认或已发生变化。");
    const providerChangeIds = claimed.items.filter((item) => item.selected).map((item) => item.providerChangeId);
    let acceptedJob = null;
    try {
      const executor = this.executors.get(claimed.executionProvider);
      if (!executor) fail("PRICE_CONTROL_REPRICING_EXECUTOR_UNAVAILABLE", 503, "调价执行器不可用；计划已锁定，不能重复提交。");
      acceptedJob = typeof executor.withAccount === "function"
        ? await executor.withAccount(claimed.accountId,
          () => executor.execute(claimed.previewToken, providerChangeIds))
        : await (async () => {
          await executor.prepare(claimed.accountId);
          return executor.execute(claimed.previewToken, providerChangeIds);
        })();
      if (!text(acceptedJob?.job_id)) {
        throw Object.assign(new Error("马帮可能已受理调价，但响应缺少任务编号；禁止重复提交，需人工核对。"), {
          code: "MABANG_REPRICING_EXECUTION_JOB_ID_MISSING",
          outcomeUnknown: true,
        });
      }
      const updated = await this.repository.markExecutionStarted(claimed.id, acceptedJob, this.now());
      await this.audit?.recordSafely({
        module: "price_control", action: "product.price_control.repricing.confirmed", status: "success",
        actorType: "user", actorIdentifier: requestedBy, runId: claimed.sourceRoundId,
        metadata: { provider: claimed.executionProvider.toLowerCase(), changeCount: providerChangeIds.length, result: "submitted" },
      });
      return publicPlan(updated);
    } catch (error) {
      const persistenceUnknown = acceptedJob && !error?.outcomeUnknown;
      const recordedError = persistenceUnknown
        ? Object.assign(new Error("马帮已受理调价，但本地任务状态保存失败；禁止重复提交，请按任务 ID 回查。", { cause: error }), {
          code: "PRICE_CONTROL_REPRICING_STATE_PERSISTENCE_UNKNOWN",
          outcomeUnknown: true,
        })
        : error;
      const updated = recordedError?.outcomeUnknown
        ? await this.repository.markExecutionUnknown(claimed.id, recordedError, this.now(), acceptedJob)
        : await this.repository.markExecutionFailed(claimed.id, error, this.now());
      await this.audit?.recordSafely({
        module: "price_control", action: "product.price_control.repricing.execute_failed", status: "failed",
        actorType: "user", actorIdentifier: requestedBy, runId: claimed.sourceRoundId,
        errorStage: "repricing_execute", errorCode: recordedError?.code || "PRICE_CONTROL_REPRICING_EXECUTE_FAILED", errorSummary: recordedError,
        metadata: { provider: claimed.executionProvider.toLowerCase(), changeCount: providerChangeIds.length },
      });
      if (recordedError?.outcomeUnknown) return publicPlan(updated);
      throw error;
    }
  }

  async refresh(id, { requestedBy = "commerce-ops" } = {}) {
    await this.assertReady();
    const plan = await this.repository.getPlan(text(id), { includeCapability: true });
    if (!plan) fail("PRICE_CONTROL_REPRICING_PLAN_NOT_FOUND", 404, "调价计划不存在。");
    if (!["EXECUTING", "EXECUTION_UNKNOWN"].includes(plan.status) || !plan.executionJobId) return publicPlan(plan);
    const executor = this.executors.get(plan.executionProvider);
    if (!executor) fail("PRICE_CONTROL_REPRICING_EXECUTOR_UNAVAILABLE", 503, "调价执行器不可用。");
    const job = typeof executor.withAccount === "function"
      ? await executor.withAccount(plan.accountId, () => executor.getJob(plan.executionJobId))
      : await (async () => {
        await executor.prepare(plan.accountId);
        return executor.getJob(plan.executionJobId);
      })();
    const updated = await this.repository.updateJob(plan.id, job, this.now());
    if (["SUCCEEDED", "PARTIAL", "FAILED"].includes(updated.status)) {
      await this.recordCompletedAdjustments(updated, requestedBy);
      await this.audit?.recordSafely({
        module: "price_control", action: "product.price_control.repricing.executed",
        status: updated.status === "FAILED" ? "failed" : "success",
        actorType: "user", actorIdentifier: requestedBy, runId: updated.sourceRoundId,
        errorStage: updated.status === "FAILED" ? "repricing_job" : null,
        errorCode: updated.status === "FAILED" ? "MABANG_REPRICING_JOB_FAILED" : null,
        metadata: { provider: updated.executionProvider.toLowerCase(), result: updated.status.toLowerCase(), changeCount: updated.items.filter((item) => item.selected).length },
      });
    }
    return publicPlan(updated);
  }

  async recordCompletedAdjustments(plan, requestedBy) {
    if (!this.priceControlService) return;
    const assignedShopIds = new Map((plan.sourceAssignments || []).map((assignment) => [
      assignment.changeId,
      unique((assignment.shopIds || []).map(text).filter(Boolean)),
    ]));
    const grouped = new Map();
    for (const item of plan.items) {
      if (!grouped.has(item.sourceChangeId)) grouped.set(item.sourceChangeId, []);
      grouped.get(item.sourceChangeId).push(item);
    }
    for (const [changeId, items] of grouped) {
      const expectedShopIds = assignedShopIds.get(changeId) || [];
      const actualShopIds = unique(items.map((item) => item.registryShopId));
      if (!items.length || (expectedShopIds.length && !sameSet(actualShopIds, expectedShopIds))
        || items.some((item) => !item.selected || item.status !== "SUCCEEDED")) continue;
      await this.priceControlService.updateAdjustment(changeId, {
        status: "ADJUSTED",
        remark: `调价计划 ${plan.id} 已通过 ${plan.executionProvider} 执行并回读成功。`,
      }, { requestedBy });
    }
  }
}

export const repricingLimits = Object.freeze({
  maxSourceChanges: MAX_SOURCE_CHANGES,
  maxShopAssignments: MAX_SHOP_ASSIGNMENTS,
});
