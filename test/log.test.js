import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEntry, realGlpCons, logStats, toCSV } from '../src/log.js';
import { SANDERO } from '../src/car.js';

const e = (date, fuel, litres, price, odo, extra = {}) => sanitizeEntry({ date, fuel, litres, price, odo, ...extra });

test('valida los repostajes', () => {
  assert.equal(sanitizeEntry({ date: '2026-11-12', litres: 0, price: 0.9 }), null);
  assert.equal(sanitizeEntry({ date: '12/11/2026', litres: 30, price: 0.9 }), null);
  const ok = sanitizeEntry({ date: '2026-11-12', litres: '30,5', price: '0,899', odo: '' });
  assert.equal(ok.litres, 30.5); assert.equal(ok.price, 0.899); assert.equal(ok.odo, null); assert.equal(ok.fuel, '17');
});

test('consumo real de GLP entre repostajes con km', () => {
  const list = [e('2026-10-01', '17', 30, 0.9, 10000), e('2026-10-08', '17', 28, 0.9, 10350), e('2026-10-15', '17', 32, 0.9, 10750)];
  const c = realGlpCons(list, SANDERO);
  assert.ok(Math.abs(c.value - 8) < 0.001, String(c.value));       // 60 L en 750 km
  assert.equal(c.km, 750);
});

test('descuenta los km hechos con gasolina', () => {
  const list = [e('2026-10-01', '17', 30, 0.9, 10000), e('2026-10-05', '1', 5.6, 1.5, null), e('2026-10-15', '17', 32, 0.9, 10500)];
  const c = realGlpCons(list, SANDERO);
  assert.ok(Math.abs(c.km - 400) < 1e-9);                          // 5,6 L de gasolina ≈ 100 km
  assert.ok(Math.abs(c.value - 8) < 0.001);
});

test('sin dos repostajes con km no hay consumo real', () => {
  assert.equal(realGlpCons([e('2026-10-01', '17', 30, 0.9, 10000), e('2026-10-08', '17', 28, 0.9, null)], SANDERO), null);
});

test('gasto por mes y ahorro frente a gasolina', () => {
  const list = [e('2026-10-20', '17', 30, 0.9, null, { gasRef: 1.5 }), e('2026-11-02', '17', 20, 1.0, null), e('2026-11-03', '1', 10, 1.5, null)];
  const s = logStats(list, SANDERO, 1.6);
  assert.deepEqual(s.months.map(m => m.key), ['2026-11', '2026-10']);
  assert.ok(Math.abs(s.months[0].total - 35) < 1e-9);
  assert.ok(Math.abs(s.spent - 62) < 1e-9);
  const want = (30 / 7.4 * 5.6 * 1.5 - 27) + (20 / 7.4 * 5.6 * 1.6 - 20);
  assert.ok(Math.abs(s.saving - want) < 1e-6, String(s.saving));
});

test('CSV con coma decimal', () => {
  const csv = toCSV([e('2026-11-02', '17', 20.5, 0.899, 12345, { station: 'REPSOL "Sur"' })], () => 'GLP');
  assert.equal(csv.split('\r\n')[1], '2026-11-02;"GLP";20,5;0,899;18,43;12345;"REPSOL ""Sur"""');
});
