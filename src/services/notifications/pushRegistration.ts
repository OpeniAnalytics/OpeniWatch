import { env, isSupabaseConfigured } from '@/lib/env'

/**
 * Web push registration.
 *
 * Explicitly opt-in: nothing here runs until an operator presses the button.
 * OpeniWatch never calls `Notification.requestPermission()` on page load — a
 * browser permission prompt an operator did not ask for is how a channel gets
 * blocked permanently.
 *
 * Only the provider's subscription identifier is stored, tied to the signed-in
 * OpeniWatch user. No device fingerprint, no location, no advertising id.
 *
 * The OneSignal SDK is loaded lazily, from the page, only when the operator
 * opts in. The REST API key is not involved: sending happens server-side in the
 * `dispatch-notifications` Edge Function.
 */

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: string }

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported'

interface OneSignalDeferredApi {
  init(config: Record<string, unknown>): Promise<void>
  User: {
    PushSubscription: {
      id: string | null
      optedIn: boolean
      optIn(): Promise<void>
      optOut(): Promise<void>
    }
  }
  Notifications: {
    permission: boolean
    requestPermission(): Promise<void>
  }
}

declare global {
  interface Window {
    OneSignalDeferred?: Array<(api: OneSignalDeferredApi) => void | Promise<void>>
  }
}

const SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'

/** Why push might be unavailable, stated plainly for the interface. */
export function checkPushSupport(): PushSupport {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'Not running in a browser.' }
  }
  if (!('Notification' in window)) {
    return { supported: false, reason: 'This browser does not support notifications.' }
  }
  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: 'This browser does not support service workers.' }
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: 'Web push requires HTTPS. It is unavailable on an insecure origin.',
    }
  }
  if (!env.oneSignalAppId) {
    return {
      supported: false,
      reason:
        'Web push is not configured for this deployment (VITE_ONESIGNAL_APP_ID is not set). In-app notifications continue to work.',
    }
  }
  if (!isSupabaseConfigured) {
    return {
      supported: false,
      reason:
        'Web push requires the Supabase backend. Local demo mode records in-app notifications only.',
    }
  }
  return { supported: true }
}

export function currentPermission(): PushPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission as PushPermission
}

let sdkPromise: Promise<OneSignalDeferredApi> | null = null

/**
 * Loads the OneSignal page SDK on demand.
 *
 * Called only from an explicit opt-in, so an operator who never enables push
 * never downloads it and never contacts OneSignal.
 */
function loadSdk(): Promise<OneSignalDeferredApi> {
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise<OneSignalDeferredApi>((resolve, reject) => {
    window.OneSignalDeferred = window.OneSignalDeferred ?? []

    const timeout = window.setTimeout(
      () => reject(new Error('The OneSignal SDK did not load within 15 seconds.')),
      15_000,
    )

    window.OneSignalDeferred.push(async (api) => {
      try {
        await api.init({
          appId: env.oneSignalAppId,
          // The service worker is served from the application origin; see
          // public/OneSignalSDKWorker.js and docs/ONESIGNAL_SETUP.md.
          serviceWorkerPath: '/OneSignalSDKWorker.js',
          serviceWorkerParam: { scope: '/' },
          // Suppress OneSignal's own prompt: OpeniWatch asks in its own UI, so
          // the operator understands what they are agreeing to.
          autoResubscribe: true,
          notifyButton: { enable: false },
          promptOptions: { slidedown: { prompts: [] } },
        })
        window.clearTimeout(timeout)
        resolve(api)
      } catch (error) {
        window.clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
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

  return sdkPromise
}

export interface RegistrationResult {
  providerSubscriptionId: string
  deviceLabel: string
}

/**
 * Requests permission and returns the provider subscription id.
 *
 * Throws with a readable message on refusal or failure; the caller records
 * nothing in that case, so a declined prompt leaves no registration behind.
 */
export async function registerForPush(): Promise<RegistrationResult> {
  const support = checkPushSupport()
  if (!support.supported) throw new Error(support.reason)

  const api = await loadSdk()

  await api.Notifications.requestPermission()
  if (Notification.permission !== 'granted') {
    throw new Error(
      'Notification permission was not granted. You can enable it later in your browser settings.',
    )
  }

  await api.User.PushSubscription.optIn()

  // The id can take a moment to appear after opt-in.
  const subscriptionId = await waitForSubscriptionId(api)
  if (!subscriptionId) {
    throw new Error('OneSignal did not return a subscription id. Registration was not recorded.')
  }

  return { providerSubscriptionId: subscriptionId, deviceLabel: describeDevice() }
}

async function waitForSubscriptionId(api: OneSignalDeferredApi): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = api.User.PushSubscription.id
    if (id) return id
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

/** Turns off push at the provider. The caller also removes the stored row. */
export async function unregisterFromPush(): Promise<void> {
  const api = await loadSdk()
  await api.User.PushSubscription.optOut()
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
