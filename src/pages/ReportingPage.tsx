import * as React from 'react'
import { Download } from 'lucide-react'
import { SEVERITY_LABELS } from '@/domain/enums'
import { cn, formatDuration } from '@/lib/utils'
import { dayRange, formatDate, weekRange } from '@/lib/datetime'
import { Button, Card, EmptyState } from '@/components/ui/primitives'
import { SeverityBadge } from '@/components/alerts/badges'
import { PageHeader } from '@/components/layout/AppShell'
import { useProviderQuery } from '@/app/DataContext'
import { alertsToCsv, downloadCsv, summaryToCsv } from '@/services/reporting/export'
import type { ReportSummary } from '@/data/provider'

/**
 * Reporting.
 *
 * Daily and weekly summaries computed from the database. Distribution bars are
 * plain proportional bars rather than charts: with seven locations and four
 * severities, a chart library would add weight without adding information.
 */

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular mt-1.5 text-2xl font-semibold leading-none">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

function DistributionBar({
  rows,
  total,
}: {
  rows: Array<{ key: string; label: React.ReactNode; count: number }>
  total: number
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No alerts in this period.</p>
  }
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-3">
          <div className="w-40 shrink-0 truncate text-sm">{row.label}</div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: total > 0 ? `${(row.count / total) * 100}%` : '0%' }}
            />
          </div>
          <span className="tabular w-8 shrink-0 text-right text-sm font-medium">{row.count}</span>
        </li>
      ))}
    </ul>
  )
}

function ReportView({ report }: { report: ReportSummary }) {
  const totalAlerts = report.alertsValidated

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {formatDate(report.range.from)} – {formatDate(report.range.to)}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCsv(
                `openiwatch-summary-${report.range.label.toLowerCase().replace(/\s+/g, '-')}.csv`,
                summaryToCsv(report),
              )
            }
          >
            <Download className="size-3.5" />
            Export summary CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={report.items.length === 0}
            onClick={() =>
              downloadCsv(
                `openiwatch-alerts-${report.range.label.toLowerCase().replace(/\s+/g, '-')}.csv`,
                alertsToCsv(report),
              )
            }
          >
            <Download className="size-3.5" />
            Export alerts CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Signals collected"
          value={String(report.signalsCollected)}
          hint="Raw items ingested in this period"
        />
        <Metric
          label="Candidate alerts"
          value={String(report.candidatesGenerated)}
          hint="Signals raised for analyst review"
        />
        <Metric
          label="Alerts validated"
          value={String(report.alertsValidated)}
          hint="Candidates approved for distribution"
        />
        <Metric
          label="False positive rate"
          value={`${report.falsePositiveRate.toFixed(1)}%`}
          hint="Rejected candidates plus false-positive dispositions, over all decided candidates"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric
          label="Avg validation time"
          value={formatDuration(report.averageValidationSeconds)}
          hint="Detection to validation"
        />
        <Metric
          label="Avg notification time"
          value={formatDuration(report.averageNotificationSeconds)}
          hint="Validation to first delivery"
        />
        <Metric
          label="Avg acknowledgment"
          value={formatDuration(report.averageAcknowledgmentSeconds)}
          hint="First delivery to acknowledgment"
        />
        <Metric label="Open incidents" value={String(report.openIncidents)} hint="Not yet resolved" />
        <Metric
          label="Escalated incidents"
          value={String(report.escalatedIncidents)}
          hint="Escalated at least once"
        />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <h2 className="mb-3 font-semibold">Alerts by severity</h2>
          <DistributionBar
            total={totalAlerts}
            rows={report.alertsBySeverity.map((row) => ({
              key: row.severity,
              label: <SeverityBadge severity={row.severity} />,
              count: row.count,
            }))}
          />
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-semibold">Alerts by location</h2>
          <DistributionBar
            total={totalAlerts}
            rows={report.alertsByLocation.map((row) => ({
              key: row.locationId,
              label: row.locationName,
              count: row.count,
            }))}
          />
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-semibold">Alerts by threat category</h2>
          <DistributionBar
            total={totalAlerts}
            rows={report.alertsByCategory.map((row) => ({
              key: row.categoryKey,
              label: row.label,
              count: row.count,
            }))}
          />
        </Card>
      </div>

      <Card className="mt-4">
        <h2 className="p-4 pb-3 font-semibold">Report items</h2>
        {report.items.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No alerts were validated in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-y bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Validated</th>
                  <th className="px-4 py-2 font-medium">Severity</th>
                  <th className="px-4 py-2 font-medium">Location</th>
                  <th className="px-4 py-2 font-medium">Category</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Disposition</th>
                  <th className="px-4 py-2 text-right font-medium">Ack time</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.items.map((item) => (
                  <tr key={item.alert.id}>
                    <td className="tabular whitespace-nowrap px-4 py-2">
                      {formatDate(item.alert.validatedAt, item.location.timeZone)}
                    </td>
                    <td className="px-4 py-2">{SEVERITY_LABELS[item.alert.severity]}</td>
                    <td className="px-4 py-2">{item.location.officialName}</td>
                    <td className="px-4 py-2">{item.category?.label ?? item.alert.categoryKey}</td>
                    <td className="px-4 py-2">{item.alert.status}</td>
                    <td className="px-4 py-2">{item.alert.disposition ?? '—'}</td>
                    <td className="tabular px-4 py-2 text-right">
                      {item.acknowledgments[0]
                        ? formatDuration(item.acknowledgments[0].responseSeconds)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

export function ReportingPage() {
  const [period, setPeriod] = React.useState<'daily' | 'weekly'>('daily')

  const range = React.useMemo(() => {
    const bounds = period === 'daily' ? dayRange() : weekRange()
    return { ...bounds, label: period === 'daily' ? 'Daily' : 'Weekly' }
  }, [period])

  const { data: report, loading } = useProviderQuery((p) => p.getReport(range), [
    range.from,
    range.to,
  ])

  return (
    <div>
      <PageHeader
        title="Reporting"
        description="Operational summaries computed from collected signals, validated alerts and SOC activity."
        actions={
          <div className="flex rounded-md border p-0.5">
            {(['daily', 'weekly'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setPeriod(value)}
                className={cn(
                  'rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                  period === value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {value}
              </button>
            ))}
          </div>
        }
      />

      {loading && !report ? (
        <p className="text-sm text-muted-foreground">Building report…</p>
      ) : report ? (
        <ReportView report={report} />
      ) : (
        <EmptyState title="No report available" description="Report data could not be loaded." />
      )}
    </div>
  )
}
