'use strict';
/* Prueba de MIGRACIÓN de esquema viejo — la base real de Render.
   La base de producción se creó con la versión inicial de movimientos_caja
   (columna «monto», sin «usuario_id»). Como CREATE TABLE IF NOT EXISTS nunca
   toca una tabla existente, el cierre de caja reventaba con:
       SQLITE_ERROR: no such column: importe
   y no se registraba NI el cierre NI los movimientos de efectivo.

   Este ensayo recrea esa base vieja al pie de la letra, arranca la app encima
   y comprueba que la migración alinea las columnas, que /api/caja/arqueo y
   /api/admin/espejo dejan de dar 500 y que el CIERRE DE CAJA se ejecuta.
   Uso: node herramientas/prueba-migracion.js */
const os = require('os');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const DB = path.join(os.tmpdir(), '360max-migracion-' + process.pid + '.db');
process.env.DB_PATH = DB;
process.env.ADMIN_USUARIO = 'administrador';
process.env.ADMIN_CLAVE = 'demo360max!';
process.env.ADMIN_NOMBRE = 'Agustín prueba';

let fallos = 0;
function ok(cond, txt) {
  console.log('  ' + (cond ? '[ok  ] ' : '[FALLA] ') + txt);
  if (!cond) fallos++;
}

function crearBaseVieja() {
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(DB, (err) => {
      if (err) return reject(err);
      d.run(`CREATE TABLE turnos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caja_id INTEGER NOT NULL,
        usuario_id INTEGER NOT NULL,
        fondo REAL NOT NULL DEFAULT 0,
        fondo_centavos INTEGER NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'cerrada' CHECK (estado IN ('abierta','cerrada')),
        fecha_apertura TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        fecha_cierre TEXT,
        contado REAL,
        diferencia REAL,
        observaciones TEXT,
        cierre_usuario_id INTEGER
      );`, (e1) => {
        if (e1) return reject(e1);
        /* ESQUEMA INICIAL EXACTO: «monto», sin «usuario_id». */
        d.run(`CREATE TABLE movimientos_caja (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
          tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
          monto REAL NOT NULL,
          motivo TEXT,
          fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );`, (e2) => {
          if (e2) return reject(e2);
          d.run("INSERT INTO turnos (caja_id, usuario_id, fondo, fondo_centavos, estado) VALUES (1, 1, 0, 0, 'cerrada')", (e3) => {
            if (e3) return reject(e3);
            d.run("INSERT INTO movimientos_caja (turno_id, tipo, monto, motivo) VALUES (1, 'ingreso', 77.5, 'movimiento de la base vieja')",
              (e4) => (e4 ? reject(e4) : d.close((e5) => (e5 ? reject(e5) : resolve()))));
          });
        });
      });
    });
  });
}

(async () => {
  console.log('Prueba de migración de esquema viejo (base de Render)\n');
  await crearBaseVieja();

  const { lista, prepare } = require('../src/db');
  await lista;                                    /* abre la base y migra */

  /* 1) Columnas alineadas + fila vieja conservada */
  const cols = (await prepare('PRAGMA table_info(movimientos_caja)').all()).map((c) => c.name);
  ok(cols.includes('importe'), 'la columna monto pasó a llamarse importe');
  ok(!cols.includes('monto'), 'no queda rastro de la columna monto');
  ok(cols.includes('usuario_id'), 'se agregó la columna usuario_id');
  const viejo = await prepare("SELECT * FROM movimientos_caja WHERE motivo = 'movimiento de la base vieja'").get();
  ok(viejo && Number(viejo.importe) === 77.5, 'el dato viejo se conservó con su importe (' + (viejo && viejo.importe) + ')');

  /* 2) La app real sobre esa base: login → apertura → arqueo → movimiento → cierre */
  const { crearApp } = require('../src/server');
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
    const login = await req('POST', '/api/auth/continuar', { usuario: 'administrador', clave: process.env.ADMIN_CLAVE });
    ok(login.status === 200, 'ingreso del administrador');

    const ap = await req('POST', '/api/caja/apertura', { caja_id: 1, fondo_centavos: 100000 });
    ok(ap.status === 201, 'apertura de caja sobre la base vieja migrada');

    const arq = await req('GET', '/api/caja/arqueo');
    ok(arq.status === 200, 'GET /api/caja/arqueo responde 200 (antes: 500 no such column: importe)');

    const esp = await req('GET', '/api/admin/espejo');
    ok(esp.status === 200, 'GET /api/admin/espejo responde 200 (también usaba importe)');

    const mov = await req('POST', '/api/caja/movimiento', { tipo: 'ingreso', importe: 50, motivo: 'ingreso nuevo' });
    ok(mov.status === 201, 'movimiento nuevo registrado con importe + usuario_id');

    const arq2 = await req('GET', '/api/caja/arqueo');
    ok(arq2.status === 200 && arq2.datos.esperado_centavos === 105000,
      'esperado = fondo 100000 + ingreso 5000 → ' + (arq2.datos && arq2.datos.esperado_centavos));

    const cierre = await req('POST', '/api/caja/cierre', { contado: arq2.datos.esperado, observaciones: '' });
    ok(cierre.status === 200 && cierre.datos.diferencia_centavos === 0,
      'CIERRE DE CAJA ejecutado y cuadrado — diferencia=' + (cierre.datos && cierre.datos.diferencia));

    const arqs = await req('GET', '/api/arqueos');
    ok(arqs.status === 200 && arqs.datos.length === 1,
      'el cierre quedó REGISTRADO en /api/arqueos (' + (arqs.datos && arqs.datos.length) + ' arqueo)');

    const est = await req('GET', '/api/caja/estado');
    ok(est.status === 200 && est.datos.turno === null, 'el turno quedó cerrado');
  } catch (e) {
    fallos++;
    console.log('  [FALLA] excepción: ' + e.message);
  } finally {
    server.close();
    for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* noop */ } }
  }

  console.log('\n' + (fallos ? 'PRUEBA CON ' + fallos + ' FALLA(S)' : 'PRUEBA LIMPIA: la base vieja migra y el cierre funciona.'));
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
