@echo off
setlocal

set BASH=
if exist "C:\Program Files\Git\bin\bash.exe" set BASH=C:\Program Files\Git\bin\bash.exe
if not defined BASH if exist "C:\Program Files (x86)\Git\bin\bash.exe" set BASH=C:\Program Files (x86)\Git\bin\bash.exe
if not defined BASH for /f "delims=" %%i in ('where bash.exe 2^>nul') do if not defined BASH set BASH=%%i

if not defined BASH (
    echo Git Bash not found. Install Git for Windows from https://git-scm.com
    pause
    exit /b 1
)

"%BASH%" "%~dp0launch-agents.sh"
