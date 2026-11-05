@echo off
timeout /t 3 /nobreak >nul
taskkill /F /IM "DeepSeek Harness.exe" >nul 2>&1
timeout /t 4 /nobreak >nul
start "" "D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"