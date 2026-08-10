import { createHash } from "node:crypto";
import { resolveRequestId } from "../contracts/identifiers.mjs";
import { assertModuleId } from "../contracts/module-ids.mjs";
import { assertAgentReference } from "./agent/agent-contracts.mjs";
import { resolveAiRequestPolicy } from "./ai-request-policy.mjs";
import { validateAiOutput } from "./ai-output-validation.mjs";
import { AiPromptRegistry, resolvePromptRegistration } from "./prompt-registry.mjs";

const RETRYABLE_CODES = new Set(["AI_TIMEOUT", "AI_RATE_LIMITED", "AI_PROVIDER_ERROR"]);

function wait(delayMs) {
  return delayMs ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function token(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function normalizeAgentInvocation(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new TypeError("AI Gateway agent reference is invalid"), {
      code: "AGENT_CONTRACT_INVALID",
    });
  }
  const reference = assertAgentReference(value.name, value.version || "1.0.0");
  const taskId = value.taskId === null || value.taskId === undefined || value.taskId === ""
    ? null
    : String(value.taskId).trim();
  if (taskId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(taskId)) {
    throw Object.assign(new TypeError("AI Gateway Agent task id is invalid"), {
      code: "AGENT_CONTRACT_INVALID",
    });
  }
  return Object.freeze({ ...reference, taskId });
}

function resultDigest(value) {
  if (value === null || value === undefined) return null;
  try {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    return createHash("sha256").update(encoded).digest("hex");
  } catch {
    return null;
  }
}

export function normalizeAiUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = token(value.inputTokens ?? value.input_tokens ?? value.prompt_tokens);
  const outputTokens = token(value.outputTokens ?? value.output_tokens ?? value.completion_tokens);
  const totalTokens = token(value.totalTokens ?? value.total_tokens)
    ?? (inputTokens !== null || outputTokens !== null ? (inputTokens || 0) + (outputTokens || 0) : null);
  const cacheHitTokens = token(value.cacheHitTokens ?? value.cache_hit_tokens ?? value.prompt_cache_hit_tokens);
  const cacheMissTokens = token(value.cacheMissTokens ?? value.cache_miss_tokens ?? value.prompt_cache_miss_tokens);
  return Object.freeze({ inputTokens, outputTokens, totalTokens, cacheHitTokens, cacheMissTokens });
}

async function logSafely(logger, entry) {
  if (typeof logger !== "function") return;
  try { await logger(entry); } catch { /* AI telemetry must not break the business request. */ }
}

export class AiGateway {
  constructor({ provider, policy = {}, logger = null, promptRegistry = new AiPromptRegistry() } = {}) {
    if (!provider || typeof provider.complete !== "function") throw new TypeError("AI provider is required");
    this.provider = provider;
    this.policy = resolveAiRequestPolicy(policy);
    this.logger = logger;
    this.promptRegistry = promptRegistry;
  }

  async complete(input) {
    const moduleId = assertModuleId(input.moduleId);
    const requestId = resolveRequestId(input.requestId);
    const agent = normalizeAgentInvocation(input.agent);
    const operation = String(input.operation || "completion").slice(0, 80);
    const prompt = resolvePromptRegistration({
      registry: this.promptRegistry,
      moduleId,
      operation,
      promptId: input.promptId,
      promptVersion: input.promptVersion,
    });
    const messages = input.messages || [
      ...(input.systemPrompt ? [{ role: "system", content: input.systemPrompt }] : []),
      { role: "user", content: input.prompt || "" },
    ];
    const startedAt = Date.now();
    let result = null;
    let attempts = 0;
    do {
      attempts += 1;
      try {
        result = await this.provider.complete({
          model: input.model,
          messages,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          responseFormat: input.responseFormat,
          thinking: input.thinking,
          timeoutMs: input.timeoutMs || this.policy.timeoutMs,
          signal: input.signal,
        });
      } catch {
        result = { success: false, errorCode: "AI_PROVIDER_ERROR", errorMessage: "AI provider request failed" };
      }
      if (result.success || !RETRYABLE_CODES.has(result.errorCode) || attempts >= this.policy.maxAttempts) break;
      await wait(this.policy.retryDelayMs * attempts);
    } while (attempts < this.policy.maxAttempts);

    const validation = result?.success
      ? validateAiOutput(result.content, input.outputValidator)
      : { valid: null, schemaId: input.outputValidator?.schemaId || null, value: null, error: null };
    const providerSucceeded = Boolean(result?.success);
    const success = providerSucceeded && validation.valid !== false;
    const usage = providerSucceeded ? normalizeAiUsage(result.usage) : null;

    const output = {
      success,
      resultStatus: success ? "succeeded" : "failed",
      requestId,
      agent,
      provider: this.provider.name || "unknown",
      model: input.model,
      prompt: Object.freeze(prompt),
      content: success ? result.content : null,
      validatedOutput: success ? validation.value : null,
      outputSchemaId: validation.schemaId,
      outputValid: validation.valid,
      resultDigest: success ? resultDigest(validation.value ?? result.content) : null,
      usage,
      attempts,
      durationMs: Date.now() - startedAt,
      errorCode: success ? null : providerSucceeded ? "AI_OUTPUT_INVALID" : result?.errorCode || "AI_PROVIDER_ERROR",
      errorMessage: success ? null : providerSucceeded ? validation.error : result?.errorMessage || "AI provider request failed",
    };
    await logSafely(this.logger, {
      moduleId,
      operation,
      provider: output.provider,
      model: output.model,
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptManaged: prompt.managed,
      attempts,
      usage,
      outputSchemaId: output.outputSchemaId,
      outputValid: output.outputValid,
      resultDigest: output.resultDigest,
      durationMs: output.durationMs,
      success: output.success,
      resultStatus: output.resultStatus,
      errorCode: output.errorCode,
      requestId,
      agent,
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
