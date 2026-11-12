import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, priceChanges, belowTarget } from '../src/alerts.js';
import { weekdayPattern } from '../src/history.js';

const now = { a: { 17: 0.889, 1: 1.5 }, b: { 17: 0.95 }, c: { 17: 1.0 } };
const priceOf = (id, f) => now[id]?.[f];

test('foto de precios de las favoritas', () => {
  assert.deepEqual(snapshot(['a', 'x'], ['17', '1'], priceOf), { a: { 17: 0.889, 1: 1.5 } });
});

test('cambios desde la última visita, bajadas primero', () => {
  const seen = { a: { 17: 0.909, 1: 1.5 }, b: { 17: 0.93 } };
  const ch = priceChanges(seen, ['a', 'b', 'c'], ['17', '1'], priceOf);
  assert.deepEqual(ch.map(c => [c.id, c.fuel]), [['a', '17'], ['b', '17']]);
  assert.ok(Math.abs(ch[0].diff + 0.02) < 1e-9);
});

test('precio objetivo', () => {
  const c = [{ id: 'a', price: 0.889 }, { id: 'b', price: 0.95 }, { id: 'c', price: 0.9 }];
  assert.deepEqual(belowTarget(c, 0.9).map(x => x.id), ['a', 'c']);
  assert.deepEqual(belowTarget(c, null), []);
});

const days = (n, f) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 8, 7) + i * 86400000);      // 7/9/2026 es lunes
  return { day: d.toISOString().slice(0, 10), value: f(d.getUTCDay(), i) };
});

test('día barato confirmado cuando se repite cada semana', () => {
  const r = weekdayPattern(days(56, dow => 0.95 - (dow === 1 ? 0.01 : 0)));
  assert.equal(r.confirmed, true);
  assert.equal(r.best.name, 'lunes');
  assert.ok(r.best.diff < -0.007);
});

test('una bajada general no se confunde con un día barato', () => {
  const r = weekdayPattern(days(56, (dow, i) => 1 - i * 0.001));
  assert.equal(r.confirmed, false);
});

test('precios planos: sin patrón; pocos datos: nada', () => {
  assert.equal(weekdayPattern(days(56, () => 0.95)).confirmed, false);
  assert.equal(weekdayPattern(days(20, () => 0.95)), null);
});
