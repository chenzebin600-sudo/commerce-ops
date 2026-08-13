const RESOLUTIONS = new Set(["LINK_VERIFIED_OBJECT", "CONFIRMED_NOT_SENT", "ABANDONED"]);
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api.?key|private.?key)/i;

function reconciliationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requiredText(value, name) {
  const output = String(value ?? "").trim();
  if (!output) throw new TypeError(`${name} is required`);
  return output;
}

function boundedEvidence(value, depth = 0) {
  if (depth > 4) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 256);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => boundedEvidence(entry, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 256);
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 30)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : boundedEvidence(entry, depth + 1);
  }
  return output;
}

function compactEvidence(value, essential = {}) {
  const original = JSON.stringify(value);
  const bounded = boundedEvidence(value);
  const serialized = JSON.stringify(bounded);
  if (original.length <= 4_096 && serialized.length <= 4_096) return { ...bounded, ...essential };
  return {
    ...essential,
    truncated: true,
    digestInputLength: original.length,
    sha256: createHash("sha256").update(original).digest("hex"),
  };
}

function exactItemReadback(intent, item, readback) {
  const target = String(intent.targetKey || "").split("\u001f");
  const approvedTarget = item.payload?.approvalTarget?.targetDiscountId;
  return Boolean(readback?.verified === true
    && readback.operationUuid === intent.operationUuid
    && readback.payloadHash === intent.payloadHash
    && readback.platformObjectId
    && String(readback.activityId || "") === target[1]
    && String(readback.platformObjectId) === String(approvedTarget || target[1])
    && readback.membership === true
    && String(readback.itemId || "") === target[2]
    && String(readback.modelId || "") === target[3]
    && String(readback.priceMinor ?? "") === item.targetPriceMinor);
}

function exactCreateReadback(intent, activity, readback) {
  const metadata = activity?.metadata || {};
  const target = String(intent.targetKey || "").split("\u001f");
  return Boolean(readback?.verified === true
    && readback.markerVerified === true
    && exactRenewalProof(intent, activity, readback)
    && readback.platformObjectId
    && String(readback.shopId || "") === String(activity?.shopId || "")
    && target[0] === String(activity?.shopId || "")
    && target[1] === metadata.fingerprint
    );
}

export async function reconcileIntent(intentId, resolution, auditContext = {}) {
  if (!auditContext?.repository) throw new TypeError("Reconciliation repository is required");
  const actorId = requiredText(auditContext.actorId, "auditContext.actorId");
  const requestId = requiredText(auditContext.requestId, "auditContext.requestId");
  if (!RESOLUTIONS.has(resolution)) {
    throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_INVALID", "Unsupported reconciliation resolution");
  }
  if (auditContext.requeue || auditContext.replacementOperationUuid) {
    throw reconciliationError(
      "SHOPEE_DISCOUNT_RECONCILIATION_REPLACEMENT_FORBIDDEN",
      "Reconciliation cannot requeue or replace an operation",
    );
  }
  const intent = await auditContext.repository.getDispatchIntent(intentId);
  if (!intent) throw reconciliationError("SHOPEE_DISCOUNT_INTENT_NOT_FOUND", "Dispatch intent was not found");
  if (!new Set(["UNKNOWN", "DISPATCHED"]).has(intent.status)) {
    throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_CLOSED", "Dispatch intent reconciliation is already closed");
  }
  if (resolution === "CONFIRMED_NOT_SENT") {
    if (typeof auditContext.confirmNotSent !== "function") {
      throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_EVIDENCE_REQUIRED", "Deterministic non-transmission evidence is required");
    }
    const confirmation = await auditContext.confirmNotSent(intent);
    if (confirmation?.deterministic !== true
      || !new Set(["OFFICIAL", "RELAY"]).has(confirmation?.source)
      || confirmation?.transmitted !== false
      || confirmation?.operationUuid !== intent.operationUuid) {
      throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_EVIDENCE_REQUIRED", "Evidence does not deterministically prove non-transmission");
    }
    return auditContext.repository.reconcileIntent({
      intentId,
      resolution,
      evidence: compactEvidence({ source: confirmation.source, requestId, confirmation }, {
        source: confirmation.source, requestId, operationUuid: intent.operationUuid,
      }),
      actor: { actorId },
      executionStatus: "SKIPPED",
      reasonCode: "CONFIRMED_NOT_SENT",
    });
  }
  if (resolution === "ABANDONED") {
    const acceptance = auditContext.evidence;
    if (!acceptance || acceptance.accepted !== true
      || typeof acceptance.reasonCode !== "string"
      || !/^[A-Z][A-Z0-9_]{2,100}$/.test(acceptance.reasonCode)) {
      throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_EVIDENCE_REQUIRED", "Explicit operator acceptance evidence is required");
    }
    return auditContext.repository.reconcileIntent({
      intentId,
      resolution,
      evidence: compactEvidence({ source: "OPERATOR_ACCEPTANCE", requestId, acceptance }),
      actor: { actorId },
      executionStatus: "SKIPPED",
      reasonCode: acceptance.reasonCode,
      activityShopId: intent.planItemId ? null : String(intent.targetKey || "").split("\u001f")[0],
    });
  }
  if (resolution !== "LINK_VERIFIED_OBJECT") {
    throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_NOT_IMPLEMENTED", "Reconciliation resolution is not implemented");
  }
  if (typeof auditContext.readbackIntent !== "function") {
    throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_EVIDENCE_REQUIRED", "Official readback is required");
  }
  const item = intent.planItemId ? await auditContext.repository.getPlanItem(intent.planItemId) : null;
  let activity = null;
  if (!item && intent.targetType === "createDiscount") {
    const shopId = String(intent.targetKey || "").split("\u001f")[0];
    activity = await auditContext.repository.getPlanActivity(intent.planId, shopId);
  }
  const readback = await auditContext.readbackIntent(intent);
  const exact = item ? exactItemReadback(intent, item, readback)
    : exactCreateReadback(intent, activity, readback);
  if (!exact) {
    throw reconciliationError("SHOPEE_DISCOUNT_RECONCILIATION_READBACK_MISMATCH", "Official readback does not prove the exact platform result");
  }
  const essentials = {
    source: "OFFICIAL_READBACK", requestId, operationUuid: intent.operationUuid,
    payloadHash: intent.payloadHash, platformObjectId: String(readback.platformObjectId),
  };
  const safeReadback = compactEvidence(readback, essentials);
  return auditContext.repository.reconcileIntent({
    intentId,
    resolution,
    evidence: compactEvidence({ source: "OFFICIAL_READBACK", requestId, readback: safeReadback }, essentials),
    actor: { actorId },
    platformObjectId: String(readback.platformObjectId),
    readback: safeReadback,
    executionStatus: "SUCCEEDED",
    activityShopId: activity?.shopId || null,
    resetActivityItems: Boolean(activity),
  });
}
import { createHash } from "node:crypto";
import { exactRenewalProof } from "./renewal-proof.mjs";
