@echo off
setlocal
echo Starting AZMORY...
pushd "%~dp0" || goto folder_error
if not exist "server.mjs" goto missing_files
if not exist "public\index.html" goto missing_files

set "REELDESK_NODE=node.exe"
where node.exe >nul 2>&1
if not errorlevel 1 goto check_node
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "REELDESK_NODE=%ProgramFiles%\nodejs\node.exe"
  goto check_node
)
echo Node.js was not found. Install Node.js 24 LTS, then open this file again.
goto failed

:check_node
"%REELDESK_NODE%" --version
if errorlevel 1 goto failed
"%REELDESK_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if not errorlevel 1 goto launch
echo AZMORY needs Node.js 24 or later.
goto failed

:launch
echo Starting the local server...
"%REELDESK_NODE%" server.mjs --open
if errorlevel 1 goto failed
popd
pause
exit /b 0

:missing_files
echo AZMORY files are missing. Extract the whole ZIP, then open this file from the extracted folder.

:failed
echo AZMORY stopped. Read the message above.
popd
pause
exit /b 1

:folder_error
echo AZMORY could not open its folder. Extract the ZIP to Downloads or Desktop and try again.
pause
exit /b 1
