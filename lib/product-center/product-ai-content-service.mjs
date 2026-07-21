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
import {
  buildListingAiContext,
  normalizeListingContentTypes,
} from "./listing-ai-context.mjs";
import { buildListingAiMessages, LISTING_AI_PROMPT_VERSION } from "./listing-ai-prompt.mjs";
import { contentResultForRecord, parseListingAiResponse } from "./listing-ai-response.mjs";

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
  constructor({ repository, gateway, configured = false, model = "deepseek-v4", promptVersion = PRODUCT_AI_PROMPT_VERSION, titleLimits = {} }) {
    this.repository = repository;
    this.gateway = gateway;
    this.configured = Boolean(configured);
    this.model = String(model || "deepseek-v4");
    this.promptVersion = promptVersion;
    this.titleLimits = titleLimits;
    this.activeProducts = new Set();
  }

  status() {
    return {
      configured: this.configured,
      provider: "deepseek",
      model: this.model,
      promptVersion: this.promptVersion,
      listingPromptVersion: LISTING_AI_PROMPT_VERSION,
      titleLimits: this.titleLimits,
    };
  }

  async generateListingContent(product, input = {}, audit = {}) {
    if (!this.configured) throw Object.assign(new Error("尚未配置 DeepSeek API Key，请联系管理员完成配置。"), { code: "AI_NOT_CONFIGURED", status: 409 });
    const contentTypes = normalizeListingContentTypes(input.contentTypes);
    if (contentTypes.includes("product_images")) throw Object.assign(new Error("真实图片只能由图片生成 Provider 处理。"), { code: "PRODUCT_AI_CONTENT_TYPE_INVALID", status: 400 });
    if (this.activeProducts.has(product.id)) throw Object.assign(new Error("该产品已有 AI 生成任务正在执行。"), { code: "PRODUCT_AI_GENERATION_IN_PROGRESS", status: 409 });
    this.activeProducts.add(product.id);
    try {
      const { context, contextHash } = buildListingAiContext(product, input);
      const result = await this.gateway.complete({
        moduleId: MODULE_IDS.PRODUCT_CENTER,
        operation: `generate_listing_${contentTypes.join("_")}`.slice(0, 120),
        requestId: audit.requestId,
        model: this.model,
        messages: buildListingAiMessages({
          context,
          contentTypes,
          titleLimits: input.titleLimits || this.titleLimits,
          generationOptions: {
            selling_point_count: Math.max(1, Math.min(Number(input.sellingPointCount) || 5, 10)),
            scenario_count: Math.max(1, Math.min(Number(input.scenarioCount) || 5, 10)),
          },
          imageTemplate: input.imageTemplate || null,
        }),
        responseFormat: { type: "json_object" },
        temperature: 0.2,
        signal: audit.signal,
      });
      if (!result.success) throw aiGatewayError(result);
      const output = parseListingAiResponse(result.content, contentTypes);
      const records = [];
      for (const contentType of contentTypes) {
        const previous = await this.repository.latestConfirmed(product.id, contentType);
        records.push(await this.repository.create({
          productId: product.id,
          country: context.target.country_name,
          sku: product.sku,
          provider: result.provider,
          model: result.model,
          contentType,
          inputContext: context,
          outputContent: contentResultForRecord(contentType, output),
          promptVersion: LISTING_AI_PROMPT_VERSION,
          status: "draft",
          createdBy: audit.operatorLabel || "local_session",
          requestId: result.requestId || audit.requestId || null,
          listingDraftId: input.listingDraftId || null,
          platform: context.target.platform || null,
          shopName: context.target.shop_name || null,
          contextHash,
          previousContentId: previous?.id || null,
        }));
      }
      return {
        contentTypes,
        outputContent: output,
        inputContext: context,
        contextHash,
        records,
        provider: result.provider,
        model: result.model,
        promptVersion: LISTING_AI_PROMPT_VERSION,
        requestId: result.requestId,
        durationMs: result.durationMs,
      };
    } finally {
      this.activeProducts.delete(product.id);
    }
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

  confirm(product, contentId, adoptedContent = null, audit = {}) {
    return this.repository.confirm(product.id, contentId, { ...audit, adoptedContent });
  }

  restore(product, contentId, adoptedContent, audit = {}) {
    return this.repository.restore(product.id, contentId, { ...audit, adoptedContent });
  }

  markManual(product, contentId, manualContent, audit = {}) {
    return this.repository.markManual(product.id, contentId, manualContent, audit);
  }

  history(productId, options) {
    return this.repository.list(productId, options);
  }

  latestConfirmed(productId) {
    return this.repository.latestConfirmed(productId);
  }

  latestConfirmedByTypes(productId) {
    return this.repository.latestConfirmedByTypes(productId);
  }
}
