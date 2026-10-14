'use strict';
/* Categorías y subcategorías (árbol de organización). */
const express = require('express');
const { db, asegurarCategoria } = require('../db');
const { exigirSesion, exigirRol } = require('../middleware/auth');
const { atender } = require('../lib/http');

const router = express.Router();

router.get('/api/categorias', exigirSesion, atender(async (req, res) => {
  const cats = await db.prepare('SELECT * FROM categorias ORDER BY nombre COLLATE NOCASE').all();
  const subs = await db.prepare('SELECT * FROM subcategorias ORDER BY nombre COLLATE NOCASE').all();
  res.json(cats.map((c) => Object.assign({}, c, {
    subcategorias: subs.filter((s) => s.categoria_id === c.id)
  })));
}));

router.post('/api/categorias', exigirRol('deposito'), atender(async (req, res) => {
  const cuerpo = req.body || {};
  const nombre = String(cuerpo.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ingresá el nombre de la categoría.' });
  const margen = Number(cuerpo.margen_ganancia_defecto);
  if (cuerpo.margen_ganancia_defecto !== undefined &&
    (!Number.isInteger(margen) || margen < 0 || margen > 1000)) {
    return res.status(400).json({ error: 'El margen debe ser un entero entre 0 y 1000.' });
  }
  const existe = await db.prepare('SELECT id FROM categorias WHERE nombre = ? COLLATE NOCASE').get(nombre);
  if (existe) return res.status(409).json({ error: 'La categoría ya existe.' });
  const id = await asegurarCategoria(nombre);
  if (Number.isInteger(margen)) {
    await db.prepare('UPDATE categorias SET margen_ganancia_defecto = ? WHERE id = ?').run(margen, id);
  }
  res.status(201).json(await db.prepare('SELECT * FROM categorias WHERE id = ?').get(id));
}));

/* Margen de ganancia por rubro: es el % que la caja aplica sobre el costo
   cuando el producto NO tiene precio fijo. Se valida como entero razonable. */
router.put('/api/categorias/:id/margen', exigirRol(), atender(async (req, res) => {
  const id = Number(req.params.id);
  const valor = Number((req.body || {}).margen_ganancia_defecto);
  if (!Number.isInteger(valor) || valor < 0 || valor > 1000) {
    return res.status(400).json({ error: 'El margen debe ser un entero entre 0 y 1000.' });
  }
  const r = await db.prepare('UPDATE categorias SET margen_ganancia_defecto = ? WHERE id = ?').run(valor, id);
  if (!r.changes) return res.status(404).json({ error: 'Categoría inexistente.' });
  await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('margen_categoria', ?, ?)")
    .run('Categoría #' + id + ' → margen ' + valor + '%', req.usuario.id);
  res.json(await db.prepare('SELECT * FROM categorias WHERE id = ?').get(id));
}));

router.delete('/api/categorias/:id', exigirRol('deposito'), atender(async (req, res) => {
  const id = Number(req.params.id);
  const enUso = (await db.prepare('SELECT COUNT(*) n FROM productos WHERE categoria_id = ?').get(id)).n;
  if (enUso) return res.status(409).json({ error: `No se puede borrar: hay ${enUso} producto(s) en esta categoría.` });
  await db.prepare('DELETE FROM categorias WHERE id = ?').run(id);
  res.json({ ok: true });
}));

router.post('/api/subcategorias', exigirRol('deposito'), atender(async (req, res) => {
  const { categoria_id, nombre } = req.body || {};
  const n = String(nombre || '').trim();
  if (!categoria_id || !n) return res.status(400).json({ error: 'Categoría y nombre son obligatorios.' });
  try {
    const r = await db.prepare('INSERT INTO subcategorias (categoria_id, nombre) VALUES (?, ?)').run(Number(categoria_id), n);
    res.status(201).json({ id: r.lastInsertRowid, categoria_id: Number(categoria_id), nombre: n });
  } catch (e) {
    res.status(409).json({ error: 'La subcategoría ya existe en esa categoría.' });
  }
}));

module.exports = router;
