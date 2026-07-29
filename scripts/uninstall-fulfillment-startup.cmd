@echo off
setlocal EnableExtensions
set "TASK_NAME=ZNWX Mabang Fulfillment"
set "STARTUP_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ZNWX Mabang Fulfillment.lnk"

echo Removing automatic startup: %TASK_NAME%
schtasks.exe /End /TN "%TASK_NAME%" >nul 2>&1
schtasks.exe /Delete /TN "%TASK_NAME%" /F >nul 2>&1
if exist "%STARTUP_LINK%" del /F /Q "%STARTUP_LINK%"
echo Automatic startup entry removed if it existed.
echo Existing logs and fulfillment data were kept.
pause
