// Ruta por carretera entre dos puntos con OSRM sobre datos de OpenStreetMap (gratis y sin clave).
// Se prueba el servidor de demostración de OSRM y, si falla, el de la comunidad alemana de OSM.

const SERVERS = [
  'https://router.project-osrm.org/route/v1/driving/',
  'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
];

/**
 * @param {{lat: number, lon: number}} a salida
 * @param {{lat: number, lon: number}} b destino
 * @returns {Promise<{km: number, seconds: number, coords: Array<[number, number]>}>} coords en [lat, lon]
 */
export async function fetchRoute(a, b) {
  let lastErr;
  for (const base of SERVERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${base}${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`El servicio de rutas respondió ${res.status}`);
      const data = await res.json();
      if (data.code === 'NoRoute') throw Object.assign(new Error('No hay ruta por carretera entre esos dos puntos'), { final: true });
      const r = data.routes?.[0];
      if (data.code !== 'Ok' || !r) throw new Error('El servicio de rutas no devolvió ninguna ruta');
      return { km: r.distance / 1000, seconds: r.duration, coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]) };
    } catch (err) {
      lastErr = err;
      if (err.final) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr?.final ? lastErr : new Error('No se pudo calcular la ruta ahora mismo. Comprueba la conexión y vuelve a intentarlo.');
}
