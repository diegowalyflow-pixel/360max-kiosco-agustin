#!/usr/bin/env node
'use strict';
/*
  ═══════════════════════════════════════════════════════════════════════════
  360MAX COMERCIOS — INYECCIÓN DEL CATÁLOGO REAL (CLIENTE: AGUSTÍN)
  ═══════════════════════════════════════════════════════════════════════════
  Carga nativa de Node (SIN PowerShell, como pide el entorno de producción):
      node src/scripts/seedAgustin.js
      npm run sembrar-agustin

  Qué hace, en una sola pasada idempotente:
    1) Crea las categorías lógicas si no existen y les fija su MARGEN de rubro.
    2) Depura el catálogo de DEMO (los códigos «7790000000…», sin ventas) para
       que la base del local quede con las referencias REALES únicamente.
    3) Inserta/actualiza cada referencia con su COSTO en CENTAVOS estrictos
       (costo × 100) y su stock actual (50 por defecto si no se declaró).
    4) Asegura el usuario administrador «Agustín».

  Opciones:
    --conservar-demo   No borra los 18 productos de demostración.
    --forzar-stock     Vuelca también el stock declarado sobre productos ya
                       existentes (por defecto se conserva el stock vivo).
*/
const CONSERVAR_DEMO = process.argv.includes('--conservar-demo');
const FORZAR_STOCK = process.argv.includes('--forzar-stock');

/* Sin catálogo de demostración: acá se carga el de Agustín (salvo que se pida
   conservarlo). Debe fijarse ANTES de requerir la base. */
if (!CONSERVAR_DEMO) process.env.SEMBRAR_DEMO = '0';

const { lista, db, asegurarCategoria, CLAVE_DEMO, DB_PATH } = require('../db');
const { nuevaClave } = require('../lib/claves');
const { resolverPrecio } = require('../lib/precios');
const { CATEGORIAS, DATOS, STOCK_POR_DEFECTO } = require('./catalogoAgustin');

