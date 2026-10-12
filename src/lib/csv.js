'use strict';
/*
  Utilidades de archivos (CSV / Excel) e importación masiva de productos.
  Usada por:  node src/scripts/importarProductos.js <archivo>
  y por la ruta POST /api/productos/importar (texto CSV).
*/
const { db, asegurarCategoria } = require('../db');

/* ---------- Números en formato es-AR ("1.234,56") o anglosajón ("1,234.56") ---------- */
function parseNumero(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (valor === null || valor === undefined) return null;
  let s = String(valor).trim().replace(/[$\s]/g, '');
  if (!s) return null;
  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');
  if (coma > -1 && punto > -1) {           // ambos: el último separador es decimal
    if (coma > punto) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (coma > -1) {                  // solo coma
    s = (s.split(',').length > 2) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizarClave(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const CLAVES_CONOCIDAS = {
  nombre: ['nombre', 'producto', 'descripcion', 'producto_nombre'],
  precio: ['precio', 'precio_venta', 'precioVenta', 'venta'],
  costo: ['costo', 'precio_costo', 'costo_unitario'],
  stock: ['stock', 'existencia', 'existencias', 'cantidad'],
  stock_minimo: ['stock_minimo', 'minimo', 'stockminimo'],
  categoria: ['categoria', 'rubro', 'seccion'],
  subcategoria: ['subcategoria'],
  unidad: ['unidad', 'unidad_medida'],
  codigo_barra: ['codigo_barra', 'codigo_barras', 'codigodebarras', 'ean', 'barcode', 'barra'],
  codigo_interno: ['codigo_interno', 'codigo', 'sku', 'codigointerno'],
  activo: ['activo', 'activa', 'habilitado'],
  variantes: ['variantes']
};

function mapearEncabezados(encabezados) {
  return encabezados.map((h) => {
    const clave = normalizarClave(h);
    for (const [campo, alias] of Object.entries(CLAVES_CONOCIDAS)) {
      if (alias.includes(clave)) return campo;
    }
    return null;
  });
}

/* ---------- Parser CSV con comillas, saltos de línea y detección de separador ---------- */
function parseCSV(texto, separador) {
  let sep = separador;
  if (!sep) {
    const primera = String(texto).split(/\r?\n/)[0] || '';
    const cuentas = { ';': (primera.match(/;/g) || []).length,
                      ',': (primera.match(/,/g) || []).length,
                      '\t': (primera.match(/\t/g) || []).length };
    sep = Object.entries(cuentas).sort((a, b) => b[1] - a[1])[0][1] > 0
      ? Object.entries(cuentas).sort((a, b) => b[1] - a[1])[0][0] : ';';
  }
  texto = String(texto).replace(/^\uFEFF/, '');
  const filas = [];
  let fila = [], campo = '', entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else entreComillas = false;
      } else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((v) => String(v).trim() !== ''));
}

/* ---------- Filas a productos: validación fila por fila ---------- */
async function procesarFilas(filas, opciones) {
  const op = Object.assign({ crearCategorias: true, actualizarStock: false }, opciones || {});
  const res = { insertados: 0, actualizados: 0, omitidos: 0, advertencias: [] };
  if (!filas.length) { res.advertencias.push('El archivo no tiene filas de datos.'); return res; }
  const mapa = mapearEncabezados(filas[0]);
  if (!mapa.includes('nombre') || !mapa.includes('precio')) {
    res.advertencias.push('Faltan columnas obligatorias «nombre» y «precio». Encabezados encontrados: ' + filas[0].join(', '));
    return res;
  }
  const vistos = new Map();
  await db.transaction(async () => {
    const SQL_BARRA = 'SELECT id, nombre FROM productos WHERE codigo_barra = ?';
    const SQL_NOMBRE = 'SELECT id FROM productos WHERE nombre = ? COLLATE NOCASE';
    const SQL_INS = `INSERT INTO productos
      (nombre, categoria_id, unidad, codigo_interno, codigo_barra, costo, costo_centavos, precio, stock, stock_minimo, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const SQL_UPD = `UPDATE productos SET
      nombre = ?, categoria_id = ?, unidad = ?, codigo_interno = ?,
      codigo_barra = COALESCE(codigo_barra, ?), costo = ?, costo_centavos = ?, precio = ?,
      stock = CASE WHEN ? = 1 THEN ? ELSE stock END,
      stock_minimo = ?, activo = ?, actualizado = datetime('now','localtime')
      WHERE id = ?`;

    for (let i = 1; i < filas.length; i++) {
      const f = filas[i];
      const dato = {};
      mapa.forEach((c, col) => { if (c) dato[c] = f[col] !== undefined ? String(f[col]).trim() : ''; });
      const n = i + 1;
      const falla = (m) => { res.omitidos++; res.advertencias.push(`Fila ${n}: ${m}  →  OMITIDA`); };

      if (!dato.nombre) { falla('falta el nombre del producto'); continue; }
      const precio = parseNumero(dato.precio);
      if (precio === null || precio < 0) { falla(`precio inválido («${dato.precio || ''}») en «${dato.nombre}»`); continue; }
      const barra = (dato.codigo_barra || '').trim();
      if (barra) {
        if (vistos.has(barra)) { falla(`codigo_barra «${barra}» duplicado (también en fila ${vistos.get(barra)})`); continue; }
        vistos.set(barra, n);
        const existente = await db.prepare(SQL_BARRA).get(barra);
        if (existente && existente.nombre.toLowerCase() !== dato.nombre.toLowerCase()) {
          falla(`codigo_barra «${barra}» ya pertenece a «${existente.nombre}»`); continue;
        }
      }

      const costo = parseNumero(dato.costo);
      const stock = parseNumero(dato.stock);
      const minimo = parseNumero(dato.stock_minimo);
      if (dato.costo && costo === null) res.advertencias.push(`Fila ${n}: costo inválido, se usa 0.`);
      if (dato.stock && stock === null) res.advertencias.push(`Fila ${n}: stock inválido, se usa 0.`);
      if (dato.stock_minimo && minimo === null) res.advertencias.push(`Fila ${n}: stock_minimo inválido, se usa 0.`);

      let categoriaId = null;
      if (dato.categoria) {
        if (op.crearCategorias) categoriaId = await asegurarCategoria(dato.categoria);
        else {
          const c = await db.prepare('SELECT id FROM categorias WHERE nombre = ? COLLATE NOCASE').get(dato.categoria);
          if (c) categoriaId = c.id;
          else res.advertencias.push(`Fila ${n}: categoría «${dato.categoria}» inexistente; se deja vacía.`);
        }
      }
      const params = {
        nombre: dato.nombre, categoria_id: categoriaId,
        unidad: (dato.unidad || '').toUpperCase() === 'KG' ? 'KG' : 'UNIDAD',
        codigo_interno: (dato.codigo_interno || '').trim() || null,
        codigo_barra: barra || null,
        costo: costo || 0, costo_centavos: Math.round((costo || 0) * 100),
        precio, stock: stock || 0, stock_minimo: minimo || 0,
        activo: dato.activo && ['no', 'false', '0', 'n', 'inactivo'].includes(dato.activo.toLowerCase()) ? 0 : 1
      };

      const existente = barra
        ? await db.prepare(SQL_BARRA).get(barra)
        : await db.prepare(SQL_NOMBRE).get(dato.nombre);
      if (existente) {
        await db.prepare(SQL_UPD).run(params.nombre, params.categoria_id, params.unidad,
          params.codigo_interno, params.codigo_barra, params.costo, params.costo_centavos, params.precio,
          op.actualizarStock ? 1 : 0, params.stock, params.stock_minimo, params.activo, existente.id);
        res.actualizados++;
      } else {
        await db.prepare(SQL_INS).run(params.nombre, params.categoria_id, params.unidad,
          params.codigo_interno, params.codigo_barra, params.costo, params.costo_centavos, params.precio,
          params.stock, params.stock_minimo, params.activo);
        res.insertados++;
      }
    }
  })();
  return res;
}

/* ---------- Lectura de archivo: CSV o Excel ---------- */
async function leerArchivo(ruta, opciones) {
  const fs = require('fs');
  const path = require('path');
  const ext = path.extname(ruta).toLowerCase();
  if (ext === '.csv' || ext === '.txt') {
    return procesarFilas(parseCSV(fs.readFileSync(ruta, 'utf8'), opciones && opciones.separador), opciones);
  }
  if (ext === '.xlsx' || ext === '.xls') {
    let XLSX;
    try { XLSX = require('xlsx'); }
    catch (e) {
      throw new Error('Para leer Excel hace falta la dependencia «xlsx». Ejecutá `npm install` o exportí el archivo como CSV.');
    }
    const wb = XLSX.readFile(ruta);
    const hoja = wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' })
      .map((f) => f.map((c) => (c === null || c === undefined ? '' : String(c))));
    return procesarFilas(filas, opciones);
  }
  throw new Error(`Formato no soportado: «${ext || '(sin extensión)'}». Usá .csv, .xlsx o .xls.`);
}

module.exports = { parseCSV, parseNumero, mapearEncabezados, procesarFilas, leerArchivo };

