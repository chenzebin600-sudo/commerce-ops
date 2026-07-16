import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openSchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);

const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS || 180);
const db = openSchedulerDatabase({ rootDir });
try {
  const audit = createOperationAuditService({ db, env: process.env });
  const deleted = audit.cleanupExpired({ retentionDays });
  audit.recordSafely({
    module: "audit",
    action: "audit.retention.cleanup",
    status: "success",
    actorType: "maintenance_script",
    metadata: { retentionDays, cleanupDeleted: deleted },
  });
  console.log(`Audit retention cleanup completed: deleted=${deleted}, retentionDays=${retentionDays}`);
} finally {
  db.close();
}
