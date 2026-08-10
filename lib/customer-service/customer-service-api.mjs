import { isLoopbackBindHost } from "../app-access.mjs";

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
  return true;
}

async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large");
      error.code = "CS_REQUEST_TOO_LARGE";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
    return value;
  } catch (error) {
    if (error.code === "CS_REQUEST_TOO_LARGE") throw error;
    const invalid = new Error("Request body must be a JSON object");
    invalid.code = "CS_REQUEST_JSON_INVALID";
    invalid.status = 400;
    throw invalid;
  }
}

function methodNotAllowed(res) {
  return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
}

function errorResponse(res, error) {
  const known = String(error?.code || "").startsWith("CS_");
  return sendJson(res, Number(error?.status || (known ? 400 : 500)), {
    ok: false,
    code: known ? error.code : "CS_INTERNAL_ERROR",
    error: known ? error.message : "Customer-service request failed",
  });
}

function workerLeaseHeaders(req) {
  return {
    accountId: String(req.headers?.["x-cs-account-id"] || "").trim().slice(0, 120),
    leaseToken: String(req.headers?.["x-cs-account-lease"] || "").trim().slice(0, 500),
  };
}

const LOCAL_RUNTIME_FORBIDDEN_FIELDS = new Set([
  "account",
  "args",
  "command",
  "cookie",
  "envfile",
  "executable",
  "password",
  "pythonexecutable",
  "runtimeroot",
  "sessionpath",
  "storagestate",
  "token",
  "username",
  "workertoken",
]);

function localRuntimeError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const value = headers[name] ?? headers[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] || "" : value || "");
}

function assertLocalRuntimeRequest(req) {
  if (!isLoopbackBindHost(req.socket?.remoteAddress)) {
    throw localRuntimeError(
      "CS_LOCAL_RUNTIME_LOOPBACK_REQUIRED",
      "LiaoLiao local runtime can only be controlled from this computer",
      403,
    );
  }
  if (headerValue(req.headers, "x-commerce-ops-local-action").trim() !== "1") {
    throw localRuntimeError(
      "CS_LOCAL_ACTION_REQUIRED",
      "LiaoLiao local runtime requires an explicit same-origin local action",
      403,
    );
  }
}

async function readEmptyLocalRuntimeBody(req) {
  const body = await readJson(req, 4 * 1024);
  const keys = Object.keys(body);
  const forbidden = keys.find((key) => (
    LOCAL_RUNTIME_FORBIDDEN_FIELDS.has(String(key).replace(/[-_]/g, "").toLowerCase())
  ));
  if (forbidden) {
    throw localRuntimeError(
      "CS_LOCAL_SECRET_INPUT_FORBIDDEN",
      "Passwords, credentials, paths and process commands are never accepted by this endpoint",
    );
  }
  if (keys.length) {
    throw localRuntimeError(
      "CS_LOCAL_REQUEST_BODY_NOT_EMPTY",
      "LiaoLiao local runtime actions require an empty JSON object",
    );
  }
}

async function requireLocalRuntimeAccount(service, accountId) {
  const moduleStatus = await service.status();
  if (moduleStatus?.ready !== true) {
    throw localRuntimeError(
      "CS_SCHEMA_NOT_READY",
      "Customer-service database migration is not applied",
      503,
    );
  }
  const account = (await service.listAccounts()).find((item) => item.id === accountId);
  if (!account) {
    throw localRuntimeError("CS_ACCOUNT_NOT_FOUND", "Channel account was not found", 404);
  }
  if (String(account.channel || "").toUpperCase() !== "LIAOLIAO") {
    throw localRuntimeError(
      "CS_LOCAL_RUNTIME_CHANNEL_UNSUPPORTED",
      "Only LiaoLiao accounts can use the local browser runtime",
      409,
    );
  }
  return account;
}

