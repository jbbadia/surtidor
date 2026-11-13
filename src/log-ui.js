// Pestaña «Diario»: apuntar repostajes y ver consumo real, gasto por mes y ahorro con GLP.

import { sanitizeEntry, logStats, toCSV, realGlpCons } from './log.js';
import { GLP } from './car.js';
import { fuelById } from './api.js';

const KEY = 'surtidor:v1:repostajes';

export function initLog(ctx) {
  const { $, esc, euros, priceText, car, prefs, savePrefs } = ctx;
  let entries = [];
  try { entries = (JSON.parse(localStorage.getItem(KEY) || '[]') || []).map(sanitizeEntry).filter(Boolean); } catch { /* vacío */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* sin almacenamiento */ } };

  const num = (v, d = 1) => v.toFixed(d).replace('.', ',');
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  const dmy = iso => iso.split('-').reverse().join('/');
  const monthName = key => new Date(`${key}-15T12:00:00Z`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/^./, c => c.toUpperCase());
  const fuelLabel = f => (f === GLP ? 'GLP' : fuelById(f)?.long || 'Gasolina');
  let pendingRef = null;                 // precio de la gasolina de referencia al apuntar desde una ficha

  function fillFuels() {
    const c = car(), cur = $('l-fuel').value || GLP;
    $('l-fuel').innerHTML = `<option value="${GLP}">GLP</option><option value="${c.gasFuel}">${esc(fuelById(c.gasFuel).long)}</option>`;
    $('l-fuel').value = [GLP, c.gasFuel].includes(cur) ? cur : GLP;
  }
  function resetForm() {
    $('log-form').reset();
    fillFuels();
    $('l-date').value = today();
    $('l-date').max = today();
    $('l-form-title').textContent = 'Apuntar repostaje';
    pendingRef = null;
  }

  // Litros × precio = total: se rellena el que falte.
  const val = id => { const v = parseFloat(String($(id).value).replace(',', '.')); return v > 0 ? v : null; };
  for (const id of ['l-litres', 'l-price']) {
    $(id).addEventListener('input', () => { const l = val('l-litres'), p = val('l-price'); if (l && p) $('l-total').value = (l * p).toFixed(2); });
  }
  $('l-total').addEventListener('input', () => {
    const t = val('l-total'), p = val('l-price'), l = val('l-litres');
    if (t && p) $('l-litres').value = (t / p).toFixed(2);
    else if (t && l) $('l-price').value = (t / l).toFixed(3);
  });

  $('log-form').addEventListener('submit', e => {
    e.preventDefault();
    const fuel = $('l-fuel').value;
    const entry = sanitizeEntry({
      date: $('l-date').value, fuel, litres: $('l-litres').value, price: $('l-price').value,
      odo: $('l-odo').value, station: $('l-station').value.trim(),
      gasRef: fuel === GLP ? (pendingRef ?? ctx.gasRefNow()) : null,
    });
    if (!entry) { $('l-litres').focus(); return; }
    entries.push(entry);
    save(); resetForm(); render();
  });

  $('l-list').addEventListener('click', e => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '¿Seguro? Borrar'; return; }
    entries = entries.filter(x => x.id !== b.dataset.del);
    save(); render();
  });

  $('l-export').addEventListener('click', () => {
    const blob = new Blob(['﻿' + toCSV(entries, fuelLabel)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `repostajes-${today()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $('l-stats').addEventListener('click', e => {
    const b = e.target.closest('[data-use-cons]');
    if (!b) return;
    prefs.car = { ...car(), glpCons: +b.dataset.useCons };
    savePrefs(); ctx.onCarChange(); render();
  });

  function render() {
    const c = car();
    const s = logStats(entries, c, ctx.gasRefNow());
    const box = $('l-stats');
    $('l-export').hidden = !entries.length;
    $('l-list-title').hidden = !entries.length;
    if (!entries.length) {
      box.innerHTML = `<div class="empty"><strong>Tu diario está vacío</strong>Apunta aquí cada vez que repostes. Verás cuánto gastas al mes, tu consumo real y lo que llevas ahorrado por ir con GLP.</div>`;
      $('l-list').innerHTML = '';
      return;
    }
    const real = s.cons && Math.round(s.cons.value * 10) / 10;
    const consCell = s.cons
      ? `<div class="cc"><span class="cl">Consumo real de GLP</span><b class="num">${num(s.cons.value)} L/100</b><small>en ${Math.round(s.cons.km)} km · en «Mi coche»: ${num(c.glpCons)}</small></div>`
      : `<div class="cc"><span class="cl">Consumo real de GLP</span><b>—</b><small>apunta los km del coche en dos repostajes de GLP</small></div>`;
    const saveCell = s.saving != null
      ? `<div class="cc"><span class="cl">${s.saving >= 0 ? 'Ahorrado por ir con GLP' : 'El GLP te ha costado de más'}</span><b class="num ${s.saving >= 0 ? 'good' : ''}">${euros(Math.abs(s.saving))}</b><small>frente a hacer esos ${Math.round(s.savingKm).toLocaleString('es-ES')} km con gasolina</small></div>`
      : `<div class="cc"><span class="cl">Ahorro por ir con GLP</span><b>—</b><small>aparecerá al apuntar repostajes de GLP</small></div>`;
    const max = Math.max(...s.months.map(m => m.total));
    box.innerHTML = `
      <div class="car-cmp">${saveCell}${consCell}</div>
      ${s.cons && Math.abs(real - c.glpCons) >= 0.05 ? `<button type="button" class="link" data-use-cons="${real}">Usar ${num(real)} L/100 km en «Mi coche» para todos los cálculos</button>` : ''}
      <p class="l-total">Total apuntado: <b class="num">${euros(s.spent)}</b> en ${s.count} repostaje${s.count === 1 ? '' : 's'}${s.glp.avg ? ` · GLP a ${priceText(s.glp.avg)} €/L de media` : ''}</p>
      <h3>Gasto por mes</h3>
      <ul class="l-months">${s.months.slice(0, 12).map(m => `<li>
        <div class="l-m-top"><span>${esc(monthName(m.key))}</span><b class="num">${euros(m.total)}</b></div>
        <div class="l-bar"><i style="width:${Math.max(2, m.total / max * 100).toFixed(1)}%"></i></div>
        <small>GLP ${euros(m.glp)}${m.gas ? ` · gasolina ${euros(m.gas)}` : ''}</small></li>`).join('')}</ul>`;
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date) || (b.odo ?? 0) - (a.odo ?? 0));
    $('l-list').innerHTML = sorted.map(e => `<li class="l-entry">
      <div class="l-e-main">
        <div class="l-e-top"><b>${esc(dmy(e.date))}</b> · ${esc(fuelLabel(e.fuel))}${e.station ? ` · ${esc(e.station)}` : ''}</div>
        <div class="ad num">${num(e.litres, 2)} L × ${priceText(e.price)} €/L${e.odo ? ` · ${e.odo.toLocaleString('es-ES')} km` : ''}</div>
      </div>
      <div class="l-e-right"><b class="num">${euros(e.litres * e.price)}</b><button type="button" class="link" data-del="${esc(e.id)}">Borrar</button></div>
    </li>`).join('');
  }

  /** Abre el formulario relleno con una gasolinera (desde su ficha). */
  function prefill({ station, fuel, price, gasRef }) {
    resetForm();
    $('l-fuel').value = fuel === GLP ? GLP : car().gasFuel;
    if (price) $('l-price').value = price.toFixed(3);
    $('l-station').value = station || '';
    $('l-form-title').textContent = `Apuntar repostaje en ${station || 'esta gasolinera'}`;
    pendingRef = gasRef ?? null;
    render();
    setTimeout(() => { $('log-form').scrollIntoView({ block: 'start', behavior: 'smooth' }); $('l-litres').focus({ preventScroll: true }); }, 50);
  }

  resetForm();
  /** Consumo real de GLP redondeado a una décima, o null si aún no hay dos repostajes con km. */
  const realCons = () => { const r = realGlpCons(entries, car()); return r ? Math.round(r.value * 10) / 10 : null; };
  return { show: on => { if (on) { fillFuels(); render(); } }, prefill, count: () => entries.length, realCons, refresh: render };
}
