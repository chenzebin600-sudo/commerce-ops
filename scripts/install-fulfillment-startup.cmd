@echo off
setlocal EnableExtensions
title ZNWX Commerce Ops - Startup Installer

set "TASK_NAME=ZNWX Commerce Ops"
set "LEGACY_TASK_NAME=ZNWX Mabang Fulfillment"
for %%I in ("%~dp0run-system-supervisor.cmd") do set "RUNNER=%%~fI"
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "STARTUP_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ZNWX Commerce Ops.lnk"
set "LEGACY_STARTUP_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ZNWX Mabang Fulfillment.lnk"
set "LOG_DIR=%PROJECT_ROOT%\storage\logs"
set "INSTALL_LOG=%LOG_DIR%\commerce-ops-startup-install.log"
set "RESULT=1"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
echo [%date% %time%] Unified startup installation started.>>"%INSTALL_LOG%"
echo Installing automatic startup for the complete Commerce Ops system...
echo.

rem Install the replacement first. The legacy fulfillment-only task is removed only after success.
schtasks.exe /Create /TN "%TASK_NAME%" /SC ONLOGON /RL LIMITED /TR "cmd.exe /d /c %RUNNER%" /F >>"%INSTALL_LOG%" 2>&1
if not errorlevel 1 (
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$task=Get-ScheduledTask -TaskName $env:TASK_NAME -ErrorAction Stop;$task.Settings.RestartCount=999;$task.Settings.RestartInterval='PT1M';$task.Settings.ExecutionTimeLimit='PT0S';$task.Settings.StartWhenAvailable=$true;$task.Settings.DisallowStartIfOnBatteries=$false;$task.Settings.StopIfGoingOnBatteries=$false;Set-ScheduledTask -InputObject $task -ErrorAction Stop | Out-Null" >>"%INSTALL_LOG%" 2>&1
  if errorlevel 1 goto failed
  echo Installed with Windows Task Scheduler.
  schtasks.exe /Run /TN "%TASK_NAME%" >>"%INSTALL_LOG%" 2>&1
  schtasks.exe /End /TN "%LEGACY_TASK_NAME%" >>"%INSTALL_LOG%" 2>&1
  schtasks.exe /Delete /TN "%LEGACY_TASK_NAME%" /F >>"%INSTALL_LOG%" 2>&1
  if exist "%LEGACY_STARTUP_LINK%" del /F /Q "%LEGACY_STARTUP_LINK%"
  set "RESULT=0"
  goto success
)

echo Windows Task Scheduler is unavailable; using the Startup folder instead...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:STARTUP_LINK);$s.TargetPath=$env:ComSpec;$q=[char]34;$s.Arguments='/d /c '+$q+$env:RUNNER+$q;$s.WorkingDirectory=$env:PROJECT_ROOT;$s.WindowStyle=7;$s.Description='ZNWX Commerce Ops complete system';$s.Save()" >>"%INSTALL_LOG%" 2>&1
if errorlevel 1 goto failed

schtasks.exe /End /TN "%LEGACY_TASK_NAME%" >>"%INSTALL_LOG%" 2>&1
schtasks.exe /Delete /TN "%LEGACY_TASK_NAME%" /F >>"%INSTALL_LOG%" 2>&1
if exist "%LEGACY_STARTUP_LINK%" del /F /Q "%LEGACY_STARTUP_LINK%"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$q=[char]34;$a='/d /c '+$q+$env:RUNNER+$q;Start-Process -FilePath $env:ComSpec -ArgumentList $a -WindowStyle Hidden" >>"%INSTALL_LOG%" 2>&1
set "RESULT=0"

:success
echo.
echo Installation complete.
echo The main system and fulfillment service will start automatically after Windows login.
echo Main: http://127.0.0.1:3101/
echo Docs: http://127.0.0.1:3112/docs
echo Log:  %INSTALL_LOG%
goto end

:failed
echo.
echo Installation failed. This window will stay open.
echo Please send this log file to me:
echo %INSTALL_LOG%

:end
echo.
pause
exit /b %RESULT%
