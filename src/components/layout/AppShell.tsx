import * as React from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Activity,
  Bell,
  ClipboardCheck,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Moon,
  Settings,
  Shield,
  Siren,
  Sun,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { env } from '@/lib/env'
import { ROLE_LABELS } from '@/domain/enums'
import { Badge, Button } from '@/components/ui/primitives'
import { useData, useProviderQuery } from '@/app/DataContext'
import { useTheme } from '@/app/ThemeContext'
import { canValidate } from '@/data/workflow'

/**
 * Application shell.
 *
 * A persistent left rail on desktop and tablet, collapsing to a slide-over on
 * mobile. Navigation is kept short: an operator under pressure should not have
 * to choose between fourteen destinations.
 */

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** Hidden for roles that cannot use the screen at all. */
  requiresValidation?: boolean
  requiresSimulator?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Operations', icon: LayoutDashboard },
  { to: '/queue', label: 'Analyst queue', icon: ClipboardCheck, requiresValidation: true },
  { to: '/alerts', label: 'Alert feed', icon: Siren },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/reporting', label: 'Reporting', icon: Activity },
  { to: '/admin', label: 'Administration', icon: Settings },
  { to: '/simulator', label: 'Simulator', icon: FlaskConical, requiresSimulator: true },
]

function ModeBanner({ mode }: { mode: 'supabase' | 'local-demo' }) {
  if (mode === 'supabase') return null
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-center text-xs text-amber-900 dark:text-amber-200">
      <strong className="font-semibold">Local demo mode.</strong> No Supabase credentials are
      configured, so data is stored in this browser and notification deliveries beyond in-app are
      simulated.
    </div>
  )
}

function NotificationBell() {
  const { data } = useProviderQuery((p) => p.listMyNotifications(), [])
  const unread = (data ?? []).filter((d) => d.readAt === null).length

  return (
    <NavLink
      to="/notifications"
      className="relative inline-flex size-9 items-center justify-center rounded-md hover:bg-accent"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      <Bell className="size-4" />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex min-w-[1.1rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </NavLink>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, reference, provider, signOut } = useData()
  const { theme, toggle } = useTheme()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = React.useState(false)

  // Close the mobile drawer on navigation so the next screen is fully visible.
  React.useEffect(() => setMobileOpen(false), [location.pathname])

  const items = NAV_ITEMS.filter((item) => {
    if (item.requiresSimulator && !env.enableSimulator) return false
    if (item.requiresValidation && session && !canValidate(session.role)) return false
    return true
  })

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )
          }
        >
          <item.icon className="size-4 shrink-0" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="min-h-screen bg-background">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <ModeBanner mode={provider.mode} />

      <div className="flex">
        {/* Desktop / tablet rail */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card md:flex">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Shield className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">OpeniWatch</p>
              <p className="truncate text-xs text-muted-foreground">
                {reference?.programs[0]?.name ?? 'Loading…'}
              </p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2">{nav}</div>

          {session && (
            <div className="border-t p-3">
              <p className="truncate text-sm font-medium">{session.fullName}</p>
              <p className="mb-2 truncate text-xs text-muted-foreground">
                {ROLE_LABELS[session.role]}
              </p>
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={signOut}>
                <LogOut className="size-4" />
                Sign out
              </Button>
            </div>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen((open) => !open)}
              aria-expanded={mobileOpen}
              aria-label="Toggle navigation"
            >
              <Menu className="size-4" />
            </Button>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {items.find((i) => i.to === location.pathname)?.label ?? 'OpeniWatch'}
              </p>
            </div>

            {reference && (
              <Badge variant="outline" className="hidden sm:inline-flex">
                {reference.organization.name}
              </Badge>
            )}
            <NotificationBell />
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </header>

          {mobileOpen && (
            <div className="border-b bg-card p-3 md:hidden">
              {nav}
              {session && (
                <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={signOut}>
                  <LogOut className="size-4" />
                  Sign out — {session.fullName}
                </Button>
              )}
            </div>
          )}

          <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}

/** Page header used by every screen for a consistent reading rhythm. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
