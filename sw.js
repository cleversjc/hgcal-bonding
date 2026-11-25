/*
 * Offline application shell only. Production records remain in IndexedDB.
 * For EVERY release that changes a shell file, change SHELL_VERSION here AND
 * in mobile-app.js. Do not call skipWaiting: open pages/drafts keep their
 * current shell until all pages using the previous worker have closed.
 */
const SHELL_VERSION = '2026-11-25-ogp-c143-revert-v1';
const CACHE_PREFIX = 'hgcal-bonding-shell-';
const CACHE_NAME = CACHE_PREFIX + SHELL_VERSION;
const SCOPE = new URL('./', self.registration.scope);
const FILES = [
  'index.html', 'app.js', 'mobile-app.js', 'domain-data.js',
  'channel-map-data.js', 'mapping.js', 'storage.js', 'styles.css', 'compact.css',
  'backside-map.js', 'backside-map.css', 'manifest.webmanifest',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'assets/cell-reference.png', 'assets/backside-reference.png',
  'ogp.js', 'ogp-pdf.js', 'ogp.css',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'persistence.js', 'archive.js', 'field-session.js', 'vendor/zip/jszip.min.js', 'previous-dev/index.html', 'previous-dev/app.js', 'previous-dev/mobile-app.js', 'previous-dev/domain-data.js', 'previous-dev/channel-map-data.js', 'previous-dev/mapping.js', 'previous-dev/storage.js', 'previous-dev/styles.css', 'previous-dev/compact.css', 'previous-dev/backside-map.js', 'previous-dev/backside-map.css', 'previous-dev/manifest.webmanifest', 'previous-dev/assets/icon.svg', 'previous-dev/assets/icon-192.png', 'previous-dev/assets/icon-512.png', 'previous-dev/assets/cell-reference.png', 'previous-dev/assets/backside-reference.png', 'previous-dev/ogp.js', 'previous-dev/ogp-pdf.js', 'previous-dev/ogp.css', 'previous-dev/vendor/pdfjs/pdf.min.mjs', 'previous-dev/vendor/pdfjs/pdf.worker.min.mjs', 'previous-dev/sw.js', 'previous-dev/recovery.js'
];
const URLS = FILES.map(path => new URL(path, SCOPE).href);
const ALLOWED = new Set(URLS);
const INDEX_URL = new URL('index.html', SCOPE).href;
const MOBILE_URL = new URL('mobile-app.js', SCOPE).href;
const CACHE_METADATA_URL = new URL('.offline-shell-metadata', SCOPE).href;
const RELEASE_CACHES = [CACHE_NAME, CACHE_NAME + '-alternate'];
let activeShellPromise, rebuilding;

function activeShell() {
  return activeShellPromise ??= (async () => {
    let latest;
    for (const name of RELEASE_CACHES) {
      if (!await caches.has(name)) continue;
      const cache = await caches.open(name);
      const metadata = await cache.match(CACHE_METADATA_URL);
      if (!metadata) continue;
      const { generation, hashes } = await metadata.json();
      if (!latest || generation > latest.generation) latest = { name, cache, generation, hashes };
    }
    return latest;
  })();
}

async function shellReady() {
  const shell = await activeShell();
  if (!shell || !await caches.has(shell.name)) return false;
  const { cache } = shell;
  const responses = await Promise.all(URLS.map(url => cache.match(url)));
  return responses.every(response => response?.ok);
}

async function validShellResponse(response, url) {
  if (!response.ok || response.type === 'opaque') return false;
  if (response.url && new URL(response.url).origin !== SCOPE.origin) return false;
  const contentType = response.headers.get('content-type') || '';
  if (url.endsWith('.html')) {
    if (!contentType.includes('text/html')) return false;
    const html = await response.clone().text();
    // Never save a hosting sign-in/error page as the offline application.
    return /id=["']app["']/.test(html) && /src=["']\.\/app\.js["']/.test(html);
  }
  if (/\.(?:mjs|js)$/.test(url)) return /(?:java|ecma)script/i.test(contentType);
  if (/\.css$/.test(url)) return contentType.includes('text/css');
  if (/\.(?:png|svg)$/.test(url)) return contentType.startsWith('image/');
  return !contentType.includes('text/html');
}

async function cacheShell(name, previous) {
  const cache = await caches.open(name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    // Check every downloaded asset against the installed release during a rebuild.
    const files = await Promise.all(URLS.map(async url => {
      const response = await fetch(new Request(url, {
        cache: 'reload', credentials: 'same-origin', signal: controller.signal
      }));
      if (!await validShellResponse(response, url)) throw new Error('Shell asset unavailable');
      const contents = await response.clone().arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', contents))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (url === MOBILE_URL && !new TextDecoder().decode(contents).includes("const SHELL_VERSION = '" + SHELL_VERSION + "';")) {
        throw new Error('Shell version mismatch');
      }
      if (previous && previous.hashes[url] !== hash) throw new Error('Shell asset changed');
      return { url, response, hash };
    }));
    const writes = await Promise.allSettled(files.map(({ url, response }) => cache.put(url, response)));
    if (writes.some(write => write.status === 'rejected')) throw new Error('Shell cache incomplete');
    const generation = previous ? previous.generation + 1 : 0;
    const hashes = Object.fromEntries(files.map(({ url, hash }) => [url, hash]));
    // A cache becomes eligible for service only after every asset is stored.
    await cache.put(CACHE_METADATA_URL, new Response(JSON.stringify({ generation, hashes })));
    return { name, cache, generation, hashes };
  } catch (error) {
    await caches.delete(name);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function rebuildShell() {
  const previous = await activeShell();
  if (!previous || !await caches.has(previous.name)) throw new Error('Shell metadata unavailable');
  const nextName = RELEASE_CACHES.find(name => name !== previous.name);
  await caches.delete(nextName);
  const next = await cacheShell(nextName, previous);
  activeShellPromise = Promise.resolve(next);
  await caches.delete(previous.name);
}

self.addEventListener('install', event => {
  event.waitUntil(cacheShell(CACHE_NAME));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (!await shellReady()) throw new Error('Shell cache incomplete');
    const { name: activeName } = await activeShell();
    await Promise.all((await caches.keys())
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== activeName)
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
  if (plain === new URL('previous-dev/',SCOPE).href) return new URL('previous-dev/index.html',SCOPE).href;
  return ALLOWED.has(plain) ? plain : null;
}

self.addEventListener('fetch', event => {
  const key = cacheKey(event.request);
  if (!key) return;
  event.respondWith((async () => {
    const shell = await activeShell();
    const cached = await shell?.cache.match(key);
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
  const port = event.ports?.[0];
  if (!port) return;
  if (event.data?.type === 'HGCAL_REBUILD_SHELL') {
    const url = event.source?.url && new URL(event.source.url);
    const page = url && url.origin + url.pathname;
    if ((page !== SCOPE.href && page !== INDEX_URL) || event.data.version !== SHELL_VERSION || self.registration.waiting) {
      port.postMessage({ ok: false, reason: 'update' });
      return;
    }
    rebuilding ??= rebuildShell().finally(() => { rebuilding = null; });
    event.waitUntil(rebuilding.then(
      () => port.postMessage({ ok: true }),
      () => port.postMessage({ ok: false })
    ));
    return;
  }
  if (event.data?.type !== 'HGCAL_SHELL_STATUS') return;
  event.waitUntil((async () => {
    port.postMessage({
      type: 'HGCAL_SHELL_STATUS', version: event.source?.url?.includes('/previous-dev/')?'previous-dev-7655f51-numbering-compat':SHELL_VERSION,
      ready: await shellReady()
    });
  })());
});
