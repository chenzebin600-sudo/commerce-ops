@echo off
setlocal EnableExtensions
title Restart ZNWX Commerce Ops
cd /d "%~dp0.."
set "TASK_NAME=ZNWX Commerce Ops"
for %%I in ("%~dp0run-system-supervisor.cmd") do set "RUNNER=%%~fI"

echo Restarting the complete Commerce Ops system...
schtasks.exe /End /TN "%TASK_NAME%" >nul 2>&1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$root=[IO.Path]::GetFullPath((Get-Location).Path);$targets=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.CommandLine.Contains('system-supervisor.mjs') };foreach($target in $targets){& taskkill.exe /PID $target.ProcessId /T /F | Out-Null}" >nul 2>&1
timeout /t 2 /nobreak >nul
schtasks.exe /Run /TN "%TASK_NAME%" >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$q=[char]34;$a='/d /c '+$q+$env:RUNNER+$q;Start-Process -FilePath $env:ComSpec -ArgumentList $a -WindowStyle Hidden"
)

echo Waiting for ports 3101 and 3112...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ok=$false;1..30 | ForEach-Object { Start-Sleep -Seconds 1;try{$main=Invoke-WebRequest 'http://127.0.0.1:3101/api/health' -UseBasicParsing -TimeoutSec 2;$fulfillment=Invoke-WebRequest 'http://127.0.0.1:3112/health' -UseBasicParsing -TimeoutSec 2;if($main.StatusCode -eq 200 -and $fulfillment.StatusCode -eq 200){$ok=$true;return}}catch{}};if(-not $ok){exit 1}"
if errorlevel 1 (
  echo The complete system has not returned yet. Check storage\logs\commerce-ops-system.log.
) else (
  echo Restart complete.
  echo Main: http://127.0.0.1:3101/
  echo Docs: http://127.0.0.1:3112/docs
)
pause
