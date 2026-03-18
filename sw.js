/**
 * Tight Ship — Service Worker
 * Strategy: Cache-First for static assets, Network-First for API calls.
 * Handles offline fallback, background sync queue, and cache versioning.
 */

const APP_VERSION   = 'v1.0.0';
const CACHE_STATIC  = `tight-ship-static-${APP_VERSION}`;
const CACHE_DYNAMIC = `tight-ship-dynamic-${APP_VERSION}`;
const CACHE_IMAGES  = `tight-ship-images-${APP_VERSION}`;

// All caches managed by this SW — anything NOT in this list gets deleted on activate
const ALL_CACHES = [CACHE_STATIC, CACHE_DYNAMIC, CACHE_IMAGES];

// ─── Static Shell: Pre-cached on install ───────────────────────────────────
const STATIC_ASSETS = [
  './index.html',
  './manifest.json',
  // CDN dependencies — cached so the app works fully offline after first load
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
  'https://unpkg.com/@phosphor-icons/web',
];

// ─── Background Sync Tag ────────────────────────────────────────────────────
const SYNC_TAG = 'tight-ship-drive-sync';

// ─── INSTALL: Pre-cache the static shell ────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW ${APP_VERSION}] Installing…`);

  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => {
        // Use individual adds so one failed CDN request doesn't abort the install
        return Promise.allSettled(
          STATIC_ASSETS.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SW] Failed to pre-cache: ${url}`, err)
            )
          )
        );
      })
      .then(() => {
        console.log(`[SW ${APP_VERSION}] Static shell cached.`);
        // Force this SW to become active immediately (skip waiting for old SW to die)
        return self.skipWaiting();
      })
  );
});

// ─── ACTIVATE: Clean up stale caches from older versions ────────────────────
self.addEventListener('activate', event => {
  console.log(`[SW ${APP_VERSION}] Activating…`);

  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => !ALL_CACHES.includes(name))
            .map(name => {
              console.log(`[SW] Deleting stale cache: ${name}`);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log(`[SW ${APP_VERSION}] Active. Claiming all clients.`);
        // Take control of all open tabs/windows immediately
        return self.clients.claim();
      })
  );
});

// ─── FETCH: Routing strategy ────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Skip non-GET requests (POST, etc.) — let them pass through
  if (request.method !== 'GET') return;

  // 2. Skip Google OAuth / Drive API calls — always needs network
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('accounts.google.com') ||
      url.hostname.includes('gstatic.com')) {
    return;
  }

  // 3. Images → Cache-First with dynamic cache fallback
  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, CACHE_IMAGES));
    return;
  }

  // 4. Static shell assets → Cache-First
  if (STATIC_ASSETS.some(asset => request.url.includes(asset.replace('./', '')))) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // 5. CDN assets (tailwind, phosphor, etc.) → Stale-While-Revalidate
  if (url.hostname !== self.location.hostname &&
      (url.hostname.includes('cdn') ||
       url.hostname.includes('cdnjs') ||
       url.hostname.includes('unpkg'))) {
    event.respondWith(staleWhileRevalidate(request, CACHE_DYNAMIC));
    return;
  }

  // 6. App HTML / navigation → Network-First with offline fallback
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirstWithFallback(request));
    return;
  }

  // 7. Everything else → Stale-While-Revalidate into dynamic cache
  event.respondWith(staleWhileRevalidate(request, CACHE_DYNAMIC));
});

// ─── Caching Strategy Implementations ──────────────────────────────────────

/**
 * Cache-First: Return cached version if available, otherwise fetch and cache.
 * Best for: Static assets that rarely change (icons, fonts, vendor JS).
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    console.warn('[SW] Cache-First fetch failed (offline?):', request.url);
    return offlineFallback(request);
  }
}

/**
 * Network-First: Try network, fall back to cache, fall back to offline page.
 * Best for: HTML documents and pages where freshness matters.
 */
async function networkFirstWithFallback(request) {
  const cache = await caches.open(CACHE_DYNAMIC);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;

    // Last resort: serve the main index.html as an SPA shell
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;

    return offlineFallback(request);
  }
}

/**
 * Stale-While-Revalidate: Return cached immediately, update cache in background.
 * Best for: CDN assets and semi-static resources where speed matters more than freshness.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Background fetch to refresh the cache (fire-and-forget)
  const networkFetch = fetch(request)
    .then(response => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || networkFetch || offlineFallback(request);
}

/**
 * Generates a minimal offline fallback response.
 * Shown when the app is completely offline and no cache exists yet.
 */
function offlineFallback(request) {
  if (request.destination === 'document' || request.mode === 'navigate') {
    return new Response(
      `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Tight Ship — Offline</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              background: #020817;
              color: #94a3b8;
              font-family: system-ui, sans-serif;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              padding: 2rem;
              text-align: center;
            }
            .icon { font-size: 3rem; margin-bottom: 1.5rem; }
            h1 { color: #f1f5f9; font-size: 1.5rem; margin-bottom: 0.75rem; }
            p { font-size: 0.875rem; line-height: 1.6; max-width: 320px; }
            .hint {
              margin-top: 2rem;
              padding: 0.75rem 1.25rem;
              background: #0f172a;
              border: 1px solid #1e293b;
              border-radius: 0.75rem;
              font-size: 0.75rem;
              color: #64748b;
            }
          </style>
        </head>
        <body>
          <div class="icon">⚓</div>
          <h1>You're Offline</h1>
          <p>Tight Ship needs a connection to load for the first time. Once loaded, it works fully offline.</p>
          <div class="hint">Your data is safe and stored locally on this device.</div>
        </body>
      </html>`,
      {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        }
      }
    );
  }

  // For non-document requests (JS, CSS, images), return empty 503
  return new Response('Offline', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// ─── BACKGROUND SYNC: Retry failed Drive uploads ────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    console.log('[SW] Background sync triggered:', SYNC_TAG);
    event.waitUntil(retryPendingDriveSync());
  }
});

/**
 * Reads any pending sync payload from the SW's own IndexedDB store,
 * attempts to re-upload to Google Drive, clears on success.
 *
 * The main app registers a sync payload via postMessage before going offline.
 * Format: { token: string, fileId: string|null, data: string }
 */
async function retryPendingDriveSync() {
  const pending = await getPendingSyncPayload();
  if (!pending || !pending.token) {
    console.log('[SW] No pending sync payload found.');
    return;
  }

  const { token, fileId, data } = pending;

  try {
    const metadata = {
      name: 'tight-ship-ledger.json',
      parents: fileId ? undefined : ['appDataFolder']
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([data], { type: 'application/json' }));

    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const response = await fetch(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });

    if (response.ok) {
      await clearPendingSyncPayload();
      console.log('[SW] Background Drive sync succeeded.');
      notifyClients({ type: 'SYNC_SUCCESS' });
    } else {
      throw new Error(`Drive API returned ${response.status}`);
    }
  } catch (err) {
    console.warn('[SW] Background Drive sync failed:', err);
    notifyClients({ type: 'SYNC_FAILED', error: err.message });
  }
}

// ─── MESSAGE HANDLER: Communication from the main app ───────────────────────
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    // App sends this when it wants to queue a sync for background retry
    case 'QUEUE_DRIVE_SYNC':
      storePendingSyncPayload(payload)
        .then(() => {
          if ('sync' in self.registration) {
            return self.registration.sync.register(SYNC_TAG);
          }
        })
        .then(() => console.log('[SW] Drive sync queued for background retry.'))
        .catch(err => console.error('[SW] Failed to queue sync:', err));
      break;

    // App requests SW version info (useful for update checks)
    case 'GET_VERSION':
      event.source.postMessage({ type: 'VERSION', version: APP_VERSION });
      break;

    // App requests cache wipe (triggered by "Wipe Memory" in settings)
    case 'CLEAR_CACHES':
      caches.keys()
        .then(names => Promise.all(names.map(n => caches.delete(n))))
        .then(() => {
          console.log('[SW] All caches cleared on request.');
          event.source.postMessage({ type: 'CACHES_CLEARED' });
        });
      break;

    default:
      console.log('[SW] Unknown message type:', type);
  }
});

// ─── IndexedDB helpers for SW-side pending sync storage ─────────────────────
// The SW cannot use localforage (it's a window library), so we use raw IDBs.

const IDB_NAME    = 'tight-ship-sw-store';
const IDB_VERSION = 1;
const IDB_STORE   = 'pending-sync';

function openSwIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function storePendingSyncPayload(payload) {
  const db = await openSwIDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req   = store.put(payload, 'pending');
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function getPendingSyncPayload() {
  const db = await openSwIDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req   = store.get('pending');
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function clearPendingSyncPayload() {
  const db = await openSwIDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req   = store.delete('pending');
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ─── Utility: Broadcast a message to all open app windows ───────────────────
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(message));
}
