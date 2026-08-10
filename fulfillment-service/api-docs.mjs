export function createOpenApiDocument(config) {
  const orderSummary = {
    type: "object",
    properties: {
      displayOrderId: { type: "string", description: "用于展示的订单号" },
      tradeNumber: { type: "string", description: "平台交易编号" },
      warehouse: { type: "string" },
      skuCount: { type: "integer" },
      stockStatus: { type: "string", enum: ["in_stock", "out_of_stock", "unknown"], description: "库存判断结果" },
      isOutOfStock: { type: "boolean", nullable: true, description: "库存未知时为 null" },
      requiredQuantity: { type: "number", nullable: true, description: "订单需要数量" },
      totalItemQuantity: { type: "number", description: "订单内所有 SKU 的商品总件数" },
      availableQuantity: { type: "number", nullable: true, description: "单 SKU 时的马帮商品库存；多 SKU 或文本库存状态时为 null" },
      outOfStockItemCount: { type: "integer", description: "缺货 SKU 种类数" },
      unknownStockItemCount: { type: "integer", description: "库存未知 SKU 种类数" },
      eligible: { type: "boolean" },
      exclusions: { type: "array", items: { type: "string" } },
    },
  };
  const preview = {
    type: "object",
    properties: {
      previewId: { type: "string", format: "uuid" },
      status: { type: "string", example: "pending" },
      expiresAt: { type: "string", format: "date-time" },
      shop: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      channel: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      eligibleOrders: { type: "array", items: orderSummary },
      excludedOrders: { type: "array", items: orderSummary },
      requiresConfirmation: { type: "boolean" },
      confirmationToken: { type: "string", description: "仅创建预览时返回，10分钟内有效" },
    },
  };
  const batchOrder = {
    type: "object",
    properties: {
      displayOrderId: { type: "string", description: "平台展示订单号" },
      status: { type: "string", enum: ["queued", "success", "needs_attention", "failed", "skipped"] },
      trackingNumberMasked: { type: "string", nullable: true, description: "脱敏运单号" },
      beforeStatus: { type: "string", description: "提交前状态，预期为待处理" },
      afterStatus: { type: "string", description: "最终回查状态；成功时必须为配货中" },
      errorCode: { type: "string", nullable: true },
      errorMessage: { type: "string", nullable: true },
      timings: { type: "object", nullable: true, description: "毫秒耗时：安全准备、提交请求、等待运单号、转配货请求、状态回查和逐单总耗时" },
    },
  };
  const batch = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      previewId: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["queued", "running", "success", "partial_success", "failed"] },
      createdAt: { type: "string", format: "date-time" },
      finishedAt: { type: "string", format: "date-time", nullable: true },
      timings: { type: "object", nullable: true, description: "毫秒耗时：整批提交前复检、逐单执行和批次总耗时" },
      orders: { type: "array", items: batchOrder },
    },
  };
  return {
    openapi: "3.0.3",
    info: {
      title: "马帮自动发货 API",
      version: "0.6.0",
      description: `一个马帮账号下的 ${config.shops.length} 个已配置店铺，每店铺每批最多10单。国家、平台、店铺、渠道、仓库范围和自动发货开关由独立配置文件维护；环境变量继续作为全局开关和店铺白名单。`,
    },
    servers: [{ url: `http://${config.host}:${config.port}`, description: "本机服务" }],
    tags: [{ name: "状态" }, { name: "只读 Agent" }, { name: "看板" }, { name: "定时预览" }, { name: "发货预览与确认" }, { name: "批次" }, { name: "运单恢复" }, { name: "待审核恢复" }, { name: "人工处理" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "仅在配置 FULFILLMENT_API_TOKEN 后需要" } },
      schemas: {
        Preview: preview,
        Batch: batch,
        SuccessPreview: { type: "object", properties: { success: { type: "boolean", example: true }, data: preview } },
        SuccessBatch: { type: "object", properties: { success: { type: "boolean", example: true }, data: batch } },
        Error: { type: "object", properties: { success: { type: "boolean", example: false }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
      },
    },
    paths: {
      "/health": {
        get: { tags: ["状态"], summary: "检查服务状态", responses: { 200: { description: "服务正常" } } },
      },
      "/api/fulfillment/agent/status": {
        get: { tags: ["只读 Agent"], summary: "查看发货 Agent 状态与只读工具清单", security: [{ bearerAuth: [] }],
          responses: { 200: { description: "返回 enabled、configured、mode、模型、提示词版本和工具清单" } } },
      },
      "/api/fulfillment/agent/chat": {
        post: { tags: ["只读 Agent"], summary: "与马帮发货运营 Agent 对话", security: [{ bearerAuth: [] }],
          description: "第一阶段只读 Agent。可以查询看板、调度状态、预览、批次并执行安全预检；没有确认发货、异常恢复、清空渠道或修改配置工具。",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["message"],
            properties: { message: { type: "string", minLength: 1, maxLength: 4000 },
              conversationId: { type: "string", description: "可选；用于本进程内的短期连续对话" } } } } } },
          responses: { 200: { description: "返回中文答复、只读模式以及本轮工具审计摘要" },
            409: { description: "Agent 已关闭、模型未配置或达到步数上限" },
            502: { description: "模型响应或上游服务异常" } } },
      },
      "/api/fulfillment/notifications/test": {
        post: { tags: ["状态"], summary: "发送 Windows 测试通知", security: [{ bearerAuth: [] }],
          responses: { 200: { description: "通知命令执行成功" }, 409: { description: "通知关闭或 Windows 命令执行失败" } } },
      },
      "/api/fulfillment/scheduler": {
        get: { tags: ["定时预览"], summary: "查看定时扫描状态", security: [{ bearerAuth: [] }],
          responses: { 200: { description: "返回开关、间隔、最近扫描结果、运行批次、待确认预览，以及 lastScanStrategy 和 lastSharedCollectionMs 共享扫描指标" } } },
      },
      "/api/fulfillment/dashboard": {
        get: { tags: ["看板"], summary: "获取履约运营看板统计", security: [{ bearerAuth: [] }],
          parameters: [{ name: "days", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 30, default: 7 } }],
          description: "按北京时间统计今日真实发货、成功、执行中、异常、店铺表现、耗时和近期开单趋势；同时返回当前运单恢复及人工处理队列。只读接口，不会触发扫描或发货。",
          responses: { 200: { description: "返回完整数据库口径的运营看板数据" } } },
      },
      "/api/fulfillment/scheduler/scan": {
        post: { tags: ["定时预览"], summary: "立即扫描并按店铺规则自动发货", security: [{ bearerAuth: [] }],
          description: "读取待处理订单并生成分店铺预览。自动发货已启用的店铺会在安全检查通过后创建真实发货批次；其他店铺只保留待确认预览。缺货和库存未知订单一律排除，同一时间只启动一个批次。",
          responses: { 200: { description: "扫描完成或安全跳过" }, 409: { description: "马帮登录或订单读取失败" } } },
      },
      "/api/fulfillment/tracking-recoveries": {
        get: { tags: ["运单恢复"], summary: "查看待审批运单号恢复队列", security: [{ bearerAuth: [] }],
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }],
          description: "查看等待运单号、已清空待重交、重新交运中、重新交运后等待以及人工处理等状态。运单号仅以脱敏形式保存。",
          responses: { 200: { description: "返回跨店铺恢复队列" } } },
      },
      "/api/fulfillment/tracking-recoveries/check": {
        post: { tags: ["运单恢复"], summary: "立即执行一次运单号回查与到期恢复", security: [{ bearerAuth: [] }],
          description: "这是可能产生真实马帮写操作的接口。自动模式要求 FULFILLMENT_TRACKING_RECOVERY_RESET_ENABLED=true；单笔受控测试可同时提供 shopId、orderId 和固定确认标记 TRACKING_RECOVERY_CONFIRMED，仅授权这一单。系统只对超过30分钟、待处理、无运单号、库存有货且存在 Pending 交运记录的订单清空物流渠道，然后仅重新交运一次。",
          requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
            shopId: { type: "string", description: "不填时检查全部已配置店铺" },
            orderId: { type: "string", description: "受控测试时填写，只处理这一笔恢复队列中的订单" },
            confirmation: { type: "string", description: "全局开关关闭时，单笔真实恢复必须精确填写 TRACKING_RECOVERY_CONFIRMED" },
          } }, example: { shopId: "2021578358", orderId: "26072905HDE2JF", confirmation: "TRACKING_RECOVERY_CONFIRMED" } } } },
          responses: { 200: { description: "返回每个店铺和订单本轮处理结果" }, 409: { description: "当前正在扫描或执行发货批次" } } },
      },
      "/api/fulfillment/manual-reviews/recheck": {
        post: { tags: ["人工处理"], summary: "重新核对换仓后的订单并解除人工处理锁（不提交发货）", security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["shopId", "orderId"], properties: {
            shopId: { type: "string", example: "2021485965" }, orderId: { type: "string", example: "260728TQYWBBTD" },
          } } } } },
          responses: { 200: { description: "仓库、库存、状态、渠道和空运单号均通过，人工锁已解除；本次不会提交发货" },
            404: { description: "没有找到对应人工处理订单" }, 409: { description: "仍为多仓、状态未恢复、深度预检失败或系统忙" } } },
      },
      "/api/fulfillment/message-review-recoveries/candidates": {
        get: { tags: ["待审核恢复"], summary: "只读检查可恢复的待审核留言异常订单", security: [{ bearerAuth: [] }],
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 10, default: 3 } }],
          description: "只返回同时满足留言单一异常、配置店铺与平台匹配、无运单号、库存安全、导出状态仍为待审核、全部 SKU 位于同一仓库且库存充足的订单；不会修改马帮订单。",
          responses: { 200: { description: "返回通过全部恢复前检查的候选订单" }, 409: { description: "马帮读取失败或当前系统忙" } } },
      },
      "/api/fulfillment/message-review-recoveries": {
        post: { tags: ["待审核恢复"], summary: "恢复一笔待审核留言异常订单", security: [{ bearerAuth: [] }],
          description: "这是马帮真实写操作。每次只允许一笔订单，必须提供固定确认标记。服务会重新执行全部安全检查，调用异常订单处理接口，再回查订单已经转为待处理；随后延迟执行定向完整安全扫描，同一轮不会直接发货。",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["orderId", "confirmation"], properties: {
            orderId: { type: "string", description: "马帮订单编号或平台交易编号" },
            confirmation: { type: "string", enum: ["MESSAGE_REVIEW_RECOVERY_CONFIRMED"] },
          } }, example: { orderId: "填写待恢复订单号", confirmation: "MESSAGE_REVIEW_RECOVERY_CONFIRMED" } } } },
          responses: { 200: { description: "恢复已确认，并已安排延迟定向复扫" }, 400: { description: "订单号或确认标记无效" }, 409: { description: "安全检查未通过、恢复后状态未变化或系统忙" } } },
      },
      "/api/fulfillment/message-review-recoveries/mode": {
        put: { tags: ["待审核恢复"], summary: "设置待审核留言订单处理方式", security: [{ bearerAuth: [] }],
          description: "模式保存在履约数据库并即时生效：off 只读展示且拒绝恢复；manual 允许逐单固定确认；auto 按独立间隔自动恢复全部安全检查通过的候选。切换时若调度或发货批次正在运行会安全拒绝。",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["mode"], properties: {
            mode: { type: "string", enum: ["off", "manual", "auto"] },
          } }, example: { mode: "manual" } } } },
          responses: { 200: { description: "模式已持久化并返回最新履约设置" }, 400: { description: "模式无效" }, 409: { description: "账号未连接或系统正在处理订单" } } },
      },
      "/api/fulfillment/previews": {
        post: {
          tags: ["发货预览与确认"], summary: "生成发货预览", security: [{ bearerAuth: [] }],
          requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
            shopId: { type: "string", description: "已配置的印尼店铺ID；不填时默认 JOJO Mall" },
            limit: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "未指定订单号时使用" },
            orderIds: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string" }, description: "指定马帮订单编号或 Shopee 交易编号；设置后会定向批量读取，不扫描其他订单" },
          } }, example: { orderIds: ["填写待测试订单号"] } } } },
          responses: { 201: { description: "预览已生成", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessPreview" } } } }, 400: { description: "参数错误" }, 500: { description: "马帮数据源或服务错误" } },
        },
      },
      "/api/fulfillment/preflights": {
        post: {
          tags: ["发货预览与确认"], summary: "深度预检（绝不提交）", security: [{ bearerAuth: [] }],
          description: "执行与真实提交相同的底层安全检查，但不接受确认标记，也不会调用马帮交运提交接口。",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["orderId"], properties: { shopId: { type: "string" }, orderId: { type: "string" } } }, example: { shopId: "2021485965", orderId: "260727RCNK1BWT" } } } },
          responses: { 200: { description: "全部底层检查通过，wouldSubmit 固定为 false" }, 400: { description: "订单号无效" }, 409: { description: "安全检查未通过" } },
        },
      },
      "/api/fulfillment/previews/{previewId}": {
        get: {
          tags: ["发货预览与确认"], summary: "查询发货预览", security: [{ bearerAuth: [] }],
          parameters: [{ name: "previewId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { 200: { description: "预览详情" }, 404: { description: "预览不存在" } },
        },
      },
      "/api/fulfillment/previews/{previewId}/confirm": {
        post: {
          tags: ["发货预览与确认"], summary: "人工确认并执行完整自动发货", security: [{ bearerAuth: [] }],
          description: "接口立即返回 queued 批次，不等待全部订单完成。后台先对整批执行一次详细库存复检，再逐单执行交运、获取运单号、渠道核对、转入配货中和结果回查。通过批次查询接口获取进度与最终结果。",
          parameters: [{ name: "previewId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["confirmationToken"], properties: { confirmationToken: { type: "string" } } } } } },
          responses: { 202: { description: "已创建后台发货批次并立即返回", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessBatch" } } } }, 403: { description: "确认令牌无效" }, 409: { description: "预览失效、重复使用或真实提交关闭" } },
        },
      },
      "/api/fulfillment/previews/{previewId}/confirmation-token": {
        post: { tags: ["定时预览"], summary: "载入定时生成的预览供人工确认", security: [{ bearerAuth: [] }],
          parameters: [{ name: "previewId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          description: "为尚未过期且未使用的预览签发新的人工确认令牌，不会提交发货。",
          responses: { 200: { description: "返回预览和新的确认令牌" }, 409: { description: "预览已过期或已使用" } } },
      },
      "/api/fulfillment/batches/{batchId}": {
        get: {
          tags: ["批次"], summary: "查询发货批次及逐单回查结果", security: [{ bearerAuth: [] }],
          parameters: [{ name: "batchId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          description: "逐单查看脱敏运单号、提交前状态、最终状态和错误信息。success 订单的 afterStatus 应为配货中。",
          responses: { 200: { description: "批次详情", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessBatch" } } } }, 404: { description: "批次不存在" } },
        },
      },
    },
  };
}

function htmlText(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
})[character]); }

export function createApiDocsHtml(config = { shops: [] }) {
  const shops = Array.isArray(config.shops) ? config.shops : [];
  const shopOptions = shops.map((shop) => `<option value="${htmlText(shop.shopId)}"${shop.shopId === config.shopId ? " selected" : ""}>${htmlText(shop.shopName)} · ${htmlText(shop.countryCode)}</option>`).join("");
  const countries = [...new Set(shops.map((shop) => shop.countryCode))];
  const autoShopNames = shops.filter((shop) => shop.autoFulfillEnabled).map((shop) => shop.shopName);
  const manualShopNames = shops.filter((shop) => !shop.autoFulfillEnabled).map((shop) => shop.shopName);
  const shopNotice = `${autoShopNames.length ? `${htmlText(autoShopNames.join("、"))} 检查通过后自动执行` : "当前没有店铺开启自动执行"}；${manualShopNames.length ? `${htmlText(manualShopNames.join("、"))} 只扫描或等待人工确认。` : "全部店铺均已开启自动执行。"}`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>马帮自动发货 API 测试台</title>
<style>:root{color-scheme:light;--bg:#f8fafc;--card:#fff;--ink:#1e293b;--muted:#64748b;--line:#d7e0ea;--blue:#2563eb;--blue2:#1d4ed8;--ok:#087a55;--warn:#9a5800;--danger:#b42318;--soft-blue:#eff6ff;--soft-green:#ecfdf5;--soft-warn:#fff7ed;--soft-red:#fff1f2}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 56px}h1{margin:0 0 6px;font-size:30px;line-height:1.2}h2{font-size:18px;margin:0}h3{font-size:15px;margin:0}.lead{color:var(--muted);margin:0 0 22px}.hint{color:var(--muted);margin:0 0 10px}.notice{padding:12px 15px;border:1px solid #f0ca86;background:#fff8e8;border-radius:10px;color:#704400;margin-bottom:18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;box-shadow:0 2px 8px #1822300a}.head{display:flex;align-items:center;gap:10px;margin-bottom:14px}.method{font-size:12px;font-weight:700;color:#fff;background:var(--blue);border-radius:5px;padding:3px 7px}.method.get{background:var(--ok)}label{display:block;color:var(--muted);margin:10px 0 5px}input,textarea{width:100%;min-height:44px;padding:9px 10px;border:1px solid #b8c3d1;border-radius:7px;font:inherit;background:#fff}textarea{resize:vertical}input:focus,textarea:focus,button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}button{min-height:44px;margin-top:12px;border:0;border-radius:7px;background:var(--blue);color:#fff;padding:10px 15px;font:inherit;font-weight:650;cursor:pointer;transition:background-color .18s ease,box-shadow .18s ease}button:hover{background:var(--blue2)}button:disabled{cursor:not-allowed;opacity:.55}button.secondary{background:#334155}.toolbar{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}.result{margin-top:16px}.status{font-weight:700;margin-bottom:6px}.status.ok{color:var(--ok)}.status.bad{color:var(--danger)}pre{margin:0;min-height:160px;max-height:480px;overflow:auto;background:#0f172a;color:#dbeafe;padding:16px;border-radius:8px;font:12px/1.55 Consolas,monospace;white-space:pre-wrap;word-break:break-word}.links{margin-top:18px;color:var(--muted)}a{color:var(--blue)}.workbench{margin-bottom:18px}.workbench-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.workbench-actions{display:flex;flex-wrap:wrap;gap:8px}.workbench-actions button{margin-top:0}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.metric{border:1px solid var(--line);border-radius:10px;padding:12px;background:#f8fafc}.metric-label{display:block;color:var(--muted);font-size:13px}.metric-value{display:block;margin-top:3px;font-size:18px;font-weight:750;font-variant-numeric:tabular-nums}.alert{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0;font-weight:650}.alert.neutral{background:var(--soft-blue);color:#1e40af;border-color:#bfdbfe}.alert.success{background:var(--soft-green);color:#066343;border-color:#a7f3d0}.alert.warning{background:var(--soft-warn);color:#854d0e;border-color:#fed7aa}.alert.danger{background:var(--soft-red);color:#9f1239;border-color:#fecdd3}.workbench-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:12px}.panel{border:1px solid var(--line);border-radius:10px;overflow:hidden}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#f8fafc;border-bottom:1px solid var(--line)}.table-wrap{overflow:auto}.data-table{width:100%;border-collapse:collapse;font-size:13px}.data-table th,.data-table td{padding:10px 12px;text-align:left;border-bottom:1px solid #e8edf3;vertical-align:middle}.data-table th{color:#475569;background:#fbfdff;font-weight:700}.data-table tr:last-child td{border-bottom:0}.data-table button{min-height:36px;margin:0;padding:6px 10px;font-size:13px}.empty{padding:24px 16px;text-align:center;color:var(--muted)}.countdown{font-variant-numeric:tabular-nums;font-weight:700}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700;background:#e2e8f0;color:#334155}.badge.good{background:#dcfce7;color:#166534}.badge.warn{background:#ffedd5;color:#9a3412}.badge.bad{background:#ffe4e6;color:#9f1239}@media(max-width:900px){.metrics{grid-template-columns:1fr 1fr}.workbench-grid{grid-template-columns:1fr}}@media(max-width:760px){body{font-size:16px}.wrap{padding:20px 12px 40px}.grid,.toolbar,.metrics{grid-template-columns:1fr}.workbench-top{display:block}.workbench-actions{margin-top:12px}.workbench-actions button{width:100%}.data-table{min-width:580px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}</style></head>
<body><main class="wrap"><h1>马帮自动发货 API 测试台</h1><p class="lead">本地交互文档 · ${shops.length} 个店铺 · ${countries.length} 个国家/地区 · 每店铺每批最多 10 单</p>
<div class="notice">${shopNotice} 自动执行流程：获取运单号 → 核对固定渠道 → 转入配货中。缺货、库存未知、仓库不在允许范围内的订单不会提交；同一时间只允许一个批次运行。</div>
<section class="card" style="margin-bottom:16px"><div class="toolbar"><div><label for="apiToken">API Token（未配置可留空）</label><input id="apiToken" type="password" autocomplete="off" placeholder="Bearer token"></div><div><label for="shopId">操作店铺</label><select id="shopId">${shopOptions}</select></div></div><button class="secondary" onclick="callApi('GET','/health')">检查服务状态</button> <button class="secondary" onclick="callApi('POST','/api/fulfillment/notifications/test',{})">测试 Windows 通知</button></section>
<section class="card workbench" aria-labelledby="workbenchTitle"><div class="workbench-top"><div><div class="head"><span class="method get">安全</span><h2 id="workbenchTitle">自动发货工作台</h2></div><p class="hint">优先选择最新有货订单；缺货和库存未知订单继续复查但绝不提交。自动店铺检查通过后会创建真实发货批次。</p></div><div class="workbench-actions"><button class="secondary" onclick="refreshWorkbench(false)">刷新状态</button><button id="scanNowButton" onclick="scanNow()">立即扫描并发货</button></div></div><div id="workbenchAlert" class="alert neutral" role="status" aria-live="polite">正在读取定时任务状态…</div><div class="metrics"><div class="metric"><span class="metric-label">运行模式</span><strong id="metricScheduler" class="metric-value">读取中</strong></div><div class="metric"><span class="metric-label">待确认预览</span><strong id="metricPending" class="metric-value">—</strong></div><div class="metric"><span class="metric-label">最近发现</span><strong id="metricOrders" class="metric-value">—</strong></div><div class="metric"><span class="metric-label">下次扫描</span><strong id="metricNextRun" class="metric-value">—</strong></div></div><div class="workbench-grid"><section class="panel" aria-labelledby="pendingTitle"><div class="panel-head"><h3 id="pendingTitle">待确认预览</h3><span id="pendingBadge" class="badge">0 个</span></div><div id="pendingPreviewList" class="empty">目前没有待确认预览</div></section><section class="panel" aria-labelledby="historyTitle"><div class="panel-head"><h3 id="historyTitle">最近扫描记录</h3><span class="badge">最多 10 条</span></div><div id="scanHistoryList" class="empty">尚无扫描记录</div></section></div></section>
<div class="grid"><section class="card"><div class="head"><span class="method">POST</span><h2>0. 深度预检（绝不提交）</h2></div><label for="preflightOrderId">指定一个订单号</label><input id="preflightOrderId" placeholder="马帮订单编号或 Shopee 交易编号"><button onclick="runPreflight()">运行深度预检</button></section>
<section class="card"><div class="head"><span class="method">POST</span><h2>1. 生成发货预览</h2></div><p class="hint">填写指定订单号会定向批量读取，不再扫描全部待处理订单。</p><label for="orderIds">指定订单号（推荐，每行一个，最多10个）</label><textarea id="orderIds" rows="3" placeholder="支持马帮订单编号或 Shopee 交易编号"></textarea><label for="limit">未指定订单号时读取数量（1–10）</label><input id="limit" type="number" min="1" max="10" value="1"><button onclick="createPreview()">生成预览</button></section>
<section class="card"><div class="head"><span class="method get">GET</span><h2>2. 查询预览</h2></div><label for="previewId">Preview ID</label><input id="previewId" placeholder="生成预览后自动填入"><button onclick="getPreview()">查询预览</button></section>
<section class="card"><div class="head"><span class="method">POST</span><h2>3. 人工确认完整发货</h2></div><p class="hint">点击后立即返回批次号，后台逐单安全执行；页面会自动刷新进度。</p><label for="confirmationToken">Confirmation Token</label><input id="confirmationToken" type="password" placeholder="生成预览后自动填入"><button onclick="confirmPreview()">人工确认完整发货</button></section>
<section class="card"><div class="head"><span class="method get">GET</span><h2>4. 查询发货批次与耗时</h2></div><p class="hint">逐单核对 trackingNumberMasked、afterStatus 和 timings；成功订单应显示“配货中”。耗时单位均为毫秒。</p><label for="batchId">Batch ID</label><input id="batchId" placeholder="真实执行后返回"><button onclick="getBatch()">查询批次</button></section></div>
<section class="card result"><div id="status" class="status">等待测试</div><pre id="output">点击上方按钮后，完整请求结果会显示在这里。</pre></section><p class="links"><a href="/openapi.json" target="_blank">查看 OpenAPI 3.0 JSON</a> · 所有请求只发送到当前本机服务。</p>
</main><script>
const byId=(id)=>document.getElementById(id);
const outcomeNames={auto_fulfillment_started:'自动发货已启动',preview_created:'已生成预览',no_eligible_orders:'无可发货订单',skipped_active_batch:'运行中已跳过',skipped_pending_preview:'已有预览已跳过',partial_scan_failed:'部分店铺失败',scan_failed:'扫描失败',not_run:'尚未扫描'};
let workbenchData=null;
function localTime(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleString('zh-CN',{hour12:false});}
function remainingText(value){const seconds=Math.max(0,Math.floor((new Date(value).getTime()-Date.now())/1000));if(!Number.isFinite(seconds))return '—';if(seconds<=0)return '已过期';const minutes=Math.floor(seconds/60),rest=seconds%60;return minutes+'分'+String(rest).padStart(2,'0')+'秒';}
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function renderPendingPreviews(items){const root=byId('pendingPreviewList');root.replaceChildren();byId('pendingBadge').textContent=items.length+' 个';byId('pendingBadge').className='badge '+(items.length?'warn':'good');if(!items.length){root.className='empty';root.textContent='目前没有待确认预览';return;}root.className='table-wrap';const table=element('table',undefined,'data-table');const head=element('thead'),headRow=element('tr');['店铺','预览','可发货','排除','剩余时间','操作'].forEach(label=>headRow.append(element('th',label)));head.append(headRow);table.append(head);const body=element('tbody');items.forEach(item=>{const row=element('tr');row.append(element('td',item.shop&&item.shop.name||'—'));row.append(element('td',item.previewId.slice(0,8)));row.append(element('td',String(item.eligibleOrderCount)));row.append(element('td',String(item.excludedOrderCount)));const timeCell=element('td');const countdown=element('span',remainingText(item.expiresAt),'countdown');countdown.dataset.expires=item.expiresAt;timeCell.append(countdown);row.append(timeCell);const actionCell=element('td');const button=element('button','载入预览');button.type='button';button.addEventListener('click',()=>loadPreviewById(item.previewId));actionCell.append(button);row.append(actionCell);body.append(row);});table.append(body);root.append(table);}
function renderScanHistory(items){const root=byId('scanHistoryList');root.replaceChildren();if(!items.length){root.className='empty';root.textContent='尚无扫描记录';return;}root.className='table-wrap';const table=element('table',undefined,'data-table');const head=element('thead'),headRow=element('tr');['时间','结果','可发货','排除'].forEach(label=>headRow.append(element('th',label)));head.append(headRow);table.append(head);const body=element('tbody');items.forEach(item=>{const row=element('tr');row.append(element('td',localTime(item.finishedAt)));const resultCell=element('td');const positive=['preview_created','auto_fulfillment_started'].includes(item.outcome);const badge=element('span',outcomeNames[item.outcome]||item.outcome,'badge '+(positive?'good':item.outcome==='scan_failed'?'bad':'warn'));resultCell.append(badge);row.append(resultCell);row.append(element('td',String(item.eligibleOrderCount)));row.append(element('td',String(item.excludedOrderCount)));body.append(row);});table.append(body);root.append(table);}
function updateCountdowns(){document.querySelectorAll('.countdown[data-expires]').forEach(node=>{node.textContent=remainingText(node.dataset.expires);});if(workbenchData&&workbenchData.nextRunAt)byId('metricNextRun').textContent=remainingText(workbenchData.nextRunAt);}
function renderWorkbench(data){workbenchData=data;const pending=data.pendingPreviews||[];const recent=data.recentScans||[];byId('metricScheduler').textContent=data.enabled?(data.autoFulfillEnabled?'自动发货 · 每 ':'仅扫描 · 每 ')+Math.round(data.intervalSeconds/60)+' 分钟':'未开启';byId('metricPending').textContent=String(pending.length);const latest=recent[0];byId('metricOrders').textContent=latest?(latest.eligibleOrderCount+' 可发 / '+latest.excludedOrderCount+' 排除'):'尚无记录';byId('metricNextRun').textContent=data.enabled?remainingText(data.nextRunAt):'—';const alert=byId('workbenchAlert');if(data.activeBatch){alert.className='alert warning';alert.textContent='发货批次 '+data.activeBatch.id.slice(0,8)+' 正在运行，其他店铺会等待下一轮。';}else if(data.lastOutcome==='scan_failed'){alert.className='alert danger';alert.textContent='最近扫描失败：'+data.lastMessage+' 请检查马帮登录状态后重试。';}else if(data.autoFulfillEnabled){alert.className='alert success';alert.textContent=data.lastMessage||'自动发货已开启，系统会继续定时扫描。';}else if(pending.length){const nearest=[...pending].sort((a,b)=>new Date(a.expiresAt)-new Date(b.expiresAt))[0];const urgent=new Date(nearest.expiresAt).getTime()-Date.now()<120000;alert.className='alert '+(urgent?'danger':'warning');alert.textContent='有 '+pending.length+' 个预览等待人工确认，最近一个将在 '+remainingText(nearest.expiresAt)+' 后过期。';}else{alert.className='alert success';alert.textContent=data.lastMessage||'当前没有待确认事项，系统会继续定时扫描。';}renderPendingPreviews(pending);renderScanHistory(recent);updateCountdowns();}
async function callApi(method,path,payload,quiet=false){const headers={};const token=byId('apiToken').value.trim();if(token)headers.Authorization='Bearer '+token;if(payload!==undefined)headers['Content-Type']='application/json';if(!quiet){byId('status').className='status';byId('status').textContent=method+' '+path+' 请求中…';}try{const response=await fetch(path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)});const data=await response.json();if(!quiet){byId('status').className='status '+(response.ok?'ok':'bad');byId('status').textContent=response.status+' '+response.statusText+(response.ok?' · 请求成功':' · 请求未成功');byId('output').textContent=JSON.stringify(data,null,2);}if(data&&data.data){const preview=data.data.createdPreview||data.data;if(preview.previewId)byId('previewId').value=preview.previewId;if(preview.confirmationToken)byId('confirmationToken').value=preview.confirmationToken;if(data.data.pendingPreview&&data.data.pendingPreview.previewId)byId('previewId').value=data.data.pendingPreview.previewId;if(data.data.batchId)byId('batchId').value=data.data.batchId;if(data.data.autoBatch&&data.data.autoBatch.id)byId('batchId').value=data.data.autoBatch.id;if(data.data.id&&path.endsWith('/confirm'))byId('batchId').value=data.data.id;if(path.includes('/scheduler'))renderWorkbench(data.data);}return data;}catch(error){if(!quiet){byId('status').className='status bad';byId('status').textContent='请求失败';byId('output').textContent=String(error);}const alert=byId('workbenchAlert');if(path.includes('/scheduler')&&alert){alert.className='alert danger';alert.textContent='无法读取定时任务状态，请检查服务是否正在运行。';}return null;}}
async function refreshWorkbench(showResult=false){return callApi('GET','/api/fulfillment/scheduler',undefined,!showResult);}async function schedulerStatus(){return refreshWorkbench(false);}async function scanNow(){if(workbenchData&&workbenchData.autoFulfillEnabled&&!window.confirm('立即扫描可能会对有货订单执行真实发货并转入配货中，是否继续？'))return;const button=byId('scanNowButton');button.disabled=true;const original=button.textContent;button.textContent='扫描中…';try{return await callApi('POST','/api/fulfillment/scheduler/scan',{});}finally{button.disabled=false;button.textContent=original;await refreshWorkbench(false);}}async function loadPreviewById(id){byId('previewId').value=id;const data=await callApi('POST','/api/fulfillment/previews/'+encodeURIComponent(id)+'/confirmation-token',{});if(data&&data.success&&data.data&&data.data.shop)byId('shopId').value=data.data.shop.id;if(data&&data.success){byId('previewId').focus();byId('previewId').scrollIntoView({behavior:'smooth',block:'center'});}return data;}async function loadScheduledPreview(){const items=workbenchData&&workbenchData.pendingPreviews||[];if(!items.length)return showRequired('有效的待确认预览，请先执行安全扫描');return loadPreviewById(items[0].previewId);}function runPreflight(){const orderId=byId('preflightOrderId').value.trim();if(!orderId)return showRequired('订单号');callApi('POST','/api/fulfillment/preflights',{shopId:byId('shopId').value,orderId});}function createPreview(){const orderIds=byId('orderIds').value.replaceAll('，',',').replaceAll(String.fromCharCode(10),',').split(',').map(v=>v.trim()).filter(Boolean);const shopId=byId('shopId').value;const payload=orderIds.length?{shopId,orderIds}:{shopId,limit:Number(byId('limit').value)};callApi('POST','/api/fulfillment/previews',payload);}function getPreview(){const id=byId('previewId').value.trim();if(!id)return showRequired('Preview ID');callApi('GET','/api/fulfillment/previews/'+encodeURIComponent(id));}async function confirmPreview(){const id=byId('previewId').value.trim(),token=byId('confirmationToken').value.trim();if(!id||!token)return showRequired('Preview ID 和 Confirmation Token');const data=await callApi('POST','/api/fulfillment/previews/'+encodeURIComponent(id)+'/confirm',{confirmationToken:token});if(data&&data.success&&data.data&&data.data.id)pollBatch(data.data.id);}async function pollBatch(id){for(let count=0;count<200;count++){await new Promise(resolve=>setTimeout(resolve,3000));const data=await callApi('GET','/api/fulfillment/batches/'+encodeURIComponent(id));const status=data&&data.data&&data.data.status;if(status&&status!=='queued'&&status!=='running'){await refreshWorkbench(false);return;}}}function getBatch(){const id=byId('batchId').value.trim();if(!id)return showRequired('Batch ID');callApi('GET','/api/fulfillment/batches/'+encodeURIComponent(id));}function showRequired(name){byId('status').className='status bad';byId('status').textContent='请先填写 '+name;}
refreshWorkbench(false);setInterval(()=>refreshWorkbench(false),30000);setInterval(updateCountdowns,1000);
</script></body></html>`;
}
