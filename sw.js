/*
 * Offline application shell only. Production records remain in IndexedDB.
 * For EVERY release that changes a shell file, change SHELL_VERSION here AND
 * in mobile-app.js. Do not call skipWaiting: open pages/drafts keep their
 * current shell until all pages using the previous worker have closed.
 */
const SHELL_VERSION = '2026-10-28-ogp-v2';
const CACHE_PREFIX = 'hgcal-bonding-shell-';
const CACHE_NAME = CACHE_PREFIX + SHELL_VERSION;
const SCOPE = new URL('./', self.registration.scope);
const FILES = [
  'index.html', 'app.js', 'mobile-app.js', 'domain-data.js',
  'channel-map-data.js', 'ogp-candidates.js', 'mapping.js', 'storage.js', 'styles.css',
  'backside-map.js', 'backside-map.css', 'manifest.webmanifest',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'assets/cell-reference.png', 'assets/backside-reference.png'
];
const URLS = FILES.map(path => new URL(path, SCOPE).href);
const ALLOWED = new Set(URLS);
const INDEX_URL = new URL('index.html', SCOPE).href;

async function shellReady() {
  if (!(await caches.keys()).includes(CACHE_NAME)) return false;
  const cache = await caches.open(CACHE_NAME);
  const responses = await Promise.all(URLS.map(url => cache.match(url)));
  return responses.every(response => response?.ok);
}

async function validShellResponse(response, url) {
  if (!response.ok || response.type === 'opaque') return false;
  if (response.url && new URL(response.url).origin !== SCOPE.origin) return false;
  const contentType = response.headers.get('content-type') || '';
  if (url === INDEX_URL) {
    if (!contentType.includes('text/html')) return false;
    const html = await response.clone().text();
    // Never save a hosting sign-in/error page as the offline application.
    return /id=["']app["']/.test(html) && /src=["']\.\/app\.js["']/.test(html);
  }
  if (/\.js$/.test(url)) return /(?:java|ecma)script/i.test(contentType);
  if (/\.css$/.test(url)) return contentType.includes('text/css');
  if (/\.(?:png|svg)$/.test(url)) return contentType.startsWith('image/');
  return !contentType.includes('text/html');
}

async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  try {
    // Fetch and validate the complete release before writing any of it.
    const files = await Promise.all(URLS.map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (!await validShellResponse(response, url)) throw new Error('Shell asset unavailable');
      return [url, response];
    }));
    await Promise.all(files.map(([url, response]) => cache.put(url, response)));
    if (!await shellReady()) throw new Error('Shell cache incomplete');
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener('install', event => {
  event.waitUntil(cacheShell());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (!await shellReady()) throw new Error('Shell cache incomplete');
    await Promise.all((await caches.keys())
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    // Claiming the first page does not reload it or discard a draft.
    await self.clients.claim();
  })());
});

function cacheKey(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return null;
  const plain = url.origin + url.pathname;
  if (plain === SCOPE.href || plain === INDEX_URL) return INDEX_URL;
  return ALLOWED.has(plain) ? plain : null;
}

self.addEventListener('fetch', event => {
  const key = cacheKey(event.request);
  if (!key) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    if (cached) return cached;
    // Browser eviction can remove cached resources. Do not turn network
    // responses into a partially updated release or cache any user requests.
    try { return await fetch(event.request); }
    catch {
      return new Response('离线文件不可用，请联网重新打开应用。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'HGCAL_SHELL_STATUS' || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    event.ports[0].postMessage({
      type: 'HGCAL_SHELL_STATUS', version: SHELL_VERSION,
      ready: await shellReady()
    });
  })());
});
