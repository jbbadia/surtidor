// Copia de seguridad: todo lo personal (coche y consumos, favoritas, descuentos, ajustes y diario)
// en un archivo, para no perderlo si el navegador borra sus datos o para pasarlo a otro dispositivo.
// Funciones puras (sin DOM) para poder probarlas.

import { sanitizeCar } from './car.js';
import { sanitizeEntry } from './log.js';

export const BACKUP_FORMAT = 'repostaje-rocio';
const FUEL_IDS = ['17', '1', '23', '20', '3', '21'];
const NOT_OURS = 'Ese archivo no es una copia de Repostaje Rocío.';

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const place = p => (p && num(p.lat, -90, 90) != null && num(p.lon, -180, 180) != null
  ? { lat: p.lat, lon: p.lon, label: String(p.label || '').slice(0, 120) } : null);

/** Deja solo lo que la aplicación entiende, con sus tipos; lo demás se descarta. */
function cleanPrefs(p) {
  const out = { car: sanitizeCar(p.car) };
  const fuels = Array.isArray(p.fuels) ? p.fuels.map(String).filter(f => FUEL_IDS.includes(f)) : [];
  if (fuels.length) out.fuels = [...new Set(fuels)];
  if (FUEL_IDS.includes(String(p.primary))) out.primary = String(p.primary);
  if (['price', 'dist', 'save'].includes(p.sort)) out.sort = p.sort;
  if (num(p.radius, 1, 200) != null) out.radius = p.radius;
  if (typeof p.openNow === 'boolean') out.openNow = p.openNow;
  if (typeof p.lowcost === 'boolean') out.lowcost = p.lowcost;
  if (typeof p.brand === 'string') out.brand = p.brand.slice(0, 80);
  out.center = place(p.center);
  out.favorites = Array.isArray(p.favorites) ? [...new Set(p.favorites.map(String))].slice(0, 500) : [];
  out.discounts = (Array.isArray(p.discounts) ? p.discounts : [])
    .filter(d => d && typeof d.brand === 'string' && num(+d.value, 0, 100) != null && ['cent', 'pct'].includes(d.type))
    .slice(0, 100)
    .map(d => ({ brand: d.brand.slice(0, 60), value: +d.value, type: d.type, ...(typeof d.offer === 'string' ? { offer: d.offer } : {}) }));
  out.glpTarget = num(p.glpTarget, 0.3, 3);
  const t = p.trip, from = t && place(t.from), to = t && place(t.to);
  out.trip = from && to ? {
    from, to, level: num(t.level, 0, 1) ?? 1, arrive: num(t.arrive, 0, 1) ?? 0, round: !!t.round,
    fuel: t.fuel === 'gas' ? 'gas' : 'glp', mode: t.mode === 'fast' ? 'fast' : 'cheap',
  } : null;
  return out;
}

/**
 * @param {object} prefs preferencias tal como se guardan
 * @param {Array<object>} entries repostajes del diario
 * @returns {{format: string, version: number, saved: string, prefs: object, repostajes: Array<object>}}
 */
export function makeBackup(prefs, entries, date = new Date()) {
  return {
    format: BACKUP_FORMAT, version: 1, saved: date.toISOString(),
    prefs: cleanPrefs(prefs || {}),
    repostajes: (Array.isArray(entries) ? entries : []).map(sanitizeEntry).filter(Boolean),
  };
}

/**
 * Lee el texto de un archivo de copia. Lanza un Error con un mensaje para el usuario si no vale.
 * @returns {{saved: string | null, prefs: object, entries: Array<object>}}
 */
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(NOT_OURS); }
  if (!data || data.format !== BACKUP_FORMAT || !data.prefs || typeof data.prefs !== 'object' || Array.isArray(data.prefs)) throw new Error(NOT_OURS);
  if (!(data.version <= 1)) throw new Error('Esta copia es de una versión más nueva de la aplicación. Actualiza la web y vuelve a intentarlo.');
  const saved = typeof data.saved === 'string' && !Number.isNaN(Date.parse(data.saved)) ? data.saved : null;
  return {
    saved,
    prefs: cleanPrefs(data.prefs),
    entries: (Array.isArray(data.repostajes) ? data.repostajes : []).map(sanitizeEntry).filter(Boolean),
  };
}

/** Resumen en una frase de lo que lleva una copia, para enseñarlo antes de restaurarla. */
export function describeBackup({ prefs, entries }) {
  const c = prefs.car, dec = v => String(v).replace('.', ',');
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return `${c.name} (GLP ${dec(c.glpCons)} L/100 km y ${dec(c.glpL)} L; gasolina ${dec(c.gasCons)} L/100 km y ${dec(c.gasL)} L), `
    + `${n(prefs.favorites.length, 'favorita', 'favoritas')}, ${n(prefs.discounts.length, 'descuento', 'descuentos')} y ${n(entries.length, 'repostaje', 'repostajes')} en el diario`;
}
