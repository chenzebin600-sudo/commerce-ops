$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
  Write-Host "Windows administrator permission is required. Opening the approval prompt..."
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"'))
  try {
    $elevated = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
  } catch {
    Write-Error "Administrator approval was cancelled or unavailable."
    exit 1
  }
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location -LiteralPath $root

function Test-ServiceHealth([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-ServiceHealth "http://127.0.0.1:3112/health") {
  $deadline = (Get-Date).AddSeconds(90)
  do {
    try {
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:3112/api/fulfillment/scheduler" -TimeoutSec 3
      if (-not $status.data.scanning -and -not $status.data.activeBatch) { break }
      Write-Host "Waiting for the current safe scan or fulfillment batch to finish..."
    } catch {
      break
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  if ($status.data.scanning -or $status.data.activeBatch) {
    Write-Error "The service is still busy after 90 seconds. It was not stopped."
    exit 1
  }
}

foreach ($taskName in @("ZNWX Commerce Ops", "ZNWX Mabang Fulfillment")) {
  try {
    & schtasks.exe /End /TN $taskName 2>$null | Out-Null
  } catch {
    # The installation can legitimately use the Startup folder instead of Task Scheduler.
  }
}

$targetIds = [Collections.Generic.HashSet[int]]::new()
foreach ($lockName in @("commerce-ops-supervisor.lock", "fulfillment-supervisor.lock")) {
  $lockPath = Join-Path $root "storage\$lockName"
  if (-not (Test-Path -LiteralPath $lockPath)) { continue }
  $pidText = (Get-Content -LiteralPath $lockPath -Raw).Trim()
  $parsedPid = 0
  $lockAgeSeconds = ((Get-Date) - (Get-Item -LiteralPath $lockPath).LastWriteTime).TotalSeconds
  if ($lockAgeSeconds -le 90 -and [int]::TryParse($pidText, [ref]$parsedPid)) {
    $process = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "node") { [void]$targetIds.Add($parsedPid) }
  }
}

$rootNeedle = $root.ToLowerInvariant()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $command = [string]$_.CommandLine
  if ($command.ToLowerInvariant().Contains($rootNeedle) -and
      ($command.Contains("system-supervisor.mjs") -or $command.Contains("fulfillment-supervisor.mjs"))) {
    [void]$targetIds.Add([int]$_.ProcessId)
  }
}

# A previous supervisor can exit while its HTTP children remain alive. Because both
# endpoints above were verified as Commerce Ops services, their listening Node
# processes are safe, exact recovery targets even when their command lines are relative.
$listenerOwnerIds = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(3101, 3112) } |
  ForEach-Object { [int]$_.OwningProcess } |
  Sort-Object -Unique)
$nodeOwnerIds = @($listenerOwnerIds | Where-Object {
  $owner = Get-Process -Id $_ -ErrorAction SilentlyContinue
  $owner -and $owner.ProcessName -eq "node"
})

# Development watch mode can keep a common Node ancestor alive and immediately
# recreate both HTTP children. Prefer stopping that exact common ancestor tree.
$ancestorChains = @()
foreach ($ownerId in $nodeOwnerIds) {
  $chain = @()
  $currentId = $ownerId
  for ($depth = 0; $depth -lt 8 -and $currentId -gt 0; $depth++) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction SilentlyContinue
    $process = Get-Process -Id $currentId -ErrorAction SilentlyContinue
    if (-not $processInfo -or -not $process) { break }
    if ($process.ProcessName -eq "node") { $chain += [int]$currentId }
    $currentId = [int]$processInfo.ParentProcessId
  }
  $ancestorChains += ,$chain
}

$commonAncestor = $null
if ($ancestorChains.Count -ge 2) {
  foreach ($candidate in $ancestorChains[0]) {
    $presentInAll = $true
    foreach ($chain in $ancestorChains[1..($ancestorChains.Count - 1)]) {
      if ($candidate -notin $chain) { $presentInAll = $false; break }
    }
    if ($presentInAll) { $commonAncestor = [int]$candidate; break }
  }
}
if ($commonAncestor) {
  [void]$targetIds.Add($commonAncestor)
} else {
  foreach ($ownerId in $nodeOwnerIds) { [void]$targetIds.Add([int]$ownerId) }
}

foreach ($targetId in $targetIds) {
  Write-Host "Stopping supervisor PID $targetId and its managed services..."
  & taskkill.exe /PID $targetId /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Unable to stop supervisor PID $targetId." }
}

$stopDeadline = (Get-Date).AddSeconds(20)
do {
  $mainRunning = Test-ServiceHealth "http://127.0.0.1:3101/api/health"
  $fulfillmentRunning = Test-ServiceHealth "http://127.0.0.1:3112/health"
  if (-not $mainRunning -and -not $fulfillmentRunning) { break }
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $stopDeadline)

if ($mainRunning -or $fulfillmentRunning) {
  Write-Error "A service is still running on port 3101 or 3112."
  exit 1
}

foreach ($lockName in @("commerce-ops-supervisor.lock", "fulfillment-supervisor.lock")) {
  $lockPath = Join-Path $root "storage\$lockName"
  if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force }
}

Write-Host "Commerce Ops background services stopped successfully."
exit 0
