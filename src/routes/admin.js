'use strict';
/* Administración (solo administrador): usuarios, precios masivos y cuentas corrientes. */
const express = require('express');
const { db } = require('../db');
const { exigirSesion, exigirRol } = require('../middleware/auth');
const { nuevaClave } = require('../lib/claves');
const { atender } = require('../lib/http');
const { resolverPrecio } = require('../lib/precios');

const router = express.Router();
const ROLES = ['caja', 'deposito', 'administrador'];

function error(status, msg) { return Object.assign(new Error(msg), { status }); }

/* ===== Usuarios ===== */
router.get('/api/usuarios', exigirRol(), atender(async (req, res) => {
  res.json(await db.prepare(`
    SELECT id, nombre, usuario, rol, activo
      FROM usuarios ORDER BY nombre COLLATE NOCASE`).all());
}));

router.post('/api/usuarios', exigirRol(), atender(async (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  const usuario = String(b.usuario || '').trim().toLowerCase();
  const rol = String(b.rol || '');
  const clave = String(b.clave || '');
  if (!nombre) throw error(400, 'Ingresá el nombre del usuario.');
  if (!usuario) throw error(400, 'Ingresá el nombre de usuario.');
  if (!ROLES.includes(rol)) throw error(400, 'Rol no válido.');
  if (clave.length < 10) throw error(400, 'La contraseña debe tener al menos 10 caracteres.');

  const { salt, hash } = nuevaClave(clave);
  try {
    const r = await db.prepare(`
      INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt)
      VALUES (?, ?, ?, ?, ?)`).run(nombre, usuario, rol, hash, salt);
    await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('usuario_creado', ?, ?)")
      .run(`Usuario @${usuario} (${rol})`, req.usuario.id);
    res.status(201).json({ id: r.lastInsertRowid, nombre, usuario, rol, activo: 1 });
  } catch (e) {
    res.status(409).json({ error: 'Ese nombre de usuario ya existe.' });
  }
}));

router.put('/api/usuarios/:id', exigirRol(), atender(async (req, res) => {
  const id = Number(req.params.id);
  const activo = (req.body || {}).activo ? 1 : 0;
  if (id === req.usuario.id && !activo) throw error(400, 'No podés desactivar tu propio usuario.');
  const r = await db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo, id);
  if (!r.changes) return res.status(404).json({ error: 'Usuario inexistente.' });
  await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('usuario_estado', ?, ?)")
    .run(`Usuario #${id} ${activo ? 'activado' : 'desactivado'}`, req.usuario.id);
  res.json({ ok: true });
}));

/* ===== Listas de precios masivas ===== */
router.post('/api/precios/masivo', exigirRol(), atender(async (req, res) => {
  const b = req.body || {};
  const porcentaje = Number(b.porcentaje);
  const categoria_id = b.categoria_id ? Number(b.categoria_id) : null;
  const redondeo = [0, 10, 50, 100].includes(Number(b.redondeo)) ? Number(b.redondeo) : 0;
  if (!Number.isFinite(porcentaje) || porcentaje === 0) throw error(400, 'Ingresá un porcentaje distinto de cero.');

  const modificados = await db.transaction(async () => {
    const productos = categoria_id
      ? await db.prepare('SELECT id, precio FROM productos WHERE activo = 1 AND categoria_id = ?').all(categoria_id)
      : await db.prepare('SELECT id, precio FROM productos WHERE activo = 1').all();
    let n = 0;
    for (const p of productos) {
      let nuevo = p.precio * (1 + porcentaje / 100);
      if (redondeo > 0) nuevo = Math.round(nuevo / redondeo) * redondeo;
      else nuevo = Math.round(nuevo * 100) / 100;
      if (!(nuevo > 0) || nuevo === p.precio) continue;
      await db.prepare("UPDATE productos SET precio = ?, actualizado = datetime('now','localtime') WHERE id = ?")
        .run(nuevo, p.id);
      n++;
    }
    await db.prepare('INSERT INTO auditoria (evento, detalle, usuario_id) VALUES (?, ?, ?)')
      .run('precios_masivos', JSON.stringify({ porcentaje, categoria_id, redondeo, modificados: n }), req.usuario.id);
    return n;
  })();

  res.json({ modificados });
}));

