import assert from "node:assert/strict";
import test from "node:test";
import {
  createExternalTaskPolicy,
  ExternalTaskPolicyError,
  startExternalRunners,
} from "../lib/runtime/external-task-policy.mjs";

test("shared PostgreSQL development disables external tasks by default", () => {
  const policy = createExternalTaskPolicy({ databaseProvider: "postgres", env: {} });
  assert.deepEqual(policy.status(), {
    enabled: false,
    instanceId: null,
    state: "disabled_by_configuration",
  });
  assert.throws(() => policy.assertAllowed("mabang_scheduler"), (error) => (
    error instanceof ExternalTaskPolicyError && error.code === "EXTERNAL_TASKS_DISABLED"
  ));
});

test("enabled external tasks require a stable instance id", () => {
  assert.throws(
    () => createExternalTaskPolicy({ databaseProvider: "postgres", env: { EXTERNAL_TASKS_ENABLED: "true" } }),
    /INSTANCE_ID/,
  );
});

test("non-executor skips every registered external runner", async () => {
  let starts = 0;
  const policy = createExternalTaskPolicy({ databaseProvider: "postgres", env: { EXTERNAL_TASKS_ENABLED: "false" } });
  const result = await startExternalRunners({ policy, runners: [{ name: "scheduler", start: async () => { starts += 1; } }] });
  assert.deepEqual(result, { status: "disabled_by_configuration", started: [] });
  assert.equal(starts, 0);
});

test("designated executor starts runners only after the shared lease is acquired", async () => {
  const policy = createExternalTaskPolicy({
    databaseProvider: "postgres",
    env: { EXTERNAL_TASKS_ENABLED: "true", INSTANCE_ID: "host-c-executor" },
  });
  let starts = 0;
  assert.deepEqual(await startExternalRunners({ policy, acquireLease: async () => false, runners: [] }), {
    status: "waiting_for_lease", started: [],
  });
  assert.deepEqual(await startExternalRunners({
    policy,
    acquireLease: async (instanceId) => instanceId === "host-c-executor",
    runners: [{ name: "scheduler", start: async () => { starts += 1; } }],
  }), { status: "active", started: ["scheduler"] });
  assert.equal(starts, 1);
  assert.equal(policy.status().state, "active");
});
