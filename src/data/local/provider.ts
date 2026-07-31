import type { AppRole, Severity } from '@/domain/enums'
import { SEVERITY_RANK } from '@/domain/enums'
import type {
  Alert,
  AlertWithContext,
  AuditEvent,
  CandidateAlert,
  CandidateWithContext,
  EscalationRule,
  NotificationDelivery,
  NotificationSubscription,
  ScoringThreshold,
  Signal,
} from '@/domain/types'
import { ingestSignal, type PipelineResult } from '@/services/ingestion/pipeline'
import type { ParsedSignalInput } from '@/services/ingestion/schema'
import { dispatchAlert } from '@/services/notifications/dispatch'
import {
  buildAlertContext,
  buildOperationsSummary,
  buildReport,
  selectAlerts,
  selectCandidates,
} from '../readModels'
import { ORG_ID, PROGRAM_ID } from '@/data/seed/pilot'
import { SEED_USERS } from '@/data/seed/users'
import type {
  AlertFilter,
  CandidateFilter,
  ChangeEvent,
  DataProvider,
  OperationsSummary,
  ReferenceData,
  ReportRange,
  ReportSummary,
  SessionUser,
} from '../provider'
import {
  WorkflowError,
  acknowledgeAlert,
  addComment,
  assignAlert,
  changeAlertStatus,
  decideCandidate,
  editAssessment,
  escalateAlert,
  requireAdminister,
  setDisposition,
  startReview,
  validateCandidate,
  type Actor,
  type AssessmentEdit,
  type EscalationInput,
} from '../workflow'
import { DATABASE_VERSION, SESSION_KEY, STORAGE_KEY, type WatchDatabase } from './database'
import { applyPipelineResult, recordDeliveries } from './mutations'
import { buildSeededDatabase } from './seedDatabase'

/**
 * Browser-local data provider.
 *
 * Used when no Supabase credentials are configured. It stores the pilot
 * database in localStorage and applies the same workflow rules as the Supabase
 * provider, so the complete Detect -> ... -> Report workflow is demonstrable
 * offline. The interface labels this mode plainly; it is never presented as a
 * live backend.
 */

let runtimeCounter = 0
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  runtimeCounter += 1
  return `local-${runtimeCounter}-${Date.now()}`
}

type Listener = (event: ChangeEvent) => void

export class LocalDataProvider implements DataProvider {
  readonly mode = 'local-demo' as const

  private db: WatchDatabase | null = null
  private session: SessionUser | null = null
  private listeners = new Set<Listener>()
  private loading: Promise<WatchDatabase> | null = null

  // -- Storage --------------------------------------------------------------

