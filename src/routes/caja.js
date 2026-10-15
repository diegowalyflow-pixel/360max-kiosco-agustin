'use strict';
/* Caja: apertura, resumen, arqueo/cierre, movimientos de efectivo y clientes.
   Control de turnos bilateral: el administrador (Agustín) abre el turno con el
   fondo inicial y el cajero que opera queda asociado a cada venta por
   usuario_id, de modo que el arqueo y la auditoría sean exactos. */
const express = require('express');
const { db } = require('../db');
const { exigirSesion, exigirRol } = require('../middleware/auth');
const { atender } = require('../lib/http');

const router = express.Router();

function error(status, msg) { return Object.assign(new Error(msg), { status }); }
async function turnoAbierto() {
  return db.prepare("SELECT * FROM turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get();
}
function dinero(n) { return '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 }); }

/* El fondo se recibe en CENTAVOS (entero) para que el arqueo cuadre exacto.
   Si el cliente manda el campo legacy «fondo» en pesos, se convierte. */
function centavosDeFondo(cuerpo) {
  const crudo = cuerpo.fondo_centavos !== undefined && cuerpo.fondo_centavos !== null
    ? cuerpo.fondo_centavos
    : (cuerpo.fondo !== undefined && cuerpo.fondo !== null ? Math.round(Number(cuerpo.fondo) * 100) : NaN);
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < 0) throw error(400, 'Fondo inicial inválido.');
  return Math.round(n);
}

/* ===== Cajas ===== */
router.get('/api/cajas', exigirSesion, atender(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM cajas ORDER BY id').all());
}));

router.get('/api/caja/estado', exigirSesion, atender(async (req, res) => {
  const abierto = await turnoAbierto();
  /* LEFT JOIN + fallbacks: un turno huérfano (caja/usuario borrado) no puede
     romper con 500 la pantalla de Caja y dejarla vacía. */
  const cierre = await db.prepare(`
    SELECT t.*, c.nombre AS caja, u.nombre AS usuario
      FROM turnos t LEFT JOIN cajas c ON c.id = t.caja_id LEFT JOIN usuarios u ON u.id = t.usuario_id
     WHERE t.estado = 'cerrada' ORDER BY t.id DESC LIMIT 1`).get();
  let turno = null;
  if (abierto) {
    const tv = await db.prepare(`
      SELECT IFNULL(SUM(total), 0) t, COUNT(*) n FROM ventas
       WHERE turno_id = ? AND estado = 'completada'`).get(abierto.id);
    const cajaFila = await db.prepare('SELECT nombre FROM cajas WHERE id = ?').get(abierto.caja_id);
    const usuFila = await db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(abierto.usuario_id);
    turno = Object.assign({}, abierto, {
      caja: (cajaFila && cajaFila.nombre) || ('Caja #' + abierto.caja_id),
      usuario: (usuFila && usuFila.nombre) || ('Usuario #' + abierto.usuario_id),
      /* El cajero que opera ahora puede no ser quien abrió el turno: la UI
         necesita saberlo para avisar que está cobrando sobre el turno ajeno. */
      abierto_por_mismo: abierto.usuario_id === req.usuario.id,
      ventas_total: tv.t, ventas_n: tv.n
    });
  }
  res.json({ turno, cierre_anterior: cierre || null });
}));

/* Historial de turnos: el administrador (socio remoto) audita aperturas y
   cierres desde Buenos Aires con la misma base centralizada. */
router.get('/api/caja/turnos', exigirSesion, atender(async (req, res) => {
  const res2 = await db.prepare(`
    SELECT t.id, t.fondo, t.fondo_centavos, t.estado, t.fecha_apertura, t.fecha_cierre,
           t.contado, t.diferencia, t.observaciones,
           c.nombre AS caja, u.nombre AS usuario, uc.nombre AS cierre_usuario,
           (SELECT COUNT(*) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'completada') AS ventas_n,
           (SELECT IFNULL(SUM(v.total), 0) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'completada') AS ventas_total
      FROM turnos t
      JOIN cajas c ON c.id = t.caja_id
      JOIN usuarios u ON u.id = t.usuario_id
      LEFT JOIN usuarios uc ON uc.id = t.cierre_usuario_id
     ORDER BY t.id DESC LIMIT 100`).all();
  res.json(res2);
}));

