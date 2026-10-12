#!/usr/bin/env node
'use strict';
/*
  ═══════════════════════════════════════════════════════════════════════════
  360MAX COMERCIOS (AGUSTÍN) — CARGA DE LA LISTA DEFINITIVA (SQLite nativo)
  ═══════════════════════════════════════════════════════════════════════════
  - BORRA todo el catálogo actual (productos + su historial transaccional) y
    lo deja limpio.
  - CARGA la lista definitiva de Agustín con PRECIO DE VENTA EXACTO: el valor
    indicado en la lista se guarda como precio_fijo_centavos, que es lo que la
    caja cobra tal cual (src/lib/precios.js le da prioridad sobre cualquier
    margen). NO se aplica 10% ni ningún cálculo: el número escrito es el precio.
  - El costo se registra con el mismo valor para mantener la base coherente.
  - Idempotente por código de barras. Categorías con margen 0.

  USO
    node src/tools/cargar-lista-agustin.js
    npm run cargar-lista
*/

const { lista, prepare, transaction, DB_PATH } = require('../db');
const { nuevaClave } = require('../lib/claves');

/* Lista definitiva — [barcode, nombre, precioExacto, categoria] */
const PRODUCTOS = [
  ['77976956', 'lucky strike 20 convertible', 5200, 'Cigarrillos'],
  ['77912879', 'philips morris 20 comun', 5250, 'Cigarrillos'],
  ['77912954', 'philips morris 20 box comun', 5650, 'Cigarrillos'],
  ['77940735', 'philips morris convertible 20 box', 5650, 'Cigarrillos'],
  ['77941015', 'marlboro xl convertible', 6200, 'Cigarrillos'],
  ['77968401', 'marlboro xl coral', 62000, 'Cigarrillos'],
  ['77916433', 'marlboro 20 comun', 5800, 'Cigarrillos'],
  ['77993403', 'marlboro blue titanium', 6750, 'Cigarrillos'],
  ['77918482', 'marlboro 20 box comun', 6200, 'Cigarrillos'],
  ['77947550', 'marlboro xl uva', 6200, 'Cigarrillos'],
  ['77988225', 'marlboro crafted convertible box', 3650, 'Cigarrillos'],
  ['77987303', 'marlboro crafted 20 comun', 3650, 'Cigarrillos'],
  ['77973887', 'chesterfield uva 20', 5050, 'Cigarrillos'],
  ['77993397', 'marlboro crafted convertible comun', 3650, 'Cigarrillos'],
  ['77987297', 'marlboro crafted comun box', 4050, 'Cigarrillos'],
  ['77953513', 'chesterfield 20 comun', 4650, 'Cigarrillos'],
  ['77958099', 'marlboro crafted uva', 4050, 'Cigarrillos'],
  ['77983916', 'chesterfield convertible 20', 4650, 'Cigarrillos'],
  ['77989345', 'marlboro crafted coral', 4050, 'Cigarrillos'],
  ['77997142', 'camel legend 20 comun', 4050, 'Cigarrillos'],
  ['77941558', 'master', 1300, 'Cigarrillos'],
  ['77900883', 'red point', 1490, 'Cigarrillos'],
  ['77973085', 'red point six', 1770, 'Cigarrillos'],
  ['77959751', 'red point convertible', 1770, 'Cigarrillos'],
  ['77992536', 'philips red selec comun', 2250, 'Cigarrillos'],
  ['77981691', 'philips select convertible', 2250, 'Cigarrillos'],
  ['77980892', 'lucky strike origen box', 990, 'Cigarrillos'],
  ['77990921', 'lucky strike origen comun 20', 3010, 'Cigarrillos'],
  ['77980908', 'lucky strike origen convertible box', 3010, 'Cigarrillos'],
  ['77990938', 'lucky strike origen convertible 20', 3700, 'Cigarrillos'],
  ['77974907', 'red point 12 comun', 990, 'Cigarrillos'],
  ['77994059', 'chesterfield 12 comun', 3010, 'Cigarrillos'],
  ['77953964', 'chesterfield 12 convertible', 3010, 'Cigarrillos'],
  ['77983343', 'marlboro 12 comun', 3700, 'Cigarrillos'],
  ['77978141', 'marlboro 12 fusion', 3700, 'Cigarrillos'],
  ['77976505', 'lucky strike 12 comun', 990, 'Cigarrillos'],
  ['77976994', 'lucky strike 12 convertible', 990, 'Cigarrillos'],
  ['77981035', 'red point 12 convertible', 990, 'Cigarrillos'],
  ['77971913', 'philips morris 12 convertible', 3400, 'Cigarrillos'],
  ['77981813', 'philips morris 12 comun', 3360, 'Cigarrillos'],
  ['7312040350056', 'absolut raspberry', 28000, 'Bebidas Alcohólicas'],
  ['7312040350100', 'absolut vainilla', 28000, 'Bebidas Alcohólicas'],
  ['7792855002416', 'petaka cafe al coñac', 1500, 'Bebidas Alcohólicas'],
  ['7792855003154', 'petaka gin', 1500, 'Bebidas Alcohólicas'],
  ['7792855002485', 'petaka ron blanco', 1500, 'Bebidas Alcohólicas'],
  ['7792855002508', 'petaka vodka', 1494, 'Bebidas Alcohólicas'],
  ['7791200200866', 'sky vodka saborizado', 8000, 'Bebidas Alcohólicas'],
  ['7790070760579', 'vino benjamin malbec', 5500, 'Bebidas Alcohólicas'],
  ['7790070760821', 'vino nieto senetiner', 7000, 'Bebidas Alcohólicas'],
  ['7790036974057', 'vino ricordi malbec', 5500, 'Bebidas Alcohólicas'],
  ['7793755000236', 'AGUA FUENTE DEL MILAGRO 2L', 883, 'Almacén'],
  ['7798399700016', 'AGUA GRAZIANI 2L', 1077, 'Almacén'],
  ['77959003', 'alka strong', 270, 'Kiosco'],
  ['7798171946267', 'perservativo max super lubricado', 2900, 'Kiosco'],
  ['7798171946281', 'perservativo max texturado', 2900, 'Kiosco'],
  ['7798171946328', 'perservativo maxx super fino', 2900, 'Kiosco'],
  ['7790040133587', 'alfajor aguila clasica', 1180, 'Kiosco'],
  ['7790040659605', 'alfajor block', 1100, 'Kiosco'],
  ['7790040148840', 'alfajor bon o bon', 1179, 'Kiosco'],
  ['7790040150072', 'alfajor chocotorta', 1125, 'Kiosco'],
  ['77980274', 'alfajor guaymallen triple', 496, 'Kiosco'],
  ['7790040331204', 'alfajor tatin simple negro', 365, 'Kiosco'],
  ['77958921', 'bon o bon', 345, 'Kiosco'],
  ['7790580102852', 'chocolate leche y mani 80g', 1243, 'Kiosco'],
  ['7790580103446', 'chupetin pops azul', 4584, 'Kiosco'],
  ['7790580103361', 'chupetin pops rojo', 1145, 'Kiosco'],
  ['7790580103439', 'cofler aireado 100g', 2600, 'Kiosco'],
  ['7790580105013', 'cofler aireado 27g', 4800, 'Kiosco'],
  ['77953124', 'cofler aireado almendras 55g', 1278, 'Kiosco'],
  ['7790580115562', 'cofler almedras 55g', 5000, 'Kiosco'],
  ['7790580124274', 'cofler block mani 170g', 1500, 'Kiosco'],
  ['7790580103484', 'cofler block mani 38g', 2397, 'Kiosco'],
  ['7790580132750', 'cofler chocolate bon o bon', 4800, 'Kiosco'],
  ['7790040124509', 'cofler extra', 1322, 'Kiosco'],
  ['7790040143531', 'cofler leche 55g', 1116, 'Kiosco'],
  ['7790040143227', 'cofler miti miti 170g', 1486, 'Kiosco'],
  ['7790040154445', 'CRIOLLITA TOSTADA', 1240, 'Almacén'],
  ['7790040116955', 'GALLETA AMOR', 1310, 'Almacén'],
  ['7790040127944', 'GALLETA CHOCOLINA', 1450, 'Almacén'],
  ['7790040110748', 'GALLETA CHOCOLINA RELLENA', 1450, 'Almacén'],
  ['7790040377707', 'GALLETA COFLER BLOCK', 535, 'Almacén'],
  ['7790040137820', 'GALLETA COFLER COOKIES', 967, 'Almacén'],
  ['7790040133266', 'GALLETA COFLER ROCKLET', 1175, 'Almacén'],
  ['7790040133235', 'GALLETA CRIOLLITA', 1175, 'Almacén'],
  ['7790040137837', 'GALLETA MANA LIMON simple', 967, 'Almacén'],
  ['7790040143548', 'GALLETA MANA RELLENAS FRUTILLA', 1106, 'Almacén'],
  ['7790040139657', 'GALLETA MANA RELLENA VAINILLA', 1116, 'Almacén'],
  ['77903501', 'GALLETA MANA VAINILLA simple', 691, 'Almacén'],
  ['7790040132689', 'GALLETA MELLIZAS', 967, 'Almacén'],
  ['7790040719804', 'GALLETA MERENGADAS', 1624, 'Almacén'],
  ['7790040143517', 'GALLETA OPERA', 1240, 'Almacén'],
  ['7790040173200', 'GALLETA PORTEÑITA', 1624, 'Almacén'],
  ['7790040135895', 'GALLETA REX', 1036, 'Almacén'],
  ['7790580133030', 'GALLETA RUMBA', 480, 'Almacén'],
  ['7790580129330', 'GALLETAS KESITAS', 777, 'Almacén'],
  ['7790580129347', 'GALLETAS PEPAS', 777, 'Almacén'],
  ['7790580147808', 'gomitas cerebritos', 777, 'Kiosco'],
  ['7790580199913', 'gomitas mogul extreme', 400, 'Kiosco'],
  ['7790580200114', 'gomitas osito', 480, 'Kiosco'],
  ['7798186030593', 'gomitas tiburon', 388, 'Kiosco'],
  ['7794612066211', 'gongys', 770, 'Kiosco'],
  ['77944405', 'hamlet', 538, 'Kiosco'],
  ['77958662', 'menthoplus cherry', 400, 'Kiosco'],
  ['77958655', 'menthoplus menta', 400, 'Kiosco'],
  ['77944412', 'menthoplus miel', 538, 'Kiosco'],
  ['77980915', 'menthoplus naranja', 390, 'Kiosco'],
  ['77946805', 'menthoplus sandia', 538, 'Kiosco'],
  ['7798094340012', 'menthoplus zero cereza', 336, 'Kiosco'],
  ['7790580612719', 'mentitas menta', 777, 'Kiosco'],
  ['7790580155360', 'misky 25g', 777, 'Kiosco'],
  ['7790580117351', 'mogul extreme frutilla', 351, 'Kiosco'],
  ['7790580104382', 'mogul extreme picante', 735, 'Kiosco'],
  ['7790580104429', 'mogul masti confitados', 735, 'Kiosco'],
  ['7790580116880', 'mogul moritas', 380, 'Kiosco'],
  ['7790580131272', 'oblea bon o bon', 777, 'Kiosco'],
  ['7790580346515', 'oblea bon o bon mega', 770, 'Kiosco'],
  ['7790580143251', 'saladix caja duo', 1100, 'Almacén'],
  ['7790040374607', 'saladix caja pizza', 1315, 'Almacén'],
  ['7790580697303', 'saladix caja salame', 1315, 'Almacén'],
  ['7790580716806', 'SNACK PAPA FRITAS SALADIX', 1315, 'Almacén'],
  ['7790040153165', 'SNACK SALADIX 40G', 1797, 'Almacén'],
  ['7790040152021', 'topline', 587, 'Kiosco'],
  ['7790580146818', 'topline 7 mentol', 1000, 'Kiosco'],
  ['77964137', 'topline 7 mint', 798, 'Kiosco'],
  ['77931764', 'topline 7 naranja', 798, 'Kiosco'],
  ['77932693', 'topline 7 straw berry', 798, 'Kiosco'],
  ['77951113', 'topline 7 strong', 798, 'Kiosco'],
  ['77939753', 'topline menta', 798, 'Kiosco'],
  ['77993779', 'topline sandia', 400, 'Kiosco'],
  ['77948588', 'topline ultra menta verde', 785, 'Kiosco'],
  ['7790580120702', 'turron clasico', 1500, 'Kiosco'],
  ['77940148', 'turron rockclets 3x1000', 194, 'Kiosco'],
  ['77993540', 'turron rocklets', 194, 'Kiosco'],
  ['3265989', 'pepito 118', 1500, 'Almacén'],
  ['7792799000059', 'AGUA ECO 1,5L', 1489, 'Bebidas'],
  ['7792799000063', 'AGUA ECO con pico 1 L', 1615, 'Bebidas'],
  ['7798399700023', 'AGUA GRAZIANI 500CC', 500, 'Bebidas'],
  ['7798113300270', 'AGUA VILLAMANAOS 600 ML', 450, 'Bebidas'],
  ['7792798007387', 'BOTELLA QUILMES CLASICA 1L', 3000, 'Bebidas'],
  ['7792798003709', 'CORONA 330', 2800, 'Bebidas'],
  ['7792170042029', 'GATORATE FRUTAS TROPICALES 500 ML', 1704, 'Bebidas'],
  ['7792170042005', 'GATORATE MANZANA 500 ML', 1704, 'Bebidas'],
  ['7791813777021', 'LATA SEVEN UP 354 ML', 946, 'Bebidas'],
  ['7791813050582', 'LATA SEVEN UP CERO 354 ML', 946, 'Bebidas'],
  ['7792798015474', 'LATA STELLA ARATOIS PURE GOLD', 2910, 'Bebidas'],
  ['7792798010615', 'LATA STELLA ARTOIS', 2910, 'Bebidas'],
  ['7791813800774', 'LATA TONICA 269 ML', 666, 'Bebidas'],
  ['7792798015511', 'LATON 1890', 2167, 'Bebidas'],
  ['7792798014835', 'LATON QUILMES CLASICA', 2372, 'Bebidas'],
  ['7792798013975', 'LATON STELLA ARTOIS', 4037, 'Bebidas'],
  ['7798062548716', 'LEVITE MANZANA 500 ML', 1233, 'Bebidas'],
  ['7798062548655', 'LEVITE NARANJA 500 ML', 1233, 'Bebidas'],
  ['7798062540260', 'LEVITE PERA 500 ML', 1233, 'Bebidas'],
  ['7798062548686', 'LEVITE POMELO 500 ML', 1233, 'Bebidas'],
  ['7791813420156', 'MIRINDA 500 ML', 1325, 'Bebidas'],
  ['7791813420385', 'PASO DE LOS TOROS 500ML', 1325, 'Bebidas'],
  ['7791813888413', 'PEPSI 1,5 L', 2900, 'Bebidas'],
  ['7791813888468', 'PEPSI 2 L', 2802, 'Bebidas'],
  ['7791813888406', 'PEPSI 500 ML', 1325, 'Bebidas'],
  ['7790895640032', 'POWERADE NARANJA 500 ML', 1582, 'Bebidas'],
  ['7791813111252', 'ROCKSTAR BERRIES', 1409, 'Bebidas'],
  ['7791813111214', 'ROCKSTAR CLASICA', 1409, 'Bebidas'],
  ['7798399700047', 'SODA GRAZIANI 500CC', 749, 'Bebidas'],
  ['7790895000782', 'COCA ORIGINAL 500 ML', 1300, 'Bebidas'],
  ['7790895067532', 'COCA ZERO 500 ML', 1300, 'Bebidas'],
  ['7790895067587', 'LATA COCA CERO 354 ML', 1100, 'Bebidas'],
  ['7790895000232', 'LATA COCA COMUN 354 ML', 1100, 'Bebidas'],
  ['7798422620045', 'MONSTER MANGO LOCO', 2400, 'Bebidas'],
  ['7798422620014', 'MONSTER ORIGINAL 473 ML', 2400, 'Bebidas'],
  ['7798119220183', 'SPEED 473 ML', 2200, 'Bebidas'],
  ['7790895000829', 'SPRITE COMUN 500 ML', 1300, 'Bebidas'],
  ['7790895064142', 'SPRITE ZERO 500 ML', 1300, 'Bebidas'],
  ['7790036000336', 'baggio manzana 1L', 1510, 'Almacén'],
  ['7790036000466', 'baggio multifruta 1L', 1510, 'Almacén'],
  ['7790036000329', 'baggio naranja 1L', 1510, 'Almacén'],
  ['7790895009846', 'CEPITA DURAZNO 1L', 2600, 'Almacén'],
  ['7790895009815', 'cepita naranja 1L', 2560, 'Almacén'],
  ['7790036972602', 'chocolatada baggio 200ml', 544, 'Almacén'],
  ['7790895005374', 'COCA cola 1.25 RETORNABLE', 2500, 'Bebidas'],
  ['7790895000430', 'coca cola 1.5L', 3600, 'Bebidas'],
  ['7790895001413', 'COCACOLA 1L', 2400, 'Bebidas'],
  ['7790895005794', 'COCACOLA 2.5L', 4000, 'Bebidas'],
  ['7790895000218', 'COCACOLA 2L RETORNABLE', 3167, 'Bebidas'],
  ['7790895068164', 'COCACOLA RETORNABLE 2.5', 3750, 'Bebidas'],
  ['7790895067556', 'coca cola zero 1,5', 3500, 'Bebidas'],
  ['7790895000454', 'FANTA 1.5 L', 3205, 'Bebidas'],
  ['7790036001579', 'fresh pomelo 1.5', 1183, 'Bebidas'],
  ['7790036000589', 'juguito baggio 200 ml durazno', 450, 'Kiosco'],
  ['7790036000602', 'juguito baggio 200 ml mix frutal', 450, 'Kiosco'],
  ['7790036000565', 'juguito naranja baggio 200 ml', 450, 'Kiosco'],
  ['7790895000270', 'LATA SPRITE 354 ML', 1185, 'Bebidas'],
  ['7791813555100', 'seven up 2.25L', 2596, 'Bebidas'],
  ['7790895000447', 'sprite 1.5L', 3500, 'Bebidas'],
  ['779003601678', 'FRESH MULTIFRUTA 1,5 L', 1179, 'Bebidas'],
  ['7790036974378', 'FRESH MULTIFRUTA 600 ML', 925, 'Bebidas'],
  ['7790036974347', 'FRESH NARANJA 600 ML', 925, 'Bebidas'],
  ['7798054013291', 'LATA 361', 933, 'Bebidas'],
  ['7793147118860', 'LATA schneider', 1667, 'Bebidas'],
  ['7798054013697', 'LATON 361', 1566, 'Bebidas'],
  ['7793147570606', 'LATON SHNEIDER', 2200, 'Bebidas'],
  ['7798113301260', 'MANAOS NARANJA 3 L', 1500, 'Bebidas'],
  ['7798113300225', 'MANAOS NARANJA 600 ML', 700, 'Bebidas'],
  ['7798119220015', 'SPEED 250 ML', 1486, 'Bebidas'],
  ['7798183772076', 'FRUTA BAÑDA EN CHOCOLATE FRUTILLA', 5500, 'Kiosco'],
  ['7798183772069', 'FRUTA BAÑADA EN CHOCLATE FRAMBUESAS', 5500, 'Kiosco'],
  ['7798183770409', 'BOMBON CROCANTE', 1212.5, 'Kiosco'],
  ['7798183770447', 'PALITO BOMBON', 630, 'Kiosco'],
  ['7798183772359', 'PALITO BOMBON DULCE DE LECHE', 630, 'Kiosco'],
  ['7798183770454', 'PALITO CREMOSO CREMA AMERICANA', 450, 'Kiosco'],
  ['7798183770461', 'PALITO CREMOSO FRUTILLA', 450, 'Kiosco'],
  ['7798183770492', 'PALITO FRUTAL NARANJA', 380, 'Kiosco'],
  ['7790310983461', '3d 23g', 767, 'Almacén'],
  ['7790310985830', '3D 85G', 2066, 'Almacén'],
  ['7790310985113', '3D QUESO 43g', 1642, 'Almacén'],
  ['7790310985793', 'CHEETOS 140 G', 4000, 'Almacén'],
  ['7790310985274', 'CHEETOS 43G', 1357, 'Almacén'],
  ['7790310985809', 'cheetos 84g', 2066, 'Almacén'],
  ['7790310988282', 'DORITO PIZZA 74 G', 2500, 'Almacén'],
  ['7790310985656', 'DORITOS 129 G', 3305, 'Almacén'],
  ['07903107', 'DORITOS 200G', 5930, 'Almacén'],
  ['7790310987605', 'DORITOS 20G', 1000, 'Almacén'],
  ['7790310985267', 'DORITOS 40 G', 1700, 'Almacén'],
  ['7790310987575', 'DORITOS FLAMINHOT 45G', 1642, 'Almacén'],
  ['7790310983614', 'lays 20g', 767, 'Almacén'],
  ['7790310988220', 'LAYS ASADO 77G', 2500, 'Almacén'],
  ['7790310987766', 'LAYS BARBACOA 77G', 2500, 'Almacén'],
  ['7790310985465', 'LAYS CLASICAS 134 G', 4000, 'Almacén'],
  ['7790310984734', 'LAYS CLASICAS 230 G', 5930, 'Almacén'],
  ['7790310985236', 'LAYS CLASICAS 40G', 1642, 'Almacén'],
  ['7790310985458', 'LAYS CLASICAS 85G', 2500, 'Almacén'],
  ['7790310985328', 'LAYS FLAMINHOT 70G', 2500, 'Almacén'],
  ['7790310985434', 'LAYS JAMON SERRANO 77G', 2214, 'Almacén'],
  ['7790310986813', 'LAYS PROVOLETA 77G', 2213, 'Almacén'],
  ['7790310985557', 'LAYS QUESO Y CEBOLLA 77G', 2500, 'Almacén'],
  ['7790310988480', 'lays sal marina 85g', 2479, 'Almacén'],
  ['7790310006818', 'PALITOS PEP 40G', 1000, 'Almacén'],
  ['7790310984291', 'PALITOS PEP 84G', 1642, 'Almacén'],
  ['7790310987742', 'pehuamar acanaladaas 90g', 1537, 'Almacén'],
  ['7790310983874', 'PEHUAMAR MANI PELADO', 1642, 'Almacén'],
  ['7790310987681', 'pehuamar matambrito 90g', 1600, 'Almacén'],
  ['7790310987759', 'pehuamar papas lisa 90g', 1600, 'Almacén'],
  ['7790310984314', 'pep rueditas 74g', 1357, 'Almacén'],
  ['7790310985168', 'RAMITAS PEP 40G', 1000, 'Almacén'],
  ['7790310920398', 'RUEDITAS PEP 40G', 1000, 'Almacén'],
  ['7790310987094', 'twistos jamon 40g', 1357, 'Almacén'],
  ['7790310987100', 'twistos queso 40g', 1357, 'Almacén'],
  ['77980212', 'alfajor guaymallen blanco simple', 359, 'Kiosco'],
  ['77980229', 'alfajor guaymallen simple negro', 359, 'Kiosco'],
  ['7798397444202', 'alfajor rasta', 1317, 'Kiosco'],
  ['7798397440013', 'alfajor rasta blanco', 1200, 'Kiosco'],
  ['77991584', 'fantoche triple blanco', 982, 'Kiosco'],
  ['77991577', 'fantoche triple negro', 982, 'Kiosco'],
  ['7899970402814', 'hersey chocolate 82g', 2537, 'Kiosco'],
  ['7899970402852', 'hersey cookies and cream 77g', 2500, 'Kiosco'],
  ['7790250000358', 'pañueitos elite', 189, 'Almacén'],
  ['7791519200076', 'perservativo prime espermicida', 2900, 'Kiosco'],
  ['8414775017033', 'filtros smoking', 1145, 'Kiosco'],
  ['30052765', 'papelillo ocb', 1000, 'Kiosco'],
  ['7798096700012', 'tabaco las hojas', 4700, 'Kiosco'],
  ['7793755000038', 'SODA TALCA 2.25 ML', 900, 'Bebidas'],
  ['7793755000083', 'TALCA LIMA LIMON 3L', 1900, 'Bebidas'],
  ['7793755000090', 'TALCA POMELO 3L', 1900, 'Bebidas'],
  ['7793755000304', 'TALCA SODA SIFON 2000 CC', 1200, 'Bebidas'],
  ['77903778', 'alfajor milka dulce de leche', 1462, 'Kiosco'],
  ['7622300457303', 'alfajor milka mousse blanko', 1462, 'Kiosco'],
  ['7622300835620', 'alfajor milka oreo triple', 1163, 'Kiosco'],
  ['77956699', 'alfajor shot triple', 1496, 'Kiosco'],
  ['7790040405608', 'alfajor tatin triple negro', 710, 'Kiosco'],
  ['7622202296291', 'alfajor terrabussi intenso', 1600, 'Kiosco'],
  ['77958990', 'alka cherry', 270, 'Kiosco'],
  ['77958983', 'alka menta', 270, 'Kiosco'],
  ['7790380020240', 'barra cereal flow', 974, 'Kiosco'],
  ['77969118', 'beldent frutilla', 600, 'Kiosco'],
  ['77969088', 'beldent menta', 600, 'Kiosco'],
  ['77969071', 'beldent menta verde', 600, 'Kiosco'],
  ['77969095', 'beldent mentol', 600, 'Kiosco'],
  ['77987686', 'beldent sandia', 600, 'Kiosco'],
  ['77969101', 'beldent tutti frutti', 600, 'Kiosco'],
  ['7798186034751', 'bubaloo frutilla', 250, 'Kiosco'],
  ['7798186034737', 'bull dog acido', 250, 'Kiosco'],
  ['7790580033507', 'bull dog frutilla', 2397, 'Kiosco'],
  ['7622202271328', 'cofler almendras', 600, 'Kiosco'],
  ['7622202271267', 'halls miel', 600, 'Kiosco'],
  ['77901095', 'halls strong', 600, 'Kiosco'],
  ['7622201818937', 'menthoplus strong', 3147, 'Kiosco'],
  ['7622201818975', 'milka aireado 50g', 3147, 'Kiosco'],
  ['7622210745620', 'milka aireado almendras 50g', 3147, 'Kiosco'],
  ['7622210745293', 'milka almendras 55 g', 3147, 'Kiosco'],
  ['7622202328947', 'milka castaña caramelo', 5500, 'Kiosco'],
  ['7622210745132', 'milka leche 55g', 3147, 'Kiosco'],
  ['7622202839962', 'milka oreo 55', 2190, 'Kiosco'],
  ['6902004095218', 'encendedor candela', 300, 'Kiosco'],
  ['4067700014559', 'jaggermaifter', 25000, 'Bebidas Alcohólicas'],
  ['7500810034477', 'takis', 2200, 'Almacén'],
  ['7500810034484', 'takis explosion', 2500, 'Almacén'],
  ['7790310985175', 'RAMITAS PEP 84G', 1500, 'Almacén'],
  ['7790310985649', 'DORITOS 77G', 2500, 'Almacén'],
  ['7790310987926', 'doritos flamin hot 82g', 2300, 'Almacén'],
  ['7790310984321', 'pep rueditas 120g', 2500, 'Almacén']
];

