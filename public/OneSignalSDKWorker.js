/*
 * OpeniWatch service worker.
 *
 * ONE worker file, doing two jobs. This is deliberate and it is the whole
 * design decision, so it is written down here rather than in a commit message.
 *
 * A service worker scope may have exactly one active registration. OneSignal
 * requires a worker at the root scope in order to receive pushes, and a PWA
 * needs a worker at the root scope in order to be installable and to serve an
 * offline shell. Registering two files at "/" means the second replaces the
 * first: either push breaks or installability does. So both behaviours live in
 * this file, which keeps the path OneSignal already expects
 * (/OneSignalSDKWorker.js, granted root scope by the Service-Worker-Allowed
 * header in netlify.toml).
 *
 * The application registers this file on startup so the shell works and the
 * app is installable even for an operator who never opts in to push. When they
 * later do opt in, the OneSignal SDK finds this existing registration at the
 * same path and scope and reuses it rather than creating a second one.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CACHED — and, more importantly, what is not
 * ---------------------------------------------------------------------------
 *
 * Cached: the application shell only. The entry document and the hashed
 * build assets that render it. These are public, identical for every operator,
 * and contain no operational content.
 *
 * NEVER cached, deliberately:
 *   - alerts, signals, candidates or any operational record;
 *   - raw source text or author information;
 *   - Supabase REST or Realtime responses of any kind;
 *   - authentication tokens or session state.
 *
 * The fetch handler below refuses to store any cross-origin response and any
 * response to a non-GET request, so a Supabase call cannot end up in the cache
 * even by accident. An operator who goes offline sees the shell and a failure
 * to load data — not a stale alert list that might be hours out of date and
 * that they could act on believing it current. Showing a cached "no critical
 * alerts" to someone standing in a car park is a safety problem, not a feature.
 */

importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js')

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
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
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
