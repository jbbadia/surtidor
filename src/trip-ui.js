// Pestaña «Viaje»: formulario, cálculo de la ruta y dibujo de las paradas en el mapa.

import { fetchRoute } from './route.js';
import { prepareRoute, alongRoute, thin, cheapPlan, fastPlan, withRank } from './trip.js';
import { GLP, tankFor, consFor } from './car.js';
import { median } from './history.js';
import { catalog, fuelById, searchPlaces, geocode } from './api.js';

// Km a cada lado de la ruta en los que se buscan gasolineras. Son amplios para que la ruta «más
// barata» pueda desviarse si compensa; la «más rápida» elige siempre la más pegada a la carretera.
const GLP_CORRIDOR = 12, GAS_CORRIDOR = 6;
const NEAR_KM = 0.5;                           // «junto a la ruta»
// Ida y vuelta: las gasolineras que rodean el destino se pasan dos veces casi seguidas. Con menos
// de estos km entre una pasada y la otra, cuentan como una sola parada posible.
const TURN_KM = 30;
const uniq = list => [...new Map(list.map(s => [s.sid, s])).values()];
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
    $('t-round').checked = !!prefs.trip.round;
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
      const round = $('t-round').checked;
      const [r1, r2] = await Promise.all([fetchRoute(from, to), round ? fetchRoute(to, from) : null,
        ctx.ensureFuel(GLP).catch(() => null), ctx.ensureFuel(c.gasFuel).catch(() => null)]);
      const route1 = prepareRoute(r1.coords), route2 = r2 && prepareRoute(r2.coords);
      // En ida y vuelta cada gasolinera puede aparecer dos veces: una a la ida y otra a la vuelta.
      const along = (fuelId, corridor) => {
        const a = candidates(route1, fuelId, corridor).map(s => ({ ...s, sid: s.id, leg: 0, legAt: s.at }));
        if (!route2) return a;
        const b = candidates(route2, fuelId, corridor).map(s => ({ ...s, sid: s.id, id: `${s.id}#v`, leg: 1, legAt: s.at, at: s.at + route1.km }));
        const out = new Map(a.map(s => [s.sid, s]));
        return [...a, ...b.filter(s => !out.has(s.sid) || s.at - out.get(s.sid).at > TURN_KM)];
      };
      const glp = along(GLP, GLP_CORRIDOR);
      const gas = along(c.gasFuel, GAS_CORRIDOR);
      const medGlp = glp.length ? median(uniq(glp).map(s => s.price)) : null;
      const medGas = gas.length ? median(uniq(gas).map(s => s.price)) : null;
      const isGlp = fuel === GLP;
      const cons = consFor(c, fuel), rangeKm = (tankFor(c, fuel) / cons) * 100;
      const cands = withRank(isGlp ? glp : thin(gas, 10, 2), cons, tankFor(c, fuel) * 0.6);
      const totalKm = route1.km + (route2 ? route2.km : 0);
      const o = {
        totalKm, rangeKm, startKm: level * rangeKm, cons,
        reserveKm: Math.min(isGlp ? 30 : 50, rangeKm * 0.15),
        gapCostPerKm: isGlp && medGas ? (c.gasCons / 100) * medGas : 0,
        // Bifuel: mejor hacer unos pocos km con gasolina que parar a echar un par de litros de GLP.
        slackKm: isGlp ? Math.min(80, rangeKm * 0.2) : 0,
      };
      state = {
        from, to, round, coords: r2 ? [r1.coords, r2.coords] : [r1.coords], km: totalKm, seconds: r1.seconds + (r2 ? r2.seconds : 0),
        legs: [{ km: route1.km, seconds: r1.seconds }, ...(r2 ? [{ km: route2.km, seconds: r2.seconds }] : [])],
        fuel, isGlp, level, cands, o, medGlp, medGas,
        plans: { cheap: cheapPlan(cands, o), fast: fastPlan(cands, o) },
      };
      prefs.trip = { from, to, level, round, fuel: isGlp ? 'glp' : 'gas', mode };
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
    const { o, isGlp, level, cands } = state;
    const name = isGlp ? 'GLP' : 'gasolina';
    const petrol = isGlp && p.gapKm > 0.5
      ? `unos <b>${num(p.gapKm, 0)} km irás con gasolina</b>${o.gapCostPerKm ? ` (≈ ${euros(p.gapKm * o.gapCostPerKm)})` : ''}` : '';
    let html;
    if (!p.stops.length && !p.gapKm) {
      html = `<b>No necesitas repostar.</b> Con el depósito ${LEVELS[level] || 'así'} tienes para unos ${Math.round(o.startKm)} km de ${name} y el viaje son ${Math.round(o.totalKm)} km${state.round ? ' entre ida y vuelta' : ''}. ${mode === 'cheap'
        ? 'Si aun así quieres llenar por el camino, esta es la más barata de la ruta contando el desvío:'
        : 'Si aun así quieres llenar por el camino, esta es la más barata de las que están junto a la carretera:'}`;
    } else if (!p.stops.length && !cands.length) {
      html = `<b>No hay gasolineras con ${name} junto a esta ruta.</b>`;
    } else if (!p.stops.length) {
      html = isGlp
        ? `<b>Sin paradas.</b> El GLP no te llega para todo el viaje y ${petrol}: parar a repostar por tan poco no compensa.${other.stops.length ? ` Si prefieres no gastar gasolina, mira «${mode === 'cheap' ? 'Más rápida' : 'Más barata'}».` : ''}`
        : '<b>No hay gasolineras a tiro para este viaje.</b>';
    } else {
      const line = t => `<span class="t-line">${t}</span>`;
      html = `<span class="t-head"><b>${stopsText(p.stops.length)}</b> · pagas <b>${euros(p.paid)}</b></span>`
        + line(`${num(p.litres)} L de ${name} a ${priceText(p.paid / p.litres)} €/L de media${p.detourKm >= 0.5 ? ` · unos ${num(p.detourKm, 0)} km de desvío en total` : ' · casi sin desvío'}`);
      if (petrol) html += line(`Además, ${petrol}: parar por tan poco no compensa.`);
      const diff = other.cost - p.cost;
      if (mode === 'cheap' && diff > 0.05) html += line(`Ahorras <b class="good">${euros(diff)}</b> frente a la ruta más rápida.`);
      else if (mode === 'fast' && diff < -0.05) {
        const less = other.stops.length - p.stops.length;
        html += line(`Cuesta ${euros(-diff)} más que la más barata${less > 0 ? `, con ${stopsText(less)} menos` : other.detourKm - p.detourKm >= 1 ? `, con ${num(other.detourKm - p.detourKm, 0)} km menos de desvío` : ''}.`);
      } else if (other.stops.length && Math.abs(diff) <= 0.05) html += line('En este viaje, la más barata y la más rápida coinciden.');
    }
    return html;
  }

  /** Parada opcional cuando no hace falta repostar: así cada modo enseña siempre su gasolinera. */
  function optionalStop() {
    const { cands } = state;
    if (!cands.length) return null;
    if (mode === 'cheap') return cands.reduce((m, s) => (s.rank < m.rank ? s : m));
    const near = cands.filter(s => s.off <= NEAR_KM);
    return near.length ? near.reduce((m, s) => (s.price < m.price ? s : m)) : cands.reduce((m, s) => (s.off < m.off ? s : m));
  }

  function stopRow(x, n) {
    const s = catalog.get(x.sid);
    if (!s) return '';
    const tank = tankFor(car(), state.fuel);
    const sub = n === '+' ? `<div class="t-do">Parada opcional · llenar ${tank} L costaría ${euros(tank * x.price)}</div>`
      : n ? `<div class="t-do">${x.full ? `<b>Llena el depósito</b> · unos ${num(x.litres, 0)} L` : `Echa al menos <b>${num(x.litres)} L</b>`} · ${euros(x.cost)}</div>`
      : '';
    const where = state.round ? (x.leg ? 'la vuelta' : 'la ida') : 'la ruta';
    return `<li class="t-stop" data-id="${x.sid}" tabindex="0">
      ${n ? `<span class="t-n">${n}</span>` : ''}
      <div class="t-main">
        <div class="nm">${esc(s.name)}</div>
        <div class="ad">Km ${Math.round(x.legAt)} de ${where} · ${esc(s.loc)} (${esc(s.prov)})</div>
        ${sub}
        <div class="ad">${x.off < 0.3 ? 'Junto a la ruta' : `A ${num(x.off)} km de la ruta`}${s.horario ? ` · ${esc(s.horario)}` : ''}</div>
      </div>
      <div class="price">${ctx.priceHTML(x.price)}<span class="u">€/L</span></div>
    </li>`;
  }

  /** El viaje en orden: salida, paradas y tramos con gasolina de la ida; llegada; y lo mismo a la vuelta. */
  function itinerary(p, opt) {
    const { legs, from, to, round, o, level, isGlp } = state;
    const short = l => esc(l.replace(/\s*\(.*\)$/, '').split(',')[0]);
    const legOf = at => (round && at >= legs[0].km ? 1 : 0);
    const legName = at => (round ? (legOf(at) ? ' de la vuelta' : ' de la ida') : '');
    const kmIn = at => Math.round(at - (legOf(at) ? legs[0].km : 0));
    const span = g => {
      const a = g.from, b = g.to - 0.01;
      return legOf(a) === legOf(b) ? `Del km ${kmIn(a)} al ${kmIn(b)}${legName(a)}` : `Del km ${kmIn(a)}${legName(a)} al ${kmIn(b)}${legName(b)}`;
    };
    const gapRow = g => `<li class="t-gap"><span class="t-n g" aria-hidden="true">!</span><div class="t-main">${isGlp
      ? `<div class="t-do"><b>Unos ${num(g.km, 0)} km con gasolina</b>${o.gapCostPerKm ? ` · ≈ ${euros(g.km * o.gapCostPerKm)}` : ''}</div><div class="ad">${span(g)} ${g.km <= o.reserveKm ? 'el GLP llega justo: si se acaba, el coche pasa solo a gasolina.' : 'no hay GLP a tiro: el coche pasa solo a gasolina.'}</div>`
      : `<div class="t-do"><b>${num(g.km, 0)} km sin cubrir</b></div><div class="ad">${span(g)} no hay gasolineras a tiro. Sal con más combustible.</div>`}</div></li>`;
    const events = [
      ...p.stops.map((x, i) => ({ at: x.at, leg: x.leg, html: stopRow(x, i + 1) })),
      ...(opt ? [{ at: opt.at, leg: opt.leg, html: stopRow(opt, '+') }] : []),
      ...p.gaps.filter(g => g.km > 0.5).map(g => ({ at: g.from, leg: legOf(g.from), html: gapRow(g) })),
    ].sort((a, b) => a.at - b.at);
    const wp = (cls, title, sub) => `<li class="t-wp"><span class="t-end ${cls}" aria-hidden="true"></span><div class="t-main"><div class="t-do"><b>${title}</b></div>${sub ? `<div class="ad">${sub}</div>` : ''}</div></li>`;
    const head = (name, leg) => `<li class="t-leg"><b>${name}</b> · ${num(leg.km, 0)} km · ${hm(leg.seconds)}</li>`;
    const usable = Math.max(0, Math.round(Math.min(o.startKm, o.rangeKm) - o.reserveKm));
    const start = wp('a', `Salida · ${short(from.label)}`, `Depósito ${LEVELS[level] || 'así'}: ${isGlp ? 'GLP' : 'gasolina'} para unos ${usable} km, más ${Math.round(o.reserveKm)} de margen`);
    return legs.map((leg, i) => [
      round ? head(i ? 'Vuelta' : 'Ida', leg) : '',
      i ? '' : start,
      ...events.filter(e => (e.leg || 0) === i).map(e => e.html),
      wp(round && i ? 'a' : 'b', `Llegada · ${short((i ? from : to).label)}`, round && !i ? 'Aquí das la vuelta' : ''),
    ].join('')).join('');
  }

  function render() {
    const el = $('t-result');
    if (!state) { el.innerHTML = ''; return; }
    const c = car();
    const { km, seconds, isGlp, medGlp, medGas, cands, plans, o, from, to, round } = state;
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
    const opt = !p.stops.length && !p.gapKm ? optionalStop() : null;
    const short = l => esc(l.replace(/\s*\(.*\)$/, '').split(',')[0]);
    const gaps = !isGlp && p.gapKm > 0.5
      ? `<div class="warn"><strong>Tramo sin gasolineras</strong>No encontramos gasolineras para cubrir ${num(p.gapKm, 0)} km de la ruta. Sal con más combustible.</div>`
      : '';
    const pt = x => `${x.lat},${x.lon}`;
    const wp = [...p.stops.filter(x => !x.leg).map(pt), ...(round ? [pt(to)] : []), ...p.stops.filter(x => x.leg).map(pt)].join('|');
    const end = round ? from : to;
    const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${end.lat},${end.lon}&travelmode=driving${wp ? `&waypoints=${encodeURIComponent(wp)}` : ''}`;
    const all = uniq(cands);
    const cheapest = [...all].sort((a, b) => a.price - b.price).slice(0, 8);

    el.innerHTML = `
      <div class="t-sum">
        <h3>${short(from.label)} ${round ? '⇄' : '→'} ${short(to.label)}${round ? ' · ida y vuelta' : ''}</h3>
        <p class="t-big"><b class="num">${num(km, 0)} km</b> · unas ${hm(seconds)} ${round ? 'al volante en total' : 'sin paradas'}</p>
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
        <ol class="t-stops t-itin" id="t-stops">${itinerary(p, opt)}</ol>
        <a class="btn primary" href="${esc(gmaps)}" target="_blank" rel="noopener">Abrir la ruta en Google Maps${p.stops.length ? ' con las paradas' : ''}</a>
      </div>
      ${cheapest.length ? `<details class="t-all"><summary>Las ${cheapest.length} más baratas de la ruta (${all.length} gasolineras con ${isGlp ? 'GLP' : 'gasolina'} a menos de ${isGlp ? GLP_CORRIDOR : GAS_CORRIDOR} km)</summary><ol class="t-stops">${cheapest.map(x => stopRow(x, 0)).join('')}</ol></details>` : ''}
      <p class="src">Donde pone «al menos», son los litros mínimos para llegar con unos ${Math.round(o.reserveKm)} km de margen; si prefieres llenar, mejor en la parada más barata. Consumo de «Mi coche» (${num(o.cons)} L/100 km): en autovía suele ser algo mayor. Ruta y tiempos de OSRM (OpenStreetMap); la distancia a la ruta es en línea recta. Los precios pueden cambiar antes de que llegues.</p>`;
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
    const plan = state.plans[mode];
    const stopN = new Map();
    plan.stops.forEach((s, i) => stopN.set(s.sid, stopN.has(s.sid) ? `${stopN.get(s.sid)}·${i + 1}` : String(i + 1)));
    if (!plan.stops.length && !plan.gapKm) { const opt = optionalStop(); if (opt) stopN.set(opt.sid, '+'); }
    const cands = uniq(state.cands);
    const prices = cands.map(s => s.price).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length / 3)], q2 = prices[Math.floor(2 * prices.length / 3)];
    const tier = p => (prices.length < 3 || q1 === q2 ? 'mid' : p <= q1 ? 'cheap' : p < q2 ? 'mid' : 'dear');
    const placed = [];
    const fits = (s, force) => {
      const pt = map.latLngToContainerPoint([s.lat, s.lon]);
      const w = stopN.has(s.sid) ? 84 : 58;
      const box = { x: pt.x - w / 2, y: pt.y - 26, w, h: 26 };
      if (!force && placed.some(b => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) return false;
      placed.push(box); return true;
    };
    const order = [...cands].sort((a, b) => (stopN.has(b.sid) - stopN.has(a.sid)) || a.price - b.price);
    for (const x of order) {
      const n = stopN.get(x.sid);
      if (!fits(x, !!n || x.sid === activeId)) continue;
      const html = `<div class="pin ${tier(x.price)} ${n ? 'stop' : ''} ${x.sid === activeId ? 'active' : ''}">${n ? `<b class="n">${n}</b>` : ''}<span>${priceText(x.price)}</span></div>`;
      L.marker([x.lat, x.lon], { icon: L.divIcon({ className: '', html, iconSize: null }), zIndexOffset: n ? 1500 : Math.round(1000 - x.price * 100), keyboard: false, title: catalog.get(x.sid)?.name || '' })
        .on('click', () => ctx.openDetail(x.sid)).addTo(markers);
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
      $('t-round').checked = !!prefs.trip?.round || $('t-round').checked;
    } else {
      layer.remove();
    }
  }

  return { show, drawPins, hasTrip: () => !!state };
}
