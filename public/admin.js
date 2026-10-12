'use strict';
/*
  Vista de Administración: productos, categorías, usuarios,
  arqueos, precios masivos, CSV y cuentas corrientes.
*/
document.addEventListener('DOMContentLoaded', () => {
  let categorias = [];
  let productosGestion = [];   /* caché para el buscador de precios */

  /* Texto legible del origen del precio efectivo que devuelve la API. */
  function origenTexto(origen) {
    return origen === 'fijo' ? 'fijo (manual)'
      : origen === 'margen' ? 'por margen del rubro'
        : 'precio base';
  }

  /* ---------- Utilidades de selects ---------- */
  function llenarCategorias() {
    const opciones = categorias.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
    ['#categoriaProducto', '#categoriaSub', '#catPrecios'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const extra = sel === '#catPrecios' ? '<option value="">Todas las categorías</option>' : '';
      const prev = el.value;
      el.innerHTML = extra + opciones;
      if (prev) el.value = prev;
    });
    llenarSubcategorias();
    pintarArbol();
  }

  function llenarSubcategorias() {
    const catId = document.querySelector('#categoriaProducto').value;
    const cat = categorias.find((c) => String(c.id) === String(catId));
    const subs = cat ? cat.subcategorias : [];
    const el = document.querySelector('#subcategoriaProducto');
    const prev = el.value;
    el.innerHTML = '<option value="">(ninguna)</option>' +
      subs.map((s) => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
    if (prev) el.value = prev;
  }

  function pintarArbol() {
    document.querySelector('#arbol').innerHTML = '<ul>' + categorias.map((c) => `
      <li class="categoria-n">📁 ${esc(c.nombre)}
        <ul>${c.subcategorias.map((s) => `<li class="sub">└ ${esc(s.nombre)}</li>`).join('') || '<li class="sub">—</li>'}</ul>
      </li>`).join('') + '</ul>';
  }

  /* ---------- Lista de productos (clic para editar) ---------- */
  async function pintarProductos() {
    productosGestion = await api('/api/productos?inactivos=1');
    document.querySelector('#gestionLista').innerHTML = productosGestion.map((p) => `
      <div class="producto" data-id="${p.id}" title="Clic para editar">
        <div class="producto-datos">
          <strong>${esc(p.nombre)} ${p.activo ? '' : '· <em>inactivo</em>'}</strong>
          <small>${esc(p.categoria || 'Sin categoría')}${p.codigo_barra ? ' · 🏷️ ' + esc(p.codigo_barra) : ''}</small>
        </div>
        <div class="producto-nums">
          <b>${money(p.precio)}</b>
          <button type="button" class="peligro mini" data-borrar="${p.id}">Borrar</button>
        </div>
      </div>`).join('');

    document.querySelectorAll('#gestionLista .producto').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.dataset.borrar) return;
        editarProducto(Number(el.dataset.id));
      });
    });
    document.querySelectorAll('#gestionLista [data-borrar]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.borrar;
        if (!confirm('¿Dar de baja este producto? (conserva histórico)')) return;
        try { await api('/api/productos/' + id, { method: 'DELETE' }); aviso('Producto dado de baja.', 'ok'); pintarProductos(); }
        catch (e) { aviso(e.message, 'error'); }
      });
    });
  }

  async function editarProducto(id) {
    const p = (await api('/api/productos?inactivos=1')).find((x) => x.id === id);
    if (!p) return;
    mostrarVista('gestion');
    const f = document.querySelector('#producto');
    f.querySelector('[name="id"]').value = p.id;
    f.nombre.value = p.nombre;
    f.categoria_id.value = p.categoria_id || '';
    llenarSubcategorias();
    f.subcategoria_id.value = p.subcategoria_id || '';
    f.unidad.value = p.unidad;
    f.codigo_interno.value = p.codigo_interno || '';
    f.codigo_barra.value = p.codigo_barra || '';
    f.costo.value = String(p.costo).replace('.', ',');
    /* «precio» de la API es el efectivo; para editar se parte del precio BASE
       (el guardado) y del precio fijo individual si lo tuviera. */
    f.precio.value = String(p.precio_base !== undefined ? p.precio_base : p.precio).replace('.', ',');
    f.precio_fijo.value = p.precio_fijo_centavos ? String(p.precio_fijo_centavos / 100).replace('.', ',') : '';
    f.stock_inicial.value = '0';
    f.stock_inicial.disabled = true;
    f.stock_minimo.value = String(p.stock_minimo).replace('.', ',');
    f.variantes.value = p.variantes || '';
    f.activo.checked = !!p.activo;
    document.querySelector('#tituloProducto').textContent =
      'Editar producto (quedan: ' + cantidad(p.stock) + ' · precio ' + origenTexto(p.precio_origen) + ')';
    f.scrollIntoView({ behavior: 'smooth' });
  }

  /* ---------- Formulario de producto ---------- */
  const formProducto = document.querySelector('#producto');
  document.querySelector('#categoriaProducto').addEventListener('change', llenarSubcategorias);
  document.querySelector('#nuevo').addEventListener('click', () => {
    formProducto.reset();
    formProducto.querySelector('[name="id"]').value = '';
    formProducto.stock_inicial.disabled = false;
    document.querySelector('#tituloProducto').textContent = 'Nuevo producto';
  });

  formProducto.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(formProducto);
    const editando = fd.get('id');
    const cuerpo = {
      nombre: fd.get('nombre'),
      categoria_id: fd.get('categoria_id') || null,
      subcategoria_id: fd.get('subcategoria_id') || null,
      unidad: fd.get('unidad'),
      codigo_interno: fd.get('codigo_interno'),
      codigo_barra: fd.get('codigo_barra'),
      costo: num(fd.get('costo')) ?? 0,
      precio: num(fd.get('precio')),
      precio_fijo: num(fd.get('precio_fijo')),
      stock_minimo: num(fd.get('stock_minimo')) ?? 0,
      variantes: fd.get('variantes'),
      activo: fd.get('activo') === 'on'
    };
    if (cuerpo.precio === null) return aviso('Precio inválido.', 'error');
    try {
      if (editando) {
        await api('/api/productos/' + editando, { method: 'PUT', body: cuerpo });
        aviso('✓ Producto actualizado.', 'ok');
      } else {
        cuerpo.stock_inicial = num(fd.get('stock_inicial')) ?? 0;
        await api('/api/productos', { method: 'POST', body: cuerpo });
        aviso('✓ Producto creado con stock inicial.', 'ok');
      }
      formProducto.reset();
      formProducto.querySelector('[name="id"]').value = '';
      formProducto.stock_inicial.disabled = false;
      document.querySelector('#tituloProducto').textContent = 'Nuevo producto';
      await pintarProductos();
      await recargarCategorias();
    } catch (e) { aviso(e.message, 'error'); }
  });

  /* ---------- Categorías / subcategorías ---------- */
  async function recargarCategorias() {
    categorias = await api('/api/categorias');
    llenarCategorias();
  }

  document.querySelector('#categoria').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/categorias', { method: 'POST', body: { nombre: new FormData(ev.target).get('nombre') } });
      ev.target.reset();
      aviso('Categoría creada.', 'ok');
      await recargarCategorias();
    } catch (e) { aviso(e.message, 'error'); }
  });

  document.querySelector('#subcategoria').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('/api/subcategorias', { method: 'POST', body: { categoria_id: fd.get('categoria_id'), nombre: fd.get('nombre') } });
      ev.target.reset();
      aviso('Subcategoría creada.', 'ok');
      await recargarCategorias();
    } catch (e) { aviso(e.message, 'error'); }
  });

  /* ---------- Usuarios ---------- */
  async function pintarUsuarios() {
    try {
      const us = await api('/api/usuarios');
      document.querySelector('#usuarios').innerHTML = us.map((u) => `
        <div class="usuario-fila">
          <span><strong>${esc(u.nombre)}</strong> · @${esc(u.usuario)} · ${esc(u.rol)} ${u.activo ? '' : '· <b>inactivo</b>'}</span>
          <button type="button" class="mini ${u.activo ? 'peligro' : 'secundario'}" data-uid="${u.id}" data-act="${u.activo ? 0 : 1}">
            ${u.activo ? 'Desactivar' : 'Activar'}
          </button>
        </div>`).join('');
      document.querySelectorAll('#usuarios [data-uid]').forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            await api('/api/usuarios/' + b.dataset.uid, { method: 'PUT', body: { activo: b.dataset.act === '1' } });
            aviso('Usuario actualizado.', 'ok');
            pintarUsuarios();
          } catch (e) { aviso(e.message, 'error'); }
        });
      });
    } catch (e) { /* sin permisos */ }
  }

  document.querySelector('#usuario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('/api/usuarios', { method: 'POST', body: {
        nombre: fd.get('nombre'), usuario: fd.get('usuario'), rol: fd.get('rol'), clave: fd.get('clave')
      } });
      ev.target.reset();
      aviso('✓ Usuario creado.', 'ok');
      pintarUsuarios();
    } catch (e) { aviso(e.message, 'error'); }
  });

  /* ---------- Arqueos históricos ---------- */
  async function pintarArqueos(desde, hasta) {
    const q = new URLSearchParams();
    if (desde) q.set('desde', desde);
    if (hasta) q.set('hasta', hasta);
    const lista = await api('/api/arqueos?' + q.toString());
    document.querySelector('#arqLista').innerHTML = lista.length ? lista.map((a) => `
      <div class="arq-fila">
        <span>${esc(a.fecha_cierre || a.fecha)} · <strong>${esc(a.caja)}</strong> · ${esc(a.usuario)}</span>
        <span>Esperado ${money(a.esperado)} / Contado ${money(a.contado)}
          <b class="${a.diferencia === 0 ? 'saldo-haber' : 'saldo-debe'}">(${money(a.diferencia)})</b></span>
        <span><button type="button" class="mini secundario" data-imprimir="${a.id}"
          title="Imprimir el reporte de este cierre" aria-label="Imprimir reporte del cierre">🖨️</button></span>
      </div>`).join('') : '<p class="ayuda">Sin arqueos en el período.</p>';
    document.querySelectorAll('#arqLista [data-imprimir]').forEach((b) =>
      b.addEventListener('click', () => imprimirArqueo(Number(b.dataset.imprimir))));
  }
  document.querySelector('#arqFiltros').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    pintarArqueos(fd.get('desde'), fd.get('hasta')).catch((e) => aviso(e.message, 'error'));
  });

  /* ---------- Precios masivos y CSV ---------- */
  document.querySelector('#preciosMasivo').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const pct = num(fd.get('porcentaje'));
    if (pct === null || pct === 0) return aviso('Escriba un porcentaje distinto de cero.', 'error');
    if (!confirm(`¿Aplicar ${pct}% a los precios${fd.get('categoria_id') ? ' de la categoría' : ' (todas)'}?`)) return;
    try {
      const r = await api('/api/precios/masivo', { method: 'POST', body: {
        categoria_id: fd.get('categoria_id') || null, porcentaje: pct, redondeo: fd.get('redondeo')
      } });
      aviso(`✓ ${r.modificados} precio(s) actualizados.`, 'ok');
      ev.target.reset();
    } catch (e) { aviso(e.message, 'error'); }
  });

  let csvTexto = '';
  document.querySelector('#csvArchivo').addEventListener('change', (ev) => {
    const archivo = ev.target.files[0];
    if (!archivo) return;
    const lector = new FileReader();
    lector.onload = () => { csvTexto = lector.result; document.querySelector('#csvResultado').textContent = 'Archivo listo: ' + archivo.name; };
    lector.readAsText(archivo, 'utf-8');
  });
  document.querySelector('#csvImportar').addEventListener('click', async () => {
    if (!csvTexto) return aviso('Elegí un archivo CSV primero.', 'error');
    try {
      const r = await api('/api/productos/importar', { method: 'POST', body: { texto: csvTexto } });
      const partes = [`✓ Insertados: ${r.insertados}`, `Actualizados: ${r.actualizados}`, `Omitidos: ${r.omitidos}`];
      document.querySelector('#csvResultado').innerHTML = partes.join(' · ') +
        (r.advertencias.length ? '<br>' + r.advertencias.map(esc).join('<br>') : '');
      aviso('Importación finalizada.', r.omitidos ? 'error' : 'ok');
      await pintarProductos();
    } catch (e) { aviso(e.message, 'error'); }
  });

  /* ---------- Precios: margen por rubro y precio fijo individual ---------- */
  function pintarMargenes() {
    document.querySelector('#margenesLista').innerHTML = categorias.length
      ? categorias.map((c) => `
        <div class="margen-fila" data-cat="${c.id}">
          <span><strong>${esc(c.nombre)}</strong></span>
          <span>
            <input type="number" min="0" max="1000" step="1" value="${Number(c.margen_ganancia_defecto) || 0}" aria-label="Margen de ${esc(c.nombre)}"> %
            <button type="button" class="mini" data-margen="${c.id}">Guardar</button>
          </span>
        </div>`).join('')
      : '<p class="ayuda">Sin categorías cargadas.</p>';

    document.querySelectorAll('#margenesLista [data-margen]').forEach((b) => {
      b.addEventListener('click', async () => {
        const fila = b.closest('.margen-fila');
        const valor = num(fila.querySelector('input').value);
        if (valor === null || valor < 0 || valor > 1000) return aviso('El margen va de 0 a 1000 %.', 'error');
        try {
          await api('/api/categorias/' + b.dataset.margen + '/margen',
            { method: 'PUT', body: { margen_ganancia_defecto: Math.round(valor) } });
          aviso('✓ Margen actualizado.', 'ok');
          await recargarCategorias();
        } catch (e) { aviso(e.message, 'error'); }
      });
    });
  }

  function filaPrecio(p) {
    const origen = p.precio_origen || 'base';
    return `
      <div class="precio-item" data-pid="${p.id}">
        <div class="precio-cab">
          <span><strong>${esc(p.nombre)}</strong><br>
            <small>${esc(p.categoria || 'Sin categoría')}${p.codigo_barra ? ' · 🏷️ ' + esc(p.codigo_barra) : ''}</small></span>
          <span>Precio efectivo: <b>${money(p.precio)}</b><br>
            <small class="precio-origen ${origen}">${esc(origenTexto(origen))}</small></span>
        </div>
        <div class="precio-campos">
          <label>Costo<input type="text" inputmode="decimal" data-costo value="${String(p.costo).replace('.', ',')}"></label>
          <label>Precio fijo<input type="text" inputmode="decimal" data-fijo value="${p.precio_fijo_centavos ? String(p.precio_fijo_centavos / 100).replace('.', ',') : ''}" placeholder="vacío = margen"></label>
          <button type="button" class="mini" data-guardar>Guardar</button>
          <button type="button" class="mini secundario" data-quitar>Quitar fijo</button>
        </div>
      </div>`;
  }

  function pintarPrecios(filtro) {
    const q = String(filtro || '').trim().toLowerCase();
    const lista = productosGestion.filter((p) => !q ||
      p.nombre.toLowerCase().includes(q) ||
      (p.codigo_barra || '').toLowerCase().includes(q) ||
      (p.codigo_interno || '').toLowerCase().includes(q));
    const cont = document.querySelector('#precioResultados');
    if (!lista.length) { cont.innerHTML = '<p class="ayuda">Sin coincidencias.</p>'; return; }
    cont.innerHTML = lista.slice(0, 40).map(filaPrecio).join('') +
      (lista.length > 40 ? `<p class="ayuda">…y ${lista.length - 40} más. Afine la búsqueda.</p>` : '');
    cont.querySelectorAll('[data-guardar]').forEach((b) =>
      b.addEventListener('click', () => guardarPrecio(b.closest('.precio-item'), false)));
    cont.querySelectorAll('[data-quitar]').forEach((b) =>
      b.addEventListener('click', () => guardarPrecio(b.closest('.precio-item'), true)));
  }

  async function guardarPrecio(item, quitarFijo) {
    const id = item.dataset.pid;
    const costo = num(item.querySelector('[data-costo]').value);
    const fijo = quitarFijo ? null : num(item.querySelector('[data-fijo]').value);
    if (costo === null || costo < 0) return aviso('Costo inválido.', 'error');
    try {
      const r = await api('/api/admin/productos/' + id + '/precio',
        { method: 'PUT', body: { costo, precio_fijo: fijo } });
      aviso('✓ Precio actualizado: ' + money(r.precio) + ' (' + origenTexto(r.precio_origen) + ')', 'ok');
      await pintarProductos();
      pintarPrecios(document.querySelector('#precioBuscar').value);
    } catch (e) { aviso(e.message, 'error'); }
  }

  document.querySelector('#precioBuscar').addEventListener('input', (ev) => pintarPrecios(ev.target.value));

  /* ---------- Cuentas corrientes ---------- */
  async function pintarCtas() {
    try {
      const clientes = await api('/api/clientes');
      document.querySelector('#ctasLista').innerHTML = clientes.length ? clientes.map((c) => `
        <div class="cta-fila">
          <span><strong>${esc(c.nombre)}</strong>${c.telefono ? ' · ' + esc(c.telefono) : ''}</span>
          <span class="${c.saldo > 0 ? 'saldo-debe' : 'saldo-haber'}">Saldo ${money(c.saldo)}</span>
        </div>`).join('') : '<p class="ayuda">Sin clientes registrados.</p>';
    } catch (e) { /* opcional */ }
  }

  /* ---------- Ventas pasadas (historial para administración) ---------- */
  async function pintarVentasPasadas(desde, hasta) {
    const q = new URLSearchParams();
    q.set('historial', '1');
    if (desde) q.set('desde', desde);
    if (hasta) q.set('hasta', hasta);
    const lista = await api('/api/ventas?' + q.toString());
    const completadas = lista.filter((v) => v.estado === 'completada');
    const total = completadas.reduce((a, v) => a + Number(v.total || 0), 0);
    document.querySelector('#vpResumen').textContent = lista.length
      ? `${lista.length} venta(s) · total ${money(total)}`
      : '';
    document.querySelector('#vpTabla').innerHTML = lista.length ? `
      <table class="tabla vp-tabla">
        <thead><tr>
          <th>N°</th><th>Fecha</th><th>Cajero</th><th>Cliente</th><th>Ítems</th><th>Medio de pago</th><th>Estado</th><th>Total</th>
        </tr></thead>
        <tbody>${lista.map((v) => `
          <tr>
            <td><strong>#${v.numero}</strong></td>
            <td>${esc(v.fecha)}</td>
            <td>${esc(v.cajero)}</td>
            <td>${esc(v.cliente || '—')}</td>
            <td>${cantidad(v.items_n)}</td>
            <td>${esc(v.pagos || '—')}</td>
            <td>${v.estado === 'completada' ? 'Completada' : '<strong class="saldo-debe">Anulada</strong>'}</td>
            <td class="vp-total">${money(v.total)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
      : '<p class="ayuda">No hay ventas en el rango elegido.</p>';
  }

  document.querySelector('#vpBoton').addEventListener('click', () => {
    const tarjeta = document.querySelector('#tarjetaVentas');
    tarjeta.hidden = !tarjeta.hidden;
    if (!tarjeta.hidden) pintarVentasPasadas('', '').catch((e) => aviso(e.message, 'error'));
  });
  document.querySelector('#vpFiltros').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    pintarVentasPasadas(fd.get('desde'), fd.get('hasta')).catch((e) => aviso(e.message, 'error'));
  });
  document.querySelector('#vpTodas').addEventListener('click', () => {
    document.querySelector('#vpFiltros').reset();
    pintarVentasPasadas('', '').catch((e) => aviso(e.message, 'error'));
  });

  /* ---------- Impresión del reporte de un cierre (arqueo) ---------- */
  function reporteArqueo(a) {
    const dif = Number(a.diferencia || 0);
    const claseDif = dif === 0 ? 'rp-sobra' : 'rp-falta';
    const pagos = (a.pagos && a.pagos.length) ? `
      <h2>Medios de pago</h2>
      <table class="rp-tabla"><thead><tr><th>Medio</th><th>Monto</th></tr></thead><tbody>
        ${a.pagos.map((p) => `<tr><td>${esc(p.medio)}</td><td class="rp-num">${money(p.monto)}</td></tr>`).join('')}
      </tbody></table>` : '';
    const movs = (a.movimientos && a.movimientos.length) ? `
      <h2>Movimientos de efectivo</h2>
      <table class="rp-tabla"><thead><tr><th>Fecha</th><th>Tipo</th><th>Motivo</th><th>Importe</th></tr></thead><tbody>
        ${a.movimientos.map((m) => `<tr><td>${esc(m.fecha)}</td><td>${esc(m.tipo)}</td><td>${esc(m.motivo)}</td>
          <td class="rp-num">${m.tipo === 'egreso' ? '−' : '+'}${money(m.importe)}</td></tr>`).join('')}
      </tbody></table>` : '';
    return `
      <h1>360MAX COMERCIOS — REPORTE DE CIERRE DE CAJA</h1>
      <p><strong>Caja:</strong> ${esc(a.caja)}</p>
      <p><strong>Fecha del cierre:</strong> ${esc(a.fecha_cierre || a.fecha)}</p>
      <p><strong>Apertura del turno:</strong> ${esc(a.fecha_apertura)}</p>
      <p><strong>Cajero:</strong> ${esc(a.usuario)}${a.cierre_usuario ? ` · <strong>Cerró:</strong> ${esc(a.cierre_usuario)}` : ''}</p>
      <h2>Totales</h2>
      <table class="rp-tabla"><tbody>
        <tr><td>Fondo inicial</td><td class="rp-num">${money(a.fondo)}</td></tr>
        <tr><td>Ventas del turno (${a.ventas ? cantidad(a.ventas.n) : 0})</td><td class="rp-num">${money(a.ventas ? a.ventas.t : 0)}</td></tr>
        <tr><td><strong>Efectivo esperado</strong></td><td class="rp-num rp-total">${money(a.esperado)}</td></tr>
        <tr><td><strong>Efectivo contado</strong></td><td class="rp-num rp-total">${money(a.contado)}</td></tr>
        <tr><td><strong>Diferencia</strong></td><td class="rp-num rp-total ${claseDif}">${money(dif)}</td></tr>
      </tbody></table>
      ${pagos}
      ${movs}
      <p><strong>Observaciones:</strong> ${esc(a.observaciones || '—')}</p>
      <p class="rp-pie">Impreso el ${new Date().toLocaleString('es-AR')} · 360MAX Comercios</p>`;
  }

  async function imprimirArqueo(id) {
    try {
      const a = await api('/api/arqueos/' + id);
      const rep = document.querySelector('#reporteImpresion');
      rep.innerHTML = reporteArqueo(a);
      const limpiar = () => { rep.innerHTML = ''; window.removeEventListener('afterprint', limpiar); };
      window.addEventListener('afterprint', limpiar);
      window.print();
      setTimeout(limpiar, 3000);   /* red de seguridad si el navegador no dispara afterprint */
    } catch (e) { aviso(e.message, 'error'); }
  }

  /* ---------- Espejo del local (control remoto de Agustín) ---------- */
  let espejoTimer = null;

  async function pintarEspejo() {
    const cont = document.querySelector('#espejoContenido');
    if (!cont) return;
    try {
      const d = await api('/api/admin/espejo');
      const t = d.turno;

      const estadoTurno = t ? `
        <div class="espejo-bloque">
          <h3>Turno abierto</h3>
          <div class="espejo-par"><span>Caja</span><b>${esc(t.caja)}</b></div>
          <div class="espejo-par"><span>Cajero</span><b>${esc(t.usuario)}</b></div>
          <div class="espejo-par"><span>Abierto</span><b>${esc(t.fecha_apertura)}</b></div>
          <div class="espejo-par"><span>Fondo inicial</span><b>${money((t.fondo_centavos || 0) / 100)}</b></div>
          <div class="espejo-par"><span>Ventas del turno</span><b>${cantidad(t.ventas_n)} · ${money(t.ventas_total)}</b></div>
          ${(t.pagos && t.pagos.length) ? '<h3>Medios de pago</h3>' + t.pagos.map((p) =>
            `<div class="espejo-par"><span>${esc(p.medio)}</span><b>${money(p.monto)}</b></div>`).join('') : ''}
          ${(t.movimientos && t.movimientos.length) ? '<h3>Movimientos de caja</h3>' + t.movimientos.map((m) =>
            `<div class="espejo-par"><span>${esc(m.tipo)} · ${esc(m.motivo)}</span><b>${m.tipo === 'egreso' ? '−' : '+'}${money(m.importe)}</b></div>`).join('') : ''}
        </div>`
        : '<div class="espejo-bloque"><h3>Turno abierto</h3><p class="ayuda">No hay caja abierta en el local.</p></div>';

      const bajo = d.stock_bajo.length ? `
        <div class="espejo-bloque">
          <h3>Stock bajo (${d.stock_bajo.length})</h3>
          ${d.stock_bajo.slice(0, 12).map((p) => `
            <div class="espejo-par"><span>${esc(p.nombre)}<small class="ayuda"> · ${esc(p.categoria)}</small></span>
              <b class="saldo-debe">${cantidad(p.stock)} / min ${cantidad(p.stock_minimo)}</b></div>`).join('')}
          ${d.stock_bajo.length > 12 ? `<p class="ayuda">…y ${d.stock_bajo.length - 12} más.</p>` : ''}
        </div>`
        : '<div class="espejo-bloque"><h3>Stock bajo</h3><p class="ayuda">Todo por encima del mínimo.</p></div>';

      const ventas = d.ventas_recientes.length ? `
        <div class="espejo-bloque espejo-ancho">
          <h3>Últimas ventas</h3>
          <table class="tabla"><thead><tr><th>N°</th><th>Fecha</th><th>Cajero</th><th>Estado</th><th>Total</th></tr></thead>
          <tbody>${d.ventas_recientes.map((v) => `<tr>
            <td><strong>#${v.numero}</strong></td><td>${esc(v.fecha)}</td><td>${esc(v.cajero)}</td>
            <td>${v.estado === 'completada' ? 'Completada' : '<b class="saldo-debe">Anulada</b>'}</td>
            <td><b>${money(v.total)}</b></td></tr>`).join('')}</tbody></table>
        </div>` : '';

      cont.innerHTML = `
        <div class="espejo-resumen">
          <div class="espejo-indicador"><small>VENTAS DE HOY</small><strong>${money(d.hoy.ventas_total)}</strong><span>${cantidad(d.hoy.ventas_n)} venta(s)</span></div>
          <div class="espejo-indicador"><small>ÚLTIMA LECTURA</small><strong>${esc(new Date(d.generado).toLocaleTimeString('es-AR'))}</strong><span>refresco automático</span></div>
        </div>
        <div class="espejo-grilla">${estadoTurno}${bajo}${ventas}</div>`;
    } catch (e) {
      cont.innerHTML = `<p class="ayuda">No se pudo leer el espejo: ${esc(e.message)}</p>`;
    }
  }

  document.querySelector('#espejoRefrescar').addEventListener('click', () => {
    pintarEspejo().then(() => aviso('Espejo actualizado.', 'ok')).catch((e) => aviso(e.message, 'error'));
  });
  /* Refresco automático cada minuto, pero solo si Administración está a la vista. */
  if (espejoTimer) clearInterval(espejoTimer);
  espejoTimer = setInterval(() => {
    const vista = document.querySelector('#gestion');
    if (vista && !vista.hidden) pintarEspejo().catch(() => {});
  }, 60000);

  /* ---------- Al entrar a Administración ---------- */
  bus.addEventListener('vista', (ev) => {
    if (ev.detail !== 'gestion') return;
    recargarCategorias()
      .then(() => { pintarMargenes(); })
      .then(() => pintarProductos())
      .then(() => { pintarPrecios(document.querySelector('#precioBuscar').value); })
      .then(() => pintarUsuarios())
      .then(() => pintarArqueos('', ''))
      .then(() => pintarCtas())
      .then(() => pintarEspejo())
      .catch((e) => aviso(e.message, 'error'));
  });
});


