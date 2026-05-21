@echo off
title RemoteDesk — Setup & Launch
color 0B
cls

echo.
echo  ================================================
echo   RemoteDesk Desktop Host — First-time Setup
echo  ================================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js is not installed.
    echo.
    echo  Please download and install Node.js from:
    echo      https://nodejs.org   (choose the LTS version)
    echo.
    echo  After installing Node.js, run this file again.
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER% found.
echo.

:: Install dependencies if needed
if not exist "node_modules\electron\dist\electron.exe" (
    echo  [>>] Installing dependencies (this may take a few minutes)...
    echo.
    call npm install --no-fund --no-audit 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo  [!] Dependency install failed.
        echo      Try running as Administrator, or check your internet connection.
        pause
        exit /b 1
    )
    echo.
    echo  [OK] Dependencies installed successfully!
    echo.
) else (
    echo  [OK] Dependencies already installed.
    echo.
)

:: Launch the app
echo  [>>] Starting RemoteDesk...
echo.
echo  ================================================
echo   RemoteDesk is running in the system tray.
echo   A session ID will appear in the app window.
echo  ================================================
echo.

start "" /B npx electron .
timeout /t 2 /nobreak >nul
exit
