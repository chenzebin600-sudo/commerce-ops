export const CUSTOMER_SERVICE_REVIEW_METRIC_VERSION = "NORMALIZED_LEVENSHTEIN_V1";

export const CUSTOMER_SERVICE_REVIEW_REASON_CODES = Object.freeze({
  ACCEPT: Object.freeze(["AI_REPLY_APPROVED"]),
  EDIT: Object.freeze([
    "FACT_CORRECTION",
    "ADD_MISSING_CONTEXT",
    "TONE_ADJUSTMENT",
    "LANGUAGE_CORRECTION",
    "POLICY_CORRECTION",
    "SHORTEN_REPLY",
    "CLARIFY_REPLY",
    "OTHER_EDIT",
    "OPERATOR_EDITED",
  ]),
  REJECT: Object.freeze([
    "FACT_ERROR",
    "MISSING_CONTEXT",
    "WRONG_INTENT",
    "WRONG_LANGUAGE",
    "UNSAFE_PROMISE",
    "POLICY_MISMATCH",
    "POOR_TONE",
    "TOO_VERBOSE",
    "OTHER",
  ]),
});

function normalizedCharacters(value) {
  return Array.from(String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase());
}

function boundedSample(characters, limit) {
  if (characters.length <= limit) return characters;
  const sampled = [];
  const step = characters.length / limit;
  for (let index = 0; index < limit; index += 1) {
    sampled.push(characters[Math.floor(index * step)]);
  }
  return sampled;
}

function levenshteinDistance(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function measureCustomerServiceReviewEdit(originalText, finalText, { sampleLimit = 1_500 } = {}) {
  const original = normalizedCharacters(originalText);
  const final = normalizedCharacters(finalText);
  const boundedLimit = Math.max(100, Math.min(2_000, Number(sampleLimit) || 1_500));
  const approximate = original.length > boundedLimit || final.length > boundedLimit;
  const sampledOriginal = boundedSample(original, boundedLimit);
  const sampledFinal = boundedSample(final, boundedLimit);
  const denominator = Math.max(sampledOriginal.length, sampledFinal.length, 1);
  const distance = levenshteinDistance(sampledOriginal, sampledFinal);
  return {
    ratio: Number((distance / denominator).toFixed(6)),
    metricVersion: CUSTOMER_SERVICE_REVIEW_METRIC_VERSION,
    approximate,
    originalLength: original.length,
    finalLength: final.length,
  };
}

export function normalizeCustomerServiceReviewReason(action, reasonCode) {
  const normalizedAction = String(action || "").trim().toUpperCase();
  const normalizedReason = String(reasonCode || "").trim().toUpperCase();
  const allowed = CUSTOMER_SERVICE_REVIEW_REASON_CODES[normalizedAction] || [];
  if (normalizedAction === "REJECT" && !normalizedReason) {
    throw Object.assign(new Error("A rejection reason is required"), { code: "CS_REVIEW_REASON_REQUIRED" });
  }
  const fallback = normalizedAction === "ACCEPT"
    ? "AI_REPLY_APPROVED"
    : normalizedAction === "EDIT" ? "OPERATOR_EDITED" : "";
  const effective = normalizedReason || fallback;
  if (effective && !allowed.includes(effective)) {
    throw Object.assign(new Error("Review reason is not allowed for this action"), { code: "CS_REVIEW_REASON_INVALID" });
  }
  return effective || null;
}
