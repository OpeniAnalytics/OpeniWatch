import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { DataProviderContext, useData } from '@/app/DataContext'
import { ThemeProvider } from '@/app/ThemeContext'
import { AppShell } from '@/components/layout/AppShell'
import { SignInPage } from '@/pages/SignInPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { AnalystQueuePage } from '@/pages/AnalystQueuePage'
import { AlertFeedPage } from '@/pages/AlertFeedPage'
import { AlertDetailPage } from '@/pages/AlertDetailPage'
import { LocationsPage } from '@/pages/LocationsPage'
import { ReportingPage } from '@/pages/ReportingPage'
import { AdminPage } from '@/pages/AdminPage'
import { SimulatorPage } from '@/pages/SimulatorPage'
import { NotificationsPage } from '@/pages/NotificationsPage'
import { env } from '@/lib/env'

/**
 * Routing.
 *
 * Everything behind the shell requires a session. Route-level gating is a
 * convenience, not a security boundary — Row Level Security in PostgreSQL is
 * what actually prevents unauthorized access.
 */
function AuthenticatedRoutes() {
  const { session, loading } = useData()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading OpeniWatch…</p>
      </div>
    )
  }

  if (!session) return <SignInPage />

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/queue" element={<AnalystQueuePage />} />
        <Route path="/alerts" element={<AlertFeedPage />} />
        <Route path="/alerts/:alertId" element={<AlertDetailPage />} />
        <Route path="/locations" element={<LocationsPage />} />
        <Route path="/reporting" element={<ReportingPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        {env.enableSimulator && <Route path="/simulator" element={<SimulatorPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

export default function App() {
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
