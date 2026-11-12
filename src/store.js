// Almacén clave-valor en IndexedDB. El catálogo de gasolineras y los precios ocupan varios MB:
// no caben con garantías en localStorage (5 MB), y hacen falta para funcionar sin conexión.

const DB = 'surtidor', STORE = 'kv';
let opening = null;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}
function run(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/** Devuelve null si no existe o si el navegador no deja usar IndexedDB (modo privado, etc.). */
export const idbGet = key => run('readonly', s => s.get(key)).then(v => v ?? null).catch(() => null);
export const idbSet = (key, value) => run('readwrite', s => s.put(value, key)).then(() => true).catch(() => false);
