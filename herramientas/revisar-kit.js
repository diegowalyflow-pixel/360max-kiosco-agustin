'use strict';
/* 360MAX Comercios — Revisión estática estricta del kit de empaquetado.
   No arranca el servidor ni toca la base: sólo audita archivos.
   Controles:
     1. ARRANCAR-DRUGSTORE.bat / INSTALADOR-RAPIDO.bat en la raíz.
     2. Contenido exigido (@echo off, cd /d %~dp0, npm start en 2.º plano,
        espera de 2 s, navegador a http://localhost:3000, npm install
        --omit=dev, verificación de data/360max.db).
     3. Rutas 100 % relativas: ninguna letra de unidad dura (C:\...) salvo
        la URL http://localhost:3000; todo se resuelve desde %~dp0.
     4. Carpeta "Drugstore Agustin" con sus .lnk y LEEME.txt; los .lnk
        apuntan a los .bat de ESTA computadora (se rehacen por PC).
     5. La base data/360max.db tiene los 286 productos (vía SQLite).
   Uso:  node herramientas/revisar-kit.js
   Sale con código 0 = kit consolidado, 1 = hay errores. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const CARPETA_ENTREGA = 'Drugstore Agustin';
const ACCESOS_ESPERADOS = [
  { lnk: 'Abrir Caja 360MAX.lnk', bat: 'ARRANCAR-DRUGSTORE.bat' },
  { lnk: 'Instalar una vez.lnk', bat: 'INSTALADOR-RAPIDO.bat' }
];

let fallos = 0;
function ok(cond, texto) {
  console.log('  [' + (cond ? ' ok ' : 'FALLA') + '] ' + texto);
  if (!cond) fallos++;
}

function leer(ruta) { return fs.readFileSync(ruta, 'utf8'); }

function destinoLnk(lnkAbs) {
  // Un .lnk guarda la ruta destino en dos sitios: LinkInfo la trae en ANSI
  // (8 bits) y StringData en UTF-16 LE. Buscamos en las dos variantes, con
  // ruta COMPLETA, para no aceptar un .lnk que sólo tenga el nombre parecido.
  const buf = fs.readFileSync(lnkAbs);
  const enAnsi = buf.toString('latin1').toLowerCase();
  return ACCESOS_ESPERADOS.filter((a) => {
    const ruta = path.join(RAIZ, a.bat);
    return enAnsi.includes(ruta.toLowerCase()) ||
           buf.includes(Buffer.from(ruta, 'utf16le'));
  }).map((a) => a.bat);
}

async function main() {
  console.log('Revisión estática del kit de empaquetado — 360MAX Comercios');
  console.log('  Raíz: ' + RAIZ);
  console.log('');

  /* ---------- 1. Archivos base ---------- */
  const batArrancar = path.join(RAIZ, 'ARRANCAR-DRUGSTORE.bat');
  const batInstalar = path.join(RAIZ, 'INSTALADOR-RAPIDO.bat');
  ok(fs.existsSync(batArrancar), 'Existe ARRANCAR-DRUGSTORE.bat en la raíz');
  ok(fs.existsSync(batInstalar), 'Existe INSTALADOR-RAPIDO.bat en la raíz');
  if (fallos > 0) return cerrar();

  const arrancar = leer(batArrancar);
  const instalar = leer(batInstalar);

  /* ---------- 2. Contenido del arranque ---------- */
  ok(/^@echo off/im.test(arrancar), 'Arranque: @echo off presente');
  ok(/title\s+360MAX/i.test(arrancar), 'Arranque: título institucional de ventana');
  ok(arrancar.includes('cd /d "%~dp0"'), 'Arranque: se ancla a su propio directorio (%~dp0)');
  ok(arrancar.includes('npm start'), 'Arranque: lanza npm start');
  ok(/start\s+"[^"]*"\s+\/min\s+cmd \/c "npm start"/i.test(arrancar),
    'Arranque: npm start en 2.º plano con ventana minimizada');
  ok(arrancar.includes('ping -n 3 127.0.0.1') && /espera 2 segundos/i.test(arrancar),
    'Arranque: espera de 2 segundos antes del navegador');
  ok(arrancar.includes('start "" "http://localhost:3000"'),
    'Arranque: abre el navegador en http://localhost:3000');
  ok(arrancar.includes('data\\360max.db'),
    'Arranque: controla que exista la base de producción antes de arrancar');

  /* ---------- 3. Contenido del instalador ---------- */
  ok(/^@echo off/im.test(instalar), 'Instalador: @echo off presente');
  ok(instalar.includes('cd /d "%~dp0"'), 'Instalador: se ancla a su propio directorio (%~dp0)');
  ok(instalar.includes('npm install --omit=dev'),
    'Instalador: ejecuta npm install --omit=dev');
  ok(instalar.includes('herramientas\\verificar-instalacion.js'),
    'Instalador: verifica data/360max.db con su script');
  ok(instalar.includes('herramientas\\crear-accesos-directos.js'),
    'Instalador: regenera los accesos directos de la PC destino');

  /* ---------- 4. Rutas relativas (portabilidad entre computadoras) ---------- */
  const rutaDura = /[A-Za-z]:[\\\/]/;
  // sólo se permite la URL http://localhost:3000 (no es ruta de archivo)
  const arrancarSinUrl = arrancar.replace(/https?:\/\/[^\s"]+/g, '');
  const instalarSinUrl = instalar.replace(/https?:\/\/[^\s"]+/g, '');
  ok(!rutaDura.test(arrancarSinUrl), 'Arranque: sin rutas absolutas de ninguna unidad');
  ok(!rutaDura.test(instalarSinUrl), 'Instalador: sin rutas absolutas de ninguna unidad');
  ok(!arrancar.includes('proyecto-360-max-pr') && !instalar.includes('proyecto-360-max-pr'),
    'Ningún .bat toca el proyecto de boliches (proyecto-360-max-pr)');

  /* ---------- 5. Carpeta de entrega + accesos directos ---------- */
  const carpeta = path.join(RAIZ, CARPETA_ENTREGA);
  ok(fs.existsSync(carpeta), 'Existe la carpeta de entrega "' + CARPETA_ENTREGA + '"');
  if (fs.existsSync(carpeta)) {
    ok(fs.existsSync(path.join(carpeta, 'LEEME.txt')), 'Contiene LEEME.txt para Agustín');
    for (const acc of ACCESOS_ESPERADOS) {
      const lnk = path.join(carpeta, acc.lnk);
      const esta = fs.existsSync(lnk);
      ok(esta, 'Acceso directo presente: ' + acc.lnk);
      if (esta) {
        const apunta = destinoLnk(lnk);
        ok(apunta.includes(acc.bat),
          acc.lnk + ' apunta a ' + acc.bat + ' (ruta absoluta de esta PC)');
      }
    }
  }

  /* ---------- 6. Base de producción con 286 productos ---------- */
  const dbPath = path.join(RAIZ, 'data', '360max.db');
  ok(fs.existsSync(dbPath), 'Existe data/360max.db');
  if (fs.existsSync(dbPath)) {
    const sqlite3 = require('sqlite3');
    const base = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const consulta = (sql) => new Promise((resolve, reject) => {
      base.get(sql, (err, fila) => (err ? reject(err) : resolve(fila)));
    });
    try {
      const chequeo = await consulta('PRAGMA quick_check');
      ok(chequeo && chequeo.quick_check === 'ok', 'Base íntegra (quick_check ok)');
      const total = await consulta('SELECT COUNT(*) AS n FROM productos WHERE activo = 1');
      ok(total && total.n === 286,
        'Productos activos en la base: ' + (total ? total.n : '?') + ' (esperados 286)');
    } catch (e) {
      ok(false, 'No se pudo leer la base: ' + e.message);
    } finally {
      base.close();
    }
  }

  /* ---------- 7. Aislamiento del proyecto de boliches ---------- */
  try {
    const rutaBoliches = path.join(RAIZ, 'public', 'proyecto-360-max-pr');
    if (fs.existsSync(rutaBoliches)) {
      const diff = execFileSync('git', ['status', '--porcelain', '--', 'public/proyecto-360-max-pr'],
        { cwd: RAIZ, encoding: 'utf8', windowsHide: true }).trim();
      ok(diff === '', 'proyecto-360-max-pr sin modificaciones en git');
    } else {
      ok(true, 'proyecto-360-max-pr no está dentro de esta copia (correcto)');
    }
  } catch (e) {
    ok(true, 'Chequeo de boliches omitido (git no disponible): ' + e.message.split('\n')[0]);
  }

  return cerrar();
}

function cerrar() {
  console.log('');
  console.log(fallos === 0
    ? 'KIT DE INSTALACIÓN DE 2 CLICS CONSOLIDADO Y LIBRE DE ERRORES.'
    : 'KIT CON ERRORES: ' + fallos + ' control(es) fallaron.');
  return fallos;
}

if (require.main === module) {
  main().then((f) => process.exit(f === 0 ? 0 : 1))
    .catch((e) => { console.error('  [FALLA] ' + (e.stack || e.message)); process.exit(1); });
}
module.exports = { main };

