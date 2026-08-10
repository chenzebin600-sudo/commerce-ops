import { createHash, randomUUID } from "node:crypto";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const TARGET_SOURCES = new Set(["manual", "screenshot", "import"]);

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function number(value) {
  const result = Number(String(value ?? "").replaceAll(",", "").replaceAll("%", "").trim());
  return Number.isFinite(result) ? result : 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < textValue.length; index += 1) {
    const char = textValue[index];
    if (char === '"') {
      if (quoted && textValue[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && textValue[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function isoDay(value) {
  const match = text(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const day = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : day;
}

function normalizedDay(value) {
  const candidate = text(value);
  if (!candidate) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
  return isoDay(candidate);
}

function dayCount(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function stableKey(productId, adName) {
  const product = text(productId);
  if (product && product !== "-") return `product:${product}`;
  return `name:${createHash("sha256").update(text(adName).toLowerCase()).digest("hex").slice(0, 24)}`;
}

function rowObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
}

export function parseShopeeAdvertisingCsv(csvText, { filename = "shopee-advertising.csv" } = {}) {
  if (typeof csvText !== "string" || !csvText.trim()) throw Object.assign(new Error("请选择Shopee广告CSV文件。"), { status: 400, code: "ADS_CSV_REQUIRED" });
  if (Buffer.byteLength(csvText) > MAX_IMPORT_BYTES) throw Object.assign(new Error("CSV文件超过2MB限制。"), { status: 413, code: "ADS_CSV_TOO_LARGE" });
  const rows = parseCsv(csvText.replace(/^\uFEFF/, ""));
  const headerIndex = rows.findIndex((row) => row[0] === "Sequence" && row.includes("Ad Name") && row.includes("Expense") && row.includes("ROAS"));
  if (headerIndex < 0) throw Object.assign(new Error("文件不是受支持的Shopee Overall Ads报表。"), { status: 422, code: "ADS_CSV_HEADER_INVALID" });
  const metadata = Object.fromEntries(rows.slice(0, headerIndex).filter((row) => row[0] && row[1]).map((row) => [row[0], row[1]]));
  if (!/Shopee/i.test(text(rows[0]?.[0]))) throw Object.assign(new Error("仅支持Shopee广告报表。"), { status: 422, code: "ADS_PLATFORM_INVALID" });
  const period = text(metadata["Date Period"]).match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})$/);
  const periodFrom = period ? isoDay(period[1]) : null;
  const periodTo = period ? isoDay(period[2]) : null;
  const shopId = text(metadata["Shop ID"]);
  if (!shopId || !periodFrom || !periodTo) throw Object.assign(new Error("报表缺少Shop ID或有效日期范围。"), { status: 422, code: "ADS_METADATA_INVALID" });
  const headers = rows[headerIndex];
  const facts = rows.slice(headerIndex + 1).filter((row) => text(row[0])).map((row) => {
    const source = rowObject(headers, row);
    const sequence = Math.trunc(number(source.Sequence));
    const adName = text(source["Ad Name"]);
    if (!sequence || !adName) throw Object.assign(new Error("广告行缺少序号或名称。"), { status: 422, code: "ADS_ROW_INVALID" });
    const adKey = stableKey(source["Product ID"], adName);
    return {
      id: randomUUID(), sequence, adKey, adName, status: text(source.Status, "Unknown"),
      adType: text(source["Ads Type"]), productId: text(source["Product ID"]),
      biddingMethod: text(source["Bidding Method"]), placement: text(source.Placement),
      startDate: normalizedDay(source["Start Date"]),
      impression: number(source.Impression), clicks: number(source.Clicks), addToCart: number(source["Add to Cart"]),
      conversions: number(source.Conversions), itemsSold: number(source["Items Sold"]),
      gmv: number(source.GMV), expense: number(source.Expense), roas: number(source.ROAS),
      directRoas: number(source["Direct ROAS"]),
    };
  });
  const totals = facts.reduce((sum, fact) => ({
    impression: sum.impression + fact.impression, clicks: sum.clicks + fact.clicks,
    conversions: sum.conversions + fact.conversions, gmv: sum.gmv + fact.gmv,
    expense: sum.expense + fact.expense,
  }), { impression: 0, clicks: 0, conversions: 0, gmv: 0, expense: 0 });
  const importedAt = new Date().toISOString();
  return {
    batch: {
      id: randomUUID(), shopId, shopName: text(metadata["Shop Name"], shopId), accountName: text(metadata["User Name"]),
      originalFilename: text(filename, "shopee-advertising.csv"), reportCreatedAt: text(metadata["Report Creation Time"]),
      periodFrom, periodTo, periodDays: dayCount(periodFrom, periodTo),
      rawSha256: createHash("sha256").update(csvText).digest("hex"), importedBy: "local_user", importedAt,
      summary: { ...totals, roas: totals.expense > 0 ? round(totals.gmv / totals.expense) : 0 },
    },
    facts,
  };
}

function batchTotals(facts, { productOnly = false } = {}) {
  const selected = productOnly ? facts.filter((fact) => fact.adType === "Product Ad") : facts;
  const totals = selected.reduce((sum, fact) => ({
    impression: sum.impression + fact.impression, clicks: sum.clicks + fact.clicks,
    conversions: sum.conversions + fact.conversions, gmv: sum.gmv + fact.gmv, expense: sum.expense + fact.expense,
  }), { impression: 0, clicks: 0, conversions: 0, gmv: 0, expense: 0 });
  return {
    ...totals,
    ctr: totals.impression > 0 ? round((totals.clicks / totals.impression) * 100, 2) : 0,
    cvr: totals.clicks > 0 ? round((totals.conversions / totals.clicks) * 100, 2) : 0,
    roas: totals.expense > 0 ? round(totals.gmv / totals.expense) : 0,
  };
}

function indexed(facts = []) { return new Map(facts.map((fact) => [fact.adKey, fact])); }

function metricWindow(fact) {
  if (!fact) return null;
  return {
    impression: fact.impression,
    clicks: fact.clicks,
    conversions: fact.conversions,
    gmv: fact.gmv,
    expense: fact.expense,
    roas: fact.roas,
    ctr: fact.impression > 0 ? round((fact.clicks / fact.impression) * 100) : 0,
    cvr: fact.clicks > 0 ? round((fact.conversions / fact.clicks) * 100) : 0,
  };
}

function percentChange(current, previous) {
  if (!current || !previous || previous.roas <= 0) return null;
  return round(((current.roas - previous.roas) / previous.roas) * 100, 1);
}

function inferCampaignType(fact) {
  const source = `${text(fact?.adName)} ${text(fact?.biddingMethod)} ${text(fact?.adType)}`.toLowerCase();
  if (/new product|new item|新品|新商品/.test(source)) return "new_product";
  if (/ad group|广告组/.test(source)) return "ad_group";
  if (/shop gmv|max shop|shop max|全店推|全店/.test(source)) return "shop_gmv_max";
  return "individual";
}

function campaignStage({ campaignType, ageDays }) {
  if (campaignType === "new_product" && (ageDays === null || ageDays <= 30)) return "new_product";
  if (ageDays !== null && ageDays < 7) return "learning";
  if (ageDays !== null && ageDays < 14) return "stabilizing";
  return "mature";
}

function buildDecisionDetail({ fact, fourteen, previousFourteen, target, decision }) {
  const campaignType = inferCampaignType(fact);
  const stage = campaignStage({ campaignType, ageDays: decision.ageDays });
  const days = fourteen ? 14 : null;
  const evidence = [];
  if (fourteen) {
    evidence.push(`14天 ${fourteen.clicks} 次点击、${fourteen.conversions} 次转化，CTR ${fourteen.ctr}%，CVR ${fourteen.cvr}%`);
    evidence.push(`14天花费 ${round(fourteen.expense, 0)}，成交额 ${round(fourteen.gmv, 0)}，实际ROAS ${fourteen.roas}`);
  } else evidence.push("缺少精确14天主判断窗口，现有短周期数据只用于观察方向");
  if (target && fourteen) evidence.push(`目标ROAS ${target.targetRoas}，当前达成率 ${decision.attainment}%`);
  else if (!target) evidence.push("尚未录入后台当前目标ROAS，无法校验目标达成");
  if (previousFourteen && decision.trend !== null) evidence.push(`较前14天ROAS ${decision.trend >= 0 ? "上升" : "下降"} ${Math.abs(decision.trend)}%`);
  if (decision.ageDays !== null) evidence.push(`广告已运行约 ${decision.ageDays} 天，当前处于${stage === "learning" ? "7天学习期" : stage === "stabilizing" ? "7—14天稳定观察期" : stage === "new_product" ? "新品冷启动阶段" : "成熟投放阶段"}`);

  const dailySpend = fourteen && days ? round(fourteen.expense / days, 0) : null;
  const common = {
    campaignType,
    stage,
    evidence,
    dailySpend,
    healthChecklist: ["标题与类目是否匹配", "价格与优惠是否有竞争力", "库存、物流与运费是否正常", "评价数量、评分与首页差评", "主图、详情页与商品真实性"],
    missingData: ["后台日预算及是否频繁耗尽", "广告余额是否发生断流", "商品毛利与盈亏ROAS", "系统推荐ROAS区间", "是否开启极速起量、智能优惠券或大促优化"],
    actionSteps: [],
    suggestedAdjustment: "暂不调整",
    observationWindow: "完成动作后观察7天",
    successSignal: "ROAS、转化率和订单量同步改善",
    stopSignal: "花费继续增长但转化没有改善时，提交人工止损评审",
    bottleneck: "证据待补充",
  };

  const detail = { ...common };
  switch (decision.ruleCode) {
    case "needs_14d_evidence":
      detail.bottleneck = "数据证据不足";
      detail.actionSteps = ["导入同店铺的精确连续14天报表", "补充紧邻的前14天报表用于环比", "数据齐全前只记录异常，不修改预算或目标ROAS"];
      detail.observationWindow = "补齐14天证据后重新判断";
      detail.successSignal = "当前14天与前14天窗口均可准确匹配";
      break;
    case "learning_period":
      detail.bottleneck = "系统仍在学习或稳定探索";
      detail.actionSteps = ["保持现有竞价、预算和广告状态", "确认余额充足且没有中途断流", "仅检查商品库存、物流和页面异常"];
      detail.observationWindow = decision.ageDays < 7 ? `至少等待至运行满7天，正式结论看满14天` : "等待至运行满14天";
      detail.successSignal = "学习期结束后流量、转化与ROAS趋于稳定";
      detail.stopSignal = "仅在缺货、链接失效或重大价格错误时立即人工介入";
      break;
    case "zero_conversion_14d":
      detail.bottleneck = "高点击但商品承接失败";
      detail.actionSteps = ["先检查价格、运费、库存和物流时效", "检查评价、首页差评、主图及详情页承诺", "核对广告流量与商品是否匹配", "完成链接优化后保持广告设置稳定观察7天"];
      detail.suggestedAdjustment = "暂不改目标ROAS；先修复商品承接";
      detail.successSignal = "优化后7天内产生首批转化，CVR脱离0%";
      detail.stopSignal = "优化后再次累计接近100次点击仍零转化，提交人工止损评审";
      break;
    case "traffic_constrained":
      detail.bottleneck = "效率达标但流量样本不足";
      detail.actionSteps = ["确认商品毛利和盈亏ROAS", "查看日预算是否耗尽及系统推荐ROAS区间", "若利润允许，由有权限人员把目标ROAS下调约10%做一次试探", "调整后7天内不重复修改"];
      detail.suggestedAdjustment = target ? `条件满足时，目标ROAS可由 ${target.targetRoas} 下调至约 ${round(target.targetRoas * 0.9, 1)}` : "先补录目标ROAS";
      detail.successSignal = "点击和订单增加，同时实际ROAS仍高于盈亏线";
      detail.stopSignal = "ROAS跌破盈亏线或花费增加但订单无增长时停止放量";
      break;
    case "sample_insufficient":
      detail.bottleneck = fourteen?.ctr < 1 ? "点击率偏低，流量获取不足" : "样本尚未成熟";
      detail.actionSteps = fourteen?.ctr < 1
        ? ["检查主图、标题和价格在同类结果页的竞争力", "确认类目与流量匹配", "保持设置稳定，继续积累至100次点击"]
        : ["保持当前设置继续积累样本", "检查预算和余额是否造成断流", "达到100次点击后再判断效率"];
      detail.observationWindow = "继续观察至14天累计100次点击，或再观察7天";
      detail.successSignal = "点击达到100次并形成稳定转化样本";
      break;
    case "target_missing":
      detail.bottleneck = "缺少目标与利润基准";
      detail.actionSteps = ["从Shopee后台补录当前目标ROAS", "补充商品毛利和盈亏ROAS", "确认系统推荐ROAS区间后重新生成建议"];
      detail.suggestedAdjustment = "只补数据，不修改后台设置";
      detail.observationWindow = "补录后立即重新判断";
      detail.successSignal = "可以同时比较实际ROAS、目标ROAS和盈亏ROAS";
      break;
    case "conversion_leak":
      detail.bottleneck = "流量正常，商品转化承接偏弱";
      detail.actionSteps = ["按商品健康清单逐项检查", "重点核对价格、优惠、评价和物流承诺", "修复后保持竞价与预算不变观察7天", "CVR恢复后再讨论放量"];
      detail.suggestedAdjustment = "不建议通过降低目标ROAS强行放量";
      detail.successSignal = "CVR提升且实际ROAS回到目标或盈亏线以上";
      break;
    case "auto_efficiency_below_target":
      detail.bottleneck = "自动竞价流量有量但效率未达标";
      detail.actionSteps = ["先排除商品健康度与预算断流问题", "核对近7天实际ROAS是否低于盈亏线", "若持续低于盈亏线，由有权限人员评估切换自定义ROAS", "切换后按新策略重新完成学习观察"];
      detail.suggestedAdjustment = target ? `自定义ROAS初始值优先参考系统建议区间与盈亏线，不直接照搬 ${target.targetRoas}` : "先补充盈亏ROAS和系统推荐区间";
      detail.successSignal = "切换后7—14天实际ROAS回升且订单没有断崖下降";
      break;
    case "efficiency_below_target":
      detail.bottleneck = "成熟样本下效率低于目标";
      detail.actionSteps = ["先排除商品健康度、余额断流和预算不足", "核对当前目标是否处于系统建议区间", "目标高于建议上限时，单次回调不超过10%", "调整后至少观察7天，不暂停重建广告"];
      detail.suggestedAdjustment = "先修复链接并核对推荐区间；不为追求流量盲目下调目标";
      detail.successSignal = "实际ROAS向目标收敛，且转化和订单保持稳定";
      break;
    default:
      detail.bottleneck = "当前未发现明确异常";
      detail.actionSteps = ["保持现有竞价和目标ROAS", "确认预算没有频繁耗尽", "若持续超额达标且利润允许，可只增加约10%预算测试", "每7天复盘一次，不因单日波动调整"];
      detail.suggestedAdjustment = dailySpend !== null ? `维持目标；如预算受限，可参考日均花费 ${dailySpend} 并小幅增加预算` : "维持当前设置";
      detail.successSignal = "订单增长且实际ROAS继续高于目标和盈亏线";
      detail.stopSignal = "放量后ROAS跌破盈亏线时恢复原预算";
  }
  return detail;
}

function classifyEvidence({ fact, fourteen, previousFourteen, target, reportDate }) {
  const mode = /auto/i.test(text(fact?.biddingMethod)) ? "auto" : /custom/i.test(text(fact?.biddingMethod)) ? "custom" : "unknown";
  const ageDays = fact?.startDate ? dayCount(fact.startDate, reportDate) : null;
  const inLearning = ageDays !== null && ageDays < 14;
  const sampleEnough = Boolean(fourteen && fourteen.clicks >= 100);
  const attainment = target && fourteen ? round((fourteen.roas / target.targetRoas) * 100, 1) : null;
  const trend = percentChange(fourteen, previousFourteen);
  const base = {
    mode,
    ageDays,
    inLearning,
    sampleEnough,
    attainment,
    trend,
    confidence: fourteen ? (sampleEnough ? "high" : "medium") : "low",
  };

  if (!fourteen) return {
    ...base,
    priority: "WAITING", ruleCode: "needs_14d_evidence", diagnosis: "证据缺口",
    action: "缺少连续14天报表，当前只展示方向，不形成广告调整建议。",
    guardrail: "请导入同一店铺的精确14天报表；单日和7日波动不能作为调整依据。",
  };
  if (inLearning) return {
    ...base,
    priority: "WAITING", ruleCode: "learning_period", diagnosis: ageDays < 7 ? "学习期" : "稳定观察期",
    action: ageDays < 7 ? `广告开启约${ageDays}天，仍在7天系统学习期。` : `广告开启约${ageDays}天，处于7—14天稳定观察期。`,
    guardrail: "前7天避免调整；正式效率结论等待满14天，期间不要暂停重开。",
  };
  if (fourteen.clicks >= 100 && fourteen.conversions === 0 && fourteen.expense > 0) return {
    ...base,
    priority: "P0", ruleCode: "zero_conversion_14d", diagnosis: "高样本零转化",
    action: "14天累计点击已达到100次但仍无转化，优先核查价格、库存、评价、详情页和流量匹配。",
    guardrail: "先核查链接承接问题；本系统不会自动暂停或修改广告。",
  };
  if (!sampleEnough) {
    if (target && attainment !== null && attainment >= 100) return {
      ...base,
      priority: "WAITING", ruleCode: "traffic_constrained", diagnosis: "效率达标但流量不足",
      action: "14天点击不足100次但ROAS已达标，目标可能限制了放量。",
      guardrail: "先确认商品利润与链接质量，再由运营评估是否小幅释放流量。",
    };
    return {
      ...base,
      priority: "WAITING", ruleCode: "sample_insufficient", diagnosis: "样本不足",
      action: "14天点击不足100次，暂时不能可靠判断广告效率。",
      guardrail: "检查曝光、CTR、目标ROAS和商品竞争力；不要仅因低ROAS频繁调整。",
    };
  }
  if (!target) return {
    ...base,
    priority: "WAITING", ruleCode: "target_missing", diagnosis: "缺少目标",
    action: "样本已经成熟，但缺少只读目标ROAS，无法判断目标达成情况。",
    guardrail: "补录后台当前目标ROAS；保存仅用于本地诊断。",
  };
  if (attainment < 100) {
    const highCtr = fourteen.ctr >= 3;
    const lowCvr = fourteen.cvr < 0.7;
    const diagnosis = highCtr && lowCvr ? "转化承接异常" : mode === "auto" ? "自动竞价效率不足" : "效率持续低于目标";
    return {
      ...base,
      priority: "P1", ruleCode: highCtr && lowCvr ? "conversion_leak" : mode === "auto" ? "auto_efficiency_below_target" : "efficiency_below_target",
      diagnosis,
      action: highCtr && lowCvr
        ? "点击获取正常但转化偏低，先核查价格、详情页、评价、库存与优惠。"
        : mode === "auto"
          ? "成熟样本下ROAS仍低于目标，可评估转为自定义ROAS。"
          : "成熟样本下ROAS持续低于目标，先排查链接，并核对系统建议区间与商品盈亏线。",
      guardrail: "目标调整后至少观察7天，单次幅度控制在10%—20%，不要暂停重开。",
    };
  }
  return {
    ...base,
    priority: "NORMAL", ruleCode: "hold_steady", diagnosis: "保持投放",
    action: "14天样本成熟且达到目标，当前不需要操作。",
    guardrail: "继续按周期观察，避免因单日波动打断学习。",
  };
}

export class ShopeeAdvertisingService {
  constructor({ repository }) { this.repository = repository; }

  importCsv(input = {}) {
    const parsed = parseShopeeAdvertisingCsv(input.csvText, { filename: input.filename });
    const existing = this.repository.findBatchByHash(parsed.batch.rawSha256);
    if (existing) return { batch: existing, duplicate: true };
    return { batch: this.repository.createBatch(parsed.batch, parsed.facts), duplicate: false };
  }

  deleteBatch(batchId) {
    const normalizedBatchId = text(batchId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedBatchId)) {
      throw Object.assign(new Error("报表批次ID无效。"), { status: 400, code: "ADS_BATCH_ID_INVALID" });
    }
    const deleted = this.repository.deleteBatch(normalizedBatchId);
    if (!deleted) throw Object.assign(new Error("该报表批次不存在或已删除。"), { status: 404, code: "ADS_BATCH_NOT_FOUND" });
    return deleted;
  }

  saveTargets({ shopId, effectiveFrom, sourceType = "manual", targets = [] } = {}) {
    const normalizedShopId = text(shopId);
    const effectiveDay = /^\d{4}-\d{2}-\d{2}$/.test(text(effectiveFrom)) ? text(effectiveFrom) : new Date().toISOString().slice(0, 10);
    if (!normalizedShopId || !Array.isArray(targets) || !targets.length) throw Object.assign(new Error("请至少提供一条目标ROAS。"), { status: 400, code: "ADS_TARGET_REQUIRED" });
    if (!TARGET_SOURCES.has(sourceType)) throw Object.assign(new Error("目标ROAS来源无效。"), { status: 400, code: "ADS_TARGET_SOURCE_INVALID" });
    const now = new Date().toISOString();
    const records = targets.map((item) => {
      const adName = text(item.adName);
      const productId = text(item.productId);
      const targetRoas = number(item.targetRoas);
      if (!adName || targetRoas <= 0) throw Object.assign(new Error("广告名称和正数目标ROAS不能为空。"), { status: 400, code: "ADS_TARGET_INVALID" });
      const targetKey = text(item.targetKey) || stableKey(productId, adName);
      return { id: randomUUID(), shopId: normalizedShopId, targetKey, productId, adName, targetRoas, sourceType,
        effectiveFrom: effectiveDay, effectiveTo: null, createdBy: "local_user", createdAt: now, updatedAt: now };
    });
    return { saved: this.repository.upsertTargets(records), targets: this.repository.listTargets(normalizedShopId, effectiveDay) };
  }

  dashboard({ shopId = null } = {}) {
    const allBatches = this.repository.listBatches({ shopId, limit: 80 });
    if (!allBatches.length) return { empty: true, batches: [], shops: [], findings: [], rows: [], summary: null };
    const shops = [...new Map(allBatches.map((batch) => [batch.shopId, { shopId: batch.shopId, shopName: batch.shopName }])).values()];
    const selectedShopId = text(shopId) || shops[0].shopId;
    const batches = allBatches.filter((batch) => batch.shopId === selectedShopId);
    const latestTo = batches[0].periodTo;
    const latestFor = (predicate) => batches.filter(predicate).sort((a, b) => b.periodTo.localeCompare(a.periodTo) || b.importedAt.localeCompare(a.importedAt))[0] || null;
    const dayBatch = latestFor((batch) => batch.periodDays === 1);
    const sevenBatch = latestFor((batch) => batch.periodDays >= 6 && batch.periodDays <= 8);
    const fourteenBatch = latestFor((batch) => batch.periodDays === 14);
    const previousFourteenBatch = fourteenBatch
      ? latestFor((batch) => batch.periodDays === 14 && batch.periodTo < fourteenBatch.periodFrom)
      : null;
    const longBatch = batches.filter((batch) => batch.periodDays >= 28).sort((a, b) => b.periodDays - a.periodDays || b.periodTo.localeCompare(a.periodTo))[0] || null;
    const dayFacts = dayBatch ? this.repository.listFacts(dayBatch.id) : [];
    const sevenFacts = sevenBatch ? this.repository.listFacts(sevenBatch.id) : [];
    const fourteenFacts = fourteenBatch ? this.repository.listFacts(fourteenBatch.id) : [];
    const previousFourteenFacts = previousFourteenBatch ? this.repository.listFacts(previousFourteenBatch.id) : [];
    const longFacts = longBatch ? this.repository.listFacts(longBatch.id) : [];
    const baseFacts = fourteenFacts.length ? fourteenFacts : sevenFacts.length ? sevenFacts : dayFacts.length ? dayFacts : longFacts;
    const dayMap = indexed(dayFacts); const sevenMap = indexed(sevenFacts); const fourteenMap = indexed(fourteenFacts);
    const previousFourteenMap = indexed(previousFourteenFacts); const longMap = indexed(longFacts);
    const targets = this.repository.listTargets(selectedShopId, latestTo);
    const targetMap = new Map(targets.map((target) => [target.targetKey, target]));
    const rows = baseFacts.filter((fact) => fact.adType === "Product Ad" && fact.status === "Ongoing").map((base) => {
      const dayFact = dayMap.get(base.adKey) || null; const sevenFact = sevenMap.get(base.adKey) || null;
      const fourteenFact = fourteenMap.get(base.adKey) || null; const previousFourteenFact = previousFourteenMap.get(base.adKey) || null;
      const longFact = longMap.get(base.adKey) || null;
      const day = metricWindow(dayFact); const seven = metricWindow(sevenFact); const fourteen = metricWindow(fourteenFact);
      const previousFourteen = metricWindow(previousFourteenFact); const long = metricWindow(longFact);
      const target = targetMap.get(base.adKey) || null;
      const decision = classifyEvidence({ fact: fourteenFact || sevenFact || dayFact || base, fourteen, previousFourteen, target, reportDate: latestTo });
      const detail = buildDecisionDetail({ fact: fourteenFact || sevenFact || dayFact || base, fourteen, previousFourteen, target, decision });
      return {
        adKey: base.adKey, adName: base.adName, productId: base.productId,
        status: base.status, biddingMethod: base.biddingMethod, startDate: base.startDate || null,
        priority: decision.priority, ruleCode: decision.ruleCode, diagnosis: decision.diagnosis,
        action: decision.action, guardrail: decision.guardrail, confidence: decision.confidence,
        mode: decision.mode, ageDays: decision.ageDays, inLearning: decision.inLearning,
        sampleEnough: decision.sampleEnough, targetAttainment: decision.attainment, fourteenTrend: decision.trend,
        targetRoas: target?.targetRoas ?? null,
        detail,
        day, seven, fourteen, previousFourteen, long,
      };
    });
    const order = { P0: 0, P1: 1, WAITING: 2, NORMAL: 3 };
    rows.sort((a, b) => order[a.priority] - order[b.priority]
      || (b.fourteen?.expense || b.seven?.expense || b.day?.expense || 0) - (a.fourteen?.expense || a.seven?.expense || a.day?.expense || 0));
    const findings = rows.filter((row) => row.priority !== "NORMAL").slice(0, 12);
    const coverage = {
      day: Boolean(dayBatch), seven: Boolean(sevenBatch), fourteen: Boolean(fourteenBatch),
      previousFourteen: Boolean(previousFourteenBatch), long: Boolean(longBatch),
    };
    const evidenceReady = coverage.fourteen;
    return {
      empty: false, selectedShopId, shops, batches: batches.slice(0, 12), dayBatch, sevenBatch,
      fourteenBatch, previousFourteenBatch, longBatch, targets, coverage, evidenceReady,
      summary: {
        reportDate: latestTo,
        day: dayFacts.length ? batchTotals(dayFacts) : null,
        dayProduct: dayFacts.length ? batchTotals(dayFacts, { productOnly: true }) : null,
        seven: sevenFacts.length ? batchTotals(sevenFacts) : null,
        sevenProduct: sevenFacts.length ? batchTotals(sevenFacts, { productOnly: true }) : null,
        fourteen: fourteenFacts.length ? batchTotals(fourteenFacts) : null,
        fourteenProduct: fourteenFacts.length ? batchTotals(fourteenFacts, { productOnly: true }) : null,
        previousFourteenProduct: previousFourteenFacts.length ? batchTotals(previousFourteenFacts, { productOnly: true }) : null,
        targetCoverage: rows.length ? round((rows.filter((row) => row.targetRoas).length / rows.length) * 100, 1) : 0,
        p0Count: rows.filter((row) => row.priority === "P0").length,
        p1Count: rows.filter((row) => row.priority === "P1").length,
        waitingCount: rows.filter((row) => row.priority === "WAITING").length,
        matureCount: rows.filter((row) => row.sampleEnough).length,
        learningCount: rows.filter((row) => row.inLearning).length,
        insufficientCount: rows.filter((row) => row.ruleCode === "sample_insufficient" || row.ruleCode === "needs_14d_evidence").length,
        holdCount: rows.filter((row) => row.priority === "NORMAL").length,
      },
      findings, rows,
    };
  }
}
