import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AiGateway, normalizeAiUsage } from "../lib/ai/ai-gateway.mjs";
import { createAiAuditLogger } from "../lib/ai/ai-audit-logger.mjs";
import { createJsonObjectOutputValidator } from "../lib/ai/ai-output-validation.mjs";
import { AiPromptRegistry } from "../lib/ai/prompt-registry.mjs";
import { DeepSeekProvider } from "../lib/ai/providers/deepseek-provider.mjs";
import { MODULE_IDS, MODULE_ID_VALUES } from "../lib/contracts/module-ids.mjs";
import { errorResponse, paginationResponse, successResponse } from "../lib/http/api-response.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("AI gateway preserves messages and returns the unified result contract", async () => {
  let requestBody;
  const provider = new DeepSeekProvider({
    apiKey: "temporary-test-key",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ choices: [{ message: { content: "unchanged result" } }], usage: { total_tokens: 12 } });
    },
  });
  const gateway = new AiGateway({ provider });
  const messages = [{ role: "system", content: "original prompt" }, { role: "user", content: "original input" }];
  const result = await gateway.complete({
    moduleId: MODULE_IDS.COMPETITOR_LINK,
    operation: "test_completion",
    model: "deepseek-chat",
    messages,
    maxTokens: 321,
    thinking: { type: "disabled" },
    requestId: "request-test-1",
  });
  assert.deepEqual(requestBody.messages, messages);
  assert.equal(requestBody.model, "deepseek-chat");
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal(requestBody.max_tokens, 321);
  assert.equal(result.success, true);
  assert.equal(result.content, "unchanged result");
  assert.equal(result.requestId, "request-test-1");
  assert.equal(result.provider, "deepseek");
  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: 12,
    cacheHitTokens: null,
    cacheMissTokens: null,
  });
  assert.equal(result.prompt.managed, false);
});

