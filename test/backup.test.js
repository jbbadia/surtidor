import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, parseBackup, describeBackup, BACKUP_FORMAT } from '../src/backup.js';

const prefs = {
  fuels: ['17', '1'], primary: '17', sort: 'save', radius: 15, openNow: true, lowcost: false, brand: '',
  center: { lat: 39.47, lon: -0.38, label: 'Valencia' },
  favorites: ['1234', '5678'],
  discounts: [{ brand: 'REPSOL', value: 10, type: 'cent' }],
  car: { name: 'Dacia Sandero ECO-G 100 (2024)', glpL: 32, glpCons: 8.5, gasL: 50, gasCons: 6.1, gasFuel: '1' },
  glpTarget: 0.85,
  trip: { from: { lat: 39.47, lon: -0.38, label: 'Valencia' }, to: { lat: 40.42, lon: -3.7, label: 'Madrid' }, level: 1, arrive: 0.5, round: true, fuel: 'glp', mode: 'cheap' },
  simpleMap: true, targetSeen: 'x', consSeen: 8, lastBackup: 123,
};
const entries = [
  { id: 'a', date: '2026-10-20', fuel: '17', litres: 30, price: 0.899, odo: 10000, station: 'GALP', gasRef: 1.5 },
  { id: 'b', date: '2026-11-05', fuel: '17', litres: 30, price: 0.9, odo: 10375, station: '', gasRef: null },
];

test('la copia lleva el coche, los consumos, las favoritas y el diario', () => {
  const b = makeBackup(prefs, entries, new Date('2026-11-15T10:00:00Z'));
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.saved, '2026-11-15T10:00:00.000Z');
  assert.equal(b.prefs.car.glpCons, 8.5);
  assert.equal(b.prefs.car.gasCons, 6.1);
  assert.deepEqual(b.prefs.favorites, ['1234', '5678']);
  assert.equal(b.repostajes.length, 2);
});

test('lo propio de cada dispositivo no viaja en la copia', () => {
  const b = makeBackup(prefs, entries);
  for (const k of ['simpleMap', 'targetSeen', 'consSeen', 'lastBackup']) assert.equal(k in b.prefs, false, k);
});

test('guardar y restaurar devuelve lo mismo', () => {
  const back = parseBackup(JSON.stringify(makeBackup(prefs, entries, new Date('2026-11-15T10:00:00Z'))));
  assert.equal(back.saved, '2026-11-15T10:00:00.000Z');
  assert.deepEqual(back.prefs.car, prefs.car);
  assert.deepEqual(back.prefs.discounts, prefs.discounts);
  assert.equal(back.prefs.glpTarget, 0.85);
  assert.equal(back.prefs.radius, 15);
  assert.equal(back.prefs.sort, 'save');
  assert.deepEqual(back.prefs.trip, prefs.trip);
  assert.deepEqual(back.entries, entries);
});

test('rechaza archivos que no son una copia', () => {
  for (const bad of ['hola', '{}', '[]', '{"format":"otra","prefs":{}}', '{"format":"repostaje-rocio","prefs":[]}']) {
    assert.throws(() => parseBackup(bad), /no es una copia/, bad);
  }
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 9, prefs: {} })), /más nueva/);
});

test('una copia manipulada no rompe la aplicación', () => {
  const back = parseBackup(JSON.stringify({
    format: BACKUP_FORMAT, version: 1, saved: 'ayer',
    prefs: { car: { glpCons: -3, glpL: 'mucho' }, fuels: 'todos', primary: '99', radius: 1e9, favorites: 'x', discounts: [{ brand: 5 }, null], glpTarget: 50, center: { lat: 'a' }, trip: { from: {} }, raro: { x: 1 } },
    repostajes: [{ date: 'nunca', litres: 30, price: 1 }, { date: '2026-11-01', litres: 20, price: 0.9 }, 7],
  }));
  assert.equal(back.saved, null);
  assert.equal(back.prefs.car.glpCons, 7.4, 'valores imposibles vuelven a los del Sandero');
  assert.equal(back.prefs.car.glpL, 32);
  assert.equal('fuels' in back.prefs, false);
  assert.equal('primary' in back.prefs, false);
  assert.equal('radius' in back.prefs, false);
  assert.equal('raro' in back.prefs, false);
  assert.deepEqual(back.prefs.favorites, []);
  assert.deepEqual(back.prefs.discounts, []);
  assert.equal(back.prefs.glpTarget, null);
  assert.equal(back.prefs.center, null);
  assert.equal(back.prefs.trip, null);
  assert.equal(back.entries.length, 1);
});

test('el resumen dice lo que se va a restaurar', () => {
  const text = describeBackup(parseBackup(JSON.stringify(makeBackup(prefs, entries))));
  assert.match(text, /Dacia Sandero/);
  assert.match(text, /GLP 8,5 L\/100 km/);
  assert.match(text, /2 favoritas, 1 descuento y 2 repostajes/);
});
