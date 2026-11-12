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

const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * ¿Hay un día de la semana en el que el combustible suela estar más barato?
 * Cada día se compara con la media de su semana (los 3 días anteriores y posteriores), para que
 * una subida o bajada general de precios no se confunda con un efecto del día.
 * Solo se da por confirmado si la diferencia es de al menos 0,3 cént/L y se repite en 3 de cada 4 semanas.
 * @param {Array<{day: string, value: number}>} points un valor por día ('YYYY-MM-DD')
 * @returns {null | {confirmed: boolean, best: {dow: number, name: string, diff: number, hits: number, n: number}, spread: number, weeks: number}}
 */
export function weekdayPattern(points) {
  const s = [...points].filter(p => Number.isFinite(p.value)).sort((a, b) => a.day.localeCompare(b.day));
  if (s.length < 35) return null;
  const t = s.map(p => Date.parse(p.day + 'T00:00:00Z') / 86400000);
  const groups = DOW.map(() => []);
  s.forEach((p, i) => {
    const around = s.filter((_, k) => Math.abs(t[k] - t[i]) <= 3);
    if (around.length < 6) return;                       // semana incompleta (bordes o huecos)
    const base = around.reduce((a, x) => a + x.value, 0) / around.length;
    groups[new Date(t[i] * 86400000).getUTCDay()].push(p.value - base);
  });
  const stats = groups.map((g, dow) => ({
    dow, name: DOW[dow], n: g.length,
    diff: g.length ? g.reduce((a, x) => a + x, 0) / g.length : 0,
    hits: g.filter(x => x < -0.0002).length,
  })).filter(x => x.n >= 4);
  if (stats.length < 7) return null;
  const best = stats.reduce((m, x) => (x.diff < m.diff ? x : m));
  const worst = stats.reduce((m, x) => (x.diff > m.diff ? x : m));
  return {
    confirmed: best.diff <= -0.003 && best.hits / best.n >= 0.75,
    best, worst, spread: worst.diff - best.diff, weeks: Math.round(s.length / 7),
  };
}
