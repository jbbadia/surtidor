// Pestaña «Viaje»: formulario, cálculo de la ruta y dibujo de las paradas en el mapa.

import { fetchRoute } from './route.js';
import { prepareRoute, alongRoute, thin, cheapPlan, fastPlan } from './trip.js';
import { GLP, tankFor, consFor } from './car.js';
import { median } from './history.js';
import { catalog, fuelById, searchPlaces, geocode } from './api.js';

const GLP_CORRIDOR = 6, GAS_CORRIDOR = 3;      // km a cada lado de la ruta
const LEVELS = { 1: 'lleno', 0.75: 'a 3/4', 0.5: 'a la mitad', 0.25: 'a 1/4', 0.1: 'casi vacío' };

export function initTrip(ctx) {
  const { L, map, $, esc, euros, priceText, prefs, savePrefs, car } = ctx;
  const layer = L.layerGroup();
  const places = { from: null, to: null };
  let state = null;
  let mode = prefs.trip?.mode === 'fast' ? 'fast' : 'cheap';
  let visible = false;

  const num = (v, d = 1) => v.toFixed(d).replace('.', ',');
  function status(text, err = false) {
    const el = $('t-status');
    el.textContent = text; el.hidden = !text; el.classList.toggle('err', err);
  }

  // ---------- Salida y destino ----------
  function setPlace(key, it) {
    places[key] = { lat: it.lat, lon: it.lon, label: it.label };
    $(`t-${key}`).value = it.label;
  }
  function placeInput(key) {
    const input = $(`t-${key}`), ul = $(`t-${key}-sug`);
    let items = [];
    const show = list => {
      items = list;
      ul.innerHTML = list.map((it, i) => `<li role="option" data-i="${i}">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</li>`).join('');
      ul.hidden = !list.length;
    };
    input.addEventListener('input', () => {
      places[key] = null;
      const text = input.value.trim();
      const local = searchPlaces(text, 6);
      show(local.length || text.length < 4 ? local : [{ label: `Buscar «${text}» como dirección`, hint: 'OpenStreetMap', geocode: text }]);
    });
    ul.addEventListener('mousedown', async e => {
      const li = e.target.closest('li');
      if (!li) return;
      e.preventDefault();
      const it = items[+li.dataset.i];
      if (!it.geocode) { setPlace(key, it); ul.hidden = true; return; }
      try {
        const found = await geocode(it.geocode);
        if (found.length) show(found); else { ul.hidden = true; status(`No encontramos «${it.geocode}» en España.`, true); }
      } catch (err) { status(err.message, true); }
    });
    input.addEventListener('blur', () => setTimeout(() => { ul.hidden = true; }, 150));
  }
  async function resolve(key, name) {
    if (places[key]) return places[key];
    const text = $(`t-${key}`).value.trim();
    if (!text) throw new Error(`Escribe ${name}.`);
    const hit = searchPlaces(text, 1)[0] || (await geocode(text))[0];
    if (!hit) throw new Error(`No encontramos «${text}» en España. Prueba con el municipio o el código postal.`);
    setPlace(key, hit);
    return places[key];
  }
  placeInput('from'); placeInput('to');
  $('t-here').addEventListener('click', () => {
    if (!('geolocation' in navigator)) { status('Tu navegador no permite obtener la ubicación.', true); return; }
    status('Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(
      pos => { setPlace('from', { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Mi ubicación' }); status(''); },
      () => status('No se pudo obtener tu ubicación. Escribe el municipio de salida.', true),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  });

  function fillFuelSelect() {
    const c = car();
    const cur = $('t-fuel').value || prefs.trip?.fuel || 'glp';
    $('t-fuel').innerHTML = `<option value="glp">GLP</option><option value="gas">${esc(fuelById(c.gasFuel).long)}</option>`;
    $('t-fuel').value = cur;
  }
  fillFuelSelect();
  if (prefs.trip) {
    if (prefs.trip.from) setPlace('from', prefs.trip.from);
    if (prefs.trip.to) setPlace('to', prefs.trip.to);
    if (prefs.trip.level) $('t-level').value = String(prefs.trip.level);
  }

  // ---------- Cálculo ----------
  function candidates(route, fuelId, corridor) {
    const data = ctx.fuelData.get(fuelId);
    if (!data) return [];
    const sts = [];
    for (const [id, p] of data.prices) {
      const s = catalog.get(id);
      if (s) sts.push({ id, lat: s.lat, lon: s.lon, price: ctx.effective(s, p) });
    }
    return alongRoute(route, sts, corridor);
  }

  $('trip-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('t-go');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Calculando…';
    $('t-from-sug').hidden = true; $('t-to-sug').hidden = true;
    status('Calculando la ruta…');
    try {
      const from = await resolve('from', 'de dónde sales');
      const to = await resolve('to', 'a dónde vas');
      const c = car();
      const fuel = $('t-fuel').value === 'gas' ? c.gasFuel : GLP;
      const level = +$('t-level').value || 1;
      const [r] = await Promise.all([fetchRoute(from, to), ctx.ensureFuel(GLP).catch(() => null), ctx.ensureFuel(c.gasFuel).catch(() => null)]);
      const route = prepareRoute(r.coords);
      const glp = candidates(route, GLP, GLP_CORRIDOR);
      const gas = candidates(route, c.gasFuel, GAS_CORRIDOR);
      const medGlp = glp.length ? median(glp.map(s => s.price)) : null;
      const medGas = gas.length ? median(gas.map(s => s.price)) : null;
      const isGlp = fuel === GLP;
      const cands = isGlp ? glp : thin(gas, 10, 2);
      const cons = consFor(c, fuel), rangeKm = (tankFor(c, fuel) / cons) * 100;
      const o = {
        totalKm: route.km, rangeKm, startKm: level * rangeKm, cons,
        reserveKm: Math.min(isGlp ? 30 : 50, rangeKm * 0.15),
        gapCostPerKm: isGlp && medGas ? (c.gasCons / 100) * medGas : 0,
      };
      state = {
        from, to, coords: r.coords, km: r.km, seconds: r.seconds, fuel, isGlp, level, cands, o, medGlp, medGas,
        plans: { cheap: cheapPlan(cands, o), fast: fastPlan(cands, o) },
      };
      prefs.trip = { from, to, level, fuel: isGlp ? 'glp' : 'gas', mode };
      savePrefs();
      status('');
      render();
      drawRoute(true);
    } catch (err) {
      status(err.message || 'No se pudo calcular la ruta.', true);
    } finally {
      btn.disabled = false; btn.textContent = 'Calcular ruta';
    }
  });

  // ---------- Resultado ----------
  const hm = sec => { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const stopsText = n => `${n} parada${n === 1 ? '' : 's'}`;

  function planSummary(p, other) {
    const { o, isGlp, level } = state;
    const name = isGlp ? 'GLP' : 'gasolina';
    let html;
    if (!p.stops.length && !p.gapKm) {
      html = `<b>No necesitas repostar.</b> Con el depósito ${LEVELS[level] || 'así'} tienes para unos ${Math.round(o.startKm)} km de ${name} y el viaje son ${Math.round(o.totalKm)} km.`;
    } else if (!p.stops.length) {
      html = `<b>No hay gasolineras con ${name} junto a esta ruta.</b>`;
    } else {
      html = `<b>${stopsText(p.stops.length)}</b> · pagas <b>${euros(p.paid)}</b> por ${num(p.litres)} L (${priceText(p.paid / p.litres)} €/L de media)${p.detourKm >= 0.5 ? ` · unos ${num(p.detourKm, 0)} km de desvío en total` : ' · casi sin desvío'}.`;
      const diff = other.cost - p.cost;
      if (mode === 'cheap' && diff > 0.05) html += ` Ahorras <b class="good">${euros(diff)}</b> frente a la ruta más rápida.`;
      else if (mode === 'fast' && diff < -0.05) {
        const less = other.stops.length - p.stops.length;
        html += ` Cuesta ${euros(-diff)} más que la más barata${less > 0 ? `, con ${stopsText(less)} menos` : other.detourKm - p.detourKm >= 1 ? `, con ${num(other.detourKm - p.detourKm, 0)} km menos de desvío` : ''}.`;
      } else if (other.stops.length && Math.abs(diff) <= 0.05) html += ' En este viaje, la más barata y la más rápida coinciden.';
    }
    return html;
  }

  function stopRow(x, n) {
    const s = catalog.get(x.id);
    if (!s) return '';
    const sub = n
      ? `<div class="t-do">Echa al menos <b>${num(x.litres)} L</b> · ${euros(x.cost)}</div>`
      : '';
    return `<li class="t-stop" data-id="${x.id}" tabindex="0">
      ${n ? `<span class="t-n">${n}</span>` : ''}
      <div class="t-main">
        <div class="nm">${esc(s.name)}</div>
        <div class="ad">Km ${Math.round(x.at)} de la ruta · ${esc(s.loc)} (${esc(s.prov)})</div>
        ${sub}
        <div class="ad">${x.off < 0.3 ? 'Junto a la ruta' : `A ${num(x.off)} km de la ruta`}${s.horario ? ` · ${esc(s.horario)}` : ''}</div>
      </div>
      <div class="price">${ctx.priceHTML(x.price)}<span class="u">€/L</span></div>
    </li>`;
  }

  function render() {
    const el = $('t-result');
    if (!state) { el.innerHTML = ''; return; }
    const c = car();
    const { km, seconds, isGlp, medGlp, medGas, cands, plans, o, from, to } = state;
    const p = plans[mode], other = plans[mode === 'cheap' ? 'fast' : 'cheap'];
    const lGlp = km * c.glpCons / 100, lGas = km * c.gasCons / 100;
    const cell = (label, litres, med, cons) => med
      ? `<div class="cc"><span class="cl">${esc(label)}</span><b class="num">${euros(litres * med)}</b><small>${num(litres)} L a ${priceText(med)} €/L de media en la ruta · ${num(cons)} L/100 km</small></div>`
      : `<div class="cc"><span class="cl">${esc(label)}</span><b>—</b><small>sin gasolineras junto a la ruta</small></div>`;
    let verdict = '';
    if (medGlp && medGas) {
      const d = lGas * medGas - lGlp * medGlp;
      verdict = d > 0 ? `En este viaje, ir con GLP te ahorra <b>${euros(d)}</b> frente a la gasolina.` : `En este viaje la gasolina sale <b>${euros(-d)}</b> más barata que el GLP.`;
    }
    const gaps = p.gapKm > 0.5
      ? `<div class="warn"><strong>${isGlp ? 'Tramo sin GLP' : 'Tramo sin gasolineras'}</strong>${isGlp
        ? `Hay ${num(p.gapKm, 0)} km en los que no llegas con GLP (${p.gaps.map(g => `del km ${Math.round(g.from)} al ${Math.round(g.to)}`).join(', ')}). El coche pasará solo a gasolina${o.gapCostPerKm ? `: unos ${euros(p.gapKm * o.gapCostPerKm)}` : ''}.`
        : `No encontramos gasolineras para cubrir ${num(p.gapKm, 0)} km de la ruta. Sal con más combustible.`}</div>`
      : '';
    const wp = p.stops.map(x => catalog.get(x.id)).filter(Boolean).map(s => `${s.lat},${s.lon}`).join('|');
    const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${to.lat},${to.lon}&travelmode=driving${wp ? `&waypoints=${encodeURIComponent(wp)}` : ''}`;
    const cheapest = [...cands].sort((a, b) => a.price - b.price).slice(0, 8);

    el.innerHTML = `
      <div class="t-sum">
        <h3>${esc(from.label.replace(/\s*\(.*\)$/, ''))} → ${esc(to.label.replace(/\s*\(.*\)$/, ''))}</h3>
        <p class="t-big"><b class="num">${num(km, 0)} km</b> · unas ${hm(seconds)} sin paradas</p>
        <p class="eyebrow">Gasto medio del viaje con tu ${esc(c.name)}</p>
        <div class="car-cmp">${cell('Con GLP', lGlp, medGlp, c.glpCons)}${cell(`Con ${fuelById(c.gasFuel).long}`, lGas, medGas, c.gasCons)}</div>
        ${verdict ? `<p class="car-verdict">${verdict}</p>` : ''}
      </div>
      <div class="t-plan">
        <p class="eyebrow">Dónde repostar ${isGlp ? 'GLP' : 'gasolina'}</p>
        <div class="seg t-mode" role="group" aria-label="Tipo de ruta">
          <button type="button" data-mode="cheap" aria-pressed="${mode === 'cheap'}">Más barata</button>
          <button type="button" data-mode="fast" aria-pressed="${mode === 'fast'}">Más rápida</button>
        </div>
        <p class="hint">${mode === 'cheap' ? 'Para en las gasolineras más baratas de la ruta, aunque haya que desviarse un poco.' : 'Las menos paradas posibles y pegadas a la carretera, cueste lo que cueste.'}</p>
        <p class="t-plan-sum" id="t-plan-sum">${planSummary(p, other)}</p>
        ${gaps}
        <ol class="t-stops" id="t-stops">${p.stops.map((x, i) => stopRow(x, i + 1)).join('')}</ol>
        <a class="btn primary" href="${esc(gmaps)}" target="_blank" rel="noopener">Abrir la ruta en Google Maps${p.stops.length ? ' con las paradas' : ''}</a>
      </div>
      ${cheapest.length ? `<details class="t-all"><summary>Las ${cheapest.length} más baratas de la ruta (${cands.length} gasolineras con ${isGlp ? 'GLP' : 'gasolina'})</summary><ol class="t-stops">${cheapest.map(x => stopRow(x, 0)).join('')}</ol></details>` : ''}
      <p class="src">Los litros de cada parada son los mínimos para llegar con unos ${Math.round(o.reserveKm)} km de margen; si llenas el depósito, mejor en la parada más barata. Consumo de «Mi coche» (${num(o.cons)} L/100 km): en autovía suele ser algo mayor. Ruta y tiempos de OSRM (OpenStreetMap); la distancia a la ruta es en línea recta. Los precios pueden cambiar antes de que llegues.</p>`;
  }

  $('t-result').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (b) {
      mode = b.dataset.mode;
      if (prefs.trip) { prefs.trip.mode = mode; savePrefs(); }
      render(); ctx.redraw();
      return;
    }
    const li = e.target.closest('.t-stop');
    if (li) ctx.openDetail(li.dataset.id);
  });
  $('t-result').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const li = e.target.closest('.t-stop');
    if (li) ctx.openDetail(li.dataset.id);
  });

  // ---------- Mapa ----------
  function drawRoute(fit) {
    layer.clearLayers();
    if (!state) return;
    const line = L.polyline(state.coords, { color: '#1f56a8', weight: 5, opacity: .85, interactive: false }).addTo(layer);
    const dot = (p, cls) => L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="t-end ${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(layer);
    dot(state.from, 'a'); dot(state.to, 'b');
    if (fit && visible) ctx.fit(line.getBounds());
    ctx.redraw();
  }

  /** Dibuja los pines del viaje en la capa de marcadores. Devuelve false si no hay viaje calculado. */
  function drawPins(markers, activeId) {
    if (!state) return false;
    const stops = state.plans[mode].stops;
    const stopN = new Map(stops.map((s, i) => [s.id, i + 1]));
    const prices = state.cands.map(s => s.price).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length / 3)], q2 = prices[Math.floor(2 * prices.length / 3)];
    const tier = p => (prices.length < 3 || q1 === q2 ? 'mid' : p <= q1 ? 'cheap' : p < q2 ? 'mid' : 'dear');
    const placed = [];
    const fits = (s, force) => {
      const pt = map.latLngToContainerPoint([s.lat, s.lon]);
      const box = { x: pt.x - 29, y: pt.y - 26, w: 58, h: 26 };
      if (!force && placed.some(b => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) return false;
      placed.push(box); return true;
    };
    const order = [...state.cands].sort((a, b) => (stopN.has(b.id) - stopN.has(a.id)) || a.price - b.price);
    for (const x of order) {
      const n = stopN.get(x.id);
      if (!fits(x, !!n || x.id === activeId)) continue;
      const html = `<div class="pin ${tier(x.price)} ${n ? 'stop' : ''} ${x.id === activeId ? 'active' : ''}">${n ? `<b class="n">${n}</b>` : ''}<span>${priceText(x.price)}</span></div>`;
      L.marker([x.lat, x.lon], { icon: L.divIcon({ className: '', html, iconSize: null }), zIndexOffset: n ? 1500 : Math.round(1000 - x.price * 100), keyboard: false, title: catalog.get(x.id)?.name || '' })
        .on('click', () => ctx.openDetail(x.id)).addTo(markers);
    }
    return true;
  }

  function show(on) {
    visible = on;
    if (on) {
      fillFuelSelect();
      if (!places.from && !$('t-from').value) {
        const c = ctx.getCenter();
        if (!c.example) setPlace('from', { lat: c.lat, lon: c.lon, label: c.label.replace(/^./, ch => ch.toUpperCase()) });
      }
      layer.addTo(map);
      if (state) ctx.fit(L.polyline(state.coords).getBounds());
    } else {
      layer.remove();
    }
  }

  return { show, drawPins, hasTrip: () => !!state };
}
