'use strict';
/* Vistas del Depósito: pestañas, selects agrupados por categoría, catálogo y historial. */
document.addEventListener('DOMContentLoaded', () => {
  const $d = (s) => document.querySelector(s);
  let productos = [];
  let proveedores = [];
  let chipActiva = 'todas';

  /* ---------- Pestañas del depósito ---------- */
  const secciones = { entrada: '#depEntrada', salida: '#depSalida', merma: '#depMerma', ajuste: '#depAjuste', catalogo: '#depCatalogo', historial: '#depHistorial' };
  document.querySelectorAll('#depTabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#depTabs button').forEach((x) => x.classList.toggle('activo', x === b));
      Object.entries(secciones).forEach(([k, sel]) => { document.querySelector(sel).hidden = k !== b.dataset.dep; });
      if (b.dataset.dep === 'historial') cargarHistorial();
      if (b.dataset.dep === 'catalogo') pintarCatalogo();
    });
  });

  /* ---------- Carga de datos ---------- */
  async function recargar() {
    productos = await api('/api/productos?inactivos=1');
    proveedores = await api('/api/proveedores');
    pintarSelects();
    pintarProveedores();
    pintarCatalogo();
    popularFiltros();
  }

  function agrupar(lista) {
    const g = new Map();
    for (const p of lista) {
      const cat = p.categoria || 'Sin categoría';
      if (!g.has(cat)) g.set(cat, []);
      g.get(cat).push(p);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  }

  function opcionesProducto(p) {
    return `<option value="${p.id}">${esc(p.nombre)} — stock ${cantidad(p.stock)} ${p.unidad === 'KG' ? 'kg' : 'u.'}</option>`;
  }

  function pintarSelects() {
    const grupos = agrupar(productos.filter((p) => p.activo));
    const html = grupos.map(([cat, ps]) =>
      `<optgroup label="${esc(cat)}">${ps.map(opcionesProducto).join('')}</optgroup>`).join('');
    ['#prodEntrada', '#prodSalida', '#prodMerma', '#prodAjuste'].forEach((sel) => {
      const el = document.querySelector(sel);
      const prev = el.value;
      el.innerHTML = html;
      if (prev) el.value = prev;
    });
    document.querySelector('#provEntrada').innerHTML =
      proveedores.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('');
  }

  function pintarProveedores() {
    document.querySelector('#provLista').innerHTML = proveedores.length
      ? proveedores.map((p) => `<span class="prov">${esc(p.nombre)}</span>`).join('')
      : '<span class="ayuda">Sin proveedores cargados.</span>';
  }

  function popularFiltros() {
    const tipos = ['entrada', 'salida', 'merma', 'ajuste', 'venta', 'devolucion', 'anulacion'];
    document.querySelector('#filtroTipo').innerHTML =
      '<option value="">Todos</option>' + tipos.map((t) => `<option value="${t}">${t}</option>`).join('');
    document.querySelector('#filtroProd').innerHTML =
      '<option value="">Todos</option>' + productos.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('');
  }

  /* ---------- Catálogo agrupado por categoría ---------- */
  function pintarCatalogo() {
    const chips = document.querySelector('#depChips');
    const grupos = agrupar(productos.filter((p) => p.activo));
    const nombres = ['todas', ...grupos.map((g) => g[0])];
    chips.innerHTML = nombres.map((n) =>
      `<button type="button" data-cat="${esc(n)}" class="${n === chipActiva ? 'activo' : ''}">${n === 'todas' ? 'Todas' : esc(n)}</button>`).join('');
    chips.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      chipActiva = b.dataset.cat; pintarCatalogo();
    }));

    const visibles = grupos.filter(([cat]) => chipActiva === 'todas' || cat === chipActiva);
    document.querySelector('#depGrupos').innerHTML = visibles.map(([cat, ps]) => `
      <div class="grupo-cat">
        <h3>${esc(cat)} · ${ps.length} producto(s)</h3>
        <div class="productos">
          ${ps.map((p) => `
            <div class="producto ${p.stock <= p.stock_minimo ? 'bajo' : ''}">
              <div class="producto-datos">
                <strong>${esc(p.nombre)}</strong>
                <small>${p.unidad === 'KG' ? 'Kilogramo' : 'Unidad'}${p.codigo_barra ? ' · 🏷️ ' + esc(p.codigo_barra) : ''}${p.subcategoria ? ' · ' + esc(p.subcategoria) : ''}</small>
              </div>
              <div class="producto-nums">
                <b>${money(p.precio)}</b>
                <small class="${p.stock <= p.stock_minimo ? 'alerta' : ''}">Quedan: ${cantidad(p.stock)}</small>
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('') || '<p class="ayuda">No hay productos en esta categoría.</p>';
  }

  /* ---------- Historial de depósito ---------- */
  async function cargarHistorial() {
    const f = document.querySelector('#depFiltros');
    const q = new URLSearchParams();
    if (f.tipo.value) q.set('tipo', f.tipo.value);
    if (f.sku_id.value) q.set('producto_id', f.sku_id.value);
    if (f.desde.value) q.set('desde', f.desde.value);
    if (f.hasta.value) q.set('hasta', f.hasta.value);
    const movs = await api('/api/movimientos?' + q.toString());
    document.querySelector('#depTabla').innerHTML = tablaMovimientos(movs);
  }
  document.querySelector('#depFiltros').addEventListener('submit', (ev) => {
    ev.preventDefault();
    cargarHistorial().catch((e) => aviso(e.message, 'error'));
  });

  /* ---------- Movimientos (entrada / salida / merma / ajuste) ---------- */
  async function enviarMovimiento(tipo, form) {
    const fd = new FormData(form);
    const cuerpo = {
      tipo,
      producto_id: Number(fd.get('sku_id')),
      cantidad: fd.get('cantidad'),
      costo: fd.get('costo'),
      proveedor_id: fd.get('proveedor_id'),
      motivo: fd.get('motivo'),
      observacion: fd.get('observacion'),
      lote: fd.get('lote'),
      vencimiento: fd.get('vencimiento'),
      stock_fisico: fd.get('stock_fisico')
    };
    const r = await api('/api/movimientos', { method: 'POST', body: cuerpo });
    const p = productos.find((x) => x.id === cuerpo.producto_id);
    aviso(`✓ ${tipo.toUpperCase()} registrada. Stock de «${p ? p.nombre : ''}»: ${cantidad(r.stock_despues)}.`, 'ok');
    form.reset();
    await recargar();
  }

  document.querySelector('#depFormEntrada').addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviarMovimiento('entrada', ev.target).catch((e) => aviso(e.message, 'error'));
  });
  document.querySelector('#depFormSalida').addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviarMovimiento('salida', ev.target).catch((e) => aviso(e.message, 'error'));
  });
  document.querySelector('#depFormMerma').addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviarMovimiento('merma', ev.target).catch((e) => aviso(e.message, 'error'));
  });
  document.querySelector('#depFormAjuste').addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviarMovimiento('ajuste', ev.target).catch((e) => aviso(e.message, 'error'));
  });

  /* Ajuste: stock en vivo según sistema vs conteo */
  function pintarAjuste() {
    const id = Number(document.querySelector('#prodAjuste').value);
    const p = productos.find((x) => x.id === id);
    document.querySelector('#ajusteSistema').textContent = p ? cantidad(p.stock) + ' ' + p.unidad : '—';
    calcularDiferencia();
  }
  function calcularDiferencia() {
    const id = Number(document.querySelector('#prodAjuste').value);
    const p = productos.find((x) => x.id === id);
    const fisico = num(document.querySelector('#depFormAjuste [name=stock_fisico]').value);
    const dif = document.querySelector('#ajusteDif');
    if (!p || fisico === null) { dif.textContent = '—'; return; }
    const d = Math.round((fisico - p.stock) * 1000) / 1000;
    dif.textContent = (d > 0 ? '+' : '') + cantidad(d);
    dif.style.color = d === 0 ? 'var(--ok)' : 'var(--peligro)';
  }
  document.querySelector('#prodAjuste').addEventListener('change', pintarAjuste);
  document.querySelector('#depFormAjuste [name=stock_fisico]').addEventListener('input', calcularDiferencia);

  /* ---------- Proveedor nuevo ---------- */
  document.querySelector('#provNuevoBtn').addEventListener('click', () => {
    const fila = document.querySelector('#provNuevoFila');
    fila.hidden = !fila.hidden;
  });
  document.querySelector('#provNuevoGuardar').addEventListener('click', async () => {
    const nombre = document.querySelector('#provNuevoNombre').value.trim();
    if (!nombre) return aviso('Escriba el nombre del proveedor.', 'error');
    try {
      await api('/api/proveedores', { method: 'POST', body: { nombre } });
      document.querySelector('#provNuevoNombre').value = '';
      document.querySelector('#provNuevoFila').hidden = true;
      aviso('Proveedor guardado.', 'ok');
      await recargar();
    } catch (e) { aviso(e.message, 'error'); }
  });

  /* ---------- Escáner por cámara: mismos fallbacks que en Caja ---------- */
  let streamCamaraDep = null;
  let detectorDep = null;
  let bucleCamaraDep = false;

  /* Cadena de intentos: trasera ({ facingMode: 'environment' }) → cualquier
     cámara → cada dispositivo detectado. */
  async function pedirCamaraDep() {
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
      } catch (e) { /* sin lista de dispositivos: quedan los intentos genéricos */ }
    }
    let ultimo = null;
    for (const restriccion of intentos) {
      try {
        const st = await navigator.mediaDevices.getUserMedia(restriccion);
        if (st && st.getVideoTracks().length) return st;
        ultimo = new Error('La cámara no entrega video.');
      } catch (e) { ultimo = e; }
    }
    throw ultimo || new Error('No se encontró ninguna cámara.');
  }

  function estadoCamaraDep(txt) {
    const el = document.querySelector('#camaraDepEstado');
    if (el) el.textContent = txt || '';
  }

  /* Stream y atributos listos ANTES del play(): iOS y Android lo exigen. */
  function montarVideoDep(st) {
    const video = document.querySelector('#camaraDepVideo');
    streamCamaraDep = st;
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

  /* Se llama SIEMPRE dentro del gesto del usuario: video.play() es síncrono acá. */
  function arrancarVideoDep() {
    const video = document.querySelector('#camaraDepVideo');
    if (!video || !video.srcObject) return Promise.resolve(false);
    video.muted = true;
    let p = null;
    try { p = video.play(); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') return p.then(() => true).catch(() => false);
    return Promise.resolve(!video.paused);
  }

  function crearDetectorDep() {
    if (!('BarcodeDetector' in window)) return null;
    try { return new window.BarcodeDetector(); } catch (e) { /* se prueba con formatos */ }
    try {
      return new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'] });
    } catch (e2) { return null; }
  }

  function vigilarCodigosDep() {
    if (bucleCamaraDep) return;
    bucleCamaraDep = true;
    const paso = () => {
      const video = document.querySelector('#camaraDepVideo');
      if (!streamCamaraDep || !video || document.querySelector('#modalCamaraDep').hidden) { bucleCamaraDep = false; return; }
      if (!detectorDep || video.paused || video.readyState < 2 || !video.videoWidth) {
        setTimeout(paso, 200);
        return;
      }
      detectorDep.detect(video).then((codes) => {
        if (codes && codes.length) {
          bucleCamaraDep = false;
          const cod = codes[0].rawValue;
          cerrarCamaraDep();
          ocultarCamaraDep();
          aplicarCodigoDep(cod);
          return;
        }
        setTimeout(paso, 200);
      }).catch(() => setTimeout(paso, 200));
    };
    paso();
  }

  /* Si el navegador bloqueó el video, aparece el botón grande en vez de una pantalla negra. */
  function revisarVideoDep(ms) {
    setTimeout(() => {
      const video = document.querySelector('#camaraDepVideo');
      if (!streamCamaraDep || document.querySelector('#modalCamaraDep').hidden) return;
      if (video.paused || !video.videoWidth) {
        document.querySelector('#camaraDepIniciar').hidden = false;
        estadoCamaraDep('Toque ▶ INICIAR VIDEO para ver la imagen.');
      } else {
        document.querySelector('#camaraDepIniciar').hidden = true;
        estadoCamaraDep('Cámara activa. Apunte al código de barras.');
      }
    }, ms);
  }

  async function abrirCamaraDep() {
    const video = document.querySelector('#camaraDepVideo');
    document.querySelector('#camaraDepIniciar').hidden = true;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      estadoCamaraDep('Este navegador no entrega la cámara. Escriba el código o use el lector USB.');
      document.querySelector('#camaraDepCodigo').focus();
      return;
    }
    if (streamCamaraDep) { arrancarVideoDep(); vigilarCodigosDep(); revisarVideoDep(300); return; }
    estadoCamaraDep('Abriendo la cámara…');
    try {
      montarVideoDep(await pedirCamaraDep());
    } catch (e) {
      estadoCamaraDep('No se pudo abrir la cámara. Escriba el código o use el lector USB.');
      document.querySelector('#camaraDepCodigo').focus();
      return;
    }
    await arrancarVideoDep();                    /* primer intento, dentro del mismo toque */
    detectorDep = detectorDep || crearDetectorDep();
    vigilarCodigosDep();
    revisarVideoDep(1500);
    if (video.paused) {
      document.querySelector('#camaraDepIniciar').hidden = false;
      estadoCamaraDep('Toque ▶ INICIAR VIDEO para ver la imagen.');
    } else {
      estadoCamaraDep('Cámara activa. Apunte al código de barras.');
    }
  }

  function cerrarCamaraDep() {
    if (streamCamaraDep) { streamCamaraDep.getTracks().forEach((t) => t.stop()); streamCamaraDep = null; }
    const video = document.querySelector('#camaraDepVideo');
    if (video) video.srcObject = null;
  }

  function mostrarCamaraDep() {
    document.querySelector('#modalFondo').hidden = false;
    document.querySelector('#modalCamaraDep').hidden = false;
    document.querySelector('#camaraDepCodigo').value = '';
    abrirCamaraDep();
  }
  function ocultarCamaraDep() {
    cerrarCamaraDep();
    document.querySelector('#modalCamaraDep').hidden = true;
    document.querySelector('#modalFondo').hidden = true;
  }

  document.querySelector('#depCamara').addEventListener('click', mostrarCamaraDep);
  /* Botón explícito: su toque es el gesto que los navegadores móviles exigen. */
  document.querySelector('#camaraDepIniciar').addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    estadoCamaraDep('Iniciando video…');
    const ok = await arrancarVideoDep();
    if (ok) {
      document.querySelector('#camaraDepIniciar').hidden = true;
      estadoCamaraDep('Cámara activa. Apunte al código de barras.');
      detectorDep = detectorDep || crearDetectorDep();
      vigilarCodigosDep();
    } else {
      estadoCamaraDep('El navegador bloqueó el video. Toque el recuadro negro o escriba el código.');
    }
  });
  document.querySelector('#camaraDepVideo').addEventListener('click', () => { arrancarVideoDep(); });
  document.querySelector('#camaraDepVideo').addEventListener('touchstart', () => { arrancarVideoDep(); }, { passive: true });
  document.querySelector('#camaraDepCerrar').addEventListener('click', ocultarCamaraDep);
  document.querySelector('#camaraDepUsar').addEventListener('click', () => {
    const cod = document.querySelector('#camaraDepCodigo').value;
    ocultarCamaraDep();
    aplicarCodigoDep(cod);
  });
  document.querySelector('#camaraDepCodigo').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); document.querySelector('#camaraDepUsar').click(); }
  });

  /* ---------- Código leído: autocompleta el campo y elige el producto ---------- */
  async function aplicarCodigoDep(cod) {
    const c = String(cod || '').trim();
    const campo = document.querySelector('#depCodigo');
    const ayuda = document.querySelector('#depCodigoAyuda');
    if (!c) return;
    campo.value = c;                    /* el campo de código de barra queda completo */
    try {
      const p = await api('/api/productos/codigo/' + encodeURIComponent(c));
      const sel = document.querySelector('#prodEntrada');
      sel.value = String(p.id);
      if (sel.value !== String(p.id)) { await recargar(); sel.value = String(p.id); }
      ayuda.textContent = `✓ ${p.nombre} · stock ${cantidad(p.stock)} ${p.unidad === 'KG' ? 'kg' : 'u.'}`;
      aviso(`✓ ${p.nombre} (${money(p.precio)}) elegido para el ingreso.`, 'ok');
      document.querySelector('#depFormEntrada [name="cantidad"]').focus();
    } catch (e) {
      ayuda.textContent = e.message;
      aviso(e.message, 'error');
    }
  }

  document.querySelector('#depCodigo').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); aplicarCodigoDep(ev.target.value); }
  });

  /* ---------- Al entrar a la vista ---------- */
  bus.addEventListener('vista', (ev) => {
    if (ev.detail === 'deposito') recargar().catch((e) => aviso(e.message, 'error'));
  });
});

