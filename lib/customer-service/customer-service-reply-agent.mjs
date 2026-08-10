import { createJsonObjectOutputValidator } from "../ai/ai-output-validation.mjs";
import { assertAgentRuntimeScope } from "../ai/agent/agent-runtime.mjs";

export const CUSTOMER_SERVICE_REPLY_AGENT_NAME = "customer-service.reply-suggestion";
export const CUSTOMER_SERVICE_REPLY_AGENT_VERSION = "1.0.0";
export const CUSTOMER_SERVICE_REPLY_PROMPT_VERSION = "CS-REPLY-1.2.0";
export const CUSTOMER_SERVICE_REPLY_OUTPUT_SCHEMA_ID = "customer-service.reply-suggestion";

const RISK_LEVELS = new Set(["LOW", "MEDIUM", "HIGH"]);
const MAX_PROMPT_CONTEXT_BYTES = 140_000;

export const CUSTOMER_SERVICE_REPLY_AGENT_DEFINITION = Object.freeze({
  name: CUSTOMER_SERVICE_REPLY_AGENT_NAME,
  version: CUSTOMER_SERVICE_REPLY_AGENT_VERSION,
  description: "Generates one evidence-grounded customer-service draft for human confirmation.",
  input_context: [{ type: "customer_service", version: "1.0.0", required: true, multiple: false }],
  tools: [
    {
      name: "context.resolve",
      version: "1.0.0",
      access: "read",
      permission: "context.resolve",
      description: "Resolve the immutable Context snapshot for the current inbound message.",
    },
    {
      name: "ai.gateway.complete",
      version: "1.0.0",
      access: "read",
      permission: "ai.gateway.complete",
      description: "Generate a validated reply through the unified AI Gateway.",
    },
  ],
  output_schema: {
    id: CUSTOMER_SERVICE_REPLY_OUTPUT_SCHEMA_ID,
    version: CUSTOMER_SERVICE_REPLY_AGENT_VERSION,
    schema: {
      type: "object",
      required: [
        "draftReply",
        "customerLanguage",
        "intent",
        "riskLevel",
        "confidence",
        "qualityFlags",
        "usedEvidenceIds",
        "requiresHumanConfirmation",
      ],
      properties: {
        draftReply: { type: "string" },
        customerLanguage: { type: "string" },
        intent: { type: "string" },
        riskLevel: { enum: ["LOW", "MEDIUM", "HIGH"] },
        confidence: { type: "number" },
        qualityFlags: { type: "array" },
        usedEvidenceIds: { type: "array" },
        requiresHumanConfirmation: { const: true },
      },
    },
  },
  permission: {
    mode: "recommend",
    task_domain: "customer_service",
    scopes: ["ai.gateway.complete", "context.resolve"],
    requires_human_approval: true,
  },
});

function text(value, fallback = "", maximum = 2_000) {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, maximum);
}

function list(value, maximum = 20) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function normalizedOutput(value) {
  const risk = text(value?.riskLevel, "MEDIUM", 20).toUpperCase();
  const confidence = Number(value?.confidence);
  return {
    draftReply: text(value?.draftReply, "", 4_000),
    customerLanguage: text(value?.customerLanguage, "und", 40).toLowerCase(),
    intent: text(value?.intent, "unknown", 120),
    riskLevel: RISK_LEVELS.has(risk) ? risk : "MEDIUM",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    qualityFlags: [...new Set(list(value?.qualityFlags, 20).map((item) => text(item, "", 80).toUpperCase()).filter(Boolean))],
    usedEvidenceIds: [...new Set(list(value?.usedEvidenceIds, 30).map((item) => text(item, "", 160)).filter(Boolean))],
    requiresHumanConfirmation: true,
  };
}

export const CUSTOMER_SERVICE_REPLY_OUTPUT_VALIDATOR = createJsonObjectOutputValidator({
  schemaId: `${CUSTOMER_SERVICE_REPLY_OUTPUT_SCHEMA_ID}@${CUSTOMER_SERVICE_REPLY_AGENT_VERSION}`,
  validate(value) {
    const output = normalizedOutput(value);
    if (!output.draftReply || !RISK_LEVELS.has(output.riskLevel)) return false;
    if (!Array.isArray(value.qualityFlags) || !Array.isArray(value.usedEvidenceIds)) return false;
    if (value.requiresHumanConfirmation !== true) return false;
    return output;
  },
});

function boundedValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 3_000);
  if (depth >= 7) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => boundedValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => [key, boundedValue(child, depth + 1)]));
  }
  return String(value).slice(0, 500);
}

function promptContext(context) {
  const facts = boundedValue(context.data.facts);
  const serialized = JSON.stringify(facts);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PROMPT_CONTEXT_BYTES) return serialized;
  const compact = {
    contractVersion: facts.contractVersion,
    trigger: facts.trigger,
    shop: facts.shop,
    messages: list(facts.messages, 12),
    observedPanel: facts.observedPanel ? {
      source: facts.observedPanel.source,
      authoritative: facts.observedPanel.authoritative,
      data: boundedValue(facts.observedPanel.data, 3),
    } : null,
    product: facts.product,
    productPackage: facts.productPackage ? {
      source: facts.productPackage.source,
      id: facts.productPackage.id,
      version: facts.productPackage.version,
    } : null,
    order: facts.order,
    logistics: facts.logistics,
    inventory: facts.inventory,
    knowledge: facts.knowledge,
    unavailable: facts.unavailable,
  };
  return JSON.stringify(boundedValue(compact));
}

