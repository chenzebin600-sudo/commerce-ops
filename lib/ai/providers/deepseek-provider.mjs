const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export function resolveDeepSeekEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEEPSEEK_ENDPOINT;
  const url = new URL(raw);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new TypeError("DEEPSEEK_BASE_URL must use HTTP or HTTPS");
  if (!url.pathname || url.pathname === "/") url.pathname = "/chat/completions";
  return url.toString();
}

function redact(value, secret) {
  const text = String(value || "AI provider request failed").split(/\r?\n/)[0].slice(0, 300);
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

function errorCodeForStatus(status) {
  if (status === 429) return "AI_RATE_LIMITED";
  return "AI_PROVIDER_ERROR";
}

export class DeepSeekProvider {
  constructor({ apiKey, fetchImpl = globalThis.fetch, endpoint = DEEPSEEK_ENDPOINT } = {}) {
    this.name = "deepseek";
    this.apiKey = String(apiKey || "");
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
  }

  async complete({ model, messages, temperature, responseFormat, timeoutMs, signal }) {
    if (!this.apiKey) {
      return { success: false, errorCode: "AI_NOT_CONFIGURED", errorMessage: "DeepSeek API Key is not configured" };
    }
    if (typeof this.fetchImpl !== "function") throw new TypeError("AI provider fetch implementation is required");

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const body = { model, stream: false, messages };
      if (temperature !== undefined) body.temperature = temperature;
      if (responseFormat !== undefined) body.response_format = responseFormat;
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      if (!response.ok) {
        const detail = data?.error?.message || raw.slice(0, 240) || `HTTP ${response.status}`;
        return { success: false, errorCode: errorCodeForStatus(response.status), errorMessage: redact(detail, this.apiKey) };
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return { success: false, errorCode: "AI_INVALID_RESPONSE", errorMessage: "DeepSeek returned an invalid response" };
      }
      return { success: true, content, usage: data?.usage || null };
    } catch (error) {
      if (error?.name === "AbortError") {
        return timedOut
          ? { success: false, errorCode: "AI_TIMEOUT", errorMessage: "DeepSeek request timed out" }
          : { success: false, errorCode: "AI_CANCELLED", errorMessage: "DeepSeek request was cancelled" };
      }
      return { success: false, errorCode: "AI_PROVIDER_ERROR", errorMessage: redact(error, this.apiKey) };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abortFromCaller);
    }
  }
}
