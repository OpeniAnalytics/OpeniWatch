import * as React from 'react'
import { Shield } from 'lucide-react'
import { ROLE_LABELS } from '@/domain/enums'
import { Button, Card, Input, Label } from '@/components/ui/primitives'
import { useData } from '@/app/DataContext'

/**
 * Sign-in.
 *
 * In Supabase mode this is a normal email and password form. In local demo
 * mode there is no authentication server, so the seeded roles are offered as
 * one-click choices — and the screen says so, rather than presenting a
 * password box that would do nothing.
 */
export function SignInPage() {
  const { provider, signIn } = useData()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const demoAccounts = provider.listSignInOptions()
  const isDemo = provider.mode === 'local-demo'

  async function submit(nextEmail: string, nextPassword?: string) {
    setBusy(true)
    setError(null)
    try {
      await signIn(nextEmail, nextPassword)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Shield className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">OpeniWatch</h1>
            <p className="text-sm text-readable-muted">
              Location-based threat detection, validation, alerting and reporting.
            </p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {isDemo ? (
          <Card className="p-4">
            <h2 className="font-medium">Choose a role</h2>
            <p className="mb-4 mt-1 text-sm text-readable-muted">
              No Supabase credentials are configured, so OpeniWatch is running in local demo mode
              with the seeded pilot data. There is no authentication server and no password — pick
              the role you want to demonstrate. Each role has genuinely different permissions.
            </p>
            <ul className="space-y-2">
              {demoAccounts.map((account) => (
                <li key={account.email}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => submit(account.email)}
                    className="w-full rounded-md border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent disabled:opacity-60"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{account.fullName}</span>
                      <span className="text-[13px] font-medium text-primary">
                        {ROLE_LABELS[account.role]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[13px] text-readable-muted">{account.purpose}</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card className="p-4">
            <h2 className="mb-4 font-medium">Sign in</h2>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void submit(email, password)
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  )
}
