import { env, isSupabaseConfigured } from '@/lib/env'
import {
  PushClient,
  type OneSignalApi,
  type PushEnvironment,
  type PushPermission,
  type PushSupport,
} from './pushClient'

/**
 * The browser-bound OneSignal client.
 *
 * This module does one thing: build a `PushClient` from the real browser and
 * export it as a singleton. Every rule lives in `pushClient.ts`, where it can
 * be tested without a DOM.
 *
 * The OneSignal SDK is loaded lazily, from the page, and only when an operator
 * opts in — or when a device that has already enrolled signs back in. OpeniWatch
 * never calls `Notification.requestPermission()` on page load: a browser
 * permission prompt an operator did not ask for is how a channel gets blocked
 * permanently.
 *
 * Only the provider's subscription identifier is stored, tied to the signed-in
 * OpeniWatch user. No device fingerprint, no location, no advertising id.
 */

export type { PushPermission, PushSupport } from './pushClient'
export type { RegistrationResult } from './pushClient'

const SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'

declare global {
  interface Window {
    OneSignalDeferred?: Array<(api: OneSignalApi) => void | Promise<void>>
  }
}

/**
 * Loads the OneSignal page SDK.
 *
 * Called at most once per page by `PushClient`, which memoizes it. The script
 * tag is added only if it is not already present, so a hot reload cannot stack
 * two copies of the SDK.
 */
function loadSdk(): Promise<OneSignalApi> {
  return new Promise<OneSignalApi>((resolve, reject) => {
    window.OneSignalDeferred = window.OneSignalDeferred ?? []

    const timeout = window.setTimeout(
      () => reject(new Error('The OneSignal SDK did not load within 15 seconds.')),
      15_000,
    )

    window.OneSignalDeferred.push((api) => {
      window.clearTimeout(timeout)
      resolve(api)
    })

    if (!document.querySelector(`script[src="${SDK_URL}"]`)) {
      const script = document.createElement('script')
      script.src = SDK_URL
      script.defer = true
      script.onerror = () => {
        window.clearTimeout(timeout)
        reject(new Error('The OneSignal SDK could not be downloaded.'))
      }
      document.head.appendChild(script)
    }
  })
}

/**
 * A coarse, human-readable device label so an operator can recognise their own
 * registrations in a list. Deliberately not a fingerprint: browser family and
 * platform only, no version, no screen metrics, no fonts.
 */
function describeDevice(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const platform = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown platform'
  return `${browser} on ${platform}`
}

const browserEnvironment: PushEnvironment = {
  // Read from import.meta.env via src/lib/env.ts, never hardcoded.
  appId: env.oneSignalAppId,
  backendConfigured: isSupabaseConfigured,
  capabilities: {
    notifications: typeof window !== 'undefined' && 'Notification' in window,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
  },
  permission: (): PushPermission => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
    return Notification.permission as PushPermission
  },
  loadSdk,
  storage: {
    get: (key) => {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        // Private browsing can refuse storage. Push still works for this page;
        // the device just is not remembered as enrolled across reloads.
      }
    },
    remove: (key) => {
      try {
        localStorage.removeItem(key)
      } catch {
        // As above.
      }
    },
  },
  describeDevice,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export const pushClient = new PushClient(browserEnvironment)

/** Why push might be unavailable, stated plainly for the interface. */
export function checkPushSupport(): PushSupport {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'Not running in a browser.' }
  }
  return pushClient.checkSupport()
}

export function currentPermission(): PushPermission {
  return pushClient.currentPermission()
}