router.post('/api/caja/apertura', exigirRol('caja'), atender(async (req, res) => {
  const { caja_id } = req.body || {};
  const centavos = centavosDeFondo(req.body || {});
  /* Apertura transaccional: valida que no haya otro turno abierto y escribe
     el turno con el fondo en centavos. El índice único de la base es la red
     de seguridad si dos cajeros apretaban ABRIR CAJA en el mismo instante. */
  const r = await db.transaction(async () => {
    if (await turnoAbierto()) throw error(409, 'Ya hay una caja abierta. Cerrala antes de abrir otra.');
    const caja = await db.prepare('SELECT * FROM cajas WHERE id = ?').get(Number(caja_id));
    if (!caja) throw error(400, 'Caja inexistente.');
    const ins = await db.prepare(
      'INSERT INTO turnos (caja_id, usuario_id, fondo, fondo_centavos, estado) VALUES (?, ?, ?, ?, \'abierta\')')
      .run(caja.id, req.usuario.id, centavos / 100, centavos);
    await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('apertura_caja', ?, ?)")
      .run(`Apertura de ${caja.nombre} con fondo ${dinero(centavos / 100)} (${centavos} centavos)`, req.usuario.id);
    return { id: ins.lastInsertRowid, caja: caja.nombre, fondo: centavos / 100, fondo_centavos: centavos };
  })();
  res.status(201).json(r);
}));

/* ===== Resumen y arqueo =====
   Todo el cálculo del arqueo se hace en CENTAVOS (enteros). Sumar y restar
   importes en REAL acumula errores de coma flotante y el cierre «cuadra» con
   un centavo de diferencia que después nadie sabe explicar. */
async function calcularEsperado(turnoId, turno) {
  const pagos = await db.prepare(`
    SELECT pg.medio, IFNULL(SUM(pg.monto), 0) monto
      FROM venta_pagos pg JOIN ventas v ON v.id = pg.venta_id
     WHERE v.turno_id = ? AND v.estado = 'completada'
     GROUP BY pg.medio`).all(turnoId);
  const movs = (await db.prepare(`
    SELECT IFNULL(SUM(CASE WHEN tipo = 'ingreso' THEN importe ELSE -importe END), 0) d
      FROM movimientos_caja WHERE turno_id = ?`).get(turnoId)).d;
  const efectivo = (pagos.find((p) => p.medio === 'efectivo') || { monto: 0 }).monto;
  const fondoCentavos = Number.isFinite(turno.fondo_centavos) && turno.fondo_centavos > 0
    ? Number(turno.fondo_centavos)
    : Math.round(Number(turno.fondo || 0) * 100);
  const esperadoCentavos = fondoCentavos +
    Math.round(Number(efectivo || 0) * 100) + Math.round(Number(movs || 0) * 100);
  return {
    pagos,
    efectivo,
    movs,
    fondo_centavos: fondoCentavos,
    esperado_centavos: esperadoCentavos,
    esperado: esperadoCentavos / 100
  };
}

router.get('/api/caja/arqueo', exigirSesion, atender(async (req, res) => {
  const turno = await turnoAbierto();
  if (!turno) return res.json({ turno: null });
  const ventas = await db.prepare(`
    SELECT COUNT(*) n, IFNULL(SUM(total), 0) t FROM ventas
     WHERE turno_id = ? AND estado = 'completada'`).get(turno.id);
  const calc = await calcularEsperado(turno.id, turno);
  const movs = await db.prepare(`
    SELECT m.*, u.nombre AS usuario FROM movimientos_caja m
      LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE m.turno_id = ? ORDER BY m.id DESC`).all(turno.id);
  res.json({
    turno: Object.assign({}, turno, {
      caja: (await db.prepare('SELECT nombre FROM cajas WHERE id = ?').get(turno.caja_id)).nombre,
      usuario: (await db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(turno.usuario_id)).nombre
    }),
    ventas_n: ventas.n, ventas_total: ventas.t,
    pagos: calc.pagos, movimientos: movs,
    esperado: calc.esperado, esperado_centavos: calc.esperado_centavos,
    fondo_centavos: calc.fondo_centavos
  });
}));

router.post('/api/caja/movimiento', exigirRol('caja'), atender(async (req, res) => {
  const { tipo, importe, motivo } = req.body || {};
  if (!['ingreso', 'egreso'].includes(String(tipo))) throw error(400, 'Tipo de movimiento inválido.');
  const importeN = Number(importe);
  if (!Number.isFinite(importeN) || importeN <= 0) throw error(400, 'Importe inválido.');
  const m = String(motivo || '').trim();
  if (!m) throw error(400, 'El motivo es obligatorio.');
  const turno = await turnoAbierto();
  if (!turno) throw error(409, 'No hay caja abierta.');
  await db.prepare('INSERT INTO movimientos_caja (turno_id, tipo, importe, motivo, usuario_id) VALUES (?, ?, ?, ?, ?)')
    .run(turno.id, tipo, importeN, m, req.usuario.id);
  res.status(201).json({ ok: true });
}));

