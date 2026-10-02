@echo off
title EasyPrint
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org , install it, then run this again.
  pause
  exit /b 1
)

rem Installs anything new after an update. Quick when nothing changed.
echo Checking for updates to EasyPrint's add-ons...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 ( echo Setup failed. Send Claude a screenshot of this window. & pause & exit /b 1 )

call npm start
