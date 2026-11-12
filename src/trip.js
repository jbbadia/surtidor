// Planificador de viaje: qué gasolineras quedan junto a la ruta y dónde conviene parar.
// Funciones puras (sin DOM ni red) para poder probarlas.

import { ROAD_FACTOR } from './car.js';

const toR = x => x * Math.PI / 180;
function haversine(a, b) {
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Prepara la geometría de una ruta: distancia acumulada en cada punto y una versión aligerada
 * (como mucho `maxPts` puntos) para que buscar gasolineras cercanas sea rápido.
 * @param {Array<[number, number]>} coords pares [lat, lon]
 * @returns {{pts: Array<{lat: number, lon: number, at: number}>, km: number}}
 */
export function prepareRoute(coords, maxPts = 1500) {
  const all = [];
  let at = 0;
  coords.forEach(([lat, lon], i) => {
    if (i) at += haversine(all[i - 1], { lat, lon });
    all.push({ lat, lon, at });
  });
  const step = Math.max(1, Math.ceil(all.length / maxPts));
  const pts = all.filter((_, i) => i % step === 0 || i === all.length - 1);
  return { pts, km: at };
}

/**
 * Estaciones a menos de `corridorKm` de la ruta, con el km de la ruta en el que quedan (`at`)
 * y lo que se apartan de ella en línea recta (`off`). Ordenadas por `at`.
 */
export function alongRoute(route, stations, corridorKm) {
  const { pts } = route;
  if (pts.length < 2) return [];
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
  }
  const mLat = corridorKm / 110.57, mLon = corridorKm / (111.32 * Math.cos(toR((minLat + maxLat) / 2)));
  const out = [];
  for (const s of stations) {
    if (s.lat < minLat - mLat || s.lat > maxLat + mLat || s.lon < minLon - mLon || s.lon > maxLon + mLon) continue;
    const kx = 111.32 * Math.cos(toR(s.lat)), ky = 110.57;     // km por grado alrededor de la estación
    let best = Infinity, bestAt = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ay = (a.lat - s.lat) * ky, by = (b.lat - s.lat) * ky;
      const seg = b.at - a.at;
      if (Math.min(Math.abs(ay), Math.abs(by)) > best + seg) continue;      // demasiado lejos para mejorar
      const ax = (a.lon - s.lon) * kx, bx = (b.lon - s.lon) * kx;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) { best = d; bestAt = a.at + t * seg; }
    }
    if (best <= corridorKm) out.push({ ...s, at: bestAt, off: best });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Con muchas estaciones (gasolina), deja las `keep` más baratas de cada tramo de `bucketKm`. */
