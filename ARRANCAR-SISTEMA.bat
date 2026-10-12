@echo off
title 360MAX COMERCIOS - DRUGSTORE AGUSTIN
cd /d "%~dp0"
echo ===================================================
echo   ARRANCANDO SISTEMA 360MAX — DRUGSTORE AGUSTIN
echo ===================================================
echo.
node src/server.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] No se pudo iniciar el servidor. Verifique Node.js.
    pause
)
