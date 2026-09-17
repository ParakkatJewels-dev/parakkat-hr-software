@echo off
REM ===========================================================================
REM  Removes the Parakkat Attendance Sync service.
REM
REM  Punch history already collected is kept — this only stops the collecting.
REM  Re-run Install.bat to put it back.
REM ===========================================================================

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0..\.."
echo Removing the service...
node "deploy\windows\service.cjs" uninstall

echo.
echo Done. Press any key to close.
pause >nul
