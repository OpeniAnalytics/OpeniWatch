import { DISPOSITION_LABELS } from '@/domain/enums'
import type { ReportSummary } from '@/data/provider'
import { formatDuration, secondsBetween } from '@/lib/utils'

/**
 * Report export.
 *
 * CSV is implemented. PDF and executive-report generation are prepared for but
 * deliberately not built in Phase 1 — `generatePdfReport` throws a clear error
 * rather than existing as a button that silently does nothing.
 */

/** RFC 4180 escaping. Also neutralises spreadsheet formula injection. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  // A leading =, +, - or @ makes Excel and Sheets evaluate the cell. Source
  // text is attacker-controlled, so prefix it to force a literal string.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/["\n,]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}

/** One row per alert, with the operational timings a client report needs. */
export function alertsToCsv(report: ReportSummary): string {
  const header = [
    'Alert ID',
    'Validated at',
    'Severity',
    'Status',
    'Threat category',
    'Location',
    'Warehouse number',
    'City',
    'State',
    'Operational assignment',
    'Title',
    'Source platform',
    'Public author handle',
    'Source URL',
    'Published at',
    'Detected at',
    'Incident-location confidence (%)',
    'Author current location',
    'Priority score',
    'First notified at',
    'Acknowledged at',
    'Detection to validation',
    'Validation to notification',
    'Notification to acknowledgment',
    'Escalated',
    'Resolved at',
    'Closed at',
    'Final disposition',
    'Disposition notes',
  ]

  const rows = report.items.map((item) => {
    const { alert, signal, author, location, assignment, category } = item
    return [
      alert.id,
      alert.validatedAt,
      alert.severity,
      alert.status,
      category?.label ?? alert.categoryKey,
      location.officialName,
      location.facilityNumber,
      location.city,
      location.state,
      assignment?.name ?? '',
      alert.title,
      signal?.sourcePlatform ?? '',
      author?.handle ?? '',
      signal?.sourceUrl ?? '',
      alert.publishedAt,
      alert.detectedAt,
      alert.incidentLocation.confidence,
      alert.authorLocation.status,
      alert.priorityScore,
      alert.firstNotifiedAt ?? '',
      alert.acknowledgedAt ?? '',
      formatDuration(secondsBetween(alert.detectedAt, alert.validatedAt)),
      formatDuration(secondsBetween(alert.validatedAt, alert.firstNotifiedAt)),
      formatDuration(secondsBetween(alert.firstNotifiedAt ?? alert.validatedAt, alert.acknowledgedAt)),
      alert.escalatedAt ? 'yes' : 'no',
      alert.resolvedAt ?? '',
      alert.closedAt ?? '',
      alert.disposition ? DISPOSITION_LABELS[alert.disposition] : '',
      alert.dispositionNotes ?? '',
    ]
  })

  return toCsv([header, ...rows])
}

/** The headline figures, as a two-column CSV. */
export function summaryToCsv(report: ReportSummary): string {
  const rows: unknown[][] = [
    ['Metric', 'Value'],
    ['Report period', report.range.label],
    ['From', report.range.from],
    ['To', report.range.to],
    ['Signals collected', report.signalsCollected],
    ['Candidate alerts generated', report.candidatesGenerated],
    ['Alerts validated', report.alertsValidated],
    ['False positive rate (%)', report.falsePositiveRate.toFixed(1)],
    ['Average validation time', formatDuration(report.averageValidationSeconds)],
    ['Average notification time', formatDuration(report.averageNotificationSeconds)],
    ['Average acknowledgment time', formatDuration(report.averageAcknowledgmentSeconds)],
    ['Open incidents', report.openIncidents],
    ['Escalated incidents', report.escalatedIncidents],
    [],
    ['Alerts by severity', ''],
    ...report.alertsBySeverity.map((row) => [row.severity, row.count]),
    [],
    ['Alerts by location', ''],
    ...report.alertsByLocation.map((row) => [row.locationName, row.count]),
    [],
    ['Alerts by threat category', ''],
    ...report.alertsByCategory.map((row) => [row.label, row.count]),
  ]
  return toCsv(rows)
}

/** Triggers a browser download without leaving the page. */
export function downloadCsv(filename: string, contents: string): void {
  // A UTF-8 BOM makes Excel open the file with the right encoding. Written as
  // an escape so the byte is visible in review rather than an invisible glyph.
  const blob = new Blob(['\uFEFF', contents], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * PDF and executive report generation — NOT IMPLEMENTED in Phase 1.
 *
 * The service layer is shaped for it: `ReportSummary` already carries every
 * figure and every alert a formatted report would need, so adding a renderer
 * means writing the renderer, not reworking the data. This throws rather than
 * returning an empty document so a caller can never ship a blank report.
 */
export function generatePdfReport(_report: ReportSummary): never {
  throw new Error(
    'PDF report generation is not implemented in Phase 1. Use CSV export, or see docs/ARCHITECTURE.md for the planned renderer.',
  )
}