/* ===== Clientes y cuentas corrientes ===== */
router.get('/api/clientes', exigirSesion, atender(async (req, res) => {
  const q = String((req.query || {}).q || '').trim();
  const filas = q
    ? await db.prepare(`SELECT id, nombre, telefono, saldo FROM clientes
         WHERE nombre LIKE ? OR IFNULL(telefono, '') LIKE ?
         ORDER BY nombre COLLATE NOCASE`).all(`%${q}%`, `%${q}%`)
    : await db.prepare('SELECT id, nombre, telefono, saldo FROM clientes ORDER BY nombre COLLATE NOCASE').all();
  res.json(filas);
}));

router.get('/api/clientes/:id', exigirSesion, atender(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.prepare('SELECT id, nombre, telefono, saldo FROM clientes WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Cliente inexistente.' });
  c.movimientos = await db.prepare(`
    SELECT fecha, motivo, monto FROM pagos_clientes
     WHERE cliente_id = ? ORDER BY id DESC`).all(id);
  res.json(c);
}));

router.post('/api/clientes', exigirRol('caja'), atender(async (req, res) => {
  const nombre = String((req.body || {}).nombre || '').trim();
  if (!nombre) throw error(400, 'Ingresá el nombre del cliente.');
  const telefono = String((req.body || {}).telefono || '').trim() || null;
  const r = await db.prepare('INSERT INTO clientes (nombre, telefono) VALUES (?, ?)').run(nombre, telefono);
  res.status(201).json({ id: r.lastInsertRowid, nombre, telefono, saldo: 0 });
}));

