@echo off
chcp 65001 >nul
title 音乐老友

echo.
echo   🎵 音乐老友 AI 桌面音乐
echo   ─────────────────────
echo   正在启动...
echo.

start "音乐老友-服务" /MIN cmd /c "node agent-server.js"
timeout /t 3 /nobreak >nul

start "音乐老友" cmd /c "npx electron ."
