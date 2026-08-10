import path from "node:path";
import { SchedulerDatabase } from "./sqlite/sqlite-scheduler-repository.mjs";
import { createDatabaseProvider, DATABASE_PROVIDER_NAMES } from "./database-provider-factory.mjs";
import { ProviderSchedulerRepository } from "./provider-scheduler-repository.mjs";
import { ProviderExportFileRepository } from "../files/provider-export-file-repository.mjs";
import { ProviderFileLifecycleRepository } from "../files/provider-file-lifecycle-repository.mjs";
import { ProviderFileReviewRepository } from "../files/provider-file-review-repository.mjs";
import { AccountRepository } from "./repositories/account-repository.mjs";
import { ScheduledTaskRepository } from "./repositories/scheduled-task-repository.mjs";
import { ScheduledRunRepository } from "./repositories/scheduled-run-repository.mjs";
import { ProductImportRepository } from "./repositories/product-import-repository.mjs";
import { ProductCatalogRepository } from "./repositories/product-catalog-repository.mjs";
import { ProductAiContentRepository } from "./repositories/product-ai-content-repository.mjs";
import { ProductListingRepository } from "./repositories/product-listing-repository.mjs";
import { ProductImageGenerationRepository } from "./repositories/product-image-generation-repository.mjs";
import { GrowthRadarRepository } from "./repositories/growth-radar-repository.mjs";
import { GrowthRadarV2Repository } from "../growth-radar/v2/growth-radar-v2-repository.mjs";
import { MabangImageRepository } from "../mabang-images/repository.mjs";
import { FoundationRepository } from "../foundation/foundation-repository.mjs";
import { SalesAssortmentRepository } from "../sales-assortment/sales-assortment-repository.mjs";
import { AiContextRepository } from "../ai/context/ai-context-repository.mjs";
import { AgentObservabilityRepository } from "../ai/observability/agent-observability-repository.mjs";
import { PriceControlRepository } from "../price-control/price-control-repository.mjs";
import { PriceControlRepricingRepository } from "../price-control/price-control-repricing-repository.mjs";
import { CommerceShopRegistryRepository } from "../shops/commerce-shop-registry-repository.mjs";
import { ProductPackageSyncRepository } from "../product-package-sync/product-package-sync-repository.mjs";
import { ProviderAuditRepository } from "./provider-audit-repository.mjs";
import { CustomerServiceRepository } from "../customer-service/customer-service-repository.mjs";
import { ProfitRepository } from "../profit/profit-repository.mjs";
import { ProductKnowledgeRepository } from "../product-knowledge/product-knowledge-repository.mjs";

export function openProviderRuntimeDataAccess({
  rootDir,
  databasePath,
  migrationsDir = null,
  env = process.env,
  selection = null,
  postgresqlConfig = null,
  postgresqlPool = null,
} = {}) {
  const selected = selection || createDatabaseProvider({
    rootDir,
    databasePath,
    env,
    postgresqlConfig,
    postgresqlPool,
  });
  const provider = selected.provider;

  if (selected.name === DATABASE_PROVIDER_NAMES.SQLITE) {
    const migrator = new SchedulerDatabase({
      databasePath,
      migrationsDir: migrationsDir || path.join(rootDir, "migrations"),
      provider,
    });
    migrator.migrate();
  }

  const exportFiles = new ProviderExportFileRepository({ provider });
  const scheduler = new ProviderSchedulerRepository({ provider, exportFiles });
  const repositories = Object.freeze({
    scheduler,
    accounts: new AccountRepository({ schedulerRepository: scheduler }),
    scheduledTasks: new ScheduledTaskRepository({ schedulerRepository: scheduler }),
    scheduledRuns: new ScheduledRunRepository({ schedulerRepository: scheduler }),
    exportFiles,
    audit: new ProviderAuditRepository({ provider }),
    fileLifecycle: new ProviderFileLifecycleRepository({ provider }),
    fileReview: new ProviderFileReviewRepository({ provider }),
    productImports: new ProductImportRepository({ provider }),
    productCatalog: new ProductCatalogRepository({ provider }),
    productAiContents: new ProductAiContentRepository({ provider }),
    productListings: new ProductListingRepository({ provider }),
    productImageGenerations: new ProductImageGenerationRepository({ provider }),
    growthRadar: new GrowthRadarRepository({ provider }),
    growthRadarV2: new GrowthRadarV2Repository({ provider }),
    mabangImages: new MabangImageRepository({ provider }),
    foundation: new FoundationRepository({ provider }),
    salesAssortment: new SalesAssortmentRepository({ provider }),
    aiContext: new AiContextRepository({ provider }),
    agentObservability: new AgentObservabilityRepository({ provider }),
    priceControl: new PriceControlRepository({ provider }),
    priceControlRepricing: new PriceControlRepricingRepository({ provider }),
    commerceShops: new CommerceShopRegistryRepository({ provider }),
    productPackageSync: provider.dialect === "postgresql" ? new ProductPackageSyncRepository({ provider }) : null,
    customerService: new CustomerServiceRepository({ provider }),
    profit: new ProfitRepository({ provider }),
    productKnowledge: new ProductKnowledgeRepository({ provider }),
  });

  let closed = false;
  return Object.freeze({
    name: selected.name,
    mode: selected.mode,
    target: selected.target,
    provider,
    transactionManager: provider.transactionManager,
    repositories,
    async close() {
      if (closed) return;
      closed = true;
      await provider.close();
    },
  });
}
