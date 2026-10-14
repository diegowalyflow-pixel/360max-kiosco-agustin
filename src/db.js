'use strict';
/* 360MAX Comercios — conexión y esquema de base de datos (SQLite vía «sqlite3»).
   «sqlite3» es asíncrono: se expone una fachada con la misma cara que el código
   original ya usa — db.prepare(sql).get/all/run, db.exec, db.transaction(fn)() —
   devolviendo promesas. Todas las operaciones pasan por una cola única para que
   ninguna consulta se cuele dentro de una transacción abierta; dentro de una
   transacción (AsyncLocalStorage) van directo para no bloquearse entre si. */
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const sqlite3 = require('sqlite3').verbose();
const { nuevaClave } = require('./lib/claves');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', '360max.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const enTransaccion = new AsyncLocalStorage();
let conector = null;
let cola = Promise.resolve();
let falloInicial = null;

function normalizarParametros(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0].map((v) => (v === undefined ? null : v));
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') {
    const conPrefijo = {};
    for (const k of Object.keys(args[0])) {
      const clave = k[0] === '@' || k[0] === ':' || k[0] === '\$' ? k : '@' + k;
      conPrefijo[clave] = args[0][k] === undefined ? null : args[0][k];
    }
    return conPrefijo;
  }
  return args.map((v) => (v === undefined ? null : v));
}

function obtenerCrudo(sql, params) {
  return new Promise((resolve, reject) => {
    conector.get(sql, params, (err, fila) => (err ? reject(err) : resolve(fila)));
  });
}

function todosCrudo(sql, params) {
  return new Promise((resolve, reject) => {
    conector.all(sql, params, (err, filas) => (err ? reject(err) : resolve(filas || [])));
  });
}

function ejecutarCrudo(sql, params) {
  return new Promise((resolve, reject) => {
    conector.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastInsertRowid: this.lastID });
    });
  });
}

function scriptCrudo(sql) {
  return new Promise((resolve, reject) => conector.exec(sql, (err) => (err ? reject(err) : resolve())));
}

function encolar(tarea) {
  if (enTransaccion.getStore()) return tarea();
  const resultado = cola.then(() => (falloInicial ? Promise.reject(falloInicial) : tarea()));
  cola = resultado.catch(() => {});
  return resultado;
}

function preparar(sql) {
  return {
    get: (...args) => encolar(() => obtenerCrudo(sql, normalizarParametros(args))),
    all: (...args) => encolar(() => todosCrudo(sql, normalizarParametros(args))),
    run: (...args) => encolar(() => ejecutarCrudo(sql, normalizarParametros(args)))
  };
}

const db = {
  prepare: preparar,
  exec: (sql) => encolar(() => scriptCrudo(sql)),
  transaction(fn) {
    return () => encolar(async () => {
      await ejecutarCrudo('BEGIN IMMEDIATE', []);
      try {
        const r = await enTransaccion.run(true, () => fn());
        await ejecutarCrudo('COMMIT', []);
        return r;
      } catch (e) {
        try { await ejecutarCrudo('ROLLBACK', []); } catch (_) { /* sin transacción activa */ }
        throw e;
      }
    });
  }
};

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE,
  rol TEXT NOT NULL CHECK (rol IN ('caja','deposito','administrador')),
  clave_hash TEXT NOT NULL,
  clave_salt TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sesiones (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expira TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  margen_ganancia_defecto INTEGER NOT NULL DEFAULT 40
);

CREATE TABLE IF NOT EXISTS subcategorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  categoria_id INTEGER NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  UNIQUE (categoria_id, nombre)
);

CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  categoria_id INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
  subcategoria_id INTEGER REFERENCES subcategorias(id) ON DELETE SET NULL,
  unidad TEXT NOT NULL DEFAULT 'UNIDAD',
  codigo_interno TEXT,
  codigo_barra TEXT,
  costo REAL NOT NULL DEFAULT 0,
  costo_centavos INTEGER,
  precio REAL NOT NULL DEFAULT 0,
  precio_fijo_centavos INTEGER,
  stock REAL NOT NULL DEFAULT 0,
  stock_minimo REAL NOT NULL DEFAULT 0,
  variantes TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  telefono TEXT,
  saldo REAL NOT NULL DEFAULT 0,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS cajas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS turnos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caja_id INTEGER NOT NULL REFERENCES cajas(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  fondo REAL NOT NULL DEFAULT 0,
  fondo_centavos INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'cerrada' CHECK (estado IN ('abierta','cerrada')),
  fecha_apertura TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  fecha_cierre TEXT,
  contado REAL,
  diferencia REAL,
  observaciones TEXT,
  cierre_usuario_id INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero INTEGER NOT NULL UNIQUE,
  turno_id INTEGER REFERENCES turnos(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  caja_id INTEGER REFERENCES cajas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  total REAL NOT NULL,
  estado TEXT NOT NULL DEFAULT 'completada' CHECK (estado IN ('completada','anulada')),
  motivo_anulacion TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS venta_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  nombre TEXT NOT NULL,
  cantidad REAL NOT NULL,
  precio REAL NOT NULL,
  subtotal REAL NOT NULL,
  cantidad_devuelta REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS venta_pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  medio TEXT NOT NULL,
  monto REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida','merma','ajuste','venta','devolucion','anulacion')),
  cantidad REAL NOT NULL,
  stock_despues REAL NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  turno_id INTEGER REFERENCES turnos(id),
  proveedor_id INTEGER REFERENCES proveedores(id),
  referencia TEXT,
  motivo TEXT,
  observacion TEXT,
  lote TEXT,
  vencimiento TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS movimientos_caja (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  monto REAL NOT NULL,
  motivo TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento TEXT NOT NULL,
  detalle TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS arqueos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  esperado REAL,
  contado REAL,
  diferencia REAL,
  observaciones TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS pagos_clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  monto REAL NOT NULL,
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

`;

async function sembrarDatos() {
  const filaUser = await obtenerCrudo("SELECT COUNT(*) as cant FROM usuarios");
  if (filaUser.cant === 0) {
    // Credenciales del administrador tomadas del entorno (producción).
    // Si no se define ADMIN_CLAVE, se genera una robusta de un solo uso y se
    // muestra UNA sola vez en el log (nunca queda un "admin"/"123" conocido).
    const salt = 'seed_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const adminUsuario = process.env.ADMIN_USUARIO || 'agustin';
    const adminNombre = process.env.ADMIN_NOMBRE || 'Agustín';
    let adminClave = process.env.ADMIN_CLAVE || '';
    let claveTemporal = false;
    if (!adminClave) {
      adminClave = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2).toUpperCase();
      claveTemporal = true;
    }
    const hash = nuevaClave(adminClave, salt);
    await ejecutarCrudo(
      "INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt) VALUES (?, ?, 'administrador', ?, ?)",
      [adminNombre, adminUsuario, hash, salt]
    );
    await crearCajaInicial();

    console.log('');
    console.log('  [360MAX] Base de datos creada de cero.');
    console.log('  [360MAX] Turno inicial: CERRADO.');
    console.log('  [360MAX] El cliente definirá el fondo inicial desde el navegador.');
    if (claveTemporal) {
      console.log('  [360MAX] ADMIN TEMPORAL -> usuario: ' + adminUsuario + ' | clave: ' + adminClave);
      console.log('  [360MAX] Definí ADMIN_CLAVE en Render y reiniciá para fijar una propia.');
    } else {
      console.log('  [360MAX] Admin creado con las credenciales del entorno (ADMIN_USUARIO / ADMIN_CLAVE).');
    }
    console.log('');
  }
}

async function crearCajaInicial() {
  await ejecutarCrudo("INSERT INTO cajas (nombre) VALUES ('Caja Principal')");
}


const lista = new Promise((resolve, reject) => {
  conector = new sqlite3.Database(DB_PATH, async (err) => {
    if (err) {
      falloInicial = err;
      return reject(err);
    }
    try {
      await ejecutarCrudo("PRAGMA foreign_keys = ON");
      await scriptCrudo(ESQUEMA);
      await sembrarDatos();
      resolve();
    } catch (e) {
      falloInicial = e;
      reject(e);
    }
  });
});

// Compatibilidad: algunos módulos hacen `const { db } = require('../db')` y usan
// db.prepare(...). Exponemos un objeto `db` con la misma API async para que ese
// patrón funcione (db === el módulo con prepare/exec/transaction).
const apiDb = { prepare: preparar, exec: db.exec, transaction: db.transaction, DB_PATH, lista };
module.exports = { DB_PATH, lista, prepare: preparar, exec: db.exec, transaction: db.transaction, db: apiDb };
