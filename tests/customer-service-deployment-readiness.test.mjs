import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCustomerServiceDeploymentReadiness } from "../lib/customer-service/customer-service-deployment-readiness.mjs";

function status(overrides = {}) {
  return {
    ready: true,
    phase: "CONTROL_PLANE_READY",
    humanConfirmationRequired: true,
    automaticSendEnabled: false,
    identityProtectionConfigured: true,
    replyAutomation: { configured: true, enabled: false, draftFillEnabled: false },
    dependencies: { productKnowledge: { ready: true, publishedSupportReleaseTotal: 1 } },
    ...overrides,
  };
}

function account(mode, rollout = {}) {
  return {
    id: "account-1",
    settings: { automationMode: mode },
    rollout: {
      currentMode: mode,
      nextMode: mode === "OBSERVE_ONLY" ? "SUGGEST_ONLY" : mode === "SUGGEST_ONLY" ? "DRAFT_FILL" : null,
      canAdvance: false,
      blockers: [],
      ...rollout,
    },
  };
}

test("observe-only deployment readiness requires both model gates off and never-send", () => {
  const ready = evaluateCustomerServiceDeploymentReadiness({
    status: status(),
    accounts: [account("OBSERVE_ONLY")],
    target: "observe",
    accountId: "account-1",
  });
  assert.equal(ready.ready, true);

  const unsafe = evaluateCustomerServiceDeploymentReadiness({
    status: status({ replyAutomation: { configured: true, enabled: true, draftFillEnabled: true } }),
    accounts: [account("OBSERVE_ONLY")],
    target: "observe",
    accountId: "account-1",
  });
  assert.equal(unsafe.ready, false);
  assert.deepEqual(unsafe.blockers.map((item) => item.code), [
    "CS_AI_MUST_BE_DISABLED_FOR_OBSERVE",
    "CS_DRAFT_FILL_MUST_BE_DISABLED_FOR_OBSERVE",
  ]);
});

test("suggest readiness requires a published SUPPORT release and account observation evidence", () => {
  const notReady = evaluateCustomerServiceDeploymentReadiness({
    status: status({
      replyAutomation: { configured: true, enabled: true, draftFillEnabled: false },
      dependencies: { productKnowledge: { ready: true, publishedSupportReleaseTotal: 0 } },
    }),
    accounts: [account("OBSERVE_ONLY", {
      nextMode: "SUGGEST_ONLY",
      canAdvance: false,
      blockers: ["CS_ACCOUNT_OBSERVATION_REQUIRED", "CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED"],
    })],
    target: "suggest",
    accountId: "account-1",
  });
  assert.equal(notReady.ready, false);
  assert.ok(notReady.blockers.some((item) => item.code === "CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED"));
  assert.ok(notReady.blockers.some((item) => item.code === "CS_ACCOUNT_OBSERVATION_REQUIRED"));

  const ready = evaluateCustomerServiceDeploymentReadiness({
    status: status({ replyAutomation: { configured: true, enabled: true, draftFillEnabled: false } }),
    accounts: [account("OBSERVE_ONLY", { nextMode: "SUGGEST_ONLY", canAdvance: true })],
    target: "suggest",
    accountId: "account-1",
  });
  assert.equal(ready.ready, true);
});

test("draft readiness requires reviewed suggestions, the draft gate and no automatic send", () => {
  const ready = evaluateCustomerServiceDeploymentReadiness({
    status: status({ replyAutomation: { configured: true, enabled: true, draftFillEnabled: true } }),
    accounts: [account("SUGGEST_ONLY", { nextMode: "DRAFT_FILL", canAdvance: true })],
    target: "draft",
    accountId: "account-1",
  });
  assert.equal(ready.ready, true);

  const unsafe = evaluateCustomerServiceDeploymentReadiness({
    status: status({
      automaticSendEnabled: true,
      humanConfirmationRequired: false,
      replyAutomation: { configured: true, enabled: true, draftFillEnabled: true },
    }),
    accounts: [account("SUGGEST_ONLY", { nextMode: "DRAFT_FILL", canAdvance: true })],
    target: "draft",
    accountId: "account-1",
  });
  assert.equal(unsafe.ready, false);
  assert.ok(unsafe.blockers.some((item) => item.code === "CS_NO_SEND_CONTRACT_VIOLATION"));
});
