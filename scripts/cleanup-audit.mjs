import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);

const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS || 180);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const dataAccess = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: process.env,
});
try {
  const audit = createOperationAuditService({ repository: dataAccess.repositories.audit, env: process.env });
  const deleted = await audit.cleanupExpired({ retentionDays });
  await audit.recordSafely({
    module: "audit",
    action: "audit.retention.cleanup",
    status: "success",
    actorType: "maintenance_script",
    metadata: { retentionDays, cleanupDeleted: deleted },
  });
  console.log(`Audit retention cleanup completed: deleted=${deleted}, retentionDays=${retentionDays}`);
} finally {
  await dataAccess.close();
}
