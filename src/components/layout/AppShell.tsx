import * as React from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Activity,
  Bell,
  ChevronDown,
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
import { env, simulatorEnabled } from '@/lib/env'
import { ROLE_LABELS } from '@/domain/enums'
import { Badge, Button } from '@/components/ui/primitives'
import { useData, useProviderQuery } from '@/app/DataContext'
import { useTheme } from '@/app/ThemeContext'
import { canValidate } from '@/data/workflow'
import { MobileNavDrawer } from './MobileNavDrawer'
import { InstallPrompt, UpdateNotice } from './InstallPrompt'

/**
 * Listens for a waiting service worker announced by `src/main.tsx`.
 *
 * Kept as a hook so the shell does not import the registration module directly:
 * a build with no service worker support simply never fires the event.
 */
function useUpdateReady(): (() => void) | null {
  const [activate, setActivate] = React.useState<(() => void) | null>(null)
  React.useEffect(() => {
    function onReady(event: Event) {
      const detail = (event as CustomEvent<{ activate: () => void }>).detail
      if (detail?.activate) setActivate(() => detail.activate)
    }
    window.addEventListener('openiwatch:update-ready', onReady)
    return () => window.removeEventListener('openiwatch:update-ready', onReady)
  }, [])
  return activate
}

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

/**
 * Environment badge.
 *
 * A staging deployment must never be mistaken for production, but a permanent
 * full-width warning strip is the wrong instrument: it costs a line of vertical
 * space on every screen and, being always present, stops being read within a
 * shift. This is a compact badge that sits in the header, where the operator
 * already looks, and it appears only when there is a label to show.
 *
 * Full-width banners are now reserved for something actionable — the outbound
 * notification kill switch, and demo mode.
 */
function EnvironmentBadge() {
  const label = env.environmentLabel.trim()
  if (!label) return null
  return (
    <span
      className="hidden shrink-0 rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[13px] font-semibold uppercase tracking-wide text-primary sm:inline-block"
      title={`${label} environment — not production. Data here may be reset at any time.`}
    >
      {label}
    </span>
  )
}

/**
 * Demo-mode indicator.
 *
 * Genuine demo mode still has to be unmistakable — but it previously spent
 * three lines of a phone screen saying so. One line, with the detail available
 * on demand.
 */
function ModeBanner({ mode }: { mode: 'supabase' | 'local-demo' }) {
  const [expanded, setExpanded] = React.useState(false)
  if (mode === 'supabase') return null

  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-center gap-2 px-4 py-2 text-[15px] font-medium"
      >
        <span>Demo mode · Browser-local data · Notifications simulated</span>
        <ChevronDown
          className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <p className="mx-auto max-w-prose px-4 pb-3 text-[15px] leading-relaxed">
          No Supabase project is connected. Everything you see is seeded pilot data held in this
          browser only — no colleague sees it, and it disappears when this browser's storage is
          cleared. Notification deliveries beyond in-app are recorded as simulated and no provider
          is contacted.
        </p>
      )}
    </div>
  )
}

