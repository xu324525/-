@echo off
chcp 65001 >nul
title 音乐老友
cd /d "%~dp0"

echo.
echo   🎵 音乐老友 AI 桌面音乐
echo   ─────────────────────
echo.

:: Start server in background
echo   [1/2] 启动服务...
start "音乐老友-服务" /MIN cmd /c "npm start"

:: Wait for server to be ready
echo   [2/2] 等待服务就绪...
:loop
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:7749 >nul 2>&1
if errorlevel 1 goto loop

:: Launch Electron
echo   启动桌面端...
start "" /B npm run electron
exit
