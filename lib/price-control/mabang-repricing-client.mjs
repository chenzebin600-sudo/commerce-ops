import { MABANG_LISTING_INTERNAL_HEADER, resolveMabangListingProxyConfig } from "../mabang-listing-proxy.mjs";

export class MabangRepricingClientError extends Error {
  constructor(code, message, { status = 502, cause = null, outcomeUnknown = false } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "MabangRepricingClientError";
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export class MabangRepricingClient {
  constructor({ baseUrl, internalToken, fetchImpl = globalThis.fetch, timeoutMs = 5 * 60_000 } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!String(internalToken || "").trim()) throw new TypeError("Mabang Listing internal token is required");
    this.baseUrl = resolveMabangListingProxyConfig({ MABANG_LISTING_BASE_URL: baseUrl }).baseUrl;
    this.internalToken = String(internalToken).trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(pathname, { method = "GET", body = null, outcomeUnknown = false } = {}) {
    const headers = new Headers({
      accept: "application/json",
      [MABANG_LISTING_INTERNAL_HEADER]: this.internalToken,
    });
    if (body !== null) headers.set("content-type", "application/json; charset=utf-8");
    let response;
    try {
      response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new MabangRepricingClientError(
        outcomeUnknown ? "MABANG_REPRICING_EXECUTION_OUTCOME_UNKNOWN" : "MABANG_LISTING_UNAVAILABLE",
        outcomeUnknown
          ? "马帮已收到执行请求的结果无法确认，请勿重复提交，需人工核对任务状态。"
          : "马帮刊登本地服务不可用。",
        { status: 503, cause, outcomeUnknown },
      );
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new MabangRepricingClientError(
        outcomeUnknown ? "MABANG_REPRICING_EXECUTION_REJECTED" : "MABANG_LISTING_REQUEST_FAILED",
        String(payload?.message || `马帮刊登请求失败（HTTP ${response.status}）。`).slice(0, 500),
        { status: response.status >= 400 && response.status < 500 ? 409 : 502, outcomeUnknown: false },
      );
    }
    return payload;
  }

  health() { return this.request("/api/health"); }
  async login({ username, password, accountHost = null }) {
    const result = await this.request("/api/session/login", {
      method: "POST",
      body: { username, password, account_host: accountHost || "" },
    });
    return result.session;
  }
  parseInstruction(command) {
    return this.request("/api/ai/parse", { method: "POST", body: { command } });
  }
  createPreview({ command, parsedCommands }) {
    return this.request("/api/ai/preview", {
      method: "POST",
      body: { command, parsed_commands: parsedCommands },
    });
  }
  execute({ previewToken, selectedChangeIds }) {
    return this.request("/api/batch/execute", {
      method: "POST",
      body: { preview_token: previewToken, selected_change_ids: selectedChangeIds },
      outcomeUnknown: true,
    });
  }
  getJob(jobId) {
    return this.request(`/api/jobs/${encodeURIComponent(jobId)}`);
  }
}

export class MabangListingRepricingAdapter {
  constructor({ client, accountBridge }) {
    if (!client || !accountBridge) throw new TypeError("Mabang repricing client and account bridge are required");
    this.client = client;
    this.accountBridge = accountBridge;
    this.provider = "MABANG_LISTING";
    this.preparedAccountId = null;
    this.accountOperationTail = Promise.resolve();
  }

  async prepare(accountId) {
    const resolved = String(accountId || "");
    if (this.preparedAccountId === resolved) return { accountId: resolved, reused: true };
    const connected = await this.accountBridge.connect(resolved);
    this.preparedAccountId = resolved;
    return connected;
  }
  async withAccount(accountId, operation) {
    if (typeof operation !== "function") throw new TypeError("Account operation must be a function");
    const previous = this.accountOperationTail;
    let release;
    this.accountOperationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await this.prepare(accountId);
      return await operation();
    } finally {
      release();
    }
  }
  parseInstruction(instructionText) { return this.client.parseInstruction(instructionText); }
  createPreview(instructionText, parsedCommands) {
    return this.client.createPreview({ command: instructionText, parsedCommands });
  }
  execute(previewToken, selectedChangeIds) {
    return this.client.execute({ previewToken, selectedChangeIds });
  }
  getJob(jobId) { return this.client.getJob(jobId); }
}
