import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../lib/ai/agent/agent-runtime.mjs";
import { AiContextRegistry } from "../lib/ai/context/ai-context-registry.mjs";
import {
  DAILY_REPORT_CONTEXT_INPUT_MAX_BYTES,
  DailyReportContextService,
} from "../lib/ai/context/daily-report-context-service.mjs";
import { registerDailyReportContext } from "../lib/ai/context/daily-report-context-registration.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";
import { FoundationTaskService } from "../lib/foundation/foundation-task-service.mjs";
import {
  buildDailyReportEvidencePack,
  DAILY_REPORT_EVIDENCE_PACK_MAX_BYTES,
  DAILY_REPORT_EVIDENCE_PACK_VERSION,
  dailyReportEvidencePackBytes,
} from "../lib/sales-assortment/daily-report-evidence-pack.mjs";
import {
  DAILY_REPORT_AGENT_NAME,
  DAILY_REPORT_AGENT_DEFINITION,
  DAILY_REPORT_AGENT_OUTPUT_VALIDATOR,
  DAILY_REPORT_AGENT_PROMPT_VERSION,
  DAILY_REPORT_AGENT_VERSION,
  DailyReportAgent,
} from "../lib/sales-assortment/daily-report-agent.mjs";
import { buildSalesAssortmentDailyReport } from "../lib/sales-assortment/sales-assortment-daily-report.mjs";

function dashboardFacts() {
  return {
    contract: "SALES-ASSORTMENT-1.0.0",
    filters: { selected: { country: "Thailand" } },
    period: { dateFrom: "2026-07-29", dateTo: "2026-08-04", dayCount: 7 },
    sourceStatus: {
      order: { source_filename: "orders.xlsx", row_count: 120, collected_at: "2026-08-05T01:00:00.000Z" },
      inventory: { source_filename: "inventory.xlsx", row_count: 80, collected_at: "2026-08-05T01:10:00.000Z" },
      productPackage: { source_filename: "products.xlsx", row_count: 60, collected_at: "2026-08-01T01:00:00.000Z" },
    },
    summary: {
      ownAmount: 120000,
      assortmentAmount: 500000,
      ownShare: 24,
      gapAmount: 380000,
      orderCount: 320,
      averageOrderValue: 375,
    },
    quality: { status: "available", limitations: [] },
    trend: [{ date: "2026-08-04", ownAmount: 20000, ownQuantity: 30, assortmentDailyAmount: 80000 }],
    stores: [{
      store: "TH Store",
      country: "Thailand",
      manager: "Owner A",
      platform: "Shopee",
      ownAmount: 50000,
      ownQuantity: 90,
      countryShare: 10,
      opportunityCount: 3,
    }],
    hierarchy: { dimension: "category", rows: [] },
    opportunityMatrix: [],
    storeSalesTrend: [{
      store: "TH Store",
      country: "Thailand",
      platform: "Shopee",
      manager: "Owner A",
      totalAmount: 50000,
      current7dAmount: 42000,
      previous7dAmount: 50000,
      changeRate: -16,
      amountChange: -8000,
      impactAmount: 8000,
      impactScore: 80,
      trendStatus: "decline",
      priority: "P1",
      points: [],
    }],
    productSalesRanking: [{
      rank: 1,
      current7dRank: 1,
      previous7dRank: 2,
      rankChange: 1,
      country: "Thailand",
      productName: "Product A",
      mainSku: "SKU-A",
      categoryL1: "Home",
      ownAmount: 30000,
      ownQuantity: 50,
      current7dAmount: 30000,
      previous7dAmount: 24000,
      changeRate: 25,
      amountChange: 6000,
      impactAmount: 6000,
      impactScore: 60,
      trendStatus: "growth",
      priority: "P1",
      points: [],
    }],
    priorityAlerts: [{
      priority: "P1",
      type: "store_decline",
      entityName: "TH Store",
      title: "TH Store sales declined",
      summary: "Current seven days are lower than the previous seven days.",
      metricLabel: "GMV impact",
      metricValue: "-8000",
      action: "Review traffic and assortment coverage.",
      evidence: ["Current 7d GMV 42000", "Previous 7d GMV 50000"],
    }],
    storeAnomalies: {
      comparisonDays: 7,
      declines: [{
        store: "TH Store",
        country: "Thailand",
        platform: "Shopee",
        manager: "Owner A",
        currentAmount: 42000,
        previousAmount: 50000,
        changeRate: -16,
        amountChange: -8000,
        impactAmount: 8000,
        priority: "P1",
      }],
      growth: [],
    },
    styleAnomalies: {
      declines: [{
        country: "Thailand",
        style: "Storage",
        categoryL1: "Home",
        categoryL2: "Organization",
        currentQuantity: 70,
        previousQuantity: 100,
        changeRate: -30,
        quantityChange: -30,
        impactQuantity: 30,
        priority: "P1",
        storeImpacts: [{
          store: "TH Store",
          manager: "Owner A",
          platform: "Shopee",
          currentQuantity: 30,
          previousQuantity: 50,
          changeRate: -40,
          quantityChange: -20,
        }],
      }],
      growth: [],
    },
    businessOpportunities: [{
      country: "Thailand",
      categoryL1: "Home",
      categoryL2: "Organization",
      style: "Storage",
      assortmentAmount: 90000,
      assortmentDailySales: 120,
      ownDailySales: 8,
      ownDailySalesShare: 6.7,
      availableQuantity: 600,
      inventoryValue: 45000,
      opportunityAmount: 84000,
      children: [{
        productName: "Product B",
        assortmentAmount: 50000,
        ownAmount: 3000,
        ownDailySalesShare: 6,
        availableQuantity: 300,
        inventoryValue: 25000,
        opportunityAmount: 47000,
      }],
    }],
    inventoryComparison: { currentBatchId: "inventory-2", previousBatchId: "inventory-1" },
    inventoryInsights: [{
      country: "Thailand",
      productName: "Product C",
      style: "Storage",
      type: "low_stock",
      priority: "P1",
      ownDailySales: 12,
      predictedDailySales: 30,
      assortmentDailyAmount: 15000,
      assortmentAmount: 105000,
      ownAmount: 10000,
      inventoryValue: 7000,
      availableQuantity: 20,
      inventoryChange: -80,
      inventoryChangeRate: -80,
      daysOfSupply: 0.7,
      action: "Check stock availability before changing platform stock.",
    }],
    dailyReport: {
      reportDate: "2026-08-04",
      summary: { alertCount: 1 },
      sections: {
        movementWindows: {
          stores7d: {
            window: {
              current: { from: "2026-07-29", to: "2026-08-04" },
              previous: { from: "2026-07-22", to: "2026-07-28" },
            },
          },
          styles7d: {
            window: {
              current: { from: "2026-07-29", to: "2026-08-04" },
              previous: { from: "2026-07-22", to: "2026-07-28" },
            },
          },
        },
      },
    },
  };
}

