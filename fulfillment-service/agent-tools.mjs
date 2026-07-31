import { FulfillmentError } from "./service.mjs";

const TOOL_NAMES = Object.freeze([
  "get_dashboard", "get_scheduler_status", "list_recent_batches", "get_batch",
  "get_preview", "inspect_shop_orders", "preflight_order",
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function requiredId(value, label, max = 160) {
  const text = String(value || "").trim();
  if (!text || text.length > max || !/^[\p{L}\p{N}._:-]+$/u.test(text)) {
    throw new FulfillmentError("AGENT_ARGUMENT_INVALID", `${label} 无效`, 400);
  }
  return text;
}

function safePreview(preview) {
  if (!preview || typeof preview !== "object") return preview;
  const { confirmationToken: _confirmationToken, ...result } = preview;
  return { ...result, requiresConfirmation: true, agentCanConfirm: false };
}

export class FulfillmentAgentTools {
  constructor({ repository, scheduler, serviceForShop, serviceForPreview, dashboardWindows, now = () => new Date() }) {
    this.repository = repository;
    this.scheduler = scheduler;
    this.serviceForShop = serviceForShop;
    this.serviceForPreview = serviceForPreview;
    this.dashboardWindows = dashboardWindows;
    this.now = now;
  }

  names() { return [...TOOL_NAMES]; }

  async execute(name, rawArguments = {}) {
    if (!TOOL_NAMES.includes(name)) {
      throw new FulfillmentError("AGENT_TOOL_FORBIDDEN", `Agent 不允许调用工具 ${String(name || "")}`, 403);
    }
    const args = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments) ? rawArguments : {};
    if (name === "get_dashboard") {
      const days = boundedInteger(args.days, 7, 1, 30);
      return this.repository.getDashboardSummary(this.dashboardWindows(this.now(), days));
    }
    if (name === "get_scheduler_status") return this.scheduler.status();
    if (name === "list_recent_batches") {
      return this.serviceForShop().listRecentBatches(boundedInteger(args.limit, 10, 1, 20)).map((batch) => ({
        id: batch.id, previewId: batch.previewId, status: batch.status, createdAt: batch.createdAt,
        finishedAt: batch.finishedAt, orderCount: batch.orders?.length || 0,
        successCount: batch.orders?.filter((order) => order.status === "success").length || 0,
        attentionCount: batch.orders?.filter((order) => order.status === "needs_attention").length || 0,
      }));
    }
    if (name === "get_batch") {
      return this.serviceForShop().getBatch(requiredId(args.batchId, "批次 ID"));
    }
    if (name === "get_preview") {
      const previewId = requiredId(args.previewId, "预览 ID");
      return safePreview(this.serviceForPreview(previewId).getPreview(previewId));
    }
    if (name === "inspect_shop_orders") {
      const shopId = requiredId(args.shopId, "店铺 ID", 24);
      const request = { limit: boundedInteger(args.limit, 10, 1, 10) };
      if (args.orderIds !== undefined) {
        if (!Array.isArray(args.orderIds) || args.orderIds.length > 10) {
          throw new FulfillmentError("AGENT_ARGUMENT_INVALID", "orderIds 必须是最多 10 项的数组", 400);
        }
        request.orderIds = args.orderIds.map((value) => requiredId(value, "订单号"));
      }
      return safePreview(await this.serviceForShop(shopId).createPreview(request));
    }
    const shopId = requiredId(args.shopId, "店铺 ID", 24);
    const orderId = requiredId(args.orderId, "订单号");
    const shopService = this.serviceForShop(shopId);
    return shopService.runPreflight(orderId, shopService.preflight);
  }
}

export { TOOL_NAMES as FULFILLMENT_AGENT_TOOL_NAMES };
