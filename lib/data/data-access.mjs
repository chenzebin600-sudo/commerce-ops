import path from "node:path";
import { SchedulerDatabase } from "../mabang-scheduler/db.mjs";
import { ExportFileRepository } from "../files/file-repository.mjs";
import { FileLifecycleRepository } from "../files/file-lifecycle-repository.mjs";
import { FileReviewRepository } from "../files/file-review-repository.mjs";
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
import { SqliteAuditRepository } from "./sqlite/sqlite-audit-repository.mjs";
import { SqliteProvider } from "./sqlite/sqlite-provider.mjs";

export function openCommerceDataAccess({ rootDir, databasePath, migrationsDir = null }) {
  const provider = new SqliteProvider({ databasePath });
  const scheduler = new SchedulerDatabase({
    databasePath,
    migrationsDir: migrationsDir || path.join(rootDir, "migrations"),
    provider,
  });
  scheduler.migrate();

  const repositories = Object.freeze({
    scheduler,
    accounts: new AccountRepository({ schedulerRepository: scheduler }),
    scheduledTasks: new ScheduledTaskRepository({ schedulerRepository: scheduler }),
    scheduledRuns: new ScheduledRunRepository({ schedulerRepository: scheduler }),
    exportFiles: new ExportFileRepository({ db: provider }),
    audit: new SqliteAuditRepository({ provider }),
    fileLifecycle: new FileLifecycleRepository({ db: provider }),
    fileReview: new FileReviewRepository({ db: provider }),
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
  });

  return Object.freeze({
    provider,
    transactionManager: provider.transactionManager,
    repositories,
    close: () => provider.close(),
  });
}
