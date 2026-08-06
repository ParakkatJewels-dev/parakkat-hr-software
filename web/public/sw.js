const VERSION = 'parakkat-hr-pwa-v4';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const MAX_RUNTIME_ENTRIES = 90;

const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/pwa-icon.svg',
  '/pwa-icon-180.png',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/pwa-maskable-512.png',
];

function isCacheable(response) {
  return response && response.ok && response.type === 'basic';
}

function shellAssetUrlsFrom(html) {
  const urls = new Set();
  const assetPattern = /(?:src|href)=["']([^"']+\.(?:js|css|png|svg|ico|webp|avif|woff2?)(?:\?[^"']*)?)["']/gi;
  for (const match of html.matchAll(assetPattern)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin) {
        urls.add(`${url.pathname}${url.search}`);
      }
    } catch {
      // Ignore malformed optional references; the fixed shell entries above still install.
    }
  }
  return [...urls];
}

async function cacheShell() {
  const cache = await caches.open(SHELL_CACHE);

  await Promise.allSettled(
    APP_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))
  );

  const indexResponse = (await cache.match('/index.html')) || (await cache.match('/'));
  if (!indexResponse) return;

  const discoveredAssets = shellAssetUrlsFrom(await indexResponse.clone().text());
  await Promise.allSettled(
    discoveredAssets.map((url) => cache.add(new Request(url, { cache: 'reload' })))
  );
}

async function trimRuntimeCache() {
  const cache = await caches.open(RUNTIME_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_RUNTIME_ENTRIES) return;
  await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map((key) => cache.delete(key)));
}

async function putRuntime(request, response) {
  if (!isCacheable(response)) return;
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response.clone());
  await trimRuntimeCache();
}

async function putShellResponse(response) {
  if (!isCacheable(response)) return;
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all([
    cache.put('/index.html', response.clone()),
    cache.put('/', response.clone()),
  ]);
}

self.addEventListener('install', (event) => {
  // One missing optional asset should not prevent the whole PWA from installing.
  event.waitUntil(cacheShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('parakkat-hr-pwa-') && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );

      if ('navigationPreload' in self.registration) {
        await self.registration.navigationPreload.enable();
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function cachedShellFallback() {
  return (
    (await caches.match('/index.html')) ||
    (await caches.match('/')) ||
    (await caches.match('/offline.html')) ||
    new Response(
      '<!doctype html><title>Offline</title><h1>Parakkat HR is offline</h1><p>Please reconnect and try again.</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
  );
}

async function navigationResponse(event) {
  try {
    const preload = await event.preloadResponse;
    if (preload) {
      await putShellResponse(preload.clone());
      return preload;
    }

    const response = await fetch(event.request);
    if (!response.ok) {
      return cachedShellFallback();
    }
    await putShellResponse(response.clone());
    return response;
  } catch {
    return cachedShellFallback();
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      await putRuntime(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await network) || new Response('', { status: 504, statusText: 'Offline' });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await putRuntime(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match('/offline.html'));
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Always go to the network for deploy checks and service endpoints.
  if (url.pathname === '/version.json' || url.pathname === '/sw.js' || url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(event));
    return;
  }

  if (/\.(?:js|css|png|svg|ico|webp|avif|woff2?)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
