import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createCustomerServiceApi } from "../lib/customer-service/customer-service-api.mjs";
import {
  createCustomerServiceLocalRuntimeManager,
} from "../lib/customer-service/customer-service-local-runtime-manager.mjs";
import { describeAuditRequest } from "../lib/security/audit-http.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const integrationDir = path.join(projectRoot, "integrations", "liaoliao-ai-assistant");
const workerToken = "customer-service-worker-token-value";

class FakeChild extends EventEmitter {
  constructor({ exitOnKill = true } = {}) {
    super();
    this.exitCode = null;
    this.killed = false;
    this.signals = [];
    this.exitOnKill = exitOnKill;
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.signals.push(signal);
    if (this.exitOnKill && this.exitCode === null) this.exit(0);
    return true;
  }

  exit(code) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function accountRuntimeDir(storageRoot, accountId) {
  const digest = createHash("sha256").update(accountId, "utf8").digest("hex");
  return path.join(storageRoot, "integrations", "liaoliao-ai-assistant", "accounts", digest);
}

function seedSession(storageRoot, accountId) {
  const sessionPath = path.join(accountRuntimeDir(storageRoot, accountId), "browser", "storage-state.json");
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, "{}", "utf8");
  return sessionPath;
}

function runtimeFixture(t, options = {}) {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-cs-runtime-"));
  t.after(() => rmSync(storageRoot, { recursive: true, force: true }));
  const spawns = [];
  const children = [];
  const audits = [];
  const spawnImpl = options.spawnImpl || ((executable, args, spawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    spawns.push({ executable, args, options: spawnOptions, child });
    return child;
  });
  const manager = createCustomerServiceLocalRuntimeManager({
    integrationDir,
    storageRoot,
    pythonExecutable: "python",
    centralApiUrl: "http://127.0.0.1:3101",
    workerToken,
    maxMonitors: options.maxMonitors,
    loginTimeoutMs: options.loginTimeoutMs || 60_000,
    stopGraceMs: options.stopGraceMs || 5,
    env: {
      PATH: process.env.PATH || "test-path",
      APP_ENCRYPTION_KEY: "must-not-reach-child",
      POSTGRES_PASSWORD: "must-not-reach-child",
      LIAOLIAO_ACCOUNT: "must-not-reach-child",
      LIAOLIAO_PASSWORD: "must-not-reach-child",
      DEEPSEEK_API_KEY: "must-not-reach-child",
      HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.invalid",
    },
    audit: {
      recordSafely(input) {
        audits.push(input);
        return null;
      },
    },
    spawnImpl,
  });
  return { manager, storageRoot, spawns, children, audits };
}

test("local runtime launches fixed login then assist with isolated paths and a scrubbed environment", async (t) => {
  const fixture = runtimeFixture(t);
  const accountId = "account-th-01";
  const started = await fixture.manager.start(accountId, { requestId: "request-1" });

  assert.equal(started.started, true);
  assert.equal(started.runtime.state, "WAITING_FOR_LOGIN");
  assert.equal(started.runtime.status, "WAITING_FOR_LOGIN");
  assert.equal(started.runtime.monitoring, false);
  assert.equal(fixture.spawns.length, 1);
  const login = fixture.spawns[0];
  assert.equal(login.executable, "python");
  assert.deepEqual(login.args, ["-m", "app.cli", "login"]);
  assert.equal(login.options.cwd, integrationDir);
  assert.equal(login.options.shell, false);
  assert.equal(login.options.detached, false);
  assert.equal(login.options.windowsHide, true);
  assert.equal(login.options.stdio, "ignore");
  assert.equal(login.options.env.LIAOLIAO_ACCOUNT, "");
  assert.equal(login.options.env.LIAOLIAO_PASSWORD, "");
  assert.equal(login.options.env.LIAOLIAO_LLM_API_KEY, "");
  assert.equal(login.options.env.DEEPSEEK_API_KEY, "");
  assert.equal(login.options.env.LIAOLIAO_HUMAN_SEND_ENABLED, "false");
  assert.equal(login.options.env.LIAOLIAO_BROWSER_CHANNEL, "chrome");
  assert.equal(login.options.env.LIAOLIAO_SKIP_ROOT_ENV, "true");
  assert.equal(login.options.env.LIAOLIAO_LOGIN_TIMEOUT_SECONDS, "60");
  assert.equal(login.options.env.CUSTOMER_SERVICE_WORKER_TOKEN, workerToken);
  assert.equal("APP_ENCRYPTION_KEY" in login.options.env, false);
  assert.equal("POSTGRES_PASSWORD" in login.options.env, false);
  assert.equal("HTTPS_PROXY" in login.options.env, false);
  assert.equal(path.isAbsolute(login.options.env.LIAOLIAO_SESSION_PATH), true);
  assert.equal(
    path.relative(fixture.storageRoot, login.options.env.LIAOLIAO_SESSION_PATH).startsWith(".."),
    false,
  );
  assert.equal(JSON.stringify(started).includes(fixture.storageRoot), false);
  assert.equal(JSON.stringify(started).includes(workerToken), false);

  writeFileSync(login.options.env.LIAOLIAO_SESSION_PATH, "{}", "utf8");
  login.child.exit(0);
  assert.equal(fixture.spawns.length, 2);
  assert.deepEqual(fixture.spawns[1].args, ["-m", "app.cli", "assist"]);
  assert.equal(fixture.manager.status(accountId).state, "MONITORING");
  assert.equal(fixture.manager.status(accountId).monitoring, true);
  assert.equal(fixture.manager.status(accountId).workerOnline, false);
  assert.equal(fixture.manager.status(accountId).leaseActive, false);

  const stopped = await fixture.manager.stop(accountId);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.runtime.state, "STOPPED");
  assert.equal(stopped.runtime.sessionReady, true);
  assert.equal(fixture.spawns[1].child.signals[0], "SIGTERM");
  assert.equal(JSON.stringify(fixture.audits).includes(workerToken), false);
  assert.ok(fixture.audits.some((item) => item.action === "customer_service.local_runtime.login_succeeded"));
  assert.ok(fixture.audits.some((item) => item.action === "customer_service.local_runtime.monitor_started"));
});

