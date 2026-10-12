'use strict';
/* 360MAX Comercios — Carpeta de entrega unificada «Drugstore Agustin».
   Crea (si no existe) el subdirectorio en la RAÍZ del proyecto y deja adentro
   los accesos directos de Windows (.lnk) apuntando a los .bat del centro:

     Drugstore Agustin/
       ├─ Abrir Caja 360MAX.lnk          -> ARRANCAR-DRUGSTORE.bat
       ├─ Instalar una vez.lnk           -> INSTALADOR-RAPIDO.bat
       └─ LEEME.txt                      -> instrucciones para Agustín

   Un .lnk guarda la ruta ABSOLUTA a la que apunta: por eso este script se
   vuelve a ejecutar en CADA computadora (lo hace solo INSTALADOR-RAPIDO.bat
   en su paso 4) y los accesos quedan siempre válidos al mudar de PC.
   La carpeta puede moverse al Escritorio: las rutas de los .bat viajan en
   el .lnk, no dependen de dónde esté la carpeta de entrega.
   Uso:  node herramientas/crear-accesos-directos.js
   Sale con código 0 = OK, 1 = algo falló. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const CARPETA_ENTREGA = 'Drugstore Agustin';

const ACCESOS = [
  { lnk: 'Abrir Caja 360MAX.lnk', bat: 'ARRANCAR-DRUGSTORE.bat',
    desc: 'Arranca el sistema de caja y abre el navegador' },
  { lnk: 'Instalar una vez.lnk', bat: 'INSTALADOR-RAPIDO.bat',
    desc: 'Instalacion inicial rapida (se ejecuta una sola vez)' }
];

const LEEME = [
  '360MAX COMERCIOS - DRUGSTORE AGUSTIN',
  '=====================================',
  '',
  'PRIMERA VEZ (viernes, al instalar la PC de la caja):',
  '  1. Doble clic en "Instalar una vez.lnk".',
  '  2. Esperar que diga INSTALACION EXITOSA.',
  '',
  'TODOS LOS DIAS:',
  '  1. Doble clic en "Abrir Caja 360MAX.lnk".',
  '  2. El navegador abre solo en http://localhost:3000.',
  '  3. No cerrar la ventana minimizada "360MAX - Servidor (no cerrar)".',
  '',
  'Si algo falla: cerrar todo y volver a ejecutar "Instalar una vez".',
  ''
].join('\r\n');

function ejecutarVbs(vbs) {
  // cscript sólo lee archivos: volcamos el .vbs a un temporal, lo corremos y
  // lo borramos. El VBS va en UTF-16 LE (BOM) para que cscript no malinterprete
  // acentos en rutas (C:\Users\Agustín\...). NUNCA usar //B: en modo batch
  // cscript silencia el WScript.Echo y no llegaría la confirmación "OK".
  const tmp = path.join(os.tmpdir(), '360max-kit-' + process.pid + '-' + Date.now() + '.vbs');
  fs.writeFileSync(tmp, '\ufeff' + vbs, 'utf16le');
  try {
    return String(execFileSync('cscript', ['//nologo', tmp],
      { encoding: 'utf8', windowsHide: true }));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ya borrado */ }
  }
}

function carpetasEscritorio() {
  // Escritorio estándar + variantes de OneDrive (carpetas redirigidas).
  // Se resuelve en Node puro para no depender de la codificación de stdout.
  const hogar = os.homedir();
  const candidatas = [
    path.join(hogar, 'Desktop'),
    path.join(hogar, 'Escritorio'),
    path.join(hogar, 'OneDrive', 'Desktop'),
    path.join(hogar, 'OneDrive', 'Escritorio')
  ];
  const vistas = new Set();
  const validas = [];
  for (const c of candidatas) {
    const clave = c.toLowerCase();
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    try {
      if (fs.statSync(c).isDirectory()) validas.push(c);
    } catch (e) { /* no existe esta variante */ }
  }
  return validas;
}

function generarVbs(destinoLnk, batAbs, raizAbs) {
  return [
    'Set o = CreateObject("WScript.Shell")',
    'Set l = o.CreateShortcut("' + destinoLnk + '")',
    'l.TargetPath = "' + batAbs + '"',
    'l.WorkingDirectory = "' + raizAbs + '"',
    'l.WindowStyle = 1',
    'l.Description = "360MAX Comercios - Drugstore Agustin"',
    'l.Save',
    'WScript.Echo "OK"'
  ].join('\r\n');
}

function crearAccesoDirecto(carpetaDestino, accion) {
  const batAbs = path.join(RAIZ, accion.bat);
  if (!fs.existsSync(batAbs)) {
    throw new Error('No existe el script central: ' + batAbs);
  }
  const lnkAbs = path.join(carpetaDestino, accion.lnk);
  const salida = ejecutarVbs(generarVbs(lnkAbs, batAbs, RAIZ));
  if (!salida.includes('OK')) throw new Error('cscript no confirmó: ' + salida);
  if (!fs.existsSync(lnkAbs)) throw new Error('No se creó: ' + lnkAbs);
  return lnkAbs;
}

function main() {
  const carpetas = [path.join(RAIZ, CARPETA_ENTREGA)];
  // Si la carpeta ya se movió al Escritorio, renovamos también esa copia.
  for (const escritorio of carpetasEscritorio()) {
    const enEscritorio = path.join(escritorio, CARPETA_ENTREGA);
    if (fs.existsSync(enEscritorio) && !carpetas.includes(enEscritorio)) carpetas.push(enEscritorio);
  }

  for (const carpeta of carpetas) {
    fs.mkdirSync(carpeta, { recursive: true });
    fs.writeFileSync(path.join(carpeta, 'LEEME.txt'), LEEME, 'utf8');
    for (const accion of ACCESOS) {
      const lnk = crearAccesoDirecto(carpeta, accion);
      console.log('  [ok] ' + lnk + '  ->  ' + accion.bat);
    }
  }
  console.log('Carpeta de entrega lista: ' + carpetas.join('  |  '));
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error('  [ERROR] ' + e.message);
  process.exit(1);
}
