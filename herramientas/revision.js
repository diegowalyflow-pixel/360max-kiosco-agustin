'use strict';
/* Revisión estática del proyecto de COMERCIOS (no toca el proyecto de boliches).
   Comprueba, sin PowerShell y sin dependencias:
     1) que cada .js de src/ y public/ parsea (node --check);
     2) que no queden caracteres de codificación corruptos (mojibake);
     3) que el HTML tenga los contenedores que el JS espera.
   Uso: node herramientas/revision.js
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const OBJETIVOS = ['src', 'public'];

/* El proyecto de boliches vive DENTRO de public/ pero es otro sistema:
   se excluye explícitamente para no auditarlo ni modificarlo. */
const EXCLUIDOS = ['proyecto-360-max-pr', 'node_modules', '.git', 'data'];

function archivos(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUIDOS.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (/\.(js|css|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/* Secuencias típicas de texto leído como latin-1 y vuelto a guardar como UTF-8. */
const MOJIBAKE = [
  'Ã¡', 'Ã©', 'Ã­', 'Ã³', 'Ãº', 'Ã±', 'Ã¼', 'Ã¤', 'Ã¶',
  'Ã\x82', 'Ã\x83', 'Â°', 'Â©', 'â\x80\x99', 'â\x80\x93', 'â\x80\x94',
  'â\x80\x9C', 'â\x80\x9D', 'â\x80\xA6', 'â\x80\xA2', 'â\x82¬', 'â\x80\x93'
];

let fallos = 0;
const lista = OBJETIVOS.flatMap((d) => archivos(path.join(RAIZ, d), []));

console.log('Revisando ' + lista.length + ' archivos de comercios...\n');

/* 1) Sintaxis */
for (const f of lista) {
  if (!f.endsWith('.js')) continue;
  const rel = path.relative(RAIZ, f);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('  [ok  ] ' + rel);
  } catch (e) {
    fallos++;
    console.log('  [FALLA] ' + rel + '\n' + String(e.stderr || e.message).trim());
  }
}

/* 2) Codificación */
console.log('');
for (const f of lista) {
  const rel = path.relative(RAIZ, f);
  const buf = fs.readFileSync(f);
  const texto = buf.toString('utf8');
  const roto = buf.includes(0xFFFD);
  const sucios = MOJIBAKE.filter((m) => texto.includes(m));
  if (roto || sucios.length) {
    fallos++;
    console.log('  [FALLA] ' + rel + (roto ? ' (byte inválido UTF-8)' : '') +
      (sucios.length ? ' secuencias corruptas: ' + sucios.join(', ') : ''));
  } else {
    console.log('  [ok  ] ' + rel + ' (UTF-8 limpio)');
  }
}

/* 3) Anclas del HTML que el JS busca por id */
console.log('');
const html = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const ANCLAS = ['posBuscar', 'ticketImpresion', 'estiloTicket', 'formApertura',
  'modalTicket', 'ticketImprimir', 'posCobrar', 'posPrincipal', 'posVender',
  'autoImprimir', 'espejoContenido', 'espejoRefrescar',
  'tarjetaPrecios', 'margenesLista', 'precioBuscar', 'precioResultados', 'precioFijo'];
for (const a of ANCLAS) {
  const ok = new RegExp('id="' + a + '"').test(html);
  if (!ok) { fallos++; console.log('  [FALLA] falta el contenedor #' + a); }
  else console.log('  [ok  ] #' + a);
}

console.log('\n' + (fallos ? 'REVISION CON ' + fallos + ' FALLA(S)' : 'REVISION LIMPIA: todo correcto.'));
process.exit(fallos ? 1 : 0);
