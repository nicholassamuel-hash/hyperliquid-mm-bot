@echo off
title Auction Dashboard Launcher
cd /d "%~dp0"
echo Starting auction bot dashboard...
start "Auction Dashboard (server)" cmd /k node dashboard\server.mjs
timeout /t 3 /nobreak >nul
start "" "http://localhost:8787"
echo.
echo Opened http://localhost:8787  (the server runs in the other window; close it to stop)
timeout /t 4 /nobreak >nul
