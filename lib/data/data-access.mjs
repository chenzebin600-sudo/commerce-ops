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
import { ShopeeHealthRepository } from "../shopee-health/repository.mjs";
import { ShopeeAdvertisingRepository } from "../advertising/shopee-advertising-repository.mjs";
import { SqliteAuditRepository } from "./sqlite/sqlite-audit-repository.mjs";
import { SqliteProvider } from "./sqlite/sqlite-provider.mjs";
function normalizeDatabaseProvider(value) {
  const selected = String(value || "sqlite").trim().toLowerCase();
  if (selected === "postgresql") return "postgres";
  if (selected === "sqlite" || selected === "postgres") return selected;
  throw new Error("DATABASE_PROVIDER must be sqlite or postgres");
}

function repositoriesFor({ provider, scheduler, postgresql = null }) {
  return Object.freeze({
    scheduler,
    accounts: new AccountRepository({ schedulerRepository: scheduler }),
    scheduledTasks: new ScheduledTaskRepository({ schedulerRepository: scheduler }),
    scheduledRuns: new ScheduledRunRepository({ schedulerRepository: scheduler }),
    exportFiles: postgresql ? new postgresql.PostgresqlExportFileRepository({ provider }) : new ExportFileRepository({ db: provider }),
    audit: postgresql ? new postgresql.PostgresqlAuditRepository({ provider }) : new SqliteAuditRepository({ provider }),
    fileLifecycle: postgresql ? new postgresql.PostgresqlFileLifecycleRepository({ provider }) : new FileLifecycleRepository({ db: provider }),
    fileReview: postgresql ? new postgresql.PostgresqlFileReviewRepository({ provider }) : new FileReviewRepository({ db: provider }),
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
    shopeeHealth: postgresql ? new postgresql.PostgresqlShopeeHealthRepository({ provider }) : new ShopeeHealthRepository({ provider }),
    shopeeAdvertising: postgresql ? new postgresql.PostgresqlShopeeAdvertisingRepository({ provider }) : new ShopeeAdvertisingRepository({ provider }),
  });
}

function dataAccess(provider, repositories) {
  return Object.freeze({ provider, transactionManager: provider.transactionManager, repositories, close: () => provider.close() });
}

export function openCommerceDataAccess({ rootDir, databasePath, migrationsDir = null, providerName = "sqlite",
  postgresqlConfig = null, credentials = {}, PoolClass } = {}) {
  const selected = normalizeDatabaseProvider(providerName);
  if (selected === "postgres") {
    return Promise.all([
      import("./open-provider.mjs"), import("./postgresql/postgresql-scheduler-repository.mjs"),
      import("./postgresql/postgresql-file-repositories.mjs"), import("./postgresql/postgresql-audit-repository.mjs"),
      import("./postgresql/postgresql-file-lifecycle-repository.mjs"), import("./postgresql/postgresql-file-review-repository.mjs"),
      import("../shopee-health/postgresql-repository.mjs"), import("../advertising/postgresql-shopee-advertising-repository.mjs"),
    ]).then(async ([providerModule, schedulerModule, fileModule, auditModule, lifecycleModule, reviewModule, healthModule, advertisingModule]) => {
      const provider = await providerModule.openProvider({ providerName: selected, databasePath, postgresqlConfig, credentials, PoolClass });
      const postgresql = { ...fileModule, ...auditModule, ...lifecycleModule, ...reviewModule, ...healthModule, ...advertisingModule };
      const scheduler = new schedulerModule.PostgresqlSchedulerRepository({ provider });
      return dataAccess(provider, repositoriesFor({ provider, scheduler, postgresql }));
    });
  }
  const provider = new SqliteProvider({ databasePath });
  const scheduler = new SchedulerDatabase({
    databasePath,
    migrationsDir: migrationsDir || path.join(rootDir, "migrations"),
    provider,
  });
  scheduler.migrate();

  return dataAccess(provider, repositoriesFor({ provider, scheduler }));
}

export async function openConfiguredCommerceDataAccess({ runtimeConfig, env = process.env, PoolClass } = {}) {
  if (!runtimeConfig) throw new TypeError("Runtime configuration is required");
  if (runtimeConfig.databaseProvider !== "postgres") {
    return openCommerceDataAccess({ rootDir: runtimeConfig.appRoot, databasePath: runtimeConfig.databasePath,
      providerName: runtimeConfig.databaseProvider });
  }
  const password = String(env.POSTGRES_APP_PASSWORD || "");
  if (!password) throw new Error("POSTGRES_APP_PASSWORD is required");
  const { loadSharedPostgresqlConfig } = await import("./postgresql/shared-runtime-config.mjs");
  const postgresqlConfig = loadSharedPostgresqlConfig({ rootDir: runtimeConfig.appRoot, env });
  return openCommerceDataAccess({ rootDir: runtimeConfig.appRoot, databasePath: runtimeConfig.databasePath,
    providerName: "postgres", postgresqlConfig, credentials: { password }, PoolClass });
}
