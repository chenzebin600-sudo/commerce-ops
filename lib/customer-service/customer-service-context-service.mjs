import { buildAiContextEnvelope } from "../ai/context/ai-context-contracts.mjs";

function contextError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requiredText(value, name, max = 300) {
  const text = String(value ?? "").trim();
  if (!text) throw contextError("CS_CONTEXT_INPUT_REQUIRED", `${name} is required`);
  if (text.length > max) throw contextError("CS_CONTEXT_INPUT_TOO_LONG", `${name} is too long`);
  return text;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function parsePanel(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueTexts(values, limit = 20) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, limit);
}

function skuCandidates(panel) {
  return uniqueTexts([
    panel?.product?.sellerSku,
    panel?.product?.seller_sku,
    panel?.product?.sku,
    panel?.product?.stockSku,
    panel?.structured?.skus,
    panel?.skus,
  ], 10);
}

export class CustomerServiceContextService {
  constructor({
    customerServiceRepository,
    productCoreFacade,
    productKnowledgeService,
    businessContextFacade = null,
    encryptText,
    decryptText,
    digestText,
    createId,
    now = () => new Date(),
  } = {}) {
    if (!customerServiceRepository || !productCoreFacade || !productKnowledgeService) {
      throw new TypeError("Customer-service Context dependencies are required");
    }
    if (![encryptText, decryptText, digestText, createId].every((item) => typeof item === "function")) {
      throw new TypeError("Customer-service Context security and identity functions are required");
    }
    this.repository = customerServiceRepository;
    this.productCore = productCoreFacade;
    this.productKnowledge = productKnowledgeService;
    this.businessContext = businessContextFacade;
    this.encryptText = encryptText;
    this.decryptText = decryptText;
    this.digestText = digestText;
    this.createId = createId;
    this.now = now;
  }

