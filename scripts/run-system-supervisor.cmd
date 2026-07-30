@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
set "NODE_EXE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  if not exist "storage" mkdir "storage" >nul 2>&1
  echo Node.js was not found.>>"storage\commerce-ops-startup-error.log"
  exit /b 1
)
"%NODE_EXE%" "scripts\system-supervisor.mjs"
