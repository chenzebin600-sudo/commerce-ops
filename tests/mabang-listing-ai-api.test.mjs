import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { AiGateway } from "../lib/ai/ai-gateway.mjs";
import {
  createMabangListingAiApi,
  MABANG_LISTING_AI_PROFILES,
  MABANG_LISTING_AI_PATH,
  MABANG_LISTING_AI_TOKEN_HEADER,
} from "../lib/ai/mabang-listing-ai-api.mjs";
import { MODULE_IDS } from "../lib/contracts/module-ids.mjs";

const TOKEN = "test-internal-token";
const SYSTEM_PROMPT = "registered system prompt";
const PROFILE = Object.freeze({
  command_parser: Object.freeze({
    operation: "parse_listing_commands",
    promptId: "mabang-listing.command-parser",
    promptVersion: "test-v1",
    systemPromptSha256: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
    outputSchemaId: "mabang-listing-command-test-v1",
    maxTokens: 2400,
    temperature: 0,
  }),
});

function request(body, { token = TOKEN, remoteAddress = "127.0.0.1", method = "POST" } = {}) {
  const value = JSON.stringify(body);
  const req = Readable.from([value]);
  req.method = method;
  req.headers = {
    "content-length": String(Buffer.byteLength(value)),
    [MABANG_LISTING_AI_TOKEN_HEADER]: token,
    "x-request-id": "request-test-1",
  };
  req.socket = { remoteAddress };
  return req;
}

function response() {
  let status = null;
  let headers = null;
  let body = null;
  return {
    writeHead(value, values) { status = value; headers = values; },
    end(value) { body = value ? JSON.parse(Buffer.from(value).toString("utf8")) : null; },
    result() { return { status, headers, body }; },
  };
}

function input(overrides = {}) {
  return {
    profile: "command_parser",
    prompt_version: "test-v1",
    system_prompt: SYSTEM_PROMPT,
    input: "请解析 SKU A 库存设为 10",
    model: "deepseek-v4-flash",
    ...overrides,
  };
}

function pythonRawPrompt(source, name) {
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  const opening = `${name} = r\"\"\"`;
  const start = normalizedSource.indexOf(opening);
  assert.notEqual(start, -1, `${name} must exist in the Python adapter`);
  const contentStart = start + opening.length;
  const end = normalizedSource.indexOf('\"\"\".strip()', contentStart);
  assert.notEqual(end, -1, `${name} must remain a stripped raw triple-quoted string`);
  return normalizedSource.slice(contentStart, end).trim();
}

test("Mabang listing internal AI profile routes through the unified Gateway", async () => {
  const providerCalls = [];
  const gateway = new AiGateway({
    provider: {
      name: "deepseek",
      async complete(value) {
        providerCalls.push(value);
        return {
          success: true,
          content: JSON.stringify({ action: "stock_update" }),
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        };
      },
    },
  });
  const handler = createMabangListingAiApi({
    gateway,
    internalToken: TOKEN,
    configured: true,
    profiles: PROFILE,
  });
  const res = response();

  assert.equal(await handler(request(input()), res, new URL(MABANG_LISTING_AI_PATH, "http://local")), true);
  const result = res.result();
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.deepEqual(result.body.data.validated_output, { action: "stock_update" });
  assert.equal(result.body.data.usage.totalTokens, 14);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].maxTokens, 2400);
  assert.equal(gateway.promptRegistry.list()[0].moduleId, MODULE_IDS.MABANG_LISTING);
  assert.equal(gateway.promptRegistry.list()[0].version, "test-v1");
});

test("registered Mabang prompt digests match the Python adapter prompts", async () => {
  const source = await fs.readFile("integrations/mabang-getdata/ai_service.py", "utf8");
  for (const [profileName, promptName] of [
    ["command_parser", "SYSTEM_PROMPT"],
    ["listing_material", "LISTING_MATERIAL_SYSTEM_PROMPT"],
  ]) {
    const digest = createHash("sha256").update(pythonRawPrompt(source, promptName), "utf8").digest("hex");
    assert.equal(digest, MABANG_LISTING_AI_PROFILES[profileName].systemPromptSha256);
  }
});

test("Mabang listing internal AI endpoint rejects external callers and invalid tokens", async () => {
  let calls = 0;
  const handler = createMabangListingAiApi({
    gateway: { complete: async () => { calls += 1; } },
    internalToken: TOKEN,
    configured: true,
    profiles: PROFILE,
  });
  const external = response();
  await handler(request(input(), { remoteAddress: "10.0.0.12" }), external, new URL(MABANG_LISTING_AI_PATH, "http://local"));
  assert.equal(external.result().status, 403);
  const unauthorized = response();
  await handler(request(input(), { token: "wrong" }), unauthorized, new URL(MABANG_LISTING_AI_PATH, "http://local"));
  assert.equal(unauthorized.result().status, 401);
  assert.equal(calls, 0);
});

test("Mabang listing internal AI endpoint enforces registered profile version and prompt digest", async () => {
  let calls = 0;
  const handler = createMabangListingAiApi({
    gateway: { complete: async () => { calls += 1; } },
    internalToken: TOKEN,
    configured: true,
    profiles: PROFILE,
  });
  for (const [body, expectedStatus] of [
    [input({ profile: "arbitrary_proxy" }), 400],
    [input({ prompt_version: "other" }), 409],
    [input({ system_prompt: "tampered" }), 409],
  ]) {
    const res = response();
    await handler(request(body), res, new URL(MABANG_LISTING_AI_PATH, "http://local"));
    assert.equal(res.result().status, expectedStatus);
  }
  assert.equal(calls, 0);
});

test("Mabang listing internal AI endpoint reports the central configuration gate", async () => {
  const handler = createMabangListingAiApi({
    gateway: { complete: async () => assert.fail("gateway must not be called") },
    internalToken: TOKEN,
    configured: false,
    profiles: PROFILE,
  });
  const res = response();
  await handler(request(input()), res, new URL(MABANG_LISTING_AI_PATH, "http://local"));
  assert.equal(res.result().status, 503);
  assert.equal(res.result().body.code, "AI_NOT_CONFIGURED");
});

test("Mabang Python AI adapter has no provider endpoint or provider credential access", async () => {
  const source = await fs.readFile("integrations/mabang-getdata/ai_service.py", "utf8");
  assert.doesNotMatch(source, /api\.deepseek\.com|chat\/completions|DEEPSEEK_API_KEY|Authorization/i);
  assert.match(source, /COMMERCE_OPS_AI_GATEWAY_URL/);
  assert.match(source, /COMMERCE_OPS_AI_GATEWAY_TOKEN/);
});
