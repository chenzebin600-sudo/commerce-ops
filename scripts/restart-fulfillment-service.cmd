@echo off
setlocal EnableExtensions
title Restart Mabang Fulfillment Service
cd /d "%~dp0.."

echo Restarting the Mabang fulfillment service...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$root=[IO.Path]::GetFullPath((Get-Location).Path);$targets=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.CommandLine.Contains('fulfillment-service\server.mjs') };if(-not $targets){exit 2};$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }"
if errorlevel 2 (
  echo The service process was not found. Try running this file as administrator.
  pause
  exit /b 1
)
if errorlevel 1 (
  echo Restart failed. Right-click this file and select Run as administrator.
  pause
  exit /b 1
)

echo Waiting for the supervisor to start the updated service...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ok=$false;1..20 | ForEach-Object { Start-Sleep -Milliseconds 500;try{$r=Invoke-RestMethod 'http://127.0.0.1:3112/health' -TimeoutSec 2;if($r.success){$ok=$true;return}}catch{}};if(-not $ok){exit 1}"
if errorlevel 1 (
  echo The service has not returned yet. Check storage\logs\fulfillment-service.log.
) else (
  echo Restart complete. Open http://127.0.0.1:3112/docs
)
pause