router.post('/api/caja/cierre', exigirRol('caja'), atender(async (req, res) => {
  const { contado, observaciones } = req.body || {};
  const obs = String(observaciones || '').trim();

  /* El cierre se resuelve DENTRO de la transacción: si mientras se contaba el
     efectivo entró una venta, el arqueo se recalcula contra el turno recién
     cerrado en lugar de contra un número viejo. Con BEGIN IMMEDIATE ninguna
     otra escritura se cuela entremedio. */
  const r = await db.transaction(async () => {
    const turno = await turnoAbierto();
    if (!turno) throw error(409, 'No hay caja abierta.');
    const contadoCentavos = Math.round(Number(contado) * 100);
    if (!Number.isFinite(contadoCentavos) || contadoCentavos < 0) throw error(400, 'Efectivo contado inválido.');
    const contadoN = contadoCentavos / 100;

    const calc = await calcularEsperado(turno.id, turno);
    const diferenciaCentavos = contadoCentavos - calc.esperado_centavos;
    const diferencia = diferenciaCentavos / 100;
    if (diferenciaCentavos !== 0 && !obs) throw error(400, 'Con diferencia hay que explicar las observaciones.');

    const cerrado = await db.prepare(`UPDATE turnos SET estado = 'cerrada', fecha_cierre = datetime('now','localtime'),
                contado = ?, diferencia = ?, observaciones = ?, cierre_usuario_id = ?
                WHERE id = ? AND estado = 'abierta'`)
      .run(contadoN, diferencia, obs || null, req.usuario.id, turno.id);
    if (!cerrado.changes) throw error(409, 'El turno se cerró en otra terminal. Actualice la pantalla.');

    const arqueoId = (await db.prepare(`INSERT INTO arqueos (turno_id, esperado, contado, diferencia, observaciones)
                                 VALUES (?, ?, ?, ?, ?)`)
      .run(turno.id, calc.esperado, contadoN, diferencia, obs || null)).lastInsertRowid;
    await db.prepare('INSERT INTO auditoria (evento, detalle, usuario_id) VALUES (?, ?, ?)')
      .run('cierre_caja', `Cierre: esperado ${dinero(calc.esperado)}, contado ${dinero(contadoN)}, dif. ${dinero(diferencia)}`, req.usuario.id);
    return {
      arqueo_id: arqueoId,
      esperado: calc.esperado, esperado_centavos: calc.esperado_centavos,
      contado: contadoN, contado_centavos: contadoCentavos,
      diferencia, diferencia_centavos: diferenciaCentavos
    };
  })();

  res.json(Object.assign({ ok: true }, r));
}));

/* ===== Arqueos históricos (administración) ===== */
router.get('/api/arqueos', exigirSesion, atender(async (req, res) => {
  const { desde, hasta } = req.query;
  const cond = [];
  const valores = [];
  if (desde) { cond.push('date(a.fecha) >= date(?)'); valores.push(desde); }
  if (hasta) { cond.push('date(a.fecha) <= date(?)'); valores.push(hasta); }
  const filas = await db.prepare(`
    SELECT a.*, t.fecha_apertura, t.fecha_cierre, c.nombre AS caja, u.nombre AS usuario,
           uc.nombre AS cierre_usuario
      FROM arqueos a
      JOIN turnos t ON t.id = a.turno_id
      JOIN cajas c ON c.id = t.caja_id
      JOIN usuarios u ON u.id = t.usuario_id
      LEFT JOIN usuarios uc ON uc.id = t.cierre_usuario_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY a.id DESC LIMIT 200`).all(valores);
  res.json(filas);
}));

/* ===== Detalle de un arqueo (reporte de cierre para imprimir) ===== */
router.get('/api/arqueos/:id', exigirRol('administrador'), atender(async (req, res) => {
  const a = await db.prepare(`
    SELECT a.id, a.turno_id, a.esperado, a.contado, a.diferencia, a.observaciones, a.fecha,
           t.fecha_apertura, t.fecha_cierre, t.fondo, t.fondo_centavos,
           c.nombre AS caja, u.nombre AS usuario, uc.nombre AS cierre_usuario
      FROM arqueos a
      JOIN turnos t ON t.id = a.turno_id
      JOIN cajas c ON c.id = t.caja_id
      JOIN usuarios u ON u.id = t.usuario_id
      LEFT JOIN usuarios uc ON uc.id = t.cierre_usuario_id
     WHERE a.id = ?`).get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Arqueo inexistente.' });

  a.ventas = await db.prepare(`
    SELECT COUNT(*) n, IFNULL(SUM(total), 0) t
      FROM ventas WHERE turno_id = ? AND estado = 'completada'`).get(a.turno_id);
  a.pagos = await db.prepare(`
    SELECT pg.medio, IFNULL(SUM(pg.monto), 0) monto
      FROM venta_pagos pg JOIN ventas v ON v.id = pg.venta_id
     WHERE v.turno_id = ? AND v.estado = 'completada'
     GROUP BY pg.medio ORDER BY pg.medio`).all(a.turno_id);
  a.movimientos = await db.prepare(`
    SELECT tipo, importe, motivo, fecha FROM movimientos_caja
     WHERE turno_id = ? ORDER BY id`).all(a.turno_id);
  delete a.turno_id;
  res.json(a);
}));

module.exports = router;

