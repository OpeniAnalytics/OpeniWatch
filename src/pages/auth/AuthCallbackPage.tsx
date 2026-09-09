import * as React from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { getSupabaseClient } from '@/data/supabase/client'
import {
  cleanAuthParamsFromUrl,
  completeMagicLink,
  completeOAuthCallback,
  type CompletionResult,
} from '@/services/auth/authClient'

/**
 * Completion screen for both authentication routes.
 *
 * `/auth/callback` receives the operator back from Microsoft; `/auth/confirm`
 * receives them from an emailed magic link. The two differ only in which
 * credential shape they expect, so they share this component.
 *
 * Three things have to be true here and are easy to get wrong:
 *
 * 1. **The credential is exchanged exactly once.** The Supabase client has
 *    `detectSessionInUrl: false` so it does not race this page, and the
 *    exchange is guarded against React's double effect invocation by a ref
 *    plus a module-level record of consumed credentials.
 * 2. **The URL is cleaned afterwards, on success and on failure.** A code left
 *    in the address bar reaches browser history, the next screenshot, and any
 *    Referer sent to a third party.
 * 3. **Nothing operational renders.** This screen runs before the session has
 *    been resolved into an OpeniWatch identity, so it shows a spinner or an
 *    error and nothing else.
 */
export function AuthCallbackPage({ mode }: { mode: 'oauth' | 'magic-link' }) {
  const [result, setResult] = React.useState<CompletionResult | null>(null)
  // React runs effects twice in development. A single-use credential does not
  // survive that, so the work is claimed synchronously before any await.
  const started = React.useRef(false)

  React.useEffect(() => {
    if (started.current) return
    started.current = true

    void (async () => {
      const href = window.location.href
      let outcome: CompletionResult
      try {
        const auth = getSupabaseClient().auth
        outcome =
          mode === 'oauth'
            ? await completeOAuthCallback(auth, href)
            : await completeMagicLink(auth, href)
      } catch (error) {
        outcome = {
          status: 'error',
          message:
            error instanceof Error && error.message
              ? 'Sign-in could not be completed. Request a new link and try again.'
              : 'Sign-in could not be completed.',
        }
      }

      /*
       * Clean the URL before doing anything else with the outcome, so the
       * credential is gone from the address bar and from history whether the
       * exchange succeeded or failed.
       */
      try {
        window.history.replaceState({}, '', cleanAuthParamsFromUrl(href))
      } catch {
        // A replaceState failure must not strand the operator on this screen.
      }

      if (outcome.status === 'success') {
        /*
         * A full navigation rather than a client-side route change.
         *
         * The application reads the session once, when it mounts. Reloading is
         * the simplest correct way to have every provider, the data context and
         * the OneSignal identity association pick up the new session, and it
         * leaves no partially-authenticated render in between.
         */
        window.location.replace(outcome.next)
        return
      }
      setResult(outcome)
    })()
  }, [mode])

  // Narrowed: the success branch navigates away above and never renders.
  if (!result || result.status === 'success') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <p className="flex items-center gap-3 text-[17px] text-readable-muted" role="status">
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          Completing sign-in…
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <main
        className="w-full max-w-md rounded-lg border bg-card p-6"
        aria-labelledby="auth-error-title"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <ShieldAlert className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 id="auth-error-title" className="text-[22px] font-semibold tracking-tight">
              Sign-in could not be completed
            </h1>
            <p role="alert" className="mt-2 text-[16px] leading-relaxed text-readable-muted">
              {result.message}
            </p>
          </div>
        </div>

        <Button
          className="touch-target mt-6 w-full text-[17px]"
          onClick={() => window.location.replace('/')}
        >
          Back to sign-in
        </Button>
      </main>
    </div>
  )
}
