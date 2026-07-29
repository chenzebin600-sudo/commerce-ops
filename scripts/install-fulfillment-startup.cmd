@echo off
setlocal EnableExtensions
title ZNWX Mabang Fulfillment - Startup Installer

set "TASK_NAME=ZNWX Mabang Fulfillment"
for %%I in ("%~dp0run-fulfillment-supervisor.cmd") do set "RUNNER=%%~fI"
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "STARTUP_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ZNWX Mabang Fulfillment.lnk"
set "LOG_DIR=%PROJECT_ROOT%\storage\logs"
set "INSTALL_LOG=%LOG_DIR%\fulfillment-startup-install.log"
set "RESULT=1"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
echo [%date% %time%] Startup installation started.>>"%INSTALL_LOG%"
echo Installing automatic startup for Mabang fulfillment...
echo.

rem Prefer Task Scheduler. Fall back to the current user's Startup folder.
schtasks.exe /Create /TN "%TASK_NAME%" /SC ONLOGON /RL LIMITED /TR "cmd.exe /d /c %RUNNER%" /F >>"%INSTALL_LOG%" 2>&1
if not errorlevel 1 (
  echo Installed with Windows Task Scheduler.
  schtasks.exe /Run /TN "%TASK_NAME%" >>"%INSTALL_LOG%" 2>&1
  set "RESULT=0"
  goto success
)

echo Windows Task Scheduler is unavailable; using the Startup folder instead...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:STARTUP_LINK);$s.TargetPath=$env:ComSpec;$q=[char]34;$s.Arguments='/d /c '+$q+$env:RUNNER+$q;$s.WorkingDirectory=$env:PROJECT_ROOT;$s.WindowStyle=7;$s.Description='ZNWX Mabang fulfillment service';$s.Save()" >>"%INSTALL_LOG%" 2>&1
if errorlevel 1 goto failed

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$q=[char]34;$a='/d /c '+$q+$env:RUNNER+$q;Start-Process -FilePath $env:ComSpec -ArgumentList $a -WindowStyle Hidden" >>"%INSTALL_LOG%" 2>&1
set "RESULT=0"

:success
echo.
echo Installation complete.
echo The service will start automatically after Windows login.
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