class MemoryFoundationRepository {
  constructor() {
    this.tasks = new Map();
    this.domainRefs = new Map();
    this.events = [];
    this.leases = new Map();
  }

  async findTaskByDomainRef(domain, type, id) {
    return this.domainRefs.get(`${domain}:${type}:${id}`) || null;
  }

  async getTask(id) {
    return this.tasks.get(id) || null;
  }

  async insertTask(input, now) {
    const task = {
      id: `task-${this.tasks.size + 1}`,
      ...input,
      input: input.input || {},
      evidence: input.evidence || {},
      result: input.result || {},
      authorityMode: input.authorityMode || "foundation",
      attemptCount: input.attemptCount || 0,
      maxAttempts: input.maxAttempts || 3,
      stateVersion: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.tasks.set(task.id, task);
    this.domainRefs.set(`${task.domain}:${task.domainRefType}:${task.domainRefId}`, task);
    return task;
  }

  async updateTask(id, changes, { expectedVersion, now }) {
    const current = this.tasks.get(id);
    assert.equal(current.stateVersion, expectedVersion);
    const next = {
      ...current,
      ...changes,
      stateVersion: current.stateVersion + 1,
      updatedAt: now.toISOString(),
    };
    this.tasks.set(id, next);
    this.domainRefs.set(`${next.domain}:${next.domainRefType}:${next.domainRefId}`, next);
    return next;
  }

  async addTaskEvent(input) {
    this.events.push(input);
  }

  async acquireTaskLease(taskId, input, now) {
    if (this.leases.has(taskId)) return null;
    const lease = {
      taskId,
      leaseOwner: input.leaseOwner,
      leaseToken: input.leaseToken,
      leaseUntil: new Date(now.getTime() + input.ttlMs).toISOString(),
    };
    this.leases.set(taskId, lease);
    return lease;
  }

  async releaseTaskLease(taskId, leaseToken) {
    const lease = this.leases.get(taskId);
    if (!lease || lease.leaseToken !== leaseToken) return false;
    this.leases.delete(taskId);
    return true;
  }
}

function successfulGateway(calls) {
  return {
    async complete(input) {
      calls.push(input);
      return {
        success: true,
        resultStatus: "succeeded",
        requestId: input.requestId,
        provider: "deepseek",
        model: input.model,
        attempts: 1,
        durationMs: 12,
        outputSchemaId: input.outputValidator.schemaId,
        outputValid: true,
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        validatedOutput: agentOutput(),
      };
    },
  };
}

function finding(objectName, overrides = {}) {
  return {
    priority: "P1",
    objectType: "store",
    objectName,
    dataChange: "Current 7d GMV 42000 vs previous 50000, down 8000 (-16%).",
    impactScale: "GMV impact 8000.",
    reason: "The decline is proven; traffic or assortment causes still require checking.",
    recommendedAction: "Review traffic, listing availability and assortment coverage before changing operations.",
    evidence: ["Current 7d GMV 42000", "Previous 7d GMV 50000"],
    ...overrides,
  };
}

function agentOutput() {
  return {
    headline: "Thailand needs attention today",
    executiveSummary: "The deterministic Evidence Pack shows a material store decline, low stock and a sizable assortment opportunity.",
    sections: {
      operatingOverview: {
        summary: "Protect the declining store and low-stock product first.",
        findings: [finding("TH Store")],
      },
      storeAnomalies: {
        summary: "One store has a material seven-day decline.",
        findings: [finding("TH Store")],
      },
      productAnomalies: {
        summary: "Product A is growing and should be monitored for continuity.",
        findings: [finding("Product A", {
          objectType: "product",
          dataChange: "Current 7d GMV 30000 vs previous 24000, up 6000 (+25%).",
          impactScale: "GMV growth impact 6000.",
          recommendedAction: "Confirm stock and listing availability before adding traffic.",
          evidence: ["Product A current 7d GMV 30000", "Previous 7d GMV 24000"],
        })],
      },
      inventoryRisks: {
        summary: "Product C has less than one day of stock cover.",
        findings: [finding("Product C", {
          objectType: "inventory",
          dataChange: "Available quantity 20 and inventory change -80.",
          impactScale: "Assortment GMV exposure 105000.",
          recommendedAction: "Confirm physical stock and inbound timing before changing platform stock.",
          evidence: ["Days of supply 0.7", "Available quantity 20"],
        })],
      },
      businessOpportunities: {
        summary: "Storage has high assortment demand with low own capture.",
        findings: [finding("Storage", {
          objectType: "opportunity",
          dataChange: "Own daily sales share is 6.7% against assortment daily sales 120.",
          impactScale: "Opportunity amount 84000 with inventory value 45000.",
          recommendedAction: "Verify online status and run a low-risk assortment test.",
          evidence: ["Opportunity amount 84000", "Own daily sales share 6.7%"],
        })],
      },
      sevenDayTrends: {
        summary: "The latest seven days are below the preceding seven days for TH Store.",
        findings: [finding("TH Store")],
      },
    },
    dataLimitations: ["The current facts do not prove the decline cause."],
  };
}

function runtime(gateway, now = () => new Date("2026-08-05T02:30:00.000Z")) {
  const repository = new MemoryFoundationRepository();
  const taskService = new FoundationTaskService({ repository, now });
  const traces = [];
  const contextRegistry = new AiContextRegistry();
  const contextService = new DailyReportContextService({ now });
  registerDailyReportContext({
    registry: contextRegistry,
    contextService,
  });
  const agentRuntime = new AgentRuntime({
    taskService,
    clock: now,
    contextRegistry,
    toolRegistry: new AgentToolRegistry(),
    gateway,
    auditService: { async recordSafely(entry) { traces.push(entry); } },
  });
  const agent = agentRuntime.createAgent({
    definition: DAILY_REPORT_AGENT_DEFINITION,
    Agent: DailyReportAgent,
    options: { configured: true },
    outputValidator: DAILY_REPORT_AGENT_OUTPUT_VALIDATOR,
  });
  return { repository, taskService, agentRuntime, agent, contextService, traces };
}

function preparedContextInput(contextService, dashboard = dashboardFacts()) {
  return contextService.prepareInput({
    dashboard,
    generatedAt: new Date("2026-08-05T02:30:00.000Z"),
  });
}

test("Daily Report Context contains only code-calculated business facts", () => {
  const contextService = new DailyReportContextService({
    now: () => new Date("2026-08-05T02:30:00.000Z"),
  });
  const input = preparedContextInput(contextService);
  const context = contextService.create({
    evidencePack: input.evidence_pack,
    generatedAt: new Date(input.generated_at),
  });

  assert.equal(context.contextType, "daily_report");
  assert.equal(context.data.deterministicMetricsOnly, true);
  assert.equal(context.data.evidencePackContract, DAILY_REPORT_EVIDENCE_PACK_VERSION);
  assert.equal(context.data.facts.reportDate, "2026-08-04");
  assert.equal(context.data.facts.operatingOverview.summary.ownAmount, 120000);
  assert.equal(context.data.facts.storeAnomalies.declines[0].changeRate, -16);
  assert.equal(context.data.facts.storeAnomalies.declines[0].impactAmount, 8000);
  assert.equal(context.data.facts.businessOpportunities[0].opportunityAmount, 84000);
  assert.equal(context.data.evidencePackBytes, dailyReportEvidencePackBytes(input.evidence_pack));
  assert.deepEqual(context.data.facts.sevenDayTrends.window.current, {
    from: "2026-07-29", to: "2026-08-04",
  });
  assert.equal(JSON.stringify(context.data.facts).includes('"daily"'), false);
  assert.equal(JSON.stringify(context.data.facts).includes('"points"'), false);
  assert.match(context.data.factsDigest, /^[a-f0-9]{64}$/);
});

test("Evidence Pack calculates the seven-day total before applying Top N selection", () => {
  const dashboard = dashboardFacts();
  dashboard.storeSalesTrend = Array.from({ length: 25 }, (_, index) => ({
    store: `Store ${index + 1}`,
    current7dAmount: 100,
    previous7dAmount: 80,
    amountChange: 20,
    impactAmount: 20,
    changeRate: 25,
    trendStatus: "growth",
    priority: "P2",
  }));

  const pack = buildDailyReportEvidencePack(dashboard);

  assert.equal(pack.sevenDayTrends.overall.currentAmount, 2500);
  assert.equal(pack.sevenDayTrends.overall.previousAmount, 2000);
  assert.equal(pack.sevenDayTrends.overall.amountChange, 500);
  assert.ok(pack.sevenDayTrends.storeGrowth.length <= 3);
});

test("oversized dashboards are compacted before Tool Runtime without losing the Evidence Pack", async () => {
  const dashboard = dashboardFacts();
  dashboard.summary.unboundedDiagnostic = "x".repeat(5 * 1024 * 1024);
  dashboard.filters.selected.unboundedDiagnostic = "y".repeat(1024 * 1024);
  const rawRuntimeInput = {
    dashboard,
    generated_at: "2026-08-05T02:30:00.000Z",
  };
  assert.ok(Buffer.byteLength(JSON.stringify(rawRuntimeInput), "utf8") > 4_194_304);

  const calls = [];
  const { agent, contextService, traces } = runtime(successfulGateway(calls));
  const contextInput = preparedContextInput(contextService, dashboard);
  const contextInputBytes = Buffer.byteLength(JSON.stringify(contextInput), "utf8");

  assert.ok(dailyReportEvidencePackBytes(contextInput.evidence_pack) <= DAILY_REPORT_EVIDENCE_PACK_MAX_BYTES);
  assert.ok(contextInputBytes <= DAILY_REPORT_CONTEXT_INPUT_MAX_BYTES);
  assert.ok(contextInputBytes < 4_194_304);
  assert.equal(JSON.stringify(contextInput).includes("x".repeat(500)), false);
  assert.equal(JSON.stringify(contextInput).includes("y".repeat(500)), false);

  const result = await agent.run({
    contextInput,
    requestId: "scheduler-run-oversized-dashboard",
    idempotencyKey: "scheduler-run-oversized-dashboard",
    correlationId: "scheduler-run-oversized-dashboard",
  });

  assert.equal(result.task.state, "SUCCEEDED");
  assert.equal(calls.length, 1);
  const contextTrace = traces.find((trace) => (
    trace.action === "agent.tool.invoke" && trace.metadata.toolName === "context.resolve"
  ));
  assert.equal(contextTrace?.status, "success");
});

test("Daily Report Agent uses Registry, Gateway and Foundation lifecycle", async () => {
  const calls = [];
  const { repository, agentRuntime, agent, contextService, traces } = runtime(successfulGateway(calls));
  const result = await agent.run({
    contextInput: preparedContextInput(contextService),
    requestId: "scheduler-run-20260805",
    idempotencyKey: "scheduler-run-20260805",
    correlationId: "scheduler-run-20260805",
  });

  assert.equal(agentRuntime.get(DAILY_REPORT_AGENT_NAME, DAILY_REPORT_AGENT_VERSION)?.name, DAILY_REPORT_AGENT_NAME);
  assert.equal(result.task.state, "SUCCEEDED");
  assert.equal(result.analysis.agentTaskId, result.task.id);
  assert.equal(result.analysis.analysis.modules.storeAnomalies.findings[0].priority, "P1");
  assert.equal(result.analysis.analysis.fullReport.sections.inventoryRisks.findings[0].objectName, "Product C");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].promptId, "sales-assortment.daily-report-agent");
  assert.equal(calls[0].promptVersion, DAILY_REPORT_AGENT_PROMPT_VERSION);
  assert.equal(calls[0].requestId, "scheduler-run-20260805");
  assert.deepEqual(calls[0].agent, {
    name: DAILY_REPORT_AGENT_NAME,
    version: DAILY_REPORT_AGENT_VERSION,
    taskId: result.task.id,
  });
  assert.match(calls[0].messages[1].content, /120000/);
  assert.match(calls[0].messages[1].content, /Evidence Pack/);
  assert.equal(calls[0].messages[1].content.includes('"trend"'), false);
  assert.deepEqual(repository.events.map((event) => event.toState), ["PENDING", "RUNNING", "SUCCEEDED"]);
  assert.equal(repository.leases.size, 0);
  assert.equal(result.task.evidence.execution_runtime, "daily_report_agent_v2_1");
  assert.equal(JSON.stringify(result.task).includes("Thailand needs attention today"), true);
  assert.equal(JSON.stringify(result.task).includes("日报上下文"), false);
  assert.equal(result.task.result.analysis_id, result.analysis.id);
  assert.equal(result.task.result.analysis.sections.businessOpportunities.findings[0].objectName, "Storage");
  assert.equal(result.task.result.evidence_pack_version, DAILY_REPORT_EVIDENCE_PACK_VERSION);
  const toolTraces = traces.filter((trace) => trace.action === "agent.tool.invoke");
  assert.deepEqual(toolTraces.map((trace) => trace.metadata.toolName), [
    "context.resolve",
    "agent.task.create",
    "agent.task.lease.acquire",
    "agent.task.transition",
    "ai.gateway.complete",
    "agent.task.transition",
    "agent.task.lease.release",
  ]);
  assert.equal(toolTraces.every((trace) => trace.status === "success"), true);
  assert.equal(toolTraces.every((trace) => /^[a-f0-9]{64}$/.test(trace.metadata.inputDigest)), true);
  assert.equal(toolTraces.every((trace) => /^[a-f0-9]{64}$/.test(trace.metadata.outputDigest)), true);
  assert.equal(JSON.stringify(traces).includes("120000"), false);

