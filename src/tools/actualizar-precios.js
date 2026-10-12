#!/usr/bin/env node
'use strict';
/*
  ═══════════════════════════════════════════════════════════════════════════
  360MAX COMERCIOS (AGUSTÍN) — ACTUALIZACIÓN RÁPIDA DE PRECIOS (+%)
  ═══════════════════════════════════════════════════════════════════════════
  Base SQLite nativa del proyecto (data/360max.db vía src/db.js). Sin psql,
  sin servicios externos: corre con Node y la misma conexión que usa la caja.

  El precio de venta se resuelve con el esquema HÍBRIDO del sistema:
      1) precio_fijo_centavos  → precio EXACTO (excepción manual)
      2) costo_centavos × (1 + margen_categoría/100)  → cálculo al vuelo
  Para que el precio que ve el cliente suba el % indicado en AMBOS casos:
      · sube costo_centavos y costo  el % indicado  (afecta el cálculo x margen)
      · sube precio_fijo_centavos     el % indicado  (afecta los de precio fijo)
      · si un producto no tiene costo ni fijo, sube el precio base guardado.

  USO
    node src/tools/actualizar-precios.js --pct=10 --dry-run   # solo muestra
    node src/tools/actualizar-precios.js --pct=10             # aplica de verdad
    npm run precios -- --pct=10 --dry-run
    npm run precios -- --pct=10

  Se ejecuta dentro de una transacción (BEGIN/COMMIT). Si algo falla, hace
  ROLLBACK y la base queda intacta.
*/

const { lista, prepare, transaction, DB_PATH } = require('../db');

/* ── parseo simple de argumentos ─────────────────────────────────────── */
function leerFlag(nombre) {
  const eq = '--' + nombre + '=';
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--' + nombre) {
      const next = process.argv[i + 1];
      return next && !next.startsWith('--') ? next : 'true';
    }
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return null;
}

const dryRun = process.argv.includes('--dry-run');
const pct = Number(leerFlag('pct') || leerFlag('porcentaje') || '10');
if (!Number.isFinite(pct) || pct <= 0) {
  console.error('✗ Indicá un porcentaje válido, ej: --pct=10');
  process.exit(1);
}
const factor = 1 + pct / 100;

const cent = (n) => Math.round(Number(n) || 0);
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Precio de venta efectivo de una fila (réplica de src/lib/precios.js). */
function precioEfectivo(f) {
  const fijo = cent(f.precio_fijo_centavos);
  if (fijo > 0) return fijo / 100;
  const costo = cent(f.costo_centavos);
  if (costo > 0) return Math.round(costo * (1 + (Number(f.margen) || 0) / 100)) / 100;
  return Number(f.precio) || 0;
}

async function main() {
  await lista; // espera a que la base esté abierta y migrada

  const filas = await prepare(
    `SELECT p.id, p.nombre, p.costo_centavos, p.costo, p.precio, p.precio_fijo_centavos,
            IFNULL(c.margen_ganancia_defecto, 40) AS margen
       FROM productos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.activo = 1
      ORDER BY p.id`
  ).all();

  console.log('═'.repeat(64));
  console.log('  360MAX — ACTUALIZACIÓN DE PRECIOS  ·  base: ' + DB_PATH);
  console.log('═'.repeat(64));
  console.log('  Modo             : ' + (dryRun ? 'DRY-RUN (no escribe)' : 'APLICAR (escribe)'));
  console.log('  Aumento          : +' + pct + '%');
  console.log('  Productos activos: ' + filas.length);
  console.log('');

  if (!filas.length) {
    console.log('  No hay productos activos para actualizar. Cargá el catálogo primero');
    console.log('  (npm run sembrar-agustin) y volvé a ejecutar.');
    return;
  }

  let porFijo = 0, porMargen = 0, porBase = 0;
  let sumaAntes = 0, sumaDespues = 0;
  const cambios = filas.map((f) => {
    const costoCent = cent(f.costo_centavos);
    const fijoCent = cent(f.precio_fijo_centavos);
    const antes = precioEfectivo(f);

    const nuevoCostoCent = costoCent > 0 ? Math.round(costoCent * factor) : 0;
    const nuevoFijoCent = fijoCent > 0 ? Math.round(fijoCent * factor) : 0;
    const nuevoPrecioBase = costoCent === 0 && fijoCent === 0
      ? Math.round((Number(f.precio) || 0) * factor * 100) / 100
      : (Number(f.precio) || 0);

    let origen = 'base';
    if (fijoCent > 0) { origen = 'fijo'; porFijo++; }
    else if (costoCent > 0) { origen = 'margen'; porMargen++; }
    else porBase++;

    const despues = origen === 'fijo'
      ? nuevoFijoCent / 100
      : origen === 'margen'
        ? Math.round(nuevoCostoCent * (1 + (Number(f.margen) || 0) / 100)) / 100
        : nuevoPrecioBase;

    sumaAntes += antes;
    sumaDespues += despues;
    return { id: f.id, nuevoCostoCent, nuevoFijoCent, nuevoPrecioBase, origen, antes, despues };
  });

  const muestra = cambios.slice(0, 12);
  for (const c of muestra) {
    const f = filas.find((x) => x.id === c.id);
    console.log('  · ' + String(f.nombre).slice(0, 34).padEnd(34) +
      ' ' + money(c.antes).padStart(10) + '  →  ' + money(c.despues).padStart(10) +
      '  [' + c.origen + ']');
  }
  if (cambios.length > muestra.length) console.log('  … y ' + (cambios.length - muestra.length) + ' productos más.');
  console.log('');
  console.log('  Por precio fijo  : ' + porFijo);
  console.log('  Por margen       : ' + porMargen);
  console.log('  Por precio base  : ' + porBase);
  console.log('  Suma antes       : ' + money(sumaAntes));
  console.log('  Suma después     : ' + money(sumaDespues));
  console.log('');

  if (dryRun) {
    console.log('  ✓ DRY-RUN: no se escribió nada. Para aplicar de verdad:');
    console.log('      node src/tools/actualizar-precios.js --pct=' + pct);
    return;
  }

  await transaction(async () => {
    for (const c of cambios) {
      if (c.nuevoCostoCent > 0) {
        await prepare('UPDATE productos SET costo_centavos = ?, costo = ? WHERE id = ?')
          .run(c.nuevoCostoCent, c.nuevoCostoCent / 100, c.id);
      }
      if (c.nuevoFijoCent > 0) {
        await prepare('UPDATE productos SET precio_fijo_centavos = ? WHERE id = ?')
          .run(c.nuevoFijoCent, c.id);
      }
      if (c.origen === 'base') {
        await prepare('UPDATE productos SET precio = ? WHERE id = ?')
          .run(c.nuevoPrecioBase, c.id);
      }
    }
  })();

  console.log('  ✓ LISTO: ' + cambios.length + ' productos actualizados +' + pct + '%.');
  console.log('  ✓ COMMIT realizado. La base ' + DB_PATH + ' tiene los precios nuevos.');
}

main().catch((e) => {
  console.error('✗ ERROR actualizando precios: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});

