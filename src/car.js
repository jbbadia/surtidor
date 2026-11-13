// Perfil del coche y cálculos de coste. Funciones puras (sin DOM) para poder probarlas.

export const GLP = '17';

/**
 * Dacia Sandero ECO-G 100 (2024), motor 1.0 TCe bifuel GLP/gasolina, 74 kW.
 * - Depósito GLP 40 L nominales; por seguridad se llena al 80 % → ~32 L por repostaje.
 * - Depósito gasolina 50 L.
 * - Consumo homologado WLTP: 7,4 L/100 km con GLP y 5,6 L/100 km con gasolina.
 */
export const SANDERO = Object.freeze({
  name: 'Dacia Sandero ECO-G 100 (2024)',
  glpL: 32, glpCons: 7.4,
  gasL: 50, gasCons: 5.6,
  gasFuel: '1',               // Gasolina 95 E5
});

export const isGlp = fuel => fuel === GLP;
export const tankFor = (car, fuel) => (isGlp(fuel) ? car.glpL : car.gasL);
export const consFor = (car, fuel) => (isGlp(fuel) ? car.glpCons : car.gasCons);
/** € que cuesta recorrer 100 km con ese combustible a ese precio. */
export const costPer100 = (car, fuel, price) => consFor(car, fuel) * price;
/** Km que da un repostaje completo. */
export const rangeKm = (car, fuel) => (tankFor(car, fuel) / consFor(car, fuel)) * 100;

/** Las carreteras no van en línea recta: la distancia real suele ser ~1,3 veces la directa. */
export const ROAD_FACTOR = 1.3;

/**
 * Lo que cuesta llegar a una gasolinera que está a `dist` km en línea recta (solo la ida), con el
 * consumo medio del coche y al precio de esa gasolinera.
 * @returns {{km: number, cost: number}} km aproximados por carretera y € de combustible
 */
export function driveCost(car, fuel, price, dist) {
  const roadKm = Math.max(0, dist) * ROAD_FACTOR;
  return { km: roadKm, cost: (roadKm * consFor(car, fuel) / 100) * price };
}

/**
 * Ahorro neto de llenar en una estación frente a otra de referencia (normalmente la más cercana),
 * descontando el combustible que se gasta en el desvío de ida y vuelta.
 * @returns {{gross: number, detour: number, net: number, extraKm: number}} en € y km
 */
export function netSaving({ car, fuel, price, dist, refPrice, refDist }) {
  const litres = tankFor(car, fuel);
  const extraKm = Math.max(0, dist - refDist) * 2 * ROAD_FACTOR;
  const detour = (extraKm * consFor(car, fuel) / 100) * price;
  const gross = (refPrice - price) * litres;
  return { gross, detour, net: gross - detour, extraKm };
}

/** Normaliza lo que viene de las preferencias guardadas, con los valores del Sandero como respaldo. */
export function sanitizeCar(c = {}) {
  const pos = (v, d, max) => (Number.isFinite(+v) && +v > 0 && +v <= max ? +v : d);
  return {
    name: String(c.name || SANDERO.name).slice(0, 60),
    glpL: pos(c.glpL, SANDERO.glpL, 120), glpCons: pos(c.glpCons, SANDERO.glpCons, 25),
    gasL: pos(c.gasL, SANDERO.gasL, 120), gasCons: pos(c.gasCons, SANDERO.gasCons, 25),
    gasFuel: ['1', '23', '20', '3', '21'].includes(c.gasFuel) ? c.gasFuel : SANDERO.gasFuel,
  };
}
