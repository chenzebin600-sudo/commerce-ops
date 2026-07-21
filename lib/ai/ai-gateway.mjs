import { resolveRequestId } from "../contracts/identifiers.mjs";
import { assertModuleId } from "../contracts/module-ids.mjs";
import { resolveAiRequestPolicy } from "./ai-request-policy.mjs";

const RETRYABLE_CODES = new Set(["AI_TIMEOUT", "AI_RATE_LIMITED", "AI_PROVIDER_ERROR"]);

function wait(delayMs) {
  return delayMs ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

export class AiGateway {
  constructor({ provider, policy = {}, logger = null } = {}) {
    if (!provider || typeof provider.complete !== "function") throw new TypeError("AI provider is required");
    this.provider = provider;
    this.policy = resolveAiRequestPolicy(policy);
    this.logger = logger;
  }

  async complete(input) {
    const moduleId = assertModuleId(input.moduleId);
    const requestId = resolveRequestId(input.requestId);
    const operation = String(input.operation || "completion").slice(0, 80);
    const messages = input.messages || [
      ...(input.systemPrompt ? [{ role: "system", content: input.systemPrompt }] : []),
      { role: "user", content: input.prompt || "" },
    ];
    const startedAt = Date.now();
    let result;
    let attempts = 0;
    do {
      attempts += 1;
      result = await this.provider.complete({
        model: input.model,
        messages,
        temperature: input.temperature,
        responseFormat: input.responseFormat,
        timeoutMs: input.timeoutMs || this.policy.timeoutMs,
        signal: input.signal,
      });
      if (result.success || !RETRYABLE_CODES.has(result.errorCode) || attempts >= this.policy.maxAttempts) break;
      await wait(this.policy.retryDelayMs * attempts);
    } while (attempts < this.policy.maxAttempts);

    const output = {
      success: Boolean(result?.success),
      requestId,
      provider: this.provider.name || "unknown",
      model: input.model,
      content: result?.success ? result.content : null,
      usage: result?.success ? result.usage || null : null,
      durationMs: Date.now() - startedAt,
      errorCode: result?.success ? null : result?.errorCode || "AI_PROVIDER_ERROR",
      errorMessage: result?.success ? null : result?.errorMessage || "AI provider request failed",
    };
    this.logger?.({
      moduleId,
      operation,
      provider: output.provider,
      model: output.model,
      durationMs: output.durationMs,
      success: output.success,
      errorCode: output.errorCode,
      requestId,
    });
    return output;
  }
}

export function aiGatewayError(result) {
  const error = new Error(result?.errorMessage || "AI provider request failed");
  error.code = result?.errorCode || "AI_PROVIDER_ERROR";
  error.requestId = result?.requestId || null;
  return error;
}
