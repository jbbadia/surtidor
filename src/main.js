import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { FUELS, fuelById, catalog, loadFuel, provinceHistory, stationHistory, searchPlaces, geocode, parseFecha, provinceDailyMedians } from './api.js';
import { openStatus } from './horario.js';
import { SANDERO, GLP, tankFor, consFor, costPer100, rangeKm, netSaving, driveCost, sanitizeCar } from './car.js';
import { OFFERS, VERIFIED, activeOffers, offerMatches, isExpired, fmtDate } from './offers.js';
import { lastPriceChange, daysAgoText, minutesAgoText, weekdayPattern } from './history.js';
import { snapshot, priceChanges, belowTarget } from './alerts.js';
import { initTrip } from './trip-ui.js';
import { initLog } from './log-ui.js';

// ======================= Preferencias (solo en este navegador) =======================
const PREFS_KEY = 'surtidor:v1:prefs';
const DEFAULTS = {
  fuels: ['17', '1'], primary: '17', sort: 'price', radius: 10, openNow: false, lowcost: false, brand: '',
  center: null, favorites: [], discounts: [], car: { ...SANDERO }, glpTarget: null, trip: null,
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
  if (tab === 'trip') { renderMarkers(); return; }
  if (programmatic) return;
  const c = map.getCenter();
  $('search-here').hidden = km(center, { lat: c.lat, lon: c.lng }) < Math.max(1, prefs.radius * 0.35);
});
$('search-here').addEventListener('click', () => {
  const c = map.getCenter();
  setCenter({ lat: c.lat, lon: c.lng, label: 'esta zona' }, { fit: false });
  $('search-here').hidden = true;
});

// ======================= Viaje y diario =======================
// (las funciones a las que apuntan están más abajo; solo se llaman tras una acción del usuario)
const shared = { L, map, $, esc, euros, priceText, priceHTML, fmtKm, prefs, savePrefs, car, fuelData, effective, openDetail: id => openDetail(id) };
const trip = initTrip({
  ...shared,
  ensureFuel: (id, o) => ensureFuel(id, o),
  getCenter: () => center,
  redraw: () => renderMarkers(),
  fit: bounds => {
    programmatic = true;
    map.fitBounds(bounds, { padding: [24, 24] });
    setTimeout(() => { programmatic = false; }, 600);
  },
});
const log = initLog({
  ...shared,
  gasRefNow: () => cheapestNear(car().gasFuel)?.eff ?? null,
  onCarChange: () => update(),
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

const TABS = ['near', 'fav', 'trip', 'log'];
function setTab(t) {
  tab = t;
  for (const k of TABS) $(`tab-${k}`).setAttribute('aria-selected', t === k);
  $('view-list').hidden = t === 'trip' || t === 'log';
  $('view-trip').hidden = t !== 'trip';
  $('view-log').hidden = t !== 'log';
  trip.show(t === 'trip');
  log.show(t === 'log');
  // En «Viaje» el mapa enseña la ruta; en el resto, el círculo del radio de búsqueda.
  if (t === 'trip') radiusCircle.remove(); else radiusCircle.addTo(map);
  if (t === 'trip') $('search-here').hidden = true;
  renderList(); renderMarkers();
}
for (const k of TABS) $(`tab-${k}`).addEventListener('click', () => setTab(k));

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
    const n = list.length;
    setStatus(`${n === 250 ? 'Más de 250' : n} gasolinera${n === 1 ? '' : 's'} con ${fuelById(prefs.primary).long} a menos de ${prefs.radius} km`);
  }
  renderUpdated();
  renderOffline();
  renderCarStrip();
  renderAlerts();
  renderList(); renderMarkers();
  computeFlags(list);
}

