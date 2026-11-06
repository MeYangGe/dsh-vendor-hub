@echo off
rem Restart the DSH desktop app and make sure its window actually comes back.
rem
rem A plain "taskkill + start" can leave the window minimized, because the app
rem remembers its last window state and a forced kill can persist "minimized".
rem The restore step at the end is what keeps "restarted" from looking like
rem "won't open".
rem
rem Usage: restart-dsh.cmd [delay-seconds]
rem Default delay keeps the caller's turn alive long enough to finish replying.

setlocal
set DELAY=%1
if "%DELAY%"=="" set DELAY=25

timeout /t %DELAY% /nobreak >nul
taskkill /F /IM "DeepSeek Harness.exe" >nul 2>&1
timeout /t 4 /nobreak >nul
start "" "D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"
timeout /t 10 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\dsh-vendor-hub\scripts\restore-window.ps1"
endlocal