import { beforeEach, describe, expect, it } from 'vitest'
import type { Alert, CandidateAlert, ProtectedLocation, Signal } from '@/domain/types'
import { ORG_ID, PROGRAM_ID, seedLocations } from '@/data/seed/pilot'
import {
  WorkflowError,
  acknowledgeAlert,
  addComment,
  assignAlert,
  canAdminister,
  canGrantRole,
  canOperate,
  canValidate,
  changeAlertStatus,
  decideCandidate,
  editAssessment,
  escalateAlert,
  setDisposition,
  startReview,
  validateCandidate,
  type Actor,
  type WorkflowContext,
} from './workflow'

const NOW = '2026-03-14T18:45:00.000Z'

let counter = 0
const ctx: WorkflowContext = {
  now: NOW,
  newId: () => `generated-${(counter += 1)}`,
}

beforeEach(() => {
  counter = 0
})

function actorWith(role: Actor['role']): Actor {
  return { userId: `user-${role}`, role, fullName: `Test ${role}`, organizationId: ORG_ID }
}

const analyst = actorWith('analyst')
const socManager = actorWith('soc_manager')
const socOperator = actorWith('soc_operator')
const viewer = actorWith('viewer')

const location: ProtectedLocation = seedLocations[0]!

const signal: Signal = {
  id: 'signal-1',
  organizationId: ORG_ID,
  programId: PROGRAM_ID,
  collectionSourceId: null,
  authorId: 'author-1',
  sourcePlatform: 'Public web source',
  sourceRecordId: 'post-1',
  sourceUrl: 'https://example.com/post/1',
  originalText: 'Man with a gun in the parking lot at Costco #1487.',
  publishedAt: '2026-03-14T18:39:00.000Z',
  ingestedAt: '2026-03-14T18:41:00.000Z',
  collectionMethod: 'simulator',
  provenance: 'Simulator',
  contentHash: 'hash',
  rawPayload: {},
  sourceLatitude: null,
  sourceLongitude: null,
  hasPublicGeotag: false,
  language: 'en',
  isRetentionRestricted: false,
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: null,
  updatedBy: null,
}

function makeCandidate(overrides: Partial<CandidateAlert> = {}): CandidateAlert {
  return {
    id: 'candidate-1',
    organizationId: ORG_ID,
    programId: PROGRAM_ID,
    signalId: signal.id,
    locationId: location.id,
    operationalAssignmentId: 'assignment-1',
    status: 'pending_review',
    automatedCategoryKey: 'weapon_or_firearm',
    automatedSeverity: 'critical',
    automatedScore: {
      priorityScore: 84,
      severity: 'critical',
      breakdown: {
        threatSeverity: 90,
        locationConfidence: 92,
        immediacy: 95,
        sourceCredibility: 68,
        specificity: 55,
        corroboration: 20,
        operationalRelevance: 87,
      },
      factors: [],
      explanation: 'Automated explanation.',
      scorerId: 'deterministic-v1',
      scoredAt: NOW,
    },
    analystCategoryKey: null,
    analystSeverity: null,
    analystNotes: null,
    incidentLocation: {
      locationId: location.id,
      confidence: 92,
      method: 'store_number_mention',
      evidence: ['Text names Costco #1487.'],
      assessedBy: 'automated',
    },
    authorLocation: {
      status: 'unknown',
      statedLocation: null,
      confidence: 0,
      evidence: [],
      assessedBy: 'automated',
    },
    duplicateOfCandidateId: null,
    reviewStartedAt: null,
    reviewStartedBy: null,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    alertId: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: null,
    updatedBy: null,
    ...overrides,
  }
}

function makeAlert(): Alert {
  const { alert } = validateCandidate(
    makeCandidate(),
    signal,
    location,
    'Weapon or firearm',
    analyst,
    ctx,
  )
  return alert
}

// ---------------------------------------------------------------------------

