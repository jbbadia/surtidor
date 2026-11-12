// Cálculos sobre la serie diaria de precios de una estación (sin DOM, para poder probarlos).

/**
 * Último cambio de precio a partir de una serie diaria ordenada por fecha (la última es hoy).
 * El histórico del Ministerio es diario, así que el cambio se fecha en el primer día que
 * aparece el precio actual.
 * @param {Array<{date: Date, price: number}>} series
 * @returns {null | {unchanged: true, since: Date, days: number} | {unchanged: false, date: Date, from: number, to: number}}
 */
export function lastPriceChange(series) {
  if (!series || series.length < 2) return null;
  const s = [...series].sort((a, b) => a.date - b.date);
  const cur = s[s.length - 1].price;
  const same = (a, b) => Math.abs(a - b) < 0.0005;
  for (let i = s.length - 2; i >= 0; i--) {
    if (!same(s[i].price, cur)) return { unchanged: false, date: s[i + 1].date, from: s[i].price, to: cur };
  }
  return { unchanged: true, since: s[0].date, days: Math.round((s[s.length - 1].date - s[0].date) / 86400000) };
}

/** "hoy", "ayer", "hace 3 días" */
export function daysAgoText(date, now = new Date()) {
  const day = d => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
    return Date.parse(p + 'T00:00:00Z');
  };
  const n = Math.round((day(now) - day(date)) / 86400000);
  return n <= 0 ? 'hoy' : n === 1 ? 'ayer' : `hace ${n} días`;
}

/** "hace un momento", "hace 12 min", "hace 2 h 5 min" */
export function minutesAgoText(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 24) return `hace ${Math.floor(h / 24)} d`;
  return `hace ${h} h${r ? ` ${r} min` : ''}`;
}
