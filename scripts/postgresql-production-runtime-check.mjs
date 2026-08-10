import assert from "node:assert/strict";
import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import {
  PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
  PHASE3D_PRODUCTION_MODE_SCOPE,
} from "../lib/postgresql/phase3d-production-candidate.mjs";
import { resolveProductionOperationalContext } from "../lib/postgresql/production-operational-context.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

async function main() {
  loadLocalEnv(rootDir);
  const operational = resolveProductionOperationalContext({ env: process.env, database: PHASE3D_PRODUCTION_CANDIDATE_DATABASE });
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const env = operational.formalCutover ? process.env : {
    ...process.env,
    DATABASE_PROVIDER: "postgres",
    POSTGRES_SHADOW_MODE: "false",
    POSTGRES_STAGING_MODE: "false",
    POSTGRES_CUTOVER_REHEARSAL_MODE: "false",
    POSTGRES_PRODUCTION_CANDIDATE_MODE: "false",
    POSTGRES_PRODUCTION_MODE: "true",
    POSTGRES_PRODUCTION_CONFIRM_DATABASE: PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
    POSTGRES_PRODUCTION_CONFIRM_SCOPE: PHASE3D_PRODUCTION_MODE_SCOPE,
  };
  const access = openProviderRuntimeDataAccess({ rootDir, databasePath: runtime.databasePath, env });
  try {
    const identity = (await access.provider.query("SELECT current_database() database,current_user username,current_setting('default_transaction_read_only') read_only")).rows[0];
    assert.deepEqual(identity, { database: PHASE3D_PRODUCTION_CANDIDATE_DATABASE, username: "commerce_app", read_only: "off" });
    const [tasks, pendingRuns, schedulerStatus] = await Promise.all([
      access.repositories.scheduler.listTasks(),
      access.repositories.scheduler.pendingRuns(1),
      access.repositories.scheduler.schedulerStatus(),
    ]);
    return {
      status: "PASS",
      mode: access.mode,
      target: access.target,
      identity,
      schedulerRepository: { tasks: tasks.length, pendingRunsObserved: pendingRuns.length, statusReadable: Boolean(schedulerStatus) },
      writes: 0,
      externalCalls: 0,
      persistentProvider: operational.provider,
      processScopedValidation: !operational.formalCutover,
      persistentProviderChanged: false,
    };
  } finally {
    await access.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`PostgreSQL production runtime check failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
