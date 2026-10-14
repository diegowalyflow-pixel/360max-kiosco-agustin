'use strict';
/* Rutas de productos: CRUD, búsqueda por código de barras, CSV e importación. */
const express = require('express');
const { db, asegurarCategoria } = require('../db');
const { exigirSesion, exigirRol } = require('../middleware/auth');
const { procesarFilas, parseCSV } = require('../lib/csv');
const { atender } = require('../lib/http');
const { conPrecioEfectivo } = require('../lib/precios');

const router = express.Router();

/* El margen del rubro viaja junto al producto: la resolución del precio
   (fijo individual o margen del rubro) se hace en JS con src/lib/precios. */
const SELECT_P = `
  SELECT p.*, c.nombre AS categoria, sc.nombre AS subcategoria,
         IFNULL(c.margen_ganancia_defecto, 40) AS margen_ganancia_defecto
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN subcategorias sc ON sc.id = p.subcategoria_id`;

function normalizarProducto(p) {
  /* «precio» de la API es el PRECIO EFECTIVO (lo que ve y cobra la caja);
     «precio_base» conserva el valor guardado y «precio_origen» dice de dónde
     salió: 'fijo' (excepción manual) o 'margen' (costo × margen del rubro). */
  return conPrecioEfectivo(Object.assign({}, p, { activo: p.activo ? 1 : 0 }));
}

router.get('/api/productos', exigirSesion, atender(async (req, res) => {
  const incluyeInactivos = req.query.inactivos === '1';
  let sql = SELECT_P + (incluyeInactivos ? '' : ' WHERE p.activo = 1');
  sql += ' ORDER BY c.nombre COLLATE NOCASE, p.nombre COLLATE NOCASE';
  res.json((await db.prepare(sql).all()).map(normalizarProducto));
}));

/* Búsqueda instantánea del lector «Nictom LCB8200W»: código de barras o interno
   exacto (el nombre también sirve). Devuelve el producto con su PRECIO EFECTIVO
   ya resuelto: precio fijo individual si lo tiene, o el cálculo al vuelo con el
   margen del rubro sobre el costo. */
async function productoPorCodigo(cod) {
  const fila = await db.prepare(`
    SELECT p.*, c.nombre AS categoria, IFNULL(c.margen_ganancia_defecto, 40) AS margen_ganancia_defecto
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.activo = 1 AND (p.codigo_barra = ? OR p.codigo_interno = ? OR p.nombre = ? COLLATE NOCASE)
     ORDER BY (p.codigo_barra = ?) DESC LIMIT 1
  `).get(cod, cod, cod, cod);
  return fila ? normalizarProducto(fila) : null;
}

router.get('/api/productos/codigo/:codigo', exigirSesion, atender(async (req, res) => {
  const cod = String(req.params.codigo || '').trim();
  if (!cod) return res.status(400).json({ error: 'Código vacío.' });
  const p = await productoPorCodigo(cod);
  if (!p) return res.status(404).json({ error: 'Código no encontrado: ' + cod });
  res.json(p);
}));

