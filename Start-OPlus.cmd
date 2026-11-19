@echo off
setlocal
cd /d "%~dp0"
if exist "releases\0.7.1\OPlusStudio\OPlusStudio.Native.exe" (
  start "" "releases\0.7.1\OPlusStudio\OPlusStudio.Native.exe"
  exit /b
)
if exist "releases\0.7.0\OPlusStudio\OPlusStudio.Native.exe" (
  start "" "releases\0.7.0\OPlusStudio\OPlusStudio.Native.exe"
  exit /b
)
if exist "releases\0.6.0\OPlusStudio\OPlusStudio.Native.exe" (
  start "" "releases\0.6.0\OPlusStudio\OPlusStudio.Native.exe"
  exit /b
)
if exist "releases\0.5.0\OPlusStudio\OPlusStudio.Native.exe" (
  start "" "releases\0.5.0\OPlusStudio\OPlusStudio.Native.exe"
  exit /b
)
if exist "releases\0.4.0\OPlusStudio\OPlusStudio.exe" (
  start "" "releases\0.4.0\OPlusStudio\OPlusStudio.exe"
  exit /b
)
if exist "releases\0.3.2\OPlusStudio\OPlusStudio.exe" (
  start "" "releases\0.3.2\OPlusStudio\OPlusStudio.exe"
  exit /b
)
if exist "releases\0.3.1\OPlusStudio\OPlusStudio.exe" (
  start "" "releases\0.3.1\OPlusStudio\OPlusStudio.exe"
  exit /b
)
if exist "releases\0.3.0\OPlusStudio\OPlusStudio.exe" (
  start "" "releases\0.3.0\OPlusStudio\OPlusStudio.exe"
  exit /b
)
if exist "dist\OPlusStudio\OPlusStudio.exe" (
  start "" "dist\OPlusStudio\OPlusStudio.exe"
  exit /b
)
if exist ".venv\Scripts\pythonw.exe" (
  start "" ".venv\Scripts\pythonw.exe" "run.py"
  exit /b
)
python -m oplus
if errorlevel 1 pause
