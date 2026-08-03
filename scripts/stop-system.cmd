@echo off
setlocal EnableExtensions
title Stop ZNWX Commerce Ops
cd /d "%~dp0.."

echo Stopping the complete Commerce Ops background system...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-system.ps1"
if errorlevel 1 (
  echo.
  echo Stop failed. Approve the Windows administrator prompt and try again.
  if /I not "%~1"=="nopause" pause
  exit /b 1
)
echo.
echo Stop completed and ports 3101 / 3112 are free.
echo To use development mode, run: npm.cmd run dev
if /I not "%~1"=="nopause" pause
