import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { FUELS, fuelById, catalog, loadFuel, provinceHistory, stationHistory, searchPlaces, geocode, parseFecha } from './api.js';
import { openStatus } from './horario.js';
import { SANDERO, GLP, tankFor, consFor, costPer100, rangeKm, netSaving, sanitizeCar } from './car.js';
import { OFFERS, VERIFIED, activeOffers, offerMatches, isExpired, fmtDate } from './offers.js';

// ======================= Preferencias (solo en este navegador) =======================
const PREFS_KEY = 'surtidor:v1:prefs';
const DEFAULTS = {
  fuels: ['17', '1'], primary: '17', sort: 'price', radius: 10, openNow: false, lowcost: false, brand: '',
  center: null, favorites: [], discounts: [], car: { ...SANDERO },
};
const prefs = (() => {
  let p;
  try { p = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { p = { ...DEFAULTS }; }
  p.car = sanitizeCar(p.car);
  delete p.tank;                                   // versión anterior: un único depósito genérico
  if (!p.fuels.includes(p.car.gasFuel)) p.fuels = FUELS.map(f => f.id).filter(x => x === p.car.gasFuel || p.fuels.includes(x));
  // Las ofertas caducadas dejan de aplicarse solas; avisamos una vez.
  const expired = p.discounts.filter(d => d.offer && isExpired(d.offer));
  if (expired.length) {
    p.discounts = p.discounts.filter(d => !expired.includes(d));
    p.expiredNotice = expired.map(d => d.label || d.offer).join(', ');
  }
  return p;
})();
const car = () => prefs.car;
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* sin almacenamiento */ } };
const favs = new Set(prefs.favorites);
const saveFavs = () => { prefs.favorites = [...favs]; savePrefs(); };

const EXAMPLE_CENTER = { lat: 40.4168, lon: -3.7038, label: 'Madrid (ejemplo)', example: true };
let center = prefs.center || EXAMPLE_CENTER;

// ======================= Estado =======================
const fuelData = new Map();          // fuelId -> {fecha, prices}
const loading = new Map();           // fuelId -> Promise
const flags = new Map();             // stationId -> [{type, text}]
let results = [];
let tab = 'near';
let activeId = null;
let meMarker = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

