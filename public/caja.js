'use strict';
/*
  CAJA (POS): escáner USB con foco automático, chips de categoráas,
  carrito, cobro completo con ticket tí©rmico e impresií³n nativa.
*/
document.addEventListener('DOMContentLoaded', () => {
  /* ---------- Estado ---------- */
  let productos = [];
  let catActiva = 'todas';
  let carrito = [];            // {id, nombre, precio, cantidad, unidad}
  let turno = null;
  let ultimaVenta = null;
  let ventaDevolver = null;
  let streamCamara = null;      // MediaStream activo del escáner por cámara
  let detectorCodigos = null;   // BarcodeDetector nativo, si el navegador lo trae

  const q = (s) => document.querySelector(s);
  const MODALES = ['#modalCobro', '#modalTicket', '#modalDevolucion', '#modalAnulacion', '#modalCamara'];

  function ocultarModales() {
    q('#modalFondo').hidden = true;
    MODALES.forEach((m) => { q(m).hidden = true; });
    if (streamCamara) cerrarCamara();   /* ninguna cámara queda encendida */
    enfocarEscanner();
  }
  function mostrarModal(sel) {
    q('#modalFondo').hidden = false;
    MODALES.forEach((m) => { q(m).hidden = m !== sel; });
  }

  /* =========================================================
     1) FOCO PERMANENTE DEL LECTOR USB (input #posBuscar)
     ========================================================= */
  function escannerListo() {
    return !q('#pos').hidden && !q('#posPrincipal').hidden && !q('#posVender').hidden &&
      q('#modalFondo').hidden;
  }
  function enfocarEscanner() {
    if (escannerListo()) q('#posBuscar').focus();
  }
  /* Si el usuario toca cualquier lado de la Caja, el foco vuelve al escáner. */
  document.addEventListener('click', (ev) => {
    if (!escannerListo()) return;
    if (ev.target.closest('input, select, textarea, button, a')) return;
    enfocarEscanner();
  });
  window.addEventListener('focus', enfocarEscanner);

  /* =========================================================
     2) PESTAí‘AS DEL POS + ESTADO DEL TURNO
     ========================================================= */
  document.querySelectorAll('#posTabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#posTabs button').forEach((x) => x.classList.toggle('activo', x === b));
      const mapa = { vender: '#posVender', arqueo: '#posArqueo', devoluciones: '#posDevoluciones', clientes: '#posClientes' };
      Object.entries(mapa).forEach(([k, sel]) => { q(sel).hidden = k !== b.dataset.tab; });
      if (b.dataset.tab === 'arqueo') cargarArqueo();
      if (b.dataset.tab === 'devoluciones') cargarVentasTurno();
      if (b.dataset.tab === 'clientes') cargarClientes();
      enfocarEscanner();
    });
  });

  async function refrescarTurno() {
    const r = await api('/api/caja/estado');
    turno = r.turno;
    if (!turno) {
      q('#apertura').hidden = false;
      q('#posPrincipal').hidden = true;
      const ses = getSesion();
      q('#aperturaUsuario').textContent = ses ? ses.nombre : 'â€”';
      q('#aperturaFecha').textContent = new Date().toLocaleString('es-AR');
      q('#aperturaCierre').textContent = r.cierreíanterior
        ? `${r.cierreíanterior.caja} á ${r.cierreíanterior.fechaícierre} á ${money(r.cierreíanterior.contado)}`
        : 'â€”';
      const cajas = await api('/api/cajas');
      q('#aperturaCaja').innerHTML = cajas.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
    } else {
      q('#apertura').hidden = true;
      q('#posPrincipal').hidden = false;
      pintarEstadoTurno();
      enfocarEscanner();
    }
  }

  function pintarEstadoTurno() {
    q('#posEstado').innerHTML = `
      <span class="dato"><small>Caja</small><b>${esc(turno.caja)}</b></span>
      <span class="dato"><small>Cajero</small><b>${esc(turno.usuario)}</b></span>
      <span class="dato"><small>Desde</small><b>${esc(turno.fechaíapertura)}</b></span>
      <span class="dato"><small>Fondo</small><b>${money(turno.fondo)}</b></span>
      <span class="dato"><small>Ventas</small><b>${turno.ventasín} á ${money(turno.ventasítotal)}</b></span>`;
  }

  q('#formApertura').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('/api/caja/apertura', { method: 'POST', body: { cajaíid: fd.get('cajaíid'), fondo: num(fd.get('fondo')) ?? 0 } });
      aviso('âœ“ Caja abierta. áListo para vender!', 'ok');
      ev.target.reset();
      await refrescarTurno();
    } catch (e) { aviso(e.message, 'error'); }
  });

  /* =========================================================
     3) PRODUCTOS AGRUPADOS POR CATEGORíA (chips + secciones)
     ========================================================= */
  async function recargarProductos() {
    productos = await api('/api/productos');
    pintarChips();
    pintarGrilla();
  }

  function grupos() {
    const g = new Map();
    for (const p of productos) {
      const cat = p.categoria || 'Sin categoráa';
      if (!g.has(cat)) g.set(cat, []);
      g.get(cat).push(p);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  }

  function pintarChips() {
    const todos = grupos();
    const nombres = ['todas', ...todos.map((t) => t[0])];
    q('#posCategorias').innerHTML = nombres.map((n) =>
      `<button type="button" data-cat="${esc(n)}" class="${n === catActiva ? 'activo' : ''}">${n === 'todas' ? 'ðŸíï¸ Todas' : esc(n)}</button>`).join('');
    q('#posCategorias').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { catActiva = b.dataset.cat; pintarChips(); pintarGrilla(); enfocarEscanner(); });
    });
  }

  function tarjetaProd(p) {
    const sinStock = p.stock <= 0;
    return `<button type="button" class="tarjeta-prod ${sinStock ? 'sin-stock' : ''}" data-id="${p.id}">
      <b>${esc(p.nombre)}</b>
      <span class="precio">${money(p.precio)}${p.unidad === 'KG' ? ' /kg' : ''}</span>
      <span class="stock">Quedan: ${cantidad(p.stock)}</span>
    </button>`;
  }

  function pintarGrilla() {
    const visibles = grupos().filter(([cat]) => catActiva === 'todas' || cat === catActiva);
    /* Si hay una categoráa activa se muestran solo sus productos; si no, secciones por categoráa. */
    if (catActiva !== 'todas') {
      const ps = visibles.length ? visibles[0][1] : [];
      q('#posGrilla').innerHTML = ps.map(tarjetaProd).join('') || '<p class="ayuda">Sin productos.</p>';
    } else {
      q('#posGrilla').innerHTML = visibles.map(([cat, ps]) => `
        <div class="pos-seccion">
          <h3>${esc(cat)} á ${ps.length}</h3>
          <div class="pos-productos">${ps.map(tarjetaProd).join('')}</div>
        </div>`).join('');
    }
    q('#posGrilla').querySelectorAll('.tarjeta-prod').forEach((b) => {
      b.addEventListener('click', () => { agregarAlCarrito(Number(b.dataset.id)); enfocarEscanner(); });
    });
  }

  /* =========================================================
     4) CARRITO
     ========================================================= */
  function agregarAlCarrito(id) {
    const p = productos.find((x) => x.id === id);
    if (!p) return;
    if (p.stock <= 0) return aviso(`Sin stock de í«${p.nombre}í».`, 'error');
    const linea = carrito.find((l) => l.id === id);
    const paso = p.unidad === 'KG' ? 0.1 : 1;
    if (linea) linea.cantidad = Math.round((linea.cantidad + paso) * 1000) / 1000;
    else carrito.push({ id: p.id, nombre: p.nombre, precio: p.precio, unidad: p.unidad, cantidad: paso });
    pintarCarrito();
  }

  function totalCarrito() {
    return Math.round(carrito.reduce((a, l) => a + l.precio * l.cantidad, 0) * 100) / 100;
  }

  function pintarCarrito() {
    q('#posItems').innerHTML = carrito.length ? carrito.map((l, i) => `
      <div class="item-carrito">
        <b>${esc(l.nombre)}</b>
        <span>${money(l.precio * l.cantidad)}</span>
        <small>${money(l.precio)} x ${cantidad(l.cantidad)}${l.unidad === 'KG' ? ' kg' : ''}</small>
        <span></span>
        <div class="item-controles">
          <button type="button" data-menos="${i}">âˆ’</button>
          <input type="text" inputmode="decimal" value="${cantidad(l.cantidad)}" data-cant="${i}" aria-label="Cantidad">
          <button type="button" data-mas="${i}">+</button>
          <button type="button" class="item-quitar" data-quitar="${i}">âœ•</button>
        </div>
      </div>`).join('')
      : '<p class="ayuda">Carrito vacáo. Escanee o toque un producto.</p>';

    const t = money(totalCarrito());
    q('#posTotal').textContent = t;
    q('#posBarraTotal').textContent = t;
    q('#posBarraCant').textContent = carrito.reduce((a, l) => a + (l.unidad === 'KG' ? 1 : l.cantidad), 0);
    const habilitado = carrito.length > 0;
    q('#posCobrar').disabled = !habilitado;
    q('#posBarraCobrar').disabled = !habilitado;

    q('#posItems').querySelectorAll('[data-mas]').forEach((b) => b.addEventListener('click', () => {
      const l = carrito[+b.dataset.mas];
      l.cantidad = Math.round((l.cantidad + (l.unidad === 'KG' ? 0.1 : 1)) * 1000) / 1000;
      pintarCarrito();
    }));
    q('#posItems').querySelectorAll('[data-menos]').forEach((b) => b.addEventListener('click', () => {
      const l = carrito[+b.dataset.menos];
      l.cantidad = Math.round((l.cantidad - (l.unidad === 'KG' ? 0.1 : 1)) * 1000) / 1000;
      if (l.cantidad <= 0) carrito.splice(+b.dataset.menos, 1);
      pintarCarrito();
    }));
    q('#posItems').querySelectorAll('[data-quitar]').forEach((b) => b.addEventListener('click', () => {
      carrito.splice(+b.dataset.quitar, 1);
      pintarCarrito();
    }));
    q('#posItems').querySelectorAll('[data-cant]').forEach((inp) => inp.addEventListener('change', () => {
      const v = num(inp.value);
      const i = +inp.dataset.cant;
      if (v === null || v <= 0) { carrito.splice(i, 1); }
      else carrito[i].cantidad = v;
      pintarCarrito();
    }));
  }

  q('#posVaciar').addEventListener('click', () => {
    if (!carrito.length) return;
    if (!confirm('í¿Vaciar el carrito?')) return;
    carrito = [];
    pintarCarrito();
    aviso('Carrito vaciado.', 'ok');
  });

  /* Carrito mobile (off-canvas) */
  q('#posAbrirCarrito').addEventListener('click', () => q('#posCarrito').classList.add('abierto'));
  q('#posCerrarCarrito').addEventListener('click', () => q('#posCarrito').classList.remove('abierto'));

  /* =========================================================
     5) ESCíNER USB í«Nictom LCB8200Wí» (gaveta de teclado + Enter final)
     El LCB8200W se presenta como un TECLADO USB: escribe el cí³digo a velocidad
     de máquina (menos de ~30 ms por dágito) y cierra con Enter. Si el foco se
     habáa perdido â€”se tocí³ el carrito o un botí³n sin volver al cuadroâ€”, el
     primer dágito caáa al vacáo y el cí³digo leádo no encontraba el producto.
     Acá se junta lo que llega a nivel documento y, como no hay otro campo de
     texto en la vista de venta, el buffer completo se cobra igual al llegar el
     Enter: nunca más un cí³digo í«perdidoí» por un clic de más. */
  let bufferEscanner = '';
  let tBufferEscanner = null;

  function limpiarBufferEscanner() {
    bufferEscanner = '';
    if (tBufferEscanner) { clearTimeout(tBufferEscanner); tBufferEscanner = null; }
  }

  async function buscarYAgregar(codigo) {
    const cod = String(codigo || '').trim();
    if (!cod) return;
    try {
      const p = await api('/api/productos/codigo/' + encodeURIComponent(cod));
      agregarAlCarrito(p.id);
      aviso(`ïí‹ ${p.nombre} (${money(p.precio)})`, 'ok');
    } catch (e) {
      aviso(e.message, 'error');
    }
    q('#posBuscar').value = '';
    limpiarBufferEscanner();
    enfocarEscanner();
  }

  /* =========================================================
     BíšSQUEDA POR PRIMERA LETRA (teclado nativo)
     El usuario escribe una o más letras y los resultados se
     filtran en vivo; Enter echa un producto al carrito.
     El escáner USB NO se toca: solo se agrega la tecla Ctrl+F
     (o el icono de lupa) para que el foco pase al campo de texto.
     ========================================================= */
  let filtroBusqueda = '';
  let tFiltroBusqueda = null;
  let buscaActiva = false;

  function aplicarFiltroBusqueda() {
    const term = filtroBusqueda.trim().toLowerCase(); // teclado
    const grilla = q('#posGrilla');
    if (!term) {
      if (catActiva === 'todas') {
        // restaurar modo de categoráa normal
        const visibles = grupos();
        grilla.innerHTML = visibles.map(([cat, ps]) => `
          <div class="pos-seccion">
            <h3>${esc(cat)} á ${ps.length}</h3>
            <div class="pos-productos">${ps.map(tarjetaProd).join('')}</div>
          </div>`).join('');
      } else {
        const ps = (grupos().filter(([cat]) => cat === catActiva) || [])[0];
        grilla.innerHTML = ps ? ps[1].map(tarjetaProd).join('') : '<p class="ayuda">Sin productos.</p>';
      }
      return;
    }
    const visibles = grupos().flatMap(([cat, ps]) =>
      ps.filter((p) => p.nombre.toLowerCase().includes(term))
    );
    if (!visibles.length) {
      grilla.innerHTML = '<p class="ayuda">Sin resultados para "<strong>' + esc(term) + '</strong>".</p>';
      return;
    }
    grilla.innerHTML = visibles.map(tarjetaProd).join('');
    grilla.querySelectorAll('.tarjeta-prod').forEach((b) => {
      b.addEventListener('click', () => { agregarAlCarrito(Number(b.dataset.id)); enfocarEscanner(); });
    });
  }

  q('#posBuscar').addEventListener('input', (ev) => {
    const v = ev.target.value;
    if (v === filtroBusqueda) return;
    filtroBusqueda = v;
    if (tFiltroBusqueda) clearTimeout(tFiltroBusqueda);
    if (!v) { enfocarEscanner(); aplicarFiltroBusqueda(); return; }
    tFiltroBusqueda = setTimeout(() => { aplicarFiltroBusqueda(); }, 120);
  });



  q('#posBuscar').addEventListener('keydown', (ev) => {
    // Ctrl+F / icono de lupa: pasar el foco al campo de texto sin tocar el escáner
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f' && !ev.target.closest('input, select, textarea, [contenteditable]')) {
      ev.preventDefault();
      q('#posBuscar').focus();
      return;
    }
    if (ev.key === 'Enter') {
      if (q('#posBuscar').value.trim()) {
        ev.preventDefault();
        const term = filtroBusqueda.trim().toLowerCase();
        const visibles = grupos().flatMap(([, ps]) =>
          ps.filter((p) => p.nombre.toLowerCase().includes(term)));
        if (visibles.length) {
          agregarAlCarrito(Number(visibles[0].id));
          q('#posBuscar').value = '';
          filtroBusqueda = '';
          aplicarFiltroBusqueda();
          aviso('OK: ' + visibles[0].nombre, 'ok');
        } else {
          aviso('Sin resultados para "' + esc(filtroBusqueda) + '".', 'error');
        }
        return;
      }
      // Enter sin texto: se genera el buffer de escáner como antes (Ignorando el filtro en vivo)
      if (bufferEscanner) {
        ev.preventDefault();
        buscarYAgregar(bufferEscanner);
        bufferEscanner = '';
        tBufferEscanner = null;
        q('#posBuscar').value = '';
      }
      return;
    }
    // Teclas que no sean Enter ni Ctrl+F: se manejan arriba por el buffer/teclado
    limpiarBufferEscanner();
  });



  // Ctrl+F / icono de lupa: pasar el foco al campo de texto sin modificar el buffer
  // del escáner.
  q('#posBuscar').querySelector('label') ? null : null;
  q('#posLupa')?.addEventListener('click', () => { q('#posBuscar').focus(); });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f' && escannerListo() && !ev.target.closest('input, select, textarea, [contenteditable]')) {
      ev.preventDefault();
      q('#posBuscar').focus();
    }
  });

  /* Captura global del lector: rescata el cí³digo aunque el foco se hubiera
     perdido. Solo actíºa en la vista de venta y con otro campo de texto inactivo. */
  document.addEventListener('keydown', (ev) => {
    if (!escannerListo()) return;
    if (ev.target === q('#posBuscar')) return;                  /* lo maneja su propio listener */
    const enCampo = ev.target.closest && ev.target.closest('input, select, textarea, [contenteditable]');
    if (enCampo) { limpiarBufferEscanner(); return; }            /* otro campo: se escribe normal */
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    if (ev.key === 'Enter') {
      if (!bufferEscanner) return;
      ev.preventDefault();
      buscarYAgregar(bufferEscanner);                            /* cobro instantáneo del cí³digo juntado */
      return;
    }
    if (ev.key.length === 1) {
      /* Sin foco en el cuadro: el dágito se guarda acá para no perderlo. */
      ev.preventDefault();
      bufferEscanner += ev.key;
      if (tBufferEscanner) clearTimeout(tBufferEscanner);
      tBufferEscanner = setTimeout(limpiarBufferEscanner, 1200); /* si nadie cierra con Enter, se descarta */
      q('#posBuscar').value = bufferEscanner;                    /* vista previa de dí³nde va el cí³digo */
    }
  });

  /* =========================================================
     6) COBRO â†’ TRANSACCIí“N REAL â†’ TICKET â†’ window.print()
     ========================================================= */
  const MEDIOS = [
    ['efectivo', 'Efectivo'], ['debito', 'Dí©bito'], ['credito', 'Crí©dito'],
    ['transferencia', 'Transferencia'], ['cuentaícorriente', 'Cuenta corriente']
  ];

  function filaPago(medio, monto) {
    const div = document.createElement('div');
    div.className = 'cobro-fila';
    div.innerHTML = `
      <label>Medio<select class="pago-medio">${MEDIOS.map(([v, t]) =>
        `<option value="${v}" ${v === medio ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Importe<input class="pago-monto" inputmode="decimal" value="${String(monto).replace('.', ',')}"></label>
      <button type="button" class="secundario mini pago-quitar">âœ•</button>`;
    div.querySelector('.pago-quitar').addEventListener('click', () => {
      div.remove();
      if (!q('#cobroPagos').children.length) agregarFilaPago('efectivo', totalCarrito());
      recalcularPendiente();
    });
    div.querySelectorAll('select, input').forEach((el) => el.addEventListener('input', recalcularPendiente));
    return div;
  }
  function agregarFilaPago(medio, monto) {
    q('#cobroPagos').appendChild(filaPago(medio, monto));
  }
  function recalcularPendiente() {
    const suma = [...q('#cobroPagos').querySelectorAll('.pago-monto')]
      .reduce((a, i) => a + (num(i.value) || 0), 0);
    const falta = Math.round((totalCarrito() - suma) * 100) / 100;
    const el = q('#cobroPendiente');
    if (Math.abs(falta) < 0.01) { el.textContent = 'âœ“ Cubierto'; el.className = 'cobro-pendiente sobra'; }
    else if (falta > 0) { el.textContent = 'Faltan ' + money(falta); el.className = 'cobro-pendiente falta'; }
    else { el.textContent = 'Vuelto ' + money(-falta); el.className = 'cobro-pendiente sobra'; }
    return falta;
  }

  async function abrirCobro() {
    if (!carrito.length) return;
    if (!turno) { aviso('Abra la caja antes de cobrar.', 'error'); return refrescarTurno(); }
    q('#cobroError').textContent = '';
    q('#cobroTotal').textContent = money(totalCarrito());
    q('#cobroPagos').innerHTML = '';
    agregarFilaPago('efectivo', totalCarrito());
    recalcularPendiente();
    /* El modal se abre YA (antes de cualquier await) para que nunca quede colgado
       esperando la red. Antes se abráa DESPUí‰S de /api/clientes y si esa llamada
       tardaba o colgaba, el cobro no aparecáa nunca. */
    mostrarModal('#modalCobro');
    try {
      const m = q('#cobroPagos').querySelector('.pago-monto');
      if (m) { m.focus(); m.select(); }
    } catch (e) { /* sin foco */ }
    /* Clientes (para cuenta corriente) se cargan en segundo plano, sin bloquear el modal. */
    try {
      const clientes = await api('/api/clientes');
      q('#cobroCliente').innerHTML = '<option value="">â€” Sin cliente â€”</option>' +
        clientes.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
    } catch (e) { /* opcional */ }
  }

  q('#posCobrar').addEventListener('click', abrirCobro);
  q('#posBarraCobrar').addEventListener('click', abrirCobro);
  q('#cobroAgregar').addEventListener('click', () => { agregarFilaPago('debito', 0); recalcularPendiente(); });
  q('#cobroCancelar').addEventListener('click', ocultarModales);

  let cobrando = false;
  q('#cobroConfirmar').addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (cobrando) return;                 /* evita el doble clic y el doble cobro */
    const boton = q('#cobroConfirmar');
    const pagos = [...q('#cobroPagos').querySelectorAll('.cobro-fila')].map((f) => ({
      medio: f.querySelector('.pago-medio').value,
      monto: num(f.querySelector('.pago-monto').value) || 0
    })).filter((p) => p.monto > 0);
    if (!pagos.length) return aviso('Escriba el importe pagado.', 'error');
    const cuerpo = {
      items: carrito.map((l) => ({ productoíid: l.id, cantidad: l.cantidad })),
      pagos,
      clienteíid: q('#cobroCliente').value ? Number(q('#cobroCliente').value) : null
    };
    q('#cobroError').textContent = '';
    cobrando = true;
    boton.disabled = true;
    boton.textContent = 'Cobrandoâ€¦';
    try {
      const venta = await api('/api/ventas', { method: 'POST', body: cuerpo });
      /* âœ… Venta procesada: stock descontado en la base, carrito limpio. */
      carrito = [];
      pintarCarrito();
      ultimaVenta = venta;
      ocultarModales();
      q('#posCarrito').classList.remove('abierto');
      await recargarProductos();
      await refrescarTurno();
      aviso(`âœ“ Venta #${venta.numero} registrada á ${money(venta.total)} á stock descontado.`, 'ok');
      /* Imprime solo si el cajero dejí³ activada la impresií³n automática. */
      abrirTicket(venta, autoImprimirActivo());
    } catch (e) {
      /* El modal queda abierto y el motivo del fallo se ve dentro del cobro. */
      const texto = (e && e.message) ? e.message : 'No se pudo registrar la venta.';
      q('#cobroError').textContent = 'No se pudo cobrar: ' + texto;
      aviso(texto, 'error');
      if (/stock/i.test(texto)) { carrito = []; pintarCarrito(); await recargarProductos(); }
    } finally {
      cobrando = false;
      boton.disabled = false;
      boton.textContent = 'CONFIRMAR COBRO';
    }
  });

  /* =========================================================
     7) TICKET Tí‰RMICO 58/80 mm + window.print()
     ========================================================= */
  function htmlTicket(v) {
    const fecha = v.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const filas = v.items.map((it) => `
      <tr>
        <td>${esc(it.nombre)}<br><small>cant ${cantidad(it.cantidad)} @ ${money(it.precio)}</small></td>
        <td class="tk-der">${money(it.subtotal)}</td>
      </tr>`).join('');
    const pagos = (v.pagos || []).map((p) =>
      `<tr><td>${esc(p.medio)}</td><td class="tk-der">${money(p.monto)}</td></tr>`).join('');
    return `
      <div class="tk">
        <div class="tk-centro">
          <div class="tk-titulo">360MAX COMERCIOS</div>
          <div>Comprobante no fiscal</div>
          <div>Ticket Ní° ${String(v.numero).padStart(6, '0')}</div>
        </div>
        <div class="tk-linea"></div>
        <table class="tk-tabla">
          <tr><td>Fecha</td><td class="tk-der">${esc(fecha)}</td></tr>
          <tr><td>Cajero</td><td class="tk-der">${esc(v.cajero || (getSesion() && getSesion().nombre) || '')}</td></tr>
          ${v.cliente ? `<tr><td>Cliente</td><td class="tk-der">${esc(v.cliente)}</td></tr>` : ''}
        </table>
        <div class="tk-linea"></div>
        <table class="tk-tabla">${filas}</table>
        <div class="tk-linea"></div>
        <table class="tk-tabla">
          <tr class="tk-total"><td>TOTAL</td><td class="tk-der">${money(v.total)}</td></tr>
          ${pagos}
        </table>
        <div class="tk-linea"></div>
        <div class="tk-pie">
          áGracias por su compra!<br>360MAX Comercios á Sistema de gestií³n
          ${v.estado === 'anulada' ? '<br><b>*** VENTA ANULADA ***</b>' : ''}
        </div>
      </div>`;
  }

  function abrirTicket(v, autoImprimir) {
    const html = htmlTicket(v);
    q('#ticketNum').textContent = '#' + v.numero;
    q('#ticketVista').innerHTML = html;
    q('#ticketImpresion').innerHTML = html;
    mostrarModal('#modalTicket');
    q('#posReimprimir').hidden = false;
    if (autoImprimir) setTimeout(imprimirTicket, 350);
  }

  function imprimirTicket() {
    if (!ultimaVenta) return aviso('No hay ticket para imprimir.', 'error');
    const ancho = q('#ticketAncho').value;                       // 58 | 80
    document.body.classList.toggle('ancho-80', ancho === '80');
    q('#estiloTicket').textContent = `@page { size: ${ancho}mm auto; margin: 2mm; }`;
    q('#ticketImpresion').innerHTML = htmlTicket(ultimaVenta);
    window.print();                                              // â† lanza la tiquetera
  }

  q('#ticketImprimir').addEventListener('click', imprimirTicket);
  q('#ticketAncho').addEventListener('change', () => {
    document.body.classList.toggle('ancho-80', q('#ticketAncho').value === '80');
    q('#estiloTicket').textContent = `@page { size: ${q('#ticketAncho').value}mm auto; margin: 2mm; }`;
  });
  q('#ticketCerrar').addEventListener('click', () => { ocultarModales(); enfocarEscanner(); });
  q('#posReimprimir').addEventListener('click', () => {
    if (ultimaVenta) abrirTicket(ultimaVenta, false);
  });

  /* ---------- Preferencia de impresií³n automática del ticket ----------
     El cajero decide si la tiquetera 58 mm dispara sola tras cada venta; la
     eleccií³n se recuerda en el navegador para no volver a marcarla. */
  function autoImprimirActivo() {
    const cb = q('#autoImprimir');
    return !cb || cb.checked;                 /* si el control no está, imprime */
  }
  (function prepararAutoImprimir() {
    const cb = q('#autoImprimir');
    if (!cb) return;
    try {
      const guardado = localStorage.getItem('360maxíautoíimprimir');
      if (guardado !== null) cb.checked = guardado === '1';
    } catch (e) { /* almacenamiento no disponible */ }
    cb.addEventListener('change', () => {
      try { localStorage.setItem('360maxíautoíimprimir', cb.checked ? '1' : '0'); } catch (e) { /* noop */ }
    });
  })();

  /* =========================================================
     8) ARQUEO Y CIERRE DE CAJA
     ========================================================= */
  const DENOMINACIONES = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];
  let esperadoActual = 0;

  async function cargarArqueo() {
    const r = await api('/api/caja/arqueo');
    if (!r.turno) { q('#arqueoDatos').innerHTML = '<p class="ayuda">No hay turno abierto.</p>'; return; }
    esperadoActual = r.esperado;
    q('#arqueoDatos').innerHTML = [
      ['Caja', r.turno.caja], ['Cajero', r.turno.usuario],
      ['Apertura', r.turno.fechaíapertura], ['Fondo inicial', money(r.turno.fondo)],
      ['Ventas', `${r.ventasín} á ${money(r.ventasítotal)}`]
    ].map(([k, v]) => `<div class="par"><span>${k}</span><b>${v}</b></div>`).join('');
    q('#arqueoMedios').innerHTML = '<h3>Medios de pago</h3>' + (r.pagos.length
      ? r.pagos.map((p) => `<div class="par"><span>${esc(p.medio)}</span><b>${money(p.monto)}</b></div>`).join('')
      : '<p class="ayuda">Sin ventas todaváa.</p>');
    q('#arqueoMovs').innerHTML = r.movimientos.length
      ? '<h3>Movimientos de efectivo</h3>' + r.movimientos.map((m) =>
        `<div class="par"><span>${esc(m.tipo)} á ${esc(m.motivo)}</span><b>${m.tipo === 'egreso' ? 'âˆ’' : '+'}${money(m.importe)}</b></div>`).join('')
      : '';
    q('#arqueoEsperado').textContent = money(r.esperado);
    q('#arqueoConteo').innerHTML = DENOMINACIONES.map((d) => `
      <label>${money(d)}<input inputmode="numeric" data-den="${d}" value="0"></label>`).join('');
    q('#arqueoConteo').querySelectorAll('input').forEach((i) => i.addEventListener('input', recalcularContado));
    recalcularContado();
  }

  function recalcularContado() {
    let contado = 0;
    q('#arqueoConteo').querySelectorAll('input').forEach((i) => {
      contado += (parseInt(i.value, 10) || 0) * Number(i.dataset.den);
    });
    q('#arqueoContado').textContent = money(contado);
    const dif = Math.round((contado - esperadoActual) * 100) / 100;
    const el = q('#arqueoDiferencia');
    el.textContent = money(dif);
    el.style.color = dif === 0 ? 'var(--ok)' : 'var(--peligro)';
    return contado;
  }

  q('#formMovCaja').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('/api/caja/movimiento', { method: 'POST', body: {
        tipo: fd.get('tipo'), importe: num(fd.get('importe')), motivo: fd.get('motivo')
      } });
      aviso('âœ“ Movimiento registrado.', 'ok');
      ev.target.reset();
      cargarArqueo();
    } catch (e) { aviso(e.message, 'error'); }
  });

  q('#arqueoCerrar').addEventListener('click', async () => {
    const contado = recalcularContado();
    const obs = q('#arqueoObs').value.trim();
    const dif = Math.round((contado - esperadoActual) * 100) / 100;
    if (dif !== 0 && !obs) return aviso('Hay diferencia: escriba el motivo en observaciones.', 'error');
    if (!confirm(`í¿Cerrar caja? Contado ${money(contado)} / Esperado ${money(esperadoActual)}.`)) return;
    const boton = q('#arqueoCerrar');
    boton.disabled = true;
    boton.textContent = 'CERRANDOâ€¦';
    try {
      const r = await api('/api/caja/cierre', { method: 'POST', body: { contado, observaciones: obs } });
      /* Turno cerrado en el servidor: se limpia la sesií³n y se vuelve al login. */
      try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* la cookie se borra igual */ }
      turno = null;
      carrito = [];
      pintarCarrito();
      if (typeof window.salirUI === 'function') window.salirUI(false);
      aviso(`âœ“ Caja cerrada. Diferencia: ${money(r.diferencia)}. Sesií³n cerrada: ingrese de nuevo.`, 'ok');
    } catch (e) {
      aviso(e.message, 'error');
    } finally {
      boton.disabled = false;
      boton.textContent = 'CERRAR CAJA';
    }
  });

  /* =========================================================
     9) DEVOLUCIONES Y ANULACIONES
     ========================================================= */
  async function cargarVentasTurno() {
    const ventas = await api('/api/ventas');
    q('#devLista').innerHTML = ventas.length ? ventas.map((v) => `
      <div class="venta-fila">
        <span>#${v.numero} á ${esc(v.fecha)} á ${esc(v.cajero)}
          ${v.estado === 'anulada' ? '<b class="saldo-debe">(anulada)</b>' : ''}</span>
        <span>${money(v.total)}
          <button type="button" class="mini secundario" data-ver="${v.numero}">Devolverâ€¦</button>
          ${v.estado === 'completada' ? `<button type="button" class="mini peligro" data-anular="${v.numero}">Anularâ€¦</button>` : ''}
        </span>
      </div>`).join('') : '<p class="ayuda">Sin ventas en este turno.</p>';
    q('#devLista').querySelectorAll('[data-ver]').forEach((b) =>
      b.addEventListener('click', () => verVenta(Number(b.dataset.ver))));
    q('#devLista').querySelectorAll('[data-anular]').forEach((b) =>
      b.addEventListener('click', () => {
        ventaDevolver = { numero: Number(b.dataset.anular) };
        q('#anulVentaNum').textContent = '#' + b.dataset.anular;
        q('#anulMotivo').value = '';
        mostrarModal('#modalAnulacion');
      }));
  }

  q('#devBuscarBtn').addEventListener('click', () => {
    const n = Number(new FormData(q('#devBuscarForm')).get('venta'));
    if (!n) return aviso('Escriba el níºmero de venta.', 'error');
    verVenta(n);
  });

  async function verVenta(numero) {
    try {
      const v = await api('/api/ventas/' + numero);
      ventaDevolver = v;
      const filas = v.items.map((it) => {
        const pendiente = Math.round((it.cantidad - it.cantidadídevuelta) * 1000) / 1000;
        return `
        <div class="dev-fila">
          <span>${esc(it.nombre)}<br><small>${cantidad(it.cantidad)} x ${money(it.precio)}${it.cantidadídevuelta ? ` á ya devuelto: ${cantidad(it.cantidadídevuelta)}` : ''}</small></span>
          <label>Cant. a devolver<input type="text" inputmode="decimal" class="dev-cant" data-pid="${it.productoíid}" value="0" style="width:90px"></label>
          <button type="button" class="mini secundario dev-max" data-pid="${it.productoíid}" data-max="${pendiente}">Todo (${cantidad(pendiente)})</button>
        </div>`;
      }).join('');
      q('#devProductos').innerHTML = v.estado === 'anulada'
        ? '<p class="ayuda">Esta venta está anulada.</p>' : filas;
      q('#devVentaNum').textContent = '#' + v.numero;
      q('#devResumen').textContent = `Total ${money(v.total)} á Estado: ${v.estado}`;
      q('#devMotivo').value = '';
      q('#devReintegro').checked = true;
      mostrarModal('#modalDevolucion');
    } catch (e) { aviso(e.message, 'error'); }
  }

  /* "Anular" tambií©n disponible desde la fila de la venta (ver cargarVentasTurno). */

  q('#devProductos').addEventListener('click', (ev) => {
    const b = ev.target.closest('.dev-max');
    if (b) {
      const inp = q(`#devProductos .dev-cant[data-pid="${b.dataset.pid}"]`);
      if (inp) inp.value = String(b.dataset.max).replace('.', ',');
    }
  });

  q('#devConfirmar').addEventListener('click', async () => {
    if (!ventaDevolver) return;
    const items = [...q('#devProductos').querySelectorAll('.dev-cant')]
      .map((i) => ({ productoíid: Number(i.dataset.pid), cantidad: num(i.value) || 0 }))
      .filter((i) => i.cantidad > 0);
    if (!items.length) return aviso('Marcá cuántas unidades devolver.', 'error');
    try {
      const r = await api(`/api/ventas/${ventaDevolver.numero}/devolver`, { method: 'POST', body: {
        items, motivo: q('#devMotivo').value, reintegrar: q('#devReintegro').checked
      } });
      ocultarModales();
      aviso(`âœ“ Devolucií³n registrada en venta #${r.numero}.`, 'ok');
      await recargarProductos();
      await refrescarTurno();
      cargarVentasTurno();
    } catch (e) { aviso(e.message, 'error'); }
  });
  q('#devCancelar').addEventListener('click', ocultarModales);

  q('#anulConfirmar').addEventListener('click', async () => {
    if (!ventaDevolver) return;
    try {
      const r = await api(`/api/ventas/${ventaDevolver.numero}/anular`, { method: 'POST', body: { motivo: q('#anulMotivo').value } });
      ocultarModales();
      aviso(`âœ“ Venta #${r.numero} anulada y stock reintegrado.`, 'ok');
      await recargarProductos();
      await refrescarTurno();
      cargarVentasTurno();
    } catch (e) { aviso(e.message, 'error'); }
  });
  q('#anulCancelar').addEventListener('click', ocultarModales);

  /* =========================================================
     10) CLIENTES Y CUENTAS CORRIENTES
     ========================================================= */
  async function cargarClientes(busqueda) {
    const clientes = await api('/api/clientes' + (busqueda ? '?q=' + encodeURIComponent(busqueda) : ''));
    q('#cliLista').innerHTML = clientes.length ? clientes.map((c) => `
      <div class="cli-fila">
        <span><strong>${esc(c.nombre)}</strong>${c.telefono ? ' á ' + esc(c.telefono) : ''}</span>
        <span class="${c.saldo > 0 ? 'saldo-debe' : 'saldo-haber'}">Saldo ${money(c.saldo)}
          <button type="button" class="mini secundario" data-cli="${c.id}">Ver</button></span>
      </div>`).join('') : '<p class="ayuda">Sin clientes. Creá el primero arriba.</p>';
    q('#cliLista').querySelectorAll('[data-cli]').forEach((b) =>
      b.addEventListener('click', () => verCliente(Number(b.dataset.cli))));
  }

  function verCliente(id) {
    api('/api/clientes/' + id).then((c) => {
      q('#cliPanel').hidden = false;
      q('#cliNombre').textContent = c.nombre;
      q('#cliDatos').innerHTML = `
        <div class="par"><span>Telí©fono</span><b>${esc(c.telefono || 'â€”')}</b></div>
        <div class="par"><span>Saldo</span><b class="${c.saldo > 0 ? 'saldo-debe' : 'saldo-haber'}">${money(c.saldo)}</b></div>`;
      q('#cliMovs').innerHTML = c.movimientos.length ? c.movimientos.map((m) => `
        <div class="par"><span>${esc(m.fecha)} á ${esc(m.motivo || '')}</span><b>${money(m.monto)}</b></div>`).join('')
        : '<p class="ayuda">Sin movimientos.</p>';
      q('#cliPago').dataset.cli = c.id;
    }).catch((e) => aviso(e.message, 'error'));
  }

  q('#cliNuevo').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('/api/clientes', { method: 'POST', body: { nombre: fd.get('nombre'), telefono: fd.get('telefono') } });
      ev.target.reset();
      aviso('âœ“ Cliente creado.', 'ok');
      cargarClientes();
    } catch (e) { aviso(e.message, 'error'); }
  });
  q('#cliBuscar').addEventListener('input', (ev) => cargarClientes(ev.target.value));
  q('#cliPago').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = ev.target.dataset.cli;
    if (!id) return aviso('Elegá un cliente primero.', 'error');
    const fd = new FormData(ev.target);
    try {
      await api(`/api/clientes/${id}/pagos`, { method: 'POST', body: { importe: num(fd.get('importe')), motivo: fd.get('motivo') } });
      ev.target.reset();
      aviso('âœ“ Pago registrado en caja.', 'ok');
      cargarClientes();
      verCliente(Number(id));
    } catch (e) { aviso(e.message, 'error'); }
  });

  /* =========================================================
     11) ESCíNER POR CíMARA (BarcodeDetector nativo si existe)
     ========================================================= */
  /* Cadena de intentos: trasera â†’ cualquier cámara â†’ cada dispositivo detectado. */
  async function pedirCamara() {
    const intentos = [
      { video: { facingMode: { ideal: 'environment' } } },
      { video: { facingMode: 'environment' } },
      { video: true }
    ];
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      try {
        const lista = await navigator.mediaDevices.enumerateDevices();
        lista.filter((d) => d.kind === 'videoinput' && d.deviceId).forEach((d) => {
          intentos.push({ video: { deviceId: { exact: d.deviceId } } });
        });
      } catch (e) { /* sin lista de dispositivos: quedan los intentos gení©ricos */ }
    }
    let ultimo = null;
    for (const restriccion of intentos) {
      try {
        const st = await navigator.mediaDevices.getUserMedia(restriccion);
        if (st && st.getVideoTracks().length) return st;
        ultimo = new Error('La cámara no entrega video.');
      } catch (e) { ultimo = e; }
    }
    throw ultimo || new Error('No se encontrí³ ninguna cámara.');
  }

  function estadoCamara(txt) {
    const el = q('#camaraEstado');
    if (el) el.textContent = txt || '';
  }

  /* Stream y atributos listos ANTES del play(): iOS y Android lo exigen. */
  function montarVideo(st) {
    const video = q('#camaraVideo');
    streamCamara = st;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    video.setAttribute('muted', 'true');
    video.playsInline = true;
    video.autoplay = true;
    if (video.srcObject !== st) video.srcObject = st;
    return video;
  }

  /* Se llama SIEMPRE dentro del gesto del usuario: video.play() es sáncrono acá. */
  function arrancarVideo() {
    const video = q('#camaraVideo');
    if (!video || !video.srcObject) return Promise.resolve(false);
    video.muted = true;
    let p = null;
    try { p = video.play(); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') return p.then(() => true).catch(() => false);
    return Promise.resolve(!video.paused);
  }
  function crearDetector() {
    if (!('BarcodeDetector' in window)) return null;
    try { return new window.BarcodeDetector(); } catch (e) { /* se prueba con formatos */ }
    try {
      return new window.BarcodeDetector({ formats: ['eaní13', 'eaní8', 'codeí128', 'codeí39', 'upcía', 'upcíe', 'qrícode'] });
    } catch (e2) { return null; }
  }

  let bucleCamara = false;
  function vigilarCodigos() {
    if (bucleCamara) return;
    bucleCamara = true;
    const paso = () => {
      const video = q('#camaraVideo');
      if (!streamCamara || !video || q('#modalCamara').hidden) { bucleCamara = false; return; }
      if (!detectorCodigos || video.paused || video.readyState < 2 || !video.videoWidth) {
        setTimeout(paso, 200);
        return;
      }
      detectorCodigos.detect(video).then((codes) => {
        if (codes && codes.length) {
          bucleCamara = false;
          const cod = codes[0].rawValue;
          cerrarCamara();
          ocultarModales();
          buscarYAgregar(cod);
          return;
        }
        setTimeout(paso, 200);
      }).catch(() => setTimeout(paso, 200));
    };
    paso();
  }

  /* Si el navegador bloqueí³ el video, aparece el botí³n grande en vez de una pantalla negra. */
  function revisarVideo(ms) {
    setTimeout(() => {
      const video = q('#camaraVideo');
      if (!streamCamara || q('#modalCamara').hidden) return;
      if (video.paused || !video.videoWidth) {
        q('#camaraIniciar').hidden = false;
        estadoCamara('Toque â–¶ INICIAR VIDEO para ver la imagen.');
      } else {
        q('#camaraIniciar').hidden = true;
        estadoCamara('Cámara activa. Apunte al cí³digo de barras.');
      }
    }, ms);
  }

  async function abrirCamara() {
    const video = q('#camaraVideo');
    q('#camaraIniciar').hidden = true;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      estadoCamara('Este navegador no entrega la cámara. Escriba el cí³digo o use el lector USB.');
      q('#camaraCodigo').focus();
      return;
    }
    if (streamCamara) { arrancarVideo(); vigilarCodigos(); revisarVideo(300); return; }
    estadoCamara('Abriendo la cámaraâ€¦');
    try {
      montarVideo(await pedirCamara());
    } catch (e) {
      estadoCamara('No se pudo abrir la cámara. Escriba el cí³digo o use el lector USB.');
      q('#camaraCodigo').focus();
      return;
    }
    await arrancarVideo();                    /* primer intento, dentro del mismo toque */
    detectorCodigos = detectorCodigos || crearDetector();
    vigilarCodigos();
    revisarVideo(1500);
    if (video.paused) {
      q('#camaraIniciar').hidden = false;
      estadoCamara('Toque â–¶ INICIAR VIDEO para ver la imagen.');
    } else {
      estadoCamara('Cámara activa. Apunte al cí³digo de barras.');
    }
  }

  q('#posCamara').addEventListener('click', () => {
    mostrarModal('#modalCamara');
    q('#camaraCodigo').value = '';
    abrirCamara();
  });

  /* Botí³n explácito: su toque es el gesto que los navegadores mí³viles exigen. */
  q('#camaraIniciar').addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    estadoCamara('Iniciando videoâ€¦');
    const ok = await arrancarVideo();
    if (ok) {
      q('#camaraIniciar').hidden = true;
      estadoCamara('Cámara activa. Apunte al cí³digo de barras.');
      detectorCodigos = detectorCodigos || crearDetector();
      vigilarCodigos();
    } else {
      estadoCamara('El navegador bloqueí³ el video. Toque el recuadro negro o escriba el cí³digo.');
    }
  });
  q('#camaraVideo').addEventListener('click', () => { arrancarVideo(); });
  q('#camaraVideo').addEventListener('touchstart', () => { arrancarVideo(); }, { passive: true });

  function cerrarCamara() {
    if (streamCamara) { streamCamara.getTracks().forEach((t) => t.stop()); streamCamara = null; }
    const video = q('#camaraVideo');
    if (video) video.srcObject = null;
  }
  q('#camaraCerrar').addEventListener('click', () => { cerrarCamara(); ocultarModales(); });
  q('#camaraUsar').addEventListener('click', () => {
    const cod = q('#camaraCodigo').value;
    cerrarCamara();
    ocultarModales();
    buscarYAgregar(cod);
  });
  q('#camaraCodigo').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); q('#camaraUsar').click(); }
  });

  /* =========================================================
     12) ARRANQUE DE LA VISTA CAJA
     ========================================================= */
  bus.addEventListener('vista', (ev) => {
    if (ev.detail !== 'pos') return;
    // NUNCA dejar la vista Caja en blanco: mostrar 'Abrir caja' al instante
    // y desacoplar las dos cargas (productos y turno son independientes).
    q('#apertura').hidden = false;
    q('#posPrincipal').hidden = true;
    recargarProductos().catch(() => {});
    refrescarTurno().catch((e) => aviso(e.message || 'No se pudo cargar la caja', 'error'));
  });
  bus.addEventListener('productos', () => recargarProductos().catch(() => {}));
  pintarCarrito();
});







