'use strict';
const fs = require('fs');
const path = require('path');
const root = 'c:\\Users\\DIego\\.cline\\data\\workspaces\\chat\\360max-comercios\\public';
const files = fs.readdirSync(root).filter((f) => /\.(js|html|css)$/.test(f));
const mapa = [
  ['\u00c3\u00b1', '\u00f1'], ['\u00c3\u00b3', '\u00f3'], ['\u00c3\u00a9', '\u00e9'],
  ['\u00c3\u00a1', '\u00e1'], ['\u00c3\u00ad', '\u00ed'], ['\u00c3\u00ba', '\u00fa'],
  ['\u00c3\u0081', '\u00c1'], ['\u00c3\u0089', '\u00c9'], ['\u00c3\u008d', '\u00cd'],
  ['\u00c3\u0093', '\u00d3'], ['\u00c3\u009a', '\u00da'], ['\u00c3\u0091', '\u00d1'],
  ['\u00c3\u00bc', '\u00fc'], ['\u00c3\u201c', '\u00d3'],
  ['\u00c2\u00a1', '\u00a1'], ['\u00c2\u00bf', '\u00bf'],
  ['\u00c3\u00af', '\u00ef'], ['\u00c3\u00b6', '\u00f6'],
  ['\u00e2\u20ac\u201c', '\u2014'], ['\u00e2\u20ac\u201d', '\u2019'],
  ['\u00e2\u20ac\u2122', '\u2019'], ['\u00e2\u20acœ', '\u201c'],
  ['\u00e2\u20ac', '\u2013'], ['\u00e2\u201c\u00a1', '\u2713'],
  ['\u00e2\u0153\u201c', '\u2713'], ['\u00e2\u0153\u00af', '\u26a0'],
  ['\u00e2\u20ac\u00a2', '\u2022'], ['\u00c3\u00a2', '\u00e2']
];
let n = 0;
for (const f of files) {
  const p = path.join(root, f);
  let t = fs.readFileSync(p, 'utf8');
  const o = t;
  for (const [a, b] of mapa) t = t.split(a).join(b);
  if (t !== o) { fs.writeFileSync(p, t, 'utf8'); console.log('EDIT ' + f); n++; }
}
console.log('done ' + n);
