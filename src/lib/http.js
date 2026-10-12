'use strict';
/* Envuelve handlers async: Express 4 no captura rechazos de promesas. */
function atender(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
module.exports = { atender };
