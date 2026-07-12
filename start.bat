@echo off
title Music Buddy
cd /d "%~dp0"
start "Server" /min node agent-server.js
ping -n 3 127.0.0.1 >nul
node_modules\electron\dist\electron.exe .
