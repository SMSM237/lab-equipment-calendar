@echo off
setlocal
cd /d "%~dp0"
echo This PC's IPv4 addresses:
ipconfig | findstr /i "IPv4"
echo.
echo Enter the IPv4 address of the network you want to share with.
echo Leave empty for access from this PC only.
set "CALENDAR_BIND=127.0.0.1"
set /p "CALENDAR_BIND=Server IPv4 [127.0.0.1]: "
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0server.py" --host "%CALENDAR_BIND%"
  goto finish
)
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0server.py" --host "%CALENDAR_BIND%"
  goto finish
)
echo Python 3 was not found. Please install Python 3 and try again.
:finish
echo.
echo Server stopped. Press any key to close this window.
pause >nul
