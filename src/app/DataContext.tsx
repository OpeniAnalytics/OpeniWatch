import * as React from 'react'
import { getDataProvider } from '@/data'
import { pushClient } from '@/services/notifications/pushRegistration'
import type { ChangeEvent, DataProvider, ReferenceData, SessionUser } from '@/data/provider'
import { NotAuthorizedError } from '@/data/workflow'

/**
 * Application data context.
 *
 * Holds the single data provider, the signed-in session, and the reference
 * data every screen needs (locations, assignments, categories, thresholds).
 * `revision` increments on every provider change event, which is how screens
 * pick up realtime updates without each one wiring its own subscription.
 */

interface DataContextValue {
  provider: DataProvider
  session: SessionUser | null
  /**
   * Set when the user authenticated but has no active OpeniWatch membership.
   * The application renders the "Access not authorized" screen and loads
   * nothing operational.
   */
  authorization: { email: string; reason: string } | null
  reference: ReferenceData | null
  /** Bumped on every change event; use as a dependency to refetch. */
  revision: number
  loading: boolean
  signIn: (email: string, password?: string) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => void
}

const DataContext = React.createContext<DataContextValue | null>(null)

export function DataProviderContext({ children }: { children: React.ReactNode }) {
  const provider = React.useMemo(() => getDataProvider(), [])
  const [session, setSession] = React.useState<SessionUser | null>(null)
  const [reference, setReference] = React.useState<ReferenceData | null>(null)
  const [revision, setRevision] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [authorization, setAuthorization] = React.useState<{
    email: string
    reason: string
  } | null>(null)

  const bump = React.useCallback(() => setRevision((r) => r + 1), [])

  /*
   * Session restoration.
   *
   * Runs on every mount, including after a page refresh and after the full
   * navigation the auth callback performs. Supabase restores the session from
   * storage; this turns it into an OpeniWatch identity, or into the
   * not-authorized state.
   *
   * The failure path matters: before this, a rejection here was unhandled, so
   * an authenticated user with no membership produced a console error and a
   * blank screen rather than an explanation.
   */
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await provider.getSession()
        if (cancelled) return
        setSession(current)
        setAuthorization(null)
      } catch (error) {
        if (cancelled) return
        setSession(null)
        setAuthorization(
          error instanceof NotAuthorizedError
            ? { email: error.email, reason: error.message }
            : {
                email: '',
                reason:
                  error instanceof Error ? error.message : 'Your account could not be verified.',
              },
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider])

  // Reference data is reloaded when the session changes (a different role may
  // see a different slice) and whenever administration changes it.
  React.useEffect(() => {
    if (!session) {
      setReference(null)
      return
    }
    let cancelled = false
    void (async () => {
      const data = await provider.getReferenceData()
      if (!cancelled) setReference(data)
    })()
    return () => {
      cancelled = true
    }
  }, [provider, session, revision])

  React.useEffect(() => {
    return provider.subscribe((_event: ChangeEvent) => bump())
  }, [provider, bump])

  /*
   * Web push identity follows the Supabase session.
   *
   * On sign-in and on a restored session the device is associated with the
   * signed-in OpeniWatch user; on sign-out it is detached. Without this a
   * shared phone would keep delivering one operator's alerts after a different
   * one had taken it over.
   *
   * `syncIdentity` is a no-op on a device that has never enrolled, so an
   * operator who has not asked for push never causes a request to OneSignal.
   * Failures are swallowed: push identity is not worth blocking sign-in over,
   * and the interface reports the registration state on its own screen.
   */
  React.useEffect(() => {
    if (!session) return
    void pushClient.syncIdentity(session.userId).catch(() => {})
  }, [session])

  const signIn = React.useCallback(
    async (email: string, password?: string) => {
      const next = await provider.signIn({ email, password })
      setSession(next)
      bump()
    },
    [provider, bump],
  )

  const signOut = React.useCallback(async () => {
    // Detach the device before the session goes, so no window exists in which
    // this browser is still addressable as the outgoing operator.
    await pushClient.clearIdentity().catch(() => {})
    await provider.signOut()
    setSession(null)
    setAuthorization(null)
    bump()
  }, [provider, bump])

  const value = React.useMemo<DataContextValue>(
    () => ({
      provider,
      session,
      authorization,
      reference,
      revision,
      loading,
      signIn,
      signOut,
      refresh: bump,
    }),
    [provider, session, authorization, reference, revision, loading, signIn, signOut, bump],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataContextValue {
  const context = React.useContext(DataContext)
  if (!context) throw new Error('useData must be used inside DataProviderContext')
  return context
}

/**
 * Loads data from the provider and refetches whenever the provider signals a
 * change. Returns the previous value while refetching so the interface does
 * not blank out mid-incident.
 */
export function useProviderQuery<T>(
  load: (provider: DataProvider) => Promise<T>,
  deps: React.DependencyList,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const { provider, revision } = useData()
  const [data, setData] = React.useState<T | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [localRevision, setLocalRevision] = React.useState(0)

  const loadRef = React.useRef(load)
  loadRef.current = load

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const result = await loadRef.current(provider)
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, revision, localRevision, ...deps])

  const reload = React.useCallback(() => setLocalRevision((r) => r + 1), [])
  return { data, loading, error, reload }
}