export function thin(stations, bucketKm = 10, keep = 2) {
  const buckets = new Map();
  for (const s of stations) {
    const k = Math.floor(s.at / bucketKm);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
  const out = [];
  for (const list of buckets.values()) {
    const byPrice = [...list].sort((a, b) => a.price - b.price).slice(0, keep);
    const nearest = list.reduce((m, s) => (s.off < m.off ? s : m));
    out.push(...new Set([...byPrice, nearest]));
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Km extra aproximados de salir de la ruta hasta la estación y volver. */
export const detourKm = s => 2 * s.off * ROAD_FACTOR;

/**
 * Dadas las estaciones en las que se permite parar, cuánto echar en cada una para pagar lo mínimo:
 * en cada parada se compra lo justo para llegar a la siguiente más barata, o se llena si no la hay
 * a tiro. El destino cuenta como «gratis», así que al final solo se compra lo que falta para llegar.
 *
 * @param {Array<{id: string, at: number, off: number, price: number}>} stations ordenadas por `at`
 * @param {{totalKm: number, rangeKm: number, startKm: number, reserveKm: number, cons: number, gapCostPerKm?: number}} o
 *   rangeKm: autonomía con el depósito lleno; startKm: autonomía al salir; reserveKm: margen que no
 *   se quiere tocar; cons: L/100 km; gapCostPerKm: € por km de los tramos que no se pueden cubrir.
 */
export function fillPlan(stations, o) {
  const U = Math.max(1, o.rangeKm - o.reserveKm);
  const nodes = [...stations, { id: null, at: o.totalKm, off: 0, price: -1 }];
  const visits = [], gaps = [];
  let pos = 0, price = Infinity, fuel = Math.max(0, Math.min(o.startKm, o.rangeKm) - o.reserveKm);
  let here = null;                     // parada actual (null en la salida: ahí no se puede repostar)
  let i = 0;
  for (;;) {
    const cap = here ? U : fuel;       // lo máximo que se puede llevar al salir de este punto
    let j = i;
    while (nodes[j].price >= price) j++;
    let next = j;
    const d = nodes[j].at - pos;
    if (d <= cap) {
      if (here && d > fuel) { here.buyKm += d - fuel; fuel = d; }
      fuel -= d;
    } else {
      if (here && cap > fuel) { here.buyKm += cap - fuel; fuel = cap; }
      next = i;
      const dn = nodes[i].at - pos;
      if (dn <= fuel) fuel -= dn;
      else { gaps.push({ from: pos + fuel, to: nodes[i].at, km: dn - fuel }); fuel = 0; }
    }
    const n = nodes[next];
    if (n.id === null) break;
    pos = n.at; price = n.price; i = next + 1;
    here = { s: n, buyKm: 0 };
    visits.push(here);
  }
  const stops = visits.filter(v => v.buyKm > 0.01).map(v => {
    const det = detourKm(v.s);
    const litres = (v.buyKm + det) * o.cons / 100;
    return { id: v.s.id, at: v.s.at, off: v.s.off, price: v.s.price, detourKm: det, litres, cost: litres * v.s.price };
  });
  const gapKm = gaps.reduce((a, g) => a + g.km, 0);
  const litres = stops.reduce((a, s) => a + s.litres, 0);
  const paid = stops.reduce((a, s) => a + s.cost, 0);
  return {
    stops, gaps, gapKm, litres, paid,
    cost: paid + gapKm * (o.gapCostPerKm || 0),
    detourKm: stops.reduce((a, s) => a + s.detourKm, 0),
  };
}

/**
 * Plan más barato. Parte del reparto óptimo y quita las paradas que ahorran menos de `stopCost` €
 * (parar tiene un coste en tiempo: no merece la pena detenerse para ahorrar unos céntimos).
 */
export function cheapPlan(stations, o, stopCost = 1) {
  let best = fillPlan(stations, o);
  let ids = new Set(best.stops.map(s => s.id));
  for (;;) {
    let pick = null;
    for (const id of ids) {
      const rest = stations.filter(s => ids.has(s.id) && s.id !== id);
      const p = fillPlan(rest, o);
      if (p.gapKm > best.gapKm + 0.01 || p.cost - best.cost >= stopCost) continue;
      if (!pick || p.cost < pick.plan.cost) pick = { id, plan: p };
    }
    if (!pick) return best;
    ids.delete(pick.id);
    best = pick.plan;
    ids = new Set([...ids].filter(id => best.stops.some(s => s.id === id)));
  }
}

/**
 * Plan más rápido: las menos paradas posibles (se apura cada depósito) y, entre las que sirven,
 * la que menos se aparta de la ruta. El precio solo desempata.
 */
export function fastPlan(stations, o) {
  const U = Math.max(1, o.rangeKm - o.reserveKm);
  const chosen = [];
  let pos = 0, fuel = Math.max(0, Math.min(o.startKm, o.rangeKm) - o.reserveKm);
  while (pos + fuel < o.totalKm) {
    const ahead = stations.filter(s => s.at > pos + 0.001);
    if (!ahead.length) break;
    const reach = ahead.filter(s => s.at <= pos + fuel);
    let pick;
    if (reach.length) {
      const far = reach[reach.length - 1].at;
      const pool = reach.filter(s => s.at >= far - 0.25 * U);
      pick = pool.reduce((m, s) => (s.off < m.off - 0.05 || (Math.abs(s.off - m.off) <= 0.05 && s.price < m.price) ? s : m));
    } else {
      pick = ahead[0];                 // no se llega a ninguna: tramo sin cubrir hasta la primera
    }
    chosen.push(pick);
    pos = pick.at; fuel = U;
  }
  return fillPlan(chosen, o);
}
