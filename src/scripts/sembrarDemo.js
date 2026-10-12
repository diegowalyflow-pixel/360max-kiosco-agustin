#!/usr/bin/env node
'use strict';
/*
  Repone la demo completa: usuario «administrador», categorías, los 18 productos
  con código de barras y la caja abierta. Es idempotente (no duplica nada), así
  que se puede correr las veces que haga falta.

  El servidor ya lo hace solo al arrancar cuando la base nace vacía (por ejemplo
  cuando Render borra el disco en cada redeploy); este script es el camino
  manual:  node src/scripts/sembrarDemo.js

  Variables útiles:  SEMBRAR_DEMO=0 apaga la siembra automática,
                     CLAVE_DEMO=otraclave cambia la clave del administrador,
                     FONDO_DEMO=5000 cambia el fondo con el que abre la caja.
*/
const { lista, sembrarDemo, CLAVE_DEMO, DB_PATH } = require('../db');

lista.then(async () => {
  const r = await sembrarDemo();
  if (!r.usuario && !r.productos && !r.turno) {
    console.log('• La demo ya estaba cargada; no se duplicó nada.');
  } else {
    console.log('✓ Demo repuesta en', DB_PATH);
  }
  console.log('  Entrá con el usuario «administrador» (clave real: ' + CLAVE_DEMO + ';');
  console.log('  el puente de demo acepta cualquier clave para ese usuario).');
}).catch((e) => {
  console.error('✗ No se pudo sembrar la demo:', e.message);
  process.exit(1);
});
