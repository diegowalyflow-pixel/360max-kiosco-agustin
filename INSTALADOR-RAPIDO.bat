@echo off
title 360MAX COMERCIOS - INSTALADOR RAPIDO
cd /d "%~dp0"

echo.
echo  ================================================
echo    360MAX COMERCIOS - INSTALADOR RAPIDO
echo    Ejecutar UNA SOLA VEZ en la PC de la caja
echo  ================================================
echo.

rem -- [1/4] Node.js y npm disponibles --
where node >nul 2>&1
if errorlevel 1 (
  echo  [1/4] FALLA: no se encontro Node.js. Se requiere Node.js 18 o superior.
  echo         Instale desde https://nodejs.org y vuelva a ejecutar.
  echo.
  timeout /t 20 >nul
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo  [1/4] FALLA: no se encontro npm. Viene junto con Node.js.
  echo.
  timeout /t 20 >nul
  exit /b 1
)
echo  [1/4] Node.js y npm listos.

rem -- [2/4] Sincronizar librerias nativas --
echo  [2/4] Instalando librerias: npm install --omit=dev
call npm install --omit=dev
if errorlevel 1 (
  echo.
  echo  [2/4] FALLA: no se pudieron instalar las librerias.
  echo         Revise su conexion a internet y ejecute otra vez.
  echo.
  timeout /t 20 >nul
  exit /b 1
)
echo  [2/4] Librerias sincronizadas.

rem -- [3/4] Verificar la base de datos de produccion --
echo  [3/4] Verificando data\360max.db con el catalogo de Agustin...
node herramientas\verificar-instalacion.js
if errorlevel 1 (
  echo.
  echo  [3/4] FALLA: la base de datos no esta completa.
  echo         Copie de nuevo la carpeta completa, incluida la carpeta data.
  echo.
  timeout /t 20 >nul
  exit /b 1
)

rem -- [4/4] Accesos directos con las rutas de esta PC --
echo  [4/4] Actualizando accesos directos de "Drugstore Agustin"...
node herramientas\crear-accesos-directos.js
if errorlevel 1 (
  echo  [4/4] FALLA: no se pudieron crear los accesos directos.
  timeout /t 20 >nul
  exit /b 1
)

echo.
echo  ================================================
echo    INSTALACION EXITOSA - sistema listo para caja
echo    Doble clic en "Abrir Caja 360MAX" para operar.
echo  ================================================
echo.
timeout /t 8 >nul
exit /b 0
