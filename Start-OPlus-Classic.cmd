@echo off
setlocal
cd /d "%~dp0"
if exist "releases\0.4.0\OPlusStudio\OPlusStudio.exe" (
  start "" "releases\0.4.0\OPlusStudio\OPlusStudio.exe"
  exit /b
)
echo The classic O+ Studio 0.4.0 package was not found.
pause
