[CmdletBinding()]
param(
  [string]$WalArchive = "D:\PostgreSQLBackups\wal",
  [double]$WarningGiB = 50,
  [double]$CriticalGiB = 80,
  [ValidateRange(1, 365)]
  [int]$RetentionDays = 7,
  [string]$OutputRoot = "D:\PostgreSQLBackups\monitor",
  [switch]$NoFail
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $WalArchive -PathType Container)) {
  throw "WAL archive does not exist: $WalArchive"
}
$files = @(Get-ChildItem -LiteralPath $WalArchive -File -Force |
  Where-Object { $_.Name -match '^[0-9A-F]{24}\.aes256gcm$' })
$bytes = (($files | Measure-Object Length -Sum).Sum)
$gib = [math]::Round($bytes / 1GB, 3)
$status = if ($gib -ge $CriticalGiB) { "CRITICAL" } elseif ($gib -ge $WarningGiB) { "WARNING" } else { "OK" }
$retentionCutoff = (Get-Date).AddDays(-$RetentionDays)
$retentionCandidates = @($files | Where-Object { $_.LastWriteTime -lt $retentionCutoff })
$retentionCandidateBytes = if ($retentionCandidates.Count) {
  [int64](($retentionCandidates | Measure-Object Length -Sum).Sum)
} else {
  [int64]0
}
$drive = Get-PSDrive ([IO.Path]::GetPathRoot($WalArchive).Substring(0, 1))
$result = [ordered]@{
  contract = "COMMERCE-OPS-POSTGRESQL-WAL-MONITOR-1.0.0"
  collectedAt = (Get-Date).ToUniversalTime().ToString("o")
  status = $status
  walArchive = $WalArchive
  files = $files.Count
  bytes = $bytes
  gib = $gib
  oldest = if ($files.Count) { ($files | Sort-Object LastWriteTime | Select-Object -First 1).LastWriteTime.ToUniversalTime().ToString("o") } else { $null }
  newest = if ($files.Count) { ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime.ToUniversalTime().ToString("o") } else { $null }
  warningGiB = $WarningGiB
  criticalGiB = $CriticalGiB
  retentionDays = $RetentionDays
  retentionCutoff = $retentionCutoff.ToUniversalTime().ToString("o")
  retentionCandidateFiles = $retentionCandidates.Count
  retentionCandidateBytes = $retentionCandidateBytes
  retentionCandidateGiB = [math]::Round($retentionCandidateBytes / 1GB, 3)
  cleanupRequiresVerifiedBaseBackup = $true
  cleanupRequiresVerifiedRestoreTest = $true
  cleanupRequiresHumanConfirmation = $true
  driveFreeGiB = [math]::Round($drive.Free / 1GB, 3)
  deletionPerformed = $false
}
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$json = $result | ConvertTo-Json -Depth 5 -Compress
$json | Set-Content -LiteralPath (Join-Path $OutputRoot "latest.json") -Encoding UTF8
$json | Add-Content -LiteralPath (Join-Path $OutputRoot "history.ndjson") -Encoding UTF8
$result | ConvertTo-Json -Depth 5
if (-not $NoFail) {
  if ($status -eq "CRITICAL") { exit 2 }
  if ($status -eq "WARNING") { exit 1 }
}