// ======================= Utilidades =======================
function km(a, b) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = d => d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(d < 10 ? 1 : 0).replace('.', ',')} km`;
/** 1.529 -> "1,52<sup>9</sup>" como en los totems de las gasolineras. */
function priceHTML(p) {
  const s = p.toFixed(3).replace('.', ',');
  return `${s.slice(0, -1)}<sup>${s.slice(-1)}</sup>`;
}
const priceText = p => p.toFixed(3).replace('.', ',');
const euros = v => v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const LOWCOST = /PLENOIL|BALLENOIL|PETROPRIX|EASYGAS|ESCLATOIL|BON ?AREA|GASEXPRESS|VALCARCE|CARREFOUR|ALCAMPO|COSTCO|LECLERC|EROSKI|AUTONETOIL|AHORRAMAS|LOW ?COST|FAST ?FUEL|STAR ?OIL|PETROALACANT/;

const applyDisc = (d, p) => Math.max(0, d.type === 'pct' ? p * (1 - d.value / 100) : p - d.value / 100);
const offerById = id => OFFERS.find(o => o.id === id);
/** El descuento que más rebaja este precio en esta gasolinera (tuyos o de ofertas que tienes). */
function discountFor(station, p = 1.5) {
  const n = norm(station.name);
  let best = null, bestEff = p;
  for (const d of prefs.discounts) {
    const o = d.offer && offerById(d.offer);
    const hit = o ? offerMatches(o, station.name) : (d.brand && n.includes(norm(d.brand)));
    if (!hit) continue;
    const e = applyDisc(d, p);
    if (e < bestEff) { best = d; bestEff = e; }
  }
  return best;
}
function effective(station, p) {
  const d = discountFor(station, p);
  return d ? applyDisc(d, p) : p;
}
function discountLabel(d) {
  const v = d.type === 'pct' ? `−${String(d.value).replace('.', ',')} %` : `−${String(d.value).replace('.', ',')} cént/L`;
  return d.offer ? `${v} · ${d.label}` : v;
}

// ======================= Ofertas =======================
const hasOffer = id => prefs.discounts.some(d => d.offer === id);
function toggleOffer(id) {
  const o = offerById(id);
  if (!o) return;
  if (hasOffer(id)) prefs.discounts = prefs.discounts.filter(d => d.offer !== id);
  else prefs.discounts.push({ offer: id, brand: o.brand, label: o.title.split(':')[0], value: o.value, type: o.type });
  savePrefs();
}
function offerCard(o, compact = false) {
  const on = hasOffer(o.id);
  const glp = o.glp === 'sí' ? '<span class="tag ok">Vale para GLP</span>' : '<span class="tag">GLP: no consta</span>';
  const until = o.until ? `Hasta el ${fmtDate(o.until)}` : 'Sin fecha de fin';
  const conf = { alta: 'Fuente oficial o prensa reciente', media: 'Según comparadores', baja: 'Dato aproximado' }[o.confidence];
  return `<article class="offer ${on ? 'on' : ''}" data-offer="${o.id}">
    <div class="o-top"><span class="o-brand">${esc(o.brand)}</span>${glp}</div>
    <h3>${esc(o.title)}</h3>
    <p class="o-meta">${esc(until)} · ${esc(o.mode)} · ${esc(conf)}</p>
    ${compact ? '' : `<p class="o-needs">${esc(o.needs)}</p>`}
    <div class="o-actions">
      <button type="button" class="btn ${on ? '' : 'primary'}" data-toggle-offer="${o.id}" aria-pressed="${on}">${on ? 'Aplicada · quitar' : 'La tengo · aplicar'}</button>
      <a href="${esc(o.url)}" target="_blank" rel="noopener" class="link">Ver fuente</a>
    </div>
  </article>`;
}
function renderOffers() {
  const list = activeOffers().sort((a, b) => (a.glp === 'sí' ? -1 : 0) - (b.glp === 'sí' ? -1 : 0));
  $('o-intro').textContent = `Comprobadas el ${fmtDate(VERIFIED)}. Si marcas «La tengo», su descuento se resta en los precios de esa marca. Las de saldo o cheque solo ahorran si luego lo gastas. Caducan solas en su fecha.`;
  $('o-list').innerHTML = list.map(o => offerCard(o)).join('');
}
function openOffers() { renderOffers(); $('offers').showModal(); }
document.addEventListener('click', e => {
  const b = e.target.closest('[data-toggle-offer]');
  if (!b) return;
  toggleOffer(b.dataset.toggleOffer);
  if ($('offers').open) renderOffers();
  update();
  if (activeId) renderDetail(activeId, false);
});

// ======================= Mapa =======================
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([center.lat, center.lon], 12);
// Mapa base: OpenFreeMap (vectorial, gratis, sin clave y sin depender del Referer).
// El servidor público de OpenStreetMap devuelve «Access blocked» (403) a los móviles que no envían
// Referer (Safari con protección de privacidad, Brave, Firefox, bloqueadores…), así que solo se usa
// como reserva si el dispositivo no tiene WebGL o OpenFreeMap no responde.
const ATTR_OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const styleUrl = () => `https://tiles.openfreemap.org/styles/${dark.matches ? 'dark' : 'liberty'}`;
function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
let baseLayer = null;
function useRasterFallback(reason) {
  if (baseLayer && baseLayer.options?.className === 'osm-tiles') return;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'osm-tiles', referrerPolicy: 'strict-origin-when-cross-origin', attribution: ATTR_OSM,
  }).addTo(map);
  baseLayer.bringToBack();
  document.documentElement.dataset.map = `osm (${reason})`;
}
// MapLibre pesa ~300 KB: se carga aparte para que la lista y los precios no lo esperen.
async function initBaseMap() {
  if (!hasWebGL()) return useRasterFallback('sin WebGL');
  try {
    const [{ maplibreGL }] = await Promise.all([
      import('@maplibre/maplibre-gl-leaflet'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ]);
    if (baseLayer) return;      // ya se pasó a la reserva
    baseLayer = maplibreGL({ style: styleUrl(), attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> ${ATTR_OSM}` }).addTo(map);
    const gl = baseLayer.getMaplibreMap();
    // El estilo de OpenFreeMap referencia alguna textura que no trae (p. ej. "wood-pattern"):
    // se rellena con un píxel transparente para no llenar la consola de avisos.
    gl.on('styleimagemissing', e => {
      if (!gl.hasImage(e.id)) gl.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    let loaded = false;
    gl.once('load', () => { loaded = true; document.documentElement.dataset.map = 'openfreemap'; });
    setTimeout(() => { if (!loaded) useRasterFallback('OpenFreeMap no respondió'); }, 12000);
    dark.addEventListener?.('change', () => { if (baseLayer?.getMaplibreMap) baseLayer.getMaplibreMap().setStyle(styleUrl()); });
  } catch {
    useRasterFallback('error al cargar el mapa vectorial');
  }
}
initBaseMap();
const markers = L.layerGroup().addTo(map);
const radiusCircle = L.circle([center.lat, center.lon], { radius: 1, color: '#1f56a8', weight: 1, opacity: .5, fillOpacity: .04, interactive: false }).addTo(map);
let programmatic = false;
function fitToRadius() {
  programmatic = true;
  radiusCircle.setLatLng([center.lat, center.lon]).setRadius(prefs.radius * 1000);
  map.fitBounds(radiusCircle.getBounds(), { padding: [10, 10] });
  setTimeout(() => { programmatic = false; }, 400);
  $('search-here').hidden = true;
}
map.on('zoomend', () => renderMarkers());
map.on('moveend', () => {
  if (programmatic) return;
  const c = map.getCenter();
  $('search-here').hidden = km(center, { lat: c.lat, lon: c.lng }) < Math.max(1, prefs.radius * 0.35);
});
$('search-here').addEventListener('click', () => {
  const c = map.getCenter();
  setCenter({ lat: c.lat, lon: c.lng, label: 'esta zona' }, { fit: false });
  $('search-here').hidden = true;
});

// ======================= Controles =======================
function renderFuelChips() {
  $('fuels').innerHTML = FUELS.map(f =>
    `<button type="button" class="chip" data-fuel="${f.id}" aria-pressed="${prefs.fuels.includes(f.id)}" title="${esc(f.long)}">${esc(f.label)}</button>`).join('');
  $('primary').innerHTML = FUELS.filter(f => prefs.fuels.includes(f.id))
    .map(f => `<option value="${f.id}" ${f.id === prefs.primary ? 'selected' : ''}>${esc(f.long)}</option>`).join('');
}
$('fuels').addEventListener('click', e => {
  const b = e.target.closest('[data-fuel]');
  if (!b) return;
  const id = b.dataset.fuel;
  if (prefs.fuels.includes(id)) {
    if (prefs.fuels.length === 1) return;          // siempre al menos un combustible
    prefs.fuels = prefs.fuels.filter(x => x !== id);
    if (prefs.primary === id) prefs.primary = prefs.fuels[0];
  } else {
    prefs.fuels = FUELS.map(f => f.id).filter(x => x === id || prefs.fuels.includes(x));
    ensureFuel(id).then(update);
  }
  savePrefs(); renderFuelChips(); ensureFuel(prefs.primary).then(update); update();
});
$('primary').addEventListener('change', e => { prefs.primary = e.target.value; savePrefs(); ensureFuel(prefs.primary).then(update); update(); });

function setSort(s) {
  prefs.sort = s; savePrefs();
  for (const k of ['price', 'dist', 'save']) $(`sort-${k}`).setAttribute('aria-pressed', s === k);
}
for (const k of ['price', 'dist', 'save']) $(`sort-${k}`).addEventListener('click', () => { setSort(k); update(); });
$('radius').addEventListener('change', e => { prefs.radius = +e.target.value; savePrefs(); fitToRadius(); update(); });
for (const [id, key] of [['open-now', 'openNow'], ['lowcost', 'lowcost']]) {
  $(id).addEventListener('click', () => { prefs[key] = !prefs[key]; savePrefs(); $(id).setAttribute('aria-pressed', prefs[key]); update(); });
}
$('brand').addEventListener('change', e => { prefs.brand = e.target.value; savePrefs(); update(); });

for (const [id, t] of [['tab-near', 'near'], ['tab-fav', 'fav']]) {
  $(id).addEventListener('click', () => {
    tab = t;
    $('tab-near').setAttribute('aria-selected', t === 'near');
    $('tab-fav').setAttribute('aria-selected', t === 'fav');
    renderList();
  });
}

// ======================= Datos =======================
function ensureFuel(id, opts) {
  if (fuelData.has(id) && !opts?.force) return Promise.resolve(fuelData.get(id));
  if (loading.has(id)) return loading.get(id);
  const p = loadFuel(id, opts).then(d => { fuelData.set(id, d); loading.delete(id); return d; })
    .catch(err => { loading.delete(id); setStatus(`No se pudieron cargar los precios de ${fuelById(id).long}: ${err.message}. Vuelve a intentarlo en un momento.`, true); throw err; });
  loading.set(id, p);
  return p;
}

function compute() {
  const prim = fuelData.get(prefs.primary);
  if (!prim) return { list: [], brands: [] };
  const out = [], brandCount = new Map();
  const r = prefs.radius;
  const dLat = r / 111, dLon = r / (111 * Math.cos(center.lat * Math.PI / 180));
  const now = new Date();
  for (const [id, p] of prim.prices) {
    const s = catalog.get(id);
    if (!s || Math.abs(s.lat - center.lat) > dLat || Math.abs(s.lon - center.lon) > dLon) continue;
    const d = km(center, s);
    if (d > r) continue;
    brandCount.set(s.name, (brandCount.get(s.name) || 0) + 1);
    if (prefs.lowcost && !LOWCOST.test(norm(s.name))) continue;
    if (prefs.brand && s.name !== prefs.brand) continue;
    const st = openStatus(s.horario, now, s.tz);
    if (prefs.openNow && st.state === 'closed') continue;
    out.push({ s, d, p, eff: effective(s, p), st });
  }
  // Ahorro neto de llenar el depósito de tu coche frente a la gasolinera más cercana.
  const ref = out.reduce((m, x) => (!m || x.d < m.d ? x : m), null);
  for (const x of out) {
    x.save = x === ref ? null
      : netSaving({ car: car(), fuel: prefs.primary, price: x.eff, dist: x.d, refPrice: ref.eff, refDist: ref.d });
  }
  const byPrice = (a, b) => a.eff - b.eff || a.d - b.d;
  out.sort(prefs.sort === 'price' ? byPrice
    : prefs.sort === 'save' ? (a, b) => (b.save?.net ?? 0) - (a.save?.net ?? 0) || byPrice(a, b)
    : (a, b) => a.d - b.d);
  const brands = [...brandCount].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  return { list: out.slice(0, 250), brands };
}

/** Colores barato / medio / caro por tercios dentro de los resultados. */
function tiers(list) {
  const v = list.map(x => x.eff).sort((a, b) => a - b);
  if (v.length < 3 || v[0] === v[v.length - 1]) return () => 'mid';
  const q1 = v[Math.floor(v.length / 3)], q2 = v[Math.floor(2 * v.length / 3)];
  return e => e <= q1 ? 'cheap' : e < q2 ? 'mid' : 'dear';
}

// ======================= Precio dudoso =======================
// Calibrado con datos reales (Madrid, nov. 2026): el GLP varía mucho entre estaciones, así que
// "un 8 % más barato que la mediana" marcaba gasolineras simplemente baratas. Usamos reglas raras:
// 1) Mismo precio que hace 30 días mientras ≥80 % de su provincia lo ha cambiado.
// 2) Valor atípico estadístico (por debajo de Q1 − 1,5·IQR) y además >10 % bajo la mediana.
const STALE_DAYS = 30;
let flagsToken = 0;
async function computeFlags(list) {
  const token = ++flagsToken;
  const fuel = prefs.primary;
  flags.clear();
  if (list.length >= 8) {
    const v = list.map(x => x.p).sort((a, b) => a - b);
    const q = k => v[Math.floor(k * (v.length - 1))];
    const med = q(0.5), fence = q(0.25) - 1.5 * (q(0.75) - q(0.25));
    for (const x of list) {
      if (x.p < fence && x.p < med * 0.9) add(x.s.id, 'low', `Un ${Math.round((1 - x.p / med) * 100)} % más barata que la mediana de la zona (${priceText(med)} €/L), muy fuera de lo normal. Puede ser real o un error al comunicarlo: confírmalo en el surtidor.`);
    }
  }
  renderList(); renderMarkers();
  const provs = [...new Set(list.map(x => x.s.idProv))].slice(0, 4);
  const cur = fuelData.get(fuel)?.prices;
  await Promise.all(provs.map(async idProv => {
    try {
      const old = await provinceHistory(idProv, fuel, STALE_DAYS);
      if (token !== flagsToken || !cur) return;
      let same = 0, total = 0;
      for (const [id, p] of old) { const c = cur.get(id); if (c === undefined) continue; total++; if (c === p) same++; }
      const changedShare = total ? 1 - same / total : 0;
      if (total < 10 || changedShare < 0.8) return;
      for (const x of list) {
        if (x.s.idProv === idProv && old.get(x.s.id) === x.p) {
          add(x.s.id, 'stale', `Mismo precio que hace ${STALE_DAYS} días, mientras que el ${Math.round(changedShare * 100)} % de las gasolineras de la provincia lo han cambiado. Puede estar desactualizado.`);
        }
      }
    } catch { /* el histórico es opcional */ }
  }));
  if (token === flagsToken) { renderList(); renderMarkers(); if (activeId) renderDetail(activeId, false); }
  function add(id, type, text) { const a = flags.get(id) || []; if (!a.some(f => f.type === type)) a.push({ type, text }); flags.set(id, a); }
}

// ======================= Render =======================
function setStatus(text, err = false) { $('status').textContent = text; $('status').classList.toggle('err', err); }

function update() {
  const { list, brands } = compute();
  results = list;
  const sel = $('brand');
  const keep = prefs.brand;
  sel.innerHTML = `<option value="">Todas</option>` + brands.slice(0, 60).map(b => `<option ${b === keep ? 'selected' : ''}>${esc(b)}</option>`).join('');
  if (keep && !brands.includes(keep)) sel.insertAdjacentHTML('beforeend', `<option selected>${esc(keep)}</option>`);
  $('brands').innerHTML = brands.slice(0, 60).map(b => `<option value="${esc(b)}">`).join('');
  $('place-label').textContent = center.label;
  $('fav-count').textContent = favs.size ? `(${favs.size})` : '';
  const prim = fuelData.get(prefs.primary);
  if (prim) {
    const f = parseFecha(prim.fecha).text;
    const n = list.length;
    setStatus(`${n === 250 ? 'Más de 250' : n} gasolinera${n === 1 ? '' : 's'} con ${fuelById(prefs.primary).long} a menos de ${prefs.radius} km · Ministerio, ${f}`);
  }
  renderCarStrip();
  renderList(); renderMarkers();
  computeFlags(list);
}

function rowHTML(x, tierOf, showDist = true) {
  const { s } = x;
  const d = x.p != null ? discountFor(s, x.p) : null;
  const others = prefs.fuels.filter(f => f !== prefs.primary).map(f => {
    const p = fuelData.get(f)?.prices.get(s.id);
    return p ? `<span>${esc(fuelById(f).label)} <b>${priceText(effective(s, p))}</b></span>` : '';
  }).join('');
  const fl = flags.get(s.id);
  return `<li class="st ${s.id === activeId ? 'active' : ''}" data-id="${s.id}" tabindex="0">
    <div class="nm">${favs.has(s.id) ? '<span class="star" aria-label="Favorita">★</span>' : ''}${esc(s.name)}</div>
    <div class="px">${x.p != null ? `<div class="price ${tierOf(x.eff)}">${priceHTML(x.eff)}<span class="u">€/L</span></div>${d ? `<span class="was">${priceText(x.p)}</span>` : ''}` : '<div class="price">—</div>'}</div>
    <div class="ad">${esc(s.addr)} · ${esc(s.loc)}</div>
    <div class="meta">
      ${showDist && x.d != null ? `<span class="num">${fmtKm(x.d)}</span>` : ''}
      <span class="${x.st.state}">${esc(x.st.label)}</span>
      ${fl ? `<span class="badge" title="${esc(fl.map(f => f.text).join(' '))}">Revisar precio</span>` : ''}
      ${saveTag(x)}
      ${others ? `<span class="others">${others}</span>` : ''}
    </div>
  </li>`;
}

function saveTag(x) {
  const sv = x.save;
  if (x.save === null && prefs.sort === 'save' && results.length > 1) return '<span class="ref" title="El ahorro de las demás se calcula frente a esta">La más cercana · referencia</span>';
  if (!sv || sv.gross <= 0.05) return '';
  const L = tankFor(car(), prefs.primary);
  if (sv.net >= 0.10) {
    return `<span class="save" title="Llenando ${L} L ahorras ${euros(sv.gross)} frente a la más cercana; el desvío (~${Math.round(sv.extraKm)} km ida y vuelta) cuesta ${euros(sv.detour)}">Ahorras ${euros(sv.net)} al llenar</span>`;
  }
  return `<span class="nosave" title="Es más barata, pero el desvío (~${Math.round(sv.extraKm)} km) se come el ahorro">No compensa el desvío</span>`;
}

/** Franja con el coste por 100 km de tu coche en GLP y en gasolina con los mejores precios de la zona. */
function cheapestNear(fuel) {
  const data = fuelData.get(fuel);
  if (!data) return null;
  let best = null;
  for (const [id, p] of data.prices) {
    const s = catalog.get(id);
    if (!s || Math.abs(s.lat - center.lat) > 0.5 || Math.abs(s.lon - center.lon) > 0.7) continue;
    if (km(center, s) > prefs.radius) continue;
    const e = effective(s, p);
    if (!best || e < best.eff) best = { s, eff: e };
  }
  return best;
}
function renderCarStrip() {
  const c = car();
  const g = cheapestNear(GLP), b = cheapestNear(c.gasFuel);
  const el = $('car-strip');
  if (!g && !b) { el.hidden = true; return; }
  const cg = g && costPer100(c, GLP, g.eff), cb = b && costPer100(c, c.gasFuel, b.eff);
  const cell = (label, best, cost) => best
    ? `<div class="cc"><span class="cl">${esc(label)}</span><b class="num">${euros(cost)}</b><small>cada 100 km · desde ${priceText(best.eff)} €/L</small></div>`
    : `<div class="cc"><span class="cl">${esc(label)}</span><b>—</b><small>no hay en ${prefs.radius} km</small></div>`;
  let verdict = '';
  if (cg && cb) {
    const diff = cb - cg;
    verdict = diff > 0
      ? `Con GLP ahorras <b>${euros(diff)}</b> cada 100 km (${Math.round(diff / cb * 100)} %), unos <b>${euros(diff * 10)}</b> cada 1.000 km.`
      : `Aquí la gasolina sale <b>${euros(-diff)}</b> más barata cada 100 km que el GLP.`;
  }
  const act = activeOffers();
  const applied = act.filter(o => hasOffer(o.id)).length;
  const glpOffers = act.filter(o => o.glp === 'sí').length;
  el.innerHTML = `<div class="car-head"><span>Tu ${esc(c.name)}</span><button type="button" class="link" id="car-edit">Cambiar</button></div>
    <div class="car-cmp">${cell('GLP', g, cg)}${cell(fuelById(c.gasFuel).long, b, cb)}</div>
    ${verdict ? `<p class="car-verdict">${verdict}</p>` : ''}
    <button type="button" class="offers-btn" id="open-offers">
      <span><b>${act.length} ofertas para ahorrar</b>${glpOffers ? ` · ${glpOffers} vale${glpOffers === 1 ? '' : 'n'} para GLP` : ''}</span>
      <span class="o-count">${applied ? `${applied} aplicada${applied === 1 ? '' : 's'}` : 'Ver'}</span>
    </button>`;
  el.hidden = false;
  $('car-edit').addEventListener('click', openSettings);
  $('open-offers').addEventListener('click', openOffers);
}

function favRows() {
  const prim = fuelData.get(prefs.primary);
  const now = new Date();
  return [...favs].map(id => catalog.get(id)).filter(Boolean).map(s => {
    const p = prim?.prices.get(s.id);
    return { s, p: p ?? null, eff: p != null ? effective(s, p) : Infinity, d: center.example ? null : km(center, s), st: openStatus(s.horario, now, s.tz) };
  }).sort((a, b) => a.eff - b.eff);
}

function renderList() {
  const list = $('list');
  if (tab === 'fav') {
    const rows = favRows();
    const priced = rows.filter(r => r.p != null);
    const t = tiers(priced);
    list.innerHTML = rows.length ? rows.map(r => rowHTML(r, t, r.d != null)).join('')
      : `<li class="empty"><strong>Aún no tienes favoritas</strong>Abre una gasolinera y pulsa «Guardar en favoritas». Aquí aparecerán ordenadas por precio, estén donde estén.</li>`;
    return;
  }
  if (!fuelData.has(prefs.primary)) { list.innerHTML = ''; return; }
  const t = tiers(results);
  list.innerHTML = results.length ? results.map(x => rowHTML(x, t)).join('')
    : `<li class="empty"><strong>No hay gasolineras con ${esc(fuelById(prefs.primary).long)} aquí</strong>Prueba a ampliar el radio, quitar filtros o elegir otro combustible. El GLP solo se vende en unas 1.000 estaciones de España.</li>`;
}

// Para que el mapa se lea, se colocan los pines en el orden de la lista (los más baratos o
// cercanos primero) y se omite cualquiera que se solaparía con uno ya colocado. Al hacer zoom aparecen más.
const PIN_W = 58, PIN_H = 26;
function renderMarkers() {
  markers.clearLayers();
  const t = tiers(results);
  const shown = new Set();
  const placed = [];
  const fits = s => {
    const p = map.latLngToContainerPoint([s.lat, s.lon]);
    const box = { x: p.x - PIN_W / 2, y: p.y - PIN_H, w: PIN_W, h: PIN_H };
    if (placed.some(b => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) return false;
    placed.push(box); return true;
  };
  const always = new Set([activeId, ...favs].filter(Boolean));
  for (const x of results) if (always.has(x.s.id)) fits(x.s);
  for (const x of results) {
    if (!always.has(x.s.id) && !fits(x.s)) continue;
    shown.add(x.s.id);
    addPin(x.s, `<div class="pin ${t(x.eff)} ${x.s.id === activeId ? 'active' : ''}">${favs.has(x.s.id) ? '<b class="s">★</b>' : ''}<span>${priceText(x.eff)}</span></div>`, x.s.id === activeId ? 1000 : Math.round(1000 - x.eff * 100));
  }
  // Favoritas siempre visibles en el mapa, aunque estén fuera del radio.
  const prim = fuelData.get(prefs.primary);
  const inResults = new Set(results.map(x => x.s.id));
  for (const id of favs) {
    const s = catalog.get(id);
    if (!s || shown.has(id) || inResults.has(id)) continue;
    const p = prim?.prices.get(id);
    addPin(s, `<div class="pin mid ${id === activeId ? 'active' : ''}"><b class="s">★</b><span>${p ? priceText(effective(s, p)) : '—'}</span></div>`, 0);
  }
  if (meMarker) meMarker.addTo(map);
}
function addPin(s, html, z) {
  L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html, iconSize: null }), zIndexOffset: z, keyboard: false, title: s.name })
    .on('click', () => openDetail(s.id))
    .addTo(markers);
}

// ======================= Ficha de estación =======================
$('list').addEventListener('click', e => { const li = e.target.closest('.st'); if (li) openDetail(li.dataset.id); });
$('list').addEventListener('keydown', e => { if (e.key === 'Enter') { const li = e.target.closest('.st'); if (li) openDetail(li.dataset.id); } });
$('d-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('detail').hidden) closeDetail(); });

function openDetail(id) {
  activeId = id;
  renderDetail(id, true);
  $('detail').hidden = false;
  renderList(); renderMarkers();
  const s = catalog.get(id);
  if (s && window.innerWidth > 760) { programmatic = true; map.panTo([s.lat, s.lon]); setTimeout(() => { programmatic = false; }, 400); }
  $('d-close').focus({ preventScroll: true });
}
function closeDetail() {
  $('detail').hidden = true;
  const prev = activeId; activeId = null;
  renderList(); renderMarkers();
  document.querySelector(`.st[data-id="${prev}"]`)?.focus({ preventScroll: true });
}

function renderDetail(id, loadHistory) {
  const s = catalog.get(id);
  if (!s) return;
  const st = openStatus(s.horario, new Date(), s.tz);
  const dist = center.example ? null : km(center, s);
  const prim = fuelData.get(prefs.primary);
  const pPrim = prim?.prices.get(id);
  const rows = FUELS.filter(f => prefs.fuels.includes(f.id)).map(f => {
    const p = fuelData.get(f.id)?.prices.get(id);
    const d = p == null ? null : discountFor(s, p);
    const v = p == null ? `<span class="na">no disponible</span>`
      : `${priceHTML(effective(s, p))}${d ? `<small>surtidor ${priceText(p)} · tu descuento ${esc(discountLabel(d))}</small>` : ''}`;
    return `<div class="lbl">${esc(f.long)}</div><div class="v">${v}</div>`;
  }).join('');
  const fl = flags.get(id) || [];
  const isFav = favs.has(id);
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
  const amaps = `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=d`;
  const fecha = prim ? parseFecha(prim.fecha).text : '';

  $('d-body').innerHTML = `
    <div class="d-head">
      <h2 id="d-name">${esc(s.name)}</h2>
      <p>${esc(s.addr)}<br>${esc(s.cp)} ${esc(s.loc)} (${esc(s.prov)})${dist != null ? ` · <span class="num">${fmtKm(dist)}</span>` : ''}</p>
    </div>
    <div class="totem" aria-label="Precios">${rows}</div>
    ${fl.map(f => `<div class="warn"><strong>Revisa este precio</strong>${esc(f.text)}</div>`).join('')}
    ${activeOffers().filter(o => offerMatches(o, s.name) && !hasOffer(o.id)).map(o => `<div class="d-offer"><p class="eyebrow">Oferta en esta gasolinera</p>${offerCard(o, true)}</div>`).join('')}
    ${carSection(s)}
    <div class="d-sec"><h3>Horario</h3>
      <dl class="kv"><dt>Ahora</dt><dd class="${st.state}">${esc(st.label)}</dd><dt>Publicado</dt><dd>${esc(s.horario || 'Sin datos')}</dd></dl></div>
    ${pPrim ? `<div class="d-sec"><h3>Últimos 30 días · ${esc(fuelById(prefs.primary).label)}</h3><div id="d-hist"><p class="src">Cargando histórico del Ministerio…</p></div></div>` : ''}
    <div class="actions">
      <button type="button" class="btn" id="d-fav" aria-pressed="${isFav}">${isFav ? '★ En favoritas' : '☆ Guardar en favoritas'}</button>
      <a class="btn primary" href="${gmaps}" target="_blank" rel="noopener">Cómo llegar</a>
      <a class="btn" href="${amaps}" target="_blank" rel="noopener">Apple Mapas</a>
    </div>
    <p class="src">Precios comunicados por la gasolinera al Ministerio${fecha ? ` (datos de ${esc(fecha)})` : ''}. El Ministerio no indica cuándo actualizó cada estación su precio, así que puede no coincidir con el surtidor.</p>`;

  $('d-fav').addEventListener('click', () => {
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    saveFavs(); renderDetail(id, false); update();
  });
  $('d-car-edit')?.addEventListener('click', openSettings);
  if (pPrim && loadHistory) loadHist(s, prefs.primary, pPrim);
  else if (pPrim && lastHist?.id === id && lastHist.fuel === prefs.primary) drawHist(lastHist.series);
}

/** Lo que te cuesta tu coche en esta gasolinera: llenar cada depósito, coste por 100 km y autonomía. */
function carSection(s) {
  const c = car();
  const rows = [[GLP, 'GLP'], [c.gasFuel, fuelById(c.gasFuel).long]].map(([fuel, label]) => {
    const p = fuelData.get(fuel)?.prices.get(s.id);
    if (p == null) return `<tr><th scope="row">${esc(label)}</th><td colspan="3" class="na">No la vende</td></tr>`;
    const e = effective(s, p), L = tankFor(c, fuel);
    return `<tr><th scope="row">${esc(label)}</th>
      <td class="num"><b>${euros(e * L)}</b><small>${L} L</small></td>
      <td class="num"><b>${euros(costPer100(c, fuel, e))}</b><small>${String(consFor(c, fuel)).replace('.', ',')} L/100</small></td>
      <td class="num"><b>${Math.round(rangeKm(c, fuel))} km</b><small>por depósito</small></td></tr>`;
  }).join('');
  const pg = fuelData.get(GLP)?.prices.get(s.id), pb = fuelData.get(c.gasFuel)?.prices.get(s.id);
  let verdict = '';
  if (pg != null && pb != null) {
    const d = costPer100(c, c.gasFuel, effective(s, pb)) - costPer100(c, GLP, effective(s, pg));
    verdict = `<p class="src">${d > 0 ? `Aquí, con GLP ahorras ${euros(d)} cada 100 km.` : `Aquí la gasolina sale ${euros(-d)} más barata cada 100 km.`}</p>`;
  }
  return `<div class="d-sec"><h3>Tu ${esc(c.name)} aquí</h3>
    <div class="fill-wrap"><table class="fill"><thead><tr><th></th><th>Llenar</th><th>Cada 100 km</th><th>Autonomía</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${verdict}<button type="button" class="link" id="d-car-edit">Cambiar datos del coche</button></div>`;
}

let lastHist = null;
async function loadHist(s, fuel, current) {
  try {
    const series = await stationHistory(s, fuel);
    series.push({ date: new Date(), price: current });
    lastHist = { id: s.id, fuel, series };
    if (activeId === s.id) drawHist(series);
  } catch {
    if (activeId === s.id && $('d-hist')) $('d-hist').innerHTML = '<p class="src">No se pudo cargar el histórico ahora mismo.</p>';
  }
}

function drawHist(series) {
  const box = $('d-hist');
  if (!box) return;
  if (series.length < 3) { box.innerHTML = '<p class="src">El Ministerio no tiene histórico suficiente de esta estación.</p>'; return; }
  const W = 340, H = 140, l = 50, r = 12, t = 12, b = 24;
  const ps = series.map(p => p.price);
  const min = Math.min(...ps), max = Math.max(...ps);
  const flat = max - min < 0.0005;
  let lo = min, hi = max;
  if (hi - lo < 0.01) { const pad = (0.01 - (hi - lo)) / 2; lo -= pad; hi += pad; }   // margen visual, sin rotularlo
  const t0 = +series[0].date, t1 = +series[series.length - 1].date;
  const x = d => l + (W - l - r) * ((+d - t0) / (t1 - t0 || 1));
  const y = v => t + (H - t - b) * (1 - (v - lo) / (hi - lo));
  const path = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.price).toFixed(1)}`).join('');
  const area = `${path}L${x(series.at(-1).date).toFixed(1)},${H - b}L${l},${H - b}Z`;
  const dm = d => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  const last = series.at(-1), first = series[0];
  const diff = last.price - first.price;
  box.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Precio de ${priceText(first.price)} a ${priceText(last.price)} euros por litro en 30 días">
      ${(flat ? [max] : [max, min]).map(v => `<line class="gd" x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${priceText(v)}</text>`).join('')}
      <path class="ar" d="${area}"/><path class="ln" d="${path}"/>
      <circle class="pt" cx="${x(last.date)}" cy="${y(last.price)}" r="4"/>
      <text x="${l}" y="${H - 6}">${dm(first.date)}</text><text x="${W - r}" y="${H - 6}" text-anchor="end">hoy</text>
    </svg>
    <p class="src">${flat ? 'El mismo precio durante los últimos 30 días.'
      : Math.abs(diff) < 0.0005 ? `Hoy cuesta lo mismo que hace 30 días; entre medias osciló entre ${priceText(min)} y ${priceText(max)} €/L.`
      : `${diff > 0 ? 'Ha subido' : 'Ha bajado'} ${Math.abs(diff * 100).toFixed(1).replace('.', ',')} céntimos por litro en 30 días.`}</p>`;
}

// ======================= Ubicación y búsqueda =======================
function setCenter(c, { fit = true, save = true } = {}) {
  center = c;
  if (save && !c.example) { prefs.center = { lat: c.lat, lon: c.lon, label: c.label }; savePrefs(); }
  radiusCircle.setLatLng([c.lat, c.lon]);
  if (fit) fitToRadius(); else radiusCircle.setRadius(prefs.radius * 1000);
  if (tab !== 'near') $('tab-near').click();
  update();
}

$('locate').addEventListener('click', () => {
  if (!('geolocation' in navigator)) { setStatus('Tu navegador no permite obtener la ubicación. Busca un municipio o código postal.', true); return; }
  setStatus('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(pos => {
    const c = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'tu ubicación' };
    if (meMarker) meMarker.remove();
    meMarker = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 2000 });
    setCenter(c);
  }, err => {
    setStatus(err.code === 1 ? 'Sin permiso de ubicación. Puedes buscar un municipio, código postal o dirección.' : 'No se pudo obtener tu ubicación. Prueba a buscar un municipio.', true);
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
});

const q = $('q'), sug = $('suggest');
let sugItems = [], sugIdx = -1, geoTimer = null;
function showSuggest(items) {
  sugItems = items; sugIdx = items.length ? 0 : -1;
  sug.innerHTML = items.map((it, i) => `<li role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === sugIdx}">${esc(it.label)}${it.n ? `<small>${it.n} gasolinera${it.n === 1 ? '' : 's'}</small>` : it.hint ? `<small>${esc(it.hint)}</small>` : ''}</li>`).join('');
  sug.hidden = !items.length;
  q.setAttribute('aria-expanded', String(!!items.length));
}
q.addEventListener('input', () => {
  clearTimeout(geoTimer);
  const text = q.value.trim();
  const local = searchPlaces(text);
  if (local.length || text.length < 4) { showSuggest(local); return; }
  showSuggest([{ label: `Buscar «${text}» como dirección`, hint: 'OpenStreetMap', geocode: text }]);
});
q.addEventListener('keydown', e => {
  if (sug.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
    [...sug.children].forEach((li, i) => li.setAttribute('aria-selected', i === sugIdx));
  } else if (e.key === 'Escape') { sug.hidden = true; }
});
sug.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(sugItems[+li.dataset.i]); } });
q.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 150));
$('search').addEventListener('submit', e => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  pick(sugItems[sugIdx] || { geocode: text });
});
async function pick(it) {
  if (!it) return;
  sug.hidden = true;
  if (it.geocode) {
    setStatus(`Buscando «${it.geocode}»…`);
    try {
      const found = await geocode(it.geocode);
      if (!found.length) { setStatus(`No encontramos «${it.geocode}» en España. Prueba con el municipio o el código postal.`, true); return; }
      if (found.length === 1) return pick(found[0]);
      showSuggest(found);
      q.focus();
    } catch (err) { setStatus(err.message, true); }
    return;
  }
  q.value = it.label;
  q.blur();
  setCenter({ lat: it.lat, lon: it.lon, label: it.label.replace(/\s*\(.*\)$/, '') });
}

