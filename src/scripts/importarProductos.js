#!/usr/bin/env node
'use strict';
/*
  ═══════════════════════════════════════════════════════════════
  360MAX COMERCIOS — Carga masiva de productos A PRUEBA DE FALLOS
  ═══════════════════════════════════════════════════════════════
  Uso:
    node src/scripts/importarProductos.js productos.csv
    node src/scripts/importarProductos.js productos.xlsx --actualizar-stock
    npm run importar -- productos.csv

  Columnas esperadas (la primera fila son los títulos):
    nombre (obligatoria) | precio (obligatoria) | costo | stock | stock_minimo
    categoria | subcategoria | unidad | codigo_interno | codigo_barra | activo

  Reglas:
    • Fila sin nombre            → se SALTA con advertencia.
    • Precio vacío / no numérico → se SALTA con advertencia.
    • codigo_barra duplicado     → se SALTA con advertencia.
    • El resto de las filas sigue procesándose normalmente.
*/
const path = require('path');
const fs = require('fs');

function imprimir(texto, color) {
  const colores = { rojo: '\x1b[31m', amarillo: '\x1b[33m', verde: '\x1b[32m', cyan: '\x1b[36m', reset: '\x1b[0m' };
  const c = colores[color] || '';
  console.log(c + texto + colores.reset);
}

function usar() {
  console.log(`
360MAX — Importador de productos
  Uso:  node src/scripts/importarProductos.js <archivo.csv|.xlsx> [opciones]

Opciones:
  --actualizar-stock   Actualiza también el stock de productos existentes
  --separador=X        Separador de columnas del CSV (por defecto se detecta solo)
  --no-crear-categorias  No crear categorías nuevas automáticamente
  --ayuda              Muestra esta ayuda
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--ayuda') || args.includes('-h')) { usar(); process.exit(0); }

  const ruta = path.resolve(args.find((a) => !a.startsWith('--')) || '');
  const flagSep = args.find((a) => a.startsWith('--separador='));
  const opciones = {
    actualizarStock: args.includes('--actualizar-stock'),
    crearCategorias: !args.includes('--no-crear-categorias'),
    separador: flagSep ? flagSep.split('=').slice(1).join('=') : undefined
  };

  if (!fs.existsSync(ruta)) {
    imprimir(`✗ No existe el archivo: ${ruta}`, 'rojo');
    process.exit(1);
  }

  imprimir('─'.repeat(60), 'cyan');
  imprimir('  360MAX · Importación masiva de productos', 'cyan');
  imprimir('─'.repeat(60), 'cyan');
  imprimir(`  Archivo: ${ruta}`);

  let resultado;
  try {
    const { leerArchivo } = require('../lib/csv');
    resultado = await leerArchivo(ruta, opciones);
  } catch (e) {
    imprimir('', '');
    imprimir('✗ ERROR FATAL: ' + e.message, 'rojo');
    imprimir('  No se importó ningún producto (la base queda intacta).', 'rojo');
    process.exit(1);
  }

  /* Advertencia por advertencia, claras y visibles. */
  if (resultado.advertencias.length) {
    imprimir('', '');
    imprimir(`⚠  ${resultado.advertencias.length} advertencia(s):`, 'amarillo');
    resultado.advertencias.forEach((a) => imprimir('   · ' + a, 'amarillo'));
  }

  imprimir('', '');
  const resumen = [
    `Insertados (nuevos): ${resultado.insertados}`,
    `Actualizados:         ${resultado.actualizados}`,
    `Omitidos con error:   ${resultado.omitidos}`
  ].join('\n');
  imprimir(resumen, resultado.omitidos ? 'amarillo' : 'verde');

  if (resultado.insertados + resultado.actualizados === 0) {
    imprimir('✗ No se cargó ningún producto. Revisá las advertencias de arriba.', 'rojo');
    process.exit(2);
  }
  imprimir('✓ Importación finalizada sin interrumpir el proceso.', 'verde');
  process.exit(0);
}

main().catch((e) => { imprimir('✗ ERROR FATAL: ' + e.message, 'rojo'); process.exit(1); });
