import { decryptSecret } from "../mabang-scheduler/crypto.mjs";
import { sendDingtalkMessage } from "../mabang-scheduler/dingtalk.mjs";
import { selectRepresentativePriceChanges } from "./price-control-contracts.mjs";

const PLATFORM_LABELS = Object.freeze({ LAZADA: "Lazada", SHOPEE: "Shopee", TIKTOK: "TikTok Shop" });

function displayTime(value) {
  if (!value) return "—";
  return new Date(String(value).replace(" ", "T")).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

function countBy(changes, key) {
  return changes.reduce((result, item) => {
    const value = item[key] || "未知";
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}

function summaryLine(values) {
  return Object.entries(values).map(([name, count]) => `${name} ${count}`).join("、") || "无";
}

function platformSummary(changes) {
  const counts = countBy(changes, "platform");
  return Object.entries(counts)
    .sort(([left], [right]) => ["LAZADA", "SHOPEE", "TIKTOK"].indexOf(left) - ["LAZADA", "SHOPEE", "TIKTOK"].indexOf(right))
    .map(([platform, count]) => `${PLATFORM_LABELS[platform] || platform} ${count}`)
    .join("、") || "无";
}

export function buildPriceControlChangeNotification(result, { visibleLimit = 30 } = {}) {
  const changes = result?.changes || [];
  const run = result?.run || {};
  const visible = selectRepresentativePriceChanges(changes, visibleLimit);
  const hiddenCount = Math.max(0, changes.length - visible.length);
  return {
    title: `控价变更提醒：${changes.length} 条`,
    markdown: [
      `### 控价变更提醒（${changes.length} 条）`,
      "",
      `- 最新审批数据时间：${displayTime(run.sourceBusinessUpdatedAt)}`,
      `- 源表更新时间：${displayTime(run.sourceTableUpdatedAt)}`,
      `- 本次获取时间：${displayTime(run.fetchedAt || run.finishedAt)}`,
      `- 国家分布：${summaryLine(countBy(changes, "countryCode"))}`,
      `- 平台分布：${platformSummary(changes)}`,
      `- 方向分布：${summaryLine(countBy(changes, "direction"))}`,
      "",
      ...visible.map((change, index) => `${index + 1}. ${change.changeText}`),
      ...(hiddenCount ? ["", `另有 ${hiddenCount} 条变更，请进入 Commerce Ops 控价变更模块查看。`] : []),
      "",
      "请人工核对后复制到马帮刊登功能页；系统不会自动刊登。",
    ].join("\n"),
  };
}

export function buildPriceControlFailureNotification(error, now = new Date()) {
  return {
    title: "控价定时获取失败",
    markdown: [
      "### 控价定时获取失败",
      "",
      `- 时间：${displayTime(now.toISOString())}`,
      `- 错误代码：${String(error?.code || "PRICE_CONTROL_SYNC_FAILED").slice(0, 80)}`,
      "- 处理建议：请进入 Commerce Ops 操作记录和控价同步记录查看详情。",
    ].join("\n"),
  };
}

export class PriceControlDingtalkNotifier {
  constructor({ configRepository, notify = sendDingtalkMessage, audit = null }) {
    this.configRepository = configRepository;
    this.notify = notify;
    this.audit = audit;
  }

  async robot(settings) {
    const robot = settings?.dingtalkConfigId
      ? await this.configRepository?.getDingtalkConfig(settings.dingtalkConfigId, { includeSecret: true })
      : null;
    if (!robot?.enabled || !robot.encryptedWebhookUrl) {
      const error = new Error("控价定时任务未绑定可用的钉钉机器人。");
      error.code = "PRICE_CONTROL_DINGTALK_NOT_CONFIGURED";
      throw error;
    }
    return {
      ...robot,
      webhookUrl: decryptSecret(robot.encryptedWebhookUrl),
      secret: robot.encryptedSecret ? decryptSecret(robot.encryptedSecret) : "",
    };
  }

  async sendChanges({ settings, result }) {
    const robot = await this.robot(settings);
    const notification = buildPriceControlChangeNotification(result);
    try {
      const sent = await this.notify({
        ...notification,
        webhookUrl: robot.webhookUrl,
        secret: robot.secret,
        atAll: robot.atAll,
        atMobiles: robot.atMobiles,
      });
      await this.audit?.recordSafely({
        module: "price_control",
        action: "product.price_control.dingtalk.sent",
        status: "success",
        runId: result.run.id,
        metadata: { changeCount: result.changes.length, robotId: robot.id },
      });
      return sent;
    } catch (error) {
      await this.audit?.recordSafely({
        module: "price_control",
        action: "product.price_control.dingtalk.failed",
        status: "failed",
        runId: result.run.id,
        errorCode: error?.code || "PRICE_CONTROL_DINGTALK_FAILED",
        errorSummary: error,
        metadata: { changeCount: result.changes.length, robotId: robot.id },
      });
      throw error;
    }
  }

  async sendFailure({ settings, error, now = new Date() }) {
    const robot = await this.robot(settings);
    return this.notify({
      ...buildPriceControlFailureNotification(error, now),
      webhookUrl: robot.webhookUrl,
      secret: robot.secret,
      atAll: robot.atAll,
      atMobiles: robot.atMobiles,
    });
  }
}
