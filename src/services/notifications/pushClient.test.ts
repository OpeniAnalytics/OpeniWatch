import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENROLLED_USER_KEY,
  PushClient,
  type OneSignalApi,
  type PushEnvironment,
  type PushPermission,
} from './pushClient'

/**
 * OneSignal web push client.
 *
 * The rules being protected here are the ones that go wrong quietly: a second
 * SDK initialization nobody notices, a shared phone still addressed as the
 * previous operator, an opt-out that stops the record but not the provider.
 */

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'

interface Harness {
  client: PushClient
  api: OneSignalApi
  store: Map<string, string>
  loadCount: () => number
  setPermission: (value: PushPermission) => void
  setSubscriptionId: (value: string | null) => void
  emitChange: (id: string | null, optedIn: boolean) => void
  calls: string[]
}

function harness(overrides: Partial<PushEnvironment> = {}): Harness {
  const store = new Map<string, string>()
  const calls: string[] = []
  let permission: PushPermission = 'default'
  let subscriptionId: string | null = 'sub-initial'
  let loads = 0
  let changeHandler: ((c: { current: { id: string | null; optedIn: boolean } }) => void) | null =
    null

  const api: OneSignalApi = {
    init: vi.fn(async () => {
      calls.push('init')
    }),
    login: vi.fn(async (externalId: string) => {
      calls.push(`login:${externalId}`)
    }),
    logout: vi.fn(async () => {
      calls.push('logout')
    }),
    User: {
      PushSubscription: {
        get id() {
          return subscriptionId
        },
        optedIn: false,
        optIn: vi.fn(async () => {
          calls.push('optIn')
        }),
        optOut: vi.fn(async () => {
          calls.push('optOut')
        }),
        addEventListener: (_event, handler) => {
          changeHandler = handler
        },
      },
    },
    Notifications: {
      permission: false,
      requestPermission: vi.fn(async () => {
        calls.push('requestPermission')
        // The browser prompt resolving is what grants permission.
        if (permission === 'default') permission = 'granted'
      }),
    },
  }

  const env: PushEnvironment = {
    appId: 'app-id-from-vite-env',
    backendConfigured: true,
    capabilities: { notifications: true, serviceWorker: true, secureContext: true },
    permission: () => permission,
    loadSdk: async () => {
      loads += 1
      calls.push('loadSdk')
      return api
    },
    storage: {
      get: (key) => store.get(key) ?? null,
      set: (key, value) => void store.set(key, value),
      remove: (key) => void store.delete(key),
    },
    describeDevice: () => 'Chrome on Windows',
    delay: async () => {},
    ...overrides,
  }

  return {
    client: new PushClient(env),
    api,
    store,
    calls,
    loadCount: () => loads,
    setPermission: (value) => {
      permission = value
    },
    setSubscriptionId: (value) => {
      subscriptionId = value
    },
    emitChange: (id, optedIn) => changeHandler?.({ current: { id, optedIn } }),
  }
}

