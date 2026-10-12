# 360MAX Comercios — Demo en vivo

Sistema fullstack (Node.js + Express + SQLite) para gestión de **caja (POS), depósito, stock y facturación por ticket térmico**, preparado para presentar una demo fluida y 100% operativa.

## Puesta en marcha (5 minutos)

```bash
npm install          # express + sqlite3 + xlsx
npm start            # http://localhost:3000 — la demo se siembra sola al arrancar
npm run sembrar      # (opcional) repone la demo a mano: administrador + 18 productos
```

- **Al arrancar, la demo se siembra sola**: si la base está vacía (o en «primer uso») el servidor crea el usuario **administrador**, las 6 categorías, los 18 productos con código de barras y deja la **Caja 1 abierta con $1000**. Por eso la demo sobrevive a los reinicios de Render, que borran el disco: `npm run sembrar` ya no es un paso obligatorio.
- Ingreso rápido de demo: `administrador / demo360max!` (para el usuario `administrador` el puente de la demo acepta cualquier clave).
- Primer uso a mano: si preferís crear tu propia cuenta, borrá `data/360max.db` con `SEMBRAR_DEMO=0` y usá el formulario (contraseña mínimo 10 caracteres).
- `SEMBRAR_DEMO=0` apaga la siembra automática; `CLAVE_DEMO=otraclave` y `FONDO_DEMO=5000` cambian la clave y el fondo con el que abre la caja.
- Para repetirlo a mano en cualquier momento: `npm run sembrar` (no duplica nada si ya hay datos).

## 1) Caja y tiquera (flujo completo sin bloqueos)

1. **Caja → Abrir caja** (fondo inicial) → pestaña **Vender**.
2. Escaneá/tocá productos → **COBRAR** → medio de pago → **CONFIRMAR COBRO**.
3. En una sola **transacción** el servidor: valida stock, descuenta stock real en SQLite,
   registra venta + pagos + movimiento de stock, y devuelve el ticket.
4. El carrito se limpia y **`window.print()` se dispara solo** (o con el botón
   *Imprimir ticket* / *Reimprimir último ticket*).
5. El ticket está maquetado con `@media print` para tiqueras **58 mm y 80 mm**
   (selector de ancho en el modal). Solo se imprime `#ticketImpresion`; toda la UI queda oculta.

## 2) Organización por categorías + cerrar sesión

- **Caja**: chips de categorías horizontales (scroll en celular) + secciones por categoría
  cuando se muestra "Todas".
- **Depósito**: pestañas (Ingreso/Egreso/Merma/Ajuste/**Catálogo**/Historial); el Catálogo
  agrupa productos por categoría con chips, y los `<select>` usan `<optgroup>` por categoría.
- **Cerrar sesión** (esquina superior derecha): `POST /api/auth/logout` borra la sesión en la
  base, elimina la cookie `httpOnly` y vuelve al Login limpiando la UI.

## 3) Código de barras

- La tabla `productos` incluye **`codigo_barra`** (con índice; migración automática si la base
  venía de una versión anterior).
- En Caja, `#posBuscar` **mantiene el foco automáticamente**: al hacer clic fuera de un campo,
  al recuperar la ventana, y al escribir cualquier tecla. El lector USB escribe el código +
  Enter → `GET /api/productos/codigo/:codigo` → entra al carrito al instante.
- También hay escaneo por cámara (`BarcodeDetector` cuando el navegador lo soporta).

## 4) Carga masiva a prueba de fallos

```bash
npm run importar -- ruta/productos.csv
npm run importar -- ruta/productos.xlsx          # requiere la dependencia xlsx (incluida)
npm run importar -- productos.csv --actualizar-stock
npm run importar -- --ayuda
```

Columnas: `nombre` y `precio` obligatorias; opcionales `costo, stock, stock_minimo,
categoria, subcategoria, unidad, codigo_interno, codigo_barra, activo`.
Acepta separador `;` o `,` y coma decimal (`1.234,56`).

**Validación por fila** (si falla una, se salta con advertencia en consola y sigue):
- nombre vacío → omitida
- precio no numérico o negativo → omitida
- `codigo_barra` repetido en el archivo o ajeno a otro producto → omitida

Resumen final: insertados / actualizados / omitidos. Desde la UI (Administración → CSV)
también podés descargar, editar en Excel e importar.

## Estructura

```
360max-comercios/
├─ package.json
├─ data/360max.db              # SQLite (se crea sola)
├─ src/
│  ├─ server.js                # Express + estáticos + error handler
│  ├─ db.js                    # esquema + migración codigo_barra + trigger nº de venta
│  ├─ middleware/auth.js       # cookie httpOnly, sesiones, roles
│  ├─ lib/claves.js            # scrypt (hash de contraseñas)
│  ├─ lib/csv.js               # parser CSV/Excel + importación validada
│  ├─ routes/  auth | productos | categorias | caja | ventas | stock | admin
│  └─ scripts/ importarProductos.js | sembrarDemo.js
└─ public/  index.html | estilo.css | app.js | caja.js | deposito.js | admin.js
```

## Roles

| Rol       | Caja | Depósito | Historial | Administración |
|-----------|------|----------|-----------|----------------|
| administrador     | ✔    | ✔        | ✔         | ✔              |
| caja      | ✔    | –        | ✔         | –              |
| deposito  | –    | ✔        | ✔         | –              |