describe('role permissions', () => {
  it('restricts validation to analysts and administrators', () => {
    expect(canValidate('analyst')).toBe(true)
    expect(canValidate('program_admin')).toBe(true)
    expect(canValidate('super_admin')).toBe(true)
    expect(canValidate('soc_manager')).toBe(false)
    expect(canValidate('soc_operator')).toBe(false)
    expect(canValidate('viewer')).toBe(false)
  })

  it('allows SOC operations for operational roles but not viewers', () => {
    expect(canOperate('soc_manager')).toBe(true)
    expect(canOperate('soc_operator')).toBe(true)
    expect(canOperate('analyst')).toBe(true)
    expect(canOperate('viewer')).toBe(false)
  })

  it('restricts administration to program and super administrators', () => {
    expect(canAdminister('program_admin')).toBe(true)
    expect(canAdminister('super_admin')).toBe(true)
    expect(canAdminister('soc_manager')).toBe(false)
    expect(canAdminister('analyst')).toBe(false)
    expect(canAdminister('viewer')).toBe(false)
  })

  it('only lets a super administrator mint another super administrator', () => {
    expect(canGrantRole('super_admin', 'super_admin')).toBe(true)
    expect(canGrantRole('program_admin', 'super_admin')).toBe(false)
    expect(canGrantRole('program_admin', 'analyst')).toBe(true)
    expect(canGrantRole('soc_manager', 'analyst')).toBe(false)
  })
})

describe('candidate review', () => {
  it('lets an analyst open a candidate for review', () => {
    const { candidate, events } = startReview(makeCandidate(), analyst, ctx)
    expect(candidate.status).toBe('under_review')
    expect(candidate.reviewStartedBy).toBe(analyst.userId)
    expect(events[0]?.action).toBe('candidate_alert.review_started')
  })

  it('refuses review by a SOC operator', () => {
    expect(() => startReview(makeCandidate(), socOperator, ctx)).toThrow(WorkflowError)
  })

  it('refuses review by a viewer', () => {
    expect(() => startReview(makeCandidate(), viewer, ctx)).toThrow(/not permitted/i)
  })

  it('keeps analyst edits separate from the automated assessment', () => {
    const original = makeCandidate()
    const { candidate } = editAssessment(
      original,
      { categoryKey: 'suspicious_activity', severity: 'moderate', notes: 'Weapon not visible in media.' },
      analyst,
      ctx,
    )

    expect(candidate.analystCategoryKey).toBe('suspicious_activity')
    expect(candidate.analystSeverity).toBe('moderate')
    // The automated assessment is untouched and still available for comparison.
    expect(candidate.automatedCategoryKey).toBe('weapon_or_firearm')
    expect(candidate.automatedSeverity).toBe('critical')
    expect(candidate.automatedScore).toEqual(original.automatedScore)
  })

  it('records an analyst location change as an analyst assessment', () => {
    const { candidate } = editAssessment(
      makeCandidate(),
      { locationId: seedLocations[1]!.id },
      analyst,
      ctx,
    )
    expect(candidate.incidentLocation.assessedBy).toBe('analyst')
    expect(candidate.incidentLocation.method).toBe('analyst_assigned')
    expect(candidate.incidentLocation.evidence.join(' ')).toMatch(/analyst review/i)
  })

  it('requires a reason when rejecting', () => {
    expect(() => decideCandidate(makeCandidate(), 'rejected', '  ', analyst, ctx)).toThrow(
      /reason is required/i,
    )
  })

  it('records rejection with an audit event', () => {
    const { candidate, events } = decideCandidate(
      makeCandidate(),
      'rejected',
      'Not related to a monitored location.',
      analyst,
      ctx,
    )
    expect(candidate.status).toBe('rejected')
    expect(candidate.decidedBy).toBe(analyst.userId)
    expect(events[0]?.action).toBe('candidate_alert.rejected')
    expect(events[0]?.detail.reason).toBe('Not related to a monitored location.')
  })

  it('records a duplicate decision with the candidate it duplicates', () => {
    const { candidate } = decideCandidate(
      makeCandidate(),
      'duplicate',
      'Same event already validated.',
      analyst,
      ctx,
      { duplicateOfCandidateId: 'candidate-original' },
    )
    expect(candidate.status).toBe('duplicate')
    expect(candidate.duplicateOfCandidateId).toBe('candidate-original')
  })

  it('will not re-decide a candidate that is already decided', () => {
    const decided = makeCandidate({ status: 'validated' })
    expect(() => decideCandidate(decided, 'rejected', 'change of mind', analyst, ctx)).toThrow(
      /already been decided/i,
    )
  })
})

