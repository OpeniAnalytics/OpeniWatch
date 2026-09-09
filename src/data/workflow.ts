import type { AppRole, CandidateStatus, Disposition, EscalationLevel, Severity } from '@/domain/enums'
import { ACTIVE_ALERT_STATUSES } from '@/domain/enums'
import type {
  Alert,
  AlertAcknowledgment,
  AlertAssignment,
  AlertComment,
  AlertDisposition,
  AlertEscalation,
  AlertEvidence,
  AuditEvent,
  CandidateAlert,
  NotificationDelivery,
  ProtectedLocation,
  Signal,
} from '@/domain/types'
import { secondsBetween } from '@/lib/utils'

/**
 * Alert workflow rules.
 *
 * Pure functions over records: given the current state and an actor, they
 * return the next state plus the audit events that must be recorded. Both the
 * browser-local provider and the Supabase provider apply the same rules, so a
 * demo and a deployment behave identically.
 *
 * Authorization is enforced here AND in the database. This layer gives an
 * immediate, readable error; Row Level Security is the boundary that actually
 * protects the data.
 */

export interface Actor {
  userId: string
  role: AppRole
  fullName: string
  organizationId: string
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/**
 * The signed-in user authenticated successfully but is not authorized to use
 * OpeniWatch.
 *
 * Distinct from every other failure on purpose. Authentication proves who
 * someone is; it says nothing about whether they may see a protected location's
 * alerts. A valid Microsoft account from a correctly configured Entra tenant
 * reaches this state, and must, until an administrator grants it a membership.
 *
 * The application shows a dedicated screen for this and loads no operational
 * data. It never creates the missing membership: silently self-provisioning on
 * first sign-in would mean anyone in the tenant could grant themselves access
 * simply by visiting the site.
 */
export class NotAuthorizedError extends Error {
  constructor(
    message: string,
    /** Address to show on the screen so the operator can quote it in a request. */
    readonly email: string,
  ) {
    super(message)
    this.name = 'NotAuthorizedError'
  }
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Analysts and program administrators only. Mirrors openiwatch.can_validate. */
export function canValidate(role: AppRole): boolean {
  return role === 'analyst' || role === 'program_admin' || role === 'super_admin'
}

/** SOC operational actions. Mirrors openiwatch.can_operate. */
export function canOperate(role: AppRole): boolean {
  return (
    role === 'soc_manager' ||
    role === 'soc_operator' ||
    role === 'analyst' ||
    role === 'program_admin' ||
    role === 'super_admin'
  )
}

/** Administration surface. Mirrors openiwatch.can_administer. */
export function canAdminister(role: AppRole): boolean {
  return role === 'program_admin' || role === 'super_admin'
}

/** Only a super administrator may grant or revoke the super admin role. */
export function canGrantRole(actorRole: AppRole, targetRole: AppRole): boolean {
  if (targetRole === 'super_admin') return actorRole === 'super_admin'
  return canAdminister(actorRole)
}

function requireValidate(actor: Actor, action: string): void {
  if (!canValidate(actor.role)) {
    throw new WorkflowError(
      `Your role (${actor.role}) is not permitted to ${action}. Only analysts and program administrators may validate or decide candidate alerts.`,
    )
  }
}

function requireOperate(actor: Actor, action: string): void {
  if (!canOperate(actor.role)) {
    throw new WorkflowError(
      `Your role (${actor.role}) is not permitted to ${action}. Viewers have read-only access.`,
    )
  }
}

export function requireAdminister(actor: Actor, action: string): void {
  if (!canAdminister(actor.role)) {
    throw new WorkflowError(
      `Your role (${actor.role}) is not permitted to ${action}. Only program administrators may change administration settings.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function auditEvent(
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
  now: string,
  id: string,
): AuditEvent {
  return {
    id,
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action,
    entityType,
    entityId,
    detail,
    occurredAt: now,
  }
}

// ---------------------------------------------------------------------------
// Candidate review
// ---------------------------------------------------------------------------

export interface WorkflowContext {
  now: string
  newId: () => string
}

/** The effective assessment: analyst override where present, automated otherwise. */
export function effectiveCategoryKey(candidate: CandidateAlert): string {
  return candidate.analystCategoryKey ?? candidate.automatedCategoryKey
}

export function effectiveSeverity(candidate: CandidateAlert): Severity {
  return candidate.analystSeverity ?? candidate.automatedSeverity
}

export function startReview(
  candidate: CandidateAlert,
  actor: Actor,
  ctx: WorkflowContext,
): { candidate: CandidateAlert; events: AuditEvent[] } {
  requireValidate(actor, 'open a candidate for review')
  if (candidate.status !== 'pending_review' && candidate.status !== 'under_review') {
    throw new WorkflowError(
      `This candidate has already been decided (${candidate.status}) and cannot be reopened.`,
    )
  }
  if (candidate.status === 'under_review' && candidate.reviewStartedBy !== actor.userId) {
    // Not an error: concurrent review is visible rather than blocked, so the
    // second analyst sees who else is looking at it.
    return { candidate, events: [] }
  }

  const next: CandidateAlert = {
    ...candidate,
    status: 'under_review',
    reviewStartedAt: ctx.now,
    reviewStartedBy: actor.userId,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    candidate: next,
    events: [
      auditEvent(
        actor,
        'candidate_alert.review_started',
        'candidate_alert',
        candidate.id,
        { previousStatus: candidate.status },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

export interface AssessmentEdit {
  categoryKey?: string
  severity?: Severity
  notes?: string
  locationId?: string | null
  operationalAssignmentId?: string | null
  incidentLocationConfidence?: number
  incidentLocationEvidence?: string[]
}

/**
 * Records an analyst's edits.
 *
 * Analyst values are written to the `analyst*` fields only. The automated
 * assessment is never overwritten, so the interface can always show both and
 * say which is which.
 */
export function editAssessment(
  candidate: CandidateAlert,
  edit: AssessmentEdit,
  actor: Actor,
  ctx: WorkflowContext,
): { candidate: CandidateAlert; events: AuditEvent[] } {
  requireValidate(actor, 'edit an assessment')

  const next: CandidateAlert = {
    ...candidate,
    analystCategoryKey: edit.categoryKey ?? candidate.analystCategoryKey,
    analystSeverity: edit.severity ?? candidate.analystSeverity,
    analystNotes: edit.notes ?? candidate.analystNotes,
    locationId: edit.locationId !== undefined ? edit.locationId : candidate.locationId,
    operationalAssignmentId:
      edit.operationalAssignmentId !== undefined
        ? edit.operationalAssignmentId
        : candidate.operationalAssignmentId,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  // An analyst changing the location makes it an analyst assessment, with the
  // analyst's own reasoning as evidence.
  if (edit.locationId !== undefined && edit.locationId !== candidate.locationId) {
    next.incidentLocation = {
      locationId: edit.locationId,
      confidence: edit.incidentLocationConfidence ?? 100,
      method: 'analyst_assigned',
      evidence: edit.incidentLocationEvidence ?? [
        `Location assigned by ${actor.fullName} during analyst review.`,
      ],
      assessedBy: 'analyst',
    }
  } else if (edit.incidentLocationConfidence !== undefined) {
    next.incidentLocation = {
      ...candidate.incidentLocation,
      confidence: edit.incidentLocationConfidence,
      evidence: edit.incidentLocationEvidence ?? candidate.incidentLocation.evidence,
      assessedBy: 'analyst',
    }
  }

  return {
    candidate: next,
    events: [
      auditEvent(
        actor,
        'candidate_alert.assessment_edited',
        'candidate_alert',
        candidate.id,
        {
          changes: edit,
          automatedCategoryKey: candidate.automatedCategoryKey,
          automatedSeverity: candidate.automatedSeverity,
        },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

const TERMINAL_STATUSES: CandidateStatus[] = ['validated', 'rejected', 'duplicate', 'suppressed']

/** Rejection, duplicate, wrong-location and suppression all land here. */
export function decideCandidate(
  candidate: CandidateAlert,
  decision: Extract<CandidateStatus, 'rejected' | 'duplicate' | 'suppressed'>,
  reason: string,
  actor: Actor,
  ctx: WorkflowContext,
  options: { duplicateOfCandidateId?: string } = {},
): { candidate: CandidateAlert; events: AuditEvent[] } {
  requireValidate(actor, 'decide a candidate alert')
  if (TERMINAL_STATUSES.includes(candidate.status)) {
    throw new WorkflowError(`This candidate has already been decided (${candidate.status}).`)
  }
  if (!reason.trim()) {
    throw new WorkflowError('A reason is required so the decision is auditable.')
  }

  const next: CandidateAlert = {
    ...candidate,
    status: decision,
    decidedAt: ctx.now,
    decidedBy: actor.userId,
    decisionReason: reason,
    duplicateOfCandidateId: options.duplicateOfCandidateId ?? candidate.duplicateOfCandidateId,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    candidate: next,
    events: [
      auditEvent(
        actor,
        `candidate_alert.${decision}`,
        'candidate_alert',
        candidate.id,
        { reason, previousStatus: candidate.status, ...options },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

export interface ValidationResult {
  candidate: CandidateAlert
  alert: Alert
  evidence: AlertEvidence[]
  events: AuditEvent[]
}

/**
 * Validation: promotes a candidate to an operational alert.
 *
 * This is the gate the whole product turns on, so it is restricted to analysts
 * and program administrators and always produces an audit event.
 */
export function validateCandidate(
  candidate: CandidateAlert,
  signal: Signal,
  location: ProtectedLocation,
  categoryLabel: string,
  actor: Actor,
  ctx: WorkflowContext,
  options: { title?: string; summary?: string; spyglassReference?: string | null } = {},
): ValidationResult {
  requireValidate(actor, 'validate a candidate alert')
  if (TERMINAL_STATUSES.includes(candidate.status)) {
    throw new WorkflowError(`This candidate has already been decided (${candidate.status}).`)
  }
  if (!candidate.locationId) {
    throw new WorkflowError(
      'A candidate cannot be validated without a confirmed location. Assign a monitored location first.',
    )
  }

  const severity = effectiveSeverity(candidate)
  const categoryKey = effectiveCategoryKey(candidate)
  const alertId = ctx.newId()

  const alert: Alert = {
    id: alertId,
    organizationId: candidate.organizationId,
    programId: candidate.programId,
    candidateAlertId: candidate.id,
    signalId: candidate.signalId,
    locationId: candidate.locationId,
    operationalAssignmentId: candidate.operationalAssignmentId,
    title: options.title ?? `${categoryLabel} — ${location.officialName}`,
    summary:
      options.summary ??
      `${categoryLabel} reported at ${location.officialName}, ${location.city}, ${location.state}.`,
    categoryKey,
    severity,
    status: 'open',
    priorityScore: candidate.automatedScore.priorityScore,
    // The incident-location assessment carried onto the alert is the analyst's,
    // because validation is an analyst act.
    incidentLocation: { ...candidate.incidentLocation, assessedBy: 'analyst' },
    authorLocation: { ...candidate.authorLocation },
    publishedAt: signal.publishedAt,
    detectedAt: signal.ingestedAt,
    validatedAt: ctx.now,
    validatedBy: actor.userId,
    firstNotifiedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    assignedTo: null,
    assignedAt: null,
    escalatedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    closedAt: null,
    disposition: null,
    dispositionNotes: null,
    spyglassReference: options.spyglassReference ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  }

  const evidence: AlertEvidence[] = [
    {
      id: ctx.newId(),
      alertId,
      signalId: signal.id,
      kind: 'source_item',
      label: `Original source item from ${signal.sourcePlatform}`,
      url: signal.sourceUrl,
      detail: signal.provenance,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    },
  ]

  const nextCandidate: CandidateAlert = {
    ...candidate,
    status: 'validated',
    decidedAt: ctx.now,
    decidedBy: actor.userId,
    decisionReason: candidate.analystNotes ?? 'Validated for operational distribution.',
    alertId,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    candidate: nextCandidate,
    alert,
    evidence,
    events: [
      auditEvent(
        actor,
        'candidate_alert.validated',
        'candidate_alert',
        candidate.id,
        {
          alertId,
          severity,
          categoryKey,
          automatedSeverity: candidate.automatedSeverity,
          automatedCategoryKey: candidate.automatedCategoryKey,
          analystOverrode:
            candidate.analystSeverity !== null || candidate.analystCategoryKey !== null,
        },
        ctx.now,
        ctx.newId(),
      ),
      auditEvent(
        actor,
        'alert.created',
        'alert',
        alertId,
        { candidateAlertId: candidate.id, severity, locationId: candidate.locationId },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

// ---------------------------------------------------------------------------
// SOC operations
// ---------------------------------------------------------------------------

function assertActive(alert: Alert, action: string): void {
  if (alert.status === 'closed') {
    throw new WorkflowError(`This alert is closed and cannot be ${action}.`)
  }
}

export function acknowledgeAlert(
  alert: Alert,
  note: string | null,
  actor: Actor,
  ctx: WorkflowContext,
): { alert: Alert; acknowledgment: AlertAcknowledgment; events: AuditEvent[] } {
  requireOperate(actor, 'acknowledge an alert')
  assertActive(alert, 'acknowledged')
  if (alert.acknowledgedAt) {
    throw new WorkflowError('This alert has already been acknowledged.')
  }

  const responseSeconds = secondsBetween(alert.firstNotifiedAt ?? alert.validatedAt, ctx.now)

  const acknowledgment: AlertAcknowledgment = {
    id: ctx.newId(),
    alertId: alert.id,
    acknowledgedBy: actor.userId,
    channel: 'web_app',
    note,
    responseSeconds: responseSeconds === null ? null : Math.round(responseSeconds),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  }

  const next: Alert = {
    ...alert,
    // Acknowledging does not undo an escalation.
    status: alert.status === 'open' ? 'acknowledged' : alert.status,
    acknowledgedAt: ctx.now,
    acknowledgedBy: actor.userId,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    alert: next,
    acknowledgment,
    events: [
      auditEvent(
        actor,
        'alert.acknowledged',
        'alert',
        alert.id,
        { responseSeconds: acknowledgment.responseSeconds, note },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

export function assignAlert(
  alert: Alert,
  assigneeUserId: string,
  assigneeName: string,
  note: string | null,
  actor: Actor,
  ctx: WorkflowContext,
): { alert: Alert; assignment: AlertAssignment; events: AuditEvent[] } {
  requireOperate(actor, 'assign an alert')
  assertActive(alert, 'assigned')

  const assignment: AlertAssignment = {
    id: ctx.newId(),
    alertId: alert.id,
    assignedTo: assigneeUserId,
    assignedBy: actor.userId,
    note,
    unassignedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  }

  const next: Alert = {
    ...alert,
    assignedTo: assigneeUserId,
    assignedAt: ctx.now,
    // Escalated and monitoring states outrank "assigned" and are preserved.
    status: alert.status === 'open' || alert.status === 'acknowledged' ? 'assigned' : alert.status,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    alert: next,
    assignment,
    events: [
      auditEvent(
        actor,
        'alert.assigned',
        'alert',
        alert.id,
        { assignedTo: assigneeUserId, assigneeName, note },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

export interface EscalationInput {
  level: EscalationLevel
  reason: string
  notifiedParties: string[]
  storeManagerNotified: boolean
  regionalManagerNotified: boolean
}

export function escalateAlert(
  alert: Alert,
  input: EscalationInput,
  actor: Actor,
  ctx: WorkflowContext,
): { alert: Alert; escalation: AlertEscalation; events: AuditEvent[] } {
  requireOperate(actor, 'escalate an alert')
  assertActive(alert, 'escalated')
  if (!input.reason.trim()) {
    throw new WorkflowError('An escalation reason is required.')
  }

  const escalation: AlertEscalation = {
    id: ctx.newId(),
    alertId: alert.id,
    level: input.level,
    escalatedBy: actor.userId,
    reason: input.reason,
    notifiedParties: input.notifiedParties,
    storeManagerNotified: input.storeManagerNotified,
    regionalManagerNotified: input.regionalManagerNotified,
    resolvedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  }

  const next: Alert = {
    ...alert,
    status: 'escalated',
    escalatedAt: ctx.now,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    alert: next,
    escalation,
    events: [
      auditEvent(
        actor,
        'alert.escalated',
        'alert',
        alert.id,
        {
          level: input.level,
          reason: input.reason,
          notifiedParties: input.notifiedParties,
          storeManagerNotified: input.storeManagerNotified,
          regionalManagerNotified: input.regionalManagerNotified,
        },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

export function changeAlertStatus(
  alert: Alert,
  status: Alert['status'],
  actor: Actor,
  ctx: WorkflowContext,
): { alert: Alert; events: AuditEvent[] } {
  requireOperate(actor, 'change an alert status')
  assertActive(alert, 'updated')

  if ((status === 'resolved' || status === 'closed') && !alert.acknowledgedAt) {
    throw new WorkflowError('An alert must be acknowledged before it can be resolved or closed.')
  }
  if (status === 'closed' && !alert.disposition) {
    throw new WorkflowError('Set a final disposition before closing the alert.')
  }

  const next: Alert = {
    ...alert,
    status,
    resolvedAt: status === 'resolved' ? ctx.now : alert.resolvedAt,
    resolvedBy: status === 'resolved' ? actor.userId : alert.resolvedBy,
    closedAt: status === 'closed' ? ctx.now : alert.closedAt,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    alert: next,
    events: [
      auditEvent(
        actor,
        `alert.status_changed`,
        'alert',
        alert.id,
        { from: alert.status, to: status },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

export function setDisposition(
  alert: Alert,
  disposition: Disposition,
  rationale: string,
  actor: Actor,
  ctx: WorkflowContext,
): { alert: Alert; record: AlertDisposition; events: AuditEvent[] } {
  requireOperate(actor, 'set a final disposition')
  if (!rationale.trim()) {
    throw new WorkflowError('A rationale is required so the disposition is auditable.')
  }

  const record: AlertDisposition = {
    id: ctx.newId(),
    alertId: alert.id,
    disposition,
    setBy: actor.userId,
    rationale,
    // An analyst recording a disposition is an analyst assessment; anyone else
    // in the SOC is recording an operational decision.
    assessedBy: actor.role === 'analyst' ? 'analyst' : 'soc',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  }

  const next: Alert = {
    ...alert,
    disposition,
    dispositionNotes: rationale,
    updatedAt: ctx.now,
    updatedBy: actor.userId,
  }

  return {
    alert: next,
    record,
    events: [
      auditEvent(
        actor,
        'alert.disposition_set',
        'alert',
        alert.id,
        { disposition, rationale, assessedBy: record.assessedBy },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

export function addComment(
  alert: Alert,
  body: string,
  kind: AlertComment['kind'],
  actor: Actor,
  ctx: WorkflowContext,
): { comment: AlertComment; events: AuditEvent[] } {
  requireOperate(actor, 'add a note')
  if (!body.trim()) {
    throw new WorkflowError('A note cannot be empty.')
  }

  const comment: AlertComment = {
    id: ctx.newId(),
    alertId: alert.id,
    authorUserId: actor.userId,
    body,
    kind,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  }

  return {
    comment,
    events: [
      auditEvent(
        actor,
        'alert.note_added',
        'alert',
        alert.id,
        { kind, excerpt: body.slice(0, 200) },
        ctx.now,
        ctx.newId(),
      ),
    ],
  }
}

/** Records the first notification attempt, which starts the acknowledgment clock. */
export function markFirstNotified(
  alert: Alert,
  deliveries: readonly NotificationDelivery[],
  ctx: WorkflowContext,
): Alert {
  if (alert.firstNotifiedAt || deliveries.length === 0) return alert
  const earliest = deliveries
    .map((d) => d.attemptedAt)
    .sort()
    .at(0)
  return { ...alert, firstNotifiedAt: earliest ?? ctx.now, updatedAt: ctx.now }
}

export function isActiveAlert(alert: Alert): boolean {
  return ACTIVE_ALERT_STATUSES.includes(alert.status)
}
