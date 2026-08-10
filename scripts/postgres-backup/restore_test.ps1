[CmdletBinding()]
param(
  [string]$BackupDirectory = "",
  [string]$BackupStorageRoot = "D:\PostgreSQLBackups",
  [string]$ProjectRoot = "",
  [string]$RestoreRoot = "C:\PostgreSQL_restore_test",
  [string]$PostgresBin = "D:\postgreSQL\bin",
  [string]$MetadataFile = "",
  [ValidateRange(1025, 65535)]
  [int]$TestPort = 55432,
  [string]$ConfirmDatabase = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Read-DotEnv([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $value = $matches[2].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$matches[1]] = $value
    }
  }
  return $values
}

function Require-Value($Values, [string]$Name) {
  $value = [string]$Values[$Name]
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is required" }
  return $value
}

$settings = Read-DotEnv (Join-Path $ProjectRoot ".env.postgres.local")
$database = Require-Value $settings "POSTGRES_DATABASE"
$adminUser = Require-Value $settings "POSTGRES_ADMIN_USER"
$adminPassword = Require-Value $settings "POSTGRES_ADMIN_PASSWORD"
$sourceHost = Require-Value $settings "POSTGRES_HOST"
$sourcePort = Require-Value $settings "POSTGRES_PORT"
if ($ConfirmDatabase -ne $database) {
  throw "Pass -ConfirmDatabase $database to confirm restore validation"
}

if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
  $metadataRoot = Join-Path $BackupStorageRoot "metadata"
  $latestVerified = @(Get-ChildItem -LiteralPath $metadataRoot -Filter "physical-base-backup-*.json" -File -ErrorAction Stop | ForEach-Object {
    try {
      $candidate = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
      if ($candidate.status -eq "VERIFIED" -and
          $candidate.pgVerifybackup -eq "PASS" -and
          (Test-Path -LiteralPath ([string]$candidate.backupDirectory) -PathType Container)) {
        $candidate
      }
    } catch {
      Write-Warning "Ignoring unreadable backup metadata: $($_.FullName)"
    }
  } | Sort-Object { [datetime]$_.completedAt } -Descending | Select-Object -First 1)
  if ($latestVerified.Count -ne 1) {
    throw "No verified physical base backup metadata is available under $metadataRoot"
  }
  $BackupDirectory = [string]$latestVerified[0].backupDirectory
}

