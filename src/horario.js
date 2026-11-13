// Interpreta el campo "Horario" del Ministerio, p. ej.:
//   "L-D: 24H"
//   "L-V: 07:00-22:00; S: 08:00-14:00"
//   "L-S: 07:00-14:00 y 16:00-21:00; D: 08:00-14:00"
// Los días van de lunes (L) a domingo (D); X = miércoles.

const DAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const DAY_MIN = 24 * 60;

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * @returns {{week: Array<Array<[number, number]>>, ambiguous: boolean, assumed: boolean} | null}
 *   week[0] = lunes … week[6] = domingo, con tramos en minutos [inicio, fin).
 *   `assumed`: el texto solo nombraba el lunes y se ha tomado como «todos los días».
 *   `ambiguous`: un único día suelto que no es lunes; no se da por bueno.
 *   null si el texto no se puede interpretar.
 */
export function parseHorario(text) {
  if (!text || typeof text !== 'string') return null;
  const week = Array.from({ length: 7 }, () => []);
  const segments = text.split(';').map(s => s.trim()).filter(Boolean);
  if (!segments.length) return null;

  // Un único tramo de un solo día ("L: 24H", "L: 06:00-22:00"). El 13/11/2026 eran 498 estaciones
  // y en 488 el día era «L»: es el valor por defecto del formulario del Ministerio y quiere decir
  // «todos los días», así que se interpreta como L-D (marcándolo como supuesto). Si el día suelto
  // es otro (10 estaciones), no hay forma de saberlo y se deja como dudoso.
  const lone = segments.length === 1 && /^[LMXJVSD]:/.test(segments[0]);
  const assumed = lone && segments[0][0] === 'L';
  if (assumed) segments[0] = `L-D${segments[0].slice(1)}`;

  for (const seg of segments) {
    const m = /^([LMXJVSD])(?:-([LMXJVSD]))?:\s*(.+)$/.exec(seg);
    if (!m) return null;
    const from = DAYS.indexOf(m[1]);
    const to = m[2] ? DAYS.indexOf(m[2]) : from;
    const days = [];
    for (let d = from; ; d = (d + 1) % 7) { days.push(d); if (d === to) break; }

    const times = m[3].trim();
    const ranges = [];
    if (/^24\s*H$/i.test(times)) {
      ranges.push([0, DAY_MIN]);
    } else {
      for (const part of times.split(/\s+y\s+/i)) {
        const r = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part.trim());
        if (!r) return null;
        const a = toMin(r[1]);
        let b = toMin(r[2]);
        if (Number.isNaN(a) || Number.isNaN(b)) return null;
        if (b === 0) b = DAY_MIN;          // "06:00-00:00" = hasta medianoche
        ranges.push([a, b]);
      }
    }

    for (const d of days) {
      for (const [a, b] of ranges) {
        if (b > a) week[d].push([a, b]);
        else {                              // cruza la medianoche: "22:00-06:00"
          week[d].push([a, DAY_MIN]);
          week[(d + 1) % 7].push([0, b]);
        }
      }
    }
  }

  return { week, ambiguous: lone && !assumed, assumed };
}

const TZ_PENINSULA = 'Europe/Madrid';
const TZ_CANARIAS = 'Atlantic/Canary';
const CANARIAS_PROV = new Set(['35', '38']);

export function timeZoneFor(idProvincia) {
  return CANARIAS_PROV.has(String(idProvincia).padStart(2, '0')) ? TZ_CANARIAS : TZ_PENINSULA;
}

/** Día de la semana (0 = lunes) y minuto del día en la zona horaria dada. */
export function localDayMinute(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

function fmt(min) {
  if (min >= DAY_MIN) return '24:00';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * Estado de apertura.
 * @returns {{state: 'open'|'closed'|'unknown', label: string, assumed?: boolean}}
 *   `assumed`: el horario publicado solo nombraba el lunes (ver parseHorario); la etiqueta lo avisa.
 */
export function openStatus(text, date = new Date(), timeZone = TZ_PENINSULA) {
  const h = parseHorario(text);
  if (!h || h.ambiguous) return { state: 'unknown', label: 'Horario no claro' };
  const r = statusOf(h, date, timeZone);
  return h.assumed ? { ...r, label: `${r.label} (probable)`, assumed: true } : r;
}

function statusOf(h, date, timeZone) {
  const { day, minute } = localDayMinute(date, timeZone);
  const today = h.week[day];
  const isAllDay = r => r[0] === 0 && r[1] === DAY_MIN;
  if (today.some(isAllDay) && h.week.every(d => d.some(isAllDay))) return { state: 'open', label: 'Abierta 24 h' };
  const cur = today.find(([a, b]) => minute >= a && minute < b);
  if (cur) {
    // Si el tramo acaba a medianoche y mañana empieza a las 00:00, sigue abierta.
    const tomorrow = h.week[(day + 1) % 7];
    if (cur[1] === DAY_MIN && tomorrow.some(r => r[0] === 0)) return { state: 'open', label: 'Abierta ahora' };
    return { state: 'open', label: `Abierta · cierra ${fmt(cur[1])}` };
  }
  const next = today.filter(([a]) => a > minute).sort((x, y) => x[0] - y[0])[0];
  return { state: 'closed', label: next ? `Cerrada · abre ${fmt(next[0])}` : 'Cerrada ahora' };
}
