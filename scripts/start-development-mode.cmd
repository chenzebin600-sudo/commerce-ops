@echo off
setlocal EnableExtensions
title ZNWX Commerce Ops Development
cd /d "%~dp0.."

echo Opening unified development mode with Windows administrator permission...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-development-mode.ps1"
if errorlevel 1 pause
