@echo off
REM ===========================================================================
REM  Parakkat Attendance Sync - installer
REM
REM  Just double-click this file. It asks Windows for administrator rights
REM  (needed to register a service that starts at boot), then runs setup.
REM ===========================================================================

REM Re-launch elevated if we are not already running as administrator.
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"

echo.
echo Press any key to close this window.
pause >nul
