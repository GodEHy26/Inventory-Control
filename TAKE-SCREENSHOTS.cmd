@echo off
rem Double-click to take the portfolio screenshots on this Windows PC.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\portfolio\shots.ps1"
pause
