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
 * Precio «de comparación» de cada estación: su precio más lo que cuesta el desvío repartido entre
 * los litros de un repostaje normal. Así una gasolinera apartada solo gana a una pegada a la ruta
 * si de verdad sale más barata contando el rodeo.
 */
export function withRank(stations, cons, typicalLitres) {
  return stations.map(s => ({ ...s, rank: s.price + (detourKm(s) * cons / 100) * s.price / typicalLitres }));
}

/**
 * Referencia para las pruebas (la web usa optimalPlan, que además evita repostajes diminutos).
 * Dadas las estaciones en las que se permite parar, cuánto echar en cada una para pagar lo mínimo:
 * en cada parada se compra lo justo para llegar a la siguiente más barata, o se llena si no la hay
 * a tiro. El destino cuenta como «gratis», así que al final solo se compra lo que falta para llegar.
 *
 * Para decidir se compara `rank` (ver withRank) si existe; lo que se paga es siempre `price`.
 *
 * @param {Array<{id: string, at: number, off: number, price: number, rank?: number}>} stations ordenadas por `at`
 * @param {{totalKm: number, rangeKm: number, startKm: number, reserveKm: number, cons: number, gapCostPerKm?: number}} o
 *   rangeKm: autonomía con el depósito lleno; startKm: autonomía al salir; reserveKm: margen que no
 *   se quiere tocar; cons: L/100 km; gapCostPerKm: € por km de los tramos que no se pueden cubrir.
 */
