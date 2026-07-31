import type {
  CandidateAlert,
  LocationAlias,
  LocationGeofence,
  OperationalAssignment,
  ProtectedLocation,
  ScoringThreshold,
  Signal,
  SignalAuthor,
  SignalDuplicate,
  SignalLocationMatch,
  SignalMedia,
  ThreatCategory,
} from '@/domain/types'
import { classifySignal, getScorer } from '@/services/scoring'
import type { ParsedSignalInput } from './schema'
import { assessAuthorLocation } from './authorLocation'
import { countCorroboration, findDuplicates, type DuplicateFinding } from './duplicates'
import {
  applyAmbiguityPenalty,
  matchLocations,
  type LocationMatchResult,
  type LocationMatchTarget,
} from './locationMatching'
import { normalizeSignal, type NormalizedSignal } from './normalize'

/**
 * The ingestion pipeline.
 *
 * Detect -> Locate -> Classify -> Score. One path for every ingestion route
 * (webhook, manual submission, simulator, connector pull) so a signal is
 * treated identically regardless of how it arrived.
 *
 * The pipeline is pure: it reads a snapshot of reference data and returns the
 * records to persist. Storage belongs to the data provider.
 */

export interface PipelineReferenceData {
  organizationId: string
  programId: string
  locations: readonly ProtectedLocation[]
  aliases: readonly LocationAlias[]
  geofences: readonly LocationGeofence[]
  assignments: readonly OperationalAssignment[]
  categories: readonly ThreatCategory[]
  thresholds: ScoringThreshold
  /** Recent signals used for duplicate detection. */
  recentSignals: readonly Signal[]
  /** Known authors, so a repeat poster resolves to the same author record. */
  authors: readonly SignalAuthor[]
}

export interface PipelineOptions {
  /** Injected for deterministic tests. Defaults to now. */
  now?: string
  /** Id factory. Injected so the demo provider can use stable ids. */
  newId?: () => string
  collectionSourceId?: string | null
}

export type PipelineDecision =
  | { kind: 'candidate_created' }
  /** An identical source record already exists. Nothing is written. */
  | { kind: 'rejected_duplicate_source_record'; existingSignalId: string }
  /** Exact content duplicate: the signal is stored, the candidate is marked duplicate. */
  | { kind: 'candidate_marked_duplicate'; duplicateOfSignalId: string }
  /** Score below the auto-suppress threshold. */
  | { kind: 'candidate_suppressed'; reason: string }

export interface PipelineResult {
  decision: PipelineDecision
  signal: Signal | null
  author: SignalAuthor | null
  media: SignalMedia[]
  matches: SignalLocationMatch[]
  duplicates: SignalDuplicate[]
  candidate: CandidateAlert | null
  /** Diagnostics surfaced in the simulator and the analyst queue. */
  normalized: NormalizedSignal
  locationMatch: LocationMatchResult | null
  duplicateFindings: DuplicateFinding[]
}

let fallbackCounter = 0
function defaultId(): string {
  // crypto.randomUUID is available in every supported browser and in Node 18+.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  fallbackCounter += 1
  return `generated-${fallbackCounter}-${Date.now()}`
}

function buildMatchTargets(reference: PipelineReferenceData): LocationMatchTarget[] {
  return reference.locations.map((location) => ({
    location,
    aliases: reference.aliases.filter((a) => a.locationId === location.id),
    geofences: reference.geofences.filter((g) => g.locationId === location.id),
  }))
}

/**
 * Chooses the operational assignment for a location.
 *
 * A physical location may carry several assignments (Plano #696 has two). The
 * lowest assignment number is used as the routing default; an analyst can
 * reassign during review. The alert always records which assignment it belongs
 * to so reporting can distinguish them.
 */
export function selectAssignment(
  locationId: string,
  assignments: readonly OperationalAssignment[],
): OperationalAssignment | null {
  const forLocation = assignments
    .filter((a) => a.locationId === locationId && a.isActive)
    .sort((a, b) => a.assignmentNumber - b.assignmentNumber)
  return forLocation[0] ?? null
}

/** Short operational headline derived from the category and location. */
export function buildAlertTitle(categoryLabel: string, location: ProtectedLocation | null): string {
  return location ? `${categoryLabel} — ${location.officialName}` : categoryLabel
}

