import { MODULE_IDS } from "../contracts/module-ids.mjs";
import { aiGatewayError } from "../ai/ai-gateway.mjs";
import {
  PRODUCT_AI_LANGUAGES,
  PRODUCT_AI_PLATFORMS,
  PRODUCT_AI_PROMPT_VERSION,
  buildProductAiContext,
  buildProductAiMessages,
} from "./product-ai-prompt.mjs";
import { parseProductAiResponse, validateProductAiContent } from "./product-ai-response.mjs";

function text(value, maxLength = 2000) {
  return String(value || "").trim().slice(0, maxLength);
}

function count(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 10)) : fallback;
}

function normalizeOptions(input = {}, product) {
  const targetPlatform = PRODUCT_AI_PLATFORMS.includes(input.targetPlatform) ? input.targetPlatform : "通用电商";
  const outputLanguage = PRODUCT_AI_LANGUAGES.includes(input.outputLanguage) ? input.outputLanguage : "中文";
  return Object.freeze({
    targetPlatform,
    targetCountry: text(input.targetCountry || product.country, 100),
    outputLanguage,
    targetUsers: text(input.targetUsers),
    productPositioning: text(input.productPositioning),
    contentStyle: text(input.contentStyle),
    sellingPointCount: count(input.sellingPointCount, 5),
    scenarioCount: count(input.scenarioCount, 5),
    specialRequirements: text(input.specialRequirements, 4000),
    forbiddenContent: text(input.forbiddenContent, 4000),
  });
}

export class ProductAiContentService {
  constructor({ repository, gateway, configured = false, model = "deepseek-v4", promptVersion = PRODUCT_AI_PROMPT_VERSION }) {
    this.repository = repository;
    this.gateway = gateway;
    this.configured = Boolean(configured);
    this.model = String(model || "deepseek-v4");
    this.promptVersion = promptVersion;
    this.activeProducts = new Set();
  }

  status() {
    return { configured: this.configured, provider: "deepseek", model: this.model, promptVersion: this.promptVersion };
  }

  async generate(product, input = {}, audit = {}) {
    if (!this.configured) throw Object.assign(new Error("尚未配置 DeepSeek API Key，请联系管理员完成配置。"), { code: "AI_NOT_CONFIGURED", status: 409 });
    if (this.activeProducts.has(product.id)) throw Object.assign(new Error("该产品已有 AI 生成任务正在执行。"), { code: "PRODUCT_AI_GENERATION_IN_PROGRESS", status: 409 });
    this.activeProducts.add(product.id);
    try {
      const inputContext = buildProductAiContext(product);
      const options = normalizeOptions(input, product);
      const result = await this.gateway.complete({
        moduleId: MODULE_IDS.PRODUCT_CENTER,
        operation: "generate_selling_points_and_scenarios",
        requestId: audit.requestId,
        model: this.model,
        messages: buildProductAiMessages({ context: inputContext, options }),
        responseFormat: { type: "json_object" },
        temperature: 0.2,
        signal: audit.signal,
      });
      if (!result.success) throw aiGatewayError(result);
      return {
        outputContent: parseProductAiResponse(result.content),
        inputContext: { product: inputContext, requirements: options },
        provider: result.provider,
        model: result.model,
        promptVersion: this.promptVersion,
        requestId: result.requestId,
        durationMs: result.durationMs,
      };
    } finally {
      this.activeProducts.delete(product.id);
    }
  }

  async save(product, input = {}, audit = {}) {
    const status = input.status === "confirmed" ? "confirmed" : "draft";
    return this.repository.create({
      productId: product.id,
      country: product.country,
      sku: product.sku,
      provider: "deepseek",
      model: text(input.model || this.model, 120),
      contentType: "selling_points_and_scenarios",
      inputContext: input.inputContext && typeof input.inputContext === "object" ? input.inputContext : {},
      outputContent: validateProductAiContent(input.outputContent),
      promptVersion: text(input.promptVersion || this.promptVersion, 120),
      status,
      createdBy: audit.operatorLabel || "local_session",
      requestId: audit.requestId || null,
    });
  }

  confirm(product, contentId, audit = {}) {
    return this.repository.confirm(product.id, contentId, audit);
  }

  history(productId, options) {
    return this.repository.list(productId, options);
  }

  latestConfirmed(productId) {
    return this.repository.latestConfirmed(productId);
  }
}
