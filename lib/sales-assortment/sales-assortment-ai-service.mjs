import { createHash } from "node:crypto";

const PROMPT_VERSION = "SALES-ASSORTMENT-AI-1.0.0";
const SUPPORTED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function list(value, max = 6) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function cleanEvidence(value) {
  return list(value, 6).map((item) => text(item)).filter(Boolean);
}

function cleanInsight(item, fallbackType = "observation") {
  return {
    type: text(item?.type, fallbackType).slice(0, 40),
    title: text(item?.title, "待进一步核查").slice(0, 100),
    reason: text(item?.reason, "当前数据不足以形成更具体结论。").slice(0, 500),
    evidence: cleanEvidence(item?.evidence),
  };
}

function cleanRecommendation(item) {
  const priority = text(item?.priority, "P2").toUpperCase();
  return {
    priority: new Set(["P0", "P1", "P2", "P3"]).has(priority) ? priority : "P2",
    title: text(item?.title, "运营核查").slice(0, 100),
    action: text(item?.action, "核查对应商品与店铺后再决定动作。").slice(0, 500),
    reason: text(item?.reason, "基于当前看板事实生成。").slice(0, 500),
    evidence: cleanEvidence(item?.evidence),
  };
}

function parseJsonObject(content) {
  const source = text(content);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function resolveModel(value) {
  const raw = text(value, "deepseek-v4-flash");
  const model = raw === "deepseek-v4" || raw === "deepseek-chat"
    ? "deepseek-v4-flash"
    : raw;
  return SUPPORTED_MODELS.has(model) ? model : "deepseek-v4-flash";
}

function sourceVersion(record) {
  if (!record) return null;
  return {
    filename: record.source_filename || null,
    rows: number(record.row_count),
    collectedAt: record.collected_at || record.applied_at || record.imported_at || record.created_at || null,
  };
}

function snapshotForAnalysis(dashboard) {
  const topProducts = (dashboard.topProducts || []).slice(0, 18).map((item) => ({
    country: item.country,
    categoryL1: item.categoryL1,
    categoryL2: item.categoryL2,
    productName: item.productName,
    mainSku: item.mainSku,
    activity: item.activity,
    productStatus: item.productStatus,
    isNew: Boolean(item.isNew),
    assortmentQuantity: number(item.assortmentQuantity),
    assortmentAmount: number(item.assortmentAmount),
    predictedDailySales: number(item.predictedDailySales),
    ownQuantity: number(item.ownQuantity),
    ownAmount: number(item.ownAmount),
    ownShare: number(item.ownShare),
    dailySalesGap: number(item.dailySalesGap),
    availableQuantity: number(item.availableQuantity),
    inTransitQuantity: number(item.inTransitQuantity),
    daysOfSupply: number(item.daysOfSupply),
  }));
  const stores = (dashboard.stores || []).slice(0, 16).map((item) => ({
    store: item.store,
    country: item.country,
    manager: item.manager,
    platform: item.platform,
    ownAmount: number(item.ownAmount),
    ownQuantity: number(item.ownQuantity),
    countryShare: number(item.countryShare),
    strength: item.strength,
    weakness: item.weakness,
    opportunityCount: number(item.opportunityCount),
    opportunityProducts: list(item.opportunityProducts, 5),
  }));
  const hierarchy = (dashboard.hierarchy?.rows || []).slice(0, 14).map((item) => ({
    label: item.label,
    assortmentAmount: number(item.assortmentAmount),
    ownAmount: number(item.ownAmount),
    ownShare: number(item.ownShare),
    predictedDailySales: number(item.predictedDailySales),
    availableQuantity: number(item.availableQuantity),
    dailySalesGap: number(item.dailySalesGap),
  }));
  const opportunities = [...(dashboard.opportunityMatrix || [])]
    .sort((a, b) => number(b.opportunityScore) - number(a.opportunityScore))
    .slice(0, 14)
    .map((item) => ({
      country: item.country,
      category: item.category,
      opportunityScore: number(item.opportunityScore),
      assortmentAmount: number(item.assortmentAmount),
      ownAmount: number(item.ownAmount),
      ownShare: number(item.ownShare),
      availableQuantity: number(item.availableQuantity),
    }));
  return {
    contract: dashboard.contract,
    selectedFilters: dashboard.filters?.selected || {},
    period: dashboard.period,
    sources: {
      order: sourceVersion(dashboard.sourceStatus?.order),
      inventory: sourceVersion(dashboard.sourceStatus?.inventory),
      productPackage: sourceVersion(dashboard.sourceStatus?.productPackage),
    },
    summary: dashboard.summary,
    quality: dashboard.quality,
    hierarchyDimension: dashboard.hierarchy?.dimension,
    hierarchy,
    topProducts,
    stores,
    opportunities,
  };
}

function analysisPrompt(snapshot) {
  return [
    "你是 Commerce Ops 的资深电商运营分析助手。",
    "你只能基于用户提供的结构化看板事实生成结论，不得补造销售额、库存、店铺、SKU 或时间数据。",
    "货盘标准化销售额和我方标准化销售额使用同一产品包标准价，仅用于横向比较；不要把预测日销量称为我司真实销量。",
    "优先发现：货盘表现强但我方承接弱、店铺品类缺口、库存与可售天数风险、新品机会、数据质量限制。",
    "每个结论和建议都必须包含可在输入中核对的证据。没有足够证据时写入 dataLimitations，不要猜测。",
    "evidence 必须写成运营人员可读的中文事实，不得直接输出 topProducts、ownQuantity、assortmentAmount 等 JSON 字段名或路径。",
    "不得自动执行经营动作，不得输出黑盒评分。",
    "只返回一个 JSON 对象，不要 Markdown，不要代码块。结构必须为：",
    JSON.stringify({
      headline: "一句话总判断",
      overview: "两到三句经营概览",
      conclusions: [{
        type: "opportunity|risk|observation",
        title: "结论标题",
        reason: "结论原因",
        evidence: ["可核对事实"],
      }],
      recommendations: [{
        priority: "P0|P1|P2|P3",
        title: "建议标题",
        action: "明确但需人工确认的运营动作",
        reason: "建议原因",
        evidence: ["可核对事实"],
      }],
      risks: [{
        type: "inventory|coverage|trend|data_quality",
        title: "风险标题",
        reason: "风险原因",
        evidence: ["可核对事实"],
      }],
      dataLimitations: ["数据窗口或质量限制"],
    }),
    "最多输出 5 条 conclusions、5 条 recommendations、4 条 risks 和 4 条 dataLimitations。",
    `看板事实：${JSON.stringify(snapshot)}`,
  ].join("\n");
}

function normalizeAnalysis(payload) {
  return {
    headline: text(payload?.headline, "当前数据已完成自动分析").slice(0, 140),
    overview: text(payload?.overview, "请结合下方证据核查重点机会与风险。").slice(0, 800),
    conclusions: list(payload?.conclusions, 5).map((item) => cleanInsight(item)),
    recommendations: list(payload?.recommendations, 5).map((item) => cleanRecommendation(item)),
    risks: list(payload?.risks, 4).map((item) => cleanInsight(item, "risk")),
    dataLimitations: list(payload?.dataLimitations, 4).map((item) => text(item)).filter(Boolean),
  };
}

export class SalesAssortmentAiService {
  constructor({
    dashboardService,
    gateway,
    configured = false,
    model = "deepseek-v4-flash",
    now = () => new Date(),
    cacheTtlMs = 10 * 60 * 1000,
  } = {}) {
    if (!dashboardService || typeof dashboardService.dashboard !== "function") {
      throw new TypeError("Sales assortment dashboard service is required");
    }
    if (!gateway || typeof gateway.complete !== "function") {
      throw new TypeError("AI gateway is required");
    }
    this.dashboardService = dashboardService;
    this.gateway = gateway;
    this.configured = Boolean(configured);
    this.model = resolveModel(model);
    this.now = now;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
  }

  status() {
    return {
      configured: this.configured,
      provider: "deepseek",
      model: this.model,
      promptVersion: PROMPT_VERSION,
    };
  }

  async analyze(input = {}) {
    if (!this.configured) {
      const error = new Error("DeepSeek 尚未配置，请先设置 DEEPSEEK_API_KEY。");
      error.code = "AI_NOT_CONFIGURED";
      error.status = 503;
      throw error;
    }
    const dashboard = await this.dashboardService.dashboard(input);
    const snapshot = snapshotForAnalysis(dashboard);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    const cached = this.cache.get(fingerprint);
    const nowMs = this.now().getTime();
    if (!input.forceRefresh && cached && nowMs - cached.cachedAt < this.cacheTtlMs) {
      return { ...cached.value, cached: true };
    }

    const result = await this.gateway.complete({
      moduleId: "sales_assortment",
      operation: "analyze_dashboard",
      model: this.model,
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你是只依据结构化经营事实工作的电商运营分析助手，输出严格 JSON。",
        },
        { role: "user", content: analysisPrompt(snapshot) },
      ],
    });
    if (!result?.success) {
      const error = new Error(result?.errorMessage || "DeepSeek 分析失败。");
      error.code = result?.errorCode || "AI_PROVIDER_ERROR";
      error.status = error.code === "AI_RATE_LIMITED" ? 429 : 502;
      throw error;
    }
    const parsed = parseJsonObject(result.content);
    if (!parsed) {
      const error = new Error("DeepSeek 返回内容无法解析为结构化分析。");
      error.code = "AI_INVALID_RESPONSE";
      error.status = 502;
      throw error;
    }
    const value = {
      id: fingerprint.slice(0, 16),
      generatedAt: this.now().toISOString(),
      provider: result.provider || "deepseek",
      model: this.model,
      promptVersion: PROMPT_VERSION,
      scope: snapshot.selectedFilters,
      period: snapshot.period,
      sources: snapshot.sources,
      usage: result.usage || null,
      analysis: normalizeAnalysis(parsed),
      cached: false,
    };
    this.cache.set(fingerprint, { cachedAt: nowMs, value });
    return value;
  }
}

export { PROMPT_VERSION as SALES_ASSORTMENT_AI_PROMPT_VERSION };
