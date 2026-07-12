@echo off
chcp 65001 >nul
title 音乐老友

echo.
echo   🎵 音乐老友 AI 桌面音乐
echo   ─────────────────────
echo.
echo   正在启动服务...
echo.

start "音乐老友-服务" /MIN cmd /c "node agent-server.js"
timeout /t 3 /nobreak >nul

echo   打开浏览器: http://localhost:7749
echo   启动 Electron: npm run electron
echo.

start http://localhost:7749

pause
