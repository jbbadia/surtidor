// Diario de repostajes: consumo real, gasto por mes y ahorro por usar GLP.
// Funciones puras (sin DOM) para poder probarlas.

import { GLP } from './car.js';

const n = v => {
  const x = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : NaN;
};

/** Valida y normaliza un repostaje. Devuelve null si faltan los datos imprescindibles. */
export function sanitizeEntry(e = {}) {
  const litres = n(e.litres), price = n(e.price), odo = n(e.odo), gasRef = n(e.gasRef);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return null;
  if (!(litres > 0 && litres <= 200) || !(price > 0 && price <= 5)) return null;
  return {
    id: String(e.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`),
    date: e.date,
    fuel: String(e.fuel || GLP),
    litres: Math.round(litres * 100) / 100,
    price: Math.round(price * 1000) / 1000,
    odo: odo > 0 && odo < 2e6 ? Math.round(odo) : null,
    station: String(e.station || '').slice(0, 80),
    gasRef: gasRef > 0 && gasRef <= 5 ? gasRef : null,
  };
}

const byTime = (a, b) => a.date.localeCompare(b.date) || (a.odo ?? 0) - (b.odo ?? 0);

/**
 * Consumo real de GLP entre el primer y el último repostaje de GLP con kilómetros apuntados.
 * Supone que cada vez se llena el depósito. Los km hechos con gasolina se estiman con los litros
 * de gasolina repostados en ese intervalo y se descuentan.
 * @returns {{value: number, km: number, litres: number} | null}
 */
export function realGlpCons(entries, car) {
  const sorted = [...entries].sort(byTime);
  const marks = sorted.filter(e => e.fuel === GLP && e.odo);
  if (marks.length < 2) return null;
  const first = marks[0], last = marks[marks.length - 1];
  const between = sorted.slice(sorted.indexOf(first) + 1, sorted.indexOf(last) + 1);
  const glpL = between.filter(e => e.fuel === GLP).reduce((a, e) => a + e.litres, 0);
  const gasL = between.filter(e => e.fuel !== GLP).reduce((a, e) => a + e.litres, 0);
  const km = last.odo - first.odo;
  const kmGlp = km - (gasL / car.gasCons) * 100;
  if (!(kmGlp >= 50) || !(glpL > 0)) return null;
  const value = (glpL / kmGlp) * 100;
  return value >= 3 && value <= 25 ? { value, km: kmGlp, litres: glpL } : null;
}

/**
 * Resumen del diario.
 * @param {number|null} gasRefNow precio actual de la gasolina, para los repostajes que no lo guardaron
 */
export function logStats(entries, car, gasRefNow = null) {
  const glp = { litres: 0, spent: 0, count: 0 }, gas = { litres: 0, spent: 0, count: 0 };
  const months = new Map();
  const cons = realGlpCons(entries, car);
  const glpCons = cons?.value ?? car.glpCons;
  let saving = 0, savingKm = 0;
  for (const e of entries) {
    const cost = e.litres * e.price;
    const g = e.fuel === GLP ? glp : gas;
    g.litres += e.litres; g.spent += cost; g.count++;
    const key = e.date.slice(0, 7);
    const m = months.get(key) || { key, glp: 0, gas: 0, total: 0 };
    m[e.fuel === GLP ? 'glp' : 'gas'] += cost; m.total += cost;
    months.set(key, m);
    const ref = e.gasRef ?? gasRefNow;
    if (e.fuel === GLP && ref) {
      const km = (e.litres / glpCons) * 100;
      saving += (km * car.gasCons / 100) * ref - cost;
      savingKm += km;
    }
  }
  for (const g of [glp, gas]) g.avg = g.litres ? g.spent / g.litres : null;
  return {
    count: entries.length, spent: glp.spent + gas.spent, glp, gas, cons,
    months: [...months.values()].sort((a, b) => b.key.localeCompare(a.key)),
    saving: savingKm ? saving : null, savingKm,
  };
}

/** CSV con punto y coma y coma decimal, para abrirlo en Excel o Numbers en español. */
export function toCSV(entries, fuelName = f => f) {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const d = v => (v == null ? '' : String(v).replace('.', ','));
  const rows = [...entries].sort(byTime).map(e =>
    [e.date, q(fuelName(e.fuel)), d(e.litres), d(e.price), d((e.litres * e.price).toFixed(2)), d(e.odo), q(e.station)].join(';'));
  return ['Fecha;Combustible;Litros;Precio €/L;Total €;Km;Gasolinera', ...rows].join('\r\n');
}
