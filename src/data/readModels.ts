import { ACTIVE_ALERT_STATUSES, SEVERITIES, SEVERITY_RANK } from '@/domain/enums'
import type {
  Alert,
  AlertWithContext,
  CandidateAlert,
  CandidateWithContext,
} from '@/domain/types'
import { average, secondsBetween, sortBy } from '@/lib/utils'
import { textSimilarity } from '@/services/ingestion/normalize'
import type { WatchDatabase } from './local/database'
import type {
  AlertFilter,
  CandidateFilter,
  OperationsSummary,
  ReportRange,
  ReportSummary,
} from './provider'

/**
 * Read models.
 *
 * Pure functions over a database snapshot. Both providers use them, so the
 * analyst queue, alert feed, operations overview and reporting are computed
 * identically whether the data came from localStorage or PostgreSQL.
 */

export function buildCandidateContext(
  db: WatchDatabase,
  candidate: CandidateAlert,
): CandidateWithContext {
  const signal = db.signals.find((s) => s.id === candidate.signalId)!
  const author = db.authors.find((a) => a.id === signal?.authorId) ?? null
  const media = db.media.filter((m) => m.signalId === candidate.signalId)
  const location = db.locations.find((l) => l.id === candidate.locationId) ?? null
  const assignment =
    db.operationalAssignments.find((a) => a.id === candidate.operationalAssignmentId) ?? null
  const categoryKey = candidate.analystCategoryKey ?? candidate.automatedCategoryKey
  const category = db.categories.find((c) => c.key === categoryKey) ?? null

  // Duplicate links are directional in storage but not in meaning, so look
  // both ways: a later signal may have been flagged against this one.
  const duplicateSignalIds = new Set<string>()
  for (const dup of db.signalDuplicates) {
    if (dup.signalId === candidate.signalId) duplicateSignalIds.add(dup.duplicateOfSignalId)
    if (dup.duplicateOfSignalId === candidate.signalId) duplicateSignalIds.add(dup.signalId)
  }

  const likelyDuplicates = [...duplicateSignalIds]
    .map((signalId) => {
      const otherCandidate = db.candidates.find((c) => c.signalId === signalId)
      const otherSignal = db.signals.find((s) => s.id === signalId)
      if (!otherCandidate || !otherSignal || !signal) return null
      return {
        candidate: otherCandidate,
        signal: otherSignal,
        similarity: textSimilarity(signal.originalText, otherSignal.originalText),
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.similarity - a.similarity)

  return { candidate, signal, author, media, location, assignment, category, likelyDuplicates }
}

export function buildAlertContext(db: WatchDatabase, alert: Alert): AlertWithContext {
  const signal = db.signals.find((s) => s.id === alert.signalId)!
  const author = db.authors.find((a) => a.id === signal?.authorId) ?? null
  const media = db.media.filter((m) => m.signalId === alert.signalId)
  const location = db.locations.find((l) => l.id === alert.locationId)!
  const assignment =
    db.operationalAssignments.find((a) => a.id === alert.operationalAssignmentId) ?? null
  const category = db.categories.find((c) => c.key === alert.categoryKey) ?? null
  const candidate = db.candidates.find((c) => c.id === alert.candidateAlertId)!

  const relatedSignalIds = new Set<string>()
  for (const dup of db.signalDuplicates) {
    if (dup.signalId === alert.signalId) relatedSignalIds.add(dup.duplicateOfSignalId)
    if (dup.duplicateOfSignalId === alert.signalId) relatedSignalIds.add(dup.signalId)
  }

  const relatedSignals = [...relatedSignalIds]
    .map((id) => {
      const related = db.signals.find((s) => s.id === id)
      if (!related) return null
      const link = db.signalDuplicates.find(
        (d) =>
          (d.signalId === alert.signalId && d.duplicateOfSignalId === id) ||
          (d.duplicateOfSignalId === alert.signalId && d.signalId === id),
      )
      return { signal: related, similarity: link?.similarity ?? 0, method: link?.method ?? 'unknown' }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.similarity - a.similarity)

  // The alert's audit trail includes its candidate's, so validation appears in
  // the alert's own history rather than only on a screen the SOC never opens.
  const auditTrail = db.auditEvents
    .filter(
      (e) =>
        (e.entityType === 'alert' && e.entityId === alert.id) ||
        (e.entityType === 'candidate_alert' && e.entityId === alert.candidateAlertId),
    )
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))

  return {
    alert,
    signal,
    author,
    media,
    location,
    assignment,
    category,
    candidate,
    evidence: db.alertEvidence.filter((e) => e.alertId === alert.id),
    assignments: db.alertAssignments.filter((a) => a.alertId === alert.id),
    acknowledgments: db.acknowledgments.filter((a) => a.alertId === alert.id),
    escalations: db.escalations.filter((e) => e.alertId === alert.id),
    dispositions: db.dispositions.filter((d) => d.alertId === alert.id),
    comments: sortBy(
      db.comments.filter((c) => c.alertId === alert.id),
      (c) => c.createdAt,
    ),
    deliveries: db.deliveries.filter((d) => d.alertId === alert.id),
    relatedSignals,
    auditTrail,
  }
}

export function selectCandidates(
  db: WatchDatabase,
  filter: CandidateFilter = {},
): CandidateWithContext[] {
  let candidates = db.candidates

  if (filter.statuses?.length) {
    candidates = candidates.filter((c) => filter.statuses!.includes(c.status))
  }
  if (filter.severities?.length) {
    candidates = candidates.filter((c) =>
      filter.severities!.includes(c.analystSeverity ?? c.automatedSeverity),
    )
  }
  if (filter.locationIds?.length) {
    candidates = candidates.filter((c) => c.locationId && filter.locationIds!.includes(c.locationId))
  }
  if (filter.categoryKeys?.length) {
    candidates = candidates.filter((c) =>
      filter.categoryKeys!.includes(c.analystCategoryKey ?? c.automatedCategoryKey),
    )
  }

  let contexts = candidates.map((c) => buildCandidateContext(db, c))

  if (filter.search?.trim()) {
    const term = filter.search.trim().toLowerCase()
    contexts = contexts.filter(
      (c) =>
        c.signal?.originalText.toLowerCase().includes(term) ||
        c.location?.officialName.toLowerCase().includes(term) ||
        c.author?.handle.toLowerCase().includes(term) ||
        c.category?.label.toLowerCase().includes(term),
    )
  }

  // Highest severity first, then priority score, then newest. This is the
  // analyst work order.
  return contexts.sort((a, b) => {
    const severityDelta =
      SEVERITY_RANK[b.candidate.analystSeverity ?? b.candidate.automatedSeverity] -
      SEVERITY_RANK[a.candidate.analystSeverity ?? a.candidate.automatedSeverity]
    if (severityDelta !== 0) return severityDelta
    const scoreDelta =
      b.candidate.automatedScore.priorityScore - a.candidate.automatedScore.priorityScore
    if (scoreDelta !== 0) return scoreDelta
    return Date.parse(b.candidate.createdAt) - Date.parse(a.candidate.createdAt)
  })
}

export function selectAlerts(db: WatchDatabase, filter: AlertFilter = {}): AlertWithContext[] {
  let alerts = db.alerts

  if (filter.statuses?.length) alerts = alerts.filter((a) => filter.statuses!.includes(a.status))
  if (filter.severities?.length) alerts = alerts.filter((a) => filter.severities!.includes(a.severity))
  if (filter.locationIds?.length) {
    alerts = alerts.filter((a) => filter.locationIds!.includes(a.locationId))
  }
  if (filter.assignmentIds?.length) {
    alerts = alerts.filter(
      (a) => a.operationalAssignmentId && filter.assignmentIds!.includes(a.operationalAssignmentId),
    )
  }
  if (filter.categoryKeys?.length) {
    alerts = alerts.filter((a) => filter.categoryKeys!.includes(a.categoryKey))
  }
  if (filter.acknowledgement === 'acknowledged') {
    alerts = alerts.filter((a) => a.acknowledgedAt !== null)
  } else if (filter.acknowledgement === 'unacknowledged') {
    alerts = alerts.filter((a) => a.acknowledgedAt === null)
  }
  if (filter.from) alerts = alerts.filter((a) => Date.parse(a.validatedAt) >= Date.parse(filter.from!))
  if (filter.to) alerts = alerts.filter((a) => Date.parse(a.validatedAt) <= Date.parse(filter.to!))

  let contexts = alerts.map((a) => buildAlertContext(db, a))

  if (filter.search?.trim()) {
    const term = filter.search.trim().toLowerCase()
    contexts = contexts.filter(
      (c) =>
        c.alert.title.toLowerCase().includes(term) ||
        c.alert.summary.toLowerCase().includes(term) ||
        c.signal?.originalText.toLowerCase().includes(term) ||
        c.location?.officialName.toLowerCase().includes(term) ||
        c.author?.handle.toLowerCase().includes(term),
    )
  }

  return contexts.sort((a, b) => {
    // Active before finished, then severity, then most recent.
    const aActive = ACTIVE_ALERT_STATUSES.includes(a.alert.status) ? 1 : 0
    const bActive = ACTIVE_ALERT_STATUSES.includes(b.alert.status) ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    const severityDelta = SEVERITY_RANK[b.alert.severity] - SEVERITY_RANK[a.alert.severity]
    if (severityDelta !== 0) return severityDelta
    return Date.parse(b.alert.validatedAt) - Date.parse(a.alert.validatedAt)
  })
}

export function buildOperationsSummary(db: WatchDatabase): OperationsSummary {
  const active = db.alerts.filter((a) => ACTIVE_ALERT_STATUSES.includes(a.status))

  const activeByLocation = db.locations.map((location) => ({
    location,
    active: active.filter((a) => a.locationId === location.id).length,
    total: db.alerts.filter((a) => a.locationId === location.id).length,
  }))

  // Detection-to-alert: source publication through to analyst validation.
  const latencies = db.alerts
    .map((a) => secondsBetween(a.publishedAt, a.validatedAt))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  const median =
    latencies.length === 0
      ? null
      : latencies.length % 2 === 1
        ? latencies[(latencies.length - 1) / 2]!
        : (latencies[latencies.length / 2 - 1]! + latencies[latencies.length / 2]!) / 2

  const liveFeed = active
    .sort((a, b) => {
      const severityDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      if (severityDelta !== 0) return severityDelta
      return Date.parse(b.validatedAt) - Date.parse(a.validatedAt)
    })
    .slice(0, 8)
    .map((a) => buildAlertContext(db, a))

  return {
    openCritical: active.filter((a) => a.severity === 'critical').length,
    openHigh: active.filter((a) => a.severity === 'high').length,
    unacknowledged: active.filter((a) => a.acknowledgedAt === null).length,
    awaitingReview: db.candidates.filter(
      (c) => c.status === 'pending_review' || c.status === 'under_review',
    ).length,
    activeByLocation: activeByLocation.sort((a, b) => b.active - a.active),
    recentActivity: [...db.auditEvents]
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .slice(0, 12),
    medianDetectionToAlertSeconds: median,
    liveFeed,
  }
}

export function buildReport(db: WatchDatabase, range: ReportRange): ReportSummary {
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  const inRange = (value: string) => {
    const t = Date.parse(value)
    return t >= from && t <= to
  }

  const signals = db.signals.filter((s) => inRange(s.ingestedAt))
  const candidates = db.candidates.filter((c) => inRange(c.createdAt))
  const alerts = db.alerts.filter((a) => inRange(a.validatedAt))

  const alertsBySeverity = SEVERITIES.map((severity) => ({
    severity,
    count: alerts.filter((a) => a.severity === severity).length,
  }))

  const alertsByLocation = db.locations
    .map((location) => ({
      locationId: location.id,
      locationName: location.officialName,
      count: alerts.filter((a) => a.locationId === location.id).length,
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)

  const alertsByCategory = db.categories
    .map((category) => ({
      categoryKey: category.key,
      label: category.label,
      count: alerts.filter((a) => a.categoryKey === category.key).length,
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)

  // False positive rate: of everything decided in the window, the share that
  // turned out not to be a real operational matter — analyst rejections plus
  // alerts the SOC dispositioned as false positives.
  const decided = candidates.filter((c) =>
    ['validated', 'rejected', 'duplicate', 'suppressed'].includes(c.status),
  )
  const rejected = decided.filter((c) => c.status === 'rejected').length
  const falsePositiveAlerts = alerts.filter((a) => a.disposition === 'false_positive').length
  const falsePositiveRate =
    decided.length === 0 ? 0 : ((rejected + falsePositiveAlerts) / decided.length) * 100

  const validationSeconds = alerts
    .map((a) => secondsBetween(a.detectedAt, a.validatedAt))
    .filter((v): v is number => v !== null)
  const notificationSeconds = alerts
    .map((a) => secondsBetween(a.validatedAt, a.firstNotifiedAt))
    .filter((v): v is number => v !== null)
  const acknowledgmentSeconds = alerts
    .map((a) => secondsBetween(a.firstNotifiedAt ?? a.validatedAt, a.acknowledgedAt))
    .filter((v): v is number => v !== null)

  return {
    range,
    signalsCollected: signals.length,
    candidatesGenerated: candidates.length,
    alertsValidated: alerts.length,
    alertsBySeverity,
    alertsByLocation,
    alertsByCategory,
    falsePositiveRate,
    averageValidationSeconds: average(validationSeconds),
    averageNotificationSeconds: average(notificationSeconds),
    averageAcknowledgmentSeconds: average(acknowledgmentSeconds),
    openIncidents: alerts.filter((a) => ACTIVE_ALERT_STATUSES.includes(a.status)).length,
    escalatedIncidents: alerts.filter((a) => a.escalatedAt !== null).length,
    items: alerts
      .map((a) => buildAlertContext(db, a))
      .sort((a, b) => Date.parse(b.alert.validatedAt) - Date.parse(a.alert.validatedAt)),
  }
}
