// Avisos al abrir la web: qué ha cambiado en tus favoritas desde la última visita y qué
// gasolineras están por debajo de tu precio objetivo. Funciones puras para poder probarlas.

/** Foto de los precios actuales de las favoritas: {idEstacion: {idCombustible: precio}}. */
export function snapshot(favIds, fuels, priceOf) {
  const out = {};
  for (const id of favIds) {
    const row = {};
    for (const f of fuels) { const p = priceOf(id, f); if (p != null) row[f] = p; }
    if (Object.keys(row).length) out[id] = row;
  }
  return out;
}

/**
 * Cambios de precio respecto a la foto guardada. Las bajadas primero, de mayor a menor.
 * @returns {Array<{id: string, fuel: string, from: number, to: number, diff: number}>}
 */
export function priceChanges(seen, favIds, fuels, priceOf) {
  const out = [];
  for (const id of favIds) {
    for (const f of fuels) {
      const from = seen?.[id]?.[f], to = priceOf(id, f);
      if (from == null || to == null || Math.abs(to - from) < 0.0005) continue;
      out.push({ id, fuel: f, from, to, diff: to - from });
    }
  }
  return out.sort((a, b) => a.diff - b.diff);
}

/** Las `limit` estaciones más baratas con precio igual o inferior al objetivo. */
export function belowTarget(candidates, target, limit = 3) {
  if (!(target > 0)) return [];
  return candidates.filter(c => c.price <= target + 1e-9).sort((a, b) => a.price - b.price).slice(0, limit);
}