router.get('/api/indicadores', exigirSesion, atender(async (req, res) => {
  const productos = (await db.prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1').get()).n;
  const bajo = (await db.prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1 AND stock <= stock_minimo').get()).n;
  const valor = (await db.prepare('SELECT IFNULL(SUM(stock * costo), 0) v FROM productos WHERE activo = 1').get()).v;
  const hoy = (await db.prepare(`SELECT IFNULL(SUM(total), 0) v FROM ventas
                          WHERE estado = 'completada' AND date(fecha) = date('now','localtime')`).get()).v;
  res.json({ productos, bajo_minimo: bajo, stock_valor: valor, ventas_hoy: hoy });
}));

function cuerpoAProducto(b) {
  const nombre = String(b.nombre || '').trim();
  if (!nombre) throw Object.assign(new Error('El nombre es obligatorio.'), { status: 400 });
  const precio = Number(b.precio);
  if (!Number.isFinite(precio) || precio < 0) throw Object.assign(new Error('Precio inválido.'), { status: 400 });
  const costo = Number.isFinite(Number(b.costo)) ? Number(b.costo) : 0;
  /* Precio fijo OPCIONAL: es la excepción individual. Si no se informa (vacío o
     cero) el producto se cobra calculando el margen del rubro sobre el costo. */
  const fijo = b.precio_fijo === null || b.precio_fijo === undefined || b.precio_fijo === ''
    ? null : Number(b.precio_fijo);
  const precio_fijo_centavos = Number.isFinite(fijo) && fijo > 0 ? Math.round(fijo * 100) : null;
  return {
    nombre,
    categoria_id: b.categoria_id ? Number(b.categoria_id) : null,
    subcategoria_id: b.subcategoria_id ? Number(b.subcategoria_id) : null,
    unidad: b.unidad === 'KG' ? 'KG' : 'UNIDAD',
    codigo_interno: String(b.codigo_interno || '').trim() || null,
    codigo_barra: String(b.codigo_barra || '').trim() || null,
    costo,
    costo_centavos: Math.round(costo * 100),
    precio,
    precio_fijo_centavos,
    stock_minimo: Number.isFinite(Number(b.stock_minimo)) ? Number(b.stock_minimo) : 0,
    variantes: String(b.variantes || '').trim() || null,
    activo: b.activo === false || b.activo === 0 || b.activo === '0' ? 0 : 1
  };
}

async function verificarBarraLibre(codigoBarra, idPropio) {
  if (!codigoBarra) return;
  const otro = await db.prepare('SELECT id FROM productos WHERE codigo_barra = ?').get(codigoBarra);
  if (otro && otro.id !== idPropio) {
    throw Object.assign(new Error('El código de barras ya está en uso por otro producto.'), { status: 409 });
  }
}

router.post('/api/productos', exigirRol('deposito'), atender(async (req, res) => {
  const p = cuerpoAProducto(req.body || {});
  await verificarBarraLibre(p.codigo_barra, null);
  const stockInicial = Number.isFinite(Number((req.body || {}).stock_inicial))
    ? Number(req.body.stock_inicial) : 0;
  const id = await db.transaction(async () => {
    const ins = await db.prepare(`
      INSERT INTO productos (nombre, categoria_id, subcategoria_id, unidad, codigo_interno, codigo_barra,
                             costo, costo_centavos, precio, precio_fijo_centavos, stock, stock_minimo, variantes, activo)
      VALUES (@nombre, @categoria_id, @subcategoria_id, @unidad, @codigo_interno, @codigo_barra,
              @costo, @costo_centavos, @precio, @precio_fijo_centavos, @stock, @stock_minimo, @variantes, @activo)`).run(Object.assign({}, p, { stock: stockInicial }));
    if (stockInicial !== 0) {
      await db.prepare(`INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, motivo)
                  VALUES (?, 'entrada', ?, ?, ?, 'Stock inicial')`).run(ins.lastInsertRowid, stockInicial, stockInicial, req.usuario.id);
    }
    return ins.lastInsertRowid;
  })();
  res.status(201).json(normalizarProducto(await db.prepare(SELECT_P + ' WHERE p.id = ?').get(id)));
}));

/* ---------- Edición y baja lógica ---------- */
router.put('/api/productos/:id', exigirRol('deposito'), atender(async (req, res) => {
  const id = Number(req.params.id);
  const actual = await db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  if (!actual) return res.status(404).json({ error: 'Producto inexistente.' });
  const cuerpo = Object.assign({}, req.body || {});
  if (cuerpo.codigo_barra === undefined) cuerpo.codigo_barra = actual.codigo_barra;
  if (cuerpo.codigo_interno === undefined) cuerpo.codigo_interno = actual.codigo_interno;
  /* Si el cliente no manda el precio fijo, se conserva el que tenía: una simple
     edición de stock o nombre no debe borrar la excepción de precio. */
  if (cuerpo.precio_fijo === undefined && actual.precio_fijo_centavos !== null && actual.precio_fijo_centavos !== undefined) {
    cuerpo.precio_fijo = Number(actual.precio_fijo_centavos) / 100;
  }
  const p = cuerpoAProducto(cuerpo);
  await verificarBarraLibre(p.codigo_barra, id);
  await db.prepare(`
    UPDATE productos SET nombre = @nombre, categoria_id = @categoria_id, subcategoria_id = @subcategoria_id,
      unidad = @unidad, codigo_interno = @codigo_interno, codigo_barra = @codigo_barra,
      costo = @costo, costo_centavos = @costo_centavos, precio = @precio,
      precio_fijo_centavos = @precio_fijo_centavos, stock_minimo = @stock_minimo, variantes = @variantes,
      activo = @activo, actualizado = datetime('now','localtime')
    WHERE id = @id
  `).run(Object.assign(p, { id }));
  res.json(normalizarProducto(await db.prepare(SELECT_P + ' WHERE p.id = ?').get(id)));
}));

/* Baja lógica: conserva el histórico de stock y ventas. */
router.delete('/api/productos/:id', exigirRol('deposito'), atender(async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.prepare('UPDATE productos SET activo = 0, actualizado = datetime(\'now\',\'localtime\') WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'Producto inexistente.' });
  res.json({ ok: true });
}));

/* ---------- Exportar CSV (para editar en Excel) ---------- */
router.get('/api/productos/csv', exigirSesion, atender(async (req, res) => {
  const filas = await db.prepare(`
    SELECT p.nombre, IFNULL(c.nombre,'') AS categoria, IFNULL(sc.nombre,'') AS subcategoria, p.unidad,
           IFNULL(p.codigo_interno,'') AS codigo_interno, IFNULL(p.codigo_barra,'') AS codigo_barra,
           p.costo, p.precio, p.stock, p.stock_minimo, p.activo
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN subcategorias sc ON sc.id = p.subcategoria_id
     ORDER BY p.nombre COLLATE NOCASE
  `).all();
  const comilla = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const decimal = (v) => String(Number(v).toFixed(2)).replace('.', ',');
  const cab = ['nombre', 'categoria', 'subcategoria', 'unidad', 'codigo_interno', 'codigo_barra',
    'costo', 'precio', 'stock', 'stock_minimo', 'activo'].join(';');
  const cuerpo = filas.map((f) => [
    f.nombre, f.categoria, f.subcategoria, f.unidad, f.codigo_interno, f.codigo_barra,
    decimal(f.costo), decimal(f.precio), String(f.stock).replace('.', ','), String(f.stock_minimo).replace('.', ','),
    f.activo ? 'SI' : 'NO'
  ].map(comilla).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="360max-productos.csv"');
  res.send('\uFEFF' + cab + '\r\n' + cuerpo);
}));

/* ---------- Importar CSV desde la vista de Administración ---------- */
router.post('/api/productos/importar', exigirRol('deposito'), atender(async (req, res) => {
  const { texto, separador, actualizar_stock } = req.body || {};
  if (!texto) return res.status(400).json({ error: 'No se recibió contenido CSV.' });
  const filas = parseCSV(texto, separador);
  const r = await procesarFilas(filas, { actualizarStock: !!actualizar_stock });
  await db.prepare('INSERT INTO auditoria (evento, detalle, usuario_id) VALUES (?, ?, ?)')
    .run('importacion_csv', JSON.stringify({ insertados: r.insertados, actualizados: r.actualizados, omitidos: r.omitidos }), req.usuario.id);
  res.json(r);
}));

/* Alias pedido por la especificación: GET /api/productos/:codigo resuelve el
   mismo precio híbrido que /api/productos/codigo/:codigo. Se registra al final
   para no tapar rutas literales previas (p. ej. GET /api/productos/csv). */
router.get('/api/productos/:codigo', exigirSesion, atender(async (req, res) => {
  const cod = String(req.params.codigo || '').trim();
  if (!cod) return res.status(400).json({ error: 'Código vacío.' });
  const p = await productoPorCodigo(cod);
  if (!p) return res.status(404).json({ error: 'Código no encontrado: ' + cod });
  res.json(p);
}));

module.exports = router;