function promptFor(context) {
  return [
    "你是 Commerce Ops 跨境电商客服回复 Agent。你的输出只是一份写入乐聊输入框、等待人工确认的草稿，绝不能发送消息。",
    "必须只使用下面 Context 中的事实。禁止猜测订单状态、物流节点、到货日期、库存、产品参数、退款金额、赔偿方案、店铺政策或承诺时效。",
    "MABANG_ORDER、MABANG_INVENTORY、PRODUCT_CORE、PLATFORM_GATEWAY_ORDER_ITEMS 和 PUBLISHED_SUPPORT_VIEW_ONLY 是结构化依据。PLATFORM_GATEWAY_ORDER_ITEMS 只有在 logistics.authoritative=true 且 resolutionStatus=RESOLVED 时才是权威物流；LIAOLIAO_PLAYWRIGHT_OBSERVATION_ONLY 以及 logistics.observed 仅是网页观察，不得描述为已被后台系统确认。",
    "如果权威物流返回 trackingAssigned=false，只能说明平台暂未分配可用运单号，不能据此声称已经发货、正在运输或给出预计送达时间。",
    "knowledge.claims 和 accessories 是已发布产品依据；policies 是处理边界，playbooks 只是已审核表达参考。不得把 policy/playbook 中的内部操作、审批人、金额或补偿内容直接对客户承诺；需要政策校验的内容必须标为 HIGH 并升级人工。",
    "如果完成回复所需的事实位于 unavailable，改为简短说明正在核实，或向客户询问一个必要信息；不要补造答案。",
    "优先使用客户最近一条入站消息的语言，语气自然、简洁、有同理心。不要向客户暴露内部系统名、证据编号、AI、Context、知识库或风险标签。",
    "涉及退款、赔偿、取消、改地址、支付争议、法律/安全、平台处罚或无法由证据支持的承诺时，riskLevel 必须为 HIGH，并使用升级人工处理的话术。",
    "draftReply 只放可直接发给客户的正文，不要包含分析过程、标题、引号或 Markdown。requiresHumanConfirmation 必须为 true。",
    "qualityFlags 应指出缺失事实、仅观察物流、澄清问题或高风险升级。usedEvidenceIds 只能填写 Context 中真实出现的 claim/order/product/source ID；没有就返回空数组。",
    "只返回严格 JSON，结构如下：",
    JSON.stringify({
      draftReply: "给客户的完整回复正文",
      customerLanguage: "语言代码，例如 en、th、vi、id、ms、tl、zh",
      intent: "客户意图",
      riskLevel: "LOW|MEDIUM|HIGH",
      confidence: 0.0,
      qualityFlags: ["CLARIFYING_QUESTION"],
      usedEvidenceIds: [],
      requiresHumanConfirmation: true,
    }),
    `Customer-service Context: ${promptContext(context)}`,
  ].join("\n");
}

export class CustomerServiceReplyAgent {
  constructor({ runtime, configured = false, model = "deepseek-v4-flash" } = {}) {
    this.runtime = assertAgentRuntimeScope(runtime);
    this.configured = Boolean(configured);
    this.model = text(model, "deepseek-v4-flash", 120);
    this.definition = this.runtime.definition;
  }

  status() {
    return {
      configured: this.configured,
      name: this.definition.name,
      version: this.definition.version,
      model: this.model,
      promptVersion: CUSTOMER_SERVICE_REPLY_PROMPT_VERSION,
    };
  }

  async run({ snapshotId, suggestionId, requestId, requestedBy = "customer-service-reply-runner" } = {}) {
    if (!this.configured) {
      throw Object.assign(new Error("Customer-service Reply Agent is not configured."), { code: "AI_NOT_CONFIGURED" });
    }
    const contextInvocation = await this.runtime.resolveContext({
      request_id: requestId,
      requested_by: requestedBy,
      context_name: "customer_service",
      context_version: "1.0.0",
      input: { snapshot_id: snapshotId },
    });
    const context = contextInvocation.result;
    const gatewayInvocation = await this.runtime.executeTool({
      request_id: requestId,
      requested_by: requestedBy,
      tool_name: "ai.gateway.complete",
      input: {
        task_id: suggestionId,
        module_id: "customer_service",
        operation: "generate_reply_suggestion_v1",
        request_id: requestId,
        prompt_id: "customer-service.reply-suggestion",
        prompt_version: CUSTOMER_SERVICE_REPLY_PROMPT_VERSION,
        model: this.model,
        temperature: 0.15,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        output_schema_id: CUSTOMER_SERVICE_REPLY_OUTPUT_VALIDATOR.schemaId,
        messages: [
          { role: "system", content: "你是严格依据业务证据生成客服草稿的 Agent，只输出 JSON，永不执行发送。" },
          { role: "user", content: promptFor(context) },
        ],
      },
    });
    const result = gatewayInvocation.result;
    if (!result?.success) {
      throw Object.assign(new Error(result?.errorMessage || "Customer-service model request failed."), {
        code: result?.errorCode || "AI_PROVIDER_ERROR",
        requestId: result?.requestId || requestId,
      });
    }
    return {
      resultStatus: "succeeded",
      output: normalizedOutput(result.validatedOutput),
      provider: result.provider,
      model: result.model || this.model,
      usage: result.usage || null,
      promptVersion: CUSTOMER_SERVICE_REPLY_PROMPT_VERSION,
      contextSnapshotId: snapshotId,
      contextDigest: context.data.contextDigest,
    };
  }
}
