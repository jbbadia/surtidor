import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRoute, alongRoute, fillPlan, cheapPlan, fastPlan, optimalPlan, thin, withRank } from '../src/trip.js';

// Ruta recta hacia el este por el paralelo 40: 1 grado de longitud ≈ 85,2 km.
const route = prepareRoute(Array.from({ length: 401 }, (_, i) => [40, -4 + i * 0.01]));
const st = (id, at, price, off = 0) => ({ id, at, price, off });
const base = { totalKm: 1000, rangeKm: 430, startKm: 430, reserveKm: 30, cons: 7.4 };

test('la ruta mide lo que debe', () => {
  assert.ok(Math.abs(route.km - 340.6) < 1, String(route.km));
  assert.ok(route.pts.length <= 1500);
});

test('estaciones junto a la ruta: km y separación', () => {
  const r = alongRoute(route, [
    { id: 'a', lat: 40.02, lon: -3 },       // ~2,2 km al norte, a 1 grado del inicio
    { id: 'b', lat: 40.2, lon: -2 },        // ~22 km: fuera del pasillo
    { id: 'c', lat: 40, lon: -5 },          // antes del inicio
    { id: 'd', lat: 39.99, lon: -0.5 },
  ], 5);
  assert.deepEqual(r.map(x => x.id), ['a', 'd']);
  assert.ok(Math.abs(r[0].off - 2.21) < 0.1, String(r[0].off));
  assert.ok(Math.abs(r[0].at - 85.2) < 1, String(r[0].at));
});

test('si el depósito alcanza, no hay paradas', () => {
  const p = fillPlan([st('a', 100, 0.9)], { ...base, totalKm: 300 });
  assert.equal(p.stops.length, 0);
  assert.equal(p.gapKm, 0);
});

test('compra lo justo en la cara y llena en la barata', () => {
  // Autonomía útil 400 km. Sale lleno. A (km 300) cara, B (km 500) barata, destino km 1000.
  const p = fillPlan([st('a', 300, 1.2), st('b', 500, 0.8), st('c', 800, 1.0)], base);
  assert.deepEqual(p.stops.map(s => s.id), ['a', 'b', 'c']);
  const [a, b, c] = p.stops;
  assert.ok(Math.abs(a.litres - 100 * 0.074) < 0.01, 'en A solo lo que falta para llegar a B');
  assert.ok(Math.abs(b.litres - 400 * 0.074) < 0.01, 'en B se llena');
  assert.ok(Math.abs(c.litres - 100 * 0.074) < 0.01, 'en C lo que falta para el destino');
  assert.equal(p.gapKm, 0);
});

test('el plan barato no para por ahorrar céntimos', () => {
  // B es 1 céntimo más barata que A: parar también en B no compensa.
  const sts = [st('a', 300, 0.90), st('b', 350, 0.89)];
  const all = fillPlan(sts, { ...base, totalKm: 650 });
  const cheap = cheapPlan(sts, { ...base, totalKm: 650 });
  assert.equal(cheap.stops.length, 1);
  assert.ok(cheap.cost - all.cost < 1);
});

test('el plan barato elige la barata y el rápido la que menos se desvía', () => {
  const sts = [st('lejos', 300, 0.80, 4), st('pegada', 320, 1.00, 0.1)];
  const o = { ...base, totalKm: 600 };
  assert.deepEqual(cheapPlan(sts, o).stops.map(s => s.id), ['lejos']);
  assert.deepEqual(fastPlan(sts, o).stops.map(s => s.id), ['pegada']);
  assert.ok(cheapPlan(sts, o).cost < fastPlan(sts, o).cost);
});

test('el plan rápido hace las menos paradas posibles', () => {
  const sts = [100, 200, 300, 390, 500, 600, 780, 900].map((at, i) => st('s' + i, at, 1 - i * 0.01));
  const p = fastPlan(sts, base);
  assert.equal(p.stops.length, 2);
  assert.equal(p.gapKm, 0);
});

test('tramo sin gasolineras: se avisa de los km sin cubrir', () => {
  const p = fillPlan([st('a', 100, 0.9)], { ...base, totalKm: 700, gapCostPerKm: 0.1 });
  assert.equal(p.gaps.length, 1);
  assert.ok(Math.abs(p.gapKm - 200) < 0.01, String(p.gapKm));     // 600 km desde A, 400 de autonomía
  assert.ok(Math.abs(p.cost - p.paid - 20) < 0.01);
});

