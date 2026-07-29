@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
set "TASK_NAME=ZNWX Mabang Fulfillment"
set "STARTUP_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ZNWX Mabang Fulfillment.lnk"

echo Automatic startup status:
schtasks.exe /Query /TN "%TASK_NAME%" /FO LIST /V 2>nul
if exist "%STARTUP_LINK%" (
  echo Startup-folder entry: installed
  echo %STARTUP_LINK%
) else (
  echo Startup-folder entry: not installed
)
echo.
echo Service health:
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod 'http://127.0.0.1:3112/health' | ConvertTo-Json -Depth 6 } catch { Write-Host $_.Exception.Message }"
echo.
echo Recent service log:
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (Test-Path 'storage\logs\fulfillment-service.log') { Get-Content 'storage\logs\fulfillment-service.log' -Tail 30 } else { 'No supervisor log has been created yet.' }"
pause
