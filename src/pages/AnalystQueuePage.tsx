import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Info } from 'lucide-react'
import {
  CANDIDATE_STATUSES,
  LOCATION_MATCH_METHOD_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  type CandidateStatus,
  type Severity,
} from '@/domain/enums'
import type { CandidateWithContext } from '@/domain/types'
import { excerpt, isSafeExternalUrl } from '@/lib/utils'
import { formatDateTime, formatRelative } from '@/lib/datetime'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Label,
  Select,
  Separator,
  Textarea,
} from '@/components/ui/primitives'
import {
  AssessmentSourceBadge,
  AuthorLocationBadge,
  CandidateStatusBadge,
  LocationConfidence,
  SeverityBadge,
  SimulatedBadge,
  severityRailClass,
} from '@/components/alerts/badges'
import { PageHeader } from '@/components/layout/AppShell'
import { useData, useProviderQuery } from '@/app/DataContext'
import { canValidate } from '@/data/workflow'

/**
 * Analyst Queue.
 *
 * A list on the left, the full review surface on the right. The review panel
 * deliberately shows the automated assessment and the analyst assessment as
 * two separate things: the analyst is correcting a machine, not agreeing with
 * it by default.
 */

function CandidateRow({
  context,
  selected,
  onSelect,
}: {
  context: CandidateWithContext
  selected: boolean
  onSelect: () => void
}) {
  const { candidate, signal, location, category } = context
  const severity = candidate.analystSeverity ?? candidate.automatedSeverity

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${severityRailClass(severity)} ${
        selected ? 'border-primary bg-accent' : 'hover:border-primary/40 hover:bg-accent/50'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={severity} />
        <CandidateStatusBadge status={candidate.status} />
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {candidate.automatedScore.priorityScore}/100
        </span>
      </div>
      <p className="mt-2 text-sm font-medium leading-snug">
        {category?.label ?? candidate.automatedCategoryKey}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {location ? `${location.officialName} — ${location.city}, ${location.state}` : 'No location matched'}
      </p>
      {signal && (
        <p className="mt-1.5 line-clamp-2 text-xs text-foreground/70">
          {excerpt(signal.originalText, 120)}
        </p>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {signal ? formatRelative(signal.publishedAt) : ''}
        {context.likelyDuplicates.length > 0 &&
          ` · ${context.likelyDuplicates.length} possible duplicate${context.likelyDuplicates.length > 1 ? 's' : ''}`}
      </p>
    </button>
  )
}

function ReviewPanel({ context }: { context: CandidateWithContext }) {
  const { provider, reference, session } = useData()
  const navigate = useNavigate()
  const { candidate, signal, author, media, location } = context

  const [severity, setSeverity] = React.useState<Severity>(
    candidate.analystSeverity ?? candidate.automatedSeverity,
  )
  const [categoryKey, setCategoryKey] = React.useState(
    candidate.analystCategoryKey ?? candidate.automatedCategoryKey,
  )
  const [locationId, setLocationId] = React.useState(candidate.locationId ?? '')
  const [assignmentId, setAssignmentId] = React.useState(candidate.operationalAssignmentId ?? '')
  const [note, setNote] = React.useState(candidate.analystNotes ?? '')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Reset the form when a different candidate is selected.
  React.useEffect(() => {
    setSeverity(candidate.analystSeverity ?? candidate.automatedSeverity)
    setCategoryKey(candidate.analystCategoryKey ?? candidate.automatedCategoryKey)
    setLocationId(candidate.locationId ?? '')
    setAssignmentId(candidate.operationalAssignmentId ?? '')
    setNote(candidate.analystNotes ?? '')
    setReason('')
    setError(null)
  }, [
    candidate.id,
    candidate.analystSeverity,
    candidate.analystCategoryKey,
    candidate.automatedSeverity,
    candidate.automatedCategoryKey,
    candidate.locationId,
    candidate.operationalAssignmentId,
    candidate.analystNotes,
  ])

  const mayValidate = session ? canValidate(session.role) : false
  const decided = ['validated', 'rejected', 'duplicate', 'suppressed'].includes(candidate.status)

  const assignmentsForLocation = (reference?.assignments ?? []).filter(
    (a) => a.locationId === locationId,
  )

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

  const saveAssessment = () =>
    run(() =>
      provider.editAssessment(candidate.id, {
        severity,
        categoryKey,
        notes: note,
        locationId: locationId || null,
        operationalAssignmentId: assignmentId || null,
      }),
    )

  const score = candidate.automatedScore

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Original source                                                     */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Original source</h2>
          <div className="flex items-center gap-2">
            {signal?.collectionMethod === 'simulator' && <SimulatedBadge />}
            <CandidateStatusBadge status={candidate.status} />
          </div>
        </div>

        {signal && (
          <>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{signal.originalText}</p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Source platform">{signal.sourcePlatform}</Field>
              <Field label="Published">
                {formatDateTime(signal.publishedAt, location?.timeZone)}
              </Field>
              <Field label="Collected">
                {formatDateTime(signal.ingestedAt, location?.timeZone)}
              </Field>
              <Field label="Collection method">{signal.collectionMethod.replace(/_/g, ' ')}</Field>
              <Field label="Source record id">
                <code className="text-xs">{signal.sourceRecordId}</code>
              </Field>
              <Field label="Content hash">
                <code className="text-xs">{signal.contentHash.slice(0, 16)}…</code>
              </Field>
            </div>

            <Field label="Provenance" className="mt-3">
              <span className="text-muted-foreground">{signal.provenance}</span>
            </Field>

            {isSafeExternalUrl(signal.sourceUrl) && (
              <Button asChild variant="outline" size="sm" className="mt-3">
                <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                  <ExternalLink className="size-3.5" />
                  Open the original source
                </a>
              </Button>
            )}
          </>
        )}

        {media.length > 0 && (
          <div className="mt-4">
            <Label>Source media</Label>
            <ul className="mt-1 space-y-1">
              {media.map((item) => (
                <li key={item.id} className="text-sm">
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
                    <span className="text-muted-foreground">
                      {item.mediaType}: reference withheld (not an http(s) URL)
                    </span>
                  )}
                  {item.caption && (
                    <span className="ml-2 text-xs text-muted-foreground">{item.caption}</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              Media is referenced, not copied. OpeniWatch does not re-host or proxy source media.
            </p>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Public author + the three location facts                            */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-4">
        <h2 className="font-semibold">Public author information</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Everything below is exactly as published by the source. OpeniWatch does not identify
          account owners or enrich profile data.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Public handle">{author?.handle ?? 'Not recorded'}</Field>
          <Field label="Public display name">{author?.displayName ?? 'Not recorded'}</Field>
          <Field label="Public profile location (self-declared)">
            {author?.profileLocationText ?? 'Not recorded'}
          </Field>
          <Field label="Author current location">
            <div className="flex items-center gap-2">
              <AuthorLocationBadge status={candidate.authorLocation.status} />
              {candidate.authorLocation.status !== 'unknown' && (
                <span className="tabular text-xs text-muted-foreground">
                  {candidate.authorLocation.confidence}% confidence
                </span>
              )}
            </div>
          </Field>
        </div>

        {candidate.authorLocation.status === 'unknown' ? (
          <p className="mt-3 flex items-start gap-2 rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            The author&apos;s current location is unknown. A profile location, biography or posting
            history never establishes where a person is — only a public geotag, coordinates in the
            source, an explicit contemporaneous statement, verifiable visual evidence or another
            documented public source can.
          </p>
        ) : (
          <div className="mt-3">
            <Label>Author location evidence</Label>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {candidate.authorLocation.evidence.map((item, index) => (
                <li key={index}>
                  <span className="font-medium">{item.kind.replace(/_/g, ' ')}:</span> {item.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Incident location evidence                                          */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Incident location</h2>
          <AssessmentSourceBadge source={candidate.incidentLocation.assessedBy} />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Matched location">
            {location ? `${location.officialName} — ${location.city}, ${location.state}` : 'None'}
          </Field>
          <Field label="Confidence">
            <LocationConfidence confidence={candidate.incidentLocation.confidence} />
          </Field>
          <Field label="Method">
            {candidate.incidentLocation.method
              ? LOCATION_MATCH_METHOD_LABELS[candidate.incidentLocation.method]
              : '—'}
          </Field>
        </div>

        <div className="mt-3">
          <Label>Evidence</Label>
          {candidate.incidentLocation.evidence.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              No location evidence was found. Assign a location manually before validating.
            </p>
          ) : (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {candidate.incidentLocation.evidence.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Automated assessment                                                */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Automated assessment</h2>
          <div className="flex items-center gap-2">
            <AssessmentSourceBadge source="automated" />
            <Badge variant="muted">{score.scorerId}</Badge>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SeverityBadge severity={candidate.automatedSeverity} size="lg" />
          <span className="tabular text-2xl font-semibold">{score.priorityScore}</span>
          <span className="text-sm text-muted-foreground">/ 100 priority</span>
          <Badge variant="outline">
            {reference?.categories.find((c) => c.key === candidate.automatedCategoryKey)?.label ??
              candidate.automatedCategoryKey}
          </Badge>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ['Threat severity', score.breakdown.threatSeverity],
              ['Location confidence', score.breakdown.locationConfidence],
              ['Immediacy', score.breakdown.immediacy],
              ['Source credibility', score.breakdown.sourceCredibility],
              ['Specificity', score.breakdown.specificity],
              ['Corroboration', score.breakdown.corroboration],
              ['Operational relevance', score.breakdown.operationalRelevance],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-md border p-2">
              <p className="text-xs text-muted-foreground">{label}</p>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${value}%` }} />
                </div>
                <span className="tabular text-xs font-medium">{value}</span>
              </div>
            </div>
          ))}
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">
            Why this candidate received this score
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed">
            {score.explanation}
          </pre>
        </details>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Likely duplicates                                                   */}
      {/* ------------------------------------------------------------------ */}
      {context.likelyDuplicates.length > 0 && (
        <Card className="p-4">
          <h2 className="font-semibold">Likely duplicates and related reports</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Independent accounts describing the same event may be corroboration rather than
            duplication. Review before marking as a duplicate.
          </p>
          <ul className="mt-3 space-y-2">
            {context.likelyDuplicates.map((dup) => (
              <li key={dup.candidate.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="tabular text-xs font-medium">{dup.similarity}% word overlap</span>
                  <CandidateStatusBadge status={dup.candidate.status} />
                </div>
                <p className="mt-1.5 text-sm">{excerpt(dup.signal.originalText, 160)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {dup.signal.sourcePlatform} · {formatRelative(dup.signal.publishedAt)}
                </p>
                {mayValidate && !decided && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        provider.decideCandidate(
                          candidate.id,
                          'duplicate',
                          `Duplicate of an existing report (${dup.similarity}% word overlap).`,
                          { duplicateOfCandidateId: dup.candidate.id },
                        ),
                      )
                    }
                  >
                    Mark this candidate a duplicate of that report
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Analyst assessment and decision                                     */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Analyst assessment</h2>
          <AssessmentSourceBadge source="analyst" />
        </div>

        {!mayValidate ? (
          <p className="mt-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">
            Your role cannot validate or decide candidate alerts. Only analysts and program
            administrators may. You can review everything on this screen.
          </p>
        ) : decided ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm">
              Decided {candidate.decidedAt ? formatRelative(candidate.decidedAt) : ''} —{' '}
              <strong>{candidate.status.replace(/_/g, ' ')}</strong>
            </p>
            {candidate.decisionReason && (
              <p className="text-sm text-muted-foreground">{candidate.decisionReason}</p>
            )}
            {candidate.alertId && (
              <Button size="sm" onClick={() => navigate(`/alerts/${candidate.alertId}`)}>
                Open the operational alert
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="severity">Severity</Label>
                <Select
                  id="severity"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as Severity)}
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {SEVERITY_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="category">Threat category</Label>
                <Select
                  id="category"
                  value={categoryKey}
                  onChange={(e) => setCategoryKey(e.target.value)}
                >
                  {(reference?.categories ?? [])
                    .filter((c) => c.isActive)
                    .map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="location">Protected location</Label>
                <Select
                  id="location"
                  value={locationId}
                  onChange={(e) => {
                    setLocationId(e.target.value)
                    setAssignmentId('')
                  }}
                >
                  <option value="">No location assigned</option>
                  {(reference?.locations ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.officialName} — {l.city}, {l.state}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="assignment">Operational assignment</Label>
                <Select
                  id="assignment"
                  value={assignmentId}
                  onChange={(e) => setAssignmentId(e.target.value)}
                  disabled={assignmentsForLocation.length === 0}
                >
                  <option value="">Not assigned</option>
                  {assignmentsForLocation.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                {assignmentsForLocation.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    This location has {assignmentsForLocation.length} assignments.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-3 space-y-1">
              <Label htmlFor="analyst-note">Analyst note</Label>
              <Textarea
                id="analyst-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What you verified, what remains uncertain, and why."
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={saveAssessment}>
                Save assessment
              </Button>
              {candidate.status === 'pending_review' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => provider.startReview(candidate.id))}
                >
                  Start review
                </Button>
              )}
            </div>

            <Separator className="my-4" />

            <div className="space-y-1">
              <Label htmlFor="reason">Reason (required to reject, suppress or mark wrong location)</Label>
              <Input
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Refers to a different retailer in the same plaza."
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="lg"
                disabled={busy || !candidate.locationId}
                title={
                  candidate.locationId
                    ? undefined
                    : 'Assign a monitored location before validating.'
                }
                onClick={() =>
                  run(async () => {
                    await provider.editAssessment(candidate.id, {
                      severity,
                      categoryKey,
                      notes: note,
                      locationId: locationId || null,
                      operationalAssignmentId: assignmentId || null,
                    })
                    const { alertId } = await provider.validateCandidate(candidate.id, {
                      note: note || undefined,
                    })
                    navigate(`/alerts/${alertId}`)
                  })
                }
              >
                Validate and create alert
              </Button>

              <Button
                variant="outline"
                disabled={busy || !reason.trim()}
                onClick={() => run(() => provider.decideCandidate(candidate.id, 'rejected', reason))}
              >
                Reject
              </Button>

              <Button
                variant="outline"
                disabled={busy || !reason.trim()}
                onClick={() =>
                  run(() =>
                    provider.decideCandidate(
                      candidate.id,
                      'rejected',
                      `Wrong location: ${reason}`,
                    ),
                  )
                }
              >
                Wrong location
              </Button>

              <Button
                variant="outline"
                disabled={busy || !reason.trim()}
                onClick={() =>
                  run(() => provider.decideCandidate(candidate.id, 'suppressed', reason))
                }
              >
                Suppress as non-operational
              </Button>

              <Button
                variant="outline"
                disabled={busy || !reason.trim()}
                onClick={() =>
                  run(() => provider.decideCandidate(candidate.id, 'duplicate', reason))
                }
              >
                Mark duplicate
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

export function AnalystQueuePage() {
  const [statuses, setStatuses] = React.useState<CandidateStatus[]>([
    'pending_review',
    'under_review',
  ])
  const [severity, setSeverity] = React.useState<Severity | ''>('')
  const [search, setSearch] = React.useState('')
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  const { data: candidates, loading } = useProviderQuery(
    (p) =>
      p.listCandidates({
        statuses,
        severities: severity ? [severity] : undefined,
        search: search || undefined,
      }),
    [statuses.join(','), severity, search],
  )

  const list = candidates ?? []
  const selected = list.find((c) => c.candidate.id === selectedId) ?? list[0] ?? null

  return (
    <div>
      <PageHeader
        title="Analyst queue"
        description="Candidate alerts awaiting review. Validating a candidate creates an operational alert and notifies subscribers."
      />

      <Card className="mb-4 p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="status-filter">Status</Label>
            <Select
              id="status-filter"
              value={statuses.length === 2 ? 'open' : (statuses[0] ?? 'all')}
              onChange={(e) => {
                const value = e.target.value
                if (value === 'open') setStatuses(['pending_review', 'under_review'])
                else if (value === 'all') setStatuses([...CANDIDATE_STATUSES])
                else setStatuses([value as CandidateStatus])
              }}
            >
              <option value="open">Awaiting review</option>
              <option value="all">All statuses</option>
              {CANDIDATE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="severity-filter">Severity</Label>
            <Select
              id="severity-filter"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Severity | '')}
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
            <Label htmlFor="queue-search">Search</Label>
            <Input
              id="queue-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Text, location, author or category"
            />
          </div>
        </div>
      </Card>

      {loading && list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading candidates…</p>
      ) : list.length === 0 ? (
        <EmptyState
          title="No candidates match these filters"
          description="Candidate alerts appear here as signals are collected and scored. Use the simulator to generate a scenario."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div className="space-y-2 lg:max-h-[calc(100vh-16rem)] lg:overflow-y-auto lg:pr-1">
            {list.map((context) => (
              <CandidateRow
                key={context.candidate.id}
                context={context}
                selected={selected?.candidate.id === context.candidate.id}
                onSelect={() => setSelectedId(context.candidate.id)}
              />
            ))}
          </div>

          <div className="min-w-0">
            {selected ? (
              <ReviewPanel key={selected.candidate.id} context={selected} />
            ) : (
              <EmptyState title="Select a candidate" description="Choose a candidate to review." />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
