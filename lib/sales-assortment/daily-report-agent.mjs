import { createHash } from "node:crypto";
import { createJsonObjectOutputValidator } from "../ai/ai-output-validation.mjs";
import { assertAgentRuntimeScope } from "../ai/agent/agent-runtime.mjs";

export const DAILY_REPORT_AGENT_NAME = "sales.daily-report";
export const DAILY_REPORT_AGENT_VERSION = "2.1.0";
export const DAILY_REPORT_AGENT_PROMPT_VERSION = "SALES-ASSORTMENT-DAILY-AGENT-2.1.0";

export const DAILY_REPORT_AGENT_OUTPUT_SCHEMA_ID = "sales.daily-report-operations-decision";
const OUTPUT_SCHEMA_ID = DAILY_REPORT_AGENT_OUTPUT_SCHEMA_ID;
const SUPPORTED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
export const DAILY_REPORT_SECTION_KEYS = Object.freeze([
  "operatingOverview",
  "storeAnomalies",
  "productAnomalies",
  "inventoryRisks",
  "businessOpportunities",
  "sevenDayTrends",
]);

export const DAILY_REPORT_AGENT_DEFINITION = Object.freeze({
  name: DAILY_REPORT_AGENT_NAME,
  version: DAILY_REPORT_AGENT_VERSION,
  description: "Turns a deterministic daily Evidence Pack into an explainable operations decision brief.",
  input_context: [{ type: "daily_report", version: "2.1.0", required: true, multiple: false }],
  tools: [
    {
      name: "context.resolve",
      version: "1.0.0",
      access: "read",
      permission: "context.resolve",
      description: "Read the immutable deterministic daily-report Evidence Pack.",
    },
    {
      name: "ai.gateway.complete",
      version: "1.0.0",
      access: "read",
      permission: "ai.gateway.complete",
      description: "Generate a validated decision narrative through the unified AI Gateway.",
    },
    {
      name: "agent.task.create",
      version: "1.0.0",
      access: "lifecycle",
      permission: "agent.task.lifecycle",
      description: "Create this Agent run's Foundation task.",
    },
    {
      name: "agent.task.transition",
      version: "1.0.0",
      access: "lifecycle",
      permission: "agent.task.lifecycle",
      description: "Transition this Agent run's Foundation task.",
    },
    {
      name: "agent.task.lease.acquire",
      version: "1.0.0",
      access: "lifecycle",
      permission: "agent.task.lifecycle",
      description: "Acquire the execution lease for this Agent run.",
    },
    {
      name: "agent.task.lease.release",
      version: "1.0.0",
      access: "lifecycle",
      permission: "agent.task.lifecycle",
      description: "Release the execution lease for this Agent run.",
    },
  ],
  output_schema: {
    id: OUTPUT_SCHEMA_ID,
    version: DAILY_REPORT_AGENT_VERSION,
    schema: {
      type: "object",
      required: ["headline", "executiveSummary", "sections", "dataLimitations"],
      properties: {
        headline: { type: "string" },
        executiveSummary: { type: "string" },
        sections: { type: "object" },
        dataLimitations: { type: "array" },
      },
    },
  },
  permission: {
    mode: "recommend",
    task_domain: "growth",
    scopes: ["agent.task.lifecycle", "ai.gateway.complete", "context.resolve"],
    requires_human_approval: false,
  },
});

function text(value, fallback = "", maximum = 800) {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, maximum);
}

function list(value, maximum) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function normalizeEvidence(value) {
  return list(value, 6).map((item) => text(item, "", 240)).filter(Boolean);
}

function normalizeFinding(value) {
  const normalizedPriority = text(value?.priority, "P2", 2).toUpperCase();
  return {
    priority: PRIORITIES.has(normalizedPriority) ? normalizedPriority : "P2",
    objectType: text(value?.objectType, "business_object", 60),
    objectName: text(value?.objectName, "需要运营核查的对象", 160),
    dataChange: text(value?.dataChange, "当前数据变化需结合证据核查。", 300),
    impactScale: text(value?.impactScale, "影响规模以 Evidence Pack 的确定性指标为准。", 300),
    reason: text(value?.reason, "当前证据只能确认异常，具体原因仍需人工核查。", 500),
    recommendedAction: text(value?.recommendedAction, "请核对业务现场后再执行运营动作。", 500),
    evidence: normalizeEvidence(value?.evidence),
  };
}

