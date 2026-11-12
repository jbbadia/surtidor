// Service worker de Surtidor: guarda la propia web para poder abrirla sin conexión.
// No toca los precios (van en IndexedDB), ni el mapa, ni las rutas: solo HTML, código, iconos y fuentes.

const CACHE = 'surtidor-shell-v1';
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const scope = self.registration.scope;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('surtidor-shell-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

const storable = r => r && (r.ok || r.type === 'opaque');
// Algunos servidores responden con «Vary: Origin» y la misma URL dejaría de coincidir según quién la
// pida (la página o este service worker). Aquí cada URL tiene un único contenido: se ignora.
const ANY = { ignoreVary: true };

async function fetchAndStore(request) {
  const res = await fetch(request);
  if (storable(res)) (await caches.open(CACHE)).put(request, res.clone()).catch(() => {});
  return res;
}

// La página avisa de qué archivos ha cargado: se guardan los que falten. Con `prune`, además se
// borran los archivos de versiones anteriores (sus nombres llevan un código que cambia al publicar).
self.addEventListener('message', e => {
  if (e.data?.type !== 'cache' || !Array.isArray(e.data.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(e.data.urls.map(async url => {
      try {
        if (await cache.match(url, ANY)) return;
        let res = await fetch(url).catch(() => null);
        if (!storable(res) && FONTS.test(url)) res = await fetch(url, { mode: 'no-cors' }).catch(() => null);
        if (storable(res)) await cache.put(url, res);
      } catch { /* se guardará en otra visita */ }
    }));
    if (e.data.prune) {
      const keep = new Set(e.data.urls);
      for (const req of await cache.keys()) {
        if (req.url.startsWith(`${scope}assets/`) && !keep.has(req.url)) await cache.delete(req);
      }
    }
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const own = req.url.startsWith(scope);
  if (!own && !FONTS.test(req.url)) return;            // precios, mapa y rutas van directos a la red

  // La página: siempre la versión nueva si hay red; sin red (o si tarda), la guardada.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const saved = (await cache.match(req, { ignoreSearch: true, ignoreVary: true })) || (await cache.match(scope, ANY));
      try {
        const net = fetchAndStore(req);
        if (!saved) return await net;
        net.catch(() => {});
        return await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error('lenta')), 4000))]);
      } catch (err) {
        if (saved) return saved;
        throw err;
      }
    })());
    return;
  }

  // Lo demás: lo guardado al instante y, de fondo, se renueva (los archivos con código no cambian nunca).
  e.respondWith((async () => {
    const saved = await caches.match(req, ANY);
    if (saved) {
      if (!req.url.startsWith(`${scope}assets/`)) fetchAndStore(req).catch(() => {});
      return saved;
    }
    return fetchAndStore(req);
  })());
});
