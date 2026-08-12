const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export class ExternalTaskPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExternalTaskPolicyError";
    this.code = code;
  }
}

function configuredBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new ExternalTaskPolicyError("EXTERNAL_TASKS_CONFIG_INVALID", "EXTERNAL_TASKS_ENABLED must be true or false");
}

export function createExternalTaskPolicy({ databaseProvider = "sqlite", env = process.env } = {}) {
  const sharedPostgresql = ["postgres", "postgresql"].includes(String(databaseProvider).trim().toLowerCase());
  const enabled = configuredBoolean(env.EXTERNAL_TASKS_ENABLED, !sharedPostgresql);
  const instanceId = String(env.INSTANCE_ID || "").trim() || null;
  if (enabled && sharedPostgresql && !instanceId) {
    throw new ExternalTaskPolicyError("INSTANCE_ID_REQUIRED", "INSTANCE_ID is required when shared PostgreSQL external tasks are enabled");
  }
  let state = enabled ? "waiting_for_lease" : "disabled_by_configuration";
  return Object.freeze({
    enabled,
    instanceId,
    assertAllowed(operation = "external_task") {
      if (!enabled) {
        throw new ExternalTaskPolicyError("EXTERNAL_TASKS_DISABLED", `${operation} is disabled on this instance`);
      }
      return true;
    },
    setState(next) {
      if (!new Set(["waiting_for_lease", "active"]).has(next)) throw new TypeError("External task state is invalid");
      state = next;
    },
    status() { return Object.freeze({ enabled, instanceId, state }); },
  });
}

export async function startExternalRunners({ policy, acquireLease = null, runners = [] } = {}) {
  if (!policy?.status || !policy?.assertAllowed) throw new TypeError("External task policy is required");
  if (!policy.status().enabled) return { status: "disabled_by_configuration", started: [] };
  policy.assertAllowed("external_runners");
  policy.setState("waiting_for_lease");
  if (typeof acquireLease !== "function" || !await acquireLease(policy.status().instanceId)) {
    return { status: "waiting_for_lease", started: [] };
  }
  const started = [];
  for (const runner of runners) {
    if (!runner?.name || typeof runner.start !== "function") throw new TypeError("External runner is invalid");
    await runner.start();
    started.push(runner.name);
  }
  policy.setState("active");
  return { status: "active", started };
}
