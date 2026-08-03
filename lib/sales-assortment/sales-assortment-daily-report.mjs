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

function signedPercent(value) {
  const result = number(value);
  return `${result > 0 ? "+" : ""}${result.toFixed(1)}%`;
}

function appendMovements(lines, title, group, valueKey, unit) {
  lines.push("", `#### ${title}`, "");
  const declines = (group?.declines || []).slice(0, 3);
  const growth = (group?.growth || []).slice(0, 3);
  if (!declines.length && !growth.length) {
    lines.push("- 当前窗口未识别到达到门槛的变化。");
    return;
  }
  for (const item of declines) {
    const name = item.store || item.style || item.productName || "未命名对象";
    lines.push(`- **下滑 · ${name}**：${signedPercent(item.changeRate)}，影响 ${number(item[valueKey]).toLocaleString("zh-CN")} ${unit}`);
  }
  for (const item of growth) {
    const name = item.store || item.style || item.productName || "未命名对象";
    lines.push(`- **增长 · ${name}**：${signedPercent(item.changeRate)}，影响 ${number(item[valueKey]).toLocaleString("zh-CN")} ${unit}`);
  }
}

export function buildSalesAssortmentDailyReport({ dashboard, analysis = null, generatedAt = new Date() }) {
  const summary = dashboard?.summary || {};
  const alerts = (dashboard?.priorityAlerts || []).slice(0, 10);
  const aiModule = analysis?.analysis?.modules?.dailyReport;
  const movementWindows = dashboard?.dailyReport?.sections?.movementWindows || {};
  const inventoryChanges = (dashboard?.dailyReport?.sections?.inventoryInsights || [])
    .filter((item) => ["rapid_drop", "restock_arrival", "new_arrival", "stockout", "low_stock"].includes(item.type))
    .slice(0, 5);
  const lines = [
    "### 销售与货盘经营日报",
    "",
    `> 数据日期：${dashboard?.dailyReport?.reportDate || "暂无"} · 生成时间：${generatedAt.toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "#### 今日经营指标",
    "",
    `- 我方 GMV：**${money(summary.ownAmount)}**`,
    `- 货盘 GMV：**${money(summary.assortmentAmount)}**`,
    `- 我方占比：**${percent(summary.ownShare)}**`,
    `- GMV 缺口：**${money(summary.gapAmount)}**`,
    `- 订单量：**${number(summary.orderCount).toLocaleString("zh-CN")} 单**`,
    `- 客单价：**${money(summary.averageOrderValue)}**`,
  ];
  appendMovements(lines, "店铺昨日与前日", movementWindows.stores1d, "impactAmount", "元");
  appendMovements(lines, "店铺近7日趋势", movementWindows.stores7d, "impactAmount", "元");
  appendMovements(lines, "款名昨日与前日", movementWindows.styles1d, "impactQuantity", "件");
  appendMovements(lines, "款名近7日趋势", movementWindows.styles7d, "impactQuantity", "件");
  lines.push("", "#### 库存快照变化", "");
  if (!inventoryChanges.length) lines.push("- 当前没有可核对的重点库存变化。");
  for (const item of inventoryChanges) {
    const change = item.inventoryChange === null ? "暂无上次快照" : `${item.inventoryChange > 0 ? "+" : ""}${item.inventoryChange}`;
    lines.push(`- **${item.productName}**：库存变化 ${change}，货盘 GMV ${money(item.assortmentAmount)}；${item.action}`);
  }
  lines.push("", "#### 今日优先事项", "");
  if (alerts.length === 0) lines.push("- 当前规则未识别到高优先级异常。");
  for (const [index, alert] of alerts.entries()) {
    lines.push(`${index + 1}. **[${alert.priority}] ${alert.title}**`);
    lines.push(`   - ${alert.metricLabel}：${alert.metricValue}`);
    lines.push(`   - 建议：${alert.action}`);
  }
  if (aiModule) {
    lines.push("", "#### DeepSeek 经营摘要", "", `**${aiModule.headline}**`, "", aiModule.summary);
    for (const item of (aiModule.recommendations || []).slice(0, 3)) {
      lines.push(`- **${item.priority} · ${item.title}**：${item.action}`);
    }
  } else {
    lines.push("", "> DeepSeek 本次不可用或未配置；以上日报仍由确定性规则生成。");
  }
  lines.push("", "---", "本日报只提供运营核查方向，不自动执行改价、补货或刊登动作。");
  return {
    version: "SALES-ASSORTMENT-DAILY-1.2.0",
    title: `销售与货盘经营日报 ${dashboard?.dailyReport?.reportDate || ""}`.trim(),
    markdown: lines.join("\n"),
    itemCount: alerts.length,
    orderCount: number(summary.orderCount),
    aiIncluded: Boolean(aiModule),
  };
}
