'use strict';
/* Hash de contraseñas con scrypt (sin dependencias externas). */
const crypto = require('crypto');

function nuevaClave(clave) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(clave), salt, 64).toString('hex');
  return { salt, hash };
}

function verificarClave(clave, salt, hash) {
  const intento = crypto.scryptSync(String(clave), salt, 64);
  const guardado = Buffer.from(hash, 'hex');
  return intento.length === guardado.length && crypto.timingSafeEqual(intento, guardado);
}

module.exports = { nuevaClave, verificarClave };