router.post('/api/clientes/:id/pagos', exigirRol('caja'), atender(async (req, res) => {
  const id = Number(req.params.id);
  const importe = Number((req.body || {}).importe);
  const motivo = String((req.body || {}).motivo || '').trim() || 'Pago de cuenta corriente';
  if (!Number.isFinite(importe) || importe <= 0) throw error(400, 'Importe inválido.');

  const cliente = await db.prepare('SELECT id, nombre FROM clientes WHERE id = ?').get(id);
  if (!cliente) return res.status(404).json({ error: 'Cliente inexistente.' });

  await db.transaction(async () => {
    await db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id = ?').run(importe, id);
    await db.prepare('INSERT INTO pagos_clientes (cliente_id, monto, motivo, usuario_id) VALUES (?, ?, ?, ?)')
      .run(id, -importe, motivo, req.usuario.id);
    /* Si hay caja abierta, el efectivo recibido entra al arqueo del turno. */
    const turno = await db.prepare("SELECT id FROM turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get();
    if (turno) {
      await db.prepare('INSERT INTO movimientos_caja (turno_id, tipo, importe, motivo, usuario_id) VALUES (?, ?, ?, ?, ?)')
        .run(turno.id, 'ingreso', importe, `Pago de ${cliente.nombre}: ${motivo}`, req.usuario.id);
    }
    await db.prepare('INSERT INTO auditoria (evento, detalle, usuario_id) VALUES (?, ?, ?)')
      .run('pago_cliente', JSON.stringify({ cliente_id: id, importe, motivo }), req.usuario.id);
  })();

  res.json({ ok: true, mensaje: 'Pago registrado.' });
}));

/* ===== Espejo del local (control remoto del administrador) =====
   Agustín (socio remoto) ve EN VIVO la terminal del local sobre la misma base
   centralizada: turno abierto con su arqueo corriente, ventas del día, últimas
   ventas, movimientos de stock y los productos por debajo del mínimo. Todo se
   calcula al momento; el frontend lo refresca cada minuto sin recargar. */
router.get('/api/admin/espejo', exigirRol('administrador'), atender(async (req, res) => {
  const turno = await db.prepare(`
    SELECT t.id, t.fondo, t.fondo_centavos, t.fecha_apertura,
           c.nombre AS caja, u.nombre AS usuario
      FROM turnos t
      JOIN cajas c ON c.id = t.caja_id
      JOIN usuarios u ON u.id = t.usuario_id
     WHERE t.estado = 'abierta' ORDER BY t.id DESC LIMIT 1`).get();
  if (turno) {
    const tv = await db.prepare(`
      SELECT COUNT(*) n, IFNULL(SUM(total), 0) t FROM ventas
       WHERE turno_id = ? AND estado = 'completada'`).get(turno.id);
    turno.ventas_n = tv.n;
    turno.ventas_total = tv.t;
    turno.pagos = await db.prepare(`
      SELECT pg.medio, IFNULL(SUM(pg.monto), 0) monto
        FROM venta_pagos pg JOIN ventas v ON v.id = pg.venta_id
       WHERE v.turno_id = ? AND v.estado = 'completada'
       GROUP BY pg.medio ORDER BY pg.medio`).all(turno.id);
    turno.movimientos = await db.prepare(`
      SELECT tipo, importe, motivo, fecha FROM movimientos_caja
       WHERE turno_id = ? ORDER BY id DESC LIMIT 20`).all(turno.id);
  }

  const hoy = await db.prepare(`
    SELECT COUNT(*) n, IFNULL(SUM(total), 0) total FROM ventas
     WHERE estado = 'completada' AND date(fecha) = date('now','localtime')`).get();

  const ventasRecientes = await db.prepare(`
    SELECT v.numero, v.total, v.estado, v.fecha, u.nombre AS cajero
      FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
     ORDER BY v.id DESC LIMIT 10`).all();

  const stockBajo = await db.prepare(`
    SELECT p.id, p.nombre, p.stock, p.stock_minimo, p.unidad,
           IFNULL(c.nombre, 'Sin categoría') AS categoria
      FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.activo = 1 AND p.stock <= p.stock_minimo
     ORDER BY (p.stock - p.stock_minimo) ASC, p.nombre COLLATE NOCASE
     LIMIT 50`).all();

  const movimientos = await db.prepare(`
    SELECT m.fecha, m.tipo, m.cantidad, m.stock_despues, m.referencia, m.motivo,
           p.nombre AS producto, u.nombre AS usuario
      FROM movimientos m
      JOIN productos p ON p.id = m.producto_id
      LEFT JOIN usuarios u ON u.id = m.usuario_id
     ORDER BY m.id DESC LIMIT 15`).all();

  res.json({
    generado: new Date().toISOString(),
    turno: turno || null,
    hoy: { ventas_n: hoy.n, ventas_total: hoy.total },
    ventas_recientes: ventasRecientes,
    stock_bajo: stockBajo,
    movimientos
  });
}));

/* ===== Precio individual de un producto (panel de Agustín) =====
   Modifica el COSTO y permite «clavar» un PRECIO FINAL manual al SKU:
     • costo (pesos) → se guarda también en centavos enteros;
     • precio_fijo vacío / null / 0 → borra la excepción y vuelve al margen del rubro;
     • precio_fijo numérico        → excepción individual: la caja cobra ese monto exacto.
   Se recalcula «precio» base (la góndola) para que las herramientas heredadas
   (CSV, listas masivas) sigan leyendo un número coherente. */
router.put('/api/admin/productos/:id/precio', exigirRol(), atender(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const actual = await db.prepare(`
    SELECT p.*, IFNULL(c.margen_ganancia_defecto, 40) AS margen_ganancia_defecto
      FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.id = ?`).get(id);
  if (!actual) throw error(404, 'Producto inexistente.');

  /* COSTO: si no viene, se conserva el actual. */
  const costo = b.costo === undefined || b.costo === null || b.costo === ''
    ? (Number(actual.costo) || 0) : Number(b.costo);
  if (!Number.isFinite(costo) || costo < 0) throw error(400, 'Costo inválido.');

  /* PRECIO FIJO: vacío/null/0 limpia la excepción (vuelve al margen del rubro). */
  const bruto = b.precio_fijo;
  const limpio = bruto === null || bruto === undefined || bruto === '' || Number(bruto) === 0;
  const fijo = limpio ? null : Number(bruto);
  if (!limpio && (!Number.isFinite(fijo) || fijo < 0)) throw error(400, 'Precio fijo inválido.');

  const margen = Number(actual.margen_ganancia_defecto) || 0;
  const efectivo = fijo !== null ? fijo : costo * (1 + margen / 100);

  await db.prepare(`
    UPDATE productos SET costo = ?, costo_centavos = ?, precio_fijo_centavos = ?,
                         precio = ?, actualizado = datetime('now','localtime')
     WHERE id = ?`)
    .run(costo, Math.round(costo * 100), fijo !== null ? Math.round(fijo * 100) : null,
      Math.round(efectivo * 100) / 100, id);
  await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('precio_producto', ?, ?)")
    .run('Producto #' + id + ' — costo $' + costo.toFixed(2) +
      (fijo !== null ? ' · precio fijo $' + fijo.toFixed(2) : ' · por margen ' + margen + '%'),
      req.usuario.id);

  const fila = await db.prepare(`
    SELECT p.*, c.nombre AS categoria, IFNULL(c.margen_ganancia_defecto, 40) AS margen_ganancia_defecto
      FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.id = ?`).get(id);
  const r = resolverPrecio(fila);
  res.json(Object.assign({}, fila, {
    precio_base: Number(fila.precio) || 0, precio: r.pesos, precio_origen: r.origen
  }));
}));

module.exports = router;

