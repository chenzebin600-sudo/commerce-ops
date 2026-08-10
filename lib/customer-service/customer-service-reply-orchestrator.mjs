import { buildFillDraftPayload, parseDraftRoute } from "./customer-service-draft-command.mjs";
import { evaluateCustomerServiceReply } from "./customer-service-reply-quality-gate.mjs";

function errorCode(error) {
  return String(error?.code || "CS_REPLY_GENERATION_FAILED").slice(0, 120);
}

function flag(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_").toUpperCase().slice(0, 80);
}

function uniqueFlags(values) {
  return [...new Set(values.map(flag).filter(Boolean))].slice(0, 40);
}

export class CustomerServiceReplyOrchestrator {
  constructor({
    repository,
    contextService,
    replyAgent,
    encryptText,
    decryptText,
    digestText,
    createId,
    audit = null,
    draftFillEnabled = true,
    contextSettleMs = 8_000,
    minimumAutoFillConfidence = 0.72,
    now = () => new Date(),
  } = {}) {
    if (!repository || !contextService || !replyAgent) throw new TypeError("Customer-service Reply dependencies are required");
    if (![encryptText, decryptText, digestText, createId].every((item) => typeof item === "function")) {
      throw new TypeError("Customer-service Reply security and identity functions are required");
    }
    this.repository = repository;
    this.contextService = contextService;
    this.replyAgent = replyAgent;
    this.encryptText = encryptText;
    this.decryptText = decryptText;
    this.digestText = digestText;
    this.createId = createId;
    this.audit = audit;
    this.draftFillEnabled = Boolean(draftFillEnabled);
    this.contextSettleMs = Math.max(0, Number(contextSettleMs) || 0);
    this.minimumAutoFillConfidence = Math.max(0, Math.min(1, Number(minimumAutoFillConfidence) || 0.72));
    this.now = now;
  }

  async record(action, status, metadata = {}, error = null) {
    if (!this.audit?.recordSafely) return null;
    return this.audit.recordSafely({
      requestId: metadata.requestId,
      module: "customer_service",
      action,
      status,
      actorType: "customer_service_reply_runner",
      errorStage: error ? "reply_generation" : null,
      errorCode: error ? errorCode(error) : null,
      errorSummary: error || null,
      metadata,
    });
  }

