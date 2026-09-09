/**
 * OneSignal web push client.
 *
 * All OneSignal interaction goes through this one object. It is written against
 * injected dependencies rather than reaching for `window` directly, so every
 * rule below is testable without a browser: single initialization, identity
 * association on sign-in, detachment on sign-out, opt-in only after an explicit
 * user action, and honest opt-out.
 *
 * Design rules, in order of importance:
 *
 * 1. **The REST API key never reaches the browser.** Nothing here sends a
 *    notification. Sending happens in the `dispatch-notifications` Edge
 *    Function. The browser holds only `VITE_ONESIGNAL_APP_ID`, which is public
 *    by design.
 * 2. **The SDK is initialized exactly once per page.** `init()` is guarded by a
 *    memoized promise, so concurrent callers share one initialization and a
 *    second call is a no-op rather than a second OneSignal instance.
 * 3. **Nothing is downloaded or contacted until the operator asks.** The SDK is
 *    fetched on first opt-in, or on sign-in for a device already enrolled. An
 *    operator who never enables push never contacts OneSignal at all.
 * 4. **Identity is the OpeniWatch user id.** `login()` on sign-in and session
 *    restore, `logout()` on sign-out, so a shared device cannot deliver one
 *    operator's alerts to another.
 */

/** The subset of the OneSignal v16 page SDK that OpeniWatch uses. */
export interface OneSignalApi {
  init(config: Record<string, unknown>): Promise<void>
  login(externalId: string): Promise<void>
  logout(): Promise<void>
  User: {
    PushSubscription: {
      id: string | null
      optedIn: boolean
      optIn(): Promise<void>
      optOut(): Promise<void>
      addEventListener?(
        event: 'change',
        handler: (change: { current: { id: string | null; optedIn: boolean } }) => void,
      ): void
    }
  }
  Notifications: {
    permission: boolean
    requestPermission(): Promise<void>
  }
}

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported'

export type PushSupport = { supported: true } | { supported: false; reason: string }

/** Everything the client needs from its surroundings. Injected, so it is testable. */
export interface PushEnvironment {
  /** VITE_ONESIGNAL_APP_ID. Empty means web push is not configured. */
  appId: string
  /** False in local demo mode: there is no backend to record a registration in. */
  backendConfigured: boolean
  capabilities: {
    notifications: boolean
    serviceWorker: boolean
    secureContext: boolean
  }
  permission(): PushPermission
  /** Loads and returns the SDK. Called at most once per client instance. */
  loadSdk(): Promise<OneSignalApi>
  /** Records which user enrolled this device. Survives reloads. */
  storage: {
    get(key: string): string | null
    set(key: string, value: string): void
    remove(key: string): void
  }
  describeDevice(): string
  /** Injected so tests do not wait in real time. */
  delay(ms: number): Promise<void>
}

export interface RegistrationResult {
  providerSubscriptionId: string
  deviceLabel: string
}

/**
 * Which OpeniWatch user enrolled this device for push.
 *
 * Its presence is what licenses the client to load the SDK without a fresh
 * click: the operator already consented on this device. Its value is what
 * detects a handover — a different operator signing in on the same phone.
 */
export const ENROLLED_USER_KEY = 'openiwatch.push.enrolled-user'

export class PushClient {
  private sdk: Promise<OneSignalApi> | null = null
  /** Set once init() resolves, so repeat initialization can be asserted against. */
  private initCount = 0

  constructor(private readonly env: PushEnvironment) {}

  /** How many times the SDK was initialized. Must never exceed 1. */
  get initializations(): number {
    return this.initCount
  }

  /** Why push might be unavailable, stated plainly for the interface. */
  checkSupport(): PushSupport {
    const { capabilities, appId, backendConfigured } = this.env
    if (!capabilities.notifications) {
      return { supported: false, reason: 'This browser does not support notifications.' }
    }
    if (!capabilities.serviceWorker) {
      return { supported: false, reason: 'This browser does not support service workers.' }
    }
    if (!capabilities.secureContext) {
      return {
        supported: false,
        reason: 'Web push requires HTTPS. It is unavailable on an insecure origin.',
      }
    }
    if (!appId) {
      return {
        supported: false,
        reason:
          'Web push is not configured for this deployment (VITE_ONESIGNAL_APP_ID is not set). In-app notifications continue to work.',
      }
    }
    if (!backendConfigured) {
      return {
        supported: false,
        reason:
          'Web push requires the Supabase backend. Local demo mode records in-app notifications only.',
      }
    }
    return { supported: true }
  }

  currentPermission(): PushPermission {
    return this.env.permission()
  }

  /** True when this device has been enrolled by some user. */
  enrolledUserId(): string | null {
    return this.env.storage.get(ENROLLED_USER_KEY)
  }