test("AI gateway registers versioned prompts and permits reuse inside one module", async () => {
  const promptRegistry = new AiPromptRegistry();
  const logs = [];
  const provider = {
    name: "fixture",
    complete: async () => ({ success: true, content: "ok", usage: { prompt_tokens: 5, completion_tokens: 3 } }),
  };
  const gateway = new AiGateway({ provider, promptRegistry, logger: async (entry) => logs.push(entry) });
  for (const operation of ["summarize", "explain"]) {
    const result = await gateway.complete({
      moduleId: MODULE_IDS.SALES_ASSORTMENT,
      operation,
      promptId: "sales-assortment.analysis",
      promptVersion: "1.0.0",
      messages: [],
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.prompt, { id: "sales-assortment.analysis", version: "1.0.0", managed: true });
  }
  assert.deepEqual(promptRegistry.list(), [{
    id: "sales-assortment.analysis",
    version: "1.0.0",
    moduleId: MODULE_IDS.SALES_ASSORTMENT,
    operations: ["explain", "summarize"],
  }]);
  assert.equal(logs[0].promptId, "sales-assortment.analysis");
  assert.equal(logs[0].promptVersion, "1.0.0");
  assert.deepEqual(logs[0].usage, {
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
    cacheHitTokens: null,
    cacheMissTokens: null,
  });
});

test("AI gateway traces the source Agent without exposing prompts or outputs", async () => {
  const logs = [];
  const gateway = new AiGateway({
    provider: {
      name: "fixture",
      complete: async () => ({
        success: true,
        content: "private output",
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    },
    logger: (entry) => logs.push(entry),
  });
  const result = await gateway.complete({
    moduleId: MODULE_IDS.SALES_ASSORTMENT,
    operation: "agent_trace",
    model: "fixture-model",
    requestId: "agent-trace-1",
    agent: {
      name: "sales.daily-report",
      version: "2.1.0",
      taskId: "task-1",
    },
    messages: [{ role: "user", content: "private input" }],
  });

  assert.equal(result.resultStatus, "succeeded");
  assert.deepEqual(result.agent, {
    name: "sales.daily-report",
    version: "2.1.0",
    taskId: "task-1",
  });
  assert.deepEqual(logs[0].agent, result.agent);
  assert.equal(logs[0].resultStatus, "succeeded");
  assert.match(result.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal(logs[0].resultDigest, result.resultDigest);
  assert.doesNotMatch(JSON.stringify(logs), /private input|private output/);
});

test("AI gateway rejects incomplete prompt references and cross-module ownership conflicts", async () => {
  const provider = { complete: async () => ({ success: true, content: "ok" }) };
  const promptRegistry = new AiPromptRegistry();
  const gateway = new AiGateway({ provider, promptRegistry });
  await assert.rejects(() => gateway.complete({
    moduleId: MODULE_IDS.SALES_ASSORTMENT,
    promptId: "sales-assortment.analysis",
    messages: [],
  }), { code: "AI_PROMPT_REFERENCE_INCOMPLETE" });
  await gateway.complete({
    moduleId: MODULE_IDS.SALES_ASSORTMENT,
    promptId: "shared.prompt",
    promptVersion: "1",
    messages: [],
  });
  await assert.rejects(() => gateway.complete({
    moduleId: MODULE_IDS.PRODUCT_CENTER,
    promptId: "shared.prompt",
    promptVersion: "1",
    messages: [],
  }), { code: "AI_PROMPT_REFERENCE_CONFLICT" });
});

test("AI gateway validates structured output and never returns invalid content", async () => {
  const logs = [];
  let content = '```json\n{"summary":"usable"}\n```';
  const gateway = new AiGateway({
    provider: { complete: async () => ({ success: true, content }) },
    logger: (entry) => logs.push(entry),
  });
  const outputValidator = createJsonObjectOutputValidator({
    schemaId: "analysis-summary@1",
    validate: (value) => typeof value.summary === "string",
  });
  const valid = await gateway.complete({
    moduleId: MODULE_IDS.SALES_ASSORTMENT,
    operation: "validate",
    messages: [],
    outputValidator,
  });
  assert.equal(valid.success, true);
  assert.deepEqual(valid.validatedOutput, { summary: "usable" });
  assert.equal(valid.outputSchemaId, "analysis-summary@1");
  assert.equal(valid.outputValid, true);

  content = '{"unexpected":true}';
  const invalid = await gateway.complete({
    moduleId: MODULE_IDS.SALES_ASSORTMENT,
    operation: "validate",
    messages: [],
    outputValidator,
  });
  assert.equal(invalid.success, false);
  assert.equal(invalid.errorCode, "AI_OUTPUT_INVALID");
  assert.equal(invalid.content, null);
  assert.equal(invalid.validatedOutput, null);
  assert.equal(logs.at(-1).outputValid, false);
});

test("AI audit logger records safe prompt, token, and validation metadata", async () => {
  const records = [];
  const logger = createAiAuditLogger({
    audit: { recordSafely: async (entry) => records.push(entry) },
  });
  await logger({
    requestId: "request-audit-1",
    moduleId: MODULE_IDS.PRODUCT_CENTER,
    operation: "generate",
    provider: "deepseek",
    agent: { name: "sales.daily-report", version: "2.1.0", taskId: "task-audit-1" },
    model: "deepseek-v4-flash",
    promptId: "product.generate",
    promptVersion: "2.1.0",
    promptManaged: true,
    attempts: 1,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheHitTokens: 2 },
    outputSchemaId: "product-copy@1",
    outputValid: true,
    resultDigest: "a".repeat(64),
    durationMs: 25,
    success: true,
    errorCode: null,
    messages: [{ role: "user", content: "private input" }],
    content: "private output",
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.totalTokens, 14);
  assert.equal(records[0].metadata.promptVersion, "2.1.0");
  assert.equal(records[0].metadata.agentName, "sales.daily-report");
  assert.equal(records[0].metadata.agentVersion, "2.1.0");
  assert.equal(records[0].metadata.agentTaskId, "task-audit-1");
  assert.equal(records[0].metadata.resultStatus, "succeeded");
  assert.equal(records[0].metadata.resultDigest, "a".repeat(64));
  assert.doesNotMatch(JSON.stringify(records), /private input|private output/);
});

test("AI gateway rejects malformed Agent tracing metadata", async () => {
  const gateway = new AiGateway({
    provider: { complete: async () => ({ success: true, content: "ok" }) },
  });
  await assert.rejects(
    () => gateway.complete({
      moduleId: MODULE_IDS.SALES_ASSORTMENT,
      agent: { name: "Invalid Agent Name", version: "1.0.0" },
      messages: [],
    }),
    { code: "AGENT_CONTRACT_INVALID" },
  );
});

test("AI gateway normalizes usage variants and isolates logger failures", async () => {
  assert.deepEqual(normalizeAiUsage({ input_tokens: 7, output_tokens: 2, prompt_cache_miss_tokens: 5 }), {
    inputTokens: 7,
    outputTokens: 2,
    totalTokens: 9,
    cacheHitTokens: null,
    cacheMissTokens: 5,
  });
  const result = await new AiGateway({
    provider: { complete: async () => ({ success: true, content: "ok" }) },
    logger: async () => { throw new Error("audit unavailable"); },
  }).complete({ moduleId: MODULE_IDS.ADVERTISING, messages: [] });
  assert.equal(result.success, true);
});

test("AI gateway reports timeout and rate limiting with stable codes", async () => {
  const timeoutProvider = new DeepSeekProvider({
    apiKey: "temporary-test-key",
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  const timedOut = await new AiGateway({ provider: timeoutProvider }).complete({
    moduleId: MODULE_IDS.COMPETITOR_KEYWORD,
    operation: "timeout",
    model: "deepseek-chat",
    messages: [],
    timeoutMs: 10,
  });
  assert.equal(timedOut.errorCode, "AI_TIMEOUT");

  const limitedProvider = new DeepSeekProvider({ apiKey: "temporary-test-key", fetchImpl: async () => response({ error: { message: "slow down" } }, 429) });
  const limited = await new AiGateway({ provider: limitedProvider }).complete({
    moduleId: MODULE_IDS.ADVERTISING,
    operation: "rate_limit",
    model: "deepseek-chat",
    messages: [],
  });
  assert.equal(limited.errorCode, "AI_RATE_LIMITED");
});

test("AI gateway never exposes its API key in errors or safe metadata", async () => {
  const secret = "temporary-secret-key";
  const metadata = [];
  const provider = new DeepSeekProvider({
    apiKey: secret,
    fetchImpl: async () => { throw new Error(`connection failed for ${secret}`); },
  });
  const result = await new AiGateway({ provider, logger: (entry) => metadata.push(entry) }).complete({
    moduleId: MODULE_IDS.COMPETITOR_LINK,
    operation: "safe_error",
    model: "deepseek-chat",
    messages: [{ role: "user", content: "private business input" }],
  });
  assert.equal(result.errorCode, "AI_PROVIDER_ERROR");
  assert.doesNotMatch(result.errorMessage, new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(metadata), /temporary-secret-key|private business input/);
});

test("stable module IDs and compatible API response helpers are additive", () => {
  assert.deepEqual(MODULE_ID_VALUES, [
    "competitor_link", "competitor_keyword", "advertising", "mabang_orders",
    "mabang_inventory", "mabang_listing", "scheduled_exports", "file_management", "operation_audit",
    "product_center", "sales_assortment", "profit", "price_control", "fulfillment_agent", "customer_service", "product_knowledge",
  ]);
  assert.deepEqual(successResponse({ value: 1 }, { requestId: "r1", legacy: { ok: true } }), {
    success: true, data: { value: 1 }, request_id: "r1", error: null, ok: true,
  });
  assert.equal(errorResponse("BAD_INPUT", "bad", { legacy: { ok: false } }).ok, false);
  assert.equal(paginationResponse([], { page: 1, pageSize: 20, total: 21 }).data.pagination.total_pages, 2);
});

test("DeepSeek HTTP calls are isolated in provider adapters and original prompts remain present", async () => {
  const mainServer = await fs.readFile(path.resolve("server.mjs"), "utf8");
  const provider = await fs.readFile(path.resolve("lib/ai/providers/deepseek-provider.mjs"), "utf8");
  assert.doesNotMatch(mainServer, /fetch\("https:\/\/api\.deepseek\.com/);
  assert.match(provider, /api\.deepseek\.com\/chat\/completions/);
  assert.match(mainServer, /你是跨境电商搜索关键词专家。/);
  assert.match(mainServer, /你是跨境电商 SKU 名称翻译与匹配专家。/);
  assert.match(mainServer, /你是资深跨境电商竞品分析师/);
  assert.match(mainServer, /你是电商主图点击率分析师/);
});