test("an existing account Session skips login, while an assist failure requires retry through login", async (t) => {
  const fixture = runtimeFixture(t);
  const accountId = "account-with-session";
  seedSession(fixture.storageRoot, accountId);

  await fixture.manager.start(accountId);
  assert.deepEqual(fixture.spawns[0].args, ["-m", "app.cli", "assist"]);
  assert.equal(fixture.manager.status(accountId).state, "MONITORING");
  fixture.spawns[0].child.exit(1);
  assert.equal(fixture.manager.status(accountId).state, "FAILED");
  assert.equal(fixture.manager.status(accountId).errorCode, "CS_LOCAL_MONITOR_EXITED");
  assert.equal(fixture.manager.status(accountId).retryable, true);

  await assert.rejects(
    fixture.manager.start(accountId),
    (error) => error.code === "CS_LOCAL_RETRY_REQUIRED",
  );
  await fixture.manager.retry(accountId);
  assert.deepEqual(fixture.spawns[1].args, ["-m", "app.cli", "login"]);
  assert.equal(fixture.manager.status(accountId).state, "WAITING_FOR_LOGIN");
  await fixture.manager.stopAll();
});

test("only one visible login is allowed globally while account monitors remain capacity bounded", async (t) => {
  const fixture = runtimeFixture(t, { maxMonitors: 1 });
  await fixture.manager.start("login-account-a");
  await assert.rejects(
    fixture.manager.start("login-account-b"),
    (error) => error.code === "CS_LOCAL_LOGIN_BUSY" && error.status === 409,
  );
  assert.equal(fixture.spawns.length, 1);
  await fixture.manager.stop("login-account-a");

  seedSession(fixture.storageRoot, "monitor-account-a");
  seedSession(fixture.storageRoot, "monitor-account-b");
  await fixture.manager.start("monitor-account-a");
  await assert.rejects(
    fixture.manager.start("monitor-account-b"),
    (error) => error.code === "CS_LOCAL_MONITOR_CAPACITY_REACHED" && error.status === 409,
  );
  assert.equal(fixture.manager.status("monitor-account-a").state, "MONITORING");
  assert.equal(fixture.manager.status("monitor-account-b").state, "FAILED");
  assert.equal(fixture.manager.maxMonitors, 1);
  await fixture.manager.stopAll();
});

test("stale child events cannot overwrite a newer retry generation and shutdown stops every owned child", async (t) => {
  const spawns = [];
  const children = [];
  const fixture = runtimeFixture(t, {
    stopGraceMs: 1,
    spawnImpl(executable, args, options) {
      const child = new FakeChild({ exitOnKill: false });
      children.push(child);
      spawns.push({ executable, args, options, child });
      return child;
    },
  });
  fixture.spawns = spawns;
  fixture.children = children;
  const accountId = "generation-account";
  await fixture.manager.start(accountId);
  const oldChild = children[0];
  await fixture.manager.stop(accountId);
  assert.equal(fixture.manager.status(accountId).state, "STOPPED");
  await fixture.manager.retry(accountId);
  assert.equal(fixture.manager.status(accountId).state, "WAITING_FOR_LOGIN");
  oldChild.exit(1);
  assert.equal(fixture.manager.status(accountId).state, "WAITING_FOR_LOGIN");

  const stoppedCount = await fixture.manager.stopAll();
  assert.equal(stoppedCount, 1);
  assert.equal(fixture.manager.status(accountId).state, "STOPPED");
  await assert.rejects(
    fixture.manager.retry(accountId),
    (error) => error.code === "CS_LOCAL_RUNTIME_SHUTTING_DOWN",
  );
});

