import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openSchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const db = openSchedulerDatabase({ rootDir });
const versions = db.db.prepare("SELECT version,applied_at FROM schema_migrations ORDER BY version").all();
console.log(`Database: ${db.databasePath}`);
for (const migration of versions) console.log(`${migration.version} ${migration.applied_at}`);
db.close();
