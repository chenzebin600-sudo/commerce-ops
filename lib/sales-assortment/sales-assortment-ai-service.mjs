import { createHash } from "node:crypto";
import { createAiOutputValidator } from "../ai/ai-output-validation.mjs";

const PROMPT_VERSION = "SALES-ASSORTMENT-AI-1.4.0";
const SUPPORTED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const ANALYSIS_MODULES = Object.freeze({
  trend: "销售与货盘趋势",
  dataQuality: "数据准备度",
  hierarchy: "经营层级",
  opportunities: "机会矩阵",
  products: "重点产品",
  stores: "店铺表现",
  storeDeclines: "高影响下滑店铺",
  storeGrowth: "高影响增长店铺",
  styleDeclines: "高影响下滑款名",
  styleGrowth: "高影响增长款名",
  businessOpportunities: "商业机会",
  inventory: "库存行动",
  dailyReport: "经营日报",
});

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

function cleanModuleAnalysis(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  return {
    headline: text(item.headline, "本模块暂无明确异常").slice(0, 120),
    summary: text(item.summary, "请结合当前筛选条件继续观察。由 DeepSeek 基于本模块数据生成。请在执行前人工核查。").slice(0, 600),
    findings: list(item.findings, 4).map((entry) => cleanInsight(entry)),
    recommendations: list(item.recommendations, 3).map((entry) => cleanRecommendation(entry)),
    dataLimitations: list(item.dataLimitations, 3).map((entry) => text(entry)).filter(Boolean),
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

const dashboardAnalysisOutputValidator = createAiOutputValidator({
  schemaId: `sales-assortment-dashboard-analysis@${PROMPT_VERSION}`,
  parse(content) {
    const parsed = parseJsonObject(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Sales assortment AI output must be a JSON object");
    }
    return parsed;
  },
  validate: () => true,
});
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
  const stores = (dashboard.stores || []).slice(0, 10).map((item) => ({
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
  const hierarchy = (dashboard.hierarchy?.rows || []).slice(0, 10).map((item) => ({
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
    .slice(0, 10)
    .map((item) => ({
      country: item.country,
      category: item.category,
      opportunityScore: number(item.opportunityScore),
      assortmentAmount: number(item.assortmentAmount),
      ownAmount: number(item.ownAmount),
      ownShare: number(item.ownShare),
      availableQuantity: number(item.availableQuantity),
    }));
  const trend = (dashboard.trend || []).slice(-42).map((item) => ({
    date: item.date,
    ownAmount: number(item.ownAmount),
    ownQuantity: number(item.ownQuantity),
    assortmentDailyAmount: number(item.assortmentDailyAmount),
  }));
  const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const storeSalesTrend = [...(dashboard.storeSalesTrend || [])]
    .sort((a, b) => (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4)
      || number(b.impactScore) - number(a.impactScore)
      || number(b.totalAmount) - number(a.totalAmount))
    .slice(0, 20)
    .map((item) => ({
      store: item.store,
      country: item.country,
      platform: item.platform,
      manager: item.manager,
      totalAmount: number(item.totalAmount),
      current7dAmount: number(item.current7dAmount),
      previous7dAmount: number(item.previous7dAmount),
      changeRate: item.changeRate === null ? null : number(item.changeRate),
      amountChange: number(item.amountChange),
      impactAmount: number(item.impactAmount),
      impactScore: number(item.impactScore),
      trendStatus: item.trendStatus,
      priority: item.priority,
      daily: list(item.points, 42),
    }));
  const productSalesRanking = (dashboard.productSalesRanking || []).slice(0, 20).map((item) => ({
    rank: number(item.rank),
    current7dRank: item.current7dRank,
    previous7dRank: item.previous7dRank,
    rankChange: item.rankChange,
    country: item.country,
    productName: item.productName,
    mainSku: item.mainSku,
    categoryL1: item.categoryL1,
    ownAmount: number(item.ownAmount),
    ownQuantity: number(item.ownQuantity),
    current7dAmount: number(item.current7dAmount),
    previous7dAmount: number(item.previous7dAmount),
    changeRate: item.changeRate === null ? null : number(item.changeRate),
    amountChange: number(item.amountChange),
    impactAmount: number(item.impactAmount),
    impactScore: number(item.impactScore),
    trendStatus: item.trendStatus,
    priority: item.priority,
    daily: list(item.points, 42),
  }));
  const priorityAlerts = (dashboard.priorityAlerts || []).slice(0, 10).map((item) => ({
    priority: item.priority,
    type: item.type,
    entityName: item.entityName,
    title: item.title,
    summary: item.summary,
    metricLabel: item.metricLabel,
    metricValue: item.metricValue,
    action: item.action,
    evidence: list(item.evidence, 3),
  }));
  const storeDeclines = list(dashboard.storeAnomalies?.declines, 15);
  const storeGrowth = list(dashboard.storeAnomalies?.growth, 15);
  const styleDeclines = list(dashboard.styleAnomalies?.declines, 15);
  const styleGrowth = list(dashboard.styleAnomalies?.growth, 15);
  const businessOpportunities = list(dashboard.businessOpportunities, 20).map((item) => ({
    country: item.country,
    categoryL1: item.categoryL1,
    categoryL2: item.categoryL2,
    style: item.style,
    assortmentAmount: number(item.assortmentAmount),
    assortmentDailySales: number(item.assortmentDailySales),
    ownDailySales: number(item.ownDailySales),
    ownDailySalesShare: number(item.ownDailySalesShare),
    availableQuantity: number(item.availableQuantity),
    inventoryValue: number(item.inventoryValue),
    opportunityAmount: number(item.opportunityAmount),
    opportunityScore: number(item.opportunityScore),
    leadingProducts: list(item.children, 5).map((child) => ({
      productName: child.productName,
      assortmentAmount: number(child.assortmentAmount),
      ownAmount: number(child.ownAmount),
      ownDailySalesShare: number(child.ownDailySalesShare),
      availableQuantity: number(child.availableQuantity),
      inventoryValue: number(child.inventoryValue),
      opportunityAmount: number(child.opportunityAmount),
    })),
  }));
  const inventoryInsights = list(dashboard.inventoryInsights, 16).map((item) => ({
    country: item.country,
    productName: item.productName,
    style: item.style,
    type: item.type,
    priority: item.priority,
    ownDailySales: number(item.ownDailySales),
    predictedDailySales: number(item.predictedDailySales),
    assortmentDailyAmount: number(item.assortmentDailyAmount),
    assortmentAmount: number(item.assortmentAmount),
    ownAmount: number(item.ownAmount),
    inventoryValue: number(item.inventoryValue),
    availableQuantity: number(item.availableQuantity),
    inventoryChange: item.inventoryChange,
    inventoryChangeRate: item.inventoryChangeRate,
    daysOfSupply: number(item.daysOfSupply),
    lastInboundAt: item.lastInboundAt,
    action: item.action,
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
    trend,
    hierarchyDimension: dashboard.hierarchy?.dimension,
    hierarchy,
    stores,
    opportunities,
    storeSalesTrend,
    productSalesRanking,
    priorityAlerts,
    anomalyComparisonDays: dashboard.storeAnomalies?.comparisonDays || 7,
    storeDeclines,
    storeGrowth,
    styleDeclines,
    styleGrowth,
    businessOpportunities,
    inventoryComparison: dashboard.inventoryComparison || null,
    inventoryInsights,
    dailyReportSummary: dashboard.dailyReport?.summary || null,
    dailyMovementWindows: dashboard.dailyReport?.sections?.movementWindows || null,
  };
}

function analysisPrompt(snapshot) {
  return [
    "你是 Commerce Ops 的资深电商运营分析助手。",
    "你只能基于用户提供的结构化看板事实生成结论，不得补造销售额、库存、店铺、SKU 或时间数据。",
    "货盘标准化销售额和我方标准化销售额使用同一产品包标准价，仅用于横向比较；不要把预测日销量称为我司真实销量。",
    "优先发现：货盘表现强但我方承接弱、店铺品类缺口、库存与可售天数风险、新品机会、数据质量限制。",
    "每个结论和建议都必须包含可在输入中核对的证据。没有足够证据时写入 dataLimitations，不要猜测。",
    "必须分别分析各个细分模块，不能把同一段概览复制到多个模块。每个模块只能引用该模块及 summary、period、sources、selectedFilters 中可核对的事实。",
    "storeDeclines 与 storeGrowth 必须分开分析店铺下滑和上涨；styleDeclines 与 styleGrowth 必须分开分析款名销量变化。",
    "异常排序必须同时考虑绝对影响金额或销量、环比幅度和当前业务规模；不能把小金额的大百分比变化当成首要结论。",
    "businessOpportunities 必须优先分析货盘 GMV 高、机会金额大、库存可支撑且我方承接低的款名，并展开多个具体商品证据。",
    "inventory 必须比较本次与上次库存快照，识别急降和到仓增加，并结合货盘 GMV、我方 GMV、日销和可售天数解释；库存下降只能表述为销量或出库候选信号，不能直接断言销量上涨。",
    "dailyReport 必须覆盖经营概览、店铺昨日与近7日变化、款名昨日与近7日变化、商业机会和库存快照变化，汇总最多十项最紧急事项。",
    "priorityAlerts 是确定性规则识别的经营日报事项；可以解释和排序，但不得篡改其优先级、对象和证据。",
    `细分模块为：${Object.entries(ANALYSIS_MODULES).map(([key, label]) => `${key}=${label}`).join("；")}。`,
    "evidence 必须写成运营人员可读的中文事实，不得直接输出 productSalesRanking、ownQuantity、assortmentAmount 等 JSON 字段名或路径。",
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
      modules: Object.fromEntries(Object.entries(ANALYSIS_MODULES).map(([key, label]) => [key, {
        headline: `${label}的一句话判断`,
        summary: "只解释这个模块的主要变化、异常或机会",
        findings: [{
          type: "opportunity|risk|observation",
          title: "模块发现",
          reason: "为什么得出该判断",
          evidence: ["可核对事实"],
        }],
        recommendations: [{
          priority: "P0|P1|P2|P3",
          title: "建议标题",
          action: "需人工确认的下一步",
          reason: "建议原因",
          evidence: ["可核对事实"],
        }],
        dataLimitations: ["该模块的数据限制"],
      }])),
    }),
    "全局最多输出 5 条 conclusions、5 条 recommendations、4 条 risks 和 4 条 dataLimitations；每个细分模块最多输出 3 条 findings、3 条 recommendations 和 3 条 dataLimitations。",
    `看板事实：${JSON.stringify(snapshot)}`,
  ].join("\n");
}

function moduleAnalysisPrompt(snapshot) {
  const moduleShape = Object.fromEntries(Object.entries(ANALYSIS_MODULES).map(([key, label]) => [key, {
    headline: `${label}的一句话判断`,
    summary: "用两到三句话说明该模块最重要的变化、异常或机会",
    findings: [{
      type: "opportunity|risk|observation",
      title: "具体对象与发现",
      reason: "为什么值得关注",
      evidence: ["可核对的金额、销量、比例、库存或时间窗口"],
    }],
    recommendations: [{
      priority: "P0|P1|P2|P3",
      title: "建议标题",
      action: "需要人工确认的下一步",
      reason: "建议原因",
      evidence: ["最多两条可核对事实"],
    }],
    dataLimitations: ["最多一条数据限制"],
  }]));
  return [
    "你是 Commerce Ops 的资深电商运营分析助手。",
    "只依据输入的结构化看板事实，为页面的各个细分模块分别生成简短结论；不得补造销售额、库存、店铺、SKU 或时间数据。",
    "货盘标准化销售额与我方标准化销售额只用于横向比较；预测日销量不得称为公司真实销量。",
    "每个模块必须返回，不得复制同一段结论；证据必须写成运营人员可读的中文事实，不得暴露 JSON 字段名。",
    "每个模块只返回一句标题、两到三句摘要、最多四项发现、最多三项建议和最多两条数据限制。没有足够证据时明确说明数据不足。",
    "storeDeclines 与 storeGrowth 必须分开输出，styleDeclines 与 styleGrowth 必须分开输出；异常结论必须写出对象名称、本期、上期、绝对差额、环比和对比周期。",
    "异常优先级先看绝对影响金额或销量，再结合变化率和当前规模。禁止把金额很小但环比很大的对象排在高金额异常之前。",
    "businessOpportunities 必须从机会金额、货盘GMV、库存标价金额、我方承接率四项综合分析，至少解释三个款名；数据足够时不得只输出一条泛化建议。",
    "inventory 必须比较本次与上次库存，区分急降、到仓增加、断货和低库存，并写出货盘GMV或我方GMV证据。库存急降只能提示核查销量、订单或调拨，不能直接断言销量增长。",
    "dailyReport 必须先概括经营指标，再分别覆盖店铺和款名的昨日变化、近7日变化、机会及库存快照变化，帮助识别人眼不易发现的持续趋势。",
    "priorityAlerts 是确定性日报事项，可用于确认优先顺序，但禁止改变其中的优先级和事实。",
    "不得自动执行经营动作，不得输出黑盒评分。只返回严格 JSON，不要 Markdown 或代码块。",
    `模块定义：${Object.entries(ANALYSIS_MODULES).map(([key, label]) => `${key}=${label}`).join("；")}。`,
    `JSON 结构：${JSON.stringify({ modules: moduleShape })}`,
    `看板事实：${JSON.stringify(snapshot)}`,
  ].join("\n");
}

function normalizeAnalysis(payload) {
  const modules = {};
  for (const key of Object.keys(ANALYSIS_MODULES)) {
    modules[key] = cleanModuleAnalysis(payload?.modules?.[key]);
  }
  return {
    headline: text(payload?.headline, "当前数据已完成自动分析").slice(0, 140),
    overview: text(payload?.overview, "请结合下方证据核查重点机会与风险。").slice(0, 800),
    conclusions: list(payload?.conclusions, 5).map((item) => cleanInsight(item)),
    recommendations: list(payload?.recommendations, 5).map((item) => cleanRecommendation(item)),
    risks: list(payload?.risks, 4).map((item) => cleanInsight(item, "risk")),
    dataLimitations: list(payload?.dataLimitations, 4).map((item) => text(item)).filter(Boolean),
    modules,
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
      promptId: "sales-assortment.dashboard-analysis",
      promptVersion: PROMPT_VERSION,
      model: this.model,
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      thinking: { type: "disabled" },
      outputValidator: dashboardAnalysisOutputValidator,
      messages: [
        {
          role: "system",
          content: "你是只依据结构化经营事实工作的电商运营分析助手，输出严格 JSON。",
        },
        { role: "user", content: moduleAnalysisPrompt(snapshot) },
      ],
    });
    if (!result?.success) {
      const error = new Error(result?.errorMessage || "DeepSeek 分析失败。");
      error.code = result?.errorCode || "AI_PROVIDER_ERROR";
      error.status = error.code === "AI_RATE_LIMITED" ? 429 : 502;
      throw error;
    }
    const parsed = result.validatedOutput ?? parseJsonObject(result.content);
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
