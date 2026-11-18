const VERSION = 'loto-sop-v4.7.0';
const PAGE_CACHE = `${VERSION}-pages`;
const ASSET_CACHE = `${VERSION}-assets`;
const SCOPE = self.registration.scope;
const START_URL = new URL('./', SCOPE).href;
const CORE_FILES = [
  './',
  './manifest.webmanifest',
  './lesaffre-logo.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const NAVIGATION_TIMEOUT_MS = 6000;

function assetUrlsFromHtml(html) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/g)) {
    urls.add(new URL(match[1].replace(/&amp;/g, '&'), START_URL).href);
  }
  // Sayfa içindeki veri bloğunda geçen parça dosyaları (ör. static/chunks/app/page-xxxx.js)
  for (const match of html.matchAll(/static\/(?:chunks|css|media)\/[^"'\\\s)]+/g)) {
    urls.add(new URL(`./_next/${match[0]}`, START_URL).href);
  }
  return [...urls];
}

async function precache(cache, urls) {
  await Promise.all(urls.map(async (url) => {
    try {
      if (await cache.match(url)) return;
      const response = await fetch(url);
      if (response.ok) await cache.put(url, response);
    } catch {
      /* tek bir dosya alınamazsa kurulum yine de tamamlanır */
    }
  }));
}

function pageKey(rawUrl) {
  const url = new URL(rawUrl);
  url.search = '';
  url.hash = '';
  const scopePath = new URL(START_URL).pathname;
  if (url.pathname === scopePath || url.pathname === `${scopePath}index.html`) return START_URL;
  return url.href;
}

async function storePage(cache, key, response) {
  const html = await response.clone().text();
  await cache.put(key, response);
  await precache(await caches.open(ASSET_CACHE), assetUrlsFromHtml(html));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const pages = await caches.open(PAGE_CACHE);
    const assets = await caches.open(ASSET_CACHE);
    let html = '';
    for (const file of CORE_FILES) {
      const url = new URL(file, START_URL).href;
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) continue;
        if (url === START_URL) {
          html = await response.clone().text();
          await pages.put(START_URL, response);
        } else {
          await assets.put(url, response);
        }
      } catch {
        /* kurulum çevrimdışı yapılırsa sonraki çevrimiçi açılışta tamamlanır */
      }
    }
    if (html) await precache(assets, assetUrlsFromHtml(html));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('loto-sop-') && !key.startsWith(VERSION))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirstPage(event) {
  const { request } = event;
  const cache = await caches.open(PAGE_CACHE);
  const key = pageKey(request.url);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      const work = storePage(cache, key, copy).catch(() => undefined);
      try { event.waitUntil(work); } catch { /* olay bitmişse iş yine de sürer */ }
    }
    return response;
  });
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAVIGATION_TIMEOUT_MS)),
    ]);
  } catch {
    const cached = (await cache.match(key)) || (await cache.match(START_URL));
    if (cached) return cached;
    return network;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => undefined);
  return response;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then((response) => {
    if (response.ok && response.type === 'basic') cache.put(event.request, response.clone()).catch(() => undefined);
    return response;
  });
  if (cached) {
    try { event.waitUntil(network.catch(() => undefined)); } catch { /* yoksay */ }
    return cached;
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !request.url.startsWith(SCOPE)) return;
  if (url.searchParams.has('_rsc') || url.pathname.endsWith('/sw.js')) return;
  if (request.mode === 'navigate') { event.respondWith(networkFirstPage(event)); return; }
  if (url.pathname.includes('/_next/static/')) { event.respondWith(cacheFirst(request)); return; }
  event.respondWith(staleWhileRevalidate(event));
});
