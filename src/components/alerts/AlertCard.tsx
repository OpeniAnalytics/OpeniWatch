import * as React from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, ChevronDown, Clock, ExternalLink, MapPin, User } from 'lucide-react'
import type { AlertWithContext } from '@/domain/types'
import { cn, excerpt, isSafeExternalUrl } from '@/lib/utils'
import { formatRelative, formatTime } from '@/lib/datetime'
import { Badge } from '@/components/ui/primitives'
import {
  AlertStatusBadge,
  AuthorLocationBadge,
  LocationConfidence,
  SeverityBadge,
  SimulatedBadge,
  severityRailClass,
} from './badges'

/**
 * Alert card for the SOC feed.
 *
 * Ordered for how the card is actually read on a phone, which is top to bottom
 * under time pressure: severity and status, then where, then what kind of
 * threat, then what was said, then when, then whether anyone has it.
 *
 * Everything an operator needs in order to decide whether to open the alert is
 * in the first screenful. Provenance, author detail and location-assessment
 * internals are real and unaltered, but they are evidence for a decision
 * already taken, so they sit behind a disclosure rather than pushing the
 * acknowledgment state below the fold.
 *
 * Nothing here is inferred — every value is a field on the record.
 */
export function AlertCard({
  context,
  assigneeName,
  acknowledgerName,
}: {
  context: AlertWithContext
  assigneeName?: string | null
  acknowledgerName?: string | null
}) {
  const { alert, signal, author, location, assignment, category } = context
  const tz = location.timeZone
  const [detailsOpen, setDetailsOpen] = React.useState(false)

  return (
    <article
      className={cn(
        'rounded-lg border bg-card p-4 transition-colors hover:border-primary/40',
        severityRailClass(alert.severity),
      )}
    >
      {/* 1-2. Severity and status lead, and stay on one row on a 320px screen. */}
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={alert.severity} />
        <AlertStatusBadge status={alert.status} />
        {signal?.collectionMethod === 'simulator' && <SimulatedBadge />}
      </div>

      {/* 5. The alert statement. Never truncated — the threat is the point. */}
      <h3 className="mt-3 text-[19px] font-semibold leading-snug sm:text-[17px]">
        <Link to={`/alerts/${alert.id}`} className="hover:underline">
          {alert.title}
        </Link>
      </h3>

      {/* 3-4. Where, and what kind. */}
      <p className="mt-2 flex items-start gap-1.5 text-[17px] leading-snug sm:text-[15px]">
        <MapPin className="mt-0.5 size-4 shrink-0 text-readable-muted" aria-hidden="true" />
        <span>
          {location.officialName} — {location.city}, {location.state}
        </span>
      </p>
      {category && (
        <div className="mt-2">
          <Badge variant="outline" className="text-[13px]">
            {category.label}
          </Badge>
        </div>
      )}

      {/* The source text itself. Selectable, and long enough to carry the
          actual statement rather than a fragment of it. */}
      {signal && (
        <blockquote className="mt-3 select-text border-l-2 border-border pl-3 text-[16px] leading-relaxed text-foreground/90">
          {excerpt(signal.originalText, 260)}
        </blockquote>
      )}

      {/* 6. Times. One column on a narrow phone: a two-column grid at 320px
          wraps "Published" onto two lines and puts the value under the wrong
          label. */}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 min-[400px]:grid-cols-2 sm:grid-cols-3">
        <div className="flex items-baseline justify-between gap-2 min-[400px]:block">
          <dt className="text-[15px] text-readable-muted">Published</dt>
          <dd className="tabular text-[15px] font-medium">{formatTime(alert.publishedAt, tz)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 min-[400px]:block">
          <dt className="text-[15px] text-readable-muted">Detected</dt>
          <dd className="tabular text-[15px] font-medium">{formatTime(alert.detectedAt, tz)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 min-[400px]:block">
          <dt className="text-[15px] text-readable-muted">Validated</dt>
          <dd className="tabular text-[15px] font-medium">{formatTime(alert.validatedAt, tz)}</dd>
        </div>
      </dl>

      {/*
        7. Acknowledgment state.

        Unacknowledged is carried by an icon, the word, a weight change and a
        border — not by colour alone. An operator with a colour vision
        deficiency, or looking at a phone in direct sunlight, must not have to
        distinguish red text from green text to know whether anyone has this.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3">
        {alert.acknowledgedAt ? (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-[15px] font-medium text-emerald-800 dark:text-emerald-200">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            Acknowledged {formatRelative(alert.acknowledgedAt)}
            {acknowledgerName ? ` by ${acknowledgerName}` : ''}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[15px] font-semibold text-destructive">
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            Unacknowledged
          </span>
        )}
        {assigneeName && (
          <span className="text-[15px] text-readable-muted">Assigned to {assigneeName}</span>
        )}
        <span className="tabular ml-auto text-[15px] text-readable-muted">
          Priority {alert.priorityScore}/100
        </span>
      </div>

      {/* Progressive disclosure: provenance and assessment detail. */}
      <button
        type="button"
        onClick={() => setDetailsOpen((open) => !open)}
        aria-expanded={detailsOpen}
        className="touch-target mt-2 flex w-full items-center justify-between gap-2 rounded-md text-[15px] font-medium text-readable-muted hover:text-foreground"
      >
        <span>{detailsOpen ? 'Hide source and assessment' : 'Source and assessment'}</span>
        <ChevronDown
          className={cn('size-4 shrink-0 transition-transform', detailsOpen && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {detailsOpen && (
        <div className="mt-1 space-y-2.5 border-t pt-3">
          <p className="flex flex-wrap items-center gap-1.5 text-[15px]">
            <User className="size-4 shrink-0 text-readable-muted" aria-hidden="true" />
            {author ? (
              <>
                <span className="font-medium">{author.handle}</span>
                {author.displayName && (
                  <span className="text-readable-muted">({author.displayName})</span>
                )}
              </>
            ) : (
              <span className="text-readable-muted">No public author recorded</span>
            )}
          </p>

          <p className="text-[15px] text-readable-muted">
            Source: <span className="text-foreground">{signal?.sourcePlatform ?? 'Unknown'}</span>
          </p>

          {assignment && (
            <p className="text-[15px] text-readable-muted">
              Assignment: <span className="text-foreground">{assignment.name}</span>
            </p>
          )}

          <p className="flex flex-wrap items-center gap-1.5 text-[15px] text-readable-muted">
            Incident location:
            <LocationConfidence confidence={alert.incidentLocation.confidence} />
          </p>

          <p className="flex flex-wrap items-center gap-1.5 text-[15px] text-readable-muted">
            Author location:
            <AuthorLocationBadge status={alert.authorLocation.status} />
          </p>

          <p className="flex items-center gap-1.5 text-[15px] text-readable-muted">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            Analyst validated
          </p>

          {isSafeExternalUrl(signal?.sourceUrl) && (
            <a
              href={signal.sourceUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="touch-target inline-flex items-center gap-1.5 rounded-md text-[16px] font-medium text-primary hover:underline"
            >
              <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
              Open the original source
            </a>
          )}
        </div>
      )}
    </article>
  )
}