const CATEGORIAS = [...new Set(PRODUCTOS.map((p) => p[3]))];

function linea(c) { console.log('─'.repeat(64)); if (c) console.log(c); }
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function asegurarAdmin() {
  const ya = await prepare('SELECT id FROM usuarios ORDER BY id LIMIT 1').get();
  if (ya) return ya.id;
  const usuario = process.env.ADMIN_USUARIO || 'administrador';
  const nombre = process.env.ADMIN_NOMBRE || 'Agustín';
  const clave = process.env.ADMIN_CLAVE || 'demo360max!';
  const salt = nuevaClave(String(Date.now()) + '-' + Math.random(), 'x');
  const hash = nuevaClave(String(clave), salt);
  const r = await prepare(
    'INSERT INTO usuarios (nombre, usuario, rol, clave_hash, clave_salt) VALUES (?, ?, ?, ?, ?)'
  ).run(nombre, usuario, 'administrador', hash, salt);
  return r.lastInsertRowid;
}

async function asegurarCategorias() {
  const ids = {};
  for (const nombre of CATEGORIAS) {
    const ex = await prepare('SELECT id FROM categorias WHERE nombre = ? COLLATE NOCASE').get(nombre);
    if (ex) {
      ids[nombre] = ex.id;
      await prepare('UPDATE categorias SET margen_ganancia_defecto = 0 WHERE id = ?').run(ex.id);
    } else {
      const r = await prepare(
        'INSERT INTO categorias (nombre, margen_ganancia_defecto) VALUES (?, 0)'
      ).run(nombre);
      ids[nombre] = r.lastInsertRowid;
    }
  }
  return ids;
}

