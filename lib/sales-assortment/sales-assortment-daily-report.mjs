function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function money(value) {
  return `¥${Math.round(number(value)).toLocaleString("zh-CN")}`;
}

function percent(value) {
  return `${number(value).toFixed(1)}%`;
}

export function salesReportDateFor(generatedAt = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(generatedAt.getTime() - 86400000));
}

export function salesDailyReportScopeFor(generatedAt = new Date()) {
  const reportDate = salesReportDateFor(generatedAt);
  return {
    periodDays: 1,
    dateFrom: reportDate,
    dateTo: reportDate,
    comparisonDays: 7,
  };
}

function signedPercent(value) {
  const result = number(value);
  return `${result > 0 ? "+" : ""}${result.toFixed(1)}%`;
}

function appendStyleStoreImpacts(lines, item, direction) {
  if (!item?.style) return;
  const matching = (item.storeImpacts || []).filter((store) => (
    direction === "decline" ? number(store.quantityChange) < 0 : number(store.quantityChange) > 0
  ));
  const stores = (matching.length ? matching : (item.storeImpacts || [])).slice(0, 3);
  if (!stores.length) return;
  const summary = stores.map((store) => {
    const manager = store.manager ? ` / ${store.manager}` : "";
    const change = number(store.quantityChange);
    return `**${store.store || "未命名店铺"}${manager}** ${change > 0 ? "+" : ""}${change.toLocaleString("zh-CN")} 件（${signedPercent(store.changeRate)}）`;
  }).join("；");
  lines.push(`  - 主要影响店铺：${summary}`);
}

function appendMovements(lines, title, group, valueKey, unit) {
  lines.push("", `#### ${title}`, "");
  const declines = (group?.declines || []).slice(0, 3);
  const growth = (group?.growth || []).slice(0, 3);
  if (!declines.length && !growth.length) {
    lines.push("- 当前窗口未识别到达到门槛的变化。");
    return;
  }
  if (declines.length) lines.push("##### 🟢 下滑", "");
  for (const item of declines) {
    const name = item.store || item.style || item.productName || "未命名对象";
    lines.push(`- 🟢 **${name}**：环比 **${signedPercent(item.changeRate)}**，影响 **${number(item[valueKey]).toLocaleString("zh-CN")} ${unit}**`);
    appendStyleStoreImpacts(lines, item, "decline");
  }
  if (growth.length) lines.push("", "##### 🔴 上涨", "");
  for (const item of growth) {
    const name = item.store || item.style || item.productName || "未命名对象";
    lines.push(`- 🔴 **${name}**：环比 **${signedPercent(item.changeRate)}**，影响 **${number(item[valueKey]).toLocaleString("zh-CN")} ${unit}**`);
    appendStyleStoreImpacts(lines, item, "growth");
  }
}

const AI_SECTION_LABELS = Object.freeze({
  operatingOverview: "经营概览",
  storeAnomalies: "店铺异常分析",
  productAnomalies: "商品 / SKU 异常分析",
  inventoryRisks: "库存风险分析",
  businessOpportunities: "商业机会分析",
  sevenDayTrends: "近 7 日趋势分析",
});

function appendAiDecisionReport(lines, report) {
  lines.push(
    "",
    "#### DeepSeek 运营决策 V2.1",
    "",
    `**${report.headline}**`,
    "",
    report.executiveSummary,
  );
  for (const [key, label] of Object.entries(AI_SECTION_LABELS)) {
    const section = report.sections?.[key];
    if (!section) continue;
    lines.push("", `##### ${label}`, "", section.summary);
    const findings = (section.findings || []).slice(0, 2);
    if (!findings.length) {
      lines.push("- 当前 Evidence Pack 未筛选出需要升级处理的对象。");
      continue;
    }
    for (const finding of findings) {
      const marker = finding.priority === "P0" || finding.priority === "P1" ? "🔴" : "🟠";
      lines.push(`- ${marker} **[${finding.priority}] ${finding.objectName}**`);
      lines.push(`  - 数据变化：**${finding.dataChange}**`);
      lines.push(`  - 影响规模：**${finding.impactScale}**`);
      lines.push(`  - 判断：${finding.reason}`);
      lines.push(`  - 建议：**${finding.recommendedAction}**`);
    }
  }
  if (report.dataLimitations?.length) {
    lines.push("", "##### 数据限制", "");
    for (const limitation of report.dataLimitations.slice(0, 5)) {
      lines.push(`- ${limitation}`);
    }
  }
}

function appendLegacyAiSummary(lines, report) {
  lines.push("", "#### DeepSeek 经营摘要（旧版兼容）", "", `**${report.headline}**`, "", report.summary);
  for (const item of (report.recommendations || []).slice(0, 3)) {
    const marker = item.priority === "P0" || item.priority === "P1" ? "🔴" : "🟢";
    lines.push(`- ${marker} **${item.priority} · ${item.title}**：${item.action}`);
  }
}

function actualSalesDisplay(summary) {
  if (summary.actualSalesAmountAvailability === "unavailable") return "待确认";
  const currencyEntries = Object.entries(summary.actualSalesAmountsByCurrency || {});
  const fallbackEntry = currencyEntries.length === 1 ? currencyEntries[0] : null;
  const currency = summary.actualSalesAmountCurrency || fallbackEntry?.[0] || "";
  const rawAmount = summary.actualSalesAmount ?? fallbackEntry?.[1];
  const amount = rawAmount == null ? null : Number(rawAmount);
  if (currency && amount !== null && Number.isFinite(amount)) {
    return `${currency} ${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${summary.actualSalesAmountAvailability === "partial" ? "（部分）" : ""}`;
  }
  return summary.actualSalesAmountAvailability === "partial" ? "多币种（部分）" : "—";
}

