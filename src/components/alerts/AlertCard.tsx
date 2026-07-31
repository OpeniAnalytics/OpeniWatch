import { Link } from 'react-router-dom'
import { CheckCircle2, Clock, ExternalLink, MapPin, User } from 'lucide-react'
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
 * Dense by design: an operator scanning the feed needs severity, location,
 * assignment, category, timing, source, author, an excerpt, both location
 * assessments, validation state and acknowledgment state without opening
 * anything. Everything here is a fact from the record — nothing is inferred.
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

  return (
    <article
      className={cn(
        'rounded-lg border bg-card p-4 transition-colors hover:border-primary/40',
        severityRailClass(alert.severity),
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={alert.severity} />
          <AlertStatusBadge status={alert.status} />
          {category && <Badge variant="outline">{category.label}</Badge>}
          {signal?.collectionMethod === 'simulator' && <SimulatedBadge />}
        </div>
        <span className="tabular text-xs text-muted-foreground">
          Priority {alert.priorityScore}/100
        </span>
      </div>

      <h3 className="mt-2.5 font-semibold leading-snug">
        <Link to={`/alerts/${alert.id}`} className="hover:underline">
          {alert.title}
        </Link>
      </h3>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3.5" />
          {location.officialName} — {location.city}, {location.state}
        </span>
        {assignment && <span className="text-xs">Assignment: {assignment.name}</span>}
      </div>

      {signal && (
        <blockquote className="mt-3 border-l-2 border-border pl-3 text-sm text-foreground/85">
          {excerpt(signal.originalText, 220)}
        </blockquote>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Published</dt>
          <dd className="tabular">{formatTime(alert.publishedAt, tz)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Detected</dt>
          <dd className="tabular">{formatTime(alert.detectedAt, tz)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Validated</dt>
          <dd className="tabular">{formatTime(alert.validatedAt, tz)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Incident location</dt>
          <dd>
            <LocationConfidence confidence={alert.incidentLocation.confidence} />
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3 text-xs">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <User className="size-3.5" />
          {author ? (
            <>
              <span className="font-medium text-foreground">{author.handle}</span>
              {author.displayName && <span>({author.displayName})</span>}
            </>
          ) : (
            'No public author recorded'
          )}
        </span>

        <span className="text-muted-foreground">
          Source: {signal?.sourcePlatform ?? 'Unknown'}
        </span>

        {isSafeExternalUrl(signal?.sourceUrl) && (
          <a
            href={signal.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="size-3" />
            Open source
          </a>
        )}

        <span className="inline-flex items-center gap-1 text-muted-foreground">
          Author location:
          <AuthorLocationBadge status={alert.authorLocation.status} />
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="size-3.5" />
          Analyst validated
        </span>
        {alert.acknowledgedAt ? (
          <span className="text-emerald-700 dark:text-emerald-300">
            Acknowledged {formatRelative(alert.acknowledgedAt)}
            {acknowledgerName ? ` by ${acknowledgerName}` : ''}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-destructive">
            <Clock className="size-3.5" />
            Unacknowledged
          </span>
        )}
        {assigneeName && <span>Assigned to {assigneeName}</span>}
      </div>
    </article>
  )
}
