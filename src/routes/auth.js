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

  const total = (await db.prepare('SELECT COUNT(*) AS n FROM usuarios').get()).n;

  if (total === 0) {
    /* Primer uso: se crea el administrador con los datos enviados. */
    if (!nombre) return res.status(400).json({ error: 'Ingresá tu nombre para crear la cuenta inicial.' });
    if (String(clave).length < 10) return res.status(400).json({ error: 'La contraseña debe tener al menos 10 caracteres.' });
    const { salt, hash } = nuevaClave(clave);
    const r = await db.prepare("INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt) VALUES (?, ?, 'administrador', ?, ?)")
      .run(String(nombre).trim(), String(usuario).trim().toLowerCase(), hash, salt);
    const token = await crearSesion(r.lastInsertRowid);
    fijarCookie(res, token);
    return res.json({
      mensaje: 'Cuenta de administrador creada. ¡Listo para la demo!',
      usuario: { id: r.lastInsertRowid, nombre: String(nombre).trim(), usuario: String(usuario).trim().toLowerCase(), rol: 'administrador' }
    });
  }

  const u = await db.prepare('SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(String(usuario).trim());
  if (!u || !verificarClave(String(usuario).trim(), clave, u.clave_salt, u.clave_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  if (!u.activo) return res.status(403).json({ error: 'El usuario está desactivado. Consultá al administrador.' });

  const token = await crearSesion(u.id);
  fijarCookie(res, token);
  await db.prepare("INSERT INTO auditoria (evento, detalle, usuario_id) VALUES ('login', ?, ?)")
    .run('Inicio de sesión: ' + u.usuario, u.id);
  res.json({ mensaje: '¡Hola de nuevo, ' + u.nombre.split(' ')[0] + '!', usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: (String(u.usuario || '').trim().toLowerCase() === 'administrador' ? 'administrador' : normalizarRol(u.rol)) } });
}));

router.post('/api/auth/logout', exigirSesion, atender(async (req, res) => {
  await destruirSesion(req.token);
  borrarCookie(res);
  res.json({ ok: true, mensaje: 'Sesión cerrada y credenciales limpias.' });
}));

module.exports = router;
