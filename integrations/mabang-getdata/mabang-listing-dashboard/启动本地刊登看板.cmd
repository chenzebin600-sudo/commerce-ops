@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 马帮刊登工作台

if exist "..\.venv\Scripts\python.exe" (
  "..\.venv\Scripts\python.exe" start_dashboard.py
  if errorlevel 1 goto :failed
  goto :eof
)

where py >nul 2>nul
if not errorlevel 1 (
  py -3 start_dashboard.py
  if errorlevel 1 goto :failed
  goto :eof
)

where python >nul 2>nul
if not errorlevel 1 (
  python start_dashboard.py
  if errorlevel 1 goto :failed
  goto :eof
)

echo 未找到 Python，无法启动本地马帮接口桥接服务。
goto :failed

:failed
echo.
echo 启动失败，请保留此窗口并查看上方错误信息。
pause
