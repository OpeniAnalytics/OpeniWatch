/*
 * OpeniWatch application service worker.
 *
 * Offline shell and installability. Push is NOT handled here — OneSignal ships
 * its own worker, `/OneSignalSDKWorker.js`, which must stay byte-for-byte as
 * the vendor supplies it.
 *
 * ---------------------------------------------------------------------------
 * Why two workers, and how they avoid fighting
 * ---------------------------------------------------------------------------
 *
 * A scope may have exactly one active service worker registration. Both this
 * worker and OneSignal's want to exist on the same origin, so they are
 * separated by SCOPE rather than by merging their code:
 *
 *   /sw.js                    scope "/"            <- this file, shell + install
 *   /OneSignalSDKWorker.js    scope "/onesignal/"  <- vendor file, push only
 *
 * A push subscription belongs to a service worker REGISTRATION, not to a page.
 * Push events and notification clicks are delivered to OneSignal's worker
 * regardless of whether any page falls inside its scope, so the narrow scope
 * costs nothing and keeps "/" free for the shell. This is OneSignal's own
 * documented arrangement for a site that already has a service worker.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CACHED — and, more importantly, what is not
 * ---------------------------------------------------------------------------
 *
 * Cached: the application shell only. The entry document and the hashed build
 * assets that render it. These are public, identical for every operator, and
 * contain no operational content.
 *
 * NEVER cached, deliberately:
 *   - alerts, signals, candidates or any operational record;
 *   - raw source text or author information;
 *   - Supabase REST or Realtime responses of any kind;
 *   - authentication tokens or session state.
 *
 * The fetch handler refuses to store any cross-origin response and any response
 * to a non-GET request, so a Supabase call cannot end up in the cache even by
 * accident. An operator who goes offline sees the shell and a failure to load
 * data — not a stale alert list that might be hours out of date and that they
 * could act on believing it current. Showing a cached "no critical alerts" to
 * someone standing in a car park is a safety problem, not a feature.
 */

// Bumped whenever the shell contract changes. Old caches are deleted on
// activate, so a stale shell cannot survive a deploy.
const CACHE = 'openiwatch-shell-v1'

/** Same-origin paths that make up the installable shell. */
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing entry does not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      // Take over as soon as possible: a security tool should not run a version
      // the operator has already been told is outdated.
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

/** True only for requests that are safe to serve from, or put into, the cache. */
function isCacheableShellRequest(request) {
  if (request.method !== 'GET') return false

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false

  // Never cache anything that looks like data or an API call, whatever its
  // origin bookkeeping says.
  if (url.pathname.startsWith('/rest/')) return false
  if (url.pathname.startsWith('/auth/')) return false
  if (url.pathname.startsWith('/functions/')) return false
  if (url.pathname.startsWith('/realtime/')) return false

  // OneSignal's worker and its scope are never this worker's business.
  if (url.pathname === '/OneSignalSDKWorker.js') return false
  if (url.pathname.startsWith('/onesignal/')) return false

  return true
}

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (!isCacheableShellRequest(request)) return // straight to the network

  // Navigations: network first, so a deployed update is picked up immediately;
  // fall back to the cached shell only when the network genuinely fails.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html').then((cached) => cached ?? Response.error())),
    )
    return
  }

  // Hashed build assets are immutable, so cache-first is safe and fast. A new
  // deploy produces new filenames rather than new contents at the same name.
  if (request.url.includes('/assets/') || request.url.includes('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone()
              void caches.open(CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
  }
})

/**
 * Update signalling.
 *
 * The page posts SKIP_WAITING when the operator accepts an update. Combined
 * with the `controllerchange` listener in src/services/pwa/register.ts, the
 * new version takes effect on the next reload rather than silently at some
 * unpredictable later navigation.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting()
})
