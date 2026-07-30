import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const BOOLEAN_COLUMNS = new Set([
  "enabled", "notify_on_success", "notify_on_failure", "notify_on_empty", "at_all",
  "notify_enabled", "catch_up_enabled", "truncated", "suggest_quarantine", "suggest_cleanup",
  "is_source_high_performance", "is_new", "eligible_saleable", "eligible_high_performance",
  "is_key_performer", "is_growth_focus_candidate",
]);

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function readPowerShellJson(script, runner = spawnSync) {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) return null;
  const output = String(result.stdout || "").trim();
  try { return JSON.parse(output); } catch {}
  try { return JSON.parse(Buffer.from(output, "base64").toString("utf8")); } catch { return null; }
}

export function inspectWindowsPostgresql({ runner = spawnSync } = {}) {
  if (process.platform !== "win32") {
    return {
      platform: process.platform,
      compatible: false,
      message: "This readiness probe currently provides detailed installation checks on Windows only.",
    };
  }
  const script = String.raw`
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$services = @(Get-Service | Where-Object { $_.Name -match 'postgres' -or $_.DisplayName -match 'PostgreSQL' })
$processes = @(Get-Process -Name postgres -ErrorAction SilentlyContinue)
$commands = @{}
foreach ($name in @('postgres','psql','pg_dump','pg_restore','pg_ctl','pgAdmin4')) { $commands[$name] = [bool](Get-Command $name -ErrorAction SilentlyContinue) }
$registryCount = 0
foreach ($root in @('HKLM:\SOFTWARE\PostgreSQL\Installations','HKLM:\SOFTWARE\WOW6432Node\PostgreSQL\Installations')) { if (Test-Path $root) { $registryCount += @(Get-ChildItem $root -ErrorAction SilentlyContinue).Count } }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
$ports = @{}
foreach ($port in 5432..5439) { $ports[[string]$port] = @($listeners | Where-Object { $_.LocalPort -eq $port }).Count }
$projectPorts = @{}
foreach ($port in @(3101,4173,9222)) { $projectPorts[[string]$port] = @($listeners | Where-Object { $_.LocalPort -eq $port }).Count }
$volumes = @{}
foreach ($drive in @('C','D')) { $volume = Get-Volume -DriveLetter $drive -ErrorAction SilentlyContinue; if ($volume) { $volumes[$drive] = @{ size = [int64]$volume.Size; free = [int64]$volume.SizeRemaining } } }
$firewall = @{}
Get-NetFirewallProfile | ForEach-Object { $firewall[$_.Name] = [bool]$_.Enabled }
$pgEnvironmentPresence = @{}
foreach ($name in @('PGHOST','PGPORT','PGUSER','PGPASSWORD')) { $pgEnvironmentPresence[$name] = [bool](Test-Path "Env:$name") }
$postgresRoots = @()
if ($env:ProgramFiles) { $postgresRoots += Join-Path $env:ProgramFiles 'PostgreSQL' }
if ($env:SystemDrive) { $postgresRoots += Join-Path $env:SystemDrive 'PostgreSQL' }
$dataVolume = Get-Volume -DriveLetter 'D' -ErrorAction SilentlyContinue
if ($dataVolume) { $postgresRoots += Join-Path $dataVolume.Path 'PostgreSQL' }
$commonDataPathCount = @($postgresRoots | ForEach-Object { Get-ChildItem (Join-Path $_ '*\data') -Directory -ErrorAction SilentlyContinue }).Count
$postgresCommonPathExists = @($postgresRoots | Where-Object { Test-Path $_ }).Count -gt 0
$pgAdminCommonPathExists = [bool]($env:ProgramFiles -and (Test-Path (Join-Path $env:ProgramFiles 'pgAdmin 4')))
$dockerDesktopPathExists = [bool]($env:ProgramFiles -and (Test-Path (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')))
$json = [ordered]@{
  platform = 'win32'
  compatible = $true
  windowsCaption = $os.Caption
  windowsVersion = $os.Version
  windowsBuild = $os.BuildNumber
  architecture = $os.OSArchitecture
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  logicalProcessors = [int]$cs.NumberOfLogicalProcessors
  memoryTotalBytes = [int64]$os.TotalVisibleMemorySize * 1024
  memoryFreeBytes = [int64]$os.FreePhysicalMemory * 1024
  isAdministrator = $isAdmin
  serviceManagerAvailable = [bool](Get-Service -Name EventLog -ErrorAction SilentlyContinue)
  postgresServiceCount = $services.Count
  postgresProcessCount = $processes.Count
  postgresRegistryCount = $registryCount
  postgresCommands = $commands
  postgresCommonPathExists = $postgresCommonPathExists
  postgresCommonDataPathCount = $commonDataPathCount
  pgAdminCommonPathExists = $pgAdminCommonPathExists
  postgresEnvironmentPresence = $pgEnvironmentPresence
  dockerDesktopInstalled = [bool]((Get-Command docker -ErrorAction SilentlyContinue) -or (Get-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue) -or $dockerDesktopPathExists)
  ports = $ports
  projectPorts = $projectPorts
  firewall5432AllowRuleCount = $null
  firewall5432Check = 'manual_read_only_check_required'
  firewallProfiles = $firewall
  volumes = $volumes
} | ConvertTo-Json -Depth 6 -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
  return readPowerShellJson(script, runner) || {
    platform: "win32",
    compatible: false,
    message: "Windows readiness probe could not collect a complete system snapshot.",
  };
}

export function inspectSqliteReadOnly(databasePath) {
  if (!fs.existsSync(databasePath)) throw new Error("Configured SQLite database does not exist");
  const before = fs.statSync(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const summaries = tables.map((table) => {
      const columns = database.prepare(`PRAGMA table_info('${table.name}')`).all();
      const indexes = database.prepare(`PRAGMA index_list('${table.name}')`).all();
      const foreignKeys = database.prepare(`PRAGMA foreign_key_list('${table.name}')`).all();
      const rows = safeInteger(database.prepare(`SELECT COUNT(*) count FROM "${table.name}"`).get().count);
      return {
        name: table.name,
        rows,
        primaryKey: columns.filter((column) => column.pk).map((column) => column.name),
        foreignKeyCount: foreignKeys.length,
        indexCount: indexes.length,
        uniqueIndexCount: indexes.filter((index) => index.unique).length,
        jsonColumns: columns.filter((column) => column.name.endsWith("_json")).map((column) => column.name),
        dateTimeColumns: columns.filter((column) => /(?:_at|_date|lease_until)$/.test(column.name)).map((column) => column.name),
        booleanColumns: columns.filter((column) => BOOLEAN_COLUMNS.has(column.name)).map((column) => column.name),
        autoincrement: /AUTOINCREMENT/i.test(table.sql || ""),
      };
    });
    const totalRows = summaries.reduce((sum, table) => sum + table.rows, 0);
    const largestTable = [...summaries].sort((left, right) => right.rows - left.rows)[0] || null;
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    const journalMode = database.prepare("PRAGMA journal_mode").get().journal_mode;
    const migrationVersions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
    const after = fs.statSync(databasePath);
    return {
      databaseFilename: path.basename(databasePath),
      databaseBytes: before.size,
      modifiedDuringProbe: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
      integrity,
      foreignKeyViolations,
      journalMode,
      walPresent: fs.existsSync(`${databasePath}-wal`),
      walBytes: fs.existsSync(`${databasePath}-wal`) ? fs.statSync(`${databasePath}-wal`).size : 0,
      shmPresent: fs.existsSync(`${databasePath}-shm`),
      shmBytes: fs.existsSync(`${databasePath}-shm`) ? fs.statSync(`${databasePath}-shm`).size : 0,
      migrationVersions,
      tableCount: summaries.length,
      totalRows,
      totalIndexes: summaries.reduce((sum, table) => sum + table.indexCount, 0),
      largestTable: largestTable ? { name: largestTable.name, rows: largestTable.rows } : null,
      tables: summaries,
    };
  } finally {
    database.close();
  }
}

export function determineF0Status({ system, sqlite }) {
  if (!sqlite || sqlite.integrity !== "ok" || sqlite.foreignKeyViolations !== 0 || sqlite.modifiedDuringProbe) return "BLOCKED";
  if (!system || system.compatible === false) return "MANUAL_ACTION_REQUIRED";
  const commandDetected = Object.values(system.postgresCommands || {}).some(Boolean);
  const postgresDetected = safeInteger(system.postgresServiceCount) > 0
    || safeInteger(system.postgresProcessCount) > 0
    || safeInteger(system.postgresRegistryCount) > 0
    || Boolean(system.postgresCommonPathExists)
    || commandDetected;
  const portOccupied = safeInteger(system.ports?.["5432"]) > 0;
  if (postgresDetected || portOccupied || !system.isAdministrator) return "MANUAL_ACTION_REQUIRED";
  return "READY_FOR_INSTALLATION";
}

export function buildReadinessReport({ rootDir, env = process.env, runner = spawnSync } = {}) {
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env });
  const system = inspectWindowsPostgresql({ runner });
  const sqlite = inspectSqliteReadOnly(runtime.databasePath);
  return {
    generatedAt: new Date().toISOString(),
    status: determineF0Status({ system, sqlite }),
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      npmVersion: String(env.npm_config_user_agent || "").match(/(?:^|\s)npm\/([^\s]+)/)?.[1] || null,
      pythonVersion: null,
      logicalCpuCount: os.cpus().length,
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
    },
    system,
    sqlite,
    safety: {
      installedSoftware: false,
      createdService: false,
      createdDatabase: false,
      changedConfiguration: false,
      wroteSqlite: false,
    },
  };
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loadLocalEnv(rootDir);
  const report = buildReadinessReport({ rootDir, env: process.env });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL readiness failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 200)}\n`);
    process.exitCode = 1;
  });
}