  const report = buildSalesAssortmentDailyReport({
    dashboard: dashboardFacts(),
    analysis: result.analysis,
    generatedAt: new Date("2026-08-05T02:30:00.000Z"),
  });
  assert.equal(report.version, "SALES-ASSORTMENT-DAILY-1.5.0");
  assert.match(report.markdown, /DeepSeek 运营决策 V2\.1/);
  assert.match(report.markdown, /店铺异常分析/);
  assert.match(report.markdown, /商品 \/ SKU 异常分析/);
  assert.match(report.markdown, /数据变化：/);
  assert.match(report.markdown, /影响规模：/);
  assert.match(report.markdown, /建议：/);
});

test("Daily Report Agent records a failed Foundation task and releases its lease", async () => {
  const { repository, agent, contextService } = runtime({
    async complete(input) {
      return {
        success: false,
        resultStatus: "failed",
        requestId: input.requestId,
        provider: "deepseek",
        model: input.model,
        attempts: 1,
        durationMs: 8,
        errorCode: "AI_PROVIDER_ERROR",
        errorMessage: "provider unavailable",
      };
    },
  });

  await assert.rejects(
    () => agent.run({
      contextInput: preparedContextInput(contextService),
      requestId: "scheduler-run-failed",
      idempotencyKey: "scheduler-run-failed",
    }),
    { code: "AI_PROVIDER_ERROR" },
  );
  const [task] = repository.tasks.values();
  assert.equal(task.state, "FAILED");
  assert.equal(task.lastErrorCode, "AI_PROVIDER_ERROR");
  assert.equal(repository.leases.size, 0);
  assert.deepEqual(repository.events.map((event) => event.toState), ["PENDING", "RUNNING", "FAILED"]);
});
