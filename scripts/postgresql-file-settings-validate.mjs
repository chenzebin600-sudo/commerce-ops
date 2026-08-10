import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

async function main() {
  loadLocalEnv(rootDir);
  if (!process.argv.includes("--confirm-infrastructure=commerce_ops_pg18")) {
    throw new Error("File-settings validation requires the exact infrastructure confirmation");
  }
  const config = loadPostgresqlF1Config({ rootDir });
  const provider = new PostgresqlProvider({
    config,
    database: "postgres",
    user: config.adminUser,
    password: config.adminPassword,
    readOnly: true,
  });
  try {
    const errors = (await provider.query(`SELECT sourcefile,sourceline,name,error
      FROM pg_file_settings WHERE error IS NOT NULL ORDER BY seqno`)).rows;
    const restartDeferred = new Set(["archive_mode", "shared_preload_libraries"]);
    const invalid = errors.filter((row) => !(restartDeferred.has(row.name) && row.error === "setting could not be applied"));
    if (invalid.length) {
      throw new Error(`postgresql.conf contains ${invalid.length} invalid setting(s): ${invalid.map((row) => `${row.name || "unknown"}@${row.sourceline}: ${row.error}`).join(" | ")}`);
    }
    const rows = (await provider.query(`SELECT name,setting,applied
      FROM pg_file_settings WHERE name=ANY($1::text[]) ORDER BY seqno`, [[
        "ssl", "ssl_min_protocol_version", "wal_level", "archive_mode", "archive_command",
        "logging_collector", "log_min_duration_statement", "track_io_timing",
        "shared_preload_libraries", "compute_query_id", "pg_stat_statements.max", "pg_stat_statements.track",
      ]])).rows;
    const selected = {};
    for (const row of rows) selected[row.name] = row.setting;
    const expected = {
      ssl: "on",
      ssl_min_protocol_version: "TLSv1.2",
      wal_level: "replica",
      archive_mode: "on",
      logging_collector: "on",
      log_min_duration_statement: "500",
      track_io_timing: "on",
      shared_preload_libraries: "pg_stat_statements",
      compute_query_id: "on",
      "pg_stat_statements.max": "10000",
      "pg_stat_statements.track": "all",
    };
    for (const [name, value] of Object.entries(expected)) {
      if (selected[name] !== value) throw new Error(`Staged PostgreSQL setting is invalid: ${name}`);
    }
    const archiveCommand = String(selected.archive_command || "").trim();
    if (!archiveCommand.includes("postgresql-wal-archive.mjs") || !archiveCommand.includes("--key-file")) {
      throw new Error("Staged WAL archive command is incomplete");
    }
    return { status: "PASS", validatedSettings: Object.keys(expected).length + 1, productionTouched: false };
  } finally {
    await provider.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
  process.stderr.write(`PostgreSQL file-settings validation failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 600)}\n`);
  process.exitCode = 1;
});
