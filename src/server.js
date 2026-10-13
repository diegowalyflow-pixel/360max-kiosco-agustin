
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

  // Anti-caché TOTAL: el navegador de Agustín tenía guardada la pantalla rota
  // vieja y por eso veía blanco aunque el servidor ya estaba bien. Con esto el
  // navegador NO puede reusar nada: pide todo de nuevo al servidor bueno.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/productos'));
  app.use(require('./routes/categorias'));
  app.use(require('./routes/caja'));
  app.use(require('./routes/ventas'));
  app.use(require('./routes/stock'));
  app.use(require('./routes/admin'));

  const PUBLIC = path.join(__dirname, '..', 'public');
  // express.static sobreescribe el Cache-Control de arriba con "public, max-age=0".
  // Con max-age=0 el navegador IGUAL muestra la pantalla rota cacheada. Acá le
  // clavamos no-store a cada archivo estático: es la única forma de que el celu
  // de Agustín no pueda reusar la versión vieja y cargue el login nuevo sí o sí.
  app.use(express.static(PUBLIC, {
    setHeaders: (res) => {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.set('Surrogate-Control', 'no-store');
    }
  }));

  // Salud para el health check de Render (nunca debe dar 404).
  app.get(['/healthz', '/health'], (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

  // Raíz explícita: garantiza servir la pantalla de login en "/".
  // cacheControl:false → Express NO pone su "public, max-age=0" (que pisaba el no-store).
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html'), { cacheControl: false }));

  // API desconocida: 404 en JSON (no confunde al front con HTML en blanco).
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

  // Fallback SPA: cualquier otra ruta GET sirve index.html. Así, entrar por un
  // sub-path (/caja, /admin, /deposito) NUNCA muestra "Cannot GET" en blanco.
  app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html'), { cacheControl: false }));
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
