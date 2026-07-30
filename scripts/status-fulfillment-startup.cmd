@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
set "TASK_NAME=ZNWX Commerce Ops"
set "LEGACY_TASK_NAME=ZNWX Mabang Fulfillment"
set "STARTUP_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ZNWX Commerce Ops.lnk"

echo Automatic startup status:
schtasks.exe /Query /TN "%TASK_NAME%" /FO LIST /V 2>nul
schtasks.exe /Query /TN "%LEGACY_TASK_NAME%" /FO LIST /V 2>nul
if exist "%STARTUP_LINK%" (
  echo Startup-folder entry: installed
  echo %STARTUP_LINK%
) else (
  echo Startup-folder entry: not installed
)
echo.
echo Main system health:
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod 'http://127.0.0.1:3101/api/health' | ConvertTo-Json -Depth 6 } catch { Write-Host $_.Exception.Message }"
echo.
echo Fulfillment service health:
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod 'http://127.0.0.1:3112/health' | ConvertTo-Json -Depth 6 } catch { Write-Host $_.Exception.Message }"
echo.
echo Recent unified system log:
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (Test-Path 'storage\logs\commerce-ops-system.log') { Get-Content 'storage\logs\commerce-ops-system.log' -Tail 30 } else { 'No unified supervisor log has been created yet.' }"
pause