export function fillPlan(stations, o) {
  const U = Math.max(1, o.rangeKm - o.reserveKm);
  const nodes = [...stations, { id: null, at: o.totalKm, off: 0, price: -1 }];
  const rank = s => s.rank ?? s.price;
  const visits = [], gaps = [];
  let pos = 0, price = Infinity, fuel = Math.max(0, Math.min(o.startKm, o.rangeKm) - o.reserveKm);
  let here = null;                     // parada actual (null en la salida: ahí no se puede repostar)
  let i = 0;
  for (;;) {
    const cap = here ? U : fuel;       // lo máximo que se puede llevar al salir de este punto
    let j = i;
    while (rank(nodes[j]) >= price) j++;
    let next = j;
    const d = nodes[j].at - pos;
    if (d <= cap) {
      if (here && d > fuel) { here.buyKm += d - fuel; fuel = d; }
      if (here) here.full = fuel >= U - 1;
      fuel -= d;
    } else {
      if (here && cap > fuel) { here.buyKm += cap - fuel; fuel = cap; }
      if (here) here.full = true;
      next = i;
      const dn = nodes[i].at - pos;
      if (dn <= fuel) fuel -= dn;
      else { gaps.push({ from: pos + fuel, to: nodes[i].at, km: dn - fuel }); fuel = 0; }
    }
    const n = nodes[next];
    if (n.id === null) break;
    pos = n.at; price = rank(n); i = next + 1;
    here = { s: n, buyKm: 0 };
    visits.push(here);
  }
  const stops = visits.filter(v => v.buyKm > 0.01).map(v => {
    const det = detourKm(v.s);
    const litres = (v.buyKm + det) * o.cons / 100;
    return { ...v.s, detourKm: det, litres, cost: litres * v.s.price, full: !!v.full };
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
 * El reparto de paradas y litros que menos cuesta entre las gasolineras dadas, sin quedarse nunca
 * sin combustible si hay alguna a tiro. Se calcula probando todas las combinaciones (programación
 * dinámica sobre «gasolinera × km de autonomía en el depósito», de km en km).
 *
 * Reglas para que el plan sea cómodo de seguir:
 * - Cada parada cuesta `stopCost` € «de molestia»: no se para por ahorrar unos céntimos.
 * - Un repostaje de menos de `o.minBuyKm` km de autonomía (rellenar un depósito casi lleno) se
 *   evita siempre que haya otra forma de llegar; si se para, se echa al menos esa cantidad.
 * - Quedarse sin combustible es lo último: antes se para donde haga falta, aunque sea cara.
 * - El desvío hasta cada gasolinera se paga en litros a su precio; con `o.detourCostPerKm` cuenta
 *   además como molestia (€ por km de rodeo), para no proponer desvíos exagerados por poco ahorro.
 * - Con `o.arriveKm` se llega al destino con al menos esa autonomía (sin contar el margen) si hay
 *   gasolineras para conseguirlo; si no, con lo más que se pueda.
 *
 * @param {Array<{id: string, at: number, off: number, price: number}>} stations
 * @param {{totalKm: number, rangeKm: number, startKm: number, reserveKm: number, cons: number, gapCostPerKm?: number, minBuyKm?: number, arriveKm?: number}} o
 * @returns además de lo de fillPlan: `leftKm` (autonomía que sobra al llegar, sin contar el margen),
 *   `net` (coste descontando el valor de lo que sobra) y `obj` (lo que se ha minimizado).
 */
export function optimalPlan(stations, o, stopCost = 0) {
  const GAP = 20;                      // € por km sin cubrir, solo para decidir (lo último que se elige)
  const SMALL = 5;                     // € de pega a un repostaje menor que el mínimo
  const SHORT = 1;                     // € por km que falten para llegar con lo pedido (solo para decidir)
  const k = o.cons / 100;              // litros por km
  const U = Math.max(1, Math.floor(o.rangeKm - o.reserveKm));
  const F0 = Math.max(0, Math.min(U, Math.floor(Math.min(o.startKm, o.rangeKm) - o.reserveKm)));
  const m = Math.max(1, Math.min(U, Math.round(o.minBuyKm || 0)));
  const sts = [...stations].sort((x, y) => x.at - y.at);
  const n = sts.length;
  const end = Math.max(0, Math.round(o.totalKm));
  const pos = sts.map(s => Math.max(0, Math.min(end, Math.round(s.at))));
  const dist = i => (i < 0 ? (n ? pos[0] : end) : (i + 1 < n ? pos[i + 1] : end) - pos[i]);   // del nodo i al siguiente (-1: salida)

  // Avanza `d` km: de «coste según lo que llevas al salir» a «coste según lo que llevas al llegar».
  const zeroFrom = [];                 // con qué se salió del nodo anterior cuando se llega a 0
  const advance = (prev, d) => {
    const next = new Float64Array(U + 1).fill(Infinity);
    let zf = -1;
    for (let y = 0; y <= U; y++) {
      if (prev[y] === Infinity) continue;
      if (y > d) next[y - d] = prev[y];
      else { const c = prev[y] + (d - y) * GAP; if (c < next[0]) { next[0] = c; zf = y; } }
    }
    zeroFrom.push(zf);
    return next;
  };

  let cur = new Float64Array(U + 1).fill(Infinity);
  cur[F0] = 0;
  cur = advance(cur, dist(-1));
  const choice = [];                   // por gasolinera y nivel al salir: nivel antes de repostar, o -1 si no se para
  for (let i = 0; i < n; i++) {
    const c = sts[i].price * k, fee = stopCost + detourKm(sts[i]) * (c + (o.detourCostPerKm || 0));
    const after = new Float64Array(U + 1), from = new Int32Array(U + 1).fill(-1);
    let any = Infinity, anyX = -1, big = Infinity, bigX = -1;
    for (let y = 0; y <= U; y++) {
      if (y >= 1) { const v = cur[y - 1] - (y - 1) * c; if (v < any) { any = v; anyX = y - 1; } }
      if (y >= m) { const v = cur[y - m] - (y - m) * c; if (v < big) { big = v; bigX = y - m; } }
      let v = cur[y], f = -1;
      const vb = big + y * c + fee; if (vb < v) { v = vb; f = bigX; }
      const vs = any + y * c + fee + SMALL; if (vs < v) { v = vs; f = anyX; }
      after[y] = v; from[y] = f;
    }
    choice.push(from);
    cur = advance(after, dist(i));
  }

  // Lo que sobra al llegar no es dinero perdido: se descuenta casi al precio más barato de la ruta.
  const credit = n ? 0.95 * k * Math.min(...sts.map(s => s.price)) : 0;
  const want = Math.max(0, Math.min(U, Math.round(o.arriveKm || 0)));
  let x = 0, bestV = Infinity;
  for (let y = 0; y <= U; y++) { const v = cur[y] - y * credit + Math.max(0, want - y) * SHORT; if (v < bestV) { bestV = v; x = y; } }
  const leftKm = x;

  // Deshacer el camino: del destino hacia la salida.
  const stops = [], gaps = [];
  for (let i = n - 1; i >= -1; i--) {
    const d = dist(i);
    const y = x > 0 ? x + d : zeroFrom[i + 1];            // con cuánto se salió del nodo i
    const start = i < 0 ? 0 : pos[i];
    if (y < d) gaps.unshift({ from: start + y, to: start + d, km: d - y });
    if (i < 0) break;
    const before = choice[i][y];
    if (before >= 0) {
      const det = detourKm(sts[i]), litres = (y - before + det) * k;
      stops.unshift({ ...sts[i], detourKm: det, litres, cost: litres * sts[i].price, full: y >= U - 1 });
      x = before;
    } else x = y;
  }
  const gapKm = gaps.reduce((t, g) => t + g.km, 0);
  const litres = stops.reduce((t, s) => t + s.litres, 0);
  const paid = stops.reduce((t, s) => t + s.cost, 0);
  const cost = paid + gapKm * (o.gapCostPerKm || 0);
  return {
    stops, gaps, gapKm, litres, paid, cost, leftKm,
    net: cost - leftKm * credit, obj: bestV,
    detourKm: stops.reduce((t, s) => t + s.detourKm, 0),
  };
}

/**
 * Plan más barato: el reparto óptimo, pero sin dos paradas casi seguidas (a menos de `SPACING` km)
 * si evitarlo cuesta poco: nadie quiere parar dos veces en diez kilómetros.
 * Una parada más tiene que ahorrar al menos `stopCost` €.
 */
export function cheapPlan(stations, o, stopCost = 2) {
  const SPACING = 40, CLOSE = 5;       // km entre paradas; € que se aceptan de más por no parar dos veces seguidas
  o = { detourCostPerKm: 0.15, ...o };
  let list = stations, best = optimalPlan(list, o, stopCost);
  const accepted = new Set();
  for (let tries = 0; tries < 12; tries++) {
    const i = best.stops.findIndex((s, j) => j > 0 && s.at - best.stops[j - 1].at < SPACING && !accepted.has(`${best.stops[j - 1].id}|${s.id}`));
    if (i < 0) break;
    const pair = [best.stops[i - 1], best.stops[i]];
    const alts = pair.map(x => { const l = list.filter(s => s.id !== x.id); return { l, plan: optimalPlan(l, o, stopCost) }; })
      .sort((a, b) => a.plan.obj - b.plan.obj);
    if (alts[0].plan.obj <= best.obj + CLOSE) { list = alts[0].l; best = alts[0].plan; }
    else accepted.add(`${pair[0].id}|${pair[1].id}`);
  }
  return best;
}

/**
 * Plan más rápido: las menos paradas posibles (se apura cada depósito) y, entre las que sirven,
 * la que menos se aparta de la ruta. El precio solo desempata.
 */
export function fastPlan(stations, o) {
  // Mismas cuentas de km en km que optimalPlan, para que lo que aquí «llega» allí también llegue.
  const U = Math.max(1, Math.floor(o.rangeKm - o.reserveKm));
  const at = s => Math.round(s.at), total = Math.round(o.totalKm) + Math.max(0, Math.min(U, Math.round(o.arriveKm || 0)));
  const chosen = [];
  let pos = 0, fuel = Math.max(0, Math.min(U, Math.floor(Math.min(o.startKm, o.rangeKm) - o.reserveKm)));
  while (pos + fuel < total) {
    const ahead = stations.filter(s => at(s) > pos && !chosen.includes(s));
    if (!ahead.length) break;
    const reach = ahead.filter(s => at(s) <= pos + fuel);
    let pick;
    if (reach.length) {
      const far = at(reach[reach.length - 1]);
      const pool = reach.filter(s => at(s) >= far - 0.25 * U);
      pick = pool.reduce((m, s) => (s.off < m.off - 0.05 || (Math.abs(s.off - m.off) <= 0.05 && s.price < m.price) ? s : m));
    } else {
      pick = ahead[0];                 // no se llega a ninguna: tramo sin cubrir hasta la primera
    }
    chosen.push(pick);
    pos = at(pick); fuel = U;
  }
  return optimalPlan(chosen, o, 0);
}
