
'use strict';
const path = require('path');
const express = require('express');
const { cargarSesion } = require('./middleware/auth');
const { DB_PATH, lista } = require('./db');

const PUERTO = process.env.PORT || 3000;

function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));
  app.use(cargarSesion);

  app.use(require('./routes/auth'));
  app.use(require('./routes/productos'));
  app.use(require('./routes/categorias'));
  app.use(require('./routes/caja'));
  app.use(require('./routes/ventas'));
  app.use(require('./routes/stock'));
  app.use(require('./routes/admin'));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error('[360MAX]', err);
    res.status(status).json({ error: err.message || 'Error interno.' });
  });
  return app;
}

if (require.main === module) {
  lista.then(async () => {
    // Auto-semilla: SOLO si la base está vacía (primer arranque en disco limpio).
    // Nunca borra ventas: en reinicios con datos, no hace nada.
    try {
      const { prepare } = require('./db');
      const fila = await prepare('SELECT COUNT(*) AS n FROM productos').get();
      if (!fila || Number(fila.n) === 0) {
        console.log('[360MAX] Base sin productos: cargando lista definitiva de Agustín (299)...');
        const { main: cargarLista } = require('./tools/cargar-lista-agustin');
        await cargarLista();
        console.log('[360MAX] Lista cargada en el primer arranque.');
      } else {
        console.log(`[360MAX] Base con datos (${fila.n} productos): se conserva, no se re-carga.`);
      }
    } catch (e) {
      console.error('[360MAX] Auto-semilla falló (no frena el arranque):', e.message);
    }
    const app = crearApp();
    app.listen(PUERTO, () => {
      console.log('');
      console.log('  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄');
      console.log('  █  360MAX COMERCIOS — DEMO ON  █');
      console.log('  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀');
      console.log(`  ➜  http://localhost:${PUERTO}`);
      console.log(`  ➜  Base de datos: ${DB_PATH}`);
      console.log('');
    });
  }).catch((e) => {
    console.error('[360MAX] No se pudo abrir la base de datos:', e.message);
    process.exit(1);
  });
}

module.exports = { crearApp };