// ======================= Ajustes: descuentos y depósito =======================
const dlg = $('settings');
function renderDiscounts() {
  $('disc-list').innerHTML = prefs.discounts.length
    ? prefs.discounts.map((d, i) => `<div class="disc"><span>${esc(d.brand)} <b>${esc(discountLabel(d))}</b></span><button type="button" data-del="${i}">Quitar</button></div>`).join('')
    : '<p class="hint">Sin descuentos todavía.</p>';
}
const CAR_FIELDS = ['name', 'glpL', 'glpCons', 'gasL', 'gasCons', 'gasFuel'];
$('car-gasFuel').innerHTML = FUELS.filter(f => f.id !== GLP).map(f => `<option value="${f.id}">${esc(f.long)}</option>`).join('');
function fillCarForm(c) { for (const k of CAR_FIELDS) $(`car-${k}`).value = c[k]; }
function openSettings() { renderDiscounts(); fillCarForm(car()); dlg.showModal(); }
$('open-settings').addEventListener('click', openSettings);
$('car-reset').addEventListener('click', () => fillCarForm(SANDERO));
$('disc-list').addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  prefs.discounts.splice(+b.dataset.del, 1); savePrefs(); renderDiscounts();
});
$('disc-add').addEventListener('click', () => {
  const brand = $('disc-brand').value.trim();
  const value = parseFloat(String($('disc-value').value).replace(',', '.'));
  if (!brand || !(value > 0)) { $('disc-brand').focus(); return; }
  prefs.discounts = prefs.discounts.filter(d => norm(d.brand) !== norm(brand));
  prefs.discounts.push({ brand: brand.toUpperCase(), value, type: $('disc-type').value });
  savePrefs(); renderDiscounts();
  $('disc-brand').value = ''; $('disc-value').value = '';
});
// Los datos del coche se guardan al cambiar cada campo (no solo al cerrar), para no perderlos
// si el diálogo se cierra de otra forma o el evento "close" llega tarde.
function saveCarFromForm() {
  const raw = Object.fromEntries(CAR_FIELDS.map(k => [k, $(`car-${k}`).value]));
  for (const k of ['glpL', 'glpCons', 'gasL', 'gasCons']) raw[k] = String(raw[k]).replace(',', '.');
  prefs.car = sanitizeCar(raw);
  if (!prefs.fuels.includes(prefs.car.gasFuel)) {
    prefs.fuels = FUELS.map(f => f.id).filter(x => x === prefs.car.gasFuel || prefs.fuels.includes(x));
    renderFuelChips();
  }
  savePrefs();
}
for (const k of CAR_FIELDS) $(`car-${k}`).addEventListener('change', () => { saveCarFromForm(); update(); });
$('car-reset').addEventListener('click', () => { saveCarFromForm(); update(); });
dlg.addEventListener('close', () => {
  saveCarFromForm();
  ensureFuel(prefs.car.gasFuel).then(update).catch(() => {});
  update();
  if (activeId) renderDetail(activeId, false);
});

