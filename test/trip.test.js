import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRoute, alongRoute, fillPlan, cheapPlan, fastPlan, thin } from '../src/trip.js';

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

test('thin deja las más baratas de cada tramo y la más pegada a la ruta', () => {
  const sts = [st('a', 1, 1.5, 1), st('b', 2, 1.4, 1), st('c', 3, 1.3, 1), st('d', 4, 1.6, 0.1), st('e', 15, 1.7, 1)];
  assert.deepEqual(thin(sts, 10, 2).map(s => s.id), ['b', 'c', 'd', 'e']);
});
