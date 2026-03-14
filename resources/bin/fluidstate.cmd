@echo off
REM FluidState CLI launcher — opens the FluidState app with the given directory.
REM Bundled inside the app; a copy at %%LOCALAPPDATA%%\FluidState\bin points here.

if "%~1"=="--help" (
  echo Usage: fluidstate [directory]
  echo.
  echo Open FluidState IDE in the specified directory ^(defaults to current directory^).
  echo.
  echo Examples:
  echo   fluidstate              Open in current directory
  echo   fluidstate .            Open in current directory
  echo   fluidstate %%USERPROFILE%%\projects   Open in projects
  exit /b 0
)

if "%~1"=="--version" (
  echo FluidState CLI
  exit /b 0
)

set "TARGET_DIR=%~f1"
if "%TARGET_DIR%"=="" set "TARGET_DIR=%CD%"

if not exist "%TARGET_DIR%\" (
  echo Error: '%TARGET_DIR%' is not a directory 1>&2
  exit /b 1
)

REM Resolve this script's directory (follows to the real location)
set "SCRIPT_DIR=%~dp0"

REM SCRIPT_DIR is <install>\resources\bin\
REM The executable is at <install>\FluidState.exe
set "APP_EXE=%SCRIPT_DIR%..\..\FluidState.exe"

if exist "%APP_EXE%" (
  start "" "%APP_EXE%" --open-dir="%TARGET_DIR%"
) else (
  echo Error: Could not locate FluidState.exe from %SCRIPT_DIR% 1>&2
  exit /b 1
)