// ======================= Avisos al abrir =======================
// 1) Qué ha cambiado en tus favoritas desde la última visita. 2) GLP por debajo de tu precio objetivo.
const SEEN_KEY = 'surtidor:v1:visto';
let seen = null;
try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch { /* sin almacenamiento */ }
const saveSeen = () => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* sin almacenamiento */ } };
let targetKey = '';
function renderAlerts() {
  const fuels = [...new Set([GLP, car().gasFuel])];
  if (!fuels.every(f => fuelData.has(f))) return;
  const priceOf = (id, f) => fuelData.get(f)?.prices.get(id);
  const ids = [...favs];
  const changes = seen?.p ? priceChanges(seen.p, ids, fuels, priceOf) : [];
  const now = snapshot(ids, fuels, priceOf);
  if (!changes.length) { seen = { t: Date.now(), p: now }; saveSeen(); }
  else {
    // Favoritas nuevas: se empiezan a seguir sin tocar los cambios pendientes de ver.
    let added = false;
    for (const id of ids) if (!seen.p[id] && now[id]) { seen.p[id] = now[id]; added = true; }
    if (added) saveSeen();
  }
  // Precio objetivo: favoritas y gasolineras dentro del radio.
  const cands = new Map();
  const glp = fuelData.get(GLP);
  if (prefs.glpTarget && glp) {
    for (const id of ids) { const s = catalog.get(id), p = glp.prices.get(id); if (s && p != null) cands.set(id, { id, s, price: effective(s, p), d: center.example ? null : km(center, s) }); }
    if (!center.example) {
      for (const [id, p] of glp.prices) {
        const s = catalog.get(id);
        if (!s || cands.has(id) || Math.abs(s.lat - center.lat) > 0.5 || Math.abs(s.lon - center.lon) > 0.7) continue;
        const d = km(center, s);
        if (d <= prefs.radius) cands.set(id, { id, s, price: effective(s, p), d });
      }
    }
  }
  let hits = belowTarget([...cands.values()], prefs.glpTarget);
  targetKey = hits.map(h => `${h.id}:${h.price.toFixed(3)}`).join('|') + `@${prefs.glpTarget}`;
  if (prefs.targetSeen === targetKey) hits = [];

  const cents = v => (Math.abs(v) * 100).toFixed(1).replace('.', ',');
  const items = [
    ...hits.map(h => `<li data-id="${h.id}" tabindex="0"><span class="a-tag down">Objetivo</span><span><b>GLP a ${priceText(h.price)} €/L</b> en ${esc(h.s.name)} (${esc(h.s.loc)}${h.d != null ? `, ${fmtKm(h.d)}` : ''}): igual o por debajo de tus ${priceText(prefs.glpTarget)} €/L.</span></li>`),
    ...changes.map(c => {
      const s = catalog.get(c.id);
      if (!s) return '';
      const down = c.diff < 0;
      return `<li data-id="${c.id}" tabindex="0"><span class="a-tag ${down ? 'down' : 'up'}">${down ? '▼' : '▲'} ${cents(c.diff)} cént</span><span><b>${esc(s.name)}</b> (${esc(s.loc)}): ${esc(fuelById(c.fuel).label)} ${down ? 'baja' : 'sube'} de ${priceText(c.from)} a ${priceText(c.to)} €/L.</span></li>`;
    }),
  ].filter(Boolean);
  $('alerts-title').textContent = changes.length && seen?.t
    ? `Cambios en tus favoritas desde tu última visita (${minutesAgoText(Date.now() - seen.t)})`
    : 'Aviso de precio';
  $('alerts-list').innerHTML = items.join('');
  $('alerts').hidden = !items.length;
}
$('alerts-ok').addEventListener('click', () => {
  const fuels = [...new Set([GLP, car().gasFuel])];
  seen = { t: Date.now(), p: snapshot([...favs], fuels, (id, f) => fuelData.get(f)?.prices.get(id)) };
  saveSeen();
  prefs.targetSeen = targetKey; savePrefs();
  $('alerts').hidden = true;
});
$('alerts-list').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) openDetail(li.dataset.id); });

// ======================= Sin conexión =======================
function renderOffline() {
  const stale = [...fuelData.values()].some(d => d.offline);
  $('offline').hidden = navigator.onLine && !stale;
}
window.addEventListener('offline', renderOffline);
window.addEventListener('online', () => { renderOffline(); refreshAll(); });

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
      ${showDist && x.d != null && x.p != null && !center.example ? goTag(x) : ''}
      <span class="${x.st.state}">${esc(x.st.label)}</span>
      ${fl ? `<span class="badge" title="${esc(fl.map(f => f.text).join(' '))}">Revisar precio</span>` : ''}
      ${saveTag(x)}
      ${others ? `<span class="others">${others}</span>` : ''}
    </div>
  </li>`;
}

/** Lo que cuesta llegar hasta la gasolinera con el consumo medio de tu coche. */
function goTag(x) {
  const g = driveCost(car(), prefs.primary, x.eff, x.d);
  if (g.km < 0.3) return '';
  return `<span class="go" title="Unos ${fmtKm(g.km)} por carretera a ${String(consFor(car(), prefs.primary)).replace('.', ',')} L/100 km. Ida y vuelta: ${euros(2 * g.cost)}">Ir cuesta ${euros(g.cost)}</span>`;
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
    ${dayLine(g)}
    <button type="button" class="offers-btn" id="open-offers">
      <span><b>${act.length} ofertas para ahorrar</b>${glpOffers ? ` · ${glpOffers} vale${glpOffers === 1 ? '' : 'n'} para GLP` : ''}</span>
      <span class="o-count">${applied ? `${applied} aplicada${applied === 1 ? '' : 's'}` : 'Ver'}</span>
    </button>`;
  el.hidden = false;
  $('car-edit').addEventListener('click', openSettings);
  $('open-offers').addEventListener('click', openOffers);
}