  /**
   * Loads and initializes the SDK, exactly once.
   *
   * Every other method funnels through here, so there is no path that produces
   * a second `init()`. Concurrent callers await the same promise.
   */
  private async ready(): Promise<OneSignalApi> {
    const support = this.checkSupport()
    if (!support.supported) throw new Error(support.reason)

    if (!this.sdk) {
      this.sdk = (async () => {
        const api = await this.env.loadSdk()
        await api.init({
          appId: this.env.appId,
          /*
           * The vendor's worker file, registered under its own scope so it
           * cannot collide with the application worker at "/". A push
           * subscription belongs to a registration, not to a page, so a narrow
           * scope does not affect delivery.
           */
          serviceWorkerPath: '/OneSignalSDKWorker.js',
          serviceWorkerParam: { scope: '/onesignal/' },
          // Suppress OneSignal's own prompt: OpeniWatch asks in its own UI, so
          // the operator understands what they are agreeing to.
          autoResubscribe: true,
          notifyButton: { enable: false },
          promptOptions: { slidedown: { prompts: [] } },
        })
        this.initCount += 1
        return api
      })()

      // A failed initialization must not poison the client forever — but it
      // also must not be retried silently in a loop.
      this.sdk.catch(() => {
        this.sdk = null
      })
    }
    return this.sdk
  }

  /**
   * Associates this device with the signed-in OpeniWatch user.
   *
   * Called after sign-in and after a restored session. It is a no-op on a
   * device that has never enrolled: loading the SDK for someone who never asked
   * for push would contact OneSignal without consent, and there would be no
   * subscription to associate anyway.
   *
   * When the enrolled user differs from the one signing in, this is a device
   * handover. `login()` moves the subscription to the new operator, which is
   * exactly what stops the previous one's alerts arriving on a phone they no
   * longer hold.
   */
  async syncIdentity(userId: string): Promise<void> {
    if (!userId) return
    const enrolled = this.enrolledUserId()
    if (!enrolled) return
    if (!this.checkSupport().supported) return

    const api = await this.ready()
    await api.login(userId)
    // The device now belongs to whoever just signed in.
    this.env.storage.set(ENROLLED_USER_KEY, userId)
  }

  /**
   * Detaches this device from the signing-out user.
   *
   * Only acts when the SDK is already loaded in this page. If it is not, no
   * OneSignal call has been made this page load, and the next sign-in runs
   * `syncIdentity`, which reassigns the device before any notification could be
   * addressed to the wrong operator.
   */
  async clearIdentity(): Promise<void> {
    if (!this.sdk) return
    const api = await this.sdk
    await api.logout()
  }

  /**
   * Requests permission and returns the provider subscription id.
   *
   * Must be called from an explicit user action — a click. It is the only path
   * that calls `requestPermission()`, and nothing calls it on load.
   *
   * Throws with a readable message on refusal or failure; the caller records
   * nothing in that case, so a declined prompt leaves no registration behind.
   */
  async optIn(userId: string): Promise<RegistrationResult> {
    const api = await this.ready()

    await api.Notifications.requestPermission()
    if (this.env.permission() !== 'granted') {
      throw new Error(
        'Notification permission was not granted. You can enable it later in your browser settings.',
      )
    }

    await api.User.PushSubscription.optIn()

    // Identity before the id: the subscription must belong to this operator
    // from the moment it exists.
    if (userId) await api.login(userId)

    const subscriptionId = await this.waitForSubscriptionId(api)
    if (!subscriptionId) {
      throw new Error('OneSignal did not return a subscription id. Registration was not recorded.')
    }

    if (userId) this.env.storage.set(ENROLLED_USER_KEY, userId)
    return { providerSubscriptionId: subscriptionId, deviceLabel: this.env.describeDevice() }
  }

  /**
   * Turns off push at the provider and forgets the enrollment.
   *
   * The caller removes the stored row. Both halves matter: leaving the row
   * behind would claim a registration that no longer exists, and leaving
   * OneSignal opted in would keep delivering to a device the operator believes
   * they have switched off.
   */
  async optOut(): Promise<void> {
    this.env.storage.remove(ENROLLED_USER_KEY)
    if (!this.sdk && !this.checkSupport().supported) return

    const api = await this.ready()
    await api.User.PushSubscription.optOut()
    await api.logout()
  }

  /** The provider's current subscription id, or null if there is not one. */
  async currentSubscriptionId(): Promise<string | null> {
    if (!this.sdk) return null
    const api = await this.sdk
    return api.User.PushSubscription.id
  }

  /**
   * Watches for the provider replacing the subscription id.
   *
   * OneSignal reissues an id when a browser rotates its push endpoint. Without
   * this the stored row would silently point at a subscription that no longer
   * receives anything — the delivery would be accepted and land nowhere.
   */
  async onSubscriptionChange(
    handler: (subscriptionId: string | null, optedIn: boolean) => void,
  ): Promise<void> {
    if (!this.sdk) return
    const api = await this.sdk
    api.User.PushSubscription.addEventListener?.('change', (change) => {
      handler(change.current.id, change.current.optedIn)
    })
  }

  /** The id can take a moment to appear after opt-in. */
  private async waitForSubscriptionId(api: OneSignalApi): Promise<string | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = api.User.PushSubscription.id
      if (id) return id
      await this.env.delay(250)
    }
    return null
  }
}