function apiRequest(method, body = null, {
  remoteAddress = "127.0.0.1",
  localAction = "1",
} = {}) {
  const request = Readable.from(body === null ? [] : [Buffer.from(body, "utf8")]);
  request.method = method;
  request.socket = { remoteAddress };
  request.headers = {
    ...(localAction === null ? {} : { "x-commerce-ops-local-action": localAction }),
    ...(body === null ? {} : { "content-type": "application/json" }),
  };
  return request;
}

function apiResponse() {
  const result = { status: null, headers: null, body: null };
  return {
    result,
    response: {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(body) {
        result.body = body ? JSON.parse(String(body)) : null;
      },
    },
  };
}

function apiFixture({ ready = true, channel = "LIAOLIAO" } = {}) {
  const calls = [];
  const runtime = {
    accountId: "account-1",
    status: "WAITING_FOR_LOGIN",
    state: "WAITING_FOR_LOGIN",
    sessionReady: false,
  };
  const localRuntimeManager = {
    status(accountId) {
      calls.push(["status", accountId]);
      return { ...runtime, accountId };
    },
    async start(accountId, context) {
      calls.push(["start", accountId, context]);
      return { started: true, runtime: { ...runtime, accountId } };
    },
    async stop(accountId) {
      calls.push(["stop", accountId]);
      return { stopped: true, runtime: { ...runtime, accountId, status: "STOPPED", state: "STOPPED" } };
    },
    async retry(accountId, context) {
      calls.push(["retry", accountId, context]);
      return { started: true, runtime: { ...runtime, accountId } };
    },
  };
  const service = {
    async status() { return { ready }; },
    async listAccounts() {
      return [{ id: "account-1", channel }];
    },
  };
  return {
    calls,
    handler: createCustomerServiceApi({ service, localRuntimeManager }),
  };
}

async function callApi(handler, method, pathname, body = null, requestOptions = {}) {
  const req = apiRequest(method, body, requestOptions);
  req.auditContext = {
    requestId: "request-local-runtime",
    annotations: [],
    annotate(value) { this.annotations.push(value); },
  };
  const { result, response } = apiResponse();
  const handled = await handler(req, response, new URL(`http://127.0.0.1${pathname}`));
  return { handled, result, req };
}

test("local runtime API enforces loopback, explicit local action and an empty secret-free body", async () => {
  const fixture = apiFixture();
  const route = "/api/customer-service/accounts/account-1/local-runtime/start";

  const remote = await callApi(fixture.handler, "POST", route, "{}", {
    remoteAddress: "192.168.1.20",
  });
  assert.equal(remote.result.status, 403);
  assert.equal(remote.result.body.code, "CS_LOCAL_RUNTIME_LOOPBACK_REQUIRED");

  const missingAction = await callApi(fixture.handler, "POST", route, "{}", {
    localAction: null,
  });
  assert.equal(missingAction.result.status, 403);
  assert.equal(missingAction.result.body.code, "CS_LOCAL_ACTION_REQUIRED");

  for (const body of [
    { password: "do-not-accept" },
    { sessionPath: "C:/outside/session.json" },
    { command: "serve", args: ["--port", "80"] },
  ]) {
    const forbidden = await callApi(fixture.handler, "POST", route, JSON.stringify(body));
    assert.equal(forbidden.result.status, 400);
    assert.equal(forbidden.result.body.code, "CS_LOCAL_SECRET_INPUT_FORBIDDEN");
  }
  const unknown = await callApi(fixture.handler, "POST", route, JSON.stringify({ force: true }));
  assert.equal(unknown.result.status, 400);
  assert.equal(unknown.result.body.code, "CS_LOCAL_REQUEST_BODY_NOT_EMPTY");
  assert.equal(fixture.calls.length, 0);

  const accepted = await callApi(fixture.handler, "POST", route, "{}");
  assert.equal(accepted.result.status, 202);
  assert.equal(accepted.result.body.runtime.status, "WAITING_FOR_LOGIN");
  assert.equal(fixture.calls[0][0], "start");
  assert.equal(fixture.calls[0][2].requestId, "request-local-runtime");
});

