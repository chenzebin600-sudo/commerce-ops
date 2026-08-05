import assert from "node:assert/strict";
import test from "node:test";
import { FulfillmentAgent } from "../fulfillment-service/agent.mjs";
import { FulfillmentAgentTools, FULFILLMENT_AGENT_TOOL_NAMES } from "../fulfillment-service/agent-tools.mjs";
import { FULFILLMENT_AGENT_SYSTEM_PROMPT } from "../fulfillment-service/agent-prompt.mjs";
import { FulfillmentRepository } from "../fulfillment-service/repository.mjs";

function queuedGateway(outputs) {
  const requests = [];
  return {
    requests,
    async complete(input) {
      requests.push(input);
      const content = outputs.shift();
      return content instanceof Error
        ? { success: false, errorCode: content.code || "AI_PROVIDER_ERROR", errorMessage: content.message }
        : { success: true, content, provider: "test", model: input.model };
    },
  };
}

test("read-only fulfillment agent executes a bounded tool loop and persists safe audit metadata", async () => {
  const repository = new FulfillmentRepository();
  const gateway = queuedGateway([
    JSON.stringify({ type:"tool",tool:"get_dashboard",arguments:{ days:1 },reason:"读取今日状态" }),
    JSON.stringify({ type:"final",message:"今天没有需要处理的异常。" }),
  ]);
  const calls = [];
  const tools = { names:() => ["get_dashboard"], async execute(name,args) { calls.push({ name,args }); return { today:{ total:0 } }; } };
  const agent = new FulfillmentAgent({ gateway, tools, repository, model:"test-model", now:() => new Date("2026-07-31T08:00:00.000Z") });
  const result = await agent.chat({ message:"检查今天有没有异常", conversationId:"conversation-1" });
  assert.equal(result.message, "今天没有需要处理的异常。");
  assert.equal(result.mode, "read_only");
  assert.deepEqual(calls, [{ name:"get_dashboard",args:{ days:1 } }]);
  assert.match(gateway.requests[0].messages[0].content, /严格只读阶段/);
  assert.equal(gateway.requests[0].promptId, "fulfillment.readonly-agent");
  assert.equal(gateway.requests[0].promptVersion, "fulfillment-readonly-agent-v1");
  assert.match(gateway.requests[0].outputValidator.schemaId, /^fulfillment-agent-command@/);
  assert.match(gateway.requests[1].messages.at(-1).content, /TOOL_RESULT get_dashboard/);
  const audit = repository.getAgentRun(result.runId);
  assert.equal(audit.status, "completed");
  assert.deepEqual(audit.toolTrace[0].argumentKeys, ["days"]);
  assert.doesNotMatch(JSON.stringify(audit), /检查今天有没有异常|today/);
  repository.close();
});

test("agent tool allowlist rejects fulfillment writes and strips confirmation tokens", async () => {
  let created = 0;
  const preview = { previewId:"preview-1",confirmationToken:"secret-confirmation",eligibleOrders:[],excludedOrders:[] };
  const shopService = { preflight:{ run:async() => ({}) },createPreview:async() => { created += 1; return preview; },
    listRecentBatches:() => [],getBatch:() => ({}),runPreflight:async() => ({ safe:true }) };
  const tools = new FulfillmentAgentTools({
    repository:{ getDashboardSummary:() => ({}) },scheduler:{ status:() => ({}) },
    serviceForShop:() => shopService,serviceForPreview:() => ({ getPreview:() => preview }),
    dashboardWindows:() => ({}),
  });
  const inspected = await tools.execute("inspect_shop_orders", { shopId:"2021485965",limit:10 });
  assert.equal(created, 1);
  assert.equal(inspected.confirmationToken, undefined);
  assert.equal(inspected.agentCanConfirm, false);
  await assert.rejects(() => tools.execute("submit_approved_preview", { previewId:"preview-1" }),
    (error) => error.code === "AGENT_TOOL_FORBIDDEN" && error.status === 403);
  assert.equal(FULFILLMENT_AGENT_TOOL_NAMES.some((name) => /confirm|submit|recover|reset/i.test(name)), false);
  assert.match(FULFILLMENT_AGENT_SYSTEM_PROMPT, /不存在确认发货、恢复订单、清空渠道/);
});

test("agent records provider failures without retaining prompts or tool results", async () => {
  const repository = new FulfillmentRepository();
  const providerError = Object.assign(new Error("provider unavailable"), { code:"AI_TIMEOUT" });
  const agent = new FulfillmentAgent({ gateway:queuedGateway([providerError]),
    tools:{ names:() => [],execute:async() => ({}) },repository,model:"test-model" });
  await assert.rejects(() => agent.chat({ message:"订单 SECRET-ORDER 怎么样",conversationId:"safe-id" }),
    (error) => error.code === "AI_TIMEOUT");
  const row = repository.db.prepare("SELECT * FROM fulfillment_agent_runs").get();
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "AI_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(row), /SECRET-ORDER|provider unavailable/);
  repository.close();
});