test('sale casi vacío y no llega a la primera', () => {
  const p = fastPlan([st('a', 100, 0.9)], { ...base, totalKm: 300, startKm: 60 });
  assert.equal(p.gaps.length, 1);
  assert.ok(Math.abs(p.gaps[0].km - 70) < 0.01);
  assert.deepEqual(p.stops.map(s => s.id), ['a']);
});

test('el desvío se paga en litros', () => {
  const p = fillPlan([st('a', 300, 0.9, 2)], { ...base, totalKm: 500 });
  assert.ok(Math.abs(p.stops[0].detourKm - 5.2) < 0.01);
  assert.ok(Math.abs(p.stops[0].litres - (100 + 5.2) * 0.074) < 0.01);
});

test('se desvía si compensa, y no por un céntimo', () => {
  const o = { ...base, totalKm: 600 };
  const rank = sts => withRank(sts, 7.4, 20);
  // 10 km de la ruta (26 km de rodeo): un céntimo menos no lo paga, y 15 céntimos tampoco (rodeo exagerado).
  // A 4 km de la ruta y 25 céntimos más barata, sí.
  assert.deepEqual(cheapPlan(rank([st('lejos', 300, 0.89, 10), st('pegada', 320, 0.90, 0.1)]), o).stops.map(s => s.id), ['pegada']);
  assert.deepEqual(cheapPlan(rank([st('lejos', 300, 0.75, 10), st('pegada', 320, 0.90, 0.1)]), o).stops.map(s => s.id), ['pegada']);
  assert.deepEqual(cheapPlan(rank([st('lejos', 300, 0.65, 4), st('pegada', 320, 0.90, 0.1)]), o).stops.map(s => s.id), ['lejos']);
});

test('nunca cuenta con quedarse sin combustible: para antes, aunque sea más cara', () => {
  // Autonomía útil 400 km y la barata está en el km 420: faltan 20 km. «c» (km 250) es cara.
  const o = { ...base, totalKm: 700, gapCostPerKm: 0.08, minBuyKm: 70 };
  const p = cheapPlan([st('c', 250, 1.1), st('b', 420, 0.8)], o);
  assert.deepEqual(p.stops.map(s => s.id), ['c', 'b']);
  assert.equal(p.gapKm, 0);
});

test('no manda rellenar un par de litros recién salido si puede parar más adelante', () => {
  // «a» (km 20) es barata, pero con el depósito lleno solo cabrían 1,5 L.
  const o = { ...base, totalKm: 700, minBuyKm: 70 };
  const p = cheapPlan([st('a', 20, 0.9), st('c', 250, 1.1), st('b', 420, 0.8)], o);
  assert.deepEqual(p.stops.map(s => s.id), ['c', 'b']);
  assert.ok(p.stops[0].litres >= 70 * 0.074 - 0.01, 'si para, echa al menos el mínimo');
  assert.equal(p.gapKm, 0);
  // Si «a» es la única forma de llegar, se usa antes que quedarse tirado.
  const only = cheapPlan([st('a', 20, 0.9), st('b', 420, 0.8)], o);
  assert.deepEqual(only.stops.map(s => s.id), ['a', 'b']);
  assert.equal(only.gapKm, 0);
});

test('el plan barato no gasta más que comprar lo justo en cada gasolinera', () => {
  const sts = [st('a', 300, 1.2), st('b', 500, 0.8), st('c', 800, 1.0)];
  const p = cheapPlan(sts, base);
  assert.equal(p.gapKm, 0);
  assert.ok(p.cost <= fillPlan(sts, base).cost + 2.01, `${p.cost} vs ${fillPlan(sts, base).cost}`);
  assert.ok(p.stops.length <= 3);
});