export function ingestSignal(
  input: ParsedSignalInput,
  reference: PipelineReferenceData,
  options: PipelineOptions = {},
): PipelineResult {
  const now = options.now ?? new Date().toISOString()
  const newId = options.newId ?? defaultId
  const normalized = normalizeSignal(input, { ingestedAt: now })

  // -- Idempotency ----------------------------------------------------------
  // The same source record must never produce two signals. This is the guard
  // that makes webhook retries safe.
  const existingSourceRecord = reference.recentSignals.find(
    (s) =>
      s.sourcePlatform === normalized.sourcePlatform &&
      s.sourceRecordId === normalized.sourceRecordId,
  )
  if (existingSourceRecord) {
    return {
      decision: {
        kind: 'rejected_duplicate_source_record',
        existingSignalId: existingSourceRecord.id,
      },
      signal: null,
      author: null,
      media: [],
      matches: [],
      duplicates: [],
      candidate: null,
      normalized,
      locationMatch: null,
      duplicateFindings: [],
    }
  }

  // -- Author ---------------------------------------------------------------
  // Author records hold only what the source published. Nothing is enriched,
  // looked up or inferred.
  let author: SignalAuthor | null = null
  if (normalized.author) {
    const existing = reference.authors.find(
      (a) =>
        a.platform === normalized.sourcePlatform &&
        a.handle.toLowerCase() === normalized.author!.handle.toLowerCase(),
    )
    author = existing
      ? { ...existing, lastSeenAt: now, updatedAt: now }
      : {
          id: newId(),
          organizationId: reference.organizationId,
          platform: normalized.sourcePlatform,
          handle: normalized.author.handle,
          displayName: normalized.author.displayName,
          profileLocationText: normalized.author.profileLocationText,
          profileUrl: normalized.author.profileUrl,
          profileDescription: normalized.author.profileDescription,
          sourceProfileMetadata: normalized.author.sourceProfileMetadata,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
          createdBy: null,
          updatedBy: null,
        }
  }

  // -- Signal ---------------------------------------------------------------
  const signalId = newId()
  const signal: Signal = {
    id: signalId,
    organizationId: reference.organizationId,
    programId: reference.programId,
    collectionSourceId: options.collectionSourceId ?? null,
    authorId: author?.id ?? null,
    sourcePlatform: normalized.sourcePlatform,
    sourceRecordId: normalized.sourceRecordId,
    sourceUrl: normalized.sourceUrl,
    originalText: normalized.originalText,
    publishedAt: normalized.publishedAt,
    ingestedAt: normalized.ingestedAt,
    collectionMethod: normalized.collectionMethod,
    provenance: normalized.provenance,
    contentHash: normalized.contentHash,
    rawPayload: normalized.rawPayload,
    sourceLatitude: normalized.sourceLatitude,
    sourceLongitude: normalized.sourceLongitude,
    hasPublicGeotag: normalized.hasPublicGeotag,
    language: normalized.language,
    isRetentionRestricted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }

  const media: SignalMedia[] = normalized.media.map((m) => ({
    id: newId(),
    signalId,
    mediaType: m.mediaType,
    url: m.url,
    thumbnailUrl: m.thumbnailUrl,
    caption: m.caption,
    capturedAt: m.capturedAt,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }))

  // -- Locate ---------------------------------------------------------------
  const rawMatches = matchLocations(normalized, buildMatchTargets(reference))
  const adjustedMatches = applyAmbiguityPenalty(rawMatches)

  // An analyst or connector hint is honoured only if that location also
  // matched on its own evidence — a hint never manufactures a match.
  const hinted = normalized.suggestedLocationId
    ? adjustedMatches.find((m) => m.locationId === normalized.suggestedLocationId)
    : undefined
  const bestMatch = hinted ?? adjustedMatches[0] ?? null

  const matches: SignalLocationMatch[] = adjustedMatches.map((match) => ({
    id: newId(),
    signalId,
    locationId: match.locationId,
    method: match.method,
    confidence: match.confidence,
    evidence: match.evidence,
    distanceMeters: match.distanceMeters,
    isPrimary: match.locationId === bestMatch?.locationId,
    assessedBy: 'automated',
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }))

  // -- Deduplicate ----------------------------------------------------------
  const duplicateFindings = findDuplicates(
    {
      contentHash: normalized.contentHash,
      originalText: normalized.originalText,
      publishedAt: normalized.publishedAt,
      sourcePlatform: normalized.sourcePlatform,
    },
    reference.recentSignals,
  )

  const duplicates: SignalDuplicate[] = duplicateFindings.map((finding) => ({
    id: newId(),
    signalId,
    duplicateOfSignalId: finding.duplicateOfSignalId,
    similarity: finding.similarity,
    method: finding.method,
    notes: finding.notes,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }))

  const signalsById = new Map(reference.recentSignals.map((s) => [s.id, s]))
  const corroboratingReports = countCorroboration(
    duplicateFindings,
    signalsById,
    author?.id ?? null,
  )

  // -- Classify -------------------------------------------------------------
  const activeCategories = reference.categories.filter((c) => c.isActive)
  const classification = classifySignal(
    normalized.originalText,
    activeCategories.map((c) => c.key),
  )
  const category =
    activeCategories.find((c) => c.key === classification.categoryKey) ?? activeCategories[0]

  if (!category) {
    throw new Error('No active threat categories are configured for this organization.')
  }

  // -- Score ----------------------------------------------------------------
  const authorLocation = assessAuthorLocation(normalized)
  const scorer = getScorer(reference.thresholds.scorerId)
  const score = scorer.score({
    signal: normalized,
    category: {
      key: category.key,
      label: category.label,
      baselineSeverity: category.baselineSeverity,
      severityWeight: category.severityWeight,
    },
    locationMatch: bestMatch,
    authorLocation,
    corroboratingReports,
    thresholds: reference.thresholds,
    now,
  })

  const location = bestMatch
    ? (reference.locations.find((l) => l.id === bestMatch.locationId) ?? null)
    : null
  const assignment = location ? selectAssignment(location.id, reference.assignments) : null

  // -- Decide ---------------------------------------------------------------
  const exactDuplicate = duplicateFindings.find((f) => f.method === 'content_hash')

  let status: CandidateAlert['status'] = 'pending_review'
  let decision: PipelineDecision = { kind: 'candidate_created' }
  let decisionReason: string | null = null

  if (exactDuplicate) {
    status = 'duplicate'
    decision = { kind: 'candidate_marked_duplicate', duplicateOfSignalId: exactDuplicate.duplicateOfSignalId }
    decisionReason = exactDuplicate.notes
  } else if (score.priorityScore < reference.thresholds.autoSuppressBelow) {
    status = 'suppressed'
    decisionReason = `Automatically suppressed: priority score ${score.priorityScore} is below the configured threshold of ${reference.thresholds.autoSuppressBelow}.`
    decision = { kind: 'candidate_suppressed', reason: decisionReason }
  } else if (
    !bestMatch ||
    bestMatch.confidence < reference.thresholds.minimumLocationConfidence
  ) {
    // Low-confidence location still reaches the queue: an analyst assigns the
    // location rather than the system discarding a possible threat.
    decisionReason = bestMatch
      ? `Incident-location confidence ${bestMatch.confidence}% is below the ${reference.thresholds.minimumLocationConfidence}% threshold. Analyst location assignment required.`
      : 'No monitored location could be matched. Analyst location assignment required.'
  }

  const candidate: CandidateAlert = {
    id: newId(),
    organizationId: reference.organizationId,
    programId: reference.programId,
    signalId,
    locationId: location?.id ?? null,
    operationalAssignmentId: assignment?.id ?? null,
    status,
    automatedCategoryKey: category.key,
    automatedSeverity: score.severity,
    automatedScore: score,
    analystCategoryKey: null,
    analystSeverity: null,
    analystNotes: null,
    incidentLocation: {
      locationId: location?.id ?? null,
      confidence: bestMatch?.confidence ?? 0,
      method: bestMatch?.method ?? null,
      evidence: bestMatch?.evidence ?? [],
      assessedBy: 'automated',
    },
    authorLocation,
    duplicateOfCandidateId: null,
    reviewStartedAt: null,
    reviewStartedBy: null,
    decidedAt: status === 'duplicate' || status === 'suppressed' ? now : null,
    decidedBy: null,
    decisionReason,
    alertId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }

  return {
    decision,
    signal,
    author,
    media,
    matches,
    duplicates,
    candidate,
    normalized,
    locationMatch: bestMatch,
    duplicateFindings,
  }
}