describe('validateCandidate', () => {
  it('creates an operational alert and an audit trail', () => {
    const result = validateCandidate(
      makeCandidate(),
      signal,
      location,
      'Weapon or firearm',
      analyst,
      ctx,
    )

    expect(result.candidate.status).toBe('validated')
    expect(result.candidate.alertId).toBe(result.alert.id)
    expect(result.alert.status).toBe('open')
    expect(result.alert.severity).toBe('critical')
    expect(result.alert.validatedBy).toBe(analyst.userId)
    // Source timestamps are carried forward for latency reporting.
    expect(result.alert.publishedAt).toBe(signal.publishedAt)
    expect(result.alert.detectedAt).toBe(signal.ingestedAt)
    expect(result.events.map((e) => e.action)).toEqual([
      'candidate_alert.validated',
      'alert.created',
    ])
  })

  it('marks the incident location as an analyst assessment on the alert', () => {
    const result = validateCandidate(
      makeCandidate(),
      signal,
      location,
      'Weapon or firearm',
      analyst,
      ctx,
    )
    expect(result.alert.incidentLocation.assessedBy).toBe('analyst')
  })

  it('carries the analyst severity override onto the alert', () => {
    const candidate = makeCandidate({ analystSeverity: 'high', analystCategoryKey: 'suspicious_activity' })
    const result = validateCandidate(candidate, signal, location, 'Suspicious activity', analyst, ctx)
    expect(result.alert.severity).toBe('high')
    expect(result.alert.categoryKey).toBe('suspicious_activity')
    expect(result.events[0]?.detail.analystOverrode).toBe(true)
  })

  it('refuses validation by a SOC manager', () => {
    expect(() =>
      validateCandidate(makeCandidate(), signal, location, 'Weapon or firearm', socManager, ctx),
    ).toThrow(/not permitted/i)
  })

  it('refuses validation by a viewer', () => {
    expect(() =>
      validateCandidate(makeCandidate(), signal, location, 'Weapon or firearm', viewer, ctx),
    ).toThrow(/not permitted/i)
  })

  it('refuses validation without a confirmed location', () => {
    expect(() =>
      validateCandidate(
        makeCandidate({ locationId: null }),
        signal,
        location,
        'Weapon or firearm',
        analyst,
        ctx,
      ),
    ).toThrow(/without a confirmed location/i)
  })

  it('attaches the original source item as evidence', () => {
    const result = validateCandidate(
      makeCandidate(),
      signal,
      location,
      'Weapon or firearm',
      analyst,
      ctx,
    )
    expect(result.evidence[0]?.kind).toBe('source_item')
    expect(result.evidence[0]?.url).toBe(signal.sourceUrl)
  })
})

