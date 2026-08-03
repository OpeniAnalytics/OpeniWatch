/**
 * Service worker registration and update handling.
 *
 * OpeniWatch registers ONE worker, `/OneSignalSDKWorker.js`, at the root scope.
 * That single file carries both the OneSignal push handler and the offline
 * shell — see the comment at the top of it for why they cannot be separate
 * files. Registering here (rather than leaving it to the OneSignal SDK) means
 * the shell works and the application is installable for operators who never
 * opt in to push; the SDK reuses this registration when they later do.
 *
 * Nothing here requests notification permission. Installation and push are kept
 * apart on purpose: an install prompt that also asks to send notifications gets
 * both refused.
 */

const WORKER_PATH = '/OneSignalSDKWorker.js'

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

  try {
    registration = await navigator.serviceWorker.register(WORKER_PATH, { scope: '/' })
  } catch {
    // A failed registration must never break the application. The operator
    // loses offline shell and installability, not the ability to work.
    return
  }

  // Reload once, when the replacement worker actually takes control.
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
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
