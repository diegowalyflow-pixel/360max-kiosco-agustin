'use strict';
/* Prueba de humo del flujo completo, SIN navegador y SIN PowerShell.
   Levanta la app con una base TEMPORAL sembrada con la demo, entra como
   administrador (Agustín), hace una venta real, comprueba el descuento atómico
   de stock, el rechazo por stock insuficiente, el arqueo en CENTAVOS enteros,
   el espejo remoto y el cierre cuadrado al centavo.
   Uso: node herramientas/prueba-flujo.js
*/
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), '360max-prueba-' + process.pid + '.db');
process.env.DB_PATH = DB;
process.env.SEMBRAR_DEMO = '1';
process.env.CLAVE_DEMO = 'demo360max!';

const { lista, CLAVE_DEMO } = require('../src/db');
const { crearApp } = require('../src/server');

let fallos = 0;
function ok(cond, txt) {
  console.log('  ' + (cond ? '[ok  ] ' : '[FALLA] ') + txt);
  if (!cond) fallos++;
}

(async () => {
  await lista;                                     /* base lista (esquema + demo) */
  const app = crearApp();
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';

  async function req(metodo, ruta, cuerpo) {
    const op = { method: metodo, headers: {} };
    if (cookie) op.headers.Cookie = cookie;
    if (cuerpo !== undefined) {
      op.headers['Content-Type'] = 'application/json';
      op.body = JSON.stringify(cuerpo);
    }
    const r = await fetch(base + ruta, op);
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let datos = null;
    try { datos = await r.json(); } catch (e) { /* sin cuerpo */ }
    return { status: r.status, datos };
  }

  try {
    console.log('Prueba de flujo 360MAX Comercios\n');

    const est = await req('GET', '/api/auth/estado');
    ok(est.datos && est.datos.primer_uso === false, 'la demo sembró al administrador (primer_uso=false)');

    const login = await req('POST', '/api/auth/continuar', { usuario: 'administrador', clave: CLAVE_DEMO });
    ok(login.status === 200 && login.datos.usuario && login.datos.usuario.rol === 'administrador',
      'ingreso de administrador: ' + (login.datos.usuario && login.datos.usuario.nombre));

    const estado = await req('GET', '/api/caja/estado');
    ok(!!estado.datos.turno, 'turno de demo abierto: ' + (estado.datos.turno && estado.datos.turno.caja));
    ok(estado.datos.turno && estado.datos.turno.abierto_por_mismo === true, 'bandera «abierto_por_mismo» presente');

    const prods = (await req('GET', '/api/productos')).datos || [];
    const p = prods.find((x) => x.stock >= 2 && x.codigo_barra);
    ok(!!p, 'producto con stock y código de barras: ' + (p && p.nombre));

    const porCodigo = await req('GET', '/api/productos/codigo/' + encodeURIComponent(p.codigo_barra));
    ok(porCodigo.status === 200 && porCodigo.datos.id === p.id, 'lectura por código de barras (escáner Nictom LCB8200W)');

    const stockAntes = p.stock;
    const venta = await req('POST', '/api/ventas', {
      items: [{ producto_id: p.id, cantidad: 2 }],
      pagos: [{ medio: 'efectivo', monto: 2 * p.precio }]
    });
    ok(venta.status === 201 && venta.datos.numero > 0, 'venta registrada #' + (venta.datos && venta.datos.numero));
    ok(venta.datos.items && venta.datos.items.length === 1, 'el ticket trae sus ítems');

    const p2 = ((await req('GET', '/api/productos')).datos || []).find((x) => x.id === p.id);
    ok(p2.stock === stockAntes - 2, 'stock descontado atómicamente: ' + stockAntes + ' → ' + p2.stock);

    const dup = await req('POST', '/api/ventas', {
      items: [{ producto_id: p.id, cantidad: 100000 }],
      pagos: [{ medio: 'efectivo', monto: 1 }]
    });
    ok(dup.status === 409 && /stock/i.test(dup.datos.error || ''), 'venta sin stock rechazada (409): ' + (dup.datos && dup.datos.error));

    /* ---- Precio HÍBRIDO: margen del rubro vs precio fijo individual ---- */
    const catId = p2.categoria_id;
    ok(!!catId, 'producto de la demo con categoría para probar el margen del rubro');
    ok(p2.precio_origen === 'margen' && Number.isInteger(p2.costo_centavos) &&
      Math.abs(p2.precio - Math.round(p2.costo_centavos * 1.4) / 100) < 0.001,
      'precio al vuelo por margen 40%: ' + p2.precio + ' (costo ' + (p2.costo_centavos / 100) + ')');

    const margen = await req('PUT', '/api/categorias/' + catId + '/margen', { margen_ganancia_defecto: 60 });
    ok(margen.status === 200, 'margen del rubro actualizado a 60%');
    const p3 = ((await req('GET', '/api/productos')).datos || []).find((x) => x.id === p.id);
    ok(Math.abs(p3.precio - Math.round(p3.costo_centavos * 1.6) / 100) < 0.001,
      'el precio del producto siguió al nuevo margen: ' + p3.precio);

    const fijo = await req('PUT', '/api/admin/productos/' + p.id + '/precio', { costo: p3.costo, precio_fijo: 2000 });
    ok(fijo.status === 200 && fijo.datos.precio === 2000 && fijo.datos.precio_origen === 'fijo',
      'precio fijo individual cobrado exacto: ' + (fijo.datos && fijo.datos.precio));

    const alias = await req('GET', '/api/productos/' + encodeURIComponent(p.codigo_barra));
    ok(alias.status === 200 && alias.datos.precio === 2000,
      'alias GET /api/productos/:codigo respeta el precio fijo');

    const quitar = await req('PUT', '/api/admin/productos/' + p.id + '/precio', { costo: p3.costo, precio_fijo: null });
    ok(quitar.status === 200 && quitar.datos.precio_origen === 'margen',
      'al quitar el precio fijo vuelve al margen del rubro: ' + (quitar.datos && quitar.datos.precio));

    const bg = await req('GET', '/api/categorias');
    ok(bg.status === 200 && bg.datos.every((c) => Number.isInteger(c.margen_ganancia_defecto)),
      'las categorías exponen su margen de ganancia por rubro');

    const arq = await req('GET', '/api/caja/arqueo');
    ok(Number.isInteger(arq.datos.esperado_centavos), 'arqueo en centavos enteros — esperado_centavos=' + arq.datos.esperado_centavos);
    ok(Number.isInteger(arq.datos.fondo_centavos), 'fondo en centavos enteros — fondo_centavos=' + arq.datos.fondo_centavos);

    const espejo = await req('GET', '/api/admin/espejo');
    ok(espejo.status === 200 && espejo.datos.turno && espejo.datos.hoy && Array.isArray(espejo.datos.stock_bajo),
      'espejo remoto: turno, ventas de hoy y stock bajo');
    ok(espejo.datos.hoy && espejo.datos.hoy.ventas_n >= 1, 'el espejo ve la venta de hoy (' + (espejo.datos.hoy && espejo.datos.hoy.ventas_n) + ')');

    const turnos = await req('GET', '/api/caja/turnos');
    ok(Array.isArray(turnos.datos) && turnos.datos.length >= 1, 'historial de turnos accesible');

    const cierre = await req('POST', '/api/caja/cierre', { contado: arq.datos.esperado, observaciones: '' });
    ok(cierre.status === 200 && cierre.datos.diferencia_centavos === 0,
      'cierre cuadrado al centavo — diferencia=' + (cierre.datos && cierre.datos.diferencia));

    const tras = await req('GET', '/api/caja/estado');
    ok(tras.datos.turno === null, 'el turno quedó cerrado tras el arqueo');
  } catch (e) {
    fallos++;
    console.log('  [FALLA] excepción: ' + e.message);
  } finally {
    server.close();
    for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* noop */ } }
  }

  console.log('\n' + (fallos ? 'PRUEBA CON ' + fallos + ' FALLA(S)' : 'PRUEBA LIMPIA: flujo completo correcto.'));
  process.exit(fallos ? 1 : 0);
})();