  async processNext() {
    const startedAt = this.now();
    const suggestion = await this.repository.claimQueuedSuggestion({
      now: startedAt.toISOString(),
      createdBefore: new Date(startedAt.getTime() - this.contextSettleMs).toISOString(),
    });
    if (!suggestion) return null;
    const requestId = suggestion.id;
    await this.record("customer_service.reply_generation.started", "success", {
      requestId,
      suggestionId: suggestion.id,
      conversationId: suggestion.conversationId,
      triggerMessageId: suggestion.triggerMessageId,
    });
    try {
      const built = await this.contextService.build(suggestion.conversationId);
      if (!built?.snapshot?.id) {
        throw Object.assign(new Error("Customer-service Context could not be built"), { code: "CS_CONTEXT_BUILD_FAILED" });
      }
      const generated = await this.replyAgent.run({
        snapshotId: built.snapshot.id,
        suggestionId: suggestion.id,
        requestId,
      });
      const output = generated.output;
      const conversationRoute = parseDraftRoute(this.decryptText, suggestion.conversationRoutingCiphertext, "Conversation");
      const messageRoute = parseDraftRoute(this.decryptText, suggestion.messageRoutingCiphertext, "Message");
      const deterministicFlags = built.snapshot.missingFields.map((item) => `MISSING_${item}`);
      const qualityGate = evaluateCustomerServiceReply({
        output,
        context: built.context,
        evidence: built.evidence,
        minimumAutoFillConfidence: this.minimumAutoFillConfidence,
      });
      const fillEligible = this.draftFillEnabled
        && suggestion.automationMode === "DRAFT_FILL"
        && qualityGate.safeToAutoFill
        && Boolean(suggestion.workerId)
        && Boolean(conversationRoute?.externalConversationId)
        && Boolean(messageRoute?.externalMessageId);
      const qualityFlags = uniqueFlags([
        ...output.qualityFlags,
        ...qualityGate.qualityFlags,
        ...deterministicFlags,
        "HUMAN_CONFIRMATION_REQUIRED",
        ...(qualityGate.autoFillBlockers.length ? ["DETERMINISTIC_QUALITY_GATE_BLOCKED"] : []),
        ...(!suggestion.workerId ? ["WORKER_ROUTE_UNAVAILABLE"] : []),
        ...(suggestion.automationMode !== "DRAFT_FILL" ? ["ACCOUNT_DRAFT_FILL_DISABLED"] : []),
        ...(!this.draftFillEnabled ? ["DRAFT_FILL_DISABLED"] : []),
      ]);
      const evidence = built.evidence.map((item, index) => ({
        id: this.createId(),
        sourceType: String(item.sourceType || "UNKNOWN").slice(0, 80),
        sourceId: item.sourceId ? String(item.sourceId).slice(0, 200) : null,
        sourceVersion: item.sourceVersion ? String(item.sourceVersion).slice(0, 200) : null,
        label: String(item.label || item.sourceType || "Evidence").slice(0, 300),
        excerptCiphertext: item.excerpt ? this.encryptText(String(item.excerpt).slice(0, 2_000)) : null,
        rank: Number(item.rank || index + 1),
        metadata: {
          claimId: item.claimId || null,
          releaseId: item.releaseId || null,
          releaseDigest: item.releaseDigest || null,
          usedByModel: output.usedEvidenceIds.includes(item.claimId)
            || output.usedEvidenceIds.includes(item.sourceId),
        },
      }));
      const draftCiphertext = this.encryptText(output.draftReply);
      const command = fillEligible ? {
        id: this.createId(),
        idempotencyKey: `fill-draft:${suggestion.id}:${built.snapshot.contextDigest}`,
        workerId: suggestion.workerId,
        accountId: suggestion.accountId,
        conversationId: suggestion.conversationId,
        triggerMessageId: suggestion.triggerMessageId,
        requiresAccountDraftFill: true,
        payloadCiphertext: this.encryptText(JSON.stringify(buildFillDraftPayload({
          conversationRoute,
          messageRoute,
          draft: output.draftReply,
          draftContentDigest: this.digestText(String(output.draftReply || "").trim()),
          triggerMessageId: suggestion.triggerMessageId,
          contextDigest: built.snapshot.contextDigest,
        }))),
      } : null;
      const completed = await this.repository.completeGeneratedSuggestion({
        id: suggestion.id,
        contextSnapshotId: built.snapshot.id,
        draftCiphertext,
        languageCode: output.customerLanguage,
        provider: generated.provider,
        model: generated.model,
        promptVersion: generated.promptVersion,
        confidence: output.confidence,
        inputTokens: generated.usage?.inputTokens ?? null,
        outputTokens: generated.usage?.outputTokens ?? null,
        totalTokens: generated.usage?.totalTokens ?? null,
        intentCode: output.intent,
        riskLevel: qualityGate.effectiveRiskLevel,
        countryCode: built.context?.shop?.countryCode || null,
        commerceShopId: built.context?.shop?.commerceShopId || null,
        productModelId: built.context?.product?.productModelId || null,
        productSkuId: built.context?.product?.productSkuId || null,
        categoryId: built.context?.product?.categoryId || null,
        categoryName: built.context?.product?.categoryName || null,
        qualityFlags,
        evidence,
        command,
        now: this.now().toISOString(),
      });
      await this.record("customer_service.reply_generation.completed", "success", {
        requestId,
        suggestionId: suggestion.id,
        conversationId: suggestion.conversationId,
        contextSnapshotId: built.snapshot.id,
        contextDigest: built.snapshot.contextDigest,
        provider: generated.provider,
        model: generated.model,
        riskLevel: qualityGate.effectiveRiskLevel,
        qualityScore: qualityGate.qualityScore,
        autoFillBlockers: qualityGate.autoFillBlockers,
        commandCreated: Boolean(completed?.commandCreated),
        evidenceCount: evidence.length,
        inputTokens: generated.usage?.inputTokens ?? null,
        outputTokens: generated.usage?.outputTokens ?? null,
        totalTokens: generated.usage?.totalTokens ?? null,
      });
      return { suggestion: completed, output, qualityFlags };
    } catch (error) {
      await this.repository.failGeneratingSuggestion({
        id: suggestion.id,
        errorCode: errorCode(error),
        qualityFlags: ["GENERATION_FAILED"],
        now: this.now().toISOString(),
      });
      await this.record("customer_service.reply_generation.failed", "failed", {
        requestId,
        suggestionId: suggestion.id,
        conversationId: suggestion.conversationId,
      }, error);
      return { suggestion: { id: suggestion.id, status: "FAILED" }, error: errorCode(error) };
    }
  }
}
