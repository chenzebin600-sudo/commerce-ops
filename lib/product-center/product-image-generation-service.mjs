import { IMAGE_AI_UNCONFIGURED_MESSAGE } from "./image-generation-config.mjs";

function imageError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

export class ProductImageGenerationService {
  constructor({ repository, aiContentService, provider, config, listingService = null }) {
    this.repository = repository;
    this.aiContentService = aiContentService;
    this.provider = provider;
    this.config = config;
    this.listingService = listingService;
    this.activeTasks = new Set();
  }

  status() {
    return {
      configured: Boolean(this.config.configured && this.provider?.configured),
      provider: this.config.provider || null,
      model: this.config.model || null,
      message: this.config.configured && this.provider?.configured ? "图片生成模型已配置。" : IMAGE_AI_UNCONFIGURED_MESSAGE,
      template: this.config.template,
    };
  }

  list(productId) { return this.repository.list(productId); }

  async createPlan(product, input = {}, audit = {}) {
    const result = await this.aiContentService.generateListingContent(product, {
      ...input,
      contentTypes: ["image_prompt"],
      imageTemplate: this.config.template,
    }, audit);
    const plan = result.outputContent.image_prompt;
    const byKey = new Map((plan.slots || []).map((slot) => [slot.slot_key, slot]));
    const items = this.config.template.slots.map((slot) => {
      const generated = byKey.get(slot.key);
      if (!generated) throw imageError("IMAGE_PROMPT_SLOT_MISSING", `AI 图片方案缺少槽位：${slot.label}`, 502);
      return {
        slotKey: slot.key,
        slotType: slot.type,
        label: slot.label,
        aspectRatio: generated.aspect_ratio || slot.aspectRatio,
        prompt: generated.prompt,
        negativePrompt: generated.negative_prompt,
        status: "waiting",
      };
    });
    return this.repository.createTask({
      productId: product.id,
      listingDraftId: input.listingDraftId || null,
      templateKey: this.config.template.key,
      provider: this.config.provider || null,
      model: this.config.model || null,
      contextHash: result.contextHash,
      context: result.inputContext,
      promptPlan: plan,
      status: "waiting_generation",
      createdBy: audit.operatorLabel || "local_session",
      items,
    });
  }

  async generate(productId, taskId, { itemIds = null } = {}) {
    if (!this.config.configured || !this.provider?.configured) throw imageError("IMAGE_AI_NOT_CONFIGURED", IMAGE_AI_UNCONFIGURED_MESSAGE);
    const task = await this.repository.getTask(taskId);
    if (!task || task.productId !== productId) throw imageError("IMAGE_GENERATION_TASK_NOT_FOUND", "图片生成任务不存在。", 404);
    if (this.activeTasks.has(taskId)) throw imageError("IMAGE_GENERATION_IN_PROGRESS", "图片生成任务正在执行。");
    const selected = new Set(Array.isArray(itemIds) ? itemIds : task.items.filter((item) => item.status !== "completed").map((item) => item.id));
    this.activeTasks.add(taskId);
    await this.repository.updateTask(taskId, { status: "generating", errorCode: null, errorMessage: null });
    try {
      for (const item of task.items.filter((entry) => selected.has(entry.id))) {
        await this.repository.updateItem(item.id, { status: "generating", errorCode: null, errorMessage: null });
        try {
          const result = await this.provider.generate({ prompt: item.prompt, negativePrompt: item.negativePrompt, aspectRatio: item.aspectRatio });
          if (!result?.fileId) throw imageError("IMAGE_PROVIDER_RESULT_INVALID", "图片模型没有返回可持久化文件。", 502);
          await this.repository.updateItem(item.id, { status: "completed", generatedFileId: result.fileId });
        } catch (error) {
          await this.repository.updateItem(item.id, {
            status: item.status === "completed" && item.generatedFileId ? "completed" : "failed",
            errorCode: error.code || "IMAGE_GENERATION_FAILED",
            errorMessage: String(error.message || "图片生成失败。").slice(0, 500),
          });
        }
      }
      const refreshed = await this.repository.getTask(taskId);
      const completed = refreshed.items.filter((item) => item.status === "completed").length;
      const failed = refreshed.items.filter((item) => item.status === "failed").length;
      const status = completed === refreshed.items.length ? "completed" : completed && failed ? "partially_completed" : failed ? "failed" : "waiting_generation";
      return this.repository.updateTask(taskId, { status, finishedAt: new Date().toISOString() });
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  async cancel(productId, taskId) {
    const task = await this.repository.getTask(taskId);
    if (!task || task.productId !== productId) throw imageError("IMAGE_GENERATION_TASK_NOT_FOUND", "图片生成任务不存在。", 404);
    for (const item of task.items.filter((entry) => ["waiting", "generating"].includes(entry.status))) await this.repository.updateItem(item.id, { status: "cancelled" });
    return this.repository.updateTask(taskId, { status: "cancelled", cancelledAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  }

  async adopt(product, taskId, itemId, audit = {}) {
    const task = await this.repository.getTask(taskId);
    const item = task?.items.find((entry) => entry.id === itemId);
    if (!task || task.productId !== product.id || !item) throw imageError("IMAGE_GENERATION_ITEM_NOT_FOUND", "图片候选不存在。", 404);
    if (item.status !== "completed" || !item.generatedFileId) throw imageError("IMAGE_GENERATION_ITEM_NOT_READY", "只有已完成并持久化的图片才可以采用。");
    if (!task.listingDraftId || !this.listingService) throw imageError("IMAGE_LISTING_DRAFT_REQUIRED", "请先保存上架草稿，再采用 AI 图片。");
    const draft = await this.listingService.get(task.listingDraftId);
    if (!draft || draft.productId !== product.id) throw imageError("PRODUCT_LISTING_NOT_FOUND", "上架草稿不存在。", 404);
    const imageIds = [...new Set([...(draft.media?.imageIds || []), item.generatedFileId])];
    await this.listingService.save(product, { ...draft, media: { ...draft.media, imageIds } }, audit, false);
    await this.repository.updateItem(item.id, { adoptedAt: new Date().toISOString(), adoptedBy: audit.operatorLabel || "local_session" });
    return this.repository.getTask(taskId);
  }
}
