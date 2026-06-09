@echo off
title Hyperliquid Auction Bot - Setup
echo === Hyperliquid Auction Bot: new-machine setup ===
echo.
where git >nul 2>&1 || echo [X] Git missing - install from https://git-scm.com
where node >nul 2>&1 || echo [X] Node missing - need v24 from https://nodejs.org
echo Node version:
node --version
echo (must be v24.x for node:sqlite)
echo.
set "DEST=%USERPROFILE%\Documents\polymarket-bot"
if not exist "%DEST%\.git" echo Cloning to %DEST% ...
if not exist "%DEST%\.git" git clone https://github.com/nicholassamuel-hash/hyperliquid-mm-bot.git "%DEST%"
if exist "%DEST%\.git" git -C "%DEST%" pull --ff-only
cd /d "%DEST%"
echo.
echo Installing dependencies + building...
call npm install
call npm run build
echo.
if exist "%USERPROFILE%\.ssh\neva-bot" echo [OK] SSH key present.
if not exist "%USERPROFILE%\.ssh\neva-bot" echo [!] SSH KEY MISSING - copy neva-bot + neva-bot.pub into %USERPROFILE%\.ssh\
echo.
echo === Done ===
echo 1) If missing, copy the SSH key (neva-bot, neva-bot.pub) to %USERPROFILE%\.ssh\
echo 2) Test VPS:  ssh -i "%USERPROFILE%\.ssh\neva-bot" root@202.155.132.247 "pm2 list"
echo 3) Dashboard: npm run dashboard   then open http://localhost:8787
echo.
pause
