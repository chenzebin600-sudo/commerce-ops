@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请安装 Node.js 20 或更高版本后重试。
  pause
  exit /b 1
)

set "NODE_MAJOR="
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo 无法读取 Node.js 版本。请重新安装 Node.js 20 或更高版本后重试。
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 20 (
  echo 当前 Node.js 版本低于 20。请安装 Node.js 20 或更高版本后重试。
  pause
  exit /b 1
)

echo 数据仓库动态文档正在启动。
echo 浏览器打开后，请保留此窗口；关闭此窗口即可停止工具。
node "server.mjs"
if errorlevel 1 (
  echo.
  echo 工具异常退出，请查看上方提示。
  pause
)
