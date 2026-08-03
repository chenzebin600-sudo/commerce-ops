param([switch]$Elevated)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
  Write-Host "Opening the development window with administrator permission..."
  $arguments = @(
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $PSCommandPath + '"'),
    "-Elevated"
  )
  try {
    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs | Out-Null
    exit 0
  } catch {
    Write-Error "Administrator approval was cancelled or unavailable."
    exit 1
  }
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location -LiteralPath $root
Write-Host "Preparing unified development mode..." -ForegroundColor Cyan

$stopScript = Join-Path $PSScriptRoot "stop-system.ps1"
$stopArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $stopScript + '"'))
$stopProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $stopArguments -Wait -PassThru -NoNewWindow
if ($stopProcess.ExitCode -ne 0) {
  Write-Host "Development mode was not started because the background services could not be stopped." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Starting automatic reload for ports 3101 and 3112..." -ForegroundColor Green
& npm.cmd run dev
$developmentExitCode = $LASTEXITCODE
if ($developmentExitCode -ne 0) {
  Write-Host "Development mode stopped with an error code $developmentExitCode." -ForegroundColor Red
  Read-Host "Press Enter to close"
}
exit $developmentExitCode
