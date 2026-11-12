// Acceso a la API REST "Precios de Carburantes" del Ministerio (Geoportal de Gasolineras).
// La API permite CORS (*), así que se llama directamente desde el navegador.

import { timeZoneFor } from './horario.js';

const BASE = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes';

/** Solo GLP y gasolinas. Los IDs son los de /Listados/ProductosPetroliferos. */
export const FUELS = [
  { id: '17', label: 'GLP', long: 'GLP (autogás)' },
  { id: '1', label: '95', long: 'Gasolina 95 E5' },
  { id: '23', label: '95 E10', long: 'Gasolina 95 E10' },
  { id: '20', label: '95 Premium', long: 'Gasolina 95 E5 Premium' },
  { id: '3', label: '98', long: 'Gasolina 98 E5' },
  { id: '21', label: '98 E10', long: 'Gasolina 98 E10' },
];
export const fuelById = id => FUELS.find(f => f.id === id);

const CACHE_TTL = 30 * 60 * 1000;          // 30 min: el Ministerio actualiza varias veces al día
const KEY_CAT = 'surtidor:v1:catalogo';
const keyFuel = id => `surtidor:v1:precios:${id}`;

const num = s => {
  const v = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
};

async function getJSON(path, { timeout = 30000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`${BASE}/${path}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`El Ministerio respondió ${res.status}`);
      const data = await res.json();
      if (data.ResultadoConsulta && data.ResultadoConsulta !== 'OK') throw new Error(`Consulta rechazada: ${data.ResultadoConsulta}`);
      return data;
    } catch (err) {
      if (attempt >= retries) {
        throw err.name === 'AbortError' ? new Error('El servidor del Ministerio tarda demasiado en responder') : err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------- Caché local (localStorage, con tolerancia a errores) ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

/** Catálogo de estaciones compartido por todos los combustibles. */
export const catalog = new Map();
const CAT_FIELDS = ['id', 'name', 'addr', 'cp', 'muni', 'loc', 'prov', 'idProv', 'idMuni', 'lat', 'lon', 'horario'];

(function loadCatalogFromCache() {
  const rows = store.get(KEY_CAT);
  if (!Array.isArray(rows)) return;
  for (const r of rows) {
    const s = Object.fromEntries(CAT_FIELDS.map((f, i) => [f, r[i]]));
    s.tz = timeZoneFor(s.idProv);
    catalog.set(s.id, s);
  }
})();

function saveCatalog() {
  store.set(KEY_CAT, [...catalog.values()].map(s => CAT_FIELDS.map(f => s[f])));
}

function tidy(text) {
  // "AVENIDA CONSTITUCION, 12" -> "Avenida Constitucion, 12" (los datos vienen en mayúsculas)
  return String(text || '').toLowerCase().replace(/(^|[\s(\-/])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase()).trim();
}

function toStation(e) {
  return {
    id: e.IDEESS,
    name: (e['Rótulo'] || 'Sin rótulo').trim(),
    addr: tidy(e['Dirección']),
    cp: e['C.P.'],
    muni: e.Municipio,
    loc: e.Localidad,
    prov: tidy(e.Provincia),
    idProv: e.IDProvincia,
    idMuni: e.IDMunicipio,
    lat: num(e.Latitud),
    lon: num(e['Longitud (WGS84)']),
    horario: e.Horario,
    tz: timeZoneFor(e.IDProvincia),
  };
}

/** "12/11/2026 0:36:47" -> Date (hora de Madrid, aproximada como CET/CEST). */
export function parseFecha(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(s || '');
  return m ? { text: `${m[1]}/${m[2]}/${m[3]} ${m[4].padStart(2, '0')}:${m[5]}`, d: m[1], mo: m[2], y: m[3] } : { text: s || '' };
}

/**
 * Precios actuales de un combustible en toda España.
 * `fecha` es la hora a la que el Ministerio generó la respuesta (la de la consulta, no la del
 * último cambio de cada gasolinera); `fetchedAt` es cuándo los descargó esta web.
 * @returns {Promise<{fecha: string, prices: Map<string, number>, fromCache: boolean, fetchedAt: number}>}
 */
export async function loadFuel(fuelId, { force = false } = {}) {
  const cached = store.get(keyFuel(fuelId));
  if (!force && cached && Date.now() - cached.t < CACHE_TTL && cached.p.every(([id]) => catalog.has(id))) {
    return { fecha: cached.fecha, prices: new Map(cached.p), fromCache: true, fetchedAt: cached.t };
  }
  const data = await getJSON(`EstacionesTerrestres/FiltroProducto/${fuelId}`);
  const prices = new Map();
  for (const e of data.ListaEESSPrecio) {
    const p = num(e.PrecioProducto);
    if (!Number.isFinite(p) || p <= 0) continue;
    const s = toStation(e);
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    catalog.set(s.id, s);
    prices.set(s.id, p);
  }
  saveCatalog();
  const fetchedAt = Date.now();
  store.set(keyFuel(fuelId), { t: fetchedAt, fecha: data.Fecha, p: [...prices] });
  return { fecha: data.Fecha, prices, fromCache: false, fetchedAt };
}

// ---------- Histórico ----------
function ddmmyyyy(date) {
  const p = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(date);
  const g = t => p.find(x => x.type === t).value;
  return `${g('day')}-${g('month')}-${g('year')}`;
}
const daysAgo = n => new Date(Date.now() - n * 86400000);

const histCache = new Map();
async function histOnce(key, path) {
  if (!histCache.has(key)) {
    histCache.set(key, getJSON(path, { timeout: 20000 }).then(d => {
      const m = new Map();
      for (const e of d.ListaEESSPrecio) {
        const p = num(e.PrecioProducto);
        if (Number.isFinite(p) && p > 0) m.set(e.IDEESS, p);
      }
      return m;
    }).catch(err => { histCache.delete(key); throw err; }));
  }
  return histCache.get(key);
}

/** Precios de una provincia para un combustible hace `n` días. */
export function provinceHistory(idProv, fuelId, n) {
  const f = ddmmyyyy(daysAgo(n));
  return histOnce(`p:${f}:${idProv}:${fuelId}`, `EstacionesTerrestresHist/FiltroProvinciaProducto/${f}/${idProv}/${fuelId}`);
}

/**
 * Serie de precios de una estación en los últimos `days` días (un punto cada `step` días).
 * @returns {Promise<Array<{date: Date, price: number}>>}
 */
export async function stationHistory(station, fuelId, { days = 30, step = 3 } = {}) {
  const points = [];
  for (let n = days; n >= 1; n -= step) points.push(n);
  const results = await Promise.allSettled(points.map(n => {
    const f = ddmmyyyy(daysAgo(n));
    return histOnce(`m:${f}:${station.idMuni}:${fuelId}`,
      `EstacionesTerrestresHist/FiltroMunicipioProducto/${f}/${station.idMuni}/${fuelId}`)
      .then(m => ({ date: daysAgo(n), price: m.get(station.id) }));
  }));
  return results
    .filter(r => r.status === 'fulfilled' && Number.isFinite(r.value.price))
    .map(r => r.value);
}

// ---------- Búsqueda de lugares ----------
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

let placeIndex = null, placeIndexSize = 0;
function buildPlaceIndex() {
  if (placeIndex && placeIndexSize === catalog.size) return placeIndex;
  const byMuni = new Map(), byCp = new Map();
  for (const s of catalog.values()) {
    const k = `${s.idMuni}`;
    const m = byMuni.get(k) || { label: `${tidy(s.muni)} (${s.prov})`, key: norm(s.muni), lat: 0, lon: 0, n: 0 };
    m.lat += s.lat; m.lon += s.lon; m.n++;
    byMuni.set(k, m);
    const c = byCp.get(s.cp) || { label: `${s.cp} · ${tidy(s.loc)}`, key: s.cp, lat: 0, lon: 0, n: 0 };
    c.lat += s.lat; c.lon += s.lon; c.n++;
    byCp.set(s.cp, c);
  }
  const fin = x => ({ ...x, lat: x.lat / x.n, lon: x.lon / x.n });
  placeIndex = { munis: [...byMuni.values()].map(fin), cps: [...byCp.values()].map(fin) };
  placeIndexSize = catalog.size;
  return placeIndex;
}

/** Sugerencias locales por municipio o código postal (sin salir del navegador). */
export function searchPlaces(query, limit = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  const { munis, cps } = buildPlaceIndex();
  if (/^\d{2,5}$/.test(q)) return cps.filter(c => c.key.startsWith(q)).slice(0, limit);
  const starts = munis.filter(m => m.key.startsWith(q));
  const contains = munis.filter(m => !m.key.startsWith(q) && m.key.includes(q));
  return [...starts.sort((a, b) => b.n - a.n), ...contains].slice(0, limit);
}

/** Búsqueda de direcciones en OpenStreetMap (solo si no hay coincidencias locales). */
export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=es&limit=5&accept-language=es&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('No se pudo buscar la dirección');
  const list = await res.json();
  return list.map(r => ({ label: r.display_name.split(',').slice(0, 3).join(','), lat: +r.lat, lon: +r.lon }));
}