// ======================= Arranque =======================
if (prefs.expiredNotice) {
  $('notice-text').textContent = `Ha caducado y ya no se aplica: ${prefs.expiredNotice}. Mira las ofertas para ver si hay una nueva.`;
  $('notice').hidden = false;
  delete prefs.expiredNotice; savePrefs();
}
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
renderFuelChips();
setSort(prefs.sort);
$('radius').value = String(prefs.radius);
$('open-now').setAttribute('aria-pressed', prefs.openNow);
$('lowcost').setAttribute('aria-pressed', prefs.lowcost);
fitToRadius();
$('place-label').textContent = center.label;

ensureFuel(prefs.primary).then(() => {
  update();
  if (center.example) setStatus(`${$('status').textContent}. Pulsa el botón de ubicación o busca tu municipio.`);
  // GLP y la gasolina de tu coche siempre se cargan: hacen falta para comparar el coste por 100 km.
  for (const f of new Set([...prefs.fuels, GLP, car().gasFuel])) if (f !== prefs.primary) ensureFuel(f).then(update).catch(() => {});
}).catch(() => {});

// Refresca los precios cada 30 minutos si la pestaña sigue abierta.
setInterval(() => { for (const f of prefs.fuels) ensureFuel(f, { force: true }).then(update).catch(() => {}); }, 30 * 60 * 1000);
