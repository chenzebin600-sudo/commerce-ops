[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$BackupRoot = "D:\PostgreSQLBackups\base_backup",
  [string]$BackupDate = (Get-Date).ToString("yyyy-MM-dd"),
  [string]$PostgresBin = "D:\postgreSQL\bin",
  [string]$ConfirmDatabase = "",
  [ValidateRange(1, 19)]
  [int]$CompressionLevel = 6
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
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$Name is required in .env.postgres.local"
  }
  return $value
}

function Assert-ChildPath([string]$Parent, [string]$Child) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childFull = [IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing path outside backup root: $childFull"
  }
}

$envFile = Join-Path $ProjectRoot ".env.postgres.local"
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  throw ".env.postgres.local is missing"
}
$settings = Read-DotEnv $envFile
$hostName = Require-Value $settings "POSTGRES_HOST"
$port = Require-Value $settings "POSTGRES_PORT"
$database = Require-Value $settings "POSTGRES_DATABASE"
$adminUser = Require-Value $settings "POSTGRES_ADMIN_USER"
$adminPassword = Require-Value $settings "POSTGRES_ADMIN_PASSWORD"
if ($ConfirmDatabase -ne $database) {
  throw "Pass -ConfirmDatabase $database to confirm the physical backup target"
}

$pgBasebackup = Join-Path $PostgresBin "pg_basebackup.exe"
$pgVerifybackup = Join-Path $PostgresBin "pg_verifybackup.exe"
$psql = Join-Path $PostgresBin "psql.exe"
foreach ($binary in @($pgBasebackup, $pgVerifybackup, $psql)) {
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "Required PostgreSQL binary is missing: $binary"
  }
}

$target = Join-Path $BackupRoot $BackupDate
Assert-ChildPath $BackupRoot $target
if (Test-Path -LiteralPath $target) {
  $existing = @(Get-ChildItem -LiteralPath $target -Force -ErrorAction Stop)
  if ($existing.Count -gt 0) {
    throw "Backup target already exists and is not empty: $target"
  }
} else {
  New-Item -ItemType Directory -Path $target -Force | Out-Null
}

$backupParent = Split-Path -Parent $BackupRoot
$logRoot = Join-Path $backupParent "logs"
$metadataRoot = Join-Path $backupParent "metadata"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
New-Item -ItemType Directory -Path $metadataRoot -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logRoot "physical-base-backup-$stamp.log"
$metadataFile = Join-Path $metadataRoot "physical-base-backup-$BackupDate.json"

$previousPassword = $env:PGPASSWORD
$previousSslMode = $env:PGSSLMODE
$previousSslRootCert = $env:PGSSLROOTCERT
$env:PGPASSWORD = $adminPassword
$sslEnabled = ([string]$settings["POSTGRES_SSL"]).ToLowerInvariant() -eq "true"
if ($sslEnabled) {
  $env:PGSSLMODE = "verify-full"
  $caRaw = Require-Value $settings "POSTGRES_SSL_CA_FILE"
  $caPath = if ([IO.Path]::IsPathRooted($caRaw)) { $caRaw } else { Join-Path $ProjectRoot $caRaw }
  $env:PGSSLROOTCERT = [IO.Path]::GetFullPath($caPath)
} else {
  $env:PGSSLMODE = "disable"
  Remove-Item Env:PGSSLROOTCERT -ErrorAction SilentlyContinue
}

function Invoke-SourceScalar([string]$Sql) {
  $result = & $psql -X -A -t -w -h $hostName -p $port -U $adminUser -d $database -v ON_ERROR_STOP=1 -c $Sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL preflight query failed: $($result -join ' ')"
  }
  return ([string]($result | Select-Object -Last 1)).Trim()
}

$coreTables = @(
  [pscustomobject]@{ domain = "orders"; table = "growth_order_raw_rows" },
  [pscustomobject]@{ domain = "products"; table = "product_skus" },
  [pscustomobject]@{ domain = "inventory"; table = "product_inventory_snapshots" },
  [pscustomobject]@{ domain = "tasks"; table = "foundation_tasks" },
  [pscustomobject]@{ domain = "agent_runs"; table = "fulfillment_agent_runs" },
  [pscustomobject]@{ domain = "audit_logs"; table = "operation_audit_events" }
)

function Get-CoreRowCounts {
  return @($coreTables | ForEach-Object {
    if ($_.table -notmatch '^[a-z_]+$') { throw "Unsafe table name in backup inventory" }
    [pscustomobject]@{
      domain = $_.domain
      table = $_.table
      rows = [int64](Invoke-SourceScalar "SELECT COUNT(*)::bigint FROM app.$($_.table)")
    }
  })
}