$backupFull = (Resolve-Path -LiteralPath $BackupDirectory).Path
$baseTar = Join-Path $backupFull "base.tar.zst"
$walTar = @(
  (Join-Path $backupFull "pg_wal.tar.zst"),
  (Join-Path $backupFull "pg_wal.tar")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$walTar = [string]$walTar
$manifest = Join-Path $backupFull "backup_manifest"
if ([string]::IsNullOrWhiteSpace($walTar)) {
  throw "Backup WAL archive is missing (expected pg_wal.tar.zst or pg_wal.tar)"
}
foreach ($file in @($baseTar, $walTar, $manifest)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Backup component is missing: $file" }
}
$pgCtl = Join-Path $PostgresBin "pg_ctl.exe"
$psql = Join-Path $PostgresBin "psql.exe"
$pgVerifybackup = Join-Path $PostgresBin "pg_verifybackup.exe"
foreach ($binary in @($pgCtl, $psql, $pgVerifybackup)) {
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Required binary is missing: $binary" }
}
if (Get-NetTCPConnection -State Listen -LocalPort $TestPort -ErrorAction SilentlyContinue) {
  throw "Restore-test port is already in use: $TestPort"
}

$backupName = Split-Path -Leaf $backupFull
$backupStorageRoot = Split-Path -Parent (Split-Path -Parent $backupFull)
if ([string]::IsNullOrWhiteSpace($MetadataFile)) {
  $MetadataFile = Join-Path $backupStorageRoot "metadata\physical-base-backup-$backupName.json"
}
if (-not (Test-Path -LiteralPath $MetadataFile -PathType Leaf)) {
  throw "Backup metadata is missing: $MetadataFile"
}
$backupMetadata = Get-Content -LiteralPath $MetadataFile -Raw | ConvertFrom-Json
if ($backupMetadata.status -ne "VERIFIED" -or $backupMetadata.pgVerifybackup -ne "PASS") {
  throw "Backup metadata is not verified"
}
$target = Join-Path $RestoreRoot $backupName
$restoreRootFull = [IO.Path]::GetFullPath($RestoreRoot).TrimEnd('\') + '\'
$targetFull = [IO.Path]::GetFullPath($target)
if (-not $targetFull.StartsWith($restoreRootFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Restore target escaped restore root"
}
if (Test-Path -LiteralPath $target) {
  throw "Restore target already exists; it is preserved and will not be overwritten: $target"
}
New-Item -ItemType Directory -Path $target -Force | Out-Null

& $pgVerifybackup --no-parse-wal $backupFull
if ($LASTEXITCODE -ne 0) { throw "Pre-restore pg_verifybackup failed" }
& tar.exe -xf $baseTar -C $target
if ($LASTEXITCODE -ne 0) { throw "Failed to extract base.tar.zst" }
$restoredWal = Join-Path $target "pg_wal"
New-Item -ItemType Directory -Path $restoredWal -Force | Out-Null
& tar.exe -xf $walTar -C $restoredWal
if ($LASTEXITCODE -ne 0) { throw "Failed to extract pg_wal.tar.zst" }

$autoConf = Join-Path $target "postgresql.auto.conf"
$restoreOnlyConfig = @"

# Commerce Ops isolated physical restore test
port = $TestPort
listen_addresses = '127.0.0.1'
archive_mode = 'off'
archive_command = ''
ssl = 'off'
logging_collector = 'on'
log_directory = 'log'
max_connections = 30
"@
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[IO.File]::AppendAllText($autoConf, $restoreOnlyConfig, $utf8NoBom)
$hba = Join-Path $target "pg_hba.conf"
$hbaOriginal = Get-Content -LiteralPath $hba -Raw
[IO.File]::WriteAllText($hba, "host all all 127.0.0.1/32 scram-sha-256`r`n$hbaOriginal", $utf8NoBom)

$previousPassword = $env:PGPASSWORD
$previousSslMode = $env:PGSSLMODE
$previousSslRootCert = $env:PGSSLROOTCERT
$env:PGPASSWORD = $adminPassword
$sslEnabled = ([string]$settings["POSTGRES_SSL"]).ToLowerInvariant() -eq "true"
if ($sslEnabled) {
  $caRaw = Require-Value $settings "POSTGRES_SSL_CA_FILE"
  $caPath = if ([IO.Path]::IsPathRooted($caRaw)) { $caRaw } else { Join-Path $ProjectRoot $caRaw }
  $env:PGSSLROOTCERT = [IO.Path]::GetFullPath($caPath)
} else {
  Remove-Item Env:PGSSLROOTCERT -ErrorAction SilentlyContinue
}
$started = $false
$evidence = $null
$startedAt = Get-Date
$logFile = Join-Path $target "restore-test-postgresql.log"
$evidenceRoot = "D:\PostgreSQLBackups\restore-test"
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$evidenceFile = Join-Path $evidenceRoot "restore-test-$backupName.json"

function Invoke-Scalar([string]$HostName, [string]$Port, [string]$SslMode, [string]$Sql) {
  $env:PGSSLMODE = $SslMode
  $result = & $psql -X -A -t -w -h $HostName -p $Port -U $adminUser -d $database -v ON_ERROR_STOP=1 -c $Sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psql validation failed: $($result -join ' ')" }
  return ([string]($result | Select-Object -Last 1)).Trim()
}

try {
  & $pgCtl start -D $target -l $logFile -o "-p $TestPort" -w -t 180
  if ($LASTEXITCODE -ne 0) { throw "Restored PostgreSQL instance failed to start" }
  $started = $true
  $tables = @(
    [pscustomobject]@{ domain = "orders"; table = "growth_order_raw_rows" },
    [pscustomobject]@{ domain = "products"; table = "product_skus" },
    [pscustomobject]@{ domain = "inventory"; table = "product_inventory_snapshots" },
    [pscustomobject]@{ domain = "tasks"; table = "foundation_tasks" },
    [pscustomobject]@{ domain = "agent_runs"; table = "fulfillment_agent_runs" },
    [pscustomobject]@{ domain = "audit_logs"; table = "operation_audit_events" }
  )
  $checks = @()
  foreach ($item in $tables) {
    if ($item.table -notmatch '^[a-z_]+$') { throw "Unsafe table name" }
    $sql = "SELECT COUNT(*)::bigint FROM app.$($item.table)"
    $sourceCount = [int64](Invoke-Scalar $sourceHost $sourcePort $(if ($sslEnabled) { "verify-full" } else { "disable" }) $sql)
    $restoreCount = [int64](Invoke-Scalar "127.0.0.1" $TestPort "disable" $sql)
    $referenceBefore = @($backupMetadata.coreRowCountsBefore | Where-Object { $_.table -eq $item.table })
    $referenceAfter = @($backupMetadata.coreRowCountsAfter | Where-Object { $_.table -eq $item.table })
    if ($referenceBefore.Count -ne 1 -or $referenceAfter.Count -ne 1) {
      throw "Backup metadata row-count reference is incomplete for app.$($item.table)"
    }
    $minimumExpected = [math]::Min([int64]$referenceBefore[0].rows, [int64]$referenceAfter[0].rows)
    $maximumExpected = [math]::Max([int64]$referenceBefore[0].rows, [int64]$referenceAfter[0].rows)
    $withinBackupWindow = $restoreCount -ge $minimumExpected -and $restoreCount -le $maximumExpected
    $checks += [pscustomobject]@{
      domain = $item.domain
      table = $item.table
      sourceRowsBeforeBackup = [int64]$referenceBefore[0].rows
      sourceRowsAfterBackup = [int64]$referenceAfter[0].rows
      sourceRowsAtRestoreTest = $sourceCount
      restoredRows = $restoreCount
      withinBackupWindow = $withinBackupWindow
      liveSourceDelta = $sourceCount - $restoreCount
      matches = $withinBackupWindow
    }
  }
  $sourceTableCount = [int](Invoke-Scalar $sourceHost $sourcePort $(if ($sslEnabled) { "verify-full" } else { "disable" }) "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r'")
  $restoreTableCount = [int](Invoke-Scalar "127.0.0.1" $TestPort "disable" "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r'")
  $restoredDatabaseBytes = [int64](Invoke-Scalar "127.0.0.1" $TestPort "disable" "SELECT pg_database_size(current_database())")
  $inRecovery = Invoke-Scalar "127.0.0.1" $TestPort "disable" "SELECT pg_is_in_recovery()"
  $tableCountMinimum = [math]::Min([int]$backupMetadata.sourceTableCountBefore, [int]$backupMetadata.sourceTableCountAfter)
  $tableCountMaximum = [math]::Max([int]$backupMetadata.sourceTableCountBefore, [int]$backupMetadata.sourceTableCountAfter)
  $tableCountWithinBackupWindow = $restoreTableCount -ge $tableCountMinimum -and $restoreTableCount -le $tableCountMaximum
  $allMatch = (@($checks | Where-Object { -not $_.matches }).Count -eq 0) -and $tableCountWithinBackupWindow
  $completedAt = Get-Date
  $evidence = [ordered]@{
    contract = "COMMERCE-OPS-POSTGRESQL-PHYSICAL-RESTORE-TEST-1.0.0"
    status = if ($allMatch -and $inRecovery -eq "f") { "PASS" } else { "FAIL" }
    backupDirectory = $backupFull
    restoreDirectory = $target
    testPort = $TestPort
    startedAt = $startedAt.ToUniversalTime().ToString("o")
    completedAt = $completedAt.ToUniversalTime().ToString("o")
    durationSeconds = [math]::Round(($completedAt - $startedAt).TotalSeconds, 3)
    testInstanceStopped = $false
    pgVerifybackup = "PASS"
    embeddedWalRestored = $true
    sourceTableCount = $sourceTableCount
    sourceTableCountBeforeBackup = [int]$backupMetadata.sourceTableCountBefore
    sourceTableCountAfterBackup = [int]$backupMetadata.sourceTableCountAfter
    restoredTableCount = $restoreTableCount
    restoredTableCountWithinBackupWindow = $tableCountWithinBackupWindow
    restoredDatabaseBytes = $restoredDatabaseBytes
    pgIsInRecovery = $inRecovery
    coreChecks = $checks
    productionModified = $false
  }
  if ($evidence.status -ne "PASS") { throw "Restore validation did not match the source database" }
} finally {
  if ($started) {
    & $pgCtl stop -D $target -m fast -w -t 120
    if ($LASTEXITCODE -ne 0) { throw "Restore-test instance could not be stopped" }
    if ($null -ne $evidence) { $evidence.testInstanceStopped = $true }
  }
  if ($null -eq $previousPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $previousPassword }
  if ($null -eq $previousSslMode) { Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue } else { $env:PGSSLMODE = $previousSslMode }
  if ($null -eq $previousSslRootCert) { Remove-Item Env:PGSSLROOTCERT -ErrorAction SilentlyContinue } else { $env:PGSSLROOTCERT = $previousSslRootCert }
}

$evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidenceFile -Encoding UTF8
$evidence | ConvertTo-Json -Depth 8
