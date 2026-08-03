import { Link } from 'react-router-dom'
import { AlertTriangle, ClipboardCheck, Clock, Siren } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import { formatRelative } from '@/lib/datetime'
import { Card, EmptyState } from '@/components/ui/primitives'
import { PageHeader } from '@/components/layout/AppShell'
import { AlertCard } from '@/components/alerts/AlertCard'
import { useData, useProviderQuery } from '@/app/DataContext'
import { canValidate } from '@/data/workflow'

/**
 * Operations Overview.
 *
 * Answers the four questions a SOC lead asks on shift handover: what is
 * critical, what has nobody looked at, what is waiting on an analyst, and how
 * fast are we moving. Every figure is computed from records — there are no
 * placeholder metrics.
 */

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  to,
}: {
  label: string
  value: string | number
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  tone?: 'default' | 'critical' | 'warning'
  to?: string
}) {
  const toneClasses = {
    default: 'text-foreground',
    critical: 'text-[hsl(var(--severity-critical))]',
    warning: 'text-[hsl(var(--severity-high))]',
  }[tone]

  /*
   * Padding is trimmed on the narrowest phones before any type size is, because
   * a smaller number is harder to read and a tighter card is not. The label
   * runs above the value on mobile so neither has to wrap mid-phrase.
   */
  const body = (
    <Card className="h-full p-3.5 transition-colors hover:border-primary/40 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-semibold uppercase leading-tight tracking-wide text-readable-muted">
          {label}
        </p>
        <Icon className={cn('size-5 shrink-0', toneClasses)} />
      </div>
      <p className={cn('tabular mt-2 text-4xl font-semibold leading-none sm:text-3xl', toneClasses)}>
        {value}
      </p>
      {hint && <p className="mt-2 text-[15px] leading-snug text-readable-muted">{hint}</p>}
    </Card>
  )

  return to ? (
    // The whole card is the target, and it clears 44px comfortably.
    <Link to={to} className="block rounded-lg focus-visible:ring-2">
      {body}
    </Link>
  ) : (
    body
  )
}

/** Section heading. Large enough to structure a phone screen, not a label. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-[19px] font-semibold tracking-tight sm:text-lg">{children}</h2>
}

export function OverviewPage() {
  const { reference, session } = useData()
  const { data: summary, loading } = useProviderQuery((p) => p.getOperationsSummary(), [])

  // The backlog figure is useful to everyone, but only roles that can work the
  // queue get a link to it — otherwise the tile would offer a destination the
  // navigation deliberately hides.
  const mayOpenQueue = session ? canValidate(session.role) : false

  const profilesById = new Map((reference?.profiles ?? []).map((p) => [p.userId, p]))

  if (loading && !summary) {
    return <p className="text-readable-muted">Loading operations overview…</p>
  }
  if (!summary) return null

  const monitored = summary.activeByLocation.filter((row) => row.location.isActive).length

  return (
    <div>
      <PageHeader
        title="Operations overview"
        description={`${monitored} monitored locations · ${reference?.assignments.length ?? 0} operational assignments`}
      />

      {/*
        One column below 380px. Two 44px-tall numbers side by side on a 320px
        screen forces "Unacknowledged" to wrap to three lines and the value to
        shrink; a single column keeps both legible. `min-w-0` stops grid items
        from refusing to shrink, which is what produced horizontal overflow.
      */}
      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Open critical"
          value={summary.openCritical}
          icon={Siren}
          tone={summary.openCritical > 0 ? 'critical' : 'default'}
          hint="Active alerts at critical severity"
          to="/alerts?severity=critical"
        />
        <StatTile
          label="Open high"
          value={summary.openHigh}
          icon={AlertTriangle}
          tone={summary.openHigh > 0 ? 'warning' : 'default'}
          hint="Active alerts at high severity"
          to="/alerts?severity=high"
        />
        <StatTile
          label="Unacknowledged"
          value={summary.unacknowledged}
          icon={Clock}
          tone={summary.unacknowledged > 0 ? 'critical' : 'default'}
          hint="Active alerts nobody has acknowledged"
          to="/alerts?ack=unacknowledged"
        />
        <StatTile
          label="Awaiting review"
          value={summary.awaitingReview}
          icon={ClipboardCheck}
          hint="Candidate alerts awaiting analyst review"
          {...(mayOpenQueue ? { to: '/queue' } : {})}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <SectionTitle>Live validated alerts</SectionTitle>
          {summary.liveFeed.length === 0 ? (
            <EmptyState
              title="No active alerts"
              description="Every validated alert has been resolved or closed. New alerts appear here the moment an analyst validates them."
            />
          ) : (
            <div className="space-y-3">
              {summary.liveFeed.map((context) => (
                <AlertCard
                  key={context.alert.id}
                  context={context}
                  assigneeName={
                    context.alert.assignedTo
                      ? profilesById.get(context.alert.assignedTo)?.fullName
                      : null
                  }
                  acknowledgerName={
                    context.alert.acknowledgedBy
                      ? profilesById.get(context.alert.acknowledgedBy)?.fullName
                      : null
                  }
                />
              ))}
            </div>
          )}
        </section>

        <div className="space-y-5">
          <section>
            <SectionTitle>Detection to alert</SectionTitle>
            <Card className="p-4">
              <p className="tabular text-3xl font-semibold sm:text-2xl">
                {formatDuration(summary.medianDetectionToAlertSeconds)}
              </p>
              <p className="mt-1.5 text-[15px] leading-relaxed text-readable-muted">
                Median time from source publication to analyst validation, across every alert on
                record.
              </p>
            </Card>
          </section>

          <section>
            <SectionTitle>Alerts by monitored location</SectionTitle>
            <Card>
              <ul className="divide-y">
                {summary.activeByLocation.map((row) => (
                  <li
                    key={row.location.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[17px] font-medium sm:text-[15px]">
                        {row.location.officialName}
                      </p>
                      <p className="truncate text-[15px] text-readable-muted">
                        {row.location.city}, {row.location.state}
                        {!row.location.isActive && ' · monitoring disabled'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className={cn(
                          'tabular text-[17px] font-semibold sm:text-[15px]',
                          row.active > 0 && 'text-[hsl(var(--severity-high))]',
                        )}
                      >
                        {row.active}
                      </p>
                      <p className="tabular text-[15px] text-readable-muted">{row.total} total</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </section>

          <section>
            <SectionTitle>Recent operational activity</SectionTitle>
            <Card>
              {summary.recentActivity.length === 0 ? (
                <p className="p-4 text-[15px] text-readable-muted">No activity recorded yet.</p>
              ) : (
                <ul className="divide-y">
                  {summary.recentActivity.map((event) => (
                    <li key={event.id} className="px-4 py-3">
                      <p className="text-[17px] sm:text-[15px]">
                        <span className="font-medium">
                          {event.actorUserId
                            ? (profilesById.get(event.actorUserId)?.fullName ?? 'Unknown user')
                            : 'System'}
                        </span>{' '}
                        <span className="text-readable-muted">
                          {event.action.replace(/[._]/g, ' ')}
                        </span>
                      </p>
                      <p className="text-[15px] text-readable-muted">
                        {formatRelative(event.occurredAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </div>
      </div>
    </div>
  )
}