test('el reparto óptimo coincide con «comprar lo justo» en 200 viajes al azar', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let t = 0; t < 200; t++) {
    const totalKm = 300 + Math.floor(rnd() * 1200);
    const used = new Set();
    const sts = [];
    for (let i = 0, n = 3 + Math.floor(rnd() * 25); i < n; i++) {
      const at = 1 + Math.floor(rnd() * (totalKm - 2));
      if (used.has(at)) continue;
      used.add(at);
      sts.push(st('s' + i, at, 0.7 + Math.round(rnd() * 60) / 100));
    }
    sts.sort((a, b) => a.at - b.at);
    const o = { ...base, totalKm, startKm: 60 + Math.floor(rnd() * 370), gapCostPerKm: 0.1 };
    const ref = fillPlan(sts, o), p = optimalPlan(sts, o, 0);
    assert.ok(Math.abs(p.gapKm - ref.gapKm) < 0.01, `viaje ${t}: tramos sin cubrir ${p.gapKm} vs ${ref.gapKm}`);
    assert.ok(Math.abs(p.paid - ref.paid) < 0.01, `viaje ${t}: ${p.paid} vs ${ref.paid}`);
  }
});

test('no para dos veces casi seguidas si evitarlo cuesta poco', () => {
  // Faltan 10 km para la barata (km 410). «n» (km 395) está pegada a ella; «c» (km 250), no.
  const o = { ...base, totalKm: 800, minBuyKm: 70 };
  const p = cheapPlan([st('c', 250, 1.0), st('n', 395, 0.95), st('b', 410, 0.8)], o);
  assert.equal(p.gapKm, 0);
  for (let i = 1; i < p.stops.length; i++) assert.ok(p.stops[i].at - p.stops[i - 1].at >= 40, p.stops.map(s => s.id).join(','));
});

test('lo que sobra al llegar se cuenta', () => {
  // Faltan 10 km y el mínimo son 70: sobran 60 km en el depósito.
  const p = cheapPlan([st('a', 300, 0.9)], { ...base, totalKm: 410, minBuyKm: 70 });
  assert.deepEqual(p.stops.map(s => s.id), ['a']);
  assert.equal(p.leftKm, 60);
  assert.ok(p.net < p.cost);
});

test('llega al destino con el depósito que se pide', () => {
  // 300 km con autonomía útil de 400: sin pedir nada no para; pidiendo llegar con 200 km, sí.
  const sts = [st('a', 100, 0.9), st('b', 250, 1.0)];
  const o = { ...base, totalKm: 300, minBuyKm: 70 };
  assert.equal(cheapPlan(sts, o).stops.length, 0);
  for (const plan of [cheapPlan, fastPlan]) {
    const p = plan(sts, { ...o, arriveKm: 200 });
    assert.ok(p.stops.length >= 1, plan.name);
    assert.ok(p.leftKm >= 200, `${plan.name}: llega con ${p.leftKm}`);
    assert.equal(p.gapKm, 0);
  }
  // Si no hay gasolinera para conseguirlo, llega con lo más que se pueda.
  const p = cheapPlan(sts, { ...o, arriveKm: 400 });
  assert.equal(p.leftKm, 350, 'llena en «b», a 50 km del destino');
});

test('tramo imposible: el plan barato lo avisa y aprovecha lo que hay', () => {
  const p = cheapPlan([st('a', 100, 0.9)], { ...base, totalKm: 700, gapCostPerKm: 0.1 });
  assert.deepEqual(p.stops.map(s => s.id), ['a']);
  assert.ok(Math.abs(p.gapKm - 200) < 1.01, String(p.gapKm));
});

test('cada parada dice si hay que llenar o basta con una parte', () => {
  const p = fillPlan([st('a', 300, 1.2), st('b', 500, 0.8), st('c', 800, 1.0)], base);
  assert.deepEqual(p.stops.map(s => s.full), [false, true, false]);
});

test('las paradas conservan los datos de la estación', () => {
  const p = fillPlan([{ ...st('a', 300, 0.9), sid: 'x', leg: 1 }], { ...base, totalKm: 500 });
  assert.equal(p.stops[0].sid, 'x');
  assert.equal(p.stops[0].leg, 1);
});

test('thin deja las más baratas de cada tramo y la más pegada a la ruta', () => {
  const sts = [st('a', 1, 1.5, 1), st('b', 2, 1.4, 1), st('c', 3, 1.3, 1), st('d', 4, 1.6, 0.1), st('e', 15, 1.7, 1)];
  assert.deepEqual(thin(sts, 10, 2).map(s => s.id), ['b', 'c', 'd', 'e']);
});
