@echo off
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -CreateDesktopShortcut
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo 安装失败，请保留本窗口中的错误信息。
pause
exit /b %RESULT%
