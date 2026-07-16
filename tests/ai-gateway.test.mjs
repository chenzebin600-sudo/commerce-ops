import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AiGateway } from "../lib/ai/ai-gateway.mjs";
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
    requestId: "request-test-1",
  });
  assert.deepEqual(requestBody.messages, messages);
  assert.equal(requestBody.model, "deepseek-chat");
  assert.equal(result.success, true);
  assert.equal(result.content, "unchanged result");
  assert.equal(result.requestId, "request-test-1");
  assert.equal(result.provider, "deepseek");
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
    "mabang_inventory", "scheduled_exports", "file_management", "operation_audit",
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
