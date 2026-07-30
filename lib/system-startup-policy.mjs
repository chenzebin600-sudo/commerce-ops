import path from "node:path";

export function loopbackProbeHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value === "0.0.0.0" || value === "::" || value === "[::]" ? "127.0.0.1" : String(host || "").trim();
}

export function nextRestartDelay({ previousDelay = 2000, runtimeMs = 0 } = {}) {
  if (runtimeMs >= 60000) return 2000;
  return Math.min(Math.max(2000, Number(previousDelay) || 2000) * 2, 60000);
}

export function createSystemServiceDefinitions({ rootDir, appConfig, fulfillmentConfig }) {
  return Object.freeze([
    Object.freeze({
      name: "main",
      entry: path.join(rootDir, "server.mjs"),
      healthUrl: `http://${loopbackProbeHost(appConfig.host)}:${appConfig.port}/api/health`,
    }),
    Object.freeze({
      name: "scheduler",
      entry: path.join(rootDir, "scheduler.mjs"),
      requiresOwned: "main",
    }),
    Object.freeze({
      name: "fulfillment",
      entry: path.join(rootDir, "scripts", "fulfillment-supervisor.mjs"),
      healthUrl: `http://${loopbackProbeHost(fulfillmentConfig.host)}:${fulfillmentConfig.port}/health`,
    }),
  ]);
}
