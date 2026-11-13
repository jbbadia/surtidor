import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDERO, GLP, costPer100, rangeKm, netSaving, tankFor, sanitizeCar, driveCost } from '../src/car.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('coste por 100 km del Sandero: GLP frente a gasolina', () => {
  // 0,899 €/L × 7,4 L = 6,65 €; 1,437 €/L × 5,6 L = 8,05 €
  close(costPer100(SANDERO, GLP, 0.899), 6.6526);
  close(costPer100(SANDERO, '1', 1.437), 8.0472);
});

test('autonomía por repostaje', () => {
  close(rangeKm(SANDERO, GLP), 32 / 7.4 * 100);   // ≈ 432 km
  close(rangeKm(SANDERO, '1'), 50 / 5.6 * 100);   // ≈ 893 km
  assert.equal(tankFor(SANDERO, GLP), 32);
  assert.equal(tankFor(SANDERO, '3'), 50);
});

test('ahorro neto: compensa desviarse', () => {
  // 10 cént/L más barata a 3 km más: 32 L × 0,10 = 3,20 € brutos;
  // desvío 3 × 2 × 1,3 = 7,8 km → 7,8 × 7,4 / 100 × 0,90 = 0,52 €
  const r = netSaving({ car: SANDERO, fuel: GLP, price: 0.90, dist: 5, refPrice: 1.00, refDist: 2 });
  close(r.gross, 3.2);
  close(r.extraKm, 7.8);
  close(r.detour, 7.8 * 7.4 / 100 * 0.90);
  assert.ok(r.net > 2.6 && r.net < 2.7);
});

test('ahorro neto: no compensa si está muy lejos', () => {
  const r = netSaving({ car: SANDERO, fuel: GLP, price: 0.99, dist: 20, refPrice: 1.00, refDist: 1 });
  assert.ok(r.gross > 0 && r.net < 0);
});

test('la propia estación de referencia no ahorra nada', () => {
  const r = netSaving({ car: SANDERO, fuel: '1', price: 1.5, dist: 1, refPrice: 1.5, refDist: 1 });
  assert.equal(r.net, 0);
});

test('preferencias corruptas vuelven a los datos del Sandero', () => {
  assert.deepEqual(sanitizeCar({ glpL: -3, glpCons: 'abc', gasFuel: '4' }), { ...SANDERO });
  assert.equal(sanitizeCar({ glpCons: 6.2 }).glpCons, 6.2);
});

test('coste de ir a una gasolinera con el consumo medio', () => {
  // 10 km en línea recta ≈ 13 km por carretera; a 7,4 L/100 km y 0,90 €/L son 0,87 €.
  const g = driveCost(SANDERO, GLP, 0.9, 10);
  assert.ok(Math.abs(g.km - 13) < 1e-9);
  assert.ok(Math.abs(g.cost - 13 * 0.074 * 0.9) < 1e-9);
  assert.ok(driveCost(SANDERO, '1', 1.5, 10).cost > 0);
  assert.equal(driveCost(SANDERO, GLP, 0.9, 0).cost, 0);
});
