@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0BioinformaticsHUB.exe" "%~dp0resources\app.asar\workflow\entry.cjs" %*
exit /b %errorlevel%
