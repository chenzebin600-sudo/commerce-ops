import { assertDatabaseProvider } from "./database-provider.mjs";
import { ProductCatalogRepository } from "./repositories/product-catalog-repository.mjs";
import { FoundationRepository } from "../foundation/foundation-repository.mjs";
import { SalesAssortmentRepository } from "../sales-assortment/sales-assortment-repository.mjs";
import { ProviderAuditRepository } from "./provider-audit-repository.mjs";
import { AiContextRepository } from "../ai/context/ai-context-repository.mjs";
import { AgentObservabilityRepository } from "../ai/observability/agent-observability-repository.mjs";

export function createProviderDomainRepositories({ provider }) {
  const resolved = assertDatabaseProvider(provider);
  const productCatalog = new ProductCatalogRepository({ provider: resolved });
  const salesAssortment = new SalesAssortmentRepository({ provider: resolved });
  const foundation = new FoundationRepository({ provider: resolved });
  const auditRepository = new ProviderAuditRepository({ provider: resolved });
  const aiContext = new AiContextRepository({ provider: resolved });
  const agentObservability = new AgentObservabilityRepository({ provider: resolved });

  return Object.freeze({
    dialect: resolved.dialect,
    products: Object.freeze({
      getProducts: (input = {}) => productCatalog.list(input),
      getProduct: (id) => productCatalog.get(id),
      getIdentitySet: () => productCatalog.listIdentitySet(),
    }),
    sales: Object.freeze({
      getSalesSummary: (input = {}) => salesAssortment.salesSummary(input),
      getSalesRows: (input = {}) => salesAssortment.currentOrderRows(input),
      getIdentitySet: () => salesAssortment.salesIdentitySet(),
    }),
    inventory: Object.freeze({
      getInventorySnapshot: () => salesAssortment.inventorySnapshotSummary(),
      getInventoryRows: () => salesAssortment.latestInventoryRows(),
    }),
    tasks: Object.freeze({
      getTask: (id) => foundation.getTask(id),
      listTasks: (input = {}) => foundation.listTasks(input),
    }),
    audit: Object.freeze({
      getEvent: (id) => auditRepository.get(id),
      listEvents: (input = {}) => auditRepository.query(input),
      getIdentitySet: () => auditRepository.listIdentitySet(),
      summary: (input = {}) => auditRepository.summary(input),
    }),
    context: aiContext,
    monitoring: agentObservability,
    raw: Object.freeze({ productCatalog, salesAssortment, foundation, auditRepository }),
  });
}
