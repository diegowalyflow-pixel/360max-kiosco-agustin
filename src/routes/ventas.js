'use strict';
/*
  Ventas: cobro completo en una TRANSACCIÓN —
  descuenta stock real en la base, registra pagos y devuelve el dato del ticket.
*/
const express = require('express');
const { db } = require('../db');
const { exigirSesion, exigirRol, esAdmin } = require('../middleware/auth');
const { atender } = require('../lib/http');
const { precioEfectivoPesos } = require('../lib/precios');

const router = express.Router();
const EPS = 0.0001;
const MEDIOS = ['efectivo', 'debito', 'credito', 'transferencia', 'cuenta_corriente'];

function error(status, msg) { return Object.assign(new Error(msg), { status }); }
function moneyFmt(n) { return '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 }); }
/* Cantidades: enteras sin decimales, fraccionarias recortadas (ej. 2 y 1,5). */
function cantFmt(n) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000).replace('.', ',');
}

async function ventaCompleta(numero) {
  const v = await db.prepare(`
    SELECT v.*, u.nombre AS cajero, cl.nombre AS cliente
      FROM ventas v
      JOIN usuarios u ON u.id = v.usuario_id
      LEFT JOIN clientes cl ON cl.id = v.cliente_id
     WHERE v.numero = ?`).get(numero);
  if (!v) return null;
  v.items = await db.prepare('SELECT * FROM venta_items WHERE venta_id = ?').all(v.id);
  v.pagos = await db.prepare('SELECT medio, monto FROM venta_pagos WHERE venta_id = ?').all(v.id);
  return v;
}

