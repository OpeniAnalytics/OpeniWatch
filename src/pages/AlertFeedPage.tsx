import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ALERT_STATUSES,
  ALERT_STATUS_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  type AlertStatus,
  type Severity,
} from '@/domain/enums'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, Card, EmptyState, Input, Label, Select } from '@/components/ui/primitives'
import { AlertCard } from '@/components/alerts/AlertCard'
import { PageHeader } from '@/components/layout/AppShell'
import { useData, useProviderQuery } from '@/app/DataContext'

/**
 * Alert Feed.
 *
 * Validated operational alerts with live updates. Filters are held in the URL
 * so a SOC lead can send someone a link to exactly what they are looking at.
 */
export function AlertFeedPage() {
  const { reference } = useData()
  const [params, setParams] = useSearchParams()
  // Collapsed by default on phones; the `sm:block` above keeps it open on
  // anything larger regardless of this value.
  const [filtersOpen, setFiltersOpen] = React.useState(false)

  const severity = (params.get('severity') ?? '') as Severity | ''
  const status = (params.get('status') ?? '') as AlertStatus | ''
  const locationId = params.get('location') ?? ''
  const categoryKey = params.get('category') ?? ''
  const acknowledgement = params.get('ack') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const [search, setSearch] = React.useState(params.get('q') ?? '')

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  // Debounce search so typing does not refetch on every keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => setParam('q', search), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const { data: alerts, loading } = useProviderQuery(
    (p) =>
      p.listAlerts({
        severities: severity ? [severity] : undefined,
        statuses: status ? [status] : undefined,
        locationIds: locationId ? [locationId] : undefined,
        categoryKeys: categoryKey ? [categoryKey] : undefined,
        acknowledgement:
          acknowledgement === 'acknowledged' || acknowledgement === 'unacknowledged'
            ? acknowledgement
            : undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
        search: params.get('q') ?? undefined,
      }),
    [severity, status, locationId, categoryKey, acknowledgement, from, to, params.get('q')],
  )

  const profilesById = new Map((reference?.profiles ?? []).map((p) => [p.userId, p]))
  const list = alerts ?? []
  const activeFilters = [
    severity,
    status,
    locationId,
    categoryKey,
    acknowledgement,
    from,
    to,
    search,
  ].filter(Boolean)
  const hasFilters = activeFilters.length > 0
  const activeFilterCount = activeFilters.length

  return (
    <div>
      <PageHeader
        title="Alert feed"
        description="Validated operational alerts. Updates arrive live as analysts validate and the SOC acts."
        actions={
          hasFilters ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch('')
                setParams(new URLSearchParams(), { replace: true })
              }}
            >
              Clear filters
            </Button>
          ) : undefined
        }
      />

      {/*
        Filters collapse on mobile.

        Seven controls ahead of the list meant an operator opening the feed on a
        phone saw a screen of dropdowns and no alerts at all — the one thing
        they came for was below the fold. They stay expanded from `sm` up, where
        the grid costs one or two rows and buries nothing.

        The toggle reports how many filters are active, so a collapsed panel can
        never hide the fact that the list is filtered.
      */}
      <div className="mb-3 sm:hidden">
        <Button
          variant="outline"
          className="touch-target w-full justify-between"
          aria-expanded={filtersOpen}
          aria-controls="alert-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal className="size-5" aria-hidden="true" />
            Filters
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-[13px] font-semibold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn('size-5 transition-transform', filtersOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </Button>
      </div>

      <Card id="alert-filters" className={cn('mb-4 p-3', !filtersOpen && 'hidden sm:block')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="f-severity">Severity</Label>
            <Select
              id="f-severity"
              value={severity}
              onChange={(e) => setParam('severity', e.target.value)}
            >
              <option value="">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="f-status">Status</Label>
            <Select id="f-status" value={status} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">All statuses</option>
              {ALERT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ALERT_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="f-location">Location</Label>
            <Select
              id="f-location"
              value={locationId}
              onChange={(e) => setParam('location', e.target.value)}
            >
              <option value="">All locations</option>
              {(reference?.locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.officialName} — {l.city}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="f-category">Threat category</Label>
            <Select
              id="f-category"
              value={categoryKey}
              onChange={(e) => setParam('category', e.target.value)}
            >
              <option value="">All categories</option>
              {(reference?.categories ?? []).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="f-ack">Acknowledgment</Label>
            <Select id="f-ack" value={acknowledgement} onChange={(e) => setParam('ack', e.target.value)}>
              <option value="">Any</option>
              <option value="unacknowledged">Unacknowledged</option>
              <option value="acknowledged">Acknowledged</option>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="f-from">Validated from</Label>
            <Input
              id="f-from"
              type="date"
              value={from}
              onChange={(e) => setParam('from', e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="f-to">Validated to</Label>
            <Input id="f-to" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="f-search">Search</Label>
            <Input
              id="f-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title, text, location or author"
            />
          </div>
        </div>
      </Card>

      <p className="mb-3 text-sm text-readable-muted" aria-live="polite">
        {loading && list.length === 0
          ? 'Loading alerts…'
          : `${list.length} alert${list.length === 1 ? '' : 's'}`}
      </p>

      {list.length === 0 && !loading ? (
        <EmptyState
          title="No alerts match these filters"
          description="Validated alerts appear here immediately. Adjust the filters, or validate a candidate from the analyst queue."
        />
      ) : (
        <div className="space-y-3">
          {list.map((context) => (
            <AlertCard
              key={context.alert.id}
              context={context}
              assigneeName={
                context.alert.assignedTo ? profilesById.get(context.alert.assignedTo)?.fullName : null
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
    </div>
  )
}
