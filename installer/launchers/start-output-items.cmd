@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-companion.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo Output Items failed to start. Keep this window open for diagnostics.
  pause
)
exit /b %RESULT%