function actualSalesCoverageText(summary) {
  const coverage = summary.actualSalesOrderCoverage;
  if (!coverage) return "按订单头“订单核算金额（人民币）”去重；缺失金额不按 0，类目 / SKU 部分命中不计整单且不分摊。";
  return `订单金额覆盖 ${number(coverage.confirmedOrderCount).toLocaleString("zh-CN")}/${number(coverage.totalOrderCount).toLocaleString("zh-CN")} 单；缺失金额不按 0，类目 / SKU 部分命中 ${number(coverage.partialAttributionOrderCount).toLocaleString("zh-CN")} 单，不计整单且不分摊。`;
}

export function buildSalesAssortmentDailyReport({ dashboard, analysis = null, generatedAt = new Date() }) {
  const summary = dashboard?.summary || {};
  const actualSales = actualSalesDisplay(summary);
  const alerts = (dashboard?.priorityAlerts || []).slice(0, 10);
  const aiReport = analysis?.analysis?.fullReport || null;
  const legacyAiModule = analysis?.analysis?.modules?.dailyReport || null;
  const movementWindows = dashboard?.dailyReport?.sections?.movementWindows || {};
  const inventoryChanges = (dashboard?.dailyReport?.sections?.inventoryInsights || [])
    .filter((item) => ["rapid_drop", "restock_arrival", "new_arrival", "stockout", "low_stock"].includes(item.type))
    .slice(0, 5);
  const lines = [
    "### 销售与货盘经营日报",
    "",
    `> 数据日期：${dashboard?.dailyReport?.reportDate || "暂无"} · 生成时间：${generatedAt.toLocaleString("zh-CN", { hour12: false })}`,
    "> 变化标识：🟢 下滑 · 🔴 上涨",
    "> 金额口径：标准化估值来自目标利润标价，仅用于横向比较，不等同于实际销售额或 GMV。",
    "",
    "#### 今日经营指标",
    "",
    `- 实际销售额：**${actualSales}**`,
    `  - 口径：${actualSalesCoverageText(summary)}`,
    `- 我方标准化估值：**${money(summary.ownEstimatedAmount ?? summary.ownAmount)}**`,
    `- 货盘标准化估值：**${money(summary.assortmentEstimatedAmount ?? summary.assortmentAmount)}**`,
    `- 标准化承接占比：**${percent(summary.ownShare)}**`,
    `- 标准化估值缺口：**${money(summary.estimatedGapAmount ?? summary.gapAmount)}**`,
    `- 订单量：**${number(summary.orderCount).toLocaleString("zh-CN")} 单**`,
    `- 估算单均值：**${money(summary.estimatedAverageOrderValue ?? summary.averageOrderValue)}**`,
  ];
  appendMovements(lines, "店铺昨日与前日", movementWindows.stores1d, "impactAmount", "元");
  appendMovements(lines, "店铺近7日趋势（最近7天环比前7天）", movementWindows.stores7d, "impactAmount", "元");
  appendMovements(lines, "款名昨日与前日", movementWindows.styles1d, "impactQuantity", "件");
  appendMovements(lines, "款名近7日趋势（最近7天环比前7天）", movementWindows.styles7d, "impactQuantity", "件");
  lines.push("", "#### 库存快照变化", "");
  if (!inventoryChanges.length) lines.push("- 当前没有可核对的重点库存变化。");
  for (const item of inventoryChanges) {
    const change = item.inventoryChange === null ? "暂无上次快照" : `${item.inventoryChange > 0 ? "+" : ""}${item.inventoryChange}`;
    const marker = item.inventoryChange === null ? "⚪" : item.inventoryChange > 0 ? "🔴" : item.inventoryChange < 0 ? "🟢" : "⚪";
    lines.push(`- ${marker} **${item.country || "国家未映射"} · ${item.productName}**：库存变化 **${change}**，货盘标准化估值 **${money(item.assortmentAmount)}**；${item.action}`);
  }
  lines.push("", "#### 今日优先事项", "");
  if (alerts.length === 0) lines.push("- 当前规则未识别到高优先级异常。");
  for (const [index, alert] of alerts.entries()) {
    const marker = alert.priority === "P0" || alert.priority === "P1" ? "🔴" : "🟢";
    lines.push(`${index + 1}. ${marker} **[${alert.priority}] ${alert.title}**`);
    lines.push(`   - ${alert.metricLabel}：${alert.metricValue}`);
    lines.push(`   - 建议：${alert.action}`);
  }
  if (aiReport) {
    appendAiDecisionReport(lines, aiReport);
  } else if (legacyAiModule) {
    appendLegacyAiSummary(lines, legacyAiModule);
  } else {
    lines.push("", "> DeepSeek 本次不可用或未配置；以上日报仍由确定性规则生成。");
  }
  lines.push("", "---", "本日报只提供运营核查方向，不自动执行改价、补货或刊登动作。");
  return {
    version: "SALES-ASSORTMENT-DAILY-1.5.0",
    title: `销售与货盘经营日报 ${dashboard?.dailyReport?.reportDate || ""}`.trim(),
    markdown: lines.join("\n"),
    itemCount: alerts.length,
    orderCount: number(summary.orderCount),
    aiIncluded: Boolean(aiReport || legacyAiModule),
    agentTaskId: analysis?.agentTaskId || null,
  };
}
