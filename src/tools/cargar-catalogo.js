#!/usr/bin/env node
'use strict';
/*
  ═══════════════════════════════════════════════════════════════════════════
  360MAX COMERCIOS (AGUSTÍN) — CARGA DEL CATÁLOGO REAL (SQLite nativo)
  ═══════════════════════════════════════════════════════════════════════════
  Versión autocontenida que SÍ funciona con la API actual de src/db.js
  (exporta: DB_PATH, lista, prepare, exec, transaction).

  Toma el catálogo real de src/scripts/catalogoAgustin.js y lo inyecta en la
  base SQLite local (data/360max.db), en una sola transacción:
     1) crea las categorías con su margen de rubro (idempotente);
     2) inserta cada producto con su COSTO en centavos y su stock;
     3) asegura el usuario administrador «Agustín» si no hay ninguno.

  USO
    node src/tools/cargar-catalogo.js
    npm run cargar-catalogo
*/

const { lista, prepare, transaction, DB_PATH } = require('../db');
const { nuevaClave } = require('../lib/claves');
const { CATEGORIAS, DATOS } = require('../scripts/catalogoAgustin');

function linea(c) { console.log('─'.repeat(64)); if (c) console.log(c); }
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function asegurarAdmin() {
  const ya = await prepare('SELECT id FROM usuarios ORDER BY id LIMIT 1').get();
  if (ya) return ya.id;
  const salt = 'agustin_salt';
  const hash = nuevaClave('demo360max!', salt);
  const r = await prepare(
    "INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt) VALUES ('Agustín', 'administrador', 'administrador', ?, ?)"
  ).run(hash, salt);
  return r.lastInsertRowid;
}

async function asegurarCategorias() {
  const ids = {};
  for (const [nombre, margen] of CATEGORIAS) {
    const ex = await prepare('SELECT id FROM categorias WHERE nombre = ?').get(nombre);
    if (ex) {
      ids[nombre] = ex.id;
      await prepare('UPDATE categorias SET margen_ganancia_defecto = ? WHERE id = ?').run(margen, ex.id);
    } else {
      const r = await prepare(
        'INSERT INTO categorias (nombre, margen_ganancia_defecto) VALUES (?, ?)'
      ).run(nombre, margen);
      ids[nombre] = r.lastInsertRowid;
    }
  }
  return ids;
}

async function main() {
  await lista; // abre y migra la base

  console.log('═'.repeat(64));
  console.log('  360MAX — CARGA DEL CATÁLOGO DE AGUSTÍN  ·  base: ' + DB_PATH);
  console.log('═'.repeat(64));
  console.log('  Referencias en el catálogo: ' + DATOS.length);
  console.log('');

  const adminId = await asegurarAdmin();
  const catIds = await asegurarCategorias();

  let insertados = 0, actualizados = 0, omitidos = 0;
  const vistos = new Set();

  await transaction(async () => {
    for (const [catNombre, cod, nombre, costo, stock] of DATOS) {
      if (vistos.has(cod)) { omitidos++; continue; }
      vistos.add(cod);

      const cid = catIds[catNombre];
      if (!cid) { omitidos++; continue; }

      const costoCent = Math.round(Number(costo) * 100);
      const stockNum = Number.isFinite(Number(stock)) ? Number(stock) : 50;

      const ex = await prepare('SELECT id FROM productos WHERE codigo_barra = ?').get(cod);
      if (ex) {
        await prepare(
          `UPDATE productos SET nombre = ?, categoria_id = ?, costo = ?, costo_centavos = ?,
                  activo = 1, actualizado = datetime('now','localtime') WHERE id = ?`
        ).run(nombre, cid, Number(costo), costoCent, ex.id);
        actualizados++;
      } else {
        const r = await prepare(
          `INSERT INTO productos
             (nombre, categoria_id, unidad, codigo_barra, costo, costo_centavos, precio, precio_fijo_centavos, stock, stock_minimo, activo)
           VALUES (?, ?, 'UNIDAD', ?, ?, ?, 0, NULL, ?, 0, 1)`
        ).run(nombre, cid, cod, Number(costo), costoCent, stockNum);
        await prepare(
          `INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, motivo)
           VALUES (?, 'entrada', ?, ?, ?, 'Carga inicial catálogo Agustín')`
        ).run(r.lastInsertRowid, stockNum, stockNum, adminId);
        insertados++;
      }
    }
  })();

  const total = (await prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1').get()).n;
  const conCosto = (await prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1 AND costo_centavos > 0').get()).n;

  linea();
  console.log('  Insertados (nuevos) ............: ' + insertados);
  console.log('  Actualizados (ya existían) .....: ' + actualizados);
  console.log('  Omitidos (código repetido) .....: ' + omitidos);
  console.log('  Productos activos en la base ...: ' + total + ' (' + conCosto + ' con costo)');
  linea();
  console.log(total >= vistos.size
    ? '✓ CATÁLOGO CARGADO (' + total + ' productos activos). Ya podés subir los precios.'
    : '✗ Revisar: quedaron menos productos activos que los esperados.');
  linea();
}

main().catch((e) => {
  console.error('✗ ERROR cargando el catálogo: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});

