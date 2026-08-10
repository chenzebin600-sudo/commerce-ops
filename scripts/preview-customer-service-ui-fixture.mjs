import http from "node:http";
import { pathToFileURL } from "node:url";

const now = "2026-08-08T12:00:00.000Z";

const baseAccounts = Object.freeze([
  {
    id: "qa-observe-blocked",
    channel: "LIAOLIAO",
    displayName: "泰国测试账号 01",
    status: "SETUP_REQUIRED",
    settings: { countryCodes: ["TH"], automationMode: "OBSERVE_ONLY" },
    lastObservedAt: null,
    createdAt: now,
    updatedAt: now,
    rollout: {
      currentMode: "OBSERVE_ONLY", stageIndex: 1, stageTotal: 3,
      nextMode: "SUGGEST_ONLY", canAdvance: false,
      blockers: ["CS_ACCOUNT_ACTIVE_REQUIRED", "CS_ACCOUNT_OBSERVATION_REQUIRED"],
      observedMessageTotal: 0, generatedSuggestionTotal: 0, reviewedSuggestionTotal: 0,
      requirements: [],
    },
  },
  {
    id: "qa-observe-ready",
    channel: "LIAOLIAO",
    displayName: "马来测试账号 02",
    status: "ACTIVE",
    settings: { countryCodes: ["MY"], automationMode: "OBSERVE_ONLY" },
    lastObservedAt: "2026-08-08T11:58:00.000Z",
    createdAt: now,
    updatedAt: now,
    rollout: {
      currentMode: "OBSERVE_ONLY", stageIndex: 1, stageTotal: 3,
      nextMode: "SUGGEST_ONLY", canAdvance: true, blockers: [],
      observedMessageTotal: 12, generatedSuggestionTotal: 0, reviewedSuggestionTotal: 0,
      requirements: [],
    },
  },
  {
    id: "qa-suggest-blocked",
    channel: "LIAOLIAO",
    displayName: "菲律宾测试账号 03",
    status: "ACTIVE",
    settings: { countryCodes: ["PH"], automationMode: "SUGGEST_ONLY" },
    lastObservedAt: "2026-08-08T11:59:00.000Z",
    createdAt: now,
    updatedAt: now,
    rollout: {
      currentMode: "SUGGEST_ONLY", stageIndex: 2, stageTotal: 3,
      nextMode: "DRAFT_FILL", canAdvance: false,
      blockers: ["CS_DRAFT_FILL_DISABLED", "CS_SUGGESTION_REVIEW_REQUIRED"],
      observedMessageTotal: 33, generatedSuggestionTotal: 8, reviewedSuggestionTotal: 0,
      requirements: [],
    },
  },
]);

const status = Object.freeze({
  ready: true,
  phase: "CONTROL_PLANE_READY",
  humanConfirmationRequired: true,
  automaticSendEnabled: false,
  identityProtectionConfigured: true,
  accounts: { SETUP_REQUIRED: 1, ACTIVE: 2 },
  workers: [{
    id: "qa-worker-1", displayName: "匿名浏览器节点", status: "ONLINE", version: "qa",
    capabilities: ["observe_messages", "fill_draft"], lastHeartbeatAt: now,
    lastErrorCode: null, online: true,
  }],
  accountLeases: [{
    accountId: "qa-observe-ready", workerId: "qa-worker-1", status: "ACTIVE",
    leasedUntil: "2099-01-01T00:00:00.000Z", createdAt: now, updatedAt: now,
  }],
  conversations: { OPEN: 0, HANDLED: 0 },
  suggestions: { QUEUED: 0, GENERATING: 0, READY: 0 },
  commands: {},
  quality: {
    generatedTotal: 8, averageConfidence: 0.86, belowThresholdTotal: 1,
    minimumAutoFillConfidence: 0.72, reviewedTotal: 0, reviews: {}, reviewReasons: {},
    averageEditRatio: null, majorEditTotal: 0, inputTokens: 1280, outputTokens: 360, totalTokens: 1640,
    observedOutboundTotal: 6, matchedAiDraftSendTotal: 4, exactAiDraftShare: 4 / 6,
    firstResponseSampleTotal: 6, firstResponseP50Ms: 42_000, firstResponseP95Ms: 185_000,
    explicitHandledTotal: 3, explicitHandledRate: 0.75,
    handlingSampleTotal: 3, handlingP50Ms: 240_000, handlingP95Ms: 720_000,
  },
  replyAutomation: {
    configured: true, enabled: true, draftFillEnabled: false,
    name: "customer-service.reply-suggestion", version: "1.0.0",
    model: "qa-model", promptVersion: "CS-REPLY-1.0.0", concurrency: 4,
    pollIntervalMs: 2000, minimumAutoFillConfidence: 0.72,
  },
  dependencies: { productKnowledge: { ready: true, publishedSupportReleaseTotal: 1 } },
});

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function fixtureRuntime(accountId, state = "IDLE") {
  const timestamp = new Date().toISOString();
  return {
    accountId,
    state,
    workerId: state === "MONITORING" ? `fixture-worker-${accountId}` : null,
    sessionReady: ["SESSION_READY", "MONITOR_STARTING", "MONITORING"].includes(state),
    workerOnline: state === "MONITORING",
    leaseActive: state === "MONITORING",
    canStop: ["STARTING", "WAITING_FOR_LOGIN", "SESSION_READY", "MONITOR_STARTING", "MONITORING"].includes(state),
    canRetry: ["STOPPED", "FAILED"].includes(state),
    lastError: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    pollAfterMs: 50,
  };
}

