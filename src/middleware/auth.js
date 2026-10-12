'use strict';
/* Sesiones por cookie httpOnly + control de roles. */
const crypto = require('crypto');
const { db } = require('../db');

const DURACION_HORAS = 12;
const NOMBRE_COOKIE = 'sid';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function leerCookie(req, nombre) {
  const crudo = req.headers.cookie || '';
  for (const parte of crudo.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function cargarSesion(req, res, next) {
  req.usuario = null;
  try {
    const token = leerCookie(req, NOMBRE_COOKIE);
    if (token) {
      const fila = await db.prepare(`
        SELECT u.id, u.nombre, u.usuario, u.rol
          FROM sesiones s
          JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.token_hash = ? AND u.activo = 1 AND s.expira > datetime('now','localtime')
      `).get(hashToken(token));
      if (fila) {
        fila.rol = normalizarRol(fila.rol);
        /* SUPERUSUARIO por nombre: aunque el rol en base vieja sea otro,
           el usuario "administrador" siempre entra como administrador. */
        if (String(fila.usuario || '').trim().toLowerCase() === 'administrador') fila.rol = 'administrador';
        req.usuario = fila; req.token = token;
      }
    }
    next();
  } catch (e) { next(e); }
}

function exigirSesion(req, res, next) {
  if (!req.usuario) return res.status(401).json({ error: 'Sesión requerida. Ingresá de nuevo.' });
  req.usuario.rol = normalizarRol(req.usuario.rol);
  if (String(req.usuario.usuario || '').trim().toLowerCase() === 'administrador') req.usuario.rol = 'administrador';
  next();
}

function esAdmin(rol) {
  const r = String(rol || '').trim().toLowerCase();
  return r === 'administrador' || r === 'administrador demo' || r === 'admin' || r === 'dueno' || r === 'dueño';
}

function normalizarRol(rol) {
  return esAdmin(rol) ? 'administrador' : String(rol || '').trim().toLowerCase();
}

function exigirRol(...roles) {
  const lista = roles.map((r) => String(r).trim().toLowerCase());
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'Sesión requerida.' });
    req.usuario.rol = normalizarRol(req.usuario.rol);
    if (String(req.usuario.usuario || '').trim().toLowerCase() === 'administrador') req.usuario.rol = 'administrador';
    if (esAdmin(req.usuario.rol)) return next(); /* SUPERUSUARIO: pasa todo */
    if (!lista.length) return res.status(403).json({ error: 'No tenés permiso para esta acción.' });
    if (!lista.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción.' });
    }
    next();
  };
}

async function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare(`INSERT INTO sesiones (token_hash, usuario_id, expira)
              VALUES (?, ?, datetime('now','localtime','+${DURACION_HORAS} hours'))`)
    .run(hashToken(token), usuarioId);
  return token;
}

async function destruirSesion(token) {
  if (token) await db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(hashToken(token));
}

function fijarCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${NOMBRE_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DURACION_HORAS * 3600}`);
}

function borrarCookie(res) {
  res.setHeader('Set-Cookie', `${NOMBRE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

module.exports = {
  cargarSesion, exigirSesion, exigirRol, esAdmin, normalizarRol,
  crearSesion, destruirSesion, fijarCookie, borrarCookie
};