  private get storage(): Storage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      // Storage can throw in private browsing modes; the app still works
      // in-memory for the session.
      return null
    }
  }

  private async load(): Promise<WatchDatabase> {
    if (this.db) return this.db
    if (this.loading) return this.loading

    this.loading = (async () => {
      const raw = this.storage?.getItem(STORAGE_KEY)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as WatchDatabase
          if (parsed.version === DATABASE_VERSION) {
            this.db = parsed
            return parsed
          }
        } catch {
          // Corrupt or stale state falls through to a fresh seed.
        }
      }
      const seeded = await buildSeededDatabase()
      this.db = seeded
      this.persist()
      return seeded
    })()

    return this.loading
  }

  private persist(): void {
    if (!this.db) return
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.db))
    } catch {
      // Quota or private-mode failures are non-fatal: the session continues
      // in memory and the user is not blocked mid-incident.
    }
  }

  private emit(...events: ChangeEvent[]): void {
    this.persist()
    for (const listener of this.listeners) {
      for (const event of events) listener(event)
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // -- Session --------------------------------------------------------------

  listSignInOptions() {
    return SEED_USERS.map((u) => ({
      email: u.email,
      fullName: u.fullName,
      role: u.role,
      purpose: u.purpose,
    }))
  }

  async getSession(): Promise<SessionUser | null> {
    if (this.session) return this.session
    const raw = this.storage?.getItem(SESSION_KEY)
    if (!raw) return null
    try {
      this.session = JSON.parse(raw) as SessionUser
      return this.session
    } catch {
      return null
    }
  }

  async signIn({ email }: { email: string; password?: string }): Promise<SessionUser> {
    const user = SEED_USERS.find((u) => u.email.toLowerCase() === email.trim().toLowerCase())
    if (!user) {
      throw new WorkflowError(
        'Unknown account. Local demo mode signs in as one of the seeded roles.',
      )
    }
    const session: SessionUser = {
      userId: user.userId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      organizationId: ORG_ID,
      programIds: [PROGRAM_ID],
      timeZone: user.timeZone,
    }
    this.session = session
    try {
      this.storage?.setItem(SESSION_KEY, JSON.stringify(session))
    } catch {
      /* non-fatal */
    }
    return session
  }

  async signOut(): Promise<void> {
    this.session = null
    this.storage?.removeItem(SESSION_KEY)
  }

  private async requireActor(): Promise<Actor> {
    const session = await this.getSession()
    if (!session) throw new WorkflowError('You are not signed in.')
    return {
      userId: session.userId,
      role: session.role,
      fullName: session.fullName,
      organizationId: session.organizationId,
    }
  }

  private ctx() {
    return { now: new Date().toISOString(), newId }
  }

  // -- Reference ------------------------------------------------------------

  async getReferenceData(): Promise<ReferenceData> {
    const db = await this.load()
    return {
      organization: db.organization,
      programs: db.programs,
      locations: db.locations,
      aliases: db.aliases,
      geofences: db.geofences,
      contacts: db.contacts,
      assignments: db.operationalAssignments,
      categories: db.categories,
      thresholds: db.thresholds,
      escalationRules: db.escalationRules,
      integrations: db.integrations,
      profiles: db.profiles,
      subscriptions: db.subscriptions,
    }
  }

  // -- Read -----------------------------------------------------------------

  async listCandidates(filter: CandidateFilter = {}): Promise<CandidateWithContext[]> {
    return selectCandidates(await this.load(), filter)
  }

  private alertContext(db: WatchDatabase, alert: Alert): AlertWithContext {
    return buildAlertContext(db, alert)
  }

  async listAlerts(filter: AlertFilter = {}): Promise<AlertWithContext[]> {
    return selectAlerts(await this.load(), filter)
  }

  async getAlert(alertId: string): Promise<AlertWithContext | null> {
    const db = await this.load()
    const alert = db.alerts.find((a) => a.id === alertId)
    return alert ? this.alertContext(db, alert) : null
  }

  async listSignals(limit = 200): Promise<Signal[]> {
    const db = await this.load()
    return [...db.signals]
      .sort((a, b) => Date.parse(b.ingestedAt) - Date.parse(a.ingestedAt))
      .slice(0, limit)
  }

  async listMyNotifications(): Promise<NotificationDelivery[]> {
    const db = await this.load()
    const session = await this.getSession()
    if (!session) return []
    return db.deliveries
      .filter((d) => d.userId === session.userId)
      .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt))
  }

  async listAuditEvents(limit = 100): Promise<AuditEvent[]> {
    const db = await this.load()
    return [...db.auditEvents]
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .slice(0, limit)
  }

  async getOperationsSummary(): Promise<OperationsSummary> {
    return buildOperationsSummary(await this.load())
  }

  async getReport(range: ReportRange): Promise<ReportSummary> {
    return buildReport(await this.load(), range)
  }

  // -- Ingestion ------------------------------------------------------------

  async ingestSignals(inputs: ParsedSignalInput[]): Promise<PipelineResult[]> {
    const db = await this.load()
    const results: PipelineResult[] = []

    for (const input of inputs) {
      const result = ingestSignal(
        input,
        {
          organizationId: ORG_ID,
          programId: PROGRAM_ID,
          locations: db.locations,
          aliases: db.aliases,
          geofences: db.geofences,
          assignments: db.operationalAssignments,
          categories: db.categories,
          thresholds: db.thresholds,
          recentSignals: db.signals,
          authors: db.authors,
        },
        { now: new Date().toISOString(), newId },
      )
      applyPipelineResult(db, result)
      results.push(result)
    }

    this.emit({ type: 'candidates' })
    return results
  }

  // -- Analyst actions ------------------------------------------------------

  private async mutateCandidate(
    candidateId: string,
    fn: (
      candidate: CandidateAlert,
      db: WatchDatabase,
      actor: Actor,
      ctx: { now: string; newId: () => string },
    ) => { candidate: CandidateAlert; events: AuditEvent[] },
  ): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    const candidate = db.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new WorkflowError('Candidate alert not found.')

    const result = fn(candidate, db, actor, this.ctx())
    db.candidates = db.candidates.map((c) => (c.id === candidateId ? result.candidate : c))
    db.auditEvents.push(...result.events)
    this.emit({ type: 'candidates' })
  }

  async startReview(candidateId: string): Promise<void> {
    await this.mutateCandidate(candidateId, (candidate, _db, actor, ctx) =>
      startReview(candidate, actor, ctx),
    )
  }

  async editAssessment(candidateId: string, edit: AssessmentEdit): Promise<void> {
    await this.mutateCandidate(candidateId, (candidate, _db, actor, ctx) =>
      editAssessment(candidate, edit, actor, ctx),
    )
  }

  async decideCandidate(
    candidateId: string,
    decision: 'rejected' | 'duplicate' | 'suppressed',
    reason: string,
    options: { duplicateOfCandidateId?: string } = {},
  ): Promise<void> {
    await this.mutateCandidate(candidateId, (candidate, _db, actor, ctx) =>
      decideCandidate(candidate, decision, reason, actor, ctx, options),
    )
  }

  async validateCandidate(
    candidateId: string,
    options: { note?: string } = {},
  ): Promise<{ alertId: string }> {
    const db = await this.load()
    const actor = await this.requireActor()
    const ctx = this.ctx()

    const candidate = db.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new WorkflowError('Candidate alert not found.')
    const signal = db.signals.find((s) => s.id === candidate.signalId)
    if (!signal) throw new WorkflowError('The source signal for this candidate is missing.')
    const location = db.locations.find((l) => l.id === candidate.locationId)
    if (!location) {
      throw new WorkflowError(
        'A candidate cannot be validated without a confirmed location. Assign a monitored location first.',
      )
    }

    const categoryKey = candidate.analystCategoryKey ?? candidate.automatedCategoryKey
    const category = db.categories.find((c) => c.key === categoryKey)

    const withNote = options.note
      ? { ...candidate, analystNotes: options.note }
      : candidate

    const result = validateCandidate(
      withNote,
      signal,
      location,
      category?.label ?? categoryKey,
      actor,
      ctx,
    )

    db.candidates = db.candidates.map((c) => (c.id === candidateId ? result.candidate : c))
    db.alerts.push(result.alert)
    db.alertEvidence.push(...result.evidence)
    db.auditEvents.push(...result.events)

    // Deliver immediately so the SOC sees it without waiting for a job.
    const outcomes = await dispatchAlert({
      alert: result.alert,
      locationLabel: `${location.officialName} — ${location.city}, ${location.state}`,
      subscriptions: db.subscriptions,
      escalationRules: db.escalationRules,
    })
    recordDeliveries(db, result.alert, outcomes, newId, ctx.now)

    this.emit({ type: 'candidates' }, { type: 'alerts' }, { type: 'notifications' })
    return { alertId: result.alert.id }
  }

  // -- SOC actions ----------------------------------------------------------

  private async mutateAlert(
    alertId: string,
    fn: (
      alert: Alert,
      db: WatchDatabase,
      actor: Actor,
      ctx: { now: string; newId: () => string },
    ) => { alert?: Alert; events: AuditEvent[] },
  ): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    const alert = db.alerts.find((a) => a.id === alertId)
    if (!alert) throw new WorkflowError('Alert not found.')

    const result = fn(alert, db, actor, this.ctx())
    if (result.alert) {
      db.alerts = db.alerts.map((a) => (a.id === alertId ? result.alert! : a))
    }
    db.auditEvents.push(...result.events)
    this.emit({ type: 'alerts' })
  }

  async acknowledgeAlert(alertId: string, note: string | null): Promise<void> {
    await this.mutateAlert(alertId, (alert, db, actor, ctx) => {
      const result = acknowledgeAlert(alert, note, actor, ctx)
      db.acknowledgments.push(result.acknowledgment)
      // Mark this user's deliveries for the alert as acknowledged.
      db.deliveries = db.deliveries.map((d) =>
        d.alertId === alertId && d.userId === actor.userId
          ? { ...d, acknowledgedAt: ctx.now, readAt: d.readAt ?? ctx.now }
          : d,
      )
      return result
    })
    this.emit({ type: 'notifications' })
  }

  async assignAlert(alertId: string, assigneeUserId: string, note: string | null): Promise<void> {
    await this.mutateAlert(alertId, (alert, db, actor, ctx) => {
      const assignee = db.profiles.find((p) => p.userId === assigneeUserId)
      const result = assignAlert(
        alert,
        assigneeUserId,
        assignee?.fullName ?? 'Unknown user',
        note,
        actor,
        ctx,
      )
      db.alertAssignments.push(result.assignment)
      return result
    })
  }

  async escalateAlert(alertId: string, input: EscalationInput): Promise<void> {
    await this.mutateAlert(alertId, (alert, db, actor, ctx) => {
      const result = escalateAlert(alert, input, actor, ctx)
      db.escalations.push(result.escalation)
      return result
    })
  }

  async changeAlertStatus(alertId: string, status: Alert['status']): Promise<void> {
    await this.mutateAlert(alertId, (alert, _db, actor, ctx) =>
      changeAlertStatus(alert, status, actor, ctx),
    )
  }

  async setDisposition(
    alertId: string,
    disposition: Parameters<typeof setDisposition>[1],
    rationale: string,
  ): Promise<void> {
    await this.mutateAlert(alertId, (alert, db, actor, ctx) => {
      const result = setDisposition(alert, disposition, rationale, actor, ctx)
      db.dispositions.push(result.record)
      return result
    })
  }

  async addComment(
    alertId: string,
    body: string,
    kind: 'operational_note' | 'analyst_note',
  ): Promise<void> {
    await this.mutateAlert(alertId, (alert, db, actor, ctx) => {
      const result = addComment(alert, body, kind, actor, ctx)
      db.comments.push(result.comment)
      return { events: result.events }
    })
  }

  async markNotificationRead(deliveryId: string): Promise<void> {
    const db = await this.load()
    const now = new Date().toISOString()
    db.deliveries = db.deliveries.map((d) => (d.id === deliveryId ? { ...d, readAt: now } : d))
    this.emit({ type: 'notifications' })
  }

  // -- Administration -------------------------------------------------------

  async setUserRole(userId: string, role: AppRole): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    requireAdminister(actor, 'change user roles')
    if (role === 'super_admin' && actor.role !== 'super_admin') {
      throw new WorkflowError('Only a super administrator may grant the super administrator role.')
    }

    const ctx = this.ctx()
    db.userRoles = db.userRoles.map((r) =>
      r.userId === userId ? { ...r, role, updatedAt: ctx.now, updatedBy: actor.userId } : r,
    )
    db.auditEvents.push({
      id: newId(),
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'user_role.changed',
      entityType: 'user_role',
      entityId: userId,
      detail: { userId, role },
      occurredAt: ctx.now,
    })
    this.emit({ type: 'reference' })
  }

  async setCategoryActive(categoryKey: string, isActive: boolean): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    requireAdminister(actor, 'change threat categories')
    const ctx = this.ctx()

    db.categories = db.categories.map((c) =>
      c.key === categoryKey ? { ...c, isActive, updatedAt: ctx.now, updatedBy: actor.userId } : c,
    )
    db.auditEvents.push({
      id: newId(),
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: isActive ? 'threat_category.activated' : 'threat_category.deactivated',
      entityType: 'threat_category',
      entityId: categoryKey,
      detail: { categoryKey, isActive },
      occurredAt: ctx.now,
    })
    this.emit({ type: 'reference' })
  }

  async updateThresholds(patch: Partial<ScoringThreshold>): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    requireAdminister(actor, 'change scoring thresholds')
    const ctx = this.ctx()

    const next = { ...db.thresholds, ...patch, updatedAt: ctx.now, updatedBy: actor.userId }
    if (!(next.criticalMin > next.highMin && next.highMin > next.moderateMin)) {
      throw new WorkflowError(
        'Thresholds must descend: critical minimum above high, high above moderate.',
      )
    }
    db.thresholds = next

    db.auditEvents.push({
      id: newId(),
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'scoring_thresholds.updated',
      entityType: 'scoring_threshold',
      entityId: db.thresholds.id,
      detail: { patch },
      occurredAt: ctx.now,
    })
    this.emit({ type: 'reference' })
  }

  async updateEscalationRule(ruleId: string, patch: Partial<EscalationRule>): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    requireAdminister(actor, 'change escalation rules')
    const ctx = this.ctx()

    db.escalationRules = db.escalationRules.map((r) =>
      r.id === ruleId ? { ...r, ...patch, updatedAt: ctx.now, updatedBy: actor.userId } : r,
    )
    db.auditEvents.push({
      id: newId(),
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'escalation_rule.updated',
      entityType: 'escalation_rule',
      entityId: ruleId,
      detail: { patch },
      occurredAt: ctx.now,
    })
    this.emit({ type: 'reference' })
  }

  async upsertSubscription(
    subscription: Partial<NotificationSubscription> & { id?: string },
  ): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    const ctx = this.ctx()

    // A user may manage their own subscriptions; administrators may manage anyone's.
    const targetUserId = subscription.userId ?? actor.userId
    if (targetUserId !== actor.userId) {
      requireAdminister(actor, "change another user's notification subscriptions")
    }

    if (subscription.id && db.subscriptions.some((s) => s.id === subscription.id)) {
      db.subscriptions = db.subscriptions.map((s) =>
        s.id === subscription.id
          ? { ...s, ...subscription, updatedAt: ctx.now, updatedBy: actor.userId }
          : s,
      )
    } else {
      db.subscriptions.push({
        id: subscription.id ?? newId(),
        organizationId: actor.organizationId,
        userId: targetUserId,
        programId: subscription.programId ?? PROGRAM_ID,
        locationId: subscription.locationId ?? null,
        operationalAssignmentId: subscription.operationalAssignmentId ?? null,
        severities: subscription.severities ?? [],
        categoryKeys: subscription.categoryKeys ?? [],
        channels: subscription.channels?.length ? subscription.channels : ['in_app'],
        quietHoursStart: subscription.quietHoursStart ?? null,
        quietHoursEnd: subscription.quietHoursEnd ?? null,
        isActive: subscription.isActive ?? true,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
    }

    this.emit({ type: 'reference' })
  }

  async deleteSubscription(subscriptionId: string): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    const existing = db.subscriptions.find((s) => s.id === subscriptionId)
    if (!existing) return
    if (existing.userId !== actor.userId) {
      requireAdminister(actor, "delete another user's notification subscription")
    }
    db.subscriptions = db.subscriptions.filter((s) => s.id !== subscriptionId)
    this.emit({ type: 'reference' })
  }

  async setLocationActive(locationId: string, isActive: boolean): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    requireAdminister(actor, 'change location monitoring status')
    const ctx = this.ctx()

    db.locations = db.locations.map((l) =>
      l.id === locationId ? { ...l, isActive, updatedAt: ctx.now, updatedBy: actor.userId } : l,
    )
    db.auditEvents.push({
      id: newId(),
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: isActive ? 'location.monitoring_enabled' : 'location.monitoring_disabled',
      entityType: 'location',
      entityId: locationId,
      detail: { isActive },
      occurredAt: ctx.now,
    })
    this.emit({ type: 'reference' })
  }

  // -- Demo utilities -------------------------------------------------------

  async resetDemoData(): Promise<void> {
    this.db = await buildSeededDatabase()
    this.loading = null
    this.emit({ type: 'reference' }, { type: 'candidates' }, { type: 'alerts' }, { type: 'notifications' })
  }
}

/** Severity ordering helper reused by the interface. */
export function severityOrder(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a]
}
