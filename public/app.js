'use strict';
/* 360MAX Comercios — núcleo: sesión, navegación, catálogo, historial. */

const $ = (s, c) => (c || document).querySelector(s);
const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
const bus = new EventTarget();
window.$ = $; window.$$ = $$; window.bus = bus;

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/[$\s]/g, '');
  if (!s) return null;
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  if (coma > -1 && punto > -1) {
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma > -1) {
    s = s.split(',').length > 2 ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cantidad = (n) => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 3 });
window.num = num; window.money = money; window.cantidad = cantidad;

let mensajeTimer = null;
function aviso(txt, tipo) {
  const el = $('#mensaje');
  el.textContent = txt || '';
  el.className = tipo || '';
  clearTimeout(mensajeTimer);
  if (txt) mensajeTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 5000);
}
window.aviso = aviso;

let sesion = null;
window.getSesion = () => sesion;

async function api(ruta, opciones) {
  const op = Object.assign({ method: 'GET', headers: {} }, opciones || {});
  if (op.body && typeof op.body !== 'string') {
    op.headers['Content-Type'] = 'application/json';
    op.body = JSON.stringify(op.body);
  }
  const r = await fetch(ruta, Object.assign({ credentials: 'same-origin' }, op));
  let datos = null;
  try { datos = await r.json(); } catch (e) { /* sin cuerpo */ }
  if (r.status === 401 && ruta !== '/api/auth/continuar' && ruta !== '/api/auth/yo') {
    salirUI(false);
    throw Object.assign(new Error((datos && datos.error) || 'Sesión expirada'), { status: 401 });
  }
  if (!r.ok) throw Object.assign(new Error((datos && datos.error) || ('Error ' + r.status)), { status: r.status, data: datos });
  return datos;
}
window.api = api;

/* ---------- Sesión / login / logout ---------- */
function mostrarLogin(primerUso) {
  $('#aplicacion').hidden = true;
  $('#acceso').hidden = false;
  $('#tituloAcceso').textContent = 'Ingresar';
  $('#salir').hidden = true;
  $('#sesionUsuario').hidden = true;
  sesion = null;
}

function salirUI(limpiarMensaje) {
  sesion = null;
  try { localStorage.removeItem('360max_sesion'); } catch (e) { /* noop */ }
  document.cookie = 'sid=; Max-Age=0; Path=/';
  $$('#main section, main > section').forEach((s) => { s.hidden = true; });
  $('#catalogo').hidden = false;
  mostrarLogin(false);
  const f = $('#login'); f.reset();
  if (limpiarMensaje !== false) aviso('Sesión cerrada correctamente. Hasta pronto 👋', 'ok');
}

async function entrar(usuario) {
  /* SUPERUSUARIO por nombre: el usuario "administrador" siempre es admin total,
     aunque la base vieja o el localStorage traigan otro rol. */
  if (usuario && String(usuario.usuario || '').trim().toLowerCase() === 'administrador') usuario.rol = 'administrador';
  else if (usuario) usuario.rol = normalizarRol(usuario.rol);
  sesion = usuario;
  $('#acceso').hidden = true;
  $('#aplicacion').hidden = false;
  try { localStorage.setItem('360max_sesion', JSON.stringify(usuario)); } catch (e) { /* noop */ }
  $('#salir').hidden = false;
  $('#sesionUsuario').hidden = false;
  $('#sesionUsuario').textContent = usuario.nombre + ' · ' + rolTexto(usuario.rol);
  $('#bienvenida').textContent = 'Hola, ' + usuario.nombre.split(' ')[0] + ' 👋';
  aplicarRoles(usuario.rol);
  aviso('', '');
  /* Blindaje: el login YA fue validado en el backend. Si el catálogo o la vista
     fallan por cualquier motivo, el usuario IGUAL entra (nunca queda trabado). */
  try { await cargarCatalogo(); } catch (e) { aviso('Entraste, pero no se pudo cargar el catálogo: ' + e.message, 'error'); }
  try { mostrarVista('catalogo'); } catch (e) { /* noop: la app ya quedó visible */ }
}

function esAdmin(rol) {
  const r = String(rol || '').trim().toLowerCase();
  return r === 'administrador' || r === 'administrador demo' || r === 'admin' || r === 'dueno' || r === 'dueño';
}

function normalizarRol(rol) {
  return esAdmin(rol) ? 'administrador' : String(rol || '').trim().toLowerCase();
}

function rolTexto(r) {
  return esAdmin(r) ? 'Administrador' : String(r || '').trim().toLowerCase() === 'caja' ? 'Caja' : 'Depósito';
}

function aplicarRoles(rol) {
  const r = normalizarRol(rol);
  sesion.rol = r; /* el superusuario queda fijado como administrador */
  if (esAdmin(r)) {
    /* SUPERUSUARIO: todo visible — Caja, Depósito, Administración, cierre, cobro */
    $$('.rol-caja, .rol-deposito, .administrador').forEach((e) => { e.hidden = false; });
    $$('#navPrincipal button').forEach((e) => { e.hidden = false; });
    return;
  }
  $$('.rol-caja').forEach((e) => { e.hidden = r !== 'caja'; });
  $$('.rol-deposito').forEach((e) => { e.hidden = r !== 'deposito'; });
  $$('.administrador').forEach((e) => { e.hidden = true; });
}
window.esAdmin = esAdmin;
window.normalizarRol = normalizarRol;

