import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFERS, activeOffers, offerMatches, isExpired } from '../src/offers.js';

const byId = id => OFFERS.find(o => o.id === id);

test('caducan solas en su fecha (hora de Madrid)', () => {
  const ids = d => activeOffers(new Date(d)).map(o => o.id);
  assert.ok(ids('2026-11-30T22:30:00Z').includes('repsol-waylet'));   // 30/11 23:30 en Madrid: aún vale
  assert.ok(!ids('2026-11-30T23:30:00Z').includes('repsol-waylet'));  // 01/12 00:30 en Madrid: caducada
  assert.ok(ids('2026-12-15T12:00:00Z').includes('moeve-gow'));
  assert.ok(!ids('2027-01-01T12:00:00Z').includes('moeve-gow'));
  assert.ok(ids('2030-01-01T12:00:00Z').includes('eroski-oro'));     // sin fecha de fin
  assert.equal(isExpired('repsol-waylet', new Date('2026-12-02T12:00:00Z')), true);
  assert.equal(isExpired('no-existe'), true);
});

test('casa con el rótulo de la gasolinera por palabra completa', () => {
  assert.ok(offerMatches(byId('moeve-gow'), 'MOEVE'));
  assert.ok(offerMatches(byId('moeve-gow'), 'Cepsa Avenida'));
  assert.ok(offerMatches(byId('repsol-waylet'), 'REPSOL'));
  assert.ok(offerMatches(byId('mi-bp'), 'BP GUADALCANAL 365'));
  assert.ok(!offerMatches(byId('mi-bp'), 'BPXL ENERGIA'));
  assert.ok(!offerMatches(byId('ing-galp-shell'), 'GALPERIN'));
  assert.ok(offerMatches(byId('ing-galp-shell'), 'GALP/3CAMINOS-VALENCIA'));
});

test('todas las ofertas tienen fuente, condiciones y valor válido', () => {
  for (const o of OFFERS) {
    assert.match(o.url, /^https:\/\//, o.id);
    assert.ok(o.needs.length > 20, o.id);
    assert.ok(o.value > 0 && ['cent', 'pct'].includes(o.type), o.id);
    assert.ok(['sí', 'no consta'].includes(o.glp), o.id);
  }
});
