import {
  ALERT_STATUS_LABELS,
  AUTHOR_LOCATION_STATUS_LABELS,
  CANDIDATE_STATUS_LABELS,
  DISPOSITION_LABELS,
  SEVERITY_LABELS,
  type AlertStatus,
  type AssessmentSource,
  type AuthorLocationStatus,
  type CandidateStatus,
  type Disposition,
  type Severity,
} from '@/domain/enums'
import { cn, formatPercent } from '@/lib/utils'
import { Badge } from '@/components/ui/primitives'

/**
 * Status and assessment badges.
 *
 * Severity uses colour plus the word itself — colour alone would fail for
 * anyone with a colour vision deficiency, and this is a safety-critical
 * hierarchy.
 */

const SEVERITY_CLASSES: Record<Severity, string> = {
  critical: 'bg-[hsl(var(--severity-critical))]/12 text-[hsl(var(--severity-critical))] border-[hsl(var(--severity-critical))]/30',
  high: 'bg-[hsl(var(--severity-high))]/12 text-[hsl(var(--severity-high))] border-[hsl(var(--severity-high))]/30',
  moderate: 'bg-[hsl(var(--severity-moderate))]/12 text-[hsl(var(--severity-moderate))] border-[hsl(var(--severity-moderate))]/30',
  informational: 'bg-[hsl(var(--severity-informational))]/12 text-[hsl(var(--severity-informational))] border-[hsl(var(--severity-informational))]/30',
}

export function SeverityBadge({
  severity,
  className,
  size = 'default',
}: {
  severity: Severity
  className?: string
  size?: 'default' | 'lg'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border font-semibold uppercase tracking-wide',
        size === 'lg' ? 'px-2.5 py-1 text-sm' : 'px-2 py-0.5 text-xs',
        SEVERITY_CLASSES[severity],
        className,
      )}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  )
}

export function severityRailClass(severity: Severity): string {
  return `severity-rail-${severity}`
}

const ALERT_STATUS_VARIANT: Record<AlertStatus, 'default' | 'secondary' | 'muted' | 'warning' | 'danger' | 'success'> = {
  open: 'danger',
  acknowledged: 'default',
  assigned: 'default',
  escalated: 'warning',
  monitoring: 'secondary',
  resolved: 'success',
  closed: 'muted',
}

export function AlertStatusBadge({ status }: { status: AlertStatus }) {
  return <Badge variant={ALERT_STATUS_VARIANT[status]}>{ALERT_STATUS_LABELS[status]}</Badge>
}

const CANDIDATE_STATUS_VARIANT: Record<
  CandidateStatus,
  'default' | 'secondary' | 'muted' | 'warning' | 'danger' | 'success'
> = {
  pending_review: 'warning',
  under_review: 'default',
  validated: 'success',
  rejected: 'muted',
  duplicate: 'muted',
  suppressed: 'muted',
}

export function CandidateStatusBadge({ status }: { status: CandidateStatus }) {
  return <Badge variant={CANDIDATE_STATUS_VARIANT[status]}>{CANDIDATE_STATUS_LABELS[status]}</Badge>
}

export function DispositionBadge({ disposition }: { disposition: Disposition }) {
  const variant =
    disposition === 'confirmed'
      ? 'danger'
      : disposition === 'false_positive' || disposition === 'non_operational'
        ? 'muted'
        : 'secondary'
  return <Badge variant={variant}>{DISPOSITION_LABELS[disposition]}</Badge>
}

/**
 * Incident-location confidence.
 *
 * Always shown as a number with its label so it is never mistaken for a
 * certainty. The evidence behind it is one click away in the alert detail.
 */
export function LocationConfidence({
  confidence,
  className,
}: {
  confidence: number
  className?: string
}) {
  const tone =
    confidence >= 80
      ? 'text-emerald-700 dark:text-emerald-300'
      : confidence >= 50
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-muted-foreground'

  return (
    <span className={cn('tabular text-sm font-medium', tone, className)}>
      {formatPercent(confidence)}
    </span>
  )
}

/**
 * Author current location.
 *
 * Rendered separately from incident location and from the profile location so
 * the three facts are never conflated. `unknown` is the normal, expected state
 * and is styled neutrally rather than as a warning.
 */
export function AuthorLocationBadge({ status }: { status: AuthorLocationStatus }) {
  return (
    <Badge variant={status === 'unknown' ? 'muted' : 'secondary'}>
      {AUTHOR_LOCATION_STATUS_LABELS[status]}
    </Badge>
  )
}

/** Labels who produced an assessment: automated, analyst, or SOC. */
export function AssessmentSourceBadge({ source }: { source: AssessmentSource }) {
  const labels: Record<AssessmentSource, string> = {
    automated: 'Automated',
    analyst: 'Analyst',
    soc: 'SOC',
  }
  return (
    <Badge variant={source === 'automated' ? 'muted' : 'outline'} className="uppercase">
      {labels[source]}
    </Badge>
  )
}

/** Marks content that was simulated rather than collected. */
export function SimulatedBadge({ label = 'Simulated' }: { label?: string }) {
  return (
    <Badge variant="warning" title="This record was produced by the development simulator or a simulated delivery.">
      {label}
    </Badge>
  )
}
