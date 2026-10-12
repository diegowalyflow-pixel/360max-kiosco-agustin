'use strict';
/* Verificación del catálogo cargado (esquema híbrido de precios).
   Lee la base configurada por DB_PATH (por defecto data/360max.db) y reporta:
     • cuántos productos activos hay y cómo se reparten por rubro y margen;
     • el PRECIO EFECTIVO resuelto de una muestra de códigos reales;
     • cuántos productos de demostración quedaron activos (deberían ser 0).
   Uso:  node herramientas/verificar-catalogo.js
*/
const { lista, db, DB_PATH } = require('../src/db');
const { resolverPrecio } = require('../src/lib/precios');

const MUESTRA = ['7312040350056', '7790040133587', '7790895000782', '1111111', '9999910', '77976956'];
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

lista.then(async () => {
  console.log('Base de datos: ' + DB_PATH + '\n');

  const tot = (await db.prepare('SELECT COUNT(*) n FROM productos').get()).n;
  const act = (await db.prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1').get()).n;
  const sinCosto = (await db.prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1 AND (costo_centavos IS NULL OR costo_centavos <= 0)').get()).n;
  console.log('Productos: ' + tot + ' totales · ' + act + ' activos · ' + sinCosto + ' sin costo');

  console.log('\nPor rubro (margen / cantidad de SKU activos):');
  const porRubro = await db.prepare(`
    SELECT c.nombre, c.margen_ganancia_defecto AS margen, COUNT(*) AS n
      FROM productos p JOIN categorias c ON c.id = p.categoria_id
     WHERE p.activo = 1 GROUP BY c.id ORDER BY n DESC`).all();
  porRubro.forEach((r) => console.log('  ' + r.nombre.padEnd(22) + r.margen + '%  →  ' + r.n + ' SKU'));

  console.log('\nPrecio efectivo de una muestra (fijo o costo × margen):');
  for (const cod of MUESTRA) {
    const p = await db.prepare(`
      SELECT p.nombre, p.costo_centavos, p.precio_fijo_centavos, IFNULL(c.margen_ganancia_defecto, 40) AS margen
        FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.codigo_barra = ?`).get(cod);
    if (!p) { console.log('  ' + cod + ' → NO ESTÁ en la base'); continue; }
    const r = resolverPrecio({ costo_centavos: p.costo_centavos, precio_fijo_centavos: p.precio_fijo_centavos, margen_ganancia_defecto: p.margen, precio: 0 });
    console.log('  ' + cod + '  ' + p.nombre.padEnd(30) + ' costo ' + money(p.costo_centavos / 100) +
      '  →  ' + r.origen + ' ' + money(r.pesos));
  }

  const demo = (await db.prepare("SELECT COUNT(*) n FROM productos WHERE codigo_barra LIKE '77900000000%' AND activo = 1").get()).n;
  console.log('\nProductos de demostración activos: ' + demo + (demo ? '  (¡revisar!)' : '  ✓ ninguno'));
  console.log((act > 0 && sinCosto === 0 && demo === 0) ? '\n✓ CATÁLOGO SANO Y LISTO.' : '\n⚠ Revisar lo señalado arriba.');
}).catch((e) => {
  console.error('✗ Error al verificar el catálogo: ' + e.message);
  process.exit(1);
});