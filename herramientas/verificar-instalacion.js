'use strict';
/* 360MAX Comercios — Verificación de instalación (post-copia a la PC caja).
   Comprueba lo mínimo para arrancar:
     1. Node >= 18 y npm disponibles.
     2. node_modules/ con express, sqlite3 y xlsx (npm install --omit=dev).
     3. data/360max.db presente, íntegro (PRAGMA quick_check) y con los
        286 productos activos del catálogo de Agustín + costos cargados.
   Uso:  node herramientas/verificar-instalacion.js
   Sale con código 0 = todo OK, 1 = falta algo (lo informa en castellano). */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const DB = path.join(RAIZ, 'data', '360max.db');
const PRODUCTOS_ESPERADOS = 286;

let fallos = 0;
function ok(cond, texto) {
  console.log('  [' + (cond ? ' ok ' : 'FALLA') + '] ' + texto);
  if (!cond) fallos++;
}

function npmDisponible() {
  // npm es npm.cmd en Windows: hay que invocarlo vía shell (execFileSync no
  // lanza archivos .cmd desde Node 18+).
  try { execSync('npm --version', { stdio: 'pipe', windowsHide: true, shell: true }); return true; }
  catch (e) { return false; }
}

async function main() {
  console.log('Verificación de instalación — 360MAX Comercios');

  const mayor = Number(process.versions.node.split('.')[0]);
  ok(mayor >= 18, 'Node.js ' + process.version + ' (requiere >= 18)');
  ok(npmDisponible(), 'npm disponible');

  const faltan = [];
  for (const mod of ['express', 'sqlite3', 'xlsx']) {
    try { require.resolve(mod, { paths: [RAIZ] }); }
    catch (e) { faltan.push(mod); }
  }
  ok(faltan.length === 0, faltan.length === 0
    ? 'Librerías instaladas (express, sqlite3, xlsx)'
    : 'Faltan librerías: ' + faltan.join(', ') + ' → correr npm install --omit=dev');

  const existe = fs.existsSync(DB);
  ok(existe, existe ? 'Base data/360max.db presente (' + fs.statSync(DB).size + ' bytes)'
                    : 'Falta data/360max.db — copiar la carpeta data del proyecto original');
  if (!existe) return cerrar();

  // Abrimos la base en modo lectura para no tocar nada de producción.
  const sqlite3 = require('sqlite3');
  const base = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
  const consulta = (sql) => new Promise((resolve, reject) => {
    base.get(sql, (err, fila) => (err ? reject(err) : resolve(fila)));
  });

  try {
    const chequeo = await consulta('PRAGMA quick_check');
    ok(chequeo && chequeo.quick_check === 'ok',
      'Archivo de base íntegro (quick_check: ' + (chequeo && chequeo.quick_check) + ')');

    const total = await consulta('SELECT COUNT(*) AS n FROM productos WHERE activo = 1');
    ok(total && total.n === PRODUCTOS_ESPERADOS,
      'Productos activos: ' + (total ? total.n : '?') + ' (esperados ' + PRODUCTOS_ESPERADOS + ')');

    const sinCosto = await consulta(
      'SELECT COUNT(*) AS n FROM productos WHERE activo = 1 AND IFNULL(costo_centavos, 0) = 0');
    ok(sinCosto && sinCosto.n === 0,
      'Productos sin costo cargado: ' + (sinCosto ? sinCosto.n : '?') + ' (esperados 0)');

    const categorias = await consulta(
      'SELECT COUNT(*) AS n FROM categorias WHERE margen_ganancia_defecto IS NOT NULL');
    ok(categorias && categorias.n > 0,
      'Categorías con margen de ganancia: ' + (categorias ? categorias.n : '?'));
  } catch (e) {
    ok(false, 'No se pudo leer la base: ' + e.message);
  } finally {
    base.close();
  }

  return cerrar();
}

function cerrar() {
  console.log(fallos === 0
    ? 'VERIFICACIÓN DE INSTALACIÓN OK — sistema listo para arrancar.'
    : 'VERIFICACIÓN DE INSTALACIÓN: ' + fallos + ' problema(s) detectado(s).');
  return fallos;
}

if (require.main === module) {
  main().then((f) => process.exit(f === 0 ? 0 : 1))
    .catch((e) => { console.error('  [FALLA] ' + e.message); process.exit(1); });
}
module.exports = { main };
