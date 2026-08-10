import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerServiceUiFixtureServer } from "../scripts/preview-customer-service-ui-fixture.mjs";

test("customer-service UI fixture simulates local account onboarding and preserves no-send", async (t) => {
  const server = createCustomerServiceUiFixtureServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const status = await fetch(`${baseUrl}/api/customer-service/status`).then((response) => response.json());
  assert.equal(status.status.automaticSendEnabled, false);
  assert.equal(status.status.dependencies.productKnowledge.publishedSupportReleaseTotal, 1);
  assert.equal(status.status.quality.matchedAiDraftSendTotal, 4);
  assert.equal(status.status.quality.firstResponseP95Ms, 185_000);
  assert.equal(status.status.quality.explicitHandledRate, 0.75);
  assert.equal(status.status.quality.handlingP95Ms, 720_000);

  const accounts = await fetch(`${baseUrl}/api/customer-service/accounts`).then((response) => response.json());
  assert.equal(accounts.accounts.length, 3);
  assert.deepEqual(accounts.accounts.map((account) => account.rollout.stageIndex), [1, 1, 2]);

  const createdResponse = await fetch(`${baseUrl}/api/customer-service/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "新接入测试账号", countryCodes: ["TH"] }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).account;
  assert.equal(created.status, "SETUP_REQUIRED");
  assert.equal(created.settings.automationMode, "OBSERVE_ONLY");
  assert.equal("password" in created, false);
  assert.equal("session" in created, false);

  const runtimeUrl = `${baseUrl}/api/customer-service/accounts/${created.id}/local-runtime`;
  const unconfirmedRead = await fetch(runtimeUrl);
  assert.equal(unconfirmedRead.status, 403);
  assert.equal((await unconfirmedRead.json()).code, "CS_LOCAL_ACTION_CONFIRMATION_REQUIRED");
  const unconfirmedStart = await fetch(`${runtimeUrl}/start`, { method: "POST", body: "{}" });
  assert.equal(unconfirmedStart.status, 403);
  assert.equal((await unconfirmedStart.json()).code, "CS_LOCAL_ACTION_CONFIRMATION_REQUIRED");

  const start = await fetch(`${runtimeUrl}/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-commerce-ops-local-action": "1" },
    body: "{}",
  });
  assert.equal(start.status, 202);
  assert.equal((await start.json()).runtime.state, "STARTING");

  const observedStates = [];
  for (let index = 0; index < 5; index += 1) {
    const runtime = await fetch(runtimeUrl, {
      headers: { "x-commerce-ops-local-action": "1" },
    }).then((response) => response.json());
    observedStates.push(runtime.runtime.state);
  }
  assert.deepEqual(observedStates, [
    "WAITING_FOR_LOGIN",
    "WAITING_FOR_LOGIN",
    "SESSION_READY",
    "MONITOR_STARTING",
    "MONITORING",
  ]);

  const stopped = await fetch(`${runtimeUrl}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-commerce-ops-local-action": "1" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(stopped.runtime.state, "STOPPED");

  const retried = await fetch(`${runtimeUrl}/retry`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-commerce-ops-local-action": "1" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(retried.runtime.state, "STARTING");

  const write = await fetch(`${baseUrl}/api/customer-service/accounts/qa/automation`, { method: "POST" });
  assert.equal(write.status, 405);
  assert.equal((await write.json()).code, "QA_FIXTURE_WRITE_NOT_SUPPORTED");
});
