@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
set "NODE_EXE=D:\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_FOUND set "NODE_FOUND=%%I"
  if not defined NODE_FOUND (
    echo Node.js was not found.>>"storage\fulfillment-startup-error.log"
    exit /b 1
  )
  set "NODE_EXE=!NODE_FOUND!"
)
"%NODE_EXE%" "scripts\fulfillment-supervisor.mjs"
