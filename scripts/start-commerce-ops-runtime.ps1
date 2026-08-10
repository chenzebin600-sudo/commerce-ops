[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [ValidateRange(0, 10)]
  [int]$RestartLimit = 3,
  [ValidateRange(1, 300)]
  [int]$RestartDelaySeconds = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$entry = Join-Path $ProjectRoot "scripts\start-all.mjs"
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  throw "Commerce Ops runtime entry is missing: $entry"
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$logRoot = Join-Path $ProjectRoot "logs\runtime"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$launchId = Get-Date -Format "yyyyMMdd-HHmmss"
$stdout = Join-Path $logRoot "commerce-ops-$launchId.stdout.log"
$stderr = Join-Path $logRoot "commerce-ops-$launchId.stderr.log"
$events = Join-Path $logRoot "commerce-ops-$launchId.events.log"

$finalExitCode = 1
for ($attempt = 0; $attempt -le $RestartLimit; $attempt++) {
  $startedAt = Get-Date
  "START attempt=$attempt pid=$PID at=$($startedAt.ToString('o')) entry=$entry" |
    Add-Content -LiteralPath $events -Encoding UTF8
  $nativeErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $node --disable-warning=ExperimentalWarning $entry 1>> $stdout 2>> $stderr
    $finalExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $nativeErrorPreference
  }
  $completedAt = Get-Date
  "EXIT attempt=$attempt code=$finalExitCode at=$($completedAt.ToString('o')) durationSeconds=$([math]::Round(($completedAt-$startedAt).TotalSeconds,3))" |
    Add-Content -LiteralPath $events -Encoding UTF8
  if ($finalExitCode -eq 0 -or $attempt -ge $RestartLimit) { break }
  Start-Sleep -Seconds $RestartDelaySeconds
}

exit $finalExitCode