describe('SOC operations', () => {
  it('acknowledges an alert and records the response time', () => {
    const alert = { ...makeAlert(), firstNotifiedAt: '2026-03-14T18:45:00.000Z' }
    const later = { ...ctx, now: '2026-03-14T18:46:30.000Z' }
    const result = acknowledgeAlert(alert, 'SOC has eyes on it.', socManager, later)

    expect(result.alert.status).toBe('acknowledged')
    expect(result.alert.acknowledgedBy).toBe(socManager.userId)
    expect(result.acknowledgment.responseSeconds).toBe(90)
    expect(result.events[0]?.action).toBe('alert.acknowledged')
  })

  it('refuses acknowledgment by a viewer', () => {
    expect(() => acknowledgeAlert(makeAlert(), null, viewer, ctx)).toThrow(/read-only/i)
  })

  it('refuses a second acknowledgment', () => {
    const { alert } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    expect(() => acknowledgeAlert(alert, null, socOperator, ctx)).toThrow(/already been acknowledged/i)
  })

  it('assigns an alert', () => {
    const { alert } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    const result = assignAlert(alert, socOperator.userId, 'Test operator', 'Take point.', socManager, ctx)
    expect(result.alert.assignedTo).toBe(socOperator.userId)
    expect(result.alert.status).toBe('assigned')
    expect(result.events[0]?.action).toBe('alert.assigned')
  })

  it('records store and regional manager notification on escalation', () => {
    const { alert } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    const result = escalateAlert(
      alert,
      {
        level: 'client_regional',
        reason: 'Firearm confirmed on site.',
        notifiedParties: ['Regional manager', 'Store security'],
        storeManagerNotified: true,
        regionalManagerNotified: true,
      },
      socManager,
      ctx,
    )

    expect(result.alert.status).toBe('escalated')
    expect(result.escalation.storeManagerNotified).toBe(true)
    expect(result.escalation.regionalManagerNotified).toBe(true)
    expect(result.escalation.notifiedParties).toEqual(['Regional manager', 'Store security'])
    expect(result.events[0]?.detail.level).toBe('client_regional')
  })

  it('requires an escalation reason', () => {
    const { alert } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    expect(() =>
      escalateAlert(
        alert,
        {
          level: 'soc_supervisor',
          reason: '   ',
          notifiedParties: [],
          storeManagerNotified: false,
          regionalManagerNotified: false,
        },
        socManager,
        ctx,
      ),
    ).toThrow(/reason is required/i)
  })

  it('does not downgrade an escalated alert when it is assigned', () => {
    const { alert: acked } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    const { alert: escalated } = escalateAlert(
      acked,
      {
        level: 'soc_supervisor',
        reason: 'Needs supervisor attention.',
        notifiedParties: [],
        storeManagerNotified: false,
        regionalManagerNotified: false,
      },
      socManager,
      ctx,
    )
    const { alert: assigned } = assignAlert(escalated, socOperator.userId, 'Op', null, socManager, ctx)
    expect(assigned.status).toBe('escalated')
  })

  it('refuses to resolve an alert that was never acknowledged', () => {
    expect(() => changeAlertStatus(makeAlert(), 'resolved', socManager, ctx)).toThrow(
      /must be acknowledged/i,
    )
  })

  it('refuses to close an alert without a final disposition', () => {
    const { alert } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    const { alert: resolved } = changeAlertStatus(alert, 'resolved', socManager, ctx)
    expect(() => changeAlertStatus(resolved, 'closed', socManager, ctx)).toThrow(
      /final disposition/i,
    )
  })

  it('closes an alert once acknowledged, resolved and dispositioned', () => {
    const { alert: acked } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    const { alert: resolved } = changeAlertStatus(acked, 'resolved', socManager, ctx)
    const { alert: disposed } = setDisposition(
      resolved,
      'confirmed',
      'Police confirmed the subject was detained.',
      socManager,
      ctx,
    )
    const { alert: closed, events } = changeAlertStatus(disposed, 'closed', socManager, ctx)

    expect(closed.status).toBe('closed')
    expect(closed.disposition).toBe('confirmed')
    expect(closed.closedAt).toBe(ctx.now)
    expect(events[0]?.detail).toEqual({ from: 'resolved', to: 'closed' })
  })

  it('refuses any operation on a closed alert', () => {
    const { alert: acked } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    const { alert: disposed } = setDisposition(acked, 'resolved', 'Done.', socManager, ctx)
    const { alert: closed } = changeAlertStatus(disposed, 'closed', socManager, ctx)
    expect(() => assignAlert(closed, socOperator.userId, 'Op', null, socManager, ctx)).toThrow(
      /closed/i,
    )
  })

  it('attributes an analyst disposition to the analyst, not the SOC', () => {
    const { alert } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    const byAnalyst = setDisposition(alert, 'false_positive', 'Media shows a toy.', analyst, ctx)
    const bySoc = setDisposition(alert, 'false_positive', 'Media shows a toy.', socManager, ctx)
    expect(byAnalyst.record.assessedBy).toBe('analyst')
    expect(bySoc.record.assessedBy).toBe('soc')
  })

  it('requires a rationale for a disposition', () => {
    const { alert } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    expect(() => setDisposition(alert, 'confirmed', '', socManager, ctx)).toThrow(/rationale/i)
  })

  it('rejects an empty operational note', () => {
    expect(() => addComment(makeAlert(), '   ', 'operational_note', socManager, ctx)).toThrow(
      /cannot be empty/i,
    )
  })

  it('records an operational note with an audit event', () => {
    const { comment, events } = addComment(
      makeAlert(),
      'Store security reached by phone.',
      'operational_note',
      socOperator,
      ctx,
    )
    expect(comment.kind).toBe('operational_note')
    expect(comment.authorUserId).toBe(socOperator.userId)
    expect(events[0]?.action).toBe('alert.note_added')
  })
})

describe('audit events', () => {
  it('always record the acting user and their role', () => {
    const { events } = acknowledgeAlert(makeAlert(), null, socManager, ctx)
    expect(events[0]?.actorUserId).toBe(socManager.userId)
    expect(events[0]?.actorRole).toBe('soc_manager')
    expect(events[0]?.occurredAt).toBe(NOW)
    expect(events[0]?.organizationId).toBe(ORG_ID)
  })
})