export function createCustomerServiceWorkerApi({ service, auth }) {
  if (!service || !auth) throw new TypeError("Customer-service worker API dependencies are required");
  return async function handleCustomerServiceWorkerApi(req, res, url) {
    const prefix = "/api/internal/customer-service";
    if (!url.pathname.startsWith(prefix)) return false;
    const authorization = auth.authenticate(req.headers);
    if (!authorization.ok) {
      return sendJson(res, authorization.status, {
        ok: false,
        code: authorization.code,
        error: authorization.error,
      });
    }
    try {
      if (url.pathname === `${prefix}/workers/register`) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const worker = await service.registerWorker(authorization.workerId, await readJson(req));
        return sendJson(res, 200, { ok: true, worker });
      }
      if (url.pathname === `${prefix}/workers/heartbeat`) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const worker = await service.heartbeatWorker(authorization.workerId, await readJson(req));
        return sendJson(res, 200, { ok: true, worker });
      }
      const accountLeaseMatch = url.pathname.match(/^\/api\/internal\/customer-service\/accounts\/([^/]+)\/lease$/);
      if (accountLeaseMatch) {
        const accountId = decodeURIComponent(accountLeaseMatch[1]);
        if (req.method === "POST") {
          const lease = await service.acquireAccountLease(
            authorization.workerId,
            accountId,
            await readJson(req),
          );
          return sendJson(res, 200, { ok: true, lease });
        }
        if (req.method === "DELETE") {
          const { accountId: headerAccountId, leaseToken } = workerLeaseHeaders(req);
          if (headerAccountId !== accountId) {
            return sendJson(res, 403, { ok: false, code: "CS_ACCOUNT_LEASE_SCOPE_MISMATCH", error: "Account lease header does not match the route" });
          }
          const released = await service.releaseAccountLease(authorization.workerId, accountId, leaseToken);
          return sendJson(res, released ? 200 : 409, {
            ok: released,
            released,
            ...(released ? {} : { code: "CS_ACCOUNT_LEASE_INVALID", error: "Account lease is no longer active" }),
          });
        }
        return methodNotAllowed(res);
      }
      if (url.pathname === `${prefix}/events/batch`) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const lease = workerLeaseHeaders(req);
        await service.assertAccountLease(authorization.workerId, lease.accountId, lease.leaseToken);
        const result = await service.ingestBatch(
          authorization.workerId,
          await readJson(req),
          { accountId: lease.accountId },
        );
        return sendJson(res, result.rejected ? 207 : 200, { ok: result.rejected === 0, ...result });
      }
      if (url.pathname === `${prefix}/commands/pull`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        const lease = workerLeaseHeaders(req);
        await service.assertAccountLease(authorization.workerId, lease.accountId, lease.leaseToken);
        const commands = await service.pullCommands(authorization.workerId, {
          accountId: lease.accountId,
          limit: url.searchParams.get("limit"),
        });
        return sendJson(res, 200, { ok: true, commands });
      }
      const commandMatch = url.pathname.match(/^\/api\/internal\/customer-service\/commands\/([^/]+)\/result$/);
      if (commandMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const lease = workerLeaseHeaders(req);
        await service.assertAccountLease(authorization.workerId, lease.accountId, lease.leaseToken);
        const command = await service.completeCommand(
          authorization.workerId,
          lease.accountId,
          decodeURIComponent(commandMatch[1]),
          await readJson(req),
        );
        if (!command) return sendJson(res, 404, { ok: false, code: "CS_COMMAND_NOT_FOUND", error: "Command was not found or is no longer leased" });
        return sendJson(res, 200, { ok: true, command });
      }
      return sendJson(res, 404, { ok: false, code: "CS_WORKER_ROUTE_NOT_FOUND", error: "Worker route was not found" });
    } catch (error) {
      return errorResponse(res, error);
    }
  };
}