function normalizeSection(value) {
  return {
    summary: text(value?.summary, "当前模块未形成额外的高优先级判断。", 500),
    findings: list(value?.findings, 3).filter((item) => item && typeof item === "object").map(normalizeFinding),
  };
}

function normalizeOutput(value) {
  const sections = {};
  for (const key of DAILY_REPORT_SECTION_KEYS) {
    sections[key] = normalizeSection(value?.sections?.[key]);
  }
  return {
    headline: text(value?.headline, "经营数据已完成决策分析", 160),
    executiveSummary: text(
      value?.executiveSummary,
      "系统已根据确定性证据筛选重点异常、风险与机会，请按模块核查建议动作。",
      800,
    ),
    sections,
    dataLimitations: list(value?.dataLimitations, 8).map((item) => text(item, "", 300)).filter(Boolean),
  };
}

export const DAILY_REPORT_AGENT_OUTPUT_VALIDATOR = createJsonObjectOutputValidator({
  schemaId: `${OUTPUT_SCHEMA_ID}@${DAILY_REPORT_AGENT_VERSION}`,
  validate(value) {
    if (typeof value.headline !== "string" || typeof value.executiveSummary !== "string") return false;
    if (!value.sections || typeof value.sections !== "object") return false;
    if (!Array.isArray(value.dataLimitations)) return false;
    return DAILY_REPORT_SECTION_KEYS.every((key) => {
      const section = value.sections[key];
      return section
        && typeof section.summary === "string"
        && Array.isArray(section.findings)
        && section.findings.every((finding) => finding && typeof finding === "object" && !Array.isArray(finding));
    });
  },
});
const outputValidator = DAILY_REPORT_AGENT_OUTPUT_VALIDATOR;

