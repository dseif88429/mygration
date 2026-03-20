/**
 * Mygration Service Worker - Map Tile Cache
 * Cache-first strategy: once a tile is fetched, it's served from cache forever.
 * Tiles are keyed by path (ignoring query params like cache-bust strings).
 */
const CACHE_NAME = 'mygration-tiles-v1';
const MAX_ENTRIES = 5000;

// Only cache tile URLs from these providers
const TILE_HOSTS = [
    'tile.openstreetmap.org',
    'basemaps.cartocdn.com',
    'server.arcgisonline.com',
    'tile.opentopomap.org'
];

function isTileRequest(url) {
    return TILE_HOSTS.some(host => url.hostname.includes(host));
}

// Normalize URL: strip query params so cache-bust doesn't create duplicates
function cacheKey(url) {
    const u = new URL(url);
    u.search = '';
    return u.toString();
}

// Evict oldest entries when cache gets too large
async function evictIfNeeded(cache) {
    const keys = await cache.keys();
    if (keys.length > MAX_ENTRIES) {
        const toDelete = keys.length - MAX_ENTRIES + 200; // delete 200 extra to avoid frequent eviction
        for (let i = 0; i < toDelete; i++) {
            await cache.delete(keys[i]);
        }
    }
}

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    if (!isTileRequest(url)) return; // Let non-tile requests pass through

    event.respondWith(
        caches.open(CACHE_NAME).then(async cache => {
            const key = cacheKey(event.request.url);
            const cached = await cache.match(key);
            if (cached) return cached; // Cache hit -- instant, no network

            try {
                // Bypass browser HTTP cache to avoid serving cached 403/429 failures
                const response = await fetch(event.request.url, { cache: 'no-cache' });
                if (response.ok) {
                    cache.put(key, response.clone());
                    evictIfNeeded(cache);
                }
                return response;
            } catch (err) {
                return new Response('', { status: 408 });
            }
        })
    );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

// Handle messages from the page
self.addEventListener('message', event => {
    if (event.data === 'CLEAR_TILE_CACHE') {
        caches.delete(CACHE_NAME).then(() => {
            event.ports[0]?.postMessage({ cleared: true });
        });
    }
    if (event.data === 'GET_CACHE_STATS') {
        caches.open(CACHE_NAME).then(cache => cache.keys()).then(keys => {
            event.ports[0]?.postMessage({ count: keys.length });
        });
    }
});
