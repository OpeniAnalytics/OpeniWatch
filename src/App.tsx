import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { DataProviderContext, useData } from '@/app/DataContext'
import { ThemeProvider } from '@/app/ThemeContext'
import { AppShell } from '@/components/layout/AppShell'
import { SignInPage } from '@/pages/SignInPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { ConfigurationErrorPage } from '@/pages/ConfigurationErrorPage'
import { canValidate } from '@/data/workflow'
import { configuration, env, simulatorEnabled } from '@/lib/env'

/**
 * Routing.
 *
 * Everything behind the shell requires a session. Route-level gating is a
 * convenience, not a security boundary — Row Level Security in PostgreSQL is
 * what actually prevents unauthorized access, and every route below is
 * reachable by typing its URL. The screens themselves therefore also check the
 * signed-in role before offering an action.
 *
 * The Operations Overview is bundled eagerly because it is the landing screen.
 * Every other route is code-split, so an operator who only ever acknowledges
 * alerts never downloads the reporting or administration code.
 */

const AnalystQueuePage = lazy(() =>
  import('@/pages/AnalystQueuePage').then((m) => ({ default: m.AnalystQueuePage })),
)
const AlertFeedPage = lazy(() =>
  import('@/pages/AlertFeedPage').then((m) => ({ default: m.AlertFeedPage })),
)
const AlertDetailPage = lazy(() =>
  import('@/pages/AlertDetailPage').then((m) => ({ default: m.AlertDetailPage })),
)
const LocationsPage = lazy(() =>
  import('@/pages/LocationsPage').then((m) => ({ default: m.LocationsPage })),
)
const ReportingPage = lazy(() =>
  import('@/pages/ReportingPage').then((m) => ({ default: m.ReportingPage })),
)
const AdminPage = lazy(() => import('@/pages/AdminPage').then((m) => ({ default: m.AdminPage })))
const NotificationsPage = lazy(() =>
  import('@/pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
)
const SimulatorPage = lazy(() =>
  import('@/pages/SimulatorPage').then((m) => ({ default: m.SimulatorPage })),
)

function RouteFallback() {
  return (
    <p className="text-sm text-readable-muted" role="status">
      Loading…
    </p>
  )
}

/**
 * Refuses a route the signed-in role may not use, whether it was reached from
 * navigation or by typing the URL. The message says which role is required, so
 * an operator understands rather than assuming a bug.
 */
function RequireRole({
  allowed,
  children,
  requirement,
}: {
  allowed: boolean
  children: React.ReactNode
  requirement: string
}) {
  const { session } = useData()
  if (allowed) return <>{children}</>
  return (
    <div className="rounded-lg border border-dashed p-6">
      <p className="font-medium">This screen is not available to your role</p>
      <p className="mt-1 max-w-prose text-sm text-readable-muted">
        {requirement} You are signed in as {session?.role.replace(/_/g, ' ')}. The database enforces
        the same restriction, so nothing here is hidden that you could otherwise reach.
      </p>
    </div>
  )
}

function AuthenticatedRoutes() {
  const { session, loading } = useData()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-readable-muted">Loading OpeniWatch…</p>
      </div>
    )
  }

  if (!session) return <SignInPage />

  const mayValidate = canValidate(session.role)
  // The simulator writes signals. Three conditions, all required: never in
  // production, the deployment flag must be on, and the role must be permitted
  // to submit. Demo mode grants none of these by itself.
  const maySimulate = simulatorEnabled && mayValidate

  return (
    <AppShell>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route
            path="/queue"
            element={
              <RequireRole
                allowed={mayValidate}
                requirement="The analyst queue is limited to analysts and program administrators."
              >
                <AnalystQueuePage />
              </RequireRole>
            }
          />
          <Route path="/alerts" element={<AlertFeedPage />} />
          <Route path="/alerts/:alertId" element={<AlertDetailPage />} />
          <Route path="/locations" element={<LocationsPage />} />
          <Route path="/reporting" element={<ReportingPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route
            path="/simulator"
            element={
              <RequireRole
                allowed={maySimulate}
                requirement={
                  !simulatorEnabled && env.deployment === 'production'
                    ? 'The signal simulator is permanently unavailable in production.'
                    : simulatorEnabled
                      ? 'The simulator writes signals, so it is limited to analysts and program administrators.'
                      : 'The signal simulator is disabled in this deployment (VITE_ENABLE_SIMULATOR is not "true").'
                }
              >
                <SimulatorPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  )
}

export default function App() {
  // Checked before anything else mounts. `DataProviderContext` constructs the
  // data provider on first render, so a blocked configuration has to short
  // circuit above it — otherwise the browser-local demo provider would be
  // built, seeded and running before any screen could refuse to show it.
  if (configuration.status === 'blocked') {
    return (
      <ThemeProvider>
        <ConfigurationErrorPage configuration={configuration} />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <DataProviderContext>
        <BrowserRouter>
          <AuthenticatedRoutes />
        </BrowserRouter>
      </DataProviderContext>
    </ThemeProvider>
  )
}
