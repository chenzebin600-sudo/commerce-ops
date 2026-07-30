import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import {
  determineF0Status,
  inspectSqliteReadOnly,
  inspectWindowsPostgresql,
} from "../scripts/postgresql-readiness.mjs";

test("SQLite readiness inspection is read-only and returns schema metadata only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgres-f0-"));
  const databasePath = path.join(root, "test.sqlite");
  const database = new SchedulerDatabase({ databasePath, migrationsDir: path.resolve("migrations") });
  database.migrate();
  database.close();
  const before = await fs.stat(databasePath);
  const report = inspectSqliteReadOnly(databasePath);
  const after = await fs.stat(databasePath);
  assert.equal(report.integrity, "ok");
  assert.equal(report.foreignKeyViolations, 0);
  const migrationSql = (await fs.readdir(path.resolve("migrations")))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => fs.readFile(path.resolve("migrations", name), "utf8"));
  const expectedTables = new Set(["schema_migrations"]);
  for (const sql of await Promise.all(migrationSql)) {
    for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/gi)) {
      if (!match[1].endsWith("_d2b1")) expectedTables.add(match[1]);
    }
  }
  assert.equal(report.tableCount, expectedTables.size);
  for (const table of [
    "growth_country_mapping_sets",
    "growth_warehouse_country_mappings",
    "growth_rule_sets",
    "growth_analysis_runs",
    "growth_sku_daily_metrics",
    "growth_sku_warehouse_daily_metrics",
    "growth_shop_daily_metrics",
    "growth_shop_sku_daily_metrics",
    "growth_signals",
    "growth_focus_items",
    "growth_focus_item_events",
    "foundation_source_systems",
    "foundation_integration_accounts",
    "foundation_account_capabilities",
    "foundation_owners",
    "foundation_warehouses",
    "foundation_identity_links",
    "foundation_source_runs",
    "foundation_tasks",
    "foundation_task_events",
    "foundation_task_leases",
  ]) {
    assert.ok(report.tables.some((candidate) => candidate.name === table), table);
  }
  assert.equal(report.modifiedDuringProbe, false);
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(JSON.stringify(report).includes("encrypted_password"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("status requires manual action when elevation is unavailable", () => {
  const sqlite = { integrity: "ok", foreignKeyViolations: 0, modifiedDuringProbe: false };
  const system = {
    compatible: true,
    isAdministrator: false,
    postgresServiceCount: 0,
    postgresProcessCount: 0,
    postgresRegistryCount: 0,
    postgresCommonPathExists: false,
    postgresCommands: {},
    ports: { "5432": 0 },
  };
  assert.equal(determineF0Status({ system, sqlite }), "MANUAL_ACTION_REQUIRED");
  assert.equal(determineF0Status({ system: { ...system, isAdministrator: true }, sqlite }), "READY_FOR_INSTALLATION");
  assert.equal(determineF0Status({ system: { ...system, isAdministrator: true }, sqlite: { ...sqlite, integrity: "failed" } }), "BLOCKED");
});

test("non-Windows environments receive an explicit compatibility result", () => {
  if (process.platform === "win32") return;
  const report = inspectWindowsPostgresql();
  assert.equal(report.compatible, false);
  assert.match(report.message, /Windows only/);
});

test("Windows probe accepts UTF-8 JSON wrapped as base64 without exposing values", () => {
  if (process.platform !== "win32") return;
  const expected = {
    platform: "win32",
    compatible: true,
    windowsCaption: "Windows 测试版",
    postgresEnvironmentPresence: { PGHOST: false, PGPASSWORD: false },
  };
  const runner = (_command, args) => {
    assert.equal(args.includes("-EncodedCommand"), true);
    return {
      status: 0,
      stdout: `${Buffer.from(JSON.stringify(expected), "utf8").toString("base64")}\r\n`,
      stderr: "",
    };
  };
  assert.deepEqual(inspectWindowsPostgresql({ runner }), expected);
});

test("readiness source contains no installation, service mutation, DDL or secret output", async () => {
  const source = await fs.readFile(path.resolve("scripts/postgresql-readiness.mjs"), "utf8");
  assert.doesNotMatch(source, /(?:Start-Process|winget\s+install|choco\s+install|docker\s+(?:run|pull)|New-Service|Start-Service|Stop-Service|Set-Service)/i);
  assert.doesNotMatch(source, /(?:CREATE\s+(?:DATABASE|ROLE|USER|TABLE)|ALTER\s+(?:DATABASE|ROLE|USER|TABLE)|DROP\s+(?:DATABASE|ROLE|USER|TABLE))/i);
  assert.match(source, /new DatabaseSync\(databasePath, \{ readOnly: true \}\)/);
  assert.doesNotMatch(source, /PGPASSWORD.*GetEnvironmentVariable|process\.env\.PGPASSWORD/);
});