async function limpiarCatalogo() {
  // Borrado físico en orden hijo→padre para no violar claves foráneas.
  await prepare('DELETE FROM venta_items').run();
  await prepare('DELETE FROM venta_pagos').run();
  await prepare('DELETE FROM ventas').run();
  await prepare('DELETE FROM movimientos').run();
  await prepare('DELETE FROM productos').run();
}

async function main() {
  await lista; // abre y migra la base
  console.log('═'.repeat(64));
  console.log('  360MAX — CARGA LISTA DEFINITIVA DE AGUSTÍN  ·  base: ' + DB_PATH);
  console.log('═'.repeat(64));
  console.log('  Productos en la lista: ' + PRODUCTOS.length);
  console.log('  Categorías: ' + CATEGORIAS.join(', '));
  console.log('');

  const adminId = await asegurarAdmin();
  const catIds = await asegurarCategorias();

  let insertados = 0, omitidos = 0;
  const vistos = new Set();

  await transaction(async () => {
    await limpiarCatalogo();
    for (const [cod, nombre, precioExacto, catNombre] of PRODUCTOS) {
      if (vistos.has(cod)) { omitidos++; continue; }
      vistos.add(cod);
      const cid = catIds[catNombre];
      if (!cid) { omitidos++; continue; }

      const precioCent = Math.round(Number(precioExacto) * 100);
      const precio = Number(precioExacto);
      const r = await prepare(
        `INSERT INTO productos
           (nombre, categoria_id, unidad, codigo_barra, costo, costo_centavos, precio, precio_fijo_centavos, stock, stock_minimo, activo)
         VALUES (?, ?, 'UNIDAD', ?, ?, ?, ?, ?, 0, 0, 1)`
      ).run(nombre, cid, cod, precio, precioCent, precio, precioCent);
      await prepare(
        `INSERT INTO movimientos (producto_id, tipo, cantidad, stock_despues, usuario_id, motivo)
         VALUES (?, 'entrada', 0, 0, ?, 'Carga lista definitiva Agustín')`
      ).run(r.lastInsertRowid, adminId);
      insertados++;
    }
  })();

  const total = (await prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1').get()).n;
  const conFijo = (await prepare('SELECT COUNT(*) n FROM productos WHERE activo = 1 AND precio_fijo_centavos > 0').get()).n;

  linea();
  console.log('  Productos cargados .................: ' + insertados);
  console.log('  Omitidos (duplicados) ..............: ' + omitidos);
  console.log('  Activos en la base .................: ' + total + ' (' + conFijo + ' con precio fijo exacto)');
  linea();
  console.log(total === vistos.size
    ? '✓ LISTA CARGADA. Precio de venta = valor exacto de la lista (sin 10% ni cálculos).'
    : '✗ Revisar: quedaron menos productos activos que los esperados.');
  linea();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('✗ ERROR cargando la lista: ' + e.message);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { PRODUCTOS, main };
