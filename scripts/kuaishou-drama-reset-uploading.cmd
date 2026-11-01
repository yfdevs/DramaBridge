@echo off
chcp 65001 >nul
pushd "%~dp0.."
node "%~dp0kuaishou-drama-reset-uploading.mjs" %*
set "resetExitCode=%errorlevel%"
echo.
pause
popd
exit /b %resetExitCode%
