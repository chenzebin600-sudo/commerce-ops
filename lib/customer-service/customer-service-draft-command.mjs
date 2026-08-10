function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

export function parseDraftRoute(decryptText, ciphertext, label) {
  try {
    const value = JSON.parse(decryptText(ciphertext));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
    return value;
  } catch {
    throw commandError("CS_DRAFT_ROUTE_INVALID", `${label} browser route is invalid`);
  }
}

export function buildFillDraftPayload({
  conversationRoute,
  messageRoute,
  draft,
  draftContentDigest,
  triggerMessageId,
  contextDigest,
}) {
  const externalConversationId = String(conversationRoute?.externalConversationId || "").trim();
  const externalMessageId = String(messageRoute?.externalMessageId || "").trim();
  const text = String(draft || "").trim();
  if (!externalConversationId || !externalMessageId) {
    throw commandError("CS_DRAFT_ROUTE_INCOMPLETE", "Exact LiaoLiao conversation and message routes are required");
  }
  if (!text) throw commandError("CS_DRAFT_EMPTY", "Reply draft is empty");
  const normalizedDraftContentDigest = String(draftContentDigest || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedDraftContentDigest)) {
    throw commandError("CS_DRAFT_DIGEST_INVALID", "Reply draft content digest is required");
  }
  return {
    contractVersion: "CS_FILL_DRAFT_V1",
    route: {
      externalConversationId,
      externalMessageId,
      shopExternalId: conversationRoute.shopExternalId || null,
      shopName: conversationRoute.shopName || null,
      customerExternalId: conversationRoute.customerExternalId || null,
      customerDisplayName: conversationRoute.customerDisplayName || null,
    },
    draft: text,
    expected: {
      centralTriggerMessageId: triggerMessageId,
      externalMessageId,
      contextDigest: contextDigest || null,
      draftContentDigest: normalizedDraftContentDigest,
    },
    safety: {
      automaticSend: false,
      requireCurrentConversation: true,
      requireLatestInboundMessage: true,
      requireEmptyOrSameEditor: true,
    },
  };
}