$startedAt = Get-Date
try {
  $sourceVersion = Invoke-SourceScalar "SHOW server_version"
  $sourceLsnBefore = Invoke-SourceScalar "SELECT pg_current_wal_lsn()"
  $sourceTableCountBefore = [int](Invoke-SourceScalar "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r'")
  $sourceDatabaseBytesBefore = [int64](Invoke-SourceScalar "SELECT pg_database_size(current_database())")
  $coreRowCountsBefore = Get-CoreRowCounts
  $label = "Commerce Ops physical base backup $($startedAt.ToString('o'))"
  $arguments = @(
    "-h", $hostName,
    "-p", $port,
    "-U", $adminUser,
    "-D", $target,
    "--format=tar",
    "--wal-method=stream",
    "--checkpoint=spread",
    "--compress=client-zstd:$CompressionLevel",
    "--manifest-checksums=SHA256",
    "--label=$label",
    "--progress",
    "--verbose",
    "--no-password"
  )
  $nativeErrorPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5 wraps every native stderr line as a PowerShell error
    # record. pg_basebackup uses stderr for normal progress, so collect it first
    # and decide success exclusively from the native exit code.
    $ErrorActionPreference = "Continue"
    $backupOutput = & $pgBasebackup @arguments 2>&1
    $backupExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $nativeErrorPreference
  }
  $backupOutput | Tee-Object -FilePath $logFile
  if ($backupExit -ne 0) {
    throw "pg_basebackup failed with exit code $backupExit; partial files were preserved for diagnosis"
  }

  try {
    $ErrorActionPreference = "Continue"
    # Tar backups cannot be passed to pg_waldump directly. Manifest/checksum
    # verification therefore uses --no-parse-wal; the independent restore test
    # starts PostgreSQL with the streamed WAL and supplies the WAL replay proof.
    $verifyOutput = & $pgVerifybackup --no-parse-wal $target 2>&1
    $verifyExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $nativeErrorPreference
  }
  $verifyOutput | Tee-Object -FilePath $logFile -Append
  if ($verifyExit -ne 0) {
    throw "pg_verifybackup failed with exit code $verifyExit"
  }

  $sourceLsnAfter = Invoke-SourceScalar "SELECT pg_current_wal_lsn()"
  $sourceTableCountAfter = [int](Invoke-SourceScalar "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r'")
  $sourceDatabaseBytesAfter = [int64](Invoke-SourceScalar "SELECT pg_database_size(current_database())")
  $coreRowCountsAfter = Get-CoreRowCounts
  $manifestPath = Join-Path $target "backup_manifest"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "backup_manifest is missing"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $walRanges = @($manifest.'WAL-Ranges')
  $files = @(Get-ChildItem -LiteralPath $target -File -Force | ForEach-Object {
    [pscustomobject]@{
      name = $_.Name
      bytes = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  })
  $completedAt = Get-Date
  $retentionCandidates = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -Force |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } |
    Sort-Object Name -Descending |
    Select-Object -Skip 4 |
    Select-Object -ExpandProperty FullName)
  $metadata = [ordered]@{
    contract = "COMMERCE-OPS-POSTGRESQL-PHYSICAL-BASE-BACKUP-1.0.0"
    status = "VERIFIED"
    database = $database
    sourceServerVersion = $sourceVersion
    backupDirectory = $target
    startedAt = $startedAt.ToUniversalTime().ToString("o")
    completedAt = $completedAt.ToUniversalTime().ToString("o")
    durationSeconds = [math]::Round(($completedAt - $startedAt).TotalSeconds, 3)
    compression = "client-zstd:$CompressionLevel"
    format = "tar"
    walMethod = "stream"
    sourceLsnBefore = $sourceLsnBefore
    sourceLsnAfter = $sourceLsnAfter
    sourceTableCountBefore = $sourceTableCountBefore
    sourceTableCountAfter = $sourceTableCountAfter
    sourceDatabaseBytesBefore = $sourceDatabaseBytesBefore
    sourceDatabaseBytesAfter = $sourceDatabaseBytesAfter
    coreRowCountsBefore = $coreRowCountsBefore
    coreRowCountsAfter = $coreRowCountsAfter
    manifestWalRanges = $walRanges
    totalBytes = (($files | Measure-Object bytes -Sum).Sum)
    files = $files
    pgVerifybackup = "PASS"
    retentionCount = 4
    retentionCandidates = $retentionCandidates
    retentionApplied = $false
    logFile = $logFile
  }
  $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
  $metadata | ConvertTo-Json -Depth 8
} finally {
  if ($null -eq $previousPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $previousPassword }
  if ($null -eq $previousSslMode) { Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue } else { $env:PGSSLMODE = $previousSslMode }
  if ($null -eq $previousSslRootCert) { Remove-Item Env:PGSSLROOTCERT -ErrorAction SilentlyContinue } else { $env:PGSSLROOTCERT = $previousSslRootCert }
}