// ¿Qué día conviene repostar? Mediana diaria del GLP en la provincia durante 8 semanas.
// Solo se afirma un «mejor día» si los datos lo confirman (ver weekdayPattern).
const dayInfo = new Map();           // idProv -> null (calculando) | {r, prov}
const PLURAL = { lunes: 'lunes', martes: 'martes', 'miércoles': 'miércoles', jueves: 'jueves', viernes: 'viernes', 'sábado': 'sábados', domingo: 'domingos' };
function dayLine(g) {
  if (!g) return '';
  const info = dayInfo.get(g.s.idProv);
  if (info === undefined) {
    if (!navigator.onLine) return '';
    dayInfo.set(g.s.idProv, null);
    const prov = g.s.prov, idProv = g.s.idProv;
    provinceDailyMedians(idProv, GLP, 56)
      .then(pts => { dayInfo.set(idProv, { r: weekdayPattern(pts), prov }); renderCarStrip(); })
      .catch(() => { dayInfo.set(idProv, { r: null, prov }); });
    return '';
  }
  const r = info?.r;
  if (!r) return '';
  const cents = v => (Math.abs(v) * 100).toFixed(1).replace('.', ',');
  return r.confirmed
    ? `<p class="car-day" id="car-day"><b>Mejor día para repostar GLP en ${esc(info.prov)}: los ${PLURAL[r.best.name]}.</b> De media, ${cents(r.best.diff)} cént/L más barato que el resto de la semana (se cumplió ${r.best.hits} de ${r.best.n} semanas).</p>`
    : `<p class="car-day" id="car-day"><b>¿Qué día repostar?</b> Da igual: en ${esc(info.prov)} el GLP cuesta prácticamente lo mismo cualquier día de la semana (${r.weeks} semanas analizadas, ${cents(r.spread)} cént/L entre el mejor y el peor día).</p>`;
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
  if (tab === 'trip' && trip.drawPins(markers, activeId)) { if (meMarker) meMarker.addTo(map); return; }
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
    ${goLine(s, dist, pPrim)}
    ${pPrim ? `<p class="d-change" id="d-change">Último cambio de precio (${esc(fuelById(prefs.primary).label)}): consultando el histórico…</p>` : ''}
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
      ${pPrim ? '<button type="button" class="btn" id="d-log">Apuntar repostaje aquí</button>' : ''}
    </div>
    <p class="src">Precios comunicados por la gasolinera al Ministerio${fecha ? ` (datos de ${esc(fecha)})` : ''}. El Ministerio no indica cuándo actualizó cada estación su precio, así que puede no coincidir con el surtidor.</p>`;

  $('d-fav').addEventListener('click', () => {
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    saveFavs(); renderDetail(id, false); update();
  });
  $('d-car-edit')?.addEventListener('click', openSettings);
  $('d-log')?.addEventListener('click', () => {
    const fuel = prefs.primary === GLP ? GLP : car().gasFuel;
    const p = fuelData.get(fuel)?.prices.get(id) ?? pPrim;
    const pb = fuelData.get(car().gasFuel)?.prices.get(id);
    closeDetail();
    setTab('log');
    log.prefill({ station: `${s.name} (${s.loc})`, fuel, price: effective(s, p), gasRef: pb != null ? effective(s, pb) : null });
  });
  if (pPrim && loadHistory) loadHist(s, prefs.primary, pPrim);
  else if (pPrim && lastHist?.id === id && lastHist.fuel === prefs.primary) { drawHist(lastHist.series); drawChange(lastHist.series); }
}

/** Ficha: lo que cuesta ir hasta la gasolinera desde donde estás buscando. */
function goLine(s, dist, p) {
  if (dist == null || p == null) return '';
  const c = car(), fuel = prefs.primary;
  const g = driveCost(c, fuel, effective(s, p), dist);
  if (g.km < 0.3) return '';
  return `<p class="d-change" id="d-go">Ir hasta aquí: unos ${fmtKm(g.km)} por carretera, <b>${euros(g.cost)}</b> de ${fuel === GLP ? 'GLP' : 'gasolina'} con tu consumo medio (${String(consFor(c, fuel)).replace('.', ',')} L/100 km). Ida y vuelta: ${euros(2 * g.cost)}.</p>`;
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
function drawChange(series) {
  const el = $('d-change');
  if (!el) return;
  const c = lastPriceChange(series);
  const label = esc(fuelById(prefs.primary).label);
  const dm = d => d.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'numeric' });
  if (!c) { el.textContent = `Último cambio de precio (${fuelById(prefs.primary).label}): el Ministerio no tiene histórico de esta estación.`; return; }
  el.innerHTML = c.unchanged
    ? `<b>Precio de ${label} sin cambios</b> en los últimos ${c.days} días. Si te parece raro, confírmalo en el surtidor.`
    : `<b>Último cambio de precio (${label}): ${esc(daysAgoText(c.date))}</b>, ${esc(dm(c.date))}. Pasó de ${priceText(c.from)} a ${priceText(c.to)} €/L.`;
}

async function loadHist(s, fuel, current) {
  try {
    // Diario: permite fechar el último cambio de precio (30 peticiones pequeñas al Ministerio, en caché).
    const series = await stationHistory(s, fuel, { days: 30, step: 1 });
    series.push({ date: new Date(), price: current });
    lastHist = { id: s.id, fuel, series };
    if (activeId === s.id) { drawHist(series); drawChange(series); }
  } catch {
    if (activeId === s.id && $('d-hist')) $('d-hist').innerHTML = '<p class="src">No se pudo cargar el histórico ahora mismo.</p>';
    if (activeId === s.id && $('d-change')) $('d-change').textContent = 'No se pudo consultar el histórico ahora mismo.';
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
  if (tab !== 'near') setTab('near');
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
function openSettings() { renderDiscounts(); fillCarForm(car()); $('glp-target').value = prefs.glpTarget ?? ''; dlg.showModal(); }
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
$('glp-target').addEventListener('change', e => {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  prefs.glpTarget = v >= 0.3 && v <= 3 ? Math.round(v * 1000) / 1000 : null;
  delete prefs.targetSeen;
  savePrefs(); renderAlerts();
});
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

// ======================= Añadir a la pantalla de inicio =======================
// iOS no permite instalar desde un botón (no existe beforeinstallprompt en Safari): el botón muestra
// los pasos exactos para el navegador que se esté usando. En Android/Chrome/Edge instala de verdad.
const UA = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const isInApp = /FBAN|FBAV|Instagram|Line\/|GSA\/|TikTok|Twitter/i.test(UA);
const iosBrowser = /CriOS/.test(UA) ? 'Chrome' : /FxiOS/.test(UA) ? 'Firefox' : /EdgiOS/.test(UA) ? 'Edge' : 'Safari';
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const INSTALL_KEY = 'surtidor:v1:install-dismissed';
let installPrompt = null;

const ICON_SHARE = '<svg class="ico" viewBox="0 0 24 24" aria-label="Compartir"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_ADD = '<svg class="ico" viewBox="0 0 24 24" aria-label="Añadir"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_DOTS = '<svg class="ico" viewBox="0 0 24 24" aria-label="Menú"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>';

function installSteps() {
  const url = location.href.split('#')[0];
  const ol = items => `<ol>${items.map(i => `<li>${i}</li>`).join('')}</ol>`;
  if (isIOS && isInApp) {
    return `<p>Ahora mismo estás dentro de otra app (por ejemplo Instagram o Google). Desde ahí no se puede añadir a la pantalla de inicio.</p>
      ${ol([`Abre esta página en <b>Safari</b>: toca el menú de la app (${ICON_DOTS} o la brújula) y elige «Abrir en Safari».`,
        'Cuando esté abierta en Safari, vuelve a pulsar «Añadir».'])}
      <p class="hint">O copia la dirección y pégala en Safari: <span class="url">${esc(url)}</span></p>`;
  }
  if (isIOS) {
    const where = iosBrowser === 'Safari' ? 'en la barra de abajo de Safari (en iPad, arriba a la derecha)' : `en la barra de direcciones de ${iosBrowser}, arriba a la derecha`;
    return ol([
      `Pulsa el botón <b>Compartir</b> ${ICON_SHARE} ${where}.`,
      `Baja en el menú y toca <b>«Añadir a pantalla de inicio»</b> ${ICON_ADD}. Si no aparece, toca «Editar acciones» al final de la lista y actívalo.`,
      'Pulsa <b>«Añadir»</b> arriba a la derecha. Aparecerá el icono de Surtidor junto a tus apps.',
    ]) + '<p class="hint">Se abrirá a pantalla completa, como una app, y conservará tu coche, tus favoritas y tus ofertas.</p>';
  }
  return ol([
    `Abre el menú del navegador ${ICON_DOTS} (arriba a la derecha).`,
    'Toca <b>«Instalar aplicación»</b> o <b>«Añadir a pantalla de inicio»</b>.',
    'Confirma. Aparecerá el icono de Surtidor junto a tus apps.',
  ]);
}
function renderInstall() {
  let dismissed = false;
  try { dismissed = !!localStorage.getItem(INSTALL_KEY); } catch { /* sin almacenamiento */ }
  const mobile = window.matchMedia('(pointer: coarse)').matches;
  $('install').hidden = isStandalone() || dismissed || !(mobile || installPrompt);
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installPrompt = null; $('install').hidden = true; });
$('install-btn').addEventListener('click', async () => {
  if (installPrompt && !isIOS) {
    try {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') $('install').hidden = true;
      installPrompt = null;
      return;
    } catch { /* el navegador no dejó instalar: se muestran los pasos a mano */ }
  }
  $('install-steps').innerHTML = installSteps();
  $('install-dlg').showModal();
});
$('install-dismiss').addEventListener('click', () => {
  try { localStorage.setItem(INSTALL_KEY, new Date().toISOString()); } catch { /* sin almacenamiento */ }
  $('install').hidden = true;
});
renderInstall();

// ======================= Actualización de precios =======================
const REFRESH_MS = 30 * 60 * 1000;
const fmtWhen = t => new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
}).format(t).replace(/^./, c => c.toUpperCase()).replace(/,? (\d{1,2}:\d{2})$/, ' a las $1');
/** Hora de la descarga más antigua entre los combustibles en uso: la que manda. */
function oldestFetch() {
  const ts = [...new Set([...prefs.fuels, GLP, car().gasFuel])].map(f => fuelData.get(f)?.fetchedAt).filter(Boolean);
  return ts.length ? Math.min(...ts) : null;
}
let refreshing = false;
function renderUpdated() {
  const t = oldestFetch();
  const btn = $('u-refresh');
  btn.disabled = refreshing;
  btn.textContent = refreshing ? 'Actualizando…' : 'Actualizar';
  if (!t) return;
  const age = Date.now() - t;
  $('u-when').textContent = fmtWhen(t);
  $('u-ago').textContent = `(${minutesAgoText(age)})`;
  $('updated').classList.toggle('stale', age > REFRESH_MS);
}
async function refreshAll() {
  if (refreshing) return;
  refreshing = true; renderUpdated();
  const fuels = [...new Set([...prefs.fuels, GLP, car().gasFuel])];
  const res = await Promise.allSettled(fuels.map(f => ensureFuel(f, { force: true })));
  refreshing = false;
  update();
  if (res.some(r => r.status === 'fulfilled' && r.value.offline)) setStatus('No hay conexión con el Ministerio: se mantienen los últimos precios guardados.', true);
  else if (res.some(r => r.status === 'rejected')) setStatus('No se pudieron descargar todos los precios. Se muestran los últimos que tenías; vuelve a intentarlo en un momento.', true);
  if (activeId) renderDetail(activeId, false);
}
$('u-refresh').addEventListener('click', refreshAll);
setInterval(renderUpdated, 30 * 1000);                       // el «hace X min» se mantiene al día
setInterval(refreshAll, REFRESH_MS);                         // cada 30 min con la web abierta
document.addEventListener('visibilitychange', () => {        // al volver a la app desde la pantalla de inicio
  if (document.visibilityState === 'visible') {
    const t = oldestFetch();
    if (t && Date.now() - t > REFRESH_MS) refreshAll(); else renderUpdated();
  }
});

// ======================= Funcionar sin conexión =======================
// El service worker guarda la propia web (HTML, código, iconos y fuentes) para poder abrirla sin
// cobertura; los precios se guardan aparte en IndexedDB (ver api.js). Solo en la versión publicada.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const base = new URL(import.meta.env.BASE_URL, location.origin).href;
      await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
      const reg = await navigator.serviceWorker.ready;
      const send = prune => {
        const urls = [location.href.split(/[?#]/)[0], ...performance.getEntriesByType('resource').map(e => e.name)
          .filter(u => u.startsWith(base) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u))];
        reg.active?.postMessage({ type: 'cache', urls: [...new Set(urls)], prune });
      };
      send(false);
      setTimeout(() => send(true), 20000);      // para entonces ya se ha cargado también el mapa
    } catch { /* sin service worker la web funciona igual, pero solo con conexión */ }
  });
}
