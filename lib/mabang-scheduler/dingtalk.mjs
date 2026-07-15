import { createHmac } from "node:crypto";

export function validateDingtalkWebhook(webhookUrl) {
  let parsed;
  try {
    parsed = new URL(String(webhookUrl || ""));
  } catch {
    throw new Error("钉钉 Webhook URL 格式无效。");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.toLowerCase().endsWith("dingtalk.com") || !parsed.pathname.includes("/robot/send")) {
    throw new Error("请填写钉钉官方自定义机器人的 HTTPS Webhook。");
  }
  return parsed.toString();
}

export function createDingtalkSignature(secret, timestamp = Date.now()) {
  if (!secret) return "";
  return createHmac("sha256", String(secret)).update(`${timestamp}\n${secret}`).digest("base64");
}

export function signedDingtalkWebhook(webhookUrl, secret, timestamp = Date.now()) {
  const parsed = new URL(validateDingtalkWebhook(webhookUrl));
  if (secret) {
    parsed.searchParams.set("timestamp", String(timestamp));
    parsed.searchParams.set("sign", createDingtalkSignature(secret, timestamp));
  }
  return parsed.toString();
}

export async function sendDingtalkMessage({ webhookUrl, secret = "", title, markdown, atAll = false, atMobiles = [], fetchImpl = fetch, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(signedDingtalkWebhook(webhookUrl, secret), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title: String(title || "Commerce Ops 通知"), text: String(markdown || "") },
        at: { isAtAll: Boolean(atAll), atMobiles: (atMobiles || []).map(String) },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data.errcode || 0) !== 0) {
      const error = new Error(`钉钉通知失败：HTTP ${response.status}，错误码 ${data.errcode ?? "unknown"}，${data.errmsg || "请求未成功"}`);
      error.code = "DINGTALK_REJECTED";
      throw error;
    }
    return { ok: true, status: response.status, code: data.errcode ?? 0, message: data.errmsg || "ok" };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`钉钉通知失败：请求超时 ${timeoutMs}ms。`);
      timeoutError.code = "DINGTALK_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function canExposeDownloadLink(baseUrl) {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host)) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return false;
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

function lines(values) {
  return (values || []).filter(Boolean).join("、") || "全部";
}

export function buildSuccessNotification({ task, run, filename, durationText, downloadUrl = "", dataSummary = {} }) {
  const inventoryTask = task.taskType === "inventory_export";
  const tail = downloadUrl
    ? `[下载 Excel](${downloadUrl})`
    : "文件已生成，请进入 Commerce Ops 的“执行记录”页面下载。";
  if (inventoryTask) {
    if (run.detailRowCount === 0) {
      return {
        title: "马帮库存定时任务已完成",
        markdown: [
          "### 马帮库存定时任务已完成", "", "本次未查询到库存明细。", "",
          `- 任务：${task.name}`, `- 执行时间：${new Date(run.startedAt || run.scheduledRunAt).toLocaleString("zh-CN", { timeZone: task.timezone, hour12: false })}`,
          "- 数据范围：执行时点库存快照", "- 状态：无数据",
        ].join("\n"),
      };
    }
    return {
      title: "马帮库存定时导出成功",
      markdown: [
        "### 马帮库存定时导出成功", "", `- 任务：${task.name}`,
        `- 执行时间：${new Date(run.startedAt || run.scheduledRunAt).toLocaleString("zh-CN", { timeZone: task.timezone, hour12: false })}`,
        "- 数据范围：执行时点库存快照", `- 库存明细：${run.detailRowCount} 行`,
        `- 库存总量：${dataSummary.total || "-"}`, `- 库存总成本：${dataSummary.totalCost || "-"}`,
        `- 在途库存：${dataSummary.inTransitTotal || "-"}`, `- 执行耗时：${durationText}`,
        `- 导出文件：${filename}`, "- 状态：成功", "", tail,
      ].join("\n"),
    };
  }
  const managerValues = task.filters.find((item) => item.fieldId === "uq172")?.values;
  const shopValues = task.filters.find((item) => item.fieldId === "uq135")?.values;
  if (run.filteredOrderCount === 0) {
    return {
      title: "马帮订单定时任务已完成",
      markdown: [
        "### 马帮订单定时任务已完成", "", "本次未查询到符合条件的订单。", "",
        `- 任务：${task.name}`, `- 付款日期：${run.paymentStartDate} 至 ${run.paymentEndDate}`,
        `- 店长：${lines(managerValues)}`, `- 店铺：${lines(shopValues)}`, "- 状态：无数据",
      ].join("\n"),
    };
  }
  return {
    title: "马帮订单定时导出成功",
    markdown: [
      "### 马帮订单定时导出成功", "", `- 任务：${task.name}`,
      `- 执行时间：${new Date(run.startedAt || run.scheduledRunAt).toLocaleString("zh-CN", { timeZone: task.timezone, hour12: false })}`,
      `- 付款日期：${run.paymentStartDate} 至 ${run.paymentEndDate}`, `- 店长：${lines(managerValues)}`,
      `- 店铺：${lines(shopValues)}`, `- 原始订单：${run.rawOrderCount} 单`,
      `- 筛选后订单：${run.filteredOrderCount} 单`, `- 订单明细：${run.detailRowCount} 行`,
      `- 执行耗时：${durationText}`, `- 导出文件：${filename}`, "- 状态：成功", "", tail,
    ].join("\n"),
  };
}

export function buildFailureNotification({ task, run, errorStage, errorMessage, retryCount }) {
  const dataLabel = task.taskType === "inventory_export" ? "库存" : "订单";
  return {
    title: `马帮${dataLabel}定时导出失败`,
    markdown: [
      `### 马帮${dataLabel}定时导出失败`, "", `- 任务：${task.name}`,
      `- 执行时间：${new Date().toLocaleString("zh-CN", { timeZone: task.timezone, hour12: false })}`,
      `- 失败阶段：${errorStage}`, `- 错误原因：${errorMessage}`, `- 已重试：${retryCount} 次`,
      "- 状态：失败", "", "请进入系统执行记录查看详细日志。",
    ].join("\n"),
  };
}
