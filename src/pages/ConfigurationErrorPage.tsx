import { AlertOctagon, ShieldAlert } from 'lucide-react'
import type { Configuration } from '@/lib/env'

/**
 * Blocking configuration screen.
 *
 * Rendered instead of the application when required browser configuration is
 * missing. Nothing behind it is constructed: no data provider, no seeded
 * records, no session, no navigation. An operator must not be shown a working
 * dashboard backed by browser-local data when the real backend is unreachable —
 * they would acknowledge alerts that no colleague can see and believe a
 * location was being watched when it was not.
 *
 * What this screen may show: the NAMES of variables that are absent or
 * unusable, and a reference code. What it must never show: any value, any
 * fragment of a value, its length, or an encoding of it. Anyone can reach this
 * screen — it renders before authentication.
 */
export function ConfigurationErrorPage({ configuration }: { configuration: Configuration }) {
  if (configuration.status !== 'blocked') return null

  const { env, missing, invalid, reference } = configuration
  const label = env.environmentLabel || 'This deployment'

  return (
    <div className="flex min-h-dvh items-start justify-center bg-background px-4 py-10 sm:items-center">
      <main
        className="w-full max-w-xl rounded-lg border border-destructive/40 bg-card p-6 shadow-sm sm:p-8"
        aria-labelledby="configuration-error-title"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <AlertOctagon className="size-5" />
          </span>
          <div className="min-w-0">
            <h1
              id="configuration-error-title"
              className="text-2xl font-semibold leading-tight tracking-tight"
            >
              OpeniWatch is not configured
            </h1>
            <p className="mt-1 text-base leading-relaxed text-muted-foreground">
              {label} cannot reach its backend, so it will not start.
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-md border border-border bg-muted/40 p-4">
          <p className="text-base leading-relaxed">
            OpeniWatch has deliberately refused to fall back to browser-local demo data. Showing an
            operational dashboard here would look normal while being backed by nothing — alerts
            would appear acknowledged to you and to nobody else.
          </p>
        </div>

        {missing.length > 0 && (
          <section className="mt-6" aria-labelledby="missing-heading">
            <h2 id="missing-heading" className="text-lg font-semibold">
              Missing configuration
            </h2>
            <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">
              These build-time variables were not set:
            </p>
            <ul className="mt-2 space-y-1.5">
              {missing.map((name) => (
                <li
                  key={name}
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-[15px]"
                >
                  {name}
                </li>
              ))}
            </ul>
          </section>
        )}

        {invalid.length > 0 && (
          <section className="mt-6" aria-labelledby="invalid-heading">
            <h2 id="invalid-heading" className="text-lg font-semibold">
              Unusable configuration
            </h2>
            <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">
              These variables were set but could not be used. The value is not shown here.
            </p>
            <ul className="mt-2 space-y-1.5">
              {invalid.map((name) => (
                <li
                  key={name}
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-[15px]"
                >
                  {name}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-6" aria-labelledby="admin-heading">
          <h2 id="admin-heading" className="text-lg font-semibold">
            For the administrator
          </h2>
          <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">
            These are <strong className="font-semibold text-foreground">build-time</strong>{' '}
            variables. Setting them in the hosting dashboard is not enough on its own — the site
            must be rebuilt and redeployed afterwards, because their values are compiled into the
            JavaScript bundle rather than read when the page loads.
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
            Every name must keep its <code className="font-mono">VITE_</code> prefix. A variable
            without it is invisible to the browser build by design, and no server-side secret —
            service-role key, REST API key, ingestion secret — may ever be given one.
          </p>
          <p className="mt-3 text-[15px] leading-relaxed">
            Reference code:{' '}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono font-semibold">
              {reference}
            </span>
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Safe to quote or screenshot. It encodes which variable names are absent and nothing
            else.
          </p>
        </section>

        <p className="mt-6 flex items-start gap-2 border-t pt-4 text-sm leading-relaxed text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Full setup instructions are in <code className="font-mono">docs/DEPLOYMENT.md</code>.
          </span>
        </p>
      </main>
    </div>
  )
}