/* ===== COBRAR VENTA ===== */
router.post('/api/ventas', exigirRol('caja'), atender(async (req, res) => {
  const { items, pagos, cliente_id } = req.body || {};
  if (!Array.isArray(items) || !items.length) throw error(400, 'El carrito está vacío.');
  if (!Array.isArray(pagos) || !pagos.length) throw error(400, 'Informá al menos un medio de pago.');

  const venta = await db.transaction(async () => {
    const turno = await db.prepare("SELECT * FROM turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get();
    if (!turno) throw error(409, 'No hay caja abierta. Abrí la caja antes de cobrar.');

    /* Un mismo producto puede venir repetido en el carrito (doble toque, dos
       cajas del mismo código). Se unen ANTES de tocar la base: si no, cada
       línea se validaría contra el stock completo y dos líneas de 3 unidades
       pasarían el control con stock 5. */
    const unificado = new Map();
    for (const it of items) {
      const id = Number(it.producto_id);
      const cant = Number(it.cantidad);
      if (!Number.isFinite(id) || id <= 0) throw error(400, 'Producto inválido en el carrito.');
      if (!Number.isFinite(cant) || cant <= 0) throw error(400, 'Cantidad inválida en el carrito.');
      unificado.set(id, Math.round(((unificado.get(id) || 0) + cant) * 1000) / 1000);
    }

    /* Precios SIEMPRE resueltos en el servidor con el esquema híbrido (precio
       fijo individual o costo × margen del rubro); el navegador no manda
       precios. Se trae el margen de la categoría en la misma consulta. */
    const lineas = [];
    for (const [id, cant] of unificado) {
      const p = await db.prepare(`
        SELECT pr.*, c.nombre AS categoria, IFNULL(c.margen_ganancia_defecto, 40) AS margen_ganancia_defecto
          FROM productos pr
          LEFT JOIN categorias c ON c.id = pr.categoria_id
         WHERE pr.id = ? AND pr.activo = 1`).get(id);
      if (!p) throw error(400, 'Producto inexistente o inactivo en el carrito.');
      if (p.stock + EPS < cant) {
        throw error(409, `Stock insuficiente de «${p.nombre}» (disponible: ${cantFmt(p.stock)}).`);
      }
      const precio = precioEfectivoPesos(p);
      lineas.push({ p, cant, precio, subtotal: Math.round(precio * cant * 100) / 100 });
    }

    const total = Math.round(lineas.reduce((a, l) => a + l.subtotal, 0) * 100) / 100;

    const pagosOk = pagos.map((pg) => {
      const medio = String(pg.medio || '').toLowerCase();
      const monto = Number(pg.monto);
      if (!MEDIOS.includes(medio)) throw error(400, 'Medio de pago no válido: ' + medio);
      if (!Number.isFinite(monto) || monto <= 0) throw error(400, 'Importe de pago inválido.');
      return { medio, monto: Math.round(monto * 100) / 100 };
    });
    const suma = Math.round(pagosOk.reduce((a, p) => a + p.monto, 0) * 100) / 100;
    if (Math.abs(suma - total) > 0.5) {
      throw error(400, `Los pagos (${moneyFmt(suma)}) no coinciden con el total (${moneyFmt(total)}).`);
    }
    const cc = pagosOk.find((p) => p.medio === 'cuenta_corriente');
    let cliente = null;
    if (cc) {
      if (!cliente_id) throw error(400, 'La venta en cuenta corriente necesita un cliente.');
      cliente = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(cliente_id));
      if (!cliente) throw error(400, 'Cliente inexistente.');
    }

    /* Número correlativo: se calcula en el INSERT (SQLite no permite asignar NEW en triggers).
       La venta queda atada al turno, a la caja y al cajero que opera: con eso
       el arqueo y la auditoría no tienen margen de duda. */
    const rV = await db.prepare(`INSERT INTO ventas (numero, turno_id, usuario_id, caja_id, cliente_id, total)
                                 SELECT IFNULL(MAX(numero), 0) + 1, ?, ?, ?, ?, ? FROM ventas`)
      .run(turno.id, req.usuario.id, turno.caja_id,
        cliente ? cliente.id : (cliente_id ? Number(cliente_id) : null), total);
    const ventaId = rV.lastInsertRowid;

    for (const l of lineas) {
      /* Descuento ATÓMICO: la condición de stock viaja en el propio UPDATE.
         Si otra terminal ya consumió esas unidades entre la validación y
         ahora, la fila no se toca, changes viene en 0 y se aborta la venta
         entera: es imposible vender stock que no existe. */
      const desc = await db.prepare(`UPDATE productos
                 SET stock = stock - ?, actualizado = datetime('now','localtime')
               WHERE id = ? AND activo = 1 AND stock >= ?`)
        .run(l.cant, l.p.id, l.cant);
      if (!desc.changes) {
        const actual = await db.prepare('SELECT stock FROM productos WHERE id = ?').get(l.p.id);
        throw error(409,
          `Stock insuficiente de «${l.p.nombre}» (disponible: ${cantFmt(actual ? actual.stock : 0)}). ` +
          'Otra venta se adelantó: recargá el producto.');
      }
      const stockDespues = (await db.prepare('SELECT stock FROM productos WHERE id = ?').get(l.p.id)).stock;
      await db.prepare(`INSERT INTO venta_items (venta_id, producto_id, nombre, cantidad, precio, subtotal)
                                VALUES (?, ?, ?, ?, ?, ?)`).run(ventaId, l.p.id, l.p.nombre, l.cant, l.precio, l.subtotal);
      await db.prepare(`INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, turno_id, referencia)
                               VALUES (?, 'venta', ?, ?, ?, ?, ?)`)
        .run(l.p.id, l.cant, stockDespues, req.usuario.id, turno.id, 'Venta #' + ventaId);
    }

    for (const pg of pagosOk) {
      await db.prepare('INSERT INTO venta_pagos (venta_id, medio, monto) VALUES (?, ?, ?)').run(ventaId, pg.medio, pg.monto);
    }

    if (cc) {
      await db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id = ?').run(total, cliente.id);
      await db.prepare('INSERT INTO pagos_clientes (cliente_id, monto, motivo, usuario_id) VALUES (?, ?, ?, ?)')
        .run(cliente.id, total, 'Compra en cuenta corriente — venta #' + ventaId, req.usuario.id);
    }

    await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('venta', ?, ?)")
      .run(`Venta #${ventaId} por ${moneyFmt(total)}`, req.usuario.id);

    const numero = (await db.prepare('SELECT numero FROM ventas WHERE id = ?').get(ventaId)).numero;
    return ventaCompleta(numero);
  })();

  res.status(201).json(venta);
}));