/** Shown whenever an administrator has stopped outbound notifications. */
function KillSwitchBanner() {
  const { provider, revision } = useData()
  const [disabled, setDisabled] = React.useState<{ reason: string | null } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const settings = await provider.getSystemSettings()
        if (!cancelled) {
          setDisabled(
            settings.outboundNotificationsEnabled
              ? null
              : { reason: settings.outboundDisabledReason },
          )
        }
      } catch {
        // Settings are advisory for the banner; a failure must not block the app.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider, revision])

  if (!disabled) return null
  return (
    <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-center text-[13px] font-medium text-destructive">
      Outbound notifications are switched off{disabled.reason ? `: ${disabled.reason}` : '.'} In-app
      alerts continue; web push and SMS are not being attempted.
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
  const menuButtonRef = React.useRef<HTMLButtonElement>(null)
  const activateUpdate = useUpdateReady()

  const closeMobileNav = React.useCallback(() => setMobileOpen(false), [])

  // Close the mobile drawer on navigation so the next screen is fully visible.
  React.useEffect(() => setMobileOpen(false), [location.pathname])

  const items = NAV_ITEMS.filter((item) => {
    // The simulator writes signals, so it needs the deployment flag, a
    // non-production environment, and a role permitted to submit. The route
    // enforces the same rule, so typing the URL gets the same answer.
    if (item.requiresSimulator) {
      if (!simulatorEnabled) return false
      if (session && !canValidate(session.role)) return false
    }
    if (item.requiresValidation && session && !canValidate(session.role)) return false
    return true
  })

  /** `compact` is the desktop rail; touch targets are larger in the drawer. */
  const navList = (compact: boolean) => (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md font-medium transition-colors',
              compact ? 'px-3 py-2 text-[15px]' : 'touch-target px-3 py-3 text-[17px]',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-readable-muted hover:bg-accent hover:text-foreground',
            )
          }
        >
          <item.icon className={cn('shrink-0', compact ? 'size-4' : 'size-5')} />
          {item.label}
        </NavLink>
      ))}
    </nav>
  )

  const currentLabel = items.find((i) => i.to === location.pathname)?.label ?? 'OpeniWatch'

  return (
    <div className="min-h-dvh bg-background">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      <div className="flex">
        {/* Desktop / tablet rail. Unchanged in structure — the desktop
            experience is deliberately preserved. */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-card md:flex">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Shield className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold leading-tight">OpeniWatch</p>
              <p className="truncate text-[13px] text-readable-muted">
                {reference?.programs[0]?.name ?? 'Loading…'}
              </p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2">{navList(true)}</div>

          {session && (
            <div className="border-t p-3">
              <p className="truncate text-[15px] font-medium">{session.fullName}</p>
              <p className="mb-2 truncate text-[13px] text-readable-muted">
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
          {/*
            Persistent header.

            `sticky top-0` against the page rather than `fixed`, so it never
            overlaps content and never needs a spacer element. It stays put
            while Safari's chrome collapses and expands, because a sticky
            element is positioned by the scroll container, not the visual
            viewport — which is what made a fixed header jump.

            z-30 keeps it above cards; the drawer above it uses z-40/z-50.
          */}
          <header className="pad-safe-top sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
            <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
              <Button
                variant="ghost"
                size="icon"
                className="touch-target min-w-11 md:hidden"
                onClick={() => setMobileOpen(true)}
                aria-expanded={mobileOpen}
                aria-controls="mobile-navigation"
                aria-label="Open navigation"
                ref={menuButtonRef}
              >
                <Menu className="size-5" />
              </Button>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[17px] font-semibold md:text-[15px]">{currentLabel}</p>
              </div>

              <EnvironmentBadge />
              {reference && (
                <Badge variant="outline" className="hidden lg:inline-flex">
                  {reference.organization.name}
                </Badge>
              )}
              <NotificationBell />
              <Button
                variant="ghost"
                size="icon"
                className="touch-target min-w-11"
                onClick={toggle}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
              </Button>
            </div>
          </header>

          {/* Banners sit below the header so they scroll away, rather than
              permanently costing a line of a phone screen. Only genuinely
              actionable states appear here. */}
          <ModeBanner mode={provider.mode} />
          <KillSwitchBanner />

          <MobileNavDrawer
            open={mobileOpen}
            onClose={closeMobileNav}
            title="OpeniWatch"
            restoreFocusTo={menuButtonRef}
            // Sign out lives in a pinned footer rather than at the end of the
            // scrolling list, so it is reachable without scrolling past every
            // destination — and stays clear of the home indicator.
            footer={
              session ? (
                <>
                  <p className="truncate px-1 text-[15px] font-medium">{session.fullName}</p>
                  <p className="mb-2 truncate px-1 text-[13px] text-readable-muted">
                    {ROLE_LABELS[session.role]}
                  </p>
                  <Button
                    variant="outline"
                    className="touch-target w-full justify-start text-[17px]"
                    onClick={signOut}
                  >
                    <LogOut className="size-5" />
                    Sign out
                  </Button>
                </>
              ) : null
            }
          >
            <div id="mobile-navigation">
              {reference && (
                <p className="px-3 pb-3 text-[15px] text-readable-muted">
                  {reference.organization.name}
                </p>
              )}
              {navList(false)}
            </div>
          </MobileNavDrawer>

          <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">
            {children}
            <InstallPrompt />
          </main>

          {activateUpdate && <UpdateNotice onActivate={activateUpdate} />}
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
      <div className="min-w-0">
        {/* ~30px on a phone, settling to the denser desktop scale where the
            surrounding chrome already establishes hierarchy. */}
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight md:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-[15px] leading-relaxed text-readable-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