export function createCustomerServiceUiFixtureServer() {
  const accounts = structuredClone(baseAccounts);
  const runtimes = new Map();
  const transitions = new Map();
  let createdAccountSequence = 0;

  function setRuntime(accountId, state) {
    const runtime = fixtureRuntime(accountId, state);
    runtimes.set(accountId, runtime);
    return runtime;
  }

  function startRuntime(accountId) {
    transitions.set(accountId, [
      "WAITING_FOR_LOGIN",
      "WAITING_FOR_LOGIN",
      "SESSION_READY",
      "MONITOR_STARTING",
      "MONITORING",
    ]);
    return setRuntime(accountId, "STARTING");
  }

  function readRuntime(accountId) {
    if (!runtimes.has(accountId)) return setRuntime(accountId, "IDLE");
    const remaining = transitions.get(accountId) || [];
    if (remaining.length) {
      const [next, ...rest] = remaining;
      transitions.set(accountId, rest);
      return setRuntime(accountId, next);
    }
    return runtimes.get(accountId);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/auth/status") {
      return json(res, 200, { authenticationEnabled: false, authenticated: true, localCompatibilityMode: true });
    }
    if (url.pathname === "/api/customer-service/status" && req.method === "GET") {
      const monitoring = [...runtimes.values()].filter((runtime) => runtime.state === "MONITORING");
      const accountCounts = accounts.reduce((counts, account) => ({
        ...counts,
        [account.status]: Number(counts[account.status] || 0) + 1,
      }), {});
      return json(res, 200, {
        ok: true,
        status: {
          ...status,
          accounts: accountCounts,
          workers: [
            ...status.workers,
            ...monitoring.map((runtime) => ({
              id: runtime.workerId,
              displayName: "本机接入模拟节点",
              status: "ONLINE",
              version: "fixture",
              capabilities: ["observe_messages", "fill_draft"],
              lastHeartbeatAt: new Date().toISOString(),
              lastErrorCode: null,
              online: true,
            })),
          ],
          accountLeases: [
            ...status.accountLeases,
            ...monitoring.map((runtime) => ({
              accountId: runtime.accountId,
              workerId: runtime.workerId,
              status: "ACTIVE",
              leasedUntil: "2099-01-01T00:00:00.000Z",
              createdAt: now,
              updatedAt: new Date().toISOString(),
            })),
          ],
        },
      });
    }
    if (url.pathname === "/api/customer-service/accounts") {
      if (req.method === "GET") return json(res, 200, { ok: true, accounts });
      if (req.method === "POST") {
        const input = await readJson(req);
        createdAccountSequence += 1;
        const account = {
          id: `qa-created-${createdAccountSequence}`,
          channel: "LIAOLIAO",
          displayName: String(input.displayName || `测试账号 ${createdAccountSequence}`),
          status: "SETUP_REQUIRED",
          settings: {
            countryCodes: Array.isArray(input.countryCodes) ? input.countryCodes : [],
            automationMode: "OBSERVE_ONLY",
          },
          lastObservedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rollout: {
            currentMode: "OBSERVE_ONLY",
            stageIndex: 1,
            stageTotal: 3,
            nextMode: "SUGGEST_ONLY",
            canAdvance: false,
            blockers: ["CS_ACCOUNT_ACTIVE_REQUIRED", "CS_ACCOUNT_OBSERVATION_REQUIRED"],
            observedMessageTotal: 0,
            generatedSuggestionTotal: 0,
            reviewedSuggestionTotal: 0,
            requirements: [],
          },
        };
        accounts.push(account);
        return json(res, 201, { ok: true, account });
      }
    }
    const localRuntimeMatch = url.pathname.match(/^\/api\/customer-service\/accounts\/([^/]+)\/local-runtime(?:\/(start|stop|retry))?$/);
    if (localRuntimeMatch) {
      const accountId = decodeURIComponent(localRuntimeMatch[1]);
      const action = localRuntimeMatch[2] || null;
      if (!accounts.some((account) => account.id === accountId)) {
        return json(res, 404, { ok: false, code: "CS_ACCOUNT_NOT_FOUND", error: "Fixture account was not found" });
      }
      if (req.headers["x-commerce-ops-local-action"] !== "1") {
        return json(res, 403, { ok: false, code: "CS_LOCAL_ACTION_CONFIRMATION_REQUIRED", error: "Local action confirmation header is required" });
      }
      if (req.method === "GET" && !action) return json(res, 200, { ok: true, runtime: readRuntime(accountId) });
      if (req.method === "POST" && action) {
        await readJson(req);
        if (action === "stop") {
          transitions.delete(accountId);
          return json(res, 200, { ok: true, runtime: setRuntime(accountId, "STOPPED") });
        }
        return json(res, 202, { ok: true, runtime: startRuntime(accountId) });
      }
      return json(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
    }
    if (url.pathname === "/api/customer-service/inbox") return json(res, 200, { ok: true, conversations: [] });
    if (url.pathname === "/api/customer-service/quality-breakdown") {
      return json(res, 200, {
        ok: true,
        quality: {
          dimension: url.searchParams.get("dimension") || "intent",
          minimumAutoFillConfidence: 0.72,
          rows: [],
        },
      });
    }
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, code: "QA_FIXTURE_WRITE_NOT_SUPPORTED", error: "This fixture write is not supported" });
    }
    return json(res, 404, { ok: false, code: "QA_FIXTURE_ROUTE_NOT_FOUND", error: "Unknown fixture route" });
  });
}

export async function listenCustomerServiceUiFixture({ port = 3198 } = {}) {
  const server = createCustomerServiceUiFixtureServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portArg = process.argv.slice(2).find((item) => item.startsWith("--port="));
  const port = Number(portArg?.slice("--port=".length) || 3198);
  const server = await listenCustomerServiceUiFixture({ port });
  process.stdout.write(`Customer Service UI fixture listening on http://127.0.0.1:${port}\n`);
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