/* ===== Detalle de venta (para devoluciones y reimprimir ticket) ===== */
router.get('/api/ventas/:numero', exigirSesion, atender(async (req, res) => {
  const v = await ventaCompleta(Number(req.params.numero));
  if (!v) return res.status(404).json({ error: 'Venta inexistente.' });
  res.json(v);
}));

/* Ventas: turno abierto (lista de devoluciones) o historial completo (administrador). */
router.get('/api/ventas', exigirSesion, atender(async (req, res) => {
  const { desde, hasta, historial } = req.query;
  const esHistorial = historial === '1' || historial === 'true' || Boolean(desde) || Boolean(hasta);

  if (esHistorial) {
    if (!esAdmin(req.usuario.rol)) throw error(403, 'El historial de ventas es solo para administradores.');
    const cond = [];
    const valores = [];
    if (desde) { cond.push('date(v.fecha) >= date(?)'); valores.push(desde); }
    if (hasta) { cond.push('date(v.fecha) <= date(?)'); valores.push(hasta); }
    const ventas = await db.prepare(`
      SELECT v.numero, v.total, v.estado, v.fecha, v.motivo_anulacion,
             u.nombre AS cajero, cl.nombre AS cliente,
             (SELECT COUNT(*) FROM venta_items vi WHERE vi.venta_id = v.id) AS items_n,
             (SELECT GROUP_CONCAT(DISTINCT pg.medio) FROM venta_pagos pg WHERE pg.venta_id = v.id) AS pagos
        FROM ventas v
        JOIN usuarios u ON u.id = v.usuario_id
        LEFT JOIN clientes cl ON cl.id = v.cliente_id
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER BY v.id DESC LIMIT 500`).all(valores);
    return res.json(ventas);
  }

  const turno = await db.prepare("SELECT id FROM turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get();
  if (!turno) return res.json([]);
  const ventasTurno = await db.prepare(`
    SELECT v.numero, v.total, v.estado, v.fecha, u.nombre AS cajero, cl.nombre AS cliente
      FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
      LEFT JOIN clientes cl ON cl.id = v.cliente_id
     WHERE v.turno_id = ? ORDER BY v.id DESC`).all(turno.id);
  res.json(ventasTurno);
}));

/* ===== Devolución parcial (reintegra stock de forma real) ===== */
router.post('/api/ventas/:numero/devolver', exigirRol('caja'), atender(async (req, res) => {
  const { items, motivo, reintegrar } = req.body || {};
  const m = String(motivo || '').trim();
  if (!m) throw error(400, 'El motivo de la devolución es obligatorio.');
  if (!Array.isArray(items) || !items.length) throw error(400, 'Elegí qué producto(s) devolver.');

  const r = await db.transaction(async () => {
    const v = await db.prepare('SELECT * FROM ventas WHERE numero = ?').get(Number(req.params.numero));
    if (!v) throw error(404, 'Venta inexistente.');
    if (v.estado !== 'completada') throw error(409, 'La venta no está activa (puede estar anulada).');

    for (const it of items) {
      const linea = await db.prepare('SELECT * FROM venta_items WHERE venta_id = ? AND producto_id = ?')
        .get(v.id, Number(it.producto_id));
      if (!linea) throw error(400, 'Producto que no pertenece a la venta.');
      const cant = Number(it.cantidad);
      if (!Number.isFinite(cant) || cant <= 0) throw error(400, 'Cantidad de devolución inválida.');
      if (cant > linea.cantidad - linea.cantidad_devuelta + EPS) {
        throw error(409, `No se puede devolver más de lo vendido de «${linea.nombre}».`);
      }
      await db.prepare('UPDATE venta_items SET cantidad_devuelta = cantidad_devuelta + ? WHERE id = ?')
        .run(cant, linea.id);
      if (reintegrar !== false) {
        const p = await db.prepare('SELECT stock FROM productos WHERE id = ?').get(linea.producto_id);
        const stockDespues = Math.round((p.stock + cant) * 1000) / 1000;
        await db.prepare("UPDATE productos SET stock = ?, actualizado = datetime('now','localtime') WHERE id = ?")
          .run(stockDespues, linea.producto_id);
        await db.prepare(`INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, referencia, motivo)
                    VALUES (?, 'devolucion', ?, ?, ?, ?, ?)`)
          .run(linea.producto_id, cant, stockDespues, req.usuario.id, 'Devolución venta #' + v.numero, m);
      }
    }
    await db.prepare('INSERT INTO auditoria (evento, detalle, usuario_id) VALUES (?, ?, ?)')
      .run('devolucion', `Devolución parcial venta #${v.numero}: ${m}`, req.usuario.id);
    return ventaCompleta(v.numero);
  })();

  res.json(r);
}));

/* ===== Anulación total (reintegra stock y queda auditada) ===== */
router.post('/api/ventas/:numero/anular', exigirRol('caja'), atender(async (req, res) => {
  const motivo = String((req.body || {}).motivo || '').trim();
  if (!motivo) throw error(400, 'El motivo de anulación es obligatorio.');

  const r = await db.transaction(async () => {
    const v = await db.prepare('SELECT * FROM ventas WHERE numero = ?').get(Number(req.params.numero));
    if (!v) throw error(404, 'Venta inexistente.');
    if (v.estado !== 'completada') throw error(409, 'La venta ya estaba anulada.');

    const lineas = await db.prepare('SELECT * FROM venta_items WHERE venta_id = ?').all(v.id);
    for (const l of lineas) {
      const pendiente = l.cantidad - l.cantidad_devuelta;
      if (pendiente > EPS) {
        const p = await db.prepare('SELECT stock FROM productos WHERE id = ?').get(l.producto_id);
        const stockDespues = Math.round((p.stock + pendiente) * 1000) / 1000;
        await db.prepare("UPDATE productos SET stock = ?, actualizado = datetime('now','localtime') WHERE id = ?")
          .run(stockDespues, l.producto_id);
        await db.prepare(`INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, referencia, motivo)
                    VALUES (?, 'anulacion', ?, ?, ?, ?, ?)`)
          .run(l.producto_id, pendiente, stockDespues, req.usuario.id, 'Anulación venta #' + v.numero, motivo);
      }
    }
    /* Si se pagó en cuenta corriente, se revierte el saldo del cliente. */
    const cc = await db.prepare("SELECT * FROM venta_pagos WHERE venta_id = ? AND medio = 'cuenta_corriente'").get(v.id);
    if (cc && v.cliente_id) {
      await db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id = ?').run(cc.monto, v.cliente_id);
      await db.prepare('INSERT INTO pagos_clientes (cliente_id, monto, motivo, usuario_id) VALUES (?, ?, ?, ?)')
        .run(v.cliente_id, -cc.monto, 'Anulación de venta #' + v.numero, req.usuario.id);
    }

    await db.prepare("UPDATE ventas SET estado = 'anulada', motivo_anulacion = ? WHERE id = ?").run(motivo, v.id);
    await db.prepare('INSERT INTO auditoria (evento, detalle, usuario_id) VALUES (?, ?, ?)')
      .run('anulacion', `Venta #${v.numero} anulada: ${motivo}`, req.usuario.id);
    return ventaCompleta(v.numero);
  })();

  res.json(r);
}));

module.exports = router;


