import * as React from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Info } from 'lucide-react'
import {
  ALERT_STATUSES,
  ALERT_STATUS_LABELS,
  DELIVERY_CHANNEL_LABELS,
  DELIVERY_STATUS_LABELS,
  DISPOSITIONS,
  DISPOSITION_LABELS,
  ESCALATION_LEVELS,
  ESCALATION_LEVEL_LABELS,
  LOCATION_MATCH_METHOD_LABELS,
  type AlertStatus,
  type Disposition,
  type EscalationLevel,
} from '@/domain/enums'
import type { AlertWithContext } from '@/domain/types'
import { env } from '@/lib/env'
import { formatDuration, isSafeExternalUrl, secondsBetween } from '@/lib/utils'
import { formatDateTime, formatRelative } from '@/lib/datetime'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Label,
  Select,
  Separator,
  Textarea,
} from '@/components/ui/primitives'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog'
import {
  AlertStatusBadge,
  AssessmentSourceBadge,
  AuthorLocationBadge,
  DispositionBadge,
  LocationConfidence,
  SeverityBadge,
  SimulatedBadge,
} from '@/components/alerts/badges'
import { useData, useProviderQuery } from '@/app/DataContext'
import { canOperate } from '@/data/workflow'

/**
 * Alert Detail.
 *
 * The complete operational record for one alert: evidence, both assessments,
 * location reasoning, related signals, notification history, acknowledgment
 * and escalation history, comments, disposition and the full audit trail.
 *
 * SOC actions live in a sticky action bar so acknowledge and escalate stay
 * reachable on a phone without scrolling back up.
 */

function SectionCard({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  )
}