function linea(c) { console.log('─'.repeat(64)); if (c) console.log(c); }
function money(n) { return '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/* El administrador «Agustín» debe existir para poder operar la terminal. */
async function asegurarAdmin() {
  const ya = await db.prepare('SELECT id FROM usuarios ORDER BY id LIMIT 1').get();
  if (ya) return { id: ya.id, creado: false };
  const { hash, salt } = nuevaClave(CLAVE_DEMO);
  const r = await db.prepare(
    "INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt) VALUES (?, 'administrador', 'administrador', ?, ?)")
    .run('Agustín', hash, salt);
  return { id: r.lastInsertRowid, creado: true };
}

/* Depura el catálogo de demostración (códigos 7790000000…):
     • los que NO tienen ventas → se borran (con sus movimientos);
     • los que SÍ tienen ventas → se desactivan (activo = 0) para preservar el
       histórico de ventas y que igual desaparezcan de la caja.
   Devuelve cuántos se borraron y cuántos se desactivaron. */
async function limpiarDemo() {
  const demo = await db.prepare("SELECT id FROM productos WHERE codigo_barra LIKE '77900000000%'").all();
  if (!demo.length) return { borrados: 0, desactivados: 0 };
  const ids = demo.map((d) => d.id);
  const ph = ids.map(() => '?').join(',');
  const vendidos = await db.prepare('SELECT DISTINCT producto_id AS id FROM venta_items WHERE producto_id IN (' + ph + ')').all(...ids);
  const protegidos = new Set(vendidos.map((v) => v.id));
  const borrar = ids.filter((id) => !protegidos.has(id));
  const desactivar = ids.filter((id) => protegidos.has(id));
  if (borrar.length) {
    const phB = borrar.map(() => '?').join(',');
    await db.prepare('DELETE FROM movimientos WHERE producto_id IN (' + phB + ')').run(...borrar);
    await db.prepare('DELETE FROM productos WHERE id IN (' + phB + ')').run(...borrar);
  }
  if (desactivar.length) {
    const phD = desactivar.map(() => '?').join(',');
    await db.prepare('UPDATE productos SET activo = 0 WHERE id IN (' + phD + ')').run(...desactivar);
  }
  return { borrados: borrar.length, desactivados: desactivar.length };
}
async function main() {
  linea();
  console.log('  360MAX COMERCIOS · Catálogo real de AGUSTÍN');
  console.log('  Base de datos: ' + DB_PATH);
  linea();
  await lista;                                   /* esquema + migraciones listas */

  const admin = await asegurarAdmin();
  if (admin.creado) console.log('• Se creó el administrador «Agustín» (clave ' + CLAVE_DEMO + ').');

  const dep = CONSERVAR_DEMO ? { borrados: 0, desactivados: 0 } : await limpiarDemo();
  if (dep.borrados || dep.desactivados) {
    console.log('• Depuración del catálogo de demostración: ' + dep.borrados + ' borrado(s)' +
      (dep.desactivados ? ', ' + dep.desactivados + ' desactivado(s) porque tenían ventas' : '') + '.');
  }

  /* 1) Categorías + margen de ganancia por rubro. */
  for (const [nombre, margen] of CATEGORIAS) {
    const id = await asegurarCategoria(nombre);
    await db.prepare('UPDATE categorias SET margen_ganancia_defecto = ? WHERE id = ?').run(margen, id);
  }
  const catId = new Map();
  for (const c of await db.prepare('SELECT id, nombre FROM categorias').all()) catId.set(String(c.nombre).toLowerCase(), c.id);

  /* 2) Referencias: alta/actualización con costo en centavos y stock. */
  const vistos = new Map();
  const conflictos = [];
  const repetidos = [];
  let insertados = 0, actualizados = 0, omitidos = 0;

  for (const [categoria, codigo, nombre, costo, stockCrudo] of DATOS) {
    const cod = String(codigo).trim();
    if (!cod) { omitidos++; continue; }
    if (vistos.has(cod)) {                                /* código repetido: se conserva el primero */
      const primero = vistos.get(cod);
      if (primero !== nombre && repetidos.length < 30) {
        repetidos.push('código ' + cod + ': se omite «' + nombre + '» («' + primero + '» ya figuraba)');
      }
      omitidos++;
      continue;
    }
    vistos.set(cod, nombre);

    const stock = (stockCrudo === undefined || stockCrudo === null || stockCrudo === '')
      ? STOCK_POR_DEFECTO : Number(stockCrudo);
    const cid = catId.get(String(categoria).toLowerCase()) || null;
    const costoCent = Math.round(Number(costo) * 100);
    const existente = await db.prepare('SELECT id, nombre FROM productos WHERE codigo_barra = ?').get(cod);

    if (existente) {
      if (String(existente.nombre) !== nombre && conflictos.length < 20) {
        conflictos.push('código ' + cod + ': se conserva «' + existente.nombre + '» (la lista también trae «' + nombre + '»)');
      }
      if (FORZAR_STOCK) {
        await db.prepare(`UPDATE productos SET nombre = ?, categoria_id = ?, costo = ?, costo_centavos = ?,
                            stock = ?, activo = 1, actualizado = datetime('now','localtime') WHERE id = ?`)
          .run(nombre, cid, Number(costo), costoCent, stock, existente.id);
      } else {
        await db.prepare(`UPDATE productos SET nombre = ?, categoria_id = ?, costo = ?, costo_centavos = ?,
                            activo = 1, actualizado = datetime('now','localtime') WHERE id = ?`)
          .run(nombre, cid, Number(costo), costoCent, existente.id);
      }
      actualizados++;
    } else {
      const r = await db.prepare(`INSERT INTO productos
          (nombre, categoria_id, unidad, codigo_barra, costo, costo_centavos, precio, precio_fijo_centavos, stock, stock_minimo, activo)
          VALUES (?, ?, 'UNIDAD', ?, ?, ?, 0, NULL, ?, 0, 1)`)
        .run(nombre, cid, cod, Number(costo), costoCent, stock);
      await db.prepare(`INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, motivo)
                        VALUES (?, 'entrada', ?, ?, ?, 'Carga inicial catálogo Agustín')`)
        .run(r.lastInsertRowid, stock, stock, admin.id);
      insertados++;
    }
  }

  /* 3) Verificación final: cuántos SKU quedaron activos y su precio efectivo. */
  const total = (await db.prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1').get()).n;
  const conCosto = (await db.prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1 AND costo_centavos > 0').get()).n;
  const sinCosto = total - conCosto;
  const muestras = await db.prepare(`SELECT p.nombre, p.costo_centavos, p.precio_fijo_centavos,
                                            IFNULL(c.margen_ganancia_defecto, 40) AS margen
                                       FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
                                      WHERE p.activo = 1 ORDER BY p.id DESC LIMIT 3`).all();

  linea();
  console.log('  RESULTADO DE LA INYECCIÓN');
  linea();
  console.log('  Referencias en la lista ........: ' + DATOS.length);
  console.log('  Códigos de barras únicos .......: ' + vistos.size);
  console.log('  Insertados (nuevos) ............: ' + insertados);
  console.log('  Actualizados (ya existían) .....: ' + actualizados);
  console.log('  Omitidos (código repetido) .....: ' + omitidos);
  console.log('  Productos activos en la base ...: ' + total);
  if (sinCosto) console.log('  Aviso: ' + sinCosto + ' producto(s) sin costo (el precio por margen daría $0).');
  if (conflictos.length) {
    console.log('');
    console.log('  Códigos con nombres distintos (se conservó el primero):');
    conflictos.forEach((c) => console.log('   · ' + c));
  }
  if (repetidos.length) {
    console.log('');
    console.log('  Códigos de barras repetidos en la lista (se cargó el primero):');
    repetidos.forEach((c) => console.log('   · ' + c));
  }
  console.log('');
  if (muestras.length) {
    console.log('  Últimos cargados (precio efectivo con el margen del rubro):');
    for (const m of muestras) {
      const r = resolverPrecio({ costo_centavos: m.costo_centavos, precio_fijo_centavos: m.precio_fijo_centavos,
        margen_ganancia_defecto: m.margen, precio: 0 });
      console.log('   · ' + m.nombre + ' → costo ' + money(m.costo_centavos / 100) + ' · ' + r.origen + ' ' + money(r.pesos));
    }
  }
  linea();
  console.log(total >= vistos.size
    ? '✓ CATÁLOGO DE AGUSTÍN CARGADO Y LISTO (' + total + ' productos activos).'
    : '✗ Revisar: quedaron menos productos activos que los esperados.');
  linea();
}

main().catch((e) => {
  console.error('✗ ERROR en la inyección del catálogo: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});