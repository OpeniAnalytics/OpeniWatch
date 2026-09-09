import * as React from 'react'
import { Loader2, Mail, Shield } from 'lucide-react'
import { ROLE_LABELS } from '@/domain/enums'
import { Button, Card, Input, Label } from '@/components/ui/primitives'
import { useData } from '@/app/DataContext'
import { getSupabaseClient } from '@/data/supabase/client'
import { requestMagicLink, startMicrosoftSignIn } from '@/services/auth/authClient'

/**
 * Sign-in.
 *
 * Microsoft Entra ID is the primary route; an emailed magic link is the
 * fallback. There is no password field, no "create account", and no way to
 * self-register — OpeniWatch accounts are provisioned by an administrator, and
 * the screen says so rather than leaving someone to discover it by failing.
 *
 * In local demo mode there is no authentication server at all, so the seeded
 * roles are offered as one-click choices and the screen says that too.
 */

/** Microsoft's four-square mark. Inline so no third-party asset is fetched. */
function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="size-5 shrink-0" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}

function ProductIdentity() {
  return (
    <div className="mb-6 flex items-center gap-3">
      <div className="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Shield className="size-6" />
      </div>
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">OpeniWatch</h1>
        <p className="text-[15px] leading-snug text-readable-muted">
          Location-based threat detection, validation, alerting and reporting.
        </p>
      </div>
    </div>
  )
}

export function SignInPage() {
  const { provider, signIn } = useData()
  const [email, setEmail] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'microsoft' | 'link' | 'demo' | null>(null)

  const isDemo = provider.mode === 'local-demo'
  const demoAccounts = provider.listSignInOptions()

  /**
   * Where to return after authenticating.
   *
   * Read from the URL so a deep link to an alert survives sign-in. It is
   * sanitized by `safeNext` inside the auth client before it reaches any
   * redirect, so a hostile value cannot turn this screen into an open redirect.
   */
  const next = new URLSearchParams(window.location.search).get('next')

  async function continueWithMicrosoft() {
    setBusy('microsoft')
    setError(null)
    setNotice(null)
    try {
      const result = await startMicrosoftSignIn(
        getSupabaseClient().auth,
        window.location.origin,
        next,
      )
      // On success the browser is navigating to Microsoft; leave the button
      // disabled rather than flashing it back to idle mid-redirect.
      if (!result.ok) {
        setError(result.message)
        setBusy(null)
      }
    } catch {
      setError('Microsoft sign-in is unavailable right now. Try an email sign-in link instead.')
      setBusy(null)
    }
  }

  async function emailSignInLink(event: React.FormEvent) {
    event.preventDefault()
    setBusy('link')
    setError(null)
    setNotice(null)
    try {
      const result = await requestMagicLink(
        getSupabaseClient().auth,
        window.location.origin,
        email,
        next,
      )
      if (result.ok) setNotice(result.message)
      else setError(result.message)
    } catch {
      // Even a transport failure gets the generic answer, so a network error
      // cannot be used to distinguish a known address from an unknown one.
      setNotice(
        'If that address belongs to an authorized OpeniWatch account, a sign-in link is on its way.',
      )
    } finally {
      setBusy(null)
    }
  }

  async function chooseDemoRole(address: string) {
    setBusy('demo')
    setError(null)
    try {
      await signIn(address)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <ProductIdentity />

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[15px] text-destructive"
          >
            {error}
          </div>
        )}

        {isDemo ? (
          <Card className="p-4">
            <h2 className="text-[17px] font-semibold">Choose a role</h2>
            <p className="mb-4 mt-1 text-[15px] leading-relaxed text-readable-muted">
              This build is running in local demo mode against seeded pilot data. There is no
              authentication server, so Microsoft and email sign-in are unavailable — pick the role
              you want to demonstrate. Each role has genuinely different permissions.
            </p>
            <ul className="space-y-2">
              {demoAccounts.map((account) => (
                <li key={account.email}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void chooseDemoRole(account.email)}
                    className="touch-target w-full rounded-md border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent disabled:opacity-60"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[16px] font-medium">{account.fullName}</span>
                      <span className="text-[13px] font-medium text-primary">
                        {ROLE_LABELS[account.role]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[15px] text-readable-muted">{account.purpose}</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card className="p-4 sm:p-5">
            <h2 className="text-[17px] font-semibold">Sign in</h2>

            <Button
              className="touch-target mt-4 w-full text-[17px]"
              disabled={busy !== null}
              onClick={() => void continueWithMicrosoft()}
            >
              {busy === 'microsoft' ? (
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              ) : (
                <MicrosoftLogo />
              )}
              Continue with Microsoft
            </Button>

            <div className="my-5 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[13px] font-medium uppercase tracking-wide text-readable-muted">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {notice ? (
              /*
               * The same confirmation regardless of whether the address exists,
               * is authorized, or is unknown. Differentiating here would turn
               * this form into a directory of who works here.
               */
              <div
                role="status"
                className="rounded-md border border-primary/40 bg-primary/5 p-3 text-[15px] leading-relaxed"
              >
                <p className="font-medium">Check your email</p>
                <p className="mt-1 text-readable-muted">{notice}</p>
                <Button
                  variant="ghost"
                  className="touch-target mt-2 px-0 text-[15px]"
                  onClick={() => {
                    setNotice(null)
                    setEmail('')
                  }}
                >
                  Use a different address
                </Button>
              </div>
            ) : (
              <form className="space-y-3" onSubmit={(e) => void emailSignInLink(e)}>
                <div className="space-y-1">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    required
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  className="touch-target w-full text-[17px]"
                  disabled={busy !== null}
                >
                  {busy === 'link' ? (
                    <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Mail className="size-5" />
                  )}
                  Email me a sign-in link
                </Button>
              </form>
            )}

            <p className="mt-5 border-t pt-4 text-[15px] leading-relaxed text-readable-muted">
              <span className="font-medium text-foreground">Access is restricted.</span> OpeniWatch
              accounts are created by an administrator. There is no self-registration, and signing
              in with a valid company account does not by itself grant access to any monitored
              location.
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
