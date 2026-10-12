'use strict';
/* Depósito: movimientos de stock (entrada, salida, merma, ajuste) y proveedores. */
const express = require('express');
const { db } = require('../db');
const { exigirSesion, exigirRol } = require('../middleware/auth');
const { atender } = require('../lib/http');

const router = express.Router();
const TIPOS = ['entrada', 'salida', 'merma', 'ajuste', 'venta', 'devolucion', 'anulacion'];

router.get('/api/movimientos', exigirSesion, atender(async (req, res) => {
  const cond = [];
  const valores = [];
  if (req.query.tipo && TIPOS.includes(req.query.tipo)) { cond.push('m.tipo = ?'); valores.push(req.query.tipo); }
  if (req.query.producto_id) { cond.push('m.producto_id = ?'); valores.push(Number(req.query.producto_id)); }
  if (req.query.desde) { cond.push('date(m.fecha) >= date(?)'); valores.push(req.query.desde); }
  if (req.query.hasta) { cond.push('date(m.fecha) <= date(?)'); valores.push(req.query.hasta); }
  const limite = Math.min(Number(req.query.limite) || 300, 1000);
  const sql = `
    SELECT m.*, p.nombre AS producto, u.nombre AS usuario, pr.nombre AS proveedor
      FROM movimientos m
      JOIN productos p ON p.id = m.producto_id
      LEFT JOIN usuarios u ON u.id = m.usuario_id
      LEFT JOIN proveedores pr ON pr.id = m.proveedor_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY m.id DESC LIMIT ${limite}`;
  res.json(await db.prepare(sql).all(valores));
}));

router.post('/api/movimientos', exigirRol('deposito'), atender(async (req, res) => {
  const b = req.body || {};
  const tipo = String(b.tipo || '');
  if (!['entrada', 'salida', 'merma', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido para depósito.' });
  }
  const producto = await db.prepare('SELECT * FROM productos WHERE id = ?').get(Number(b.producto_id));
  if (!producto) return res.status(400).json({ error: 'Producto inexistente.' });

  const r = await db.transaction(async () => {
    let cantidad, stockDespues, motivo = String(b.motivo || '').trim();
    const obs = String(b.observacion || '').trim() || null;

    if (tipo === 'ajuste') {
      const fisico = Number(b.stock_fisico);
      if (!Number.isFinite(fisico) || fisico < 0) throw Object.assign(new Error('Conteo físico inválido.'), { status: 400 });
      if (!motivo) throw Object.assign(new Error('El motivo del ajuste es obligatorio.'), { status: 400 });
      cantidad = Math.round((fisico - producto.stock) * 1000) / 1000;
      stockDespues = fisico;
      await db.prepare("UPDATE productos SET stock = ?, actualizado = datetime('now','localtime') WHERE id = ?")
        .run(stockDespues, producto.id);
    } else {
      const cant = Number(b.cantidad);
      if (!Number.isFinite(cant) || cant <= 0) throw Object.assign(new Error('Cantidad inválida.'), { status: 400 });
      if (tipo === 'entrada') {
        if (!motivo) motivo = 'Ingreso a depósito';
        cantidad = cant;
        stockDespues = Math.round((producto.stock + cant) * 1000) / 1000;
        const costo = Number(b.costo);
        await db.prepare("UPDATE productos SET stock = ?, costo = CASE WHEN ? > 0 THEN ? ELSE costo END, actualizado = datetime('now','localtime') WHERE id = ?")
          .run(stockDespues, Number.isFinite(costo) ? costo : 0, Number.isFinite(costo) ? costo : 0, producto.id);
      } else {
        if (!motivo) throw Object.assign(new Error('El motivo es obligatorio.'), { status: 400 });
        if (producto.stock + 0.0001 < cant) {
          throw Object.assign(new Error(`Stock insuficiente de «${producto.nombre}» (disponible: ${producto.stock}).`), { status: 409 });
        }
        cantidad = cant;
        stockDespues = Math.round((producto.stock - cant) * 1000) / 1000;
        await db.prepare("UPDATE productos SET stock = ?, actualizado = datetime('now','localtime') WHERE id = ?")
          .run(stockDespues, producto.id);
      }
    }

    const proveedorId = b.proveedor_id ? Number(b.proveedor_id) : null;
    await db.prepare(`
      INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, proveedor_id,
                               motivo, observacion, lote, vencimiento)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(producto.id, tipo, cantidad, stockDespues, req.usuario.id,
      tipo === 'entrada' ? proveedorId : null,
      motivo || null, obs,
      b.lote ? String(b.lote).trim() : null,
      b.vencimiento || null);

    return { producto_id: producto.id, tipo, cantidad, stock_despues: stockDespues };
  })();

  res.status(201).json(r);
}));

/* ===== Proveedores ===== */
router.get('/api/proveedores', exigirSesion, atender(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM proveedores ORDER BY nombre COLLATE NOCASE').all());
}));

router.post('/api/proveedores', exigirRol('deposito'), atender(async (req, res) => {
  const nombre = String((req.body || {}).nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ingresá el nombre del proveedor.' });
  try {
    const r = await db.prepare('INSERT INTO proveedores (nombre) VALUES (?)').run(nombre);
    res.status(201).json({ id: r.lastInsertRowid, nombre });
  } catch (e) {
    res.status(409).json({ error: 'El proveedor ya existe.' });
  }
}));

module.exports = router;