  async build(conversationId) {
    const source = await this.repository.getContextSource(requiredText(conversationId, "conversationId", 120));
    if (!source) return null;
    if (!source.conversation.currentInboundMessageId) {
      throw contextError("CS_CONTEXT_NO_CURRENT_INBOUND", "Conversation does not have a current inbound message", 409);
    }
    const messages = source.messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      contentType: message.contentType,
      content: this.decryptText(message.contentCiphertext),
      sentAt: message.sentAt,
    }));
    const panel = parsePanel(source.panel ? this.decryptText(source.panel.snapshotCiphertext) : null);
    const candidates = skuCandidates(panel);
    const resolutions = [];
    for (const sku of candidates) {
      const resolution = await this.productCore.resolveExactSku({
        sku,
        countryCode: source.conversation.countryCode,
      });
      resolutions.push({ sku, ...resolution });
      if (resolution.status === "RESOLVED") break;
    }
    const resolved = resolutions.find((item) => item.status === "RESOLVED") || null;
    const product = resolved?.product || null;
    const knowledgeInput = product ? {
      productModelId: product.productModelId,
      productSkuId: product.productSkuId,
      categoryId: product.categoryId,
      categoryName: product.categoryL1 || product.categoryL2,
      countryCode: source.conversation.countryCode,
      limit: 20,
    } : null;
    const knowledge = product
      ? typeof this.productKnowledge.resolveSupportBundle === "function"
        ? await this.productKnowledge.resolveSupportBundle(knowledgeInput)
        : {
            claims: await this.productKnowledge.resolveSupportKnowledge(knowledgeInput),
            accessories: [], policies: [], playbooks: [],
          }
      : { claims: [], accessories: [], policies: [], playbooks: [] };
    const claims = knowledge.claims;
    const shopResolution = this.businessContext
      ? source.conversation.commerceShopId
        ? { status: "CONFIRMED_BINDING", shop: await this.businessContext.getCommerceShop(source.conversation.commerceShopId) }
        : await this.businessContext.resolveShopCandidates({
          observedName: source.conversation.shopName,
          countryCode: source.conversation.countryCode,
        })
      : { status: "FACADE_UNAVAILABLE", candidates: [] };
    const orderRefs = uniqueTexts([
      panel?.order?.references,
      panel?.order?.orderNo,
      panel?.order?.orderNumber,
      panel?.order?.orderId,
      panel?.order?.reference,
      panel?.structured?.order_refs,
      panel?.orderRefs,
    ], 5);
    let orderResolution = { status: orderRefs.length ? "SHOP_BINDING_REQUIRED" : "ORDER_REF_MISSING" };
    if (this.businessContext && source.conversation.commerceShopId && orderRefs.length) {
      for (const orderRef of orderRefs) {
        const result = await this.businessContext.findExactOrder({
          commerceShopId: source.conversation.commerceShopId,
          orderRef,
        });
        orderResolution = { observedOrderRef: orderRef, ...result };
        if (result.status === "RESOLVED") break;
      }
    }
    const logisticsResolution = this.businessContext
      && source.conversation.commerceShopId
      && orderResolution.status === "RESOLVED"
      && typeof this.businessContext.authoritativeLogistics === "function"
      ? await this.businessContext.authoritativeLogistics({
          commerceShopId: source.conversation.commerceShopId,
          orderRef: orderResolution.order.orderRef,
        })
      : {
          status: orderResolution.status === "RESOLVED" ? "FACADE_UNAVAILABLE" : "AUTHORITATIVE_ORDER_REQUIRED",
          authoritative: false,
          records: [],
        };
    const inventoryResolution = this.businessContext && product
      ? await this.businessContext.currentInventory({
        productSkuId: product.productSkuId,
        countryCode: source.conversation.countryCode,
      })
      : { status: product ? "FACADE_UNAVAILABLE" : "PRODUCT_REQUIRED", snapshots: [] };
    const productPackage = this.businessContext && product
      ? await this.businessContext.productPackageSnapshot(product.productSkuId)
      : null;
    const missing = [];
    if (!source.conversation.commerceShopId) missing.push("confirmed_commerce_shop_identity");
    if (!source.panel) missing.push("liaoliao_right_panel_snapshot");
    if (!candidates.length) missing.push("product_sku_observation");
    else if (!product) missing.push("product_core_exact_match");
    if (product && !claims.length && !knowledge.accessories.length && !knowledge.policies.length && !knowledge.playbooks.length) {
      missing.push("published_product_knowledge");
    }
    if (orderResolution.status !== "RESOLVED") missing.push("authoritative_order_context");
    if (logisticsResolution.status !== "RESOLVED") missing.push("authoritative_logistics_context");
    if (inventoryResolution.status !== "RESOLVED") missing.push("authoritative_inventory_context");
    if (product && !productPackage) missing.push("product_package_snapshot");
    const businessEvidence = [];
    if (orderResolution.status === "RESOLVED") businessEvidence.push({
      rank: 1,
      sourceType: "MABANG_ORDER",
      sourceId: orderResolution.order.id,
      sourceVersion: `revision:${orderResolution.order.revision}`,
      label: `Order ${orderResolution.order.orderRef}`,
      excerpt: `status=${orderResolution.order.status}; quality=${orderResolution.order.qualityStatus}`,
    });
    if (logisticsResolution.status === "RESOLVED") businessEvidence.push({
      rank: businessEvidence.length + 1,
      sourceType: "PLATFORM_GATEWAY_ORDER_ITEMS",
      sourceId: `${source.conversation.commerceShopId}:${logisticsResolution.orderRef}`,
      sourceVersion: logisticsResolution.providerRequestId || logisticsResolution.fetchedAt,
      label: `Logistics ${logisticsResolution.orderRef}`,
      excerpt: `${logisticsResolution.records.length} order item rows; tracking_assigned=${logisticsResolution.trackingAssigned}`,
    });
    if (inventoryResolution.status === "RESOLVED") businessEvidence.push({
      rank: businessEvidence.length + 1,
      sourceType: "MABANG_INVENTORY",
      sourceId: inventoryResolution.source.batchId,
      sourceVersion: inventoryResolution.source.sourceSha256,
      label: "Current inventory snapshot",
      excerpt: `${inventoryResolution.snapshots.length} country-mapped warehouse rows`,
    });
    if (productPackage) businessEvidence.push({
      rank: businessEvidence.length + 1,
      sourceType: "PRODUCT_PACKAGE",
      sourceId: productPackage.id,
      sourceVersion: productPackage.rowHash,
      label: "Product package snapshot",
      excerpt: `updated_at=${productPackage.updatedAt}`,
    });
    const knowledgeEvidence = [
      ...claims.map((claim) => ({
        sourceType: "PRODUCT_KNOWLEDGE_RELEASE",
        sourceId: claim.evidence.sourceId,
        sourceVersion: `${claim.release.key}@${claim.release.version}`,
        claimId: claim.id,
        label: claim.title || claim.claimType,
        excerpt: claim.text.slice(0, 800),
        releaseId: claim.release.id,
        releaseDigest: claim.release.digest,
      })),
      ...knowledge.accessories.map((item) => ({
        sourceType: "PRODUCT_ACCESSORY_RELEASE",
        sourceId: item.evidence.sourceId,
        sourceVersion: `${item.release.key}@${item.release.version}`,
        claimId: item.id,
        label: `Accessory ${item.accessorySkuCode}`,
        excerpt: JSON.stringify(item.relation).slice(0, 800),
        releaseId: item.release.id,
        releaseDigest: item.release.digest,
      })),
      ...knowledge.policies.map((item) => ({
        sourceType: "CUSTOMER_SERVICE_POLICY_RELEASE",
        sourceId: item.evidence.sourceId,
        sourceVersion: `${item.release.key}@${item.release.version}`,
        claimId: item.id,
        label: item.policy?.issue || item.policyKey,
        excerpt: JSON.stringify(item.policy).slice(0, 800),
        releaseId: item.release.id,
        releaseDigest: item.release.digest,
      })),
      ...knowledge.playbooks.map((item) => ({
        sourceType: "CUSTOMER_SERVICE_PLAYBOOK_RELEASE",
        sourceId: item.evidence.sourceId,
        sourceVersion: `${item.release.key}@${item.release.version}`,
        claimId: item.id,
        label: item.playbook?.question || item.playbookKey,
        excerpt: JSON.stringify(item.playbook).slice(0, 800),
        releaseId: item.release.id,
        releaseDigest: item.release.digest,
      })),
    ];
    const evidence = [...businessEvidence, ...knowledgeEvidence.map((item, index) => ({
      rank: businessEvidence.length + index + 1,
      ...item,
    }))];
    const builtAt = this.now().toISOString();
    const context = stableValue({
      contractVersion: "CS_CONTEXT_V1",
      builtAt,
      trigger: {
        conversationId: source.conversation.id,
        messageId: source.conversation.currentInboundMessageId,
      },
      shop: {
        accountId: source.conversation.accountId,
        channel: source.conversation.channel,
        observedShopName: source.conversation.shopName,
        countryCode: source.conversation.countryCode,
        commerceShopId: source.conversation.commerceShopId,
        identityStatus: source.conversation.shopIdentityStatus,
        registryResolution: shopResolution,
      },
      messages,
      observedPanel: panel ? {
        source: "LIAOLIAO_PLAYWRIGHT_OBSERVATION",
        observedAt: source.panel.observedAt,
        digest: source.panel.snapshotDigest,
        data: panel,
        authoritative: false,
      } : null,
      product: product ? {
        source: "PRODUCT_CORE",
        matchMethod: "EXACT_STOCK_SKU_AND_COUNTRY",
        observedSku: resolved.sku,
        ...product,
      } : { source: "PRODUCT_CORE", matchStatus: resolutions.at(-1)?.status || "SKU_NOT_OBSERVED" },
      productPackage: productPackage ? {
        source: "PRODUCT_PACKAGE",
        id: productPackage.id,
        version: productPackage.rowHash,
        importBatchId: productPackage.importBatchId,
        updatedAt: productPackage.updatedAt,
        facts: productPackage.facts,
      } : null,
      order: orderResolution.status === "RESOLVED" ? {
        source: "MABANG_ORDER",
        resolutionStatus: orderResolution.status,
        data: orderResolution.order,
      } : { source: "MABANG_ORDER", resolutionStatus: orderResolution.status },
      logistics: logisticsResolution.status === "RESOLVED" ? {
        source: "PLATFORM_GATEWAY_ORDER_ITEMS",
        authoritative: true,
        resolutionStatus: logisticsResolution.status,
        orderRef: logisticsResolution.orderRef,
        providerRequestId: logisticsResolution.providerRequestId,
        fetchedAt: logisticsResolution.fetchedAt,
        cacheHit: logisticsResolution.cacheHit === true,
        trackingAssigned: logisticsResolution.trackingAssigned,
        records: logisticsResolution.records,
        observed: panel?.logistics || null,
      } : {
        source: "PLATFORM_GATEWAY_ORDER_ITEMS",
        authoritative: false,
        resolutionStatus: logisticsResolution.status,
        errorCode: logisticsResolution.errorCode || null,
        orderRef: logisticsResolution.orderRef || orderResolution.observedOrderRef || null,
        records: [],
        observed: panel?.logistics || null,
      },
      inventory: {
        source: "MABANG_INVENTORY",
        resolutionStatus: inventoryResolution.status,
        sourceSnapshot: inventoryResolution.source || null,
        snapshots: inventoryResolution.snapshots || [],
      },
      knowledge: {
        source: "PUBLISHED_SUPPORT_VIEW_ONLY",
        claims: claims.map((claim) => ({
          id: claim.id,
          type: claim.claimType,
          title: claim.title,
          text: claim.text,
          riskLevel: claim.riskLevel,
          scope: claim.scope,
          release: claim.release,
        })),
        accessories: knowledge.accessories.map((item) => ({
          id: item.id,
          accessorySkuCode: item.accessorySkuCode,
          countryCode: item.countryCode,
          relation: item.relation,
          release: item.release,
        })),
        policies: knowledge.policies.map((item) => ({
          id: item.id,
          countryCode: item.countryCode,
          categoryName: item.categoryName,
          policy: item.policy,
          release: item.release,
        })),
        playbooks: knowledge.playbooks.map((item) => ({
          id: item.id,
          intentCode: item.intentCode,
          countryCode: item.countryCode,
          playbook: item.playbook,
          release: item.release,
        })),
      },
      unavailable: missing,
    });
    const serialized = JSON.stringify(context);
    const snapshot = await this.repository.saveContextSnapshot({
      id: this.createId(),
      conversationId: source.conversation.id,
      triggerMessageId: source.conversation.currentInboundMessageId,
      contextCiphertext: this.encryptText(serialized),
      contextDigest: this.digestText(serialized),
      contextVersion: "CS_CONTEXT_V1",
      evidenceCount: evidence.length,
      missingFields: missing,
      builtAt,
      expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
      createdAt: builtAt,
    });
    return { snapshot, context, evidence };
  }

  async resolveSnapshot(snapshotId) {
    const snapshot = await this.repository.getContextSnapshot(requiredText(snapshotId, "snapshotId", 120));
    if (!snapshot) {
      throw contextError("CS_CONTEXT_SNAPSHOT_NOT_FOUND", "Customer-service Context snapshot was not found", 404);
    }
    if (snapshot.contextVersion !== "CS_CONTEXT_V1") {
      throw contextError("CS_CONTEXT_VERSION_UNSUPPORTED", "Customer-service Context version is unsupported", 409);
    }
    if (snapshot.triggerMessageId !== snapshot.currentInboundMessageId) {
      throw contextError("CS_CONTEXT_TRIGGER_STALE", "A newer inbound message superseded this Context snapshot", 409);
    }
    const context = parsePanel(this.decryptText(snapshot.contextCiphertext));
    if (!context || context.contractVersion !== "CS_CONTEXT_V1") {
      throw contextError("CS_CONTEXT_SNAPSHOT_INVALID", "Customer-service Context snapshot is invalid", 500);
    }
    return buildAiContextEnvelope({
      type: "customer_service",
      id: snapshot.id,
      generatedAt: new Date(snapshot.builtAt),
      freshness: {
        builtAt: snapshot.builtAt,
        expiresAt: snapshot.expiresAt,
        current: true,
      },
      quality: {
        status: snapshot.missingFields.length ? "partial" : "available",
        evidenceSource: "encrypted_customer_service_context_snapshot",
        limitations: snapshot.missingFields,
      },
      data: {
        contractVersion: snapshot.contextVersion,
        contextDigest: snapshot.contextDigest,
        evidenceCount: snapshot.evidenceCount,
        facts: context,
      },
    });
  }

  async latest(conversationId) {
    const snapshot = await this.repository.getLatestContextSnapshotForConversation(
      requiredText(conversationId, "conversationId", 120),
    );
    if (!snapshot) return null;
    const context = parsePanel(this.decryptText(snapshot.contextCiphertext));
    if (!context) {
      throw contextError("CS_CONTEXT_SNAPSHOT_INVALID", "Customer-service Context snapshot is invalid", 500);
    }
    return {
      snapshot: {
        id: snapshot.id,
        conversationId: snapshot.conversationId,
        triggerMessageId: snapshot.triggerMessageId,
        contextDigest: snapshot.contextDigest,
        contextVersion: snapshot.contextVersion,
        evidenceCount: snapshot.evidenceCount,
        missingFields: snapshot.missingFields,
        builtAt: snapshot.builtAt,
        expiresAt: snapshot.expiresAt,
      },
      context,
    };
  }
}
