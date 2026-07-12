@echo off
chcp 65001 >nul
title 音乐老友
cd /d "%~dp0"

echo.
echo   🎵 音乐老友
echo.

echo   [1/2] 启动后台服务...
start "音乐老友-服务" /MIN cmd /c "node agent-server.js"

echo   [2/2] 等待服务就绪...
:wait
timeout /t 2 /nobreak >nul
powershell -Command "try { (Invoke-WebRequest http://127.0.0.1:7749/health -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>&1
if errorlevel 1 goto wait

echo   启动桌面端...
start "音乐老友" cmd /c "npx electron ."
