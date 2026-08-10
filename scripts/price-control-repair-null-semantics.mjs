import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { PriceControlService } from "../lib/price-control/price-control-service.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const dataAccess = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: process.env,
});
const foundation = new FoundationService({ repository: dataAccess.repositories.foundation });
const audit = createOperationAuditService({ repository: dataAccess.repositories.audit, env: process.env });
const service = new PriceControlService({
  repository: dataAccess.repositories.priceControl,
  foundationRepository: dataAccess.repositories.foundation,
  foundationTaskService: foundation.tasks,
  audit,
});

try {
  const result = await service.repairNullSemantics({ requestedBy: "price-control-repair-cli" });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await dataAccess.close();
}