test("local runtime API exposes GET, stop and retry only for a ready LiaoLiao account", async () => {
  const fixture = apiFixture();
  const base = "/api/customer-service/accounts/account-1/local-runtime";
  assert.equal((await callApi(fixture.handler, "GET", base)).result.status, 200);
  assert.equal((await callApi(fixture.handler, "POST", `${base}/stop`, "{}")).result.status, 200);
  assert.equal((await callApi(fixture.handler, "POST", `${base}/retry`, "{}")).result.status, 202);
  assert.deepEqual(fixture.calls.map((call) => call[0]), ["status", "stop", "retry"]);

  const schemaMissing = apiFixture({ ready: false });
  const notReady = await callApi(schemaMissing.handler, "GET", base);
  assert.equal(notReady.result.status, 503);
  assert.equal(notReady.result.body.code, "CS_SCHEMA_NOT_READY");

  const wrongChannel = apiFixture({ channel: "EMAIL" });
  const unsupported = await callApi(wrongChannel.handler, "GET", base);
  assert.equal(unsupported.result.status, 409);
  assert.equal(unsupported.result.body.code, "CS_LOCAL_RUNTIME_CHANNEL_UNSUPPORTED");
});

test("local runtime HTTP actions are described for audit and worker tokens are redacted", async () => {
  assert.deepEqual(
    describeAuditRequest(
      "POST",
      "/api/customer-service/accounts/account-1/local-runtime/start",
    ),
    {
      module: "customer_service",
      action: "customer_service.local_runtime.start_requested",
    },
  );
  assert.equal(
    describeAuditRequest("GET", "/api/customer-service/accounts/account-1/local-runtime"),
    null,
  );

  const created = [];
  const audit = createOperationAuditService({
    repository: {
      create(input) {
        created.push(input);
        return input;
      },
    },
    env: { CUSTOMER_SERVICE_WORKER_TOKEN: workerToken },
  });
  await audit.recordSafely({
    module: "customer_service",
    action: "customer_service.local_runtime.failed",
    status: "failed",
    errorSummary: `worker token=${workerToken}`,
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].errorSummary.includes(workerToken), false);
  assert.match(created[0].errorSummary, /\[REDACTED\]/);
});

test("local runtime fails closed for unsafe or incomplete server configuration", async (t) => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-cs-config-"));
  t.after(() => rmSync(storageRoot, { recursive: true, force: true }));

  assert.throws(
    () => createCustomerServiceLocalRuntimeManager({
      integrationDir,
      storageRoot,
      pythonExecutable: "python",
      centralApiUrl: "https://commerce-ops.example.com",
      workerToken,
    }),
    /loopback central API URL/,
  );

  const manager = createCustomerServiceLocalRuntimeManager({
    integrationDir,
    storageRoot,
    pythonExecutable: "python",
    centralApiUrl: "http://127.0.0.1:3101",
    workerToken: "",
  });
  const status = manager.status("account-unconfigured");
  assert.equal(status.available, false);
  assert.equal(status.status, "FAILED");
  assert.equal(status.errorCode, "CS_LOCAL_RUNTIME_WORKER_AUTH_NOT_CONFIGURED");
  assert.equal(status.retryable, false);
  await assert.rejects(
    manager.start("account-unconfigured"),
    (error) => error.code === "CS_LOCAL_RUNTIME_WORKER_AUTH_NOT_CONFIGURED" && error.status === 503,
  );
});

test("server keeps ordinary local-runtime actions behind app auth and stops them during shutdown", () => {
  const source = readFileSync(path.join(projectRoot, "server.mjs"), "utf8");
  assert.match(source, /const customerServiceWorkerToken = await resolveCustomerServiceWorkerToken/);
  assert.match(source, /token: customerServiceWorkerToken/);
  assert.match(source, /workerToken: customerServiceWorkerToken/);
  const workerApi = source.indexOf("await handleCustomerServiceWorkerApi(req, res, url)");
  const appAuth = source.indexOf("protectedApiAccessResponse(req.headers, accessPolicy)");
  const ordinaryApi = source.indexOf("await handleCustomerServiceApi(req, res, url)");
  assert.ok(workerApi >= 0 && appAuth > workerApi && ordinaryApi > appAuth);

  const shutdown = source.indexOf("async function shutdown()");
  const runtimeStop = source.indexOf("await customerServiceLocalRuntimeManager.stopAll()", shutdown);
  const dataClose = source.indexOf("await dataAccess.close()", shutdown);
  assert.ok(shutdown >= 0 && runtimeStop > shutdown && dataClose > runtimeStop);
});