/* ---------- Navegación entre vistas ---------- */
function mostrarVista(nombre) {
  ['catalogo', 'pos', 'deposito', 'movimientos', 'gestion'].forEach((v) => {
    const s = document.getElementById(v);
    if (s) s.hidden = v !== nombre;
  });
  $$('#navPrincipal button').forEach((b) => b.classList.toggle('activo', b.dataset.vista === nombre));
  bus.dispatchEvent(new CustomEvent('vista', { detail: nombre }));
  if (nombre === 'movimientos') cargarHistorial();
}
window.mostrarVista = mostrarVista;

/* ---------- Catálogo (productos y stock) ---------- */
let productosCache = [];

async function cargarCatalogo() {
  productosCache = await api('/api/productos');
  pintarCatalogo('');
  await pintarIndicadores();
}

async function pintarIndicadores() {
  try {
    const i = await api('/api/indicadores');
    $('#indicadores').innerHTML = [
      ['Productos', i.productos, '📦'],
      ['Stock bajo', i.bajo_minimo, '⚠️'],
      ['Valor stock', money(i.stock_valor), '💰'],
      ['Ventas hoy', money(i.ventas_hoy), '🧾']
    ].map(([t, v, ic]) => `<div class="indicador"><span>${ic}</span><strong>${v}</strong><small>${t}</small></div>`).join('');
  } catch (e) { /* indicadores opcionales */ }
}

function tarjetaCatalogo(p) {
  const bajo = p.stock <= p.stock_minimo;
  return `
    <div class="producto ${bajo ? 'bajo' : ''}">
      <div class="producto-datos">
        <strong>${esc(p.nombre)}</strong>
        <small>${esc(p.categoria || 'Sin categoría')} · ${esc(p.unidad)}
          ${p.codigo_barra ? ' · 🏷️ ' + esc(p.codigo_barra) : ''}</small>
      </div>
      <div class="producto-nums">
        <b>${money(p.precio)}</b>
        <small class="${bajo ? 'alerta' : ''}">Quedan: ${cantidad(p.stock)}</small>
      </div>
    </div>`;
}

/* Catálogo AGRUPADO POR CATEGORÍA: el mismo orden que la góndola, para que el
   repositor recorra la lista como recorre el salón y no un amontonamiento
   alfabético de todos los rubros mezclados. */
function pintarCatalogo(filtro) {
  const q = (filtro || '').trim().toLowerCase();
  const lista = productosCache.filter((p) =>
    !q || p.nombre.toLowerCase().includes(q) ||
    (p.codigo_interno || '').toLowerCase().includes(q) ||
    (p.codigo_barra || '').toLowerCase().includes(q)
  );
  if (!lista.length) {
    $('#lista').innerHTML = '<p class="ayuda">No se encontraron productos.</p>';
    return;
  }
  const grupos = new Map();
  for (const p of lista) {
    const cat = p.categoria || 'Sin categoría';
    if (!grupos.has(cat)) grupos.set(cat, []);
    grupos.get(cat).push(p);
  }
  const secciones = [...grupos.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  $('#lista').innerHTML = secciones.map(([cat, ps]) => `
    <div class="grupo-cat">
      <h3>${esc(cat)} · ${ps.length}</h3>
      <div class="productos">${ps.map(tarjetaCatalogo).join('')}</div>
    </div>`).join('');
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
window.esc = esc;

/* ---------- Historial de stock ---------- */
async function cargarHistorial() {
  try {
    const movs = await api('/api/movimientos?limite=200');
    $('#historial').innerHTML = tablaMovimientos(movs);
  } catch (e) { $('#historial').innerHTML = `<p class="ayuda">${esc(e.message)}</p>`; }
}

function tablaMovimientos(movs) {
  if (!movs.length) return '<p class="ayuda">Todavía no hay movimientos.</p>';
  return `<table class="tabla"><thead><tr>
    <th>Fecha</th><th>Producto</th><th>Tipo</th><th>Cantidad</th><th>Stock</th><th>Motivo / referencia</th><th>Usuario</th>
  </tr></thead><tbody>` + movs.map((m) => `<tr>
    <td>${esc(m.fecha)}</td>
    <td>${esc(m.producto)}</td>
    <td><span class="pila pila-${esc(m.tipo)}">${esc(m.tipo)}</span></td>
    <td>${cantidad(m.cantidad)}</td>
    <td>${cantidad(m.stock_despues)}</td>
    <td>${esc(m.motivo || m.referencia || '—')}</td>
    <td>${esc(m.usuario || '—')}</td>
  </tr>`).join('') + '</tbody></table>';
}
window.tablaMovimientos = tablaMovimientos;

/* ---------- Eventos del núcleo ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  $('#login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const cuerpo = { usuario: fd.get('usuario').trim().toLowerCase(), clave: fd.get('clave') };
    try {
      const r = await api('/api/auth/continuar', { method: 'POST', body: cuerpo });
      ev.target.reset();
      await entrar(r.usuario);
      aviso(r.mensaje || '¡Bienvenido!', 'ok');
    } catch (e) { aviso(e.message, 'error'); }
  });

  $('#salir').addEventListener('click', async () => {
    if (!confirm('¿Cerrar sesión? Se limpiará la sesión actual.')) return;
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* la cookie se limpia igual */}
    salirUI(true);
  });

  $$('#navPrincipal button').forEach((b) =>
    b.addEventListener('click', () => mostrarVista(b.dataset.vista)));

  $('#buscar').addEventListener('input', (ev) => pintarCatalogo(ev.target.value));

  /* Arranque: ¿primer uso o sesión existente? */
  try {
    const estado = await api('/api/auth/estado');
    if (estado.primer_uso) { mostrarLogin(true); return; }
    const yo = await api('/api/auth/yo');
    await entrar(yo);
  } catch (e) {
    mostrarLogin(false);
    if (e.status !== 401) aviso('No se pudo conectar con el servidor.', 'error');
  }
});



