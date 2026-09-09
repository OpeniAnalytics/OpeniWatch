import { LogOut, ShieldX } from 'lucide-react'
import { Button } from '@/components/ui/primitives'

/**
 * Authenticated, but not authorized.
 *
 * Reached when someone proves who they are — a valid Microsoft account in a
 * correctly configured Entra tenant, or a real OpeniWatch magic link — but has
 * no active OpeniWatch profile and organization membership.
 *
 * This is the screen that keeps authentication from becoming authorization. A
 * whole Entra tenant can authenticate here; none of them get anything until an
 * administrator provisions them. The screen deliberately:
 *
 *   - loads no operational data, and is rendered instead of the application
 *     shell rather than inside it;
 *   - does not create the missing membership. Self-provisioning on first
 *     sign-in would mean anyone in the tenant could grant themselves access by
 *     visiting the site;
 *   - offers sign-out, so a shared machine is not left holding a session
 *     nobody can use;
 *   - names no organization, program, location or colleague. The person
 *     reading it is, so far as OpeniWatch is concerned, a stranger.
 */
export function NotAuthorizedPage({
  email,
  reason,
  onSignOut,
}: {
  email: string
  reason?: string
  onSignOut: () => void
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <main
        className="w-full max-w-md rounded-lg border bg-card p-6"
        aria-labelledby="not-authorized-title"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <ShieldX className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 id="not-authorized-title" className="text-[22px] font-semibold tracking-tight">
              Access not authorized
            </h1>
            <p className="mt-2 text-[16px] leading-relaxed text-readable-muted">
              You signed in successfully, but this account has not been granted access to
              OpeniWatch.
            </p>
          </div>
        </div>

        {email && (
          <p className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-[15px]">
            Signed in as <span className="font-medium">{email}</span>
          </p>
        )}

        <p className="mt-4 text-[15px] leading-relaxed text-readable-muted">
          OpeniWatch access is granted by an administrator, one account at a time. Signing in with a
          valid company account does not grant it on its own. Ask your OpeniWatch administrator to
          authorize this address{reason ? ` — ${reason}` : '.'}
        </p>

        <Button
          variant="outline"
          className="touch-target mt-6 w-full text-[17px]"
          onClick={onSignOut}
        >
          <LogOut className="size-5" />
          Sign out
        </Button>
      </main>
    </div>
  )
}
