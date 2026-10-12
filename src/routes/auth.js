'use strict';
/* Rutas de autenticación: registro de primer usuario, login y cierre de sesión. */
const express = require('express');
const { db } = require('../db');
const { nuevaClave } = require('../lib/claves');

function verificarClave(usuario, clave, salt, hash) {
  const crypto = require('crypto');
  try {
    const intento = crypto.scryptSync(String(clave), salt, 64);
    const guardado = Buffer.from(hash, 'hex');
    return intento.length === guardado.length && crypto.timingSafeEqual(intento, guardado);
  } catch (e) {
    return false;
  }
}
const { crearSesion, destruirSesion, fijarCookie, borrarCookie, exigirSesion, normalizarRol } = require('../middleware/auth');
const { atender } = require('../lib/http');

const router = express.Router();

router.get('/api/auth/estado', atender(async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM usuarios').get()).n;
  res.json({ primer_uso: total === 0, usuario: req.usuario });
}));

router.get('/api/auth/yo', (req, res) => {
  if (!req.usuario) return res.status(401).json({ error: 'Sin sesión activa.' });
  req.usuario.rol = normalizarRol(req.usuario.rol);
  res.json(req.usuario);
});

router.post('/api/auth/continuar', atender(async (req, res) => {
  const { usuario, clave, nombre } = req.body || {};
  if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y contraseña son obligatorios.' });

  const usuarioNorm = String(usuario).trim().toLowerCase();
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM usuarios').get()).n;

  /* ── ADMIN POR VARIABLES DE ENTORNO (fuente de verdad en Render) ──────────
     El administrador entra validando contra ADMIN_USUARIO / ADMIN_CLAVE.
     Usuario case-insensitive (.toLowerCase()); contraseña exacta. Esto evita
     el 401 aunque la base tenga sembrada una clave distinta. */
  const ADMIN_USUARIO = String(process.env.ADMIN_USUARIO || 'administrador').trim().toLowerCase();
  const ADMIN_CLAVE = process.env.ADMIN_CLAVE || '';
  if (ADMIN_CLAVE && usuarioNorm === ADMIN_USUARIO && String(clave) === ADMIN_CLAVE) {
    let u = await db.prepare('SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(ADMIN_USUARIO);
    const adminNombre = process.env.ADMIN_NOMBRE || 'Agustín';
    if (!u) {
      const { salt, hash } = nuevaClave(ADMIN_CLAVE);
      const r = await db.prepare("INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt) VALUES (?, ?, 'administrador', ?, ?)")
        .run(adminNombre, ADMIN_USUARIO, hash, salt);
      u = { id: r.lastInsertRowid, nombre: adminNombre, usuario: ADMIN_USUARIO };
    } else {
      // Sincroniza la clave del admin con la env var (queda coherente para logins futuros por BD).
      const { salt, hash } = nuevaClave(ADMIN_CLAVE);
      await db.prepare('UPDATE usuarios SET clave_hash = ?, clave_salt = ?, rol = ? WHERE id = ?')
        .run(hash, salt, 'administrador', u.id);
    }
    const token = await crearSesion(u.id);
    fijarCookie(res, token);
    return res.json({
      mensaje: '¡Hola ' + String(u.nombre).split(' ')[0] + '!',
      usuario: { id: u.id, nombre: u.nombre, usuario: ADMIN_USUARIO, rol: 'administrador' }
    });
  }

  if (total === 0) {
    /* Primer uso: se crea el administrador. Si no viene nombre, se toma de ADMIN_NOMBRE. */
    const nombreFinal = nombre ? String(nombre).trim() : (process.env.ADMIN_NOMBRE || 'Agustín');
    if (String(clave).length < 10) return res.status(400).json({ error: 'La contraseña debe tener al menos 10 caracteres.' });
    const { salt, hash } = nuevaClave(clave);
    const r = await db.prepare("INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt) VALUES (?, ?, 'administrador', ?, ?)")
      .run(nombreFinal, usuarioNorm, hash, salt);
    const token = await crearSesion(r.lastInsertRowid);
    fijarCookie(res, token);
    return res.json({
      mensaje: 'Cuenta de administrador creada.',
      usuario: { id: r.lastInsertRowid, nombre: nombreFinal, usuario: usuarioNorm, rol: 'administrador' }
    });
  }

  const u = await db.prepare('SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(usuarioNorm);
  if (!u || !verificarClave(usuarioNorm, clave, u.clave_salt, u.clave_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  if (!u.activo) return res.status(403).json({ error: 'El usuario está desactivado. Consultá al administrador.' });

  const token = await crearSesion(u.id);
  fijarCookie(res, token);
  await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('login', ?, ?)")
    .run('Inicio de sesión: ' + u.usuario, u.id);
  res.json({ mensaje: '¡Hola de nuevo, ' + u.nombre.split(' ')[0] + '!', usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: (u.usuario === 'administrador' ? 'administrador' : normalizarRol(u.rol)) } });
}));

router.post('/api/auth/logout', exigirSesion, atender(async (req, res) => {
  await destruirSesion(req.token);
  borrarCookie(res);
  res.json({ ok: true, mensaje: 'Sesión cerrada y credenciales limpias.' });
}));

module.exports = router;
