// Ofertas para ahorrar en combustible, verificadas el 12/11/2026 en fuentes oficiales o prensa.
// Cambian a menudo: cada oferta caduca sola en su fecha `until` y enlaza a su fuente para comprobarla.
//
// glp: 'sí' (la fuente incluye el GLP de forma expresa) · 'no consta' (la fuente no lo aclara).
// value/type: lo que se resta del precio al aplicarla (cént/L o %). Si es saldo o cheque, el ahorro
// es real solo si luego lo gastas.

export const VERIFIED = '2026-11-12';

export const OFFERS = [
  {
    id: 'moeve-gow',
    brand: 'Moeve / Cepsa',
    match: ['MOEVE', 'CEPSA'],
    title: 'App Moeve gow: 10 cént/L, también en GLP',
    value: 10, type: 'cent', mode: 'saldo', glp: 'sí',
    until: '2026-12-31',
    needs: 'Registrarte en la app Moeve gow e identificarte al pagar. El saldo se usa en próximos repostajes. Desde enero vuelve a la ventaja habitual de 5 cént/L en GLP. Si contratas luz y gas con Naturgy se acumula hasta 40 cént/L.',
    url: 'https://www.merca2.es/2026/10/21/descuentos-carburantes-moeve-2478342/',
    confidence: 'alta',
  },
  {
    id: 'repsol-waylet',
    brand: 'Repsol / Campsa / Petronor',
    match: ['REPSOL', 'CAMPSA', 'PETRONOR', 'PETROCAT'],
    title: 'App Waylet: 10 cént/L sin contratar nada',
    value: 10, type: 'cent', mode: 'saldo', glp: 'no consta',
    until: '2026-11-30',
    needs: 'Pagar con la app Waylet. Sube a 20 cént/L con luz o gas de Repsol, a 30 con luz y gas y a 40 con solar; la Tarjeta Waylet suma más. Repsol no aclara si vale para AutoGas: compruébalo en la app antes de contar con ello.',
    url: 'https://www.repsol.es/particulares/asesoramiento-consumo/10-centimos-descuento-gasolina/',
    confidence: 'alta',
  },
  {
    id: 'carrefour',
    brand: 'Carrefour',
    match: ['CARREFOUR'],
    title: 'Gasolineras Carrefour: 8 % en cheque ahorro',
    value: 8, type: 'pct', mode: 'cheque', glp: 'no consta',
    until: '2026-12-31',
    needs: 'Identificarte con el Club Carrefour (app o tarjeta). El 8 % se acumula como cheque para gastar en tiendas Carrefour, no baja el precio en el surtidor.',
    url: 'https://www.chollometro.com/ofertas/recopilatorio-de-todas-las-ofertas-para-ahorrar-combustible-actualmente-2028491',
    confidence: 'media',
  },
  {
    id: 'eroski-oro',
    brand: 'Eroski',
    match: ['EROSKI'],
    title: 'Tarjeta Oro EROSKI club: 4 %',
    value: 4, type: 'pct', mode: 'devolución', glp: 'no consta',
    until: null,
    needs: 'Es una tarjeta de crédito. Según comparadores, solo compensa si gastas unos 125 €/mes en Eroski entre compra y combustible.',
    url: 'https://www.elindependiente.com/economia/2026/03/21/descuentos-en-carburantes-caza-al-cliente-en-supermercados-gasolineras-y-energeticas/',
    confidence: 'media',
  },
  {
    id: 'ing-galp-shell',
    brand: 'Galp y Shell (tarjeta ING)',
    match: ['GALP', 'SHELL'],
    title: 'Tarjeta ING: 3 % de devolución en Galp y Shell',
    value: 3, type: 'pct', mode: 'devolución', glp: 'no consta',
    until: null,
    needs: 'Pagar con tarjeta de ING (cuenta en ING). La devolución llega a la cuenta. Dato de comparadores de 2026: confirma las condiciones en ING.',
    url: 'https://www.kelisto.es/tarjetas-credito/consejos-y-analisis/que-tarjetas-te-permiten-ahorrar-en-gasolina-5026',
    confidence: 'media',
  },
  {
    id: 'mi-bp',
    brand: 'BP',
    match: ['BP'],
    title: 'App Mi BP: unos 10 cént/L',
    value: 10, type: 'cent', mode: 'directo', glp: 'no consta',
    until: null,
    needs: 'Cifra aproximada de una guía de marzo de 2026, sin campaña oficial confirmada para noviembre. Mírala en la app antes de contar con ella.',
    url: 'https://www.adslzone.net/noticias/ciencia/descuento-gasolineras-2026-apps-promocion/',
    confidence: 'baja',
  },
];

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/** Ofertas en vigor en la fecha dada (comparando días en hora de Madrid). */
export function activeOffers(date = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(date); // YYYY-MM-DD
  return OFFERS.filter(o => !o.until || o.until >= today);
}

/** ¿Esta oferta se aplica a una gasolinera con este rótulo? (palabra completa: "BP" no casa con "BPXYZ") */
export function offerMatches(offer, stationName) {
  const n = norm(stationName);
  return offer.match.some(m => new RegExp(`(^|[^A-Z0-9])${m}([^A-Z0-9]|$)`).test(n));
}

export function isExpired(offerId, date = new Date()) {
  const o = OFFERS.find(x => x.id === offerId);
  return !o || !activeOffers(date).includes(o);
}

export const fmtDate = iso => iso ? iso.split('-').reverse().join('/') : '';
