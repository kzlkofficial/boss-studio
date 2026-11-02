@echo off
cd /d "%~dp0"
title Boss Studio Easy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0program\start_easy.ps1"
if errorlevel 1 (
 echo.
 echo Could not start. Please read НАЧНИ_ЗДЕСЬ.txt in this folder.
 pause
)
