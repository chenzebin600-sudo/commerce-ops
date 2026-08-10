[CmdletBinding()]
param(
  [string]$Target = "C:\PostgreSQL_restore_test\2026-08-10",
  [string]$RestoreRoot = "C:\PostgreSQL_restore_test",
  [string]$OfficialBackup = "D:\PostgreSQLBackups\base_backup\2026-08-10",
  [string]$MetadataFile = "D:\PostgreSQLBackups\metadata\physical-base-backup-2026-08-10.json",
  [string]$RestoreEvidenceFile = "D:\PostgreSQLBackups\restore-test\restore-test-2026-08-10.json",
  [string]$AuditRoot = "D:\PostgreSQLBackups\cleanup-audit",
  [string]$ConfirmTarget = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$restoreRootFull = [IO.Path]::GetFullPath($RestoreRoot).TrimEnd('\') + '\'
$targetFull = [IO.Path]::GetFullPath($Target).TrimEnd('\')
$officialFull = [IO.Path]::GetFullPath($OfficialBackup).TrimEnd('\')

if ($ConfirmTarget -ne $targetFull) {
  throw "Pass -ConfirmTarget `"$targetFull`" to authorize this exact restore-test deletion"
}
if (-not $targetFull.StartsWith($restoreRootFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Delete target escaped the restore-test root"
}
if ($targetFull -eq $restoreRootFull.TrimEnd('\')) {
  throw "Refusing to delete the restore-test root itself"
}
if (-not (Test-Path -LiteralPath $targetFull -PathType Container)) {
  throw "Expected restore-test target is missing: $targetFull"
}

$targetItem = Get-Item -LiteralPath $targetFull -Force
if ($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw "Refusing recursive deletion through a reparse point"
}

$metadata = Get-Content -LiteralPath $MetadataFile -Raw | ConvertFrom-Json
$restoreEvidence = Get-Content -LiteralPath $RestoreEvidenceFile -Raw | ConvertFrom-Json
if ($metadata.status -ne "VERIFIED" -or $metadata.pgVerifybackup -ne "PASS") {
  throw "Official physical backup verification gate failed"
}
if ([IO.Path]::GetFullPath([string]$metadata.backupDirectory).TrimEnd('\') -ne $officialFull) {
  throw "Metadata does not identify the expected official physical backup"
}
if ($restoreEvidence.status -ne "PASS" -or
    -not $restoreEvidence.testInstanceStopped -or
    $restoreEvidence.productionModified) {
  throw "Restore-test evidence gate failed"
}
foreach ($name in @("base.tar.zst", "pg_wal.tar", "backup_manifest")) {
  if (-not (Test-Path -LiteralPath (Join-Path $officialFull $name) -PathType Leaf)) {
    throw "Official backup component is missing: $name"
  }
}
if (Get-NetTCPConnection -State Listen -LocalPort 55432 -ErrorAction SilentlyContinue) {
  throw "Restore-test port 55432 is still listening"
}

$processInventory = @(Get-CimInstance Win32_Process)
$launcherProcessIds = [Collections.Generic.HashSet[int]]::new()
$currentProcessId = [int]$PID
while ($currentProcessId -gt 0 -and $launcherProcessIds.Add($currentProcessId)) {
  $currentProcess = $processInventory | Where-Object { $_.ProcessId -eq $currentProcessId } | Select-Object -First 1
  if ($null -eq $currentProcess) { break }
  $currentProcessId = [int]$currentProcess.ParentProcessId
}

$references = @($processInventory | Where-Object {
  -not $launcherProcessIds.Contains([int]$_.ProcessId) -and (
    ([string]$_.ExecutablePath).IndexOf($targetFull, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    ([string]$_.CommandLine).IndexOf($targetFull, [StringComparison]::OrdinalIgnoreCase) -ge 0
  )
})
if ($references.Count) {
  throw "Processes still reference the restore-test target: $($references.ProcessId -join ',')"
}

$files = @(Get-ChildItem -LiteralPath $targetFull -File -Force -Recurse -ErrorAction Stop)
$bytes = if ($files.Count) { [int64](($files | Measure-Object Length -Sum).Sum) } else { [int64]0 }
$freeBefore = [int64](Get-PSDrive C).Free
$startedAt = Get-Date

[IO.Directory]::Delete($targetFull, $true)

$completedAt = Get-Date
if (Test-Path -LiteralPath $targetFull) {
  throw "Restore-test target still exists after deletion"
}
Start-Sleep -Seconds 2
$freeAfter = [int64](Get-PSDrive C).Free

$audit = [ordered]@{
  contract = "COMMERCE-OPS-POSTGRESQL-RESTORE-TEST-CLEANUP-1.0.0"
  status = "DELETED"
  deletedPath = $targetFull
  deletedFiles = $files.Count
  deletedBytes = $bytes
  deletedGiB = [math]::Round($bytes / 1GB, 3)
  startedAt = $startedAt.ToUniversalTime().ToString("o")
  completedAt = $completedAt.ToUniversalTime().ToString("o")
  durationSeconds = [math]::Round(($completedAt - $startedAt).TotalSeconds, 3)
  cFreeBeforeBytes = $freeBefore
  cFreeAfterBytes = $freeAfter
  observedFreedBytes = $freeAfter - $freeBefore
  officialBackup = $officialFull
  officialBackupStatus = "VERIFIED"
  restoreEvidenceStatus = "PASS"
  restoreInstanceStopped = $true
  restoreRootPreserved = Test-Path -LiteralPath $restoreRootFull.TrimEnd('\')
  walDeletionPerformed = $false
  productionDatabaseModified = $false
}

New-Item -ItemType Directory -Path $AuditRoot -Force | Out-Null
$auditFile = Join-Path $AuditRoot "restore-test-cleanup-$($startedAt.ToString('yyyyMMdd-HHmmss')).json"
$audit | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $auditFile -Encoding UTF8
$audit["auditFile"] = $auditFile
$audit | ConvertTo-Json -Depth 6
