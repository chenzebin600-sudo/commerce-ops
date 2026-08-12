import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPostgresqlSchema,
  createSqliteMigrationSnapshot,
  inspectSqliteSchema,
  openReadOnlySqliteSnapshot,
} from "../lib/postgresql/sqlite-migration.mjs";

function argument(name, args) {
  const index = args.indexOf(name);
  const value = index >= 0 ? String(args[index + 1] || "").trim() : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function buildSharedPostgresqlBaseline({ sourcePath, outputPath, schema = "app" }) {
  if (!sourcePath || !outputPath) throw new TypeError("Baseline sourcePath and outputPath are required");
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-postgresql-baseline-"));
  const snapshotPath = path.join(temporaryRoot, "source.sqlite");
  let database;
  try {
    const snapshot = await createSqliteMigrationSnapshot({ sourcePath, destinationPath: snapshotPath });
    if (snapshot.integrity !== "ok" || snapshot.foreignKeyViolations !== 0) {
      throw new Error("SQLite baseline snapshot failed integrity validation");
    }
    database = openReadOnlySqliteSnapshot(snapshotPath);
    const inspected = inspectSqliteSchema(database);
    const tables = inspected.tables.filter(({ name }) => name !== "schema_migrations");
    const source = {
      ...inspected,
      tables,
      tableCount: tables.length,
      columnCount: tables.reduce((sum, table) => sum + table.columns.length, 0),
      rowCount: tables.reduce((sum, table) => sum + table.rowCount, 0),
      indexCount: tables.reduce((sum, table) => sum + table.indexes.length, 0),
    };
    const generated = buildPostgresqlSchema(source, { schema });
    const header = [
      "-- Generated from a consistent SQLite snapshot. Schema only; no business rows.",
      "-- The PostgreSQL migration runner owns app.schema_migrations.",
      `-- Tables: ${source.tableCount}; columns: ${source.columnCount}; source rows inspected: ${source.rowCount}.`,
      "",
    ].join("\n");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${header}${generated.sql}\n`, "utf8");
    return Object.freeze({
      tableCount: source.tableCount,
      columnCount: source.columnCount,
      indexCount: generated.expectedIndexCount,
      outputPath: path.resolve(outputPath),
      snapshotHash: snapshot.snapshotHash,
    });
  } finally {
    database?.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourcePath = path.resolve(rootDir, argument("--source", process.argv));
  const outputPath = path.resolve(rootDir, argument("--output", process.argv));
  const result = await buildSharedPostgresqlBaseline({ sourcePath, outputPath });
  process.stdout.write(`${JSON.stringify({ status: "GENERATED", ...result }, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL baseline generation failed [${String(error?.code || "PG_BASELINE_FAILED").slice(0, 80)}]\n`);
    process.exitCode = 1;
  });
}