function resolveModel(value) {
  const raw = String(value || "deepseek-v4-flash").trim();
  const normalized = raw === "deepseek-v4" || raw === "deepseek-chat"
    ? "deepseek-v4-flash"
    : raw;
  return SUPPORTED_MODELS.has(normalized) ? normalized : "deepseek-v4-flash";
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function promptFor(context) {
  return [
    "你是 Commerce Ops 的电商运营决策日报 Agent。",
    "输入是由代码生成的 Evidence Pack，不是原始订单、库存或商品明细。金额、环比、排名、异常排序、影响规模和 Top N 已由确定性代码完成。",
    "禁止重新计算、补数、改变排序、扩展样本或虚构原因。你只负责解释证据、识别需要核查的可能原因，并给出人工执行建议。",
    "必须完整输出六个模块：经营概览、店铺异常、商品/SKU异常、库存风险、商业机会、近7日趋势。没有重点发现时保留模块并明确写出。",
    "每条 finding 必须包含对象、数据变化、影响规模、判断原因、建议动作和可核对证据。对象名称和数字必须来自 Evidence Pack。",
    "每个模块最多输出 3 条 finding；经营概览最多输出 2 条。优先选择高优先级且影响规模最大的对象，不要把 Evidence Pack 全部复述一遍。",
    "reason 必须区分已证实事实与待核查假设，不得把流量、广告、Listing、价格等未提供信息写成既定原因。",
    "recommendedAction 必须具体、可执行且需要人工确认；不得自动改价、补货、刊登、同步库存或通知个人。",
    "经营概览用于给管理者说明今天最重要的结论；其他模块优先分析高优先级且影响规模大的对象，避免平均用力。",
    "只返回严格 JSON，不要 Markdown 或代码块。结构如下：",
    JSON.stringify({
      headline: "一句话决策结论",
      executiveSummary: "两到三句管理层摘要",
      sections: Object.fromEntries(DAILY_REPORT_SECTION_KEYS.map((key) => [key, {
        summary: "模块判断",
        findings: [{
          priority: "P0|P1|P2|P3",
          objectType: "store|product|sku|style|inventory|opportunity|portfolio",
          objectName: "具体对象名称",
          dataChange: "本期、上期、绝对变化或环比",
          impactScale: "影响金额、销量、库存价值或机会金额",
          reason: "已证实判断，以及明确标记的待核查原因",
          recommendedAction: "人工核查或运营动作",
          evidence: ["Evidence Pack 中可核对的对象与数字"],
        }],
      }])),
      dataLimitations: ["数据窗口、来源或口径限制"],
    }),
    `Evidence Pack：${JSON.stringify(context.data.facts)}`,
  ].join("\n");
}

function flattenFindings(output) {
  return DAILY_REPORT_SECTION_KEYS.flatMap((key) => (
    output.sections[key].findings.map((finding) => ({ ...finding, section: key }))
  ));
}

function analysisEnvelope({ output, context, result, model, taskId, generatedAt }) {
  const id = fingerprint({ context: context.data.factsDigest, output }).slice(0, 16);
  const findings = flattenFindings(output);
  return {
    id,
    agentTaskId: taskId,
    generatedAt: generatedAt.toISOString(),
    provider: result.provider || "deepseek",
    model,
    promptVersion: DAILY_REPORT_AGENT_PROMPT_VERSION,
    evidencePackVersion: context.data.evidencePackContract,
    evidencePackDigest: context.data.factsDigest,
    scope: context.data.facts.selectedFilters,
    period: context.data.facts.period,
    sources: context.data.facts.sources,
    usage: result.usage || null,
    analysis: {
      headline: output.headline,
      overview: output.executiveSummary,
      conclusions: findings,
      recommendations: findings.map((finding) => ({
        priority: finding.priority,
        title: finding.objectName,
        action: finding.recommendedAction,
        reason: finding.reason,
        evidence: finding.evidence,
        section: finding.section,
      })),
      risks: findings.filter((finding) => (
        ["P0", "P1"].includes(finding.priority)
        || ["inventoryRisks", "storeAnomalies", "productAnomalies"].includes(finding.section)
      )),
      dataLimitations: output.dataLimitations,
      modules: output.sections,
      fullReport: output,
    },
    cached: false,
  };
}

export class DailyReportAgent {
  constructor({
    runtime,
    configured = false,
    model = "deepseek-v4-flash",
    leaseTtlMs = 180_000,
  } = {}) {
    this.runtime = assertAgentRuntimeScope(runtime);
    this.configured = Boolean(configured);
    this.model = resolveModel(model);
    this.leaseTtlMs = leaseTtlMs;
    this.definition = this.runtime.definition;
  }

  status() {
    return {
      configured: this.configured,
      name: this.definition.name,
      version: this.definition.version,
      model: this.model,
      promptVersion: DAILY_REPORT_AGENT_PROMPT_VERSION,
    };
  }

  async run({
    contextInput,
    generatedAt = this.runtime.now(),
    requestId,
    idempotencyKey = requestId,
    correlationId = requestId,
    requestedBy = "sales-assortment-scheduler",
  } = {}) {
    if (!this.configured) {
      throw Object.assign(new Error("Daily Report Agent is not configured."), {
        code: "AI_NOT_CONFIGURED",
      });
    }
    if (!contextInput || typeof contextInput !== "object" || Array.isArray(contextInput)) {
      throw Object.assign(new TypeError("Prepared Daily Report Context input is required"), {
        code: "DAILY_REPORT_CONTEXT_INPUT_REQUIRED",
      });
    }
    const contextInvocation = await this.runtime.resolveContext({
      request_id: requestId,
      requested_by: requestedBy,
      context_name: "daily_report",
      context_version: "2.1.0",
      input: contextInput,
    });
    const context = contextInvocation.result;
    const task = (await this.runtime.executeTool({
      request_id: requestId,
      requested_by: requestedBy,
      tool_name: "agent.task.create",
      input: {
        idempotency_key: idempotencyKey,
        correlation_id: correlationId,
        priority: "P2",
        context_refs: [{ type: "daily_report", version: "2.1.0", id: context.subject.id }],
        execution_runtime: "daily_report_agent_v2_1",
      },
    })).result;
    if (task.state !== "PENDING") {
      throw Object.assign(new Error(`Daily Report Agent task is already ${task.state}.`), {
        code: "DAILY_REPORT_AGENT_TASK_NOT_PENDING",
        taskId: task.id,
      });
    }
    const leaseResult = (await this.runtime.executeTool({
      request_id: requestId,
      requested_by: requestedBy,
      tool_name: "agent.task.lease.acquire",
      input: {
        task_id: task.id,
        lease_owner: `daily-report-agent:${process.pid}`,
        ttl_ms: this.leaseTtlMs,
      },
    })).result;
    const lease = leaseResult.lease;
    if (!lease) {
      throw Object.assign(new Error("Daily Report Agent task lease is busy."), {
        code: "DAILY_REPORT_AGENT_LEASE_BUSY",
        taskId: task.id,
      });
    }

    let running = null;
    try {
      running = (await this.runtime.executeTool({
        request_id: requestId,
        requested_by: requestedBy,
        tool_name: "agent.task.transition",
        input: {
          task_id: task.id,
          to_state: "RUNNING",
          options: {
            actorId: requestedBy,
            reasonCode: "AGENT_EXECUTION_STARTED",
            evidence: {
              context_digest: context.data.factsDigest,
              evidence_pack_version: context.data.evidencePackContract,
              prompt_id: "sales-assortment.daily-report-agent",
              prompt_version: DAILY_REPORT_AGENT_PROMPT_VERSION,
            },
          },
        },
      })).result;
      const gatewayInvocation = await this.runtime.executeTool({
        request_id: requestId,
        requested_by: requestedBy,
        tool_name: "ai.gateway.complete",
        input: {
          task_id: task.id,
          module_id: "sales_assortment",
          operation: "generate_daily_report_agent_v2_1",
          request_id: requestId,
          prompt_id: "sales-assortment.daily-report-agent",
          prompt_version: DAILY_REPORT_AGENT_PROMPT_VERSION,
          model: this.model,
          temperature: 0.1,
          max_tokens: 4096,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          output_schema_id: outputValidator.schemaId,
          messages: [
            {
              role: "system",
            content: "你是只基于确定性 Evidence Pack 工作的电商运营决策日报 Agent，输出严格 JSON。",
            },
            { role: "user", content: promptFor(context) },
          ],
        },
      });
      const result = gatewayInvocation.result;
      if (!result?.success) {
        throw Object.assign(new Error(result?.errorMessage || "Daily Report Agent model request failed."), {
          code: result?.errorCode || "AI_PROVIDER_ERROR",
          requestId: result?.requestId || requestId,
        });
      }
      const output = normalizeOutput(result.validatedOutput);
      const analysis = analysisEnvelope({
        output,
        context,
        result,
        model: this.model,
        taskId: task.id,
        generatedAt: this.runtime.now(),
      });
      const completed = (await this.runtime.executeTool({
        request_id: requestId,
        requested_by: requestedBy,
        tool_name: "agent.task.transition",
        input: {
          task_id: task.id,
          to_state: "SUCCEEDED",
          options: {
            actorId: requestedBy,
            reasonCode: "AGENT_OUTPUT_VALIDATED",
            evidence: {
              context_digest: context.data.factsDigest,
              evidence_pack_version: context.data.evidencePackContract,
              analysis_id: analysis.id,
              output_schema_id: result.outputSchemaId,
              output_valid: result.outputValid,
            },
            result: {
              analysis_id: analysis.id,
              generated_at: analysis.generatedAt,
              provider: analysis.provider,
              model: analysis.model,
              prompt_version: analysis.promptVersion,
              output_schema_id: result.outputSchemaId,
              context_digest: context.data.factsDigest,
              evidence_pack_version: context.data.evidencePackContract,
              usage: analysis.usage,
              analysis: output,
            },
          },
        },
      })).result;
      return { task: completed, context, analysis };
    } catch (error) {
      if (running) {
        try {
          await this.runtime.executeTool({
            request_id: requestId,
            requested_by: requestedBy,
            tool_name: "agent.task.transition",
            input: {
              task_id: task.id,
              to_state: "FAILED",
              options: {
                actorId: requestedBy,
                reasonCode: error.code || "AGENT_EXECUTION_FAILED",
                message: String(error.message || "Daily Report Agent execution failed").slice(0, 500),
                errorCode: error.code || "AGENT_EXECUTION_FAILED",
                errorMessage: String(error.message || "Daily Report Agent execution failed").slice(0, 500),
                evidence: {
                  context_digest: context.data.factsDigest,
                  evidence_pack_version: context.data.evidencePackContract,
                },
              },
            },
          });
        } catch {
          // Preserve the original provider or validation error for the scheduler fallback.
        }
      }
      throw error;
    } finally {
      await this.runtime.executeTool({
        request_id: requestId,
        requested_by: requestedBy,
        tool_name: "agent.task.lease.release",
        input: { task_id: task.id, lease_token: lease.leaseToken },
      }).catch(() => false);
    }
  }
}
