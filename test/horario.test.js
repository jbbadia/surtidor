import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHorario, openStatus, timeZoneFor } from '../src/horario.js';

// 2026-11-11 es miércoles. 12:00 en Madrid (CET, UTC+1) = 11:00Z.
const at = (iso) => new Date(iso);
const WED_NOON = at('2026-11-11T11:00:00Z');
const WED_2330 = at('2026-11-11T22:30:00Z');
const SAT_1500 = at('2026-11-14T14:00:00Z');
const SUN_1000 = at('2026-11-15T09:00:00Z');

test('24H todos los días', () => {
  assert.equal(openStatus('L-D: 24H', WED_2330).state, 'open');
  assert.equal(openStatus('L-D: 24H', WED_2330).label, 'Abierta 24 h');
});

test('horario simple abierto y cerrado', () => {
  assert.equal(openStatus('L-D: 06:00-22:00', WED_NOON).label, 'Abierta · cierra 22:00');
  assert.equal(openStatus('L-D: 06:00-22:00', WED_2330).state, 'closed');
});

test('hasta medianoche (00:00 como fin)', () => {
  const h = parseHorario('L-D: 06:00-00:00');
  assert.deepEqual(h.week[2], [[360, 1440]]);
  assert.equal(openStatus('L-D: 06:00-00:00', WED_2330).state, 'open');
});

test('varios tramos por día y por segmento', () => {
  const t = 'L-V: 07:00-14:00 y 16:00-21:00; S: 08:00-14:00';
  assert.equal(openStatus(t, WED_NOON).state, 'open');
  assert.equal(openStatus(t, at('2026-11-11T14:00:00Z')).label, 'Cerrada · abre 16:00'); // 15:00 local
  assert.equal(openStatus(t, SAT_1500).state, 'closed');
  assert.equal(openStatus(t, SUN_1000).label, 'Cerrada ahora');
});

test('rango que cruza la medianoche pasa al día siguiente', () => {
  const h = parseHorario('L-D: 22:00-06:00');
  // Lunes: su propio tramo de noche + la madrugada que viene del domingo.
  assert.deepEqual(h.week[0], [[1320, 1440], [0, 360]]);
  assert.deepEqual(h.week[1], [[1320, 1440], [0, 360]].reverse());
  assert.equal(openStatus('L-D: 22:00-06:00', WED_2330).state, 'open');
});

test('un solo día suelto es ambiguo', () => {
  assert.equal(parseHorario('L: 24H').ambiguous, true);
  assert.equal(openStatus('L: 06:00-22:00', WED_NOON).state, 'unknown');
});

test('texto no interpretable', () => {
  assert.equal(parseHorario('abierto a veces'), null);
  assert.equal(openStatus('', WED_NOON).state, 'unknown');
});

test('hora de Canarias va una hora por detrás', () => {
  assert.equal(timeZoneFor('35'), 'Atlantic/Canary');
  assert.equal(timeZoneFor('8'), 'Europe/Madrid');
  // 21:30 en Madrid = 20:30 en Canarias: abierta allí hasta las 21:00.
  const t = at('2026-11-11T20:30:00Z');
  assert.equal(openStatus('L-D: 07:00-21:00', t, 'Europe/Madrid').state, 'closed');
  assert.equal(openStatus('L-D: 07:00-21:00', t, 'Atlantic/Canary').state, 'open');
});
