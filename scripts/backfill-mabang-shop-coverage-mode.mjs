import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { createDatabaseProvider } from "../lib/data/database-provider-factory.mjs";

const CONFIRMATION = "MABANG_SHOP_COVERAGE_V1";

function option(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
}

async function main() {
  const rootDir = path.resolve(import.meta.dirname, "..");
  loadLocalEnv(rootDir);
  const runtime = createDatabaseProvider({
    rootDir,
    databasePath: path.join(rootDir, "data", "commerce-ops.db"),
  });
  const provider = runtime.provider;
  try {
    const identity = (await provider.query("SELECT current_database() database,current_user username")).rows[0];
    const apply = process.argv.includes("--apply");
    if (apply && (option("confirm-database") !== identity.database || option("confirm-repair") !== CONFIRMATION)) {
      throw new Error(`Apply requires --confirm-database=${identity.database} --confirm-repair=${CONFIRMATION}`);
    }
    const eligibleSql = `
      SELECT batch.id,batch.source_scope_json->>'queryType' query_type,
             batch.source_scope_json->>'dateFrom' date_from,batch.source_scope_json->>'dateTo' date_to
      FROM growth_source_batches batch
      LEFT JOIN export_files file ON file.id=batch.source_file_id
      LEFT JOIN scheduled_export_tasks task ON task.id=file.task_id
      WHERE batch.source_type='mabang_order' AND batch.status='applied'
        AND batch.source_scope_status='confirmed'
        AND NOT (batch.source_scope_json ? 'shopCoverageMode')
        AND (
          batch.source_scope_json->>'queryType'='profit_initial_sync'
          OR (
            batch.source_scope_json->>'queryType'='scheduled_export'
            AND jsonb_typeof(task.filters_json)='array'
            AND jsonb_array_length(task.filters_json)=0
          )
        )`;
    const eligible = (await provider.query(eligibleSql)).rows;
    if (apply && eligible.length) {
      await provider.transaction(async (transaction) => {
        await transaction.execute(
          `UPDATE growth_source_batches SET
             source_scope_json=jsonb_set(source_scope_json,'{shopCoverageMode}','"ALL_VISIBLE_SHOPS"'::jsonb,true),
             updated_at=NOW()
           WHERE id=ANY($1::text[])`,
          [eligible.map((row) => row.id)],
        );
      });
    }
    const ranges = new Map();
    for (const row of eligible) {
      const key = `${row.query_type}:${row.date_from}:${row.date_to}`;
      ranges.set(key, (ranges.get(key) || 0) + 1);
    }
    process.stdout.write(`${JSON.stringify({
      status: apply ? "APPLIED" : "PLAN",
      database: identity.database,
      eligibleBatchCount: eligible.length,
      ranges: [...ranges.entries()].sort().map(([range, batchCount]) => ({ range, batchCount })),
    }, null, 2)}\n`);
  } finally {
    await provider.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Mabang shop coverage repair failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