function EscalateDialog({
  context,
  onDone,
}: {
  context: AlertWithContext
  onDone: (run: () => Promise<void>) => void
}) {
  const { provider } = useData()
  const [open, setOpen] = React.useState(false)
  const [level, setLevel] = React.useState<EscalationLevel>('client_regional')
  const [reason, setReason] = React.useState('')
  const [parties, setParties] = React.useState('')
  const [storeManager, setStoreManager] = React.useState(false)
  const [regionalManager, setRegionalManager] = React.useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          Escalate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Escalate alert</DialogTitle>
          <DialogDescription>
            Record who the SOC contacted. OpeniWatch does not contact a reported subject or
            emergency services automatically — this is a record of calls your team made.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="esc-level">Escalation level</Label>
            <Select
              id="esc-level"
              value={level}
              onChange={(e) => setLevel(e.target.value as EscalationLevel)}
            >
              {ESCALATION_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {ESCALATION_LEVEL_LABELS[l]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="esc-reason">Reason</Label>
            <Textarea
              id="esc-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this needs escalation."
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="esc-parties">Who was notified (comma separated)</Label>
            <Input
              id="esc-parties"
              value={parties}
              onChange={(e) => setParties(e.target.value)}
              placeholder="Regional manager, Store security"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={storeManager}
                onChange={(e) => setStoreManager(e.target.checked)}
              />
              Store manager notified
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={regionalManager}
                onChange={(e) => setRegionalManager(e.target.checked)}
              />
              Regional manager notified
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!reason.trim()}
            onClick={() => {
              onDone(async () => {
                await provider.escalateAlert(context.alert.id, {
                  level,
                  reason,
                  notifiedParties: parties
                    .split(',')
                    .map((p) => p.trim())
                    .filter(Boolean),
                  storeManagerNotified: storeManager,
                  regionalManagerNotified: regionalManager,
                })
                setOpen(false)
                setReason('')
                setParties('')
              })
            }}
          >
            Record escalation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DispositionDialog({
  context,
  onDone,
}: {
  context: AlertWithContext
  onDone: (run: () => Promise<void>) => void
}) {
  const { provider } = useData()
  const [open, setOpen] = React.useState(false)
  const [disposition, setDisposition] = React.useState<Disposition>('confirmed')
  const [rationale, setRationale] = React.useState('')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          Set disposition
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Final disposition</DialogTitle>
          <DialogDescription>
            What this alert turned out to be. Required before the alert can be closed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="disp">Disposition</Label>
            <Select
              id="disp"
              value={disposition}
              onChange={(e) => setDisposition(e.target.value as Disposition)}
            >
              {DISPOSITIONS.map((d) => (
                <option key={d} value={d}>
                  {DISPOSITION_LABELS[d]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="disp-rationale">Rationale</Label>
            <Textarea
              id="disp-rationale"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="What was established, and how."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!rationale.trim()}
            onClick={() =>
              onDone(async () => {
                await provider.setDisposition(context.alert.id, disposition, rationale)
                setOpen(false)
                setRationale('')
              })
            }
          >
            Record disposition
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AlertDetailPage() {
  const { alertId } = useParams<{ alertId: string }>()
  const { provider, reference, session } = useData()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState('')
  const [assignee, setAssignee] = React.useState('')
  // Mobile only: secondary actions collapse so the bar stays one row tall.
  const [moreOpen, setMoreOpen] = React.useState(false)

  const { data: context, loading } = useProviderQuery(
    (p) => (alertId ? p.getAlert(alertId) : Promise.resolve(null)),
    [alertId],
  )

  const profilesById = new Map((reference?.profiles ?? []).map((p) => [p.userId, p]))
  const nameFor = (userId: string | null | undefined) =>
    userId ? (profilesById.get(userId)?.fullName ?? 'Unknown user') : '—'

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading && !context) return <p className="text-sm text-readable-muted">Loading alert…</p>
  if (!context) {
    return (
      <Card className="p-6">
        <p className="font-medium">Alert not found</p>
        <p className="mt-1 text-sm text-readable-muted">
          It may have been removed, or your role may not have access to its program.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <Link to="/alerts">Back to the alert feed</Link>
        </Button>
      </Card>
    )
  }

  const { alert, signal, author, media, location, assignment, category, candidate } = context
  const tz = location.timeZone
  const mayOperate = session ? canOperate(session.role) : false
  const closed = alert.status === 'closed'

  const spyglassLink =
    alert.spyglassReference ??
    (env.spyglassBaseUrl
      ? `${env.spyglassBaseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(location.officialName)}`
      : null)

  return (
    // Room for the sticky action bar, plus the iOS home indicator. Without
    // the safe-area term the last note in the timeline sits under the bar.
    <div className="pb-[calc(7rem+env(safe-area-inset-bottom,0px))]">
      <Button asChild variant="ghost" size="sm" className="mb-3">
        <Link to="/alerts">
          <ArrowLeft className="size-4" />
          Back to the alert feed
        </Link>
      </Button>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {/* Header ------------------------------------------------------------ */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={alert.severity} size="lg" />
          <AlertStatusBadge status={alert.status} />
          {category && <Badge variant="outline">{category.label}</Badge>}
          {alert.disposition && <DispositionBadge disposition={alert.disposition} />}
          {signal?.collectionMethod === 'simulator' && <SimulatedBadge />}
          <span className="tabular ml-auto text-sm text-readable-muted">
            Priority {alert.priorityScore}/100
          </span>
        </div>

        <h1 className="mt-3 text-xl font-semibold leading-tight">{alert.title}</h1>
        <p className="mt-1 text-sm text-readable-muted">{alert.summary}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Protected location">
            {location.officialName}
            <br />
            <span className="text-readable-muted">
              {location.addressLine1}
              {location.addressLine2 ? `, ${location.addressLine2}` : ''}, {location.city},{' '}
              {location.state} {location.postalCode}
            </span>
          </Field>
          <Field label="Operational assignment">{assignment?.name ?? 'Not assigned'}</Field>
          <Field label="Assigned to">{nameFor(alert.assignedTo)}</Field>
          <Field label="Acknowledged by">
            {alert.acknowledgedAt ? (
              <>
                {nameFor(alert.acknowledgedBy)}
                <br />
                <span className="text-readable-muted">
                  {formatDateTime(alert.acknowledgedAt, tz)}
                </span>
              </>
            ) : (
              <span className="font-medium text-destructive">Unacknowledged</span>
            )}
          </Field>
        </div>

        <Separator className="my-4" />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Published">{formatDateTime(alert.publishedAt, tz)}</Field>
          <Field label="Detected">{formatDateTime(alert.detectedAt, tz)}</Field>
          <Field label="Validated">
            {formatDateTime(alert.validatedAt, tz)}
            <br />
            <span className="text-readable-muted">by {nameFor(alert.validatedBy)}</span>
          </Field>
          <Field label="First notified">
            {alert.firstNotifiedAt ? formatDateTime(alert.firstNotifiedAt, tz) : 'Not yet notified'}
          </Field>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Detection to validation">
            {formatDuration(secondsBetween(alert.detectedAt, alert.validatedAt))}
          </Field>
          <Field label="Validation to notification">
            {formatDuration(secondsBetween(alert.validatedAt, alert.firstNotifiedAt))}
          </Field>
          <Field label="Notification to acknowledgment">
            {formatDuration(
              secondsBetween(alert.firstNotifiedAt ?? alert.validatedAt, alert.acknowledgedAt),
            )}
          </Field>
        </div>

        {spyglassLink && isSafeExternalUrl(spyglassLink) && (
          <Button asChild variant="outline" size="sm" className="mt-4">
            <a href={spyglassLink} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-3.5" />
              View in Spyglass
            </a>
          </Button>
        )}
      </Card>

      {/* min-w-0 on the columns: a grid item defaults to min-width:auto and
          would otherwise refuse to shrink below its widest content, pushing the
          page into horizontal scroll on a phone. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-4">
          {/* Source ------------------------------------------------------- */}
          <SectionCard title="Full original source content">
            {signal ? (
              <>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{signal.originalText}</p>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="Source platform">{signal.sourcePlatform}</Field>
                  <Field label="Collection method">
                    {signal.collectionMethod.replace(/_/g, ' ')}
                  </Field>
                  <Field label="Source record id">
                    <code className="text-[13px]">{signal.sourceRecordId}</code>
                  </Field>
                  <Field label="Content hash">
                    <code className="text-[13px] break-all">{signal.contentHash}</code>
                  </Field>
                </div>

                <Field label="Provenance" className="mt-3">
                  <span className="text-readable-muted">{signal.provenance}</span>
                </Field>

                {isSafeExternalUrl(signal.sourceUrl) && (
                  <Button asChild variant="outline" size="sm" className="mt-3">
                    <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                      <ExternalLink className="size-3.5" />
                      Open source
                    </a>
                  </Button>
                )}

                {media.length > 0 && (
                  <div className="mt-4">
                    <Label>Media</Label>
                    <ul className="mt-1 space-y-1 text-sm">
                      {media.map((item) => (
                        <li key={item.id}>
                          {isSafeExternalUrl(item.url) ? (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              className="text-primary hover:underline"
                            >
                              {item.mediaType}: {item.url}
                            </a>
                          ) : (
                            <span className="text-readable-muted">
                              {item.mediaType}: reference withheld (not an http(s) URL)
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-readable-muted">The source signal is unavailable.</p>
            )}
          </SectionCard>

          {/* Author + locations ------------------------------------------- */}
          <SectionCard title="Public author information">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Public handle">{author?.handle ?? 'Not recorded'}</Field>
              <Field label="Public display name">{author?.displayName ?? 'Not recorded'}</Field>
              <Field label="Public profile location (self-declared)">
                {author?.profileLocationText ?? 'Not recorded'}
              </Field>
              <Field label="Author current location">
                <div className="flex flex-wrap items-center gap-2">
                  <AuthorLocationBadge status={alert.authorLocation.status} />
                  {alert.authorLocation.status !== 'unknown' && (
                    <span className="tabular text-[13px] text-readable-muted">
                      {alert.authorLocation.confidence}% confidence
                    </span>
                  )}
                  <AssessmentSourceBadge source={alert.authorLocation.assessedBy} />
                </div>
              </Field>
            </div>

            {alert.authorLocation.status === 'unknown' ? (
              <p className="mt-3 flex items-start gap-2 rounded-md bg-muted p-2.5 text-[13px] text-readable-muted">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                The author&apos;s current location is unknown and is deliberately not inferred from
                their profile, biography or posting history. The profile location above is a
                self-declared string, not a statement of where this person is.
              </p>
            ) : (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                {alert.authorLocation.evidence.map((item, index) => (
                  <li key={index}>
                    <span className="font-medium">{item.kind.replace(/_/g, ' ')}:</span>{' '}
                    {item.detail}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Incident location evidence"
            action={<AssessmentSourceBadge source={alert.incidentLocation.assessedBy} />}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Confidence">
                <LocationConfidence confidence={alert.incidentLocation.confidence} />
              </Field>
              <Field label="Method">
                {alert.incidentLocation.method
                  ? LOCATION_MATCH_METHOD_LABELS[alert.incidentLocation.method]
                  : '—'}
              </Field>
              <Field label="Time zone">{location.timeZone}</Field>
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {alert.incidentLocation.evidence.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </SectionCard>

          {/* Assessments -------------------------------------------------- */}
          <SectionCard
            title="Automated assessment"
            action={<AssessmentSourceBadge source="automated" />}
          >
            <div className="flex flex-wrap items-center gap-3">
              <SeverityBadge severity={candidate.automatedSeverity} />
              <span className="tabular text-lg font-semibold">
                {candidate.automatedScore.priorityScore}/100
              </span>
              <Badge variant="muted">{candidate.automatedScore.scorerId}</Badge>
            </div>
            <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 text-[13px] leading-relaxed">
              {candidate.automatedScore.explanation}
            </pre>
          </SectionCard>

          <SectionCard title="Analyst assessment" action={<AssessmentSourceBadge source="analyst" />}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Severity">
                {candidate.analystSeverity ? (
                  <SeverityBadge severity={candidate.analystSeverity} />
                ) : (
                  <span className="text-readable-muted">
                    Not changed — the automated severity was accepted
                  </span>
                )}
              </Field>
              <Field label="Category">
                {candidate.analystCategoryKey ? (
                  (reference?.categories.find((c) => c.key === candidate.analystCategoryKey)
                    ?.label ?? candidate.analystCategoryKey)
                ) : (
                  <span className="text-readable-muted">
                    Not changed — the automated category was accepted
                  </span>
                )}
              </Field>
            </div>
            <Field label="Analyst note" className="mt-3">
              {candidate.analystNotes ?? (
                <span className="text-readable-muted">No analyst note recorded.</span>
              )}
            </Field>
          </SectionCard>

          {/* Related ------------------------------------------------------ */}
          {context.relatedSignals.length > 0 && (
            <SectionCard title="Related and duplicate signals">
              <ul className="space-y-2">
                {context.relatedSignals.map((related) => (
                  <li key={related.signal.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="tabular font-medium">{related.similarity}% overlap</span>
                      <Badge variant="muted">{related.method.replace(/_/g, ' ')}</Badge>
                      <span className="text-readable-muted">
                        {related.signal.sourcePlatform} ·{' '}
                        {formatRelative(related.signal.publishedAt)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm">{related.signal.originalText}</p>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {/* Comments ----------------------------------------------------- */}
          <SectionCard title="Operational notes">
            {context.comments.length === 0 ? (
              <p className="text-sm text-readable-muted">No notes recorded yet.</p>
            ) : (
              <ul className="space-y-3">
                {context.comments.map((comment) => (
                  <li key={comment.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-readable-muted">
                      <span className="font-medium text-foreground">
                        {nameFor(comment.authorUserId)}
                      </span>
                      <Badge variant="muted">{comment.kind.replace(/_/g, ' ')}</Badge>
                      <span>{formatDateTime(comment.createdAt, tz)}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-sm">{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}

            {mayOperate && !closed && (
              <div className="mt-3 space-y-2">
                <Label htmlFor="op-note">Add an operational note</Label>
                <Textarea
                  id="op-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Who you contacted, what they said, what happens next."
                />
                <Button
                  size="sm"
                  disabled={busy || !note.trim()}
                  onClick={() =>
                    run(async () => {
                      await provider.addComment(alert.id, note, 'operational_note')
                      setNote('')
                    })
                  }
                >
                  Add note
                </Button>
              </div>
            )}
          </SectionCard>

          {/* Audit -------------------------------------------------------- */}
          <SectionCard title="Full audit trail">
            <ol className="space-y-2">
              {context.auditTrail.map((event) => (
                <li key={event.id} className="rounded-md border p-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium">{event.action.replace(/[._]/g, ' ')}</span>
                    <Badge variant="muted">{event.actorRole.replace(/_/g, ' ')}</Badge>
                    <span className="text-readable-muted">
                      {nameFor(event.actorUserId)} · {formatDateTime(event.occurredAt, tz)}
                    </span>
                  </div>
                  {Object.keys(event.detail).length > 0 && (
                    <pre className="mt-1.5 overflow-x-auto rounded bg-muted p-2 text-[11px]">
                      {JSON.stringify(event.detail, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </SectionCard>
        </div>

        {/* Sidebar ------------------------------------------------------- */}
        <div className="min-w-0 space-y-4">
          <SectionCard title="Notification delivery history">
            {context.deliveries.length === 0 ? (
              <p className="text-sm text-readable-muted">
                No delivery has been attempted for this alert.
              </p>
            ) : (
              <ul className="space-y-2">
                {context.deliveries.map((delivery) => (
                  <li key={delivery.id} className="rounded-md border p-2.5 text-[13px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">
                        {DELIVERY_CHANNEL_LABELS[delivery.channel]}
                      </span>
                      <Badge
                        variant={
                          delivery.status === 'delivered'
                            ? 'success'
                            : delivery.status === 'failed'
                              ? 'danger'
                              : 'muted'
                        }
                      >
                        {DELIVERY_STATUS_LABELS[delivery.status]}
                      </Badge>
                      {delivery.isSimulated && <SimulatedBadge />}
                      <span className="ml-auto text-readable-muted">step {delivery.pathStep}</span>
                    </div>
                    <p className="mt-1 text-readable-muted">
                      To {nameFor(delivery.userId)} · {formatDateTime(delivery.attemptedAt, tz)}
                    </p>
                    {delivery.detail && <p className="mt-1 text-readable-muted">{delivery.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Acknowledgment history">
            {context.acknowledgments.length === 0 ? (
              <p className="text-sm text-readable-muted">Not yet acknowledged.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {context.acknowledgments.map((ack) => (
                  <li key={ack.id} className="rounded-md border p-2.5">
                    <p className="font-medium">{nameFor(ack.acknowledgedBy)}</p>
                    <p className="text-[13px] text-readable-muted">
                      {formatDateTime(ack.createdAt, tz)} · responded in{' '}
                      {formatDuration(ack.responseSeconds)}
                    </p>
                    {ack.note && <p className="mt-1 text-sm">{ack.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Escalation history">
            {context.escalations.length === 0 ? (
              <p className="text-sm text-readable-muted">No escalation recorded.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {context.escalations.map((escalation) => (
                  <li key={escalation.id} className="rounded-md border p-2.5">
                    <p className="font-medium">{ESCALATION_LEVEL_LABELS[escalation.level]}</p>
                    <p className="text-[13px] text-readable-muted">
                      {nameFor(escalation.escalatedBy)} · {formatDateTime(escalation.createdAt, tz)}
                    </p>
                    <p className="mt-1">{escalation.reason}</p>
                    {escalation.notifiedParties.length > 0 && (
                      <p className="mt-1 text-[13px]">
                        Notified: {escalation.notifiedParties.join(', ')}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {escalation.storeManagerNotified && (
                        <Badge variant="secondary">Store manager notified</Badge>
                      )}
                      {escalation.regionalManagerNotified && (
                        <Badge variant="secondary">Regional manager notified</Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Final disposition">
            {alert.disposition ? (
              <>
                <DispositionBadge disposition={alert.disposition} />
                {alert.dispositionNotes && (
                  <p className="mt-2 text-sm">{alert.dispositionNotes}</p>
                )}
                <ul className="mt-2 space-y-1 text-[13px] text-readable-muted">
                  {context.dispositions.map((d) => (
                    <li key={d.id}>
                      {DISPOSITION_LABELS[d.disposition]} — {nameFor(d.setBy)} (
                      {d.assessedBy === 'analyst' ? 'analyst assessment' : 'SOC decision'})
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-readable-muted">No disposition set.</p>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Sticky SOC action bar ------------------------------------------- */}
      {mayOperate && !closed && (
        // Offset past the navigation rail on desktop so the bar cannot cover
        // the sidebar controls beneath it.
        <div
          className="pad-safe-bottom fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur md:left-60"
          data-testid="alert-action-bar"
        >
          <div className="mx-auto max-w-[1600px] p-3">
            {/*
              Mobile: Acknowledge is the whole first row, full width, because it
              is the action that matters and the one most often taken one-handed
              while walking. Everything else collapses behind "More actions" so
              the bar stays one row tall and never grows into the content.

              Desktop keeps every control inline, exactly as before.
            */}
            <div className="flex flex-wrap items-center gap-2 md:hidden">
              {!alert.acknowledgedAt && (
                <Button
                  size="lg"
                  className="w-full text-[17px]"
                  disabled={busy}
                  onClick={() => run(() => provider.acknowledgeAlert(alert.id, null))}
                >
                  Acknowledge
                </Button>
              )}
              <Button
                variant="outline"
                size="lg"
                className="w-full text-[17px]"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
              >
                {moreOpen ? 'Hide actions' : 'More actions'}
              </Button>

              {moreOpen && (
                <div className="flex w-full flex-col gap-2 pt-1">
                  <Select
                    aria-label="Assign to"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    className="h-12 w-full text-[16px]"
                  >
                    <option value="">Assign to…</option>
                    {(reference?.profiles ?? []).map((profile) => (
                      <option key={profile.userId} value={profile.userId}>
                        {profile.fullName}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="outline"
                    size="lg"
                    className="w-full text-[17px]"
                    disabled={busy || !assignee}
                    onClick={() =>
                      run(async () => {
                        await provider.assignAlert(alert.id, assignee, null)
                        setAssignee('')
                      })
                    }
                  >
                    Assign
                  </Button>

                  <EscalateDialog context={context} onDone={run} />
                  <DispositionDialog context={context} onDone={run} />

                  <Select
                    aria-label="Change status"
                    value={alert.status}
                    disabled={busy}
                    className="h-12 w-full text-[16px]"
                    onChange={(e) =>
                      run(() => provider.changeAlertStatus(alert.id, e.target.value as AlertStatus))
                    }
                  >
                    {ALERT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {ALERT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>

            <div className="hidden flex-wrap items-center gap-2 md:flex">
              {!alert.acknowledgedAt && (
                <Button
                  size="lg"
                  disabled={busy}
                  onClick={() => run(() => provider.acknowledgeAlert(alert.id, null))}
                >
                  Acknowledge
                </Button>
              )}

              <div className="flex items-center gap-1.5">
                <Select
                  aria-label="Assign to"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  className="h-12 w-44"
                >
                  <option value="">Assign to…</option>
                  {(reference?.profiles ?? []).map((profile) => (
                    <option key={profile.userId} value={profile.userId}>
                      {profile.fullName}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  size="lg"
                  disabled={busy || !assignee}
                  onClick={() =>
                    run(async () => {
                      await provider.assignAlert(alert.id, assignee, null)
                      setAssignee('')
                    })
                  }
                >
                  Assign
                </Button>
              </div>

              <EscalateDialog context={context} onDone={run} />
              <DispositionDialog context={context} onDone={run} />

              <Select
                aria-label="Change status"
                value={alert.status}
                disabled={busy}
                className="h-12 w-40"
                onChange={(e) =>
                  run(() => provider.changeAlertStatus(alert.id, e.target.value as AlertStatus))
                }
              >
                {ALERT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ALERT_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
