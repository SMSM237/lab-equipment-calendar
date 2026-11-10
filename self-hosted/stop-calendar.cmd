@echo off
setlocal
set "CALENDAR_DIR=%~dp0"
powershell -NoProfile -Command "$target=[IO.Path]::GetFullPath((Join-Path $env:CALENDAR_DIR 'server.py')); $pattern='(?i)(^|\s|\x22)'+[regex]::Escape($target)+'(\s|\x22|$)'; $items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match $pattern }); if ($items.Count -eq 0) { Write-Output 'No matching calendar server was found.' } else { foreach ($item in $items) { Stop-Process -Id $item.ProcessId; Write-Output ('Stopped calendar server: ' + $item.ProcessId) } }"
echo.
pause
