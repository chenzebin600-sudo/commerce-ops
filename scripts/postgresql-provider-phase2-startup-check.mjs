import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openProviderDomainDataAccess } from "../lib/data/provider-domain-data-access.mjs";
import { resolveShadowSqliteSnapshot } from "../lib/postgresql/incremental-sync/shadow-snapshot-resolver.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { AiContextService } from "../lib/ai/context/ai-context-service.mjs";
import { DailyReportContextService } from "../lib/ai/context/daily-report-context-service.mjs";
import { registerDailyReportContext } from "../lib/ai/context/daily-report-context-registration.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";
import { AgentRuntime } from "../lib/ai/agent/agent-runtime.mjs";
import { AiGateway } from "../lib/ai/ai-gateway.mjs";
import {
  DAILY_REPORT_AGENT_DEFINITION,
  DAILY_REPORT_AGENT_OUTPUT_VALIDATOR,
  DailyReportAgent,
} from "../lib/sales-assortment/daily-report-agent.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const providerName = String(
  process.argv.find((argument) => argument.startsWith("--provider="))?.split("=")[1] || "sqlite",
).trim().toLowerCase();
if (!new Set(["sqlite", "postgres"]).has(providerName)) {
  throw new TypeError("Startup check provider must be sqlite or postgres");
}

const snapshotPath = resolveShadowSqliteSnapshot({ rootDir });
if (providerName === "sqlite" && !fs.existsSync(snapshotPath)) {
  throw new Error(`PostgreSQL Shadow SQLite snapshot is missing: ${snapshotPath}`);
}

const dataAccess = openProviderDomainDataAccess({
  rootDir,
  databasePath: providerName === "sqlite" ? snapshotPath : undefined,
  env: providerName === "sqlite"
    ? { DATABASE_PROVIDER: "sqlite" }
    : { ...process.env, DATABASE_PROVIDER: "postgres", POSTGRES_SHADOW_MODE: "true" },
  sqliteReadOnly: providerName === "sqlite",
});

try {
  const { repositories } = dataAccess;
  const [products, sales, inventory, tasks, audit, monitoring] = await Promise.all([
    repositories.products.getProducts({ page: 1, pageSize: 1 }),
    repositories.sales.getSalesSummary(),
    repositories.inventory.getInventorySnapshot(),
    repositories.tasks.listTasks({ limit: 1 }),
    repositories.audit.summary(),
    repositories.monitoring.summary({}),
  ]);
  const foundation = new FoundationService({ repository: repositories.raw.foundation });
  const foundationStatus = await foundation.status();
  const contextService = new AiContextService({ repository: repositories.context });
  const dailyReportContextService = new DailyReportContextService();
  registerDailyReportContext({
    registry: contextService.registry,
    contextService: dailyReportContextService,
  });

  const gateway = new AiGateway({
    provider: {
      async complete() {
        throw new Error("Phase 2 startup check must not call an external AI provider");
      },
    },
  });
  const auditService = Object.freeze({
    async recordSafely() {
      throw new Error("Phase 2 startup check must not write audit events");
    },
  });
  const runtime = new AgentRuntime({
    taskService: foundation.tasks,
    contextRegistry: contextService.registry,
    toolRegistry: new AgentToolRegistry(),
    gateway,
    auditService,
  });
  runtime.createAgent({
    definition: DAILY_REPORT_AGENT_DEFINITION,
    Agent: DailyReportAgent,
    options: { configured: false, model: "deepseek-v4-flash" },
    outputValidator: DAILY_REPORT_AGENT_OUTPUT_VALIDATOR,
  });

  const registeredDailyReport = runtime.get(
    DAILY_REPORT_AGENT_DEFINITION.name,
    DAILY_REPORT_AGENT_DEFINITION.version,
  );
  assert.equal(registeredDailyReport?.name, "sales.daily-report");
  assert.equal(foundationStatus.ready, true);
  if (providerName === "postgres") {
    const identity = await dataAccess.provider.query(
      "SELECT current_database() database,current_user username,current_schema() schema,current_setting('default_transaction_read_only') read_only",
    );
    assert.deepEqual(identity.rows[0], {
      database: "commerce_ops_shadow",
      username: "commerce_app",
      schema: "app",
      read_only: "on",
    });
  }

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    contractVersion: "COMMERCE-OPS-PG-PROVIDER-2.0.0",
    provider: dataAccess.name,
    mode: dataAccess.mode,
    target: dataAccess.target,
    readOnly: true,
    repositories: {
      productCount: products.total,
      orderCount: sales.orderCount,
      inventoryRows: inventory.rowCount,
      taskSample: tasks.length,
      auditEvents: audit.byStatus.reduce((total, row) => total + row.count, 0),
    },
    foundation: foundationStatus,
    contextTypes: contextService.list().map((entry) => `${entry.type}@${entry.version}`),
    dailyReportAgent: `${registeredDailyReport.name}@${registeredDailyReport.version}`,
    monitoring: { totalRuns: monitoring.totalRuns, totalToolCalls: monitoring.toolCalls },
    externalCalls: 0,
    writes: 0,
  }, null, 2)}\n`);
} finally {
  await dataAccess.close();
}
