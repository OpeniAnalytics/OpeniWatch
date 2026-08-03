/**
 * Application service worker registration and update handling.
 *
 * OpeniWatch runs TWO workers, separated by scope so they never contend for a
 * single registration:
 *
 *   /sw.js                  scope "/"            this file registers it
 *   /OneSignalSDKWorker.js  scope "/onesignal/"  the OneSignal SDK registers it
 *
 * The OneSignal file is left byte-for-byte as the vendor supplies it, and is
 * registered by the SDK on opt-in — not here. See
 * `src/services/notifications/pushClient.ts`.
 *
 * Nothing here requests notification permission. Installation and push are kept
 * apart on purpose: an install prompt that also asks to send notifications gets
 * both refused.
 */

const WORKER_PATH = '/sw.js'

export type UpdateListener = (activate: () => void) => void

let registration: ServiceWorkerRegistration | null = null

export function isServiceWorkerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    // A worker on an insecure origin is neither possible nor desirable.
    window.isSecureContext
  )
}

/**
 * Registers the worker and reports when a new version is waiting.
 *
 * `onUpdateReady` is called with an `activate` callback. Calling it tells the
 * waiting worker to take over and reloads once it does — so an operator is
 * never moved onto a new build mid-action without being told.
 */
export async function registerServiceWorker(onUpdateReady?: UpdateListener): Promise<void> {
  if (!isServiceWorkerSupported()) return

  /*
   * Whether this page was already under a worker's control BEFORE registering.
   *
   * This distinguishes the two reasons `controllerchange` fires:
   *
   *   - no previous controller: a first install calling `clients.claim()`.
   *     The page is already running the current build. Reloading here would
   *     make every first visit reload itself, which reads as a flicker or a
   *     crash and would throw away anything typed into a form.
   *   - a previous controller: a replacement worker has taken over, so the
   *     page really is running superseded code and should reload.
   *
   * Captured before `register()`, because registering can install and claim
   * within the same tick.
   */
  const hadController = Boolean(navigator.serviceWorker.controller)

  try {
    registration = await navigator.serviceWorker.register(WORKER_PATH, { scope: '/' })
  } catch {
    // A failed registration must never break the application. The operator
    // loses offline shell and installability, not the ability to work.
    return
  }

  // Reload once, and only when a replacement worker takes control.
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return
    reloading = true
    window.location.reload()
  })

  const notify = (worker: ServiceWorker) => {
    if (!onUpdateReady) return
    onUpdateReady(() => worker.postMessage({ type: 'SKIP_WAITING' }))
  }

  // Already waiting when the page loaded.
  if (registration.waiting && navigator.serviceWorker.controller) {
    notify(registration.waiting)
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration?.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      // `controller` present means this is a replacement, not a first install.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        notify(installing)
      }
    })
  })
}

/** True when the application is running as an installed app rather than a tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone
  return window.matchMedia('(display-mode: standalone)').matches || iosStandalone === true
}

/** True for iOS Safari, which installs via Share -> Add to Home Screen only. */
export function isIos(): boolean {
  if (typeof window === 'undefined') return false
  const ua = navigator.userAgent
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  )
}
