@echo off
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
