'use strict';
/*
  Resolución del PRECIO EFECTIVO — esquema HÍBRIDO de 360MAX Comercios.

  Cada SKU resuelve su precio de venta con DOS niveles, en este orden:

    1) PRECIO FIJO individual  (productos.precio_fijo_centavos)
       Es la excepción manual: Agustín le «clava» un precio final al producto y la
       caja cobra ese monto EXACTO, sin importar el costo ni el rubro.

    2) MARGEN DEL RUBRO  (categorias.margen_ganancia_defecto, 40% por defecto)
       Si no hay precio fijo, el precio se calcula AL VUELO:
           precio = costo * (1 + margen / 100)

  Todo se razona en CENTAVOS ENTEROS (productos.costo_centavos) para que el
  cálculo al vuelo y el arqueo de caja cuadren al centavo, sin errores de
  redondeo en coma flotante. Este módulo es la ÚNICA fuente de verdad del
  precio y lo usan tanto la lectura del lector (GET /api/productos/...) como el
  cobro real (POST /api/ventas): así la góndola y el ticket nunca discrepan.
*/

/* Convierte pesos (REAL) a centavos enteros, con redondeo bancario simple. */
function aCentavos(pesos) {
  const n = Number(pesos);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/* Convierte centavos enteros a pesos (REAL) para los cálculos en pesos. */
function aPesos(centavos) {
  const n = Number(centavos);
  return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

/* Costo del producto en centavos: prefiere costo_centavos y cae al costo REAL
   heredado (bases viejas) para no quedarse sin dato. */
function costoCentavos(p) {
  if (!p) return 0;
  const c = p.costo_centavos;
  if (c !== null && c !== undefined && Number.isFinite(Number(c)) && Number(c) > 0) {
    return Math.round(Number(c));
  }
  return aCentavos(p.costo);
}

/* Margen del rubro normalizado: 0% si no hay dato, redondeado a entero. */
function margenDe(p) {
  const m = p && p.margen_ganancia_defecto;
  const n = Number(m);
  return Number.isFinite(n) ? n : 0;
}

/* Precio fijo válido (entero > 0) o null si el producto se calcula por margen. */
function precioFijoCentavos(p) {
  const f = p && p.precio_fijo_centavos;
  if (f === null || f === undefined || f === '') return null;
  const n = Number(f);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/*
  Resuelve el precio efectivo de un producto y de dónde proviene.
  Devuelve: { centavos, pesos, origen } con origen ∈ 'fijo' | 'margen' | 'base'.
  El último recurso es el precio base guardado (productos.precio) para que un
  SKU sin costo ni precio fijo jamás quede en $0.
*/
function resolverPrecio(p) {
  const fijo = precioFijoCentavos(p);
  if (fijo !== null) return { centavos: fijo, pesos: aPesos(fijo), origen: 'fijo' };

  const costo = costoCentavos(p);
  const margen = margenDe(p);
  if (costo > 0) {
    const centavos = Math.round(costo * (1 + margen / 100));
    return { centavos, pesos: aPesos(centavos), origen: 'margen' };
  }
  return { centavos: aCentavos(p && p.precio), pesos: aPesos(p && p.precio), origen: 'base' };
}

/* Atajos: precio efectivo en pesos o en centavos. */
function precioEfectivoPesos(p) { return resolverPrecio(p).pesos; }
function precioEfectivoCentavos(p) { return resolverPrecio(p).centavos; }

/*
  Decora una fila de producto para la API: agrega el precio efectivo en «precio»
  (lo que ve y cobra la caja) y deja el precio base original en «precio_base»
  junto al origen del cálculo. No muta la fila de entrada.
*/
function conPrecioEfectivo(p) {
  const r = resolverPrecio(p);
  return Object.assign({}, p, {
    precio_base: Number(p && p.precio) || 0,
    precio: r.pesos,
    precio_origen: r.origen,
    precio_centavos: r.centavos,
    costo_centavos: costoCentavos(p),
    margen_ganancia_defecto: margenDe(p),
    precio_fijo_centavos: precioFijoCentavos(p)
  });
}

module.exports = {
  aCentavos, aPesos, costoCentavos, margenDe, precioFijoCentavos,
  resolverPrecio, precioEfectivoPesos, precioEfectivoCentavos, conPrecioEfectivo
};