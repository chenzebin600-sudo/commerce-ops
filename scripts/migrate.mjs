import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openSchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const db = openSchedulerDatabase({ rootDir: runtimeConfig.appRoot, databasePath: runtimeConfig.databasePath });
const versions = db.db.prepare("SELECT version,applied_at FROM schema_migrations ORDER BY version").all();
console.log("Database migrations:");
for (const migration of versions) console.log(`${migration.version} ${migration.applied_at}`);
db.close();
