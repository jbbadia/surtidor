// Ruta por carretera entre dos puntos con OSRM sobre datos de OpenStreetMap (gratis y sin clave).
// Se prueba el servidor de demostración de OSRM y, si falla, el de la comunidad alemana de OSM.

import { idbGet, idbSet } from './store.js';

const SERVERS = [
  'https://router.project-osrm.org/route/v1/driving/',
  'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
];

/**
 * Ruta por carretera que pasa por los puntos dados, en orden.
 * @param {Array<{lat: number, lon: number}>} points
 * @param {boolean} geometry false para pedir solo distancia y tiempo (respuesta mucho más pequeña)
 * @returns {Promise<{km: number, seconds: number, coords: Array<[number, number]>}>} coords en [lat, lon]
 */
export async function fetchVia(points, geometry = true) {
  const path = points.map(p => `${p.lon},${p.lat}`).join(';');
  let lastErr;
  for (const base of SERVERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${base}${path}?overview=${geometry ? 'full' : 'false'}&geometries=geojson`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`El servicio de rutas respondió ${res.status}`);
      const data = await res.json();
      if (data.code === 'NoRoute') throw Object.assign(new Error('No hay ruta por carretera entre esos dos puntos'), { final: true });
      const r = data.routes?.[0];
      if (data.code !== 'Ok' || !r) throw new Error('El servicio de rutas no devolvió ninguna ruta');
      return { km: r.distance / 1000, seconds: r.duration, coords: geometry ? r.geometry.coordinates.map(([lon, lat]) => [lat, lon]) : [] };
    } catch (err) {
      lastErr = err;
      if (err.final) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr?.final ? lastErr : new Error('No se pudo calcular la ruta ahora mismo. Comprueba la conexión y vuelve a intentarlo.');
}

// Las últimas rutas se guardan en el dispositivo: los servidores públicos no tienen garantía, y así
// un viaje ya calculado se puede repetir aunque estén caídos (y se les piden menos cosas).
const CACHE_KEY = 'surtidor:v1:rutas', CACHE_MAX = 6, FRESH_MS = 30 * 24 * 3600 * 1000;
const keyOf = (a, b) => [a.lat, a.lon, b.lat, b.lon].map(v => Number(v).toFixed(4)).join(',');
let writing = Promise.resolve();

/**
 * Ruta entre dos puntos. Si está guardada y tiene menos de 30 días, se usa sin llamar a nadie; si los
 * servidores fallan, se usa la guardada aunque sea más vieja (`stale: true`).
 * @param {{lat: number, lon: number}} a salida
 * @param {{lat: number, lon: number}} b destino
 * @returns {Promise<{km: number, seconds: number, coords: Array<[number, number]>, stale?: boolean}>}
 */
export async function fetchRoute(a, b) {
  const k = keyOf(a, b);
  const hit = ((await idbGet(CACHE_KEY)) || []).find(x => x.k === k);
  if (hit && Date.now() - hit.t < FRESH_MS) return hit.r;
  try {
    const r = await fetchVia([a, b]);
    writing = writing.then(async () => {
      const list = (await idbGet(CACHE_KEY)) || [];
      await idbSet(CACHE_KEY, [{ k, t: Date.now(), r }, ...list.filter(x => x.k !== k)].slice(0, CACHE_MAX));
    }).catch(() => {});
    return r;
  } catch (err) {
    if (hit && !err.final) return { ...hit.r, stale: true };
    throw err;
  }
}
