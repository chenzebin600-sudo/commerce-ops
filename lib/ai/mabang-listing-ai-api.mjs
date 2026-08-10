import { createHash } from "node:crypto";
import { constantTimeTokenEquals, isLoopbackBindHost } from "../app-access.mjs";
import { MODULE_IDS } from "../contracts/module-ids.mjs";
import { createJsonObjectOutputValidator } from "./ai-output-validation.mjs";

export const MABANG_LISTING_AI_PATH = "/api/internal/ai/mabang-listing/complete";
export const MABANG_LISTING_AI_TOKEN_HEADER = "x-commerce-ops-internal-token";

export const MABANG_LISTING_AI_PROFILES = Object.freeze({
  command_parser: Object.freeze({
    operation: "parse_listing_commands",
    promptId: "mabang-listing.command-parser",
    promptVersion: "mabang-listing-command-v1",
    systemPromptSha256: "e686adc2d59bc5273b3e72f9550087195b4d3dce1ca116923d9eec4e08b4f1a6",
    outputSchemaId: "mabang-listing-command-v1",
    maxTokens: 2400,
    temperature: 0,
  }),
  listing_material: Object.freeze({
    operation: "generate_listing_material",
    promptId: "mabang-listing.material-generator",
    promptVersion: "mabang-listing-material-v1",
    systemPromptSha256: "10e140b3562beb2f59230585d4bd80b349c20b57907bc385528bf5e7eb5a67d0",
    outputSchemaId: "mabang-listing-material-v1",
    maxTokens: 3200,
    temperature: 0.2,
  }),
});

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
  return true;
}

async function readJson(req, maxBytes = 32 * 1024) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (declared > maxBytes) throw Object.assign(new Error("AI request is too large"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw Object.assign(new Error("AI request is too large"), { status: 413 });
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("AI request body must be valid JSON"), { status: 400 });
  }
}

function remoteAddress(req) {
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || "").trim();
}

function promptDigest(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function stringField(value, maximum) {
  const output = String(value || "").trim();
  if (!output || output.length > maximum) return null;
  return output;
}

function profileOutputValidator(profile) {
  return createJsonObjectOutputValidator({
    schemaId: profile.outputSchemaId,
    validate(value) {
      if (profile.operation === "parse_listing_commands") {
        const commands = Array.isArray(value.commands) ? value.commands : [value];
        return commands.length > 0 && commands.every((command) => (
          command && typeof command === "object" && !Array.isArray(command)
          && typeof command.action === "string"
        ));
      }
      return typeof value.title === "string"
        && typeof value.description === "string"
        && Array.isArray(value.variants);
    },
  });
}

function errorStatus(result) {
  if (result?.errorCode === "AI_TIMEOUT") return 504;
  if (result?.errorCode === "AI_RATE_LIMITED") return 429;
  if (result?.errorCode === "AI_OUTPUT_INVALID") return 422;
  return 502;
}

export function createMabangListingAiApi({
  gateway,
  internalToken,
  configured,
  defaultModel = "deepseek-v4-flash",
  profiles = MABANG_LISTING_AI_PROFILES,
} = {}) {
  if (!gateway || typeof gateway.complete !== "function") throw new TypeError("AI gateway is required");
  if (!String(internalToken || "").trim()) throw new TypeError("Mabang listing internal token is required");

  return async function handleMabangListingAiApi(req, res, url) {
    if (url.pathname !== MABANG_LISTING_AI_PATH) return false;
    if (req.method !== "POST") return sendJson(res, 405, { success: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
    if (!isLoopbackBindHost(remoteAddress(req))) {
      return sendJson(res, 403, { success: false, code: "AI_INTERNAL_LOOPBACK_REQUIRED", error: "Internal AI access requires loopback" });
    }
    const suppliedToken = req.headers?.[MABANG_LISTING_AI_TOKEN_HEADER];
    if (!constantTimeTokenEquals(internalToken, Array.isArray(suppliedToken) ? suppliedToken[0] : suppliedToken)) {
      return sendJson(res, 401, { success: false, code: "AI_INTERNAL_UNAUTHORIZED", error: "Internal AI authentication failed" });
    }
    if (!configured) {
      return sendJson(res, 503, { success: false, code: "AI_NOT_CONFIGURED", error: "DeepSeek is not configured in Commerce Ops" });
    }

    try {
      const body = await readJson(req);
      const profile = profiles[String(body.profile || "").trim()];
      if (!profile) return sendJson(res, 400, { success: false, code: "AI_PROFILE_INVALID", error: "AI profile is not allowed" });
      if (body.prompt_version !== profile.promptVersion) {
        return sendJson(res, 409, { success: false, code: "AI_PROMPT_VERSION_MISMATCH", error: "AI prompt version does not match the registered profile" });
      }
      const systemPrompt = stringField(body.system_prompt, 16 * 1024);
      const input = stringField(body.input, 8 * 1024);
      if (!systemPrompt || promptDigest(systemPrompt) !== profile.systemPromptSha256) {
        return sendJson(res, 409, { success: false, code: "AI_PROMPT_CONTENT_MISMATCH", error: "AI prompt content does not match the registered profile" });
      }
      if (!input) return sendJson(res, 400, { success: false, code: "AI_INPUT_INVALID", error: "AI input is required" });

      const result = await gateway.complete({
        moduleId: MODULE_IDS.MABANG_LISTING,
        operation: profile.operation,
        promptId: profile.promptId,
        promptVersion: profile.promptVersion,
        model: stringField(body.model, 80) || defaultModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        responseFormat: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        outputValidator: profileOutputValidator(profile),
        requestId: req.headers?.["x-request-id"],
      });
      if (!result.success) {
        return sendJson(res, errorStatus(result), {
          success: false,
          code: result.errorCode,
          error: result.errorMessage,
          request_id: result.requestId,
        });
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          request_id: result.requestId,
          provider: result.provider,
          model: result.model,
          prompt: result.prompt,
          content: result.content,
          validated_output: result.validatedOutput,
          usage: result.usage,
        },
      });
    } catch (error) {
      return sendJson(res, Number(error?.status || 400), {
        success: false,
        code: error?.status === 413 ? "AI_REQUEST_TOO_LARGE" : "AI_INTERNAL_REQUEST_INVALID",
        error: error?.message || "Internal AI request failed",
      });
    }
  };
}
