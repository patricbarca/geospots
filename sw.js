// Service worker: la app y sus librerías quedan guardadas para usarse sin conexión.
// Las teselas del mapa base se guardan a medida que se ven (las zonas visitadas funcionan offline).
const VERSION = 'v2';
const SHELL = `geoplano-shell-${VERSION}`;
const TILES = 'geoplano-tiles';
const MAX_TILES = 4000;

const LOCAL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/geo.js', 'js/db.js', 'js/importer.js', 'js/inspect.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(LOCAL);
    await Promise.all(CDN.map(async (u) => {
      try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await c.put(u, r); } catch {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('geoplano-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.searchParams.has('import') || url.pathname.endsWith('.pdf')) return; // PDFs de prueba: directo a la red

  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(tile(req));
    return;
  }
  if (CDN.includes(req.url)) {
    // Librerías con versión fija: primero la caché.
    e.respondWith(caches.open(SHELL).then(async (c) => (await c.match(req.url)) || fetch(req)));
    return;
  }
  if (url.origin === location.origin) {
    // Archivos de la app: primero la red (para recibir mejoras); sin conexión, la caché.
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      try {
        const r = await fetch(req);
        if (r.ok) c.put(req, r.clone());
        return r;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) || new Response('Sin conexión', { status: 503 });
      }
    })());
  }
});

async function tile(req) {
  const c = await caches.open(TILES);
  try {
    const r = await fetch(req);
    if (r.ok || r.type === 'opaque') {
      c.put(req, r.clone()).then(trim).catch(() => {});
    }
    return r;
  } catch {
    return (await c.match(req)) || new Response('', { status: 504 });
  }
}

let trimming = false;
async function trim() {
  if (trimming) return; trimming = true;
  try {
    const c = await caches.open(TILES);
    const keys = await c.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
  } finally { trimming = false; }
}