export function createCustomerServiceApi({ service, contextService = null, localRuntimeManager = null }) {
  if (!service) throw new TypeError("Customer-service API service is required");
  return async function handleCustomerServiceApi(req, res, url) {
    const prefix = "/api/customer-service";
    if (!url.pathname.startsWith(prefix)) return false;
    try {
      if (url.pathname === `${prefix}/status`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        return sendJson(res, 200, { ok: true, status: await service.status() });
      }
      if (url.pathname === `${prefix}/quality-breakdown`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        const quality = await service.qualityBreakdown({
          dimension: url.searchParams.get("dimension"),
          accountId: url.searchParams.get("account_id"),
          limit: url.searchParams.get("limit"),
        });
        return sendJson(res, 200, { ok: true, quality });
      }
      if (url.pathname === `${prefix}/accounts`) {
        if (req.method === "GET") return sendJson(res, 200, { ok: true, accounts: await service.listAccounts() });
        if (req.method === "POST") {
          const account = await service.createAccount(await readJson(req));
          return sendJson(res, 201, { ok: true, account });
        }
        return methodNotAllowed(res);
      }
      const localRuntimeMatch = url.pathname.match(
        /^\/api\/customer-service\/accounts\/([^/]+)\/local-runtime(?:\/(start|stop|retry))?$/,
      );
      if (localRuntimeMatch) {
        assertLocalRuntimeRequest(req);
        if (!localRuntimeManager) {
          throw localRuntimeError(
            "CS_LOCAL_RUNTIME_NOT_CONFIGURED",
            "LiaoLiao local runtime is not configured",
            503,
          );
        }
        const accountId = decodeURIComponent(localRuntimeMatch[1]);
        await requireLocalRuntimeAccount(service, accountId);
        const action = localRuntimeMatch[2] || null;
        req.auditContext?.annotate({ metadata: { accountId } });
        if (!action) {
          if (req.method !== "GET") return methodNotAllowed(res);
          return sendJson(res, 200, { ok: true, runtime: localRuntimeManager.status(accountId) });
        }
        if (req.method !== "POST") return methodNotAllowed(res);
        await readEmptyLocalRuntimeBody(req);
        if (action === "start") {
          const result = await localRuntimeManager.start(accountId, {
            requestId: req.auditContext?.requestId || null,
          });
          return sendJson(res, result.started ? 202 : 200, { ok: true, ...result });
        }
        if (action === "retry") {
          const result = await localRuntimeManager.retry(accountId, {
            requestId: req.auditContext?.requestId || null,
          });
          return sendJson(res, result.started ? 202 : 200, { ok: true, ...result });
        }
        const result = await localRuntimeManager.stop(accountId);
        return sendJson(res, 200, { ok: true, ...result });
      }
      const accountAutomationMatch = url.pathname.match(/^\/api\/customer-service\/accounts\/([^/]+)\/automation$/);
      if (accountAutomationMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const actorId = String(req.headers?.["x-user-id"] || "local-user").trim().slice(0, 120);
        const account = await service.updateAccountAutomation(
          decodeURIComponent(accountAutomationMatch[1]),
          await readJson(req),
          actorId,
        );
        if (!account) return sendJson(res, 404, { ok: false, code: "CS_ACCOUNT_NOT_FOUND", error: "Channel account was not found" });
        req.auditContext?.annotate({ metadata: {
          operation: "customer_service_account_automation_update",
          accountId: account.id,
          automationMode: account.settings?.automationMode || "OBSERVE_ONLY",
        } });
        return sendJson(res, 200, { ok: true, account });
      }
      if (url.pathname === `${prefix}/inbox`) {
        if (req.method !== "GET") return methodNotAllowed(res);
        const conversations = await service.listInbox({
          accountId: url.searchParams.get("account_id"),
          status: url.searchParams.get("status"),
          limit: url.searchParams.get("limit"),
        });
        return sendJson(res, 200, { ok: true, conversations });
      }
      const shopBindingMatch = url.pathname.match(/^\/api\/customer-service\/shop-bindings\/([^/]+)\/confirm$/);
      if (shopBindingMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const body = await readJson(req);
        const actorId = String(req.headers?.["x-user-id"] || "local-user").trim().slice(0, 120);
        const binding = await service.confirmShopBinding(
          decodeURIComponent(shopBindingMatch[1]),
          body.commerceShopId,
          actorId,
        );
        if (!binding) return sendJson(res, 404, { ok: false, code: "CS_SHOP_BINDING_NOT_FOUND", error: "Shop binding was not found" });
        req.auditContext?.annotate({ metadata: {
          operation: "customer_service_shop_binding_confirm",
          shopBindingId: binding.id,
          commerceShopId: binding.commerceShopId,
        } });
        return sendJson(res, 200, { ok: true, binding });
      }
      const contextMatch = url.pathname.match(/^\/api\/customer-service\/conversations\/([^/]+)\/context\/rebuild$/);
      if (contextMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        if (!contextService) {
          return sendJson(res, 503, {
            ok: false,
            code: "CS_CONTEXT_SERVICE_NOT_CONFIGURED",
            error: "Customer-service Context service is not configured",
          });
        }
        const result = await contextService.build(decodeURIComponent(contextMatch[1]));
        if (!result) return sendJson(res, 404, { ok: false, code: "CS_CONVERSATION_NOT_FOUND", error: "Conversation was not found" });
        req.auditContext?.annotate({
          metadata: {
            operation: "customer_service_context_rebuild",
            conversationId: decodeURIComponent(contextMatch[1]),
            contextSnapshotId: result.snapshot?.id || null,
          },
        });
        return sendJson(res, 200, { ok: true, ...result });
      }
      const contextReadMatch = url.pathname.match(/^\/api\/customer-service\/conversations\/([^/]+)\/context$/);
      if (contextReadMatch) {
        if (req.method !== "GET") return methodNotAllowed(res);
        if (!contextService) {
          return sendJson(res, 503, { ok: false, code: "CS_CONTEXT_SERVICE_NOT_CONFIGURED", error: "Customer-service Context service is not configured" });
        }
        const result = await contextService.latest(decodeURIComponent(contextReadMatch[1]));
        if (!result) return sendJson(res, 404, { ok: false, code: "CS_CONTEXT_SNAPSHOT_NOT_FOUND", error: "Context snapshot was not found" });
        return sendJson(res, 200, { ok: true, ...result });
      }
      const replyMatch = url.pathname.match(/^\/api\/customer-service\/conversations\/([^/]+)\/reply\/queue$/);
      if (replyMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const actorId = String(req.headers?.["x-user-id"] || "local-user").trim().slice(0, 120);
        const suggestion = await service.queueReply(decodeURIComponent(replyMatch[1]), actorId);
        if (!suggestion) return sendJson(res, 404, { ok: false, code: "CS_CONVERSATION_NOT_FOUND", error: "Conversation was not found" });
        req.auditContext?.annotate({ metadata: { operation: "customer_service_reply_queue", conversationId: decodeURIComponent(replyMatch[1]), suggestionId: suggestion.id } });
        return sendJson(res, suggestion.duplicate ? 200 : 202, { ok: true, suggestion });
      }
      const suggestionReviewMatch = url.pathname.match(/^\/api\/customer-service\/suggestions\/([^/]+)\/review$/);
      if (suggestionReviewMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const actorId = String(req.headers?.["x-user-id"] || "local-user").trim().slice(0, 120);
        const review = await service.reviewSuggestion(
          decodeURIComponent(suggestionReviewMatch[1]),
          await readJson(req),
          actorId,
        );
        if (!review) return sendJson(res, 404, { ok: false, code: "CS_SUGGESTION_NOT_FOUND", error: "Suggestion was not found" });
        req.auditContext?.annotate({ metadata: {
          operation: "customer_service_suggestion_review",
          suggestionId: review.id,
          reviewId: review.reviewId,
          status: review.status,
          commandCreated: review.commandCreated,
        } });
        return sendJson(res, review.commandCreated ? 202 : 200, { ok: true, review });
      }
      const conversationMatch = url.pathname.match(/^\/api\/customer-service\/conversations\/([^/]+)$/);
      if (conversationMatch) {
        if (req.method !== "GET") return methodNotAllowed(res);
        const result = await service.getConversation(decodeURIComponent(conversationMatch[1]));
        if (!result) return sendJson(res, 404, { ok: false, code: "CS_CONVERSATION_NOT_FOUND", error: "Conversation was not found" });
        return sendJson(res, 200, { ok: true, ...result });
      }
      const handledMatch = url.pathname.match(/^\/api\/customer-service\/conversations\/([^/]+)\/handled$/);
      if (handledMatch) {
        if (req.method !== "POST") return methodNotAllowed(res);
        const actorId = String(req.headers?.["x-user-id"] || "local-user").trim().slice(0, 120);
        const conversation = await service.markHandled(decodeURIComponent(handledMatch[1]), actorId);
        if (!conversation) return sendJson(res, 404, { ok: false, code: "CS_CONVERSATION_NOT_FOUND", error: "Conversation was not found" });
        req.auditContext?.annotate({ metadata: { operation: "customer_service_mark_handled", conversationId: conversation.id } });
        return sendJson(res, 200, { ok: true, conversation });
      }
      return sendJson(res, 404, { ok: false, code: "CS_ROUTE_NOT_FOUND", error: "Customer-service route was not found" });
    } catch (error) {
      req.auditContext?.annotate({
        errorStage: "customer_service_api",
        errorCode: error?.code || "CS_INTERNAL_ERROR",
        errorSummary: error,
      });
      return errorResponse(res, error);
    }
  };
}
