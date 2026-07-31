import { Link } from 'react-router-dom'
import { AlertTriangle, ClipboardCheck, Clock, Siren } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import { formatRelative } from '@/lib/datetime'
import { Card, EmptyState } from '@/components/ui/primitives'
import { PageHeader } from '@/components/layout/AppShell'
import { AlertCard } from '@/components/alerts/AlertCard'
import { useData, useProviderQuery } from '@/app/DataContext'

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

  const body = (
    <Card className="h-full p-4 transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <Icon className={cn('size-4 shrink-0', toneClasses)} />
      </div>
      <p className={cn('tabular mt-2 text-3xl font-semibold leading-none', toneClasses)}>{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  )

  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  )
}

export function OverviewPage() {
  const { reference } = useData()
  const { data: summary, loading } = useProviderQuery((p) => p.getOperationsSummary(), [])

  const profilesById = new Map((reference?.profiles ?? []).map((p) => [p.userId, p]))

  if (loading && !summary) {
    return <p className="text-sm text-muted-foreground">Loading operations overview…</p>
  }
  if (!summary) return null

  const monitored = summary.activeByLocation.filter((row) => row.location.isActive).length

  return (
    <div>
      <PageHeader
        title="Operations overview"
        description={`${monitored} monitored locations · ${reference?.assignments.length ?? 0} operational assignments`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          hint="Candidate alerts in the analyst queue"
          to="/queue"
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Live validated alerts
          </h2>
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
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Detection to alert
            </h2>
            <Card className="p-4">
              <p className="tabular text-2xl font-semibold">
                {formatDuration(summary.medianDetectionToAlertSeconds)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Median time from source publication to analyst validation, across every alert on
                record.
              </p>
            </Card>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Alerts by monitored location
            </h2>
            <Card>
              <ul className="divide-y">
                {summary.activeByLocation.map((row) => (
                  <li
                    key={row.location.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{row.location.officialName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {row.location.city}, {row.location.state}
                        {!row.location.isActive && ' · monitoring disabled'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className={cn(
                          'tabular text-sm font-semibold',
                          row.active > 0 && 'text-[hsl(var(--severity-high))]',
                        )}
                      >
                        {row.active}
                      </p>
                      <p className="tabular text-xs text-muted-foreground">{row.total} total</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Recent operational activity
            </h2>
            <Card>
              {summary.recentActivity.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No activity recorded yet.</p>
              ) : (
                <ul className="divide-y">
                  {summary.recentActivity.map((event) => (
                    <li key={event.id} className="px-4 py-2.5">
                      <p className="text-sm">
                        <span className="font-medium">
                          {event.actorUserId
                            ? (profilesById.get(event.actorUserId)?.fullName ?? 'Unknown user')
                            : 'System'}
                        </span>{' '}
                        <span className="text-muted-foreground">
                          {event.action.replace(/[._]/g, ' ')}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
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
