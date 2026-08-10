import { createHash } from "node:crypto";
import { assertAgentReference } from "../agent/agent-contracts.mjs";
import { assertAgentToolName } from "./agent-tool-contracts.mjs";
import { assertJsonSchemaValue } from "./json-schema-validation.mjs";

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

function requestIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    throw Object.assign(new TypeError(`${label} is invalid`), {
      code: "AGENT_TOOL_INVOCATION_INVALID",
    });
  }
  return normalized;
}

function boundedJson(value, { label, maximum, code }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new TypeError(`${label} must be an object`), {
      code,
    });
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded || Buffer.byteLength(encoded, "utf8") > maximum) throw new TypeError();
    return JSON.parse(encoded);
  } catch {
    throw Object.assign(new TypeError(`${label} must be bounded JSON`), {
      code,
    });
  }
}

function summary(value) {
  const encoded = JSON.stringify(value);
  return Object.freeze({
    digest: createHash("sha256").update(encoded).digest("hex"),
    bytes: Buffer.byteLength(encoded, "utf8"),
    keys: Object.freeze(Object.keys(value).sort().slice(0, 50)),
  });
}

function normalizedUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalize = (candidate) => {
    if (candidate === null || candidate === undefined || candidate === "") return null;
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
  };
  const inputTokens = normalize(value.inputTokens ?? value.input_tokens ?? value.prompt_tokens);
  const outputTokens = normalize(value.outputTokens ?? value.output_tokens ?? value.completion_tokens);
  const totalTokens = normalize(value.totalTokens ?? value.total_tokens)
    ?? (inputTokens !== null || outputTokens !== null ? (inputTokens || 0) + (outputTokens || 0) : null);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheHitTokens: normalize(value.cacheHitTokens ?? value.cache_hit_tokens ?? value.prompt_cache_hit_tokens),
    cacheMissTokens: normalize(value.cacheMissTokens ?? value.cache_miss_tokens ?? value.prompt_cache_miss_tokens),
  };
}

async function traceSafely(trace, entry) {
  try { await trace(entry); } catch { /* Tool telemetry cannot break Agent execution. */ }
}

export class AgentToolRuntime {
  constructor({ agentRegistry, toolRegistry, trace }) {
    if (!agentRegistry || typeof agentRegistry.require !== "function") {
      throw new TypeError("Agent registry is required");
    }
    if (!toolRegistry || typeof toolRegistry.require !== "function"
      || typeof toolRegistry.execute !== "function") {
      throw new TypeError("Agent tool registry is required");
    }
    if (typeof trace !== "function") throw new TypeError("Agent tool trace is required");
    this.agentRegistry = agentRegistry;
    this.toolRegistry = toolRegistry;
    this.trace = trace;
  }

  async execute(input = {}) {
    const agent = assertAgentReference(input.agent_name, input.agent_version || "1.0.0");
    const definition = this.agentRegistry.require(agent.name, agent.version);
    const toolName = assertAgentToolName(input.tool_name);
    const declared = definition.tools.find((tool) => tool.name === toolName);
    const requestedVersion = String(input.tool_version || declared?.version || "").trim();
    const entry = this.toolRegistry.require(toolName, requestedVersion || "1.0.0");
    const requestId = requestIdentifier(input.request_id, "Agent tool request id");
    const requestedBy = requestIdentifier(
      input.requested_by || "agent-tool-runtime",
      "Agent tool requester",
    );
    const startedAt = Date.now();
    let inputSummary = null;
    try {
      if (!declared) {
        throw Object.assign(new Error(`Agent ${agent.name} cannot use ${toolName}`), {
          code: "AGENT_TOOL_FORBIDDEN",
          agentName: agent.name,
          toolName,
        });
      }
      if (declared.version !== entry.definition.version) {
        throw Object.assign(new Error("Agent tool version does not match the registry"), {
          code: "AGENT_TOOL_VERSION_MISMATCH",
          agentName: agent.name,
          toolName,
          requestedVersion: entry.definition.version,
          declaredVersion: declared.version,
        });
      }
      if (declared.access !== entry.definition.access
        || declared.permission !== entry.definition.permission
        || !definition.permission.scopes.includes(entry.definition.permission)) {
        throw Object.assign(new Error("Agent tool permission does not match the registry"), {
          code: "AGENT_TOOL_PERMISSION_MISMATCH",
          agentName: agent.name,
          toolName,
        });
      }
      const normalizedInput = boundedJson(input.input, {
        label: "Agent tool input",
        maximum: 4_194_304,
        code: "AGENT_TOOL_INVOCATION_INVALID",
      });
      inputSummary = summary(normalizedInput);
      assertJsonSchemaValue(entry.definition.input_schema, normalizedInput, {
        code: "AGENT_TOOL_INPUT_SCHEMA_INVALID",
        label: "input",
      });
      const rawResult = await this.toolRegistry.execute(toolName, entry.definition.version, {
        agent,
        agentDefinition: definition,
        requestId,
        requestedBy,
        input: normalizedInput,
      });
      const result = boundedJson(rawResult, {
        label: "Agent tool output",
        maximum: 4_194_304,
        code: "AGENT_TOOL_OUTPUT_INVALID",
      });
      assertJsonSchemaValue(entry.definition.output_schema, result, {
        code: "AGENT_TOOL_OUTPUT_SCHEMA_INVALID",
        label: "output",
      });
      const outputSummary = summary(result);
      await traceSafely(this.trace, {
        requestId,
        agent,
        tool: entry.definition,
        success: true,
        durationMs: Date.now() - startedAt,
        inputSummary,
        outputSummary,
        resultDigest: outputSummary.digest,
        resultStatus: result.resultStatus || result.state || "succeeded",
        contextVersion: typeof result.contextVersion === "string" ? result.contextVersion : null,
        usage: normalizedUsage(result.usage),
        errorCode: null,
      });
      return Object.freeze({
        tool: entry.definition,
        agent,
        requestId,
        result,
      });
    } catch (error) {
      await traceSafely(this.trace, {
        requestId,
        agent,
        tool: entry.definition,
        success: false,
        durationMs: Date.now() - startedAt,
        inputSummary,
        outputSummary: null,
        resultDigest: null,
        resultStatus: "failed",
        contextVersion: null,
        usage: null,
        errorCode: error.code || "AGENT_TOOL_EXECUTION_FAILED",
      });
      throw error;
    }
  }
}
