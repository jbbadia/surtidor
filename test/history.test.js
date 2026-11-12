import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastPriceChange, daysAgoText, minutesAgoText } from '../src/history.js';

const d = s => new Date(s + 'T12:00:00Z');
const serie = (pairs) => pairs.map(([s, p]) => ({ date: d(s), price: p }));

test('fecha del último cambio = primer día con el precio actual', () => {
  const r = lastPriceChange(serie([['2026-11-07', 0.919], ['2026-11-08', 0.909], ['2026-11-09', 0.899], ['2026-11-10', 0.899], ['2026-11-12', 0.899]]));
  assert.equal(r.unchanged, false);
  assert.deepEqual(r.date, d('2026-11-09'));
  assert.equal(r.from, 0.909);
  assert.equal(r.to, 0.899);
});

test('cambio hoy', () => {
  const r = lastPriceChange(serie([['2026-11-10', 1.5], ['2026-11-11', 1.5], ['2026-11-12', 1.459]]));
  assert.deepEqual(r.date, d('2026-11-12'));
});

test('sin cambios en todo el periodo', () => {
  const r = lastPriceChange(serie([['2026-10-13', 0.899], ['2026-10-20', 0.899], ['2026-11-12', 0.899]]));
  assert.equal(r.unchanged, true);
  assert.equal(r.days, 30);
});

test('serie desordenada o insuficiente', () => {
  assert.equal(lastPriceChange([]), null);
  assert.equal(lastPriceChange(serie([['2026-11-12', 1]])), null);
  const r = lastPriceChange(serie([['2026-11-12', 1.2], ['2026-11-10', 1.3], ['2026-11-11', 1.2]]));
  assert.deepEqual(r.date, d('2026-11-11'));
});

test('textos relativos', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  assert.equal(daysAgoText(new Date('2026-11-12T01:00:00Z'), now), 'hoy');
  assert.equal(daysAgoText(new Date('2026-11-11T10:00:00Z'), now), 'ayer');
  assert.equal(daysAgoText(new Date('2026-11-09T10:00:00Z'), now), 'hace 3 días');
  assert.equal(minutesAgoText(20 * 1000), 'hace un momento');
  assert.equal(minutesAgoText(12 * 60000), 'hace 12 min');
  assert.equal(minutesAgoText(125 * 60000), 'hace 2 h 5 min');
  assert.equal(minutesAgoText(120 * 60000), 'hace 2 h');
});
