const MODES = Object.freeze(["OBSERVE_ONLY", "SUGGEST_ONLY", "DRAFT_FILL"]);
const MODE_RANK = Object.freeze(Object.fromEntries(MODES.map((mode, index) => [mode, index])));

function normalizedMode(value) {
  const mode = String(value || "OBSERVE_ONLY").trim().toUpperCase();
  return Object.hasOwn(MODE_RANK, mode) ? mode : "OBSERVE_ONLY";
}

function count(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function requirement(code, requiredFor, satisfied, observedValue = null) {
  return { code, requiredFor, satisfied: satisfied === true, observedValue };
}

export function evaluateCustomerServiceAutomationTransition({ readiness, automation = {}, targetMode }) {
  const currentMode = normalizedMode(readiness?.account?.settings?.automationMode);
  const target = normalizedMode(targetMode);
  const currentRank = MODE_RANK[currentMode];
  const targetRank = MODE_RANK[target];
  const upgrading = targetRank > currentRank;
  const blockers = [];

  if (upgrading && targetRank !== currentRank + 1) {
    blockers.push("CS_AUTOMATION_TRANSITION_INVALID");
  } else if (upgrading && target === "SUGGEST_ONLY") {
    if (automation.configured !== true) blockers.push("CS_REPLY_AGENT_NOT_CONFIGURED");
    if (automation.enabled !== true) blockers.push("CS_AI_ROLLOUT_DISABLED");
    if (automation.knowledge?.ready !== true) blockers.push("CS_PRODUCT_KNOWLEDGE_NOT_READY");
    if (count(automation.knowledge?.publishedSupportReleaseTotal) < 1) {
      blockers.push("CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED");
    }
    if (readiness?.account?.status !== "ACTIVE") blockers.push("CS_ACCOUNT_ACTIVE_REQUIRED");
    if (!readiness?.account?.lastObservedAt || count(readiness?.observedMessageTotal) < 1) {
      blockers.push("CS_ACCOUNT_OBSERVATION_REQUIRED");
    }
  } else if (upgrading && target === "DRAFT_FILL") {
    if (automation.configured !== true) blockers.push("CS_REPLY_AGENT_NOT_CONFIGURED");
    if (automation.enabled !== true) blockers.push("CS_AI_ROLLOUT_DISABLED");
    if (automation.draftFillEnabled !== true) blockers.push("CS_DRAFT_FILL_DISABLED");
    if (readiness?.account?.status !== "ACTIVE") blockers.push("CS_ACCOUNT_ACTIVE_REQUIRED");
    if (count(readiness?.generatedSuggestionTotal) < 1) blockers.push("CS_SUGGESTION_GENERATION_REQUIRED");
    if (count(readiness?.reviewedSuggestionTotal) < 1) blockers.push("CS_SUGGESTION_REVIEW_REQUIRED");
  }

  return {
    currentMode,
    targetMode: target,
    upgrading,
    allowed: blockers.length === 0,
    blockers,
  };
}

export function buildCustomerServiceAccountRollout(readiness, automation = {}) {
  const account = readiness?.account || {};
  const currentMode = normalizedMode(account.settings?.automationMode);
  const nextMode = MODES[MODE_RANK[currentMode] + 1] || null;
  const observedMessageTotal = count(readiness?.observedMessageTotal);
  const generatedSuggestionTotal = count(readiness?.generatedSuggestionTotal);
  const reviewedSuggestionTotal = count(readiness?.reviewedSuggestionTotal);
  const nextTransition = nextMode
    ? evaluateCustomerServiceAutomationTransition({ readiness, automation, targetMode: nextMode })
    : null;

  return {
    currentMode,
    stageIndex: MODE_RANK[currentMode] + 1,
    stageTotal: MODES.length,
    nextMode,
    canAdvance: nextTransition?.allowed === true,
    blockers: nextTransition?.blockers || [],
    observedMessageTotal,
    generatedSuggestionTotal,
    reviewedSuggestionTotal,
    requirements: [
      requirement("CS_REPLY_AGENT_NOT_CONFIGURED", "SUGGEST_ONLY", automation.configured === true),
      requirement("CS_AI_ROLLOUT_DISABLED", "SUGGEST_ONLY", automation.enabled === true),
      requirement("CS_PRODUCT_KNOWLEDGE_NOT_READY", "SUGGEST_ONLY", automation.knowledge?.ready === true),
      requirement("CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED", "SUGGEST_ONLY", count(automation.knowledge?.publishedSupportReleaseTotal) > 0, count(automation.knowledge?.publishedSupportReleaseTotal)),
      requirement("CS_ACCOUNT_ACTIVE_REQUIRED", "SUGGEST_ONLY", account.status === "ACTIVE", account.status || null),
      requirement("CS_ACCOUNT_OBSERVATION_REQUIRED", "SUGGEST_ONLY", Boolean(account.lastObservedAt) && observedMessageTotal > 0, observedMessageTotal),
      requirement("CS_DRAFT_FILL_DISABLED", "DRAFT_FILL", automation.draftFillEnabled === true),
      requirement("CS_SUGGESTION_GENERATION_REQUIRED", "DRAFT_FILL", generatedSuggestionTotal > 0, generatedSuggestionTotal),
      requirement("CS_SUGGESTION_REVIEW_REQUIRED", "DRAFT_FILL", reviewedSuggestionTotal > 0, reviewedSuggestionTotal),
    ],
  };
}

export const CUSTOMER_SERVICE_AUTOMATION_MODES = MODES;
