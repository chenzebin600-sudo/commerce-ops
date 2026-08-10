import { randomUUID } from "node:crypto";
import { aiGatewayError } from "../lib/ai/ai-gateway.mjs";
import { createAiOutputValidator } from "../lib/ai/ai-output-validation.mjs";
import { MODULE_IDS } from "../lib/contracts/module-ids.mjs";
import { FulfillmentError } from "./service.mjs";
import { FULFILLMENT_AGENT_PROMPT_VERSION, FULFILLMENT_AGENT_SYSTEM_PROMPT } from "./agent-prompt.mjs";

function parseCommand(content) {
  let text = String(content || "").trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let command;
  try { command = JSON.parse(text); }
  catch { throw new FulfillmentError("AGENT_INVALID_RESPONSE", "Agent 返回了无法解析的响应", 502); }
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new FulfillmentError("AGENT_INVALID_RESPONSE", "Agent 响应结构无效", 502);
  }
  if (command.type === "final") {
    const message = String(command.message || "").trim();
    if (!message || message.length > 8000) throw new FulfillmentError("AGENT_INVALID_RESPONSE", "Agent 最终答复无效", 502);
    return { type: "final", message };
  }
  if (command.type === "tool") {
    return { type: "tool", tool: String(command.tool || ""), arguments: command.arguments || {}, reason: String(command.reason || "").slice(0, 240) };
  }
  throw new FulfillmentError("AGENT_INVALID_RESPONSE", "Agent 响应类型无效", 502);
}

const fulfillmentCommandOutputValidator = createAiOutputValidator({
  schemaId: `fulfillment-agent-command@${FULFILLMENT_AGENT_PROMPT_VERSION}`,
  parse: parseCommand,
  validate: () => true,
});

function boundedMessage(value) {
  const message = String(value || "").trim();
  if (!message || message.length > 4000) throw new FulfillmentError("AGENT_MESSAGE_INVALID", "消息必须是 1-4000 个字符", 400);
  return message;
}

function safeConversationId(value) {
  const id = String(value || "").trim();
  if (!id) return randomUUID();
  if (id.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new FulfillmentError("AGENT_CONVERSATION_INVALID", "conversationId 无效", 400);
  return id;
}

function auditTrace(trace) {
  return trace.map(({ step, tool, argumentKeys }) => ({ step, tool, argumentKeys }));
}

export class FulfillmentAgent {
  constructor({ gateway, tools, repository = null, enabled = true, model = "deepseek-chat", maxSteps = 6, now = () => new Date() }) {
    this.gateway = gateway;
    this.tools = tools;
    this.repository = repository;
    this.enabled = Boolean(enabled);
    this.model = model;
    this.maxSteps = Math.max(1, Math.min(8, Number(maxSteps) || 6));
    this.now = now;
    this.conversations = new Map();
  }

  status() {
    return { enabled: this.enabled, configured: Boolean(this.gateway), mode: "read_only", model: this.model,
      promptVersion: FULFILLMENT_AGENT_PROMPT_VERSION, tools: this.tools.names() };
  }

  remember(conversationId, userMessage, assistantMessage) {
    const existing = this.conversations.get(conversationId) || [];
    existing.push({ role: "user", content: userMessage }, { role: "assistant", content: assistantMessage });
    this.conversations.set(conversationId, existing.slice(-12));
    if (this.conversations.size > 100) this.conversations.delete(this.conversations.keys().next().value);
  }

  async chat({ message, conversationId } = {}) {
    if (!this.enabled) throw new FulfillmentError("AGENT_DISABLED", "马帮发货 Agent 已关闭", 409);
    if (!this.gateway) throw new FulfillmentError("AI_NOT_CONFIGURED", "尚未配置 DeepSeek API Key，无法使用发货 Agent", 409);
    const userMessage = boundedMessage(message);
    const id = safeConversationId(conversationId);
    const runId = randomUUID();
    const startedAt = this.now().toISOString();
    const trace = [];
    await this.repository?.startAgentRun?.({ id: runId, conversationId: id, model: this.model, startedAt });
    const messages = [
      { role: "system", content: FULFILLMENT_AGENT_SYSTEM_PROMPT },
      ...(this.conversations.get(id) || []),
      { role: "user", content: userMessage },
    ];
    try {
      for (let step = 1; step <= this.maxSteps; step += 1) {
        const result = await this.gateway.complete({ moduleId: MODULE_IDS.FULFILLMENT_AGENT,
          operation: "fulfillment_agent_step", promptId: "fulfillment.readonly-agent",
          promptVersion: FULFILLMENT_AGENT_PROMPT_VERSION, model: this.model, messages, temperature: 0.1,
          responseFormat: { type: "json_object" }, outputValidator: fulfillmentCommandOutputValidator });
        if (!result.success) throw aiGatewayError(result);
        const command = result.validatedOutput ?? parseCommand(result.content);
        if (command.type === "final") {
          this.remember(id, userMessage, command.message);
          await this.repository?.finishAgentRun?.({ id: runId, status: "completed", stepCount: step,
            toolTrace: auditTrace(trace), finishedAt: this.now().toISOString() });
          return { conversationId: id, runId, mode: "read_only", message: command.message, toolsUsed: trace };
        }
        const traceItem = { step, tool: command.tool, reason: command.reason,
          argumentKeys: Object.keys(command.arguments || {}).sort() };
        trace.push(traceItem);
        let toolResult;
        try { toolResult = { success: true, data: await this.tools.execute(command.tool, command.arguments) }; }
        catch (error) { toolResult = { success: false, error: { code: error.code || "TOOL_FAILED", message: error.message || "工具调用失败" } }; }
        messages.push({ role: "assistant", content: JSON.stringify(command) });
        messages.push({ role: "user", content: `TOOL_RESULT ${command.tool}: ${JSON.stringify(toolResult)}` });
      }
      throw new FulfillmentError("AGENT_STEP_LIMIT", "Agent 达到最大工具调用步数，未执行任何真实操作", 409);
    } catch (error) {
      await this.repository?.finishAgentRun?.({ id: runId, status: "failed", stepCount: trace.length,
        toolTrace: auditTrace(trace), errorCode: error.code || "AGENT_FAILED", finishedAt: this.now().toISOString() });
      if (error instanceof FulfillmentError) throw error;
      throw new FulfillmentError(error.code || "AGENT_FAILED", error.message || "Agent 执行失败", 502);
    }
  }
}