describe('single SDK initialization', () => {
  it('initializes once no matter how many operations run', async () => {
    const h = harness()
    await h.client.optIn(ALICE)
    await h.client.syncIdentity(ALICE)
    await h.client.optOut()
    await h.client.optIn(ALICE)

    expect(h.client.initializations).toBe(1)
    expect(h.loadCount()).toBe(1)
    expect(h.calls.filter((c) => c === 'init')).toHaveLength(1)
  })

  it('shares one initialization between concurrent callers', async () => {
    const h = harness()
    await Promise.all([h.client.optIn(ALICE), h.client.optIn(ALICE), h.client.optIn(ALICE)])
    expect(h.client.initializations).toBe(1)
    expect(h.loadCount()).toBe(1)
  })

  it('passes the injected app id to init and never a literal', async () => {
    const h = harness()
    await h.client.optIn(ALICE)
    const config = (h.api.init as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls[0]![0]
    expect(config.appId).toBe('app-id-from-vite-env')
    // The vendor worker, under its own scope so it cannot displace /sw.js.
    expect(config.serviceWorkerPath).toBe('/OneSignalSDKWorker.js')
    expect(config.serviceWorkerParam).toEqual({ scope: '/onesignal/' })
  })

  it('does not stay poisoned after a failed load', async () => {
    let attempts = 0
    const h = harness({
      loadSdk: async () => {
        attempts += 1
        throw new Error('CDN unreachable')
      },
    })

    await expect(h.client.optIn(ALICE)).rejects.toThrow(/CDN unreachable/)
    expect(attempts).toBe(1)

    // The memoized promise is discarded on failure, so a later attempt tries
    // again instead of replaying the old rejection forever. An operator whose
    // first attempt hit a flaky network can press the button a second time.
    await expect(h.client.optIn(ALICE)).rejects.toThrow(/CDN unreachable/)
    expect(attempts).toBe(2)
    // And a failed initialization is never counted as one.
    expect(h.client.initializations).toBe(0)
  })
})

describe('missing app id', () => {
  it('reports push unavailable and names the variable', () => {
    const h = harness({ appId: '' })
    const support = h.client.checkSupport()
    expect(support.supported).toBe(false)
    if (support.supported) return
    expect(support.reason).toContain('VITE_ONESIGNAL_APP_ID')
  })

  it('never loads the SDK without an app id', async () => {
    const h = harness({ appId: '' })
    await expect(h.client.optIn(ALICE)).rejects.toThrow(/VITE_ONESIGNAL_APP_ID/)
    expect(h.loadCount()).toBe(0)
  })

  it('reports unavailable without a backend, rather than pretending', () => {
    const h = harness({ backendConfigured: false })
    const support = h.client.checkSupport()
    expect(support.supported).toBe(false)
    if (support.supported) return
    expect(support.reason).toMatch(/Supabase backend/)
  })
})

describe('opt-in', () => {
  it('requests permission, subscribes and associates the signed-in user', async () => {
    const h = harness()
    const result = await h.client.optIn(ALICE)

    expect(h.calls).toEqual([
      'loadSdk',
      'init',
      'requestPermission',
      'optIn',
      `login:${ALICE}`,
    ])
    expect(result.providerSubscriptionId).toBe('sub-initial')
    expect(result.deviceLabel).toBe('Chrome on Windows')
    expect(h.store.get(ENROLLED_USER_KEY)).toBe(ALICE)
  })

  it('records nothing when permission is refused', async () => {
    const h = harness()
    h.setPermission('denied')
    await expect(h.client.optIn(ALICE)).rejects.toThrow(/permission was not granted/i)
    // No identity claimed, no enrollment stored.
    expect(h.calls).not.toContain(`login:${ALICE}`)
    expect(h.store.has(ENROLLED_USER_KEY)).toBe(false)
  })

  it('refuses to report success when the provider returns no subscription id', async () => {
    const h = harness()
    h.setSubscriptionId(null)
    await expect(h.client.optIn(ALICE)).rejects.toThrow(/did not return a subscription id/i)
    expect(h.store.has(ENROLLED_USER_KEY)).toBe(false)
  })

  it('is never triggered by construction or by a support check', () => {
    const h = harness()
    h.client.checkSupport()
    h.client.currentPermission()
    h.client.enrolledUserId()
    // Nothing happens until an explicit user action calls optIn().
    expect(h.calls).toEqual([])
    expect(h.loadCount()).toBe(0)
  })
})

describe('sign-in identity association', () => {
  it('logs the enrolled device in as the signed-in user', async () => {
    const h = harness()
    h.store.set(ENROLLED_USER_KEY, ALICE)

    await h.client.syncIdentity(ALICE)
    expect(h.calls).toContain(`login:${ALICE}`)
  })

  it('does nothing on a device that never enrolled', async () => {
    const h = harness()
    await h.client.syncIdentity(ALICE)
    // Loading the SDK here would contact OneSignal for someone who never asked
    // for push.
    expect(h.calls).toEqual([])
    expect(h.loadCount()).toBe(0)
  })

  it('survives a restored session without re-prompting', async () => {
    const h = harness()
    h.store.set(ENROLLED_USER_KEY, ALICE)

    // Session restore on a fresh page load.
    await h.client.syncIdentity(ALICE)
    expect(h.calls).toContain(`login:${ALICE}`)
    expect(h.calls).not.toContain('requestPermission')
    expect(h.calls).not.toContain('optIn')
  })
})

describe('unauthorized subscription association', () => {
  it('moves the device to the operator who actually signed in', async () => {
    const h = harness()
    // Alice enrolled this phone.
    await h.client.optIn(ALICE)
    expect(h.store.get(ENROLLED_USER_KEY)).toBe(ALICE)

    // Bob signs in on the same phone.
    await h.client.syncIdentity(BOB)

    // The subscription is now Bob's, so Alice's alerts stop arriving on a
    // device she no longer holds.
    expect(h.calls).toContain(`login:${BOB}`)
    expect(h.store.get(ENROLLED_USER_KEY)).toBe(BOB)
  })

  it('never associates a subscription with a user who is not signed in', async () => {
    const h = harness()
    await h.client.optIn(ALICE)
    // Every login call names a user the client was actually given.
    const logins = h.calls.filter((c) => c.startsWith('login:'))
    expect(logins.every((c) => c === `login:${ALICE}`)).toBe(true)
  })

  it('refuses to claim an identity for an empty user id', async () => {
    const h = harness()
    h.store.set(ENROLLED_USER_KEY, ALICE)
    await h.client.syncIdentity('')
    expect(h.calls.filter((c) => c.startsWith('login:'))).toEqual([])
  })
})

describe('sign-out', () => {
  it('detaches the device at the provider', async () => {
    const h = harness()
    await h.client.optIn(ALICE)
    await h.client.clearIdentity()
    expect(h.calls).toContain('logout')
  })

  it('does nothing when the SDK was never loaded this page', async () => {
    const h = harness()
    h.store.set(ENROLLED_USER_KEY, ALICE)
    await h.client.clearIdentity()
    // No SDK loaded means no live association to clear; the next sign-in
    // reassigns the device before anything could be misdelivered.
    expect(h.calls).toEqual([])
    expect(h.loadCount()).toBe(0)
  })
})

describe('opt-out', () => {
  it('tells the provider to stop, logs out, and forgets the enrollment', async () => {
    const h = harness()
    await h.client.optIn(ALICE)
    h.calls.length = 0

    await h.client.optOut()

    // Both halves. Stopping only one of them is the dishonest outcome: a row
    // claiming a dead registration, or a phone still buzzing.
    expect(h.calls).toContain('optOut')
    expect(h.calls).toContain('logout')
    expect(h.store.has(ENROLLED_USER_KEY)).toBe(false)
  })

  it('clears local enrollment even when push is no longer supported', async () => {
    const h = harness({ appId: '' })
    h.store.set(ENROLLED_USER_KEY, ALICE)
    await h.client.optOut()
    expect(h.store.has(ENROLLED_USER_KEY)).toBe(false)
  })
})

describe('subscription id changes', () => {
  it('reports a reissued id so the stored row can be corrected', async () => {
    const h = harness()
    await h.client.optIn(ALICE)

    const seen: Array<{ id: string | null; optedIn: boolean }> = []
    await h.client.onSubscriptionChange((id, optedIn) => seen.push({ id, optedIn }))

    h.emitChange('sub-rotated', true)
    expect(seen).toEqual([{ id: 'sub-rotated', optedIn: true }])
  })

  it('reports the current id', async () => {
    const h = harness()
    await h.client.optIn(ALICE)
    h.setSubscriptionId('sub-rotated')
    expect(await h.client.currentSubscriptionId()).toBe('sub-rotated')
  })

  it('reports no id before the SDK has loaded', async () => {
    const h = harness()
    expect(await h.client.currentSubscriptionId()).toBeNull()
    expect(h.loadCount()).toBe(0)
  })
})

describe('the REST API key is server-side only', () => {
  const REST_KEY = 'ONESIGNAL_REST_API_KEY'

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) sourceFiles(full, out)
      else if (/\.tsx?$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('is never read from import.meta.env by browser code', () => {
    const offenders = sourceFiles('src').filter((file) =>
      new RegExp(`import\\.meta\\.env\\s*(\\.\\s*${REST_KEY}|\\[\\s*['"\`]${REST_KEY})`).test(
        readFileSync(file, 'utf8'),
      ),
    )
    expect(offenders).toEqual([])
  })

  it('has no VITE_ alias, which would inline it into the bundle', () => {
    const declarations = readFileSync('src/vite-env.d.ts', 'utf8')
    expect(declarations).not.toMatch(new RegExp(`VITE_${REST_KEY}`))
    expect(readFileSync('.env.example', 'utf8')).not.toMatch(new RegExp(`VITE_${REST_KEY}`))
  })

  it('is read only by the server-side Edge Function', () => {
    const readers = sourceFiles('supabase/functions').filter((file) =>
      readFileSync(file, 'utf8').includes(`Deno.env.get('${REST_KEY}')`),
    )
    expect(readers.length).toBeGreaterThan(0)
    for (const file of readers) expect(file.startsWith('supabase/functions')).toBe(true)
  })
})

describe('the shipped service worker files', () => {
  it('keeps the OneSignal worker exactly as the vendor supplies it', () => {
    const worker = readFileSync('public/OneSignalSDKWorker.js', 'utf8')
    // Byte-for-byte, one line. Anything else and OneSignal support cannot
    // reason about it, and a future edit could silently break push.
    expect(worker.trim()).toBe(
      'importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");',
    )
    expect(worker.trim().split('\n')).toHaveLength(1)
  })

  it('keeps the application worker separate, and free of push handling', () => {
    const appWorker = readFileSync('public/sw.js', 'utf8')
    expect(appWorker).not.toContain('OneSignalSDK.sw.js')
    // The application worker owns "/" and must never cache operational data.
    expect(appWorker).toContain("'/rest/'")
    expect(appWorker).toContain("'/auth/'")
  })

  it('registers the application worker at the root scope', () => {
    const register = readFileSync('src/services/pwa/register.ts', 'utf8')
    expect(register).toContain("const WORKER_PATH = '/sw.js'")
    expect(register).toContain("scope: '/'")
  })
})
