import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppRole, AlertStatus, Disposition } from '@/domain/enums'
import type {
  Alert,
  AlertWithContext,
  AuditEvent,
  CandidateAlert,
  CandidateWithContext,
  EscalationRule,
  NotificationDelivery,
  NotificationSubscription,
  PushSubscription,
  ScoringThreshold,
  Signal,
  SystemSettings,
} from '@/domain/types'
import { ingestSignal, type PipelineResult } from '@/services/ingestion/pipeline'
import type { ParsedSignalInput } from '@/services/ingestion/schema'
import { dispatchAlert } from '@/services/notifications/dispatch'
import type {
  AlertFilter,
  CandidateFilter,
  ChangeEvent,
  DataProvider,
  OperationsSummary,
  Page,
  ReferenceData,
  ReportRange,
  ReportSummary,
  SessionUser,
} from '../provider'
import { resolvePage } from '../provider'
import {
  buildAlertContext,
  buildOperationsSummary,
  buildReport,
  selectCandidates,
} from '../readModels'
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
import { DATABASE_VERSION, type WatchDatabase } from '../local/database'
import { getSupabaseClient, toCamel, toSnake } from './client'

/**
 * Supabase data provider.
 *
 * Reads the program's working set into an in-memory snapshot, then serves
 * every screen from the same read models the local provider uses. Writes go
 * straight to PostgreSQL and Row Level Security is the authority on what is
 * permitted — the workflow checks in `workflow.ts` run first only to give the
 * operator a readable error before a round trip.
 *
 * The snapshot approach suits the pilot's scale (one program, eight
 * assignments, thousands of signals). For a larger deployment the read paths
 * would move to server-side views or RPCs; the interface would not change.
 *
 * NOTE ON VERIFICATION: this path requires a deployed Supabase project with
 * the migrations applied and seeded users. It has not been executed against a
 * live database in this repository's test environment — the automated tests
 * cover the local provider. See docs/DEPLOYMENT.md for the verification steps
 * to run after first deployment.
 */

type Listener = (event: ChangeEvent) => void

const SNAPSHOT_TABLES = [
  ['organizations', 'organization'],
  ['programs', 'programs'],
  ['profiles', 'profiles'],
  ['user_roles', 'userRoles'],
  ['locations', 'locations'],
  ['location_aliases', 'aliases'],
  ['location_geofences', 'geofences'],
  ['location_contacts', 'contacts'],
  ['operational_assignments', 'operationalAssignments'],
  ['threat_categories', 'categories'],
  ['scoring_thresholds', 'thresholds'],
  ['escalation_rules', 'escalationRules'],
  ['integrations', 'integrations'],
  ['signals', 'signals'],
  ['signal_authors', 'authors'],
  ['signal_media', 'media'],
  ['signal_location_matches', 'locationMatches'],
  ['signal_duplicates', 'signalDuplicates'],
  ['candidate_alerts', 'candidates'],
  ['alerts', 'alerts'],
  ['alert_evidence', 'alertEvidence'],
  ['alert_assignments', 'alertAssignments'],
  ['alert_acknowledgments', 'acknowledgments'],
  ['alert_escalations', 'escalations'],
  ['alert_dispositions', 'dispositions'],
  ['alert_comments', 'comments'],
  ['notification_subscriptions', 'subscriptions'],
  ['notification_deliveries', 'deliveries'],
  ['audit_events', 'auditEvents'],
  ['push_subscriptions', 'pushSubscriptions'],
] as const

export class SupabaseDataProvider implements DataProvider {
  readonly mode = 'supabase' as const

  private client: SupabaseClient
  private snapshot: WatchDatabase | null = null
  private loading: Promise<WatchDatabase> | null = null
  private session: SessionUser | null = null
  private listeners = new Set<Listener>()
  private realtimeBound = false

  constructor() {
    this.client = getSupabaseClient()
  }

  // -- Session --------------------------------------------------------------

  listSignInOptions() {
    // Supabase mode authenticates against real accounts; there is no list of
    // one-click demo identities to offer.
    return []
  }

  async getSession(): Promise<SessionUser | null> {
    if (this.session) return this.session
    const { data } = await this.client.auth.getUser()
    if (!data.user) return null
    return this.hydrateSession(data.user.id, data.user.email ?? '')
  }

  private async hydrateSession(userId: string, email: string): Promise<SessionUser | null> {
    const [{ data: profileRow }, { data: roleRows }, { data: orgRows }, { data: programRows }] =
      await Promise.all([
        this.client.from('profiles').select('*').eq('user_id', userId).maybeSingle(),
        this.client.from('user_roles').select('*').eq('user_id', userId),
        this.client.from('organization_memberships').select('*').eq('user_id', userId),
        this.client.from('program_memberships').select('*').eq('user_id', userId),
      ])

    if (!profileRow) {
      throw new WorkflowError(
        'This account has no OpeniWatch profile. An administrator must create one before you can sign in.',
      )
    }

    const roles = (roleRows ?? []).map((r) => (r as { role: AppRole }).role)
    // Most privileged role wins when a user holds several.
    const precedence: AppRole[] = [
      'super_admin',
      'program_admin',
      'analyst',
      'soc_manager',
      'soc_operator',
      'viewer',
    ]
    const role = precedence.find((r) => roles.includes(r)) ?? 'viewer'

    const organizationId =
      (orgRows?.[0] as { organization_id?: string } | undefined)?.organization_id ??
      ((roleRows ?? []).find((r) => (r as { organization_id?: string }).organization_id) as
        | { organization_id?: string }
        | undefined)?.organization_id ??
      ''

    const profile = toCamel<{ fullName: string; timeZone: string }>(
      profileRow as Record<string, unknown>,
    )

    this.session = {
      userId,
      email,
      fullName: profile.fullName,
      role,
      organizationId,
      programIds: (programRows ?? []).map((p) => (p as { program_id: string }).program_id),
      timeZone: profile.timeZone,
    }
    return this.session
  }

  async signIn({ email, password }: { email: string; password?: string }): Promise<SessionUser> {
    if (!password) {
      throw new WorkflowError('A password is required when Supabase authentication is configured.')
    }
    const { data, error } = await this.client.auth.signInWithPassword({ email, password })
    if (error || !data.user) {
      throw new WorkflowError(error?.message ?? 'Sign-in failed.')
    }
    const session = await this.hydrateSession(data.user.id, data.user.email ?? email)
    if (!session) throw new WorkflowError('Sign-in succeeded but no profile could be loaded.')
    this.invalidate()
    return session
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut()
    this.session = null
    this.snapshot = null
    this.loading = null
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
    // The database generates UUIDs; ids created client-side are only used for
    // records the client inserts explicitly.
    return { now: new Date().toISOString(), newId: () => crypto.randomUUID() }
  }

  // -- Snapshot -------------------------------------------------------------

  private invalidate(): void {
    this.snapshot = null
    this.loading = null
  }

  private async load(): Promise<WatchDatabase> {
    if (this.snapshot) return this.snapshot
    if (this.loading) return this.loading

    this.loading = (async () => {
      const results = await Promise.all(
        SNAPSHOT_TABLES.map(([table]) => this.client.from(table).select('*')),
      )

      const db = {} as Record<string, unknown>
      SNAPSHOT_TABLES.forEach(([table, key], index) => {
        const { data, error } = results[index]!
        if (error) {
          throw new WorkflowError(`Failed to read ${table}: ${error.message}`)
        }
        const rows = (data ?? []).map((row) => toCamel(row as Record<string, unknown>))
        // Singleton tables collapse to the first visible row.
        if (key === 'organization' || key === 'thresholds') {
          db[key] = rows[0] ?? null
        } else {
          db[key] = rows
        }
      })

      db.version = DATABASE_VERSION
      // The snapshot type carries systemSettings; the table is read separately
      // by getSystemSettings(), so give the snapshot a permissive default.
      db.systemSettings = db.systemSettings ?? {
        organizationId: '',
        outboundNotificationsEnabled: true,
        outboundDisabledReason: null,
        outboundDisabledAt: null,
        outboundDisabledBy: null,
        autoEscalationEnabled: true,
        environmentLabel: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const snapshot = db as unknown as WatchDatabase

      // Candidate and alert JSON columns arrive flat; rebuild the nested
      // assessment shapes the read models and workflow expect.
      snapshot.candidates = snapshot.candidates.map(reshapeCandidate)
      snapshot.alerts = snapshot.alerts.map(reshapeAlert)

      this.snapshot = snapshot
      this.bindRealtime()
      return snapshot
    })()

    return this.loading
  }

  private bindRealtime(): void {
    if (this.realtimeBound) return
    this.realtimeBound = true

    // Realtime respects RLS, so a subscriber only receives rows it may read.
    this.client
      .channel('openiwatch-operations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, () =>
        this.emit({ type: 'alerts' }),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'candidate_alerts' }, () =>
        this.emit({ type: 'candidates' }),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notification_deliveries' },
        () => this.emit({ type: 'notifications' }),
      )
      .subscribe()
  }

  private emit(...events: ChangeEvent[]): void {
    this.invalidate()
    for (const listener of this.listeners) {
      for (const event of events) listener(event)
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
    return (await this.listCandidatesPage(filter)).items
  }

  async listAlerts(filter: AlertFilter = {}): Promise<AlertWithContext[]> {
    return (await this.listAlertsPage(filter)).items
  }

  /**
   * Server-side filtered and paged.
   *
   * PostgREST applies the filters, the ordering and the range, and returns an
   * exact count, so the browser receives one page rather than the table. The
   * matching rows' context (signal, author, location, evidence…) is then
   * hydrated from the reference snapshot and per-page child queries.
   */
  async listAlertsPage(filter: AlertFilter = {}): Promise<Page<AlertWithContext>> {
    const { limit, offset } = resolvePage(filter)
    const db = await this.load()

    let query = this.client
      .from('alerts')
      .select('id', { count: 'exact' })
      .order('validated_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (filter.statuses?.length) query = query.in('status', filter.statuses)
    if (filter.severities?.length) query = query.in('severity', filter.severities)
    if (filter.locationIds?.length) query = query.in('location_id', filter.locationIds)
    if (filter.assignmentIds?.length) {
      query = query.in('operational_assignment_id', filter.assignmentIds)
    }
    if (filter.categoryKeys?.length) query = query.in('category_key', filter.categoryKeys)
    if (filter.acknowledgement === 'acknowledged') query = query.not('acknowledged_at', 'is', null)
    if (filter.acknowledgement === 'unacknowledged') query = query.is('acknowledged_at', null)
    if (filter.from) query = query.gte('validated_at', filter.from)
    if (filter.to) query = query.lte('validated_at', filter.to)
    // Search runs server-side against the indexed title and summary. Source
    // text search would need a full-text index; see docs/PRODUCTION_READINESS.md.
    if (filter.search?.trim()) {
      const term = filter.search.trim().replace(/[%,()]/g, ' ')
      query = query.or(`title.ilike.%${term}%,summary.ilike.%${term}%`)
    }

    const { data, error, count } = await query
    if (error) throw new WorkflowError(`alerts: ${error.message}`)

    const ids = new Set((data ?? []).map((row) => (row as { id: string }).id))
    const items = db.alerts
      .filter((a) => ids.has(a.id))
      .sort((a, b) => Date.parse(b.validatedAt) - Date.parse(a.validatedAt))
      .map((a) => buildAlertContext(db, a))

    return {
      items,
      total: count ?? null,
      hasMore: count === null ? items.length === limit : offset + items.length < count,
      limit,
      offset,
    }
  }

  async listCandidatesPage(filter: CandidateFilter = {}): Promise<Page<CandidateWithContext>> {
    const { limit, offset } = resolvePage(filter)
    const db = await this.load()

    let query = this.client
      .from('candidate_alerts')
      .select('id', { count: 'exact' })
      .order('automated_priority_score', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (filter.statuses?.length) query = query.in('status', filter.statuses)
    if (filter.locationIds?.length) query = query.in('location_id', filter.locationIds)

    const { data, error, count } = await query
    if (error) throw new WorkflowError(`candidate_alerts: ${error.message}`)

    const ids = new Set((data ?? []).map((row) => (row as { id: string }).id))
    // Severity, category and free-text filters need the joined signal and the
    // analyst override, so they are applied to the fetched page.
    const items = selectCandidates(
      { ...db, candidates: db.candidates.filter((c) => ids.has(c.id)) },
      { ...filter, limit: undefined, offset: undefined },
    )

    return {
      items,
      total: count ?? null,
      hasMore: count === null ? items.length === limit : offset + items.length < count,
      limit,
      offset,
    }
  }

  async getAlert(alertId: string): Promise<AlertWithContext | null> {
    const db = await this.load()
    const alert = db.alerts.find((a) => a.id === alertId)
    return alert ? buildAlertContext(db, alert) : null
  }

  async getOperationsSummary(): Promise<OperationsSummary> {
    return buildOperationsSummary(await this.load())
  }

  async getReport(range: ReportRange): Promise<ReportSummary> {
    return buildReport(await this.load(), range)
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

  // -- Writes ---------------------------------------------------------------

  private async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return
    const { error } = await this.client.from(table).insert(rows.map(toSnake))
    if (error) throw new WorkflowError(`${table}: ${error.message}`)
  }

  private async update(
    table: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.client.from(table).update(toSnake(patch)).eq('id', id)
    if (error) throw new WorkflowError(`${table}: ${error.message}`)
  }

  private async writeAudit(events: AuditEvent[]): Promise<void> {
    await this.insert(
      'audit_events',
      events.map((e) => ({
        organizationId: e.organizationId,
        actorUserId: e.actorUserId,
        actorRole: e.actorRole,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        detail: e.detail,
        occurredAt: e.occurredAt,
      })),
    )
  }

  async ingestSignals(inputs: ParsedSignalInput[]): Promise<PipelineResult[]> {
    const db = await this.load()
    const actor = await this.requireActor()
    const program = db.programs[0]
    if (!program) throw new WorkflowError('No program is available for this account.')

    const results: PipelineResult[] = []
    const working = { ...db, signals: [...db.signals], authors: [...db.authors] }

    for (const input of inputs) {
      const result = ingestSignal(
        input,
        {
          organizationId: actor.organizationId,
          programId: program.id,
          locations: working.locations,
          aliases: working.aliases,
          geofences: working.geofences,
          assignments: working.operationalAssignments,
          categories: working.categories,
          thresholds: working.thresholds,
          recentSignals: working.signals,
          authors: working.authors,
        },
        this.ctx(),
      )
      results.push(result)
      if (!result.signal || !result.candidate) continue

      if (result.author && !working.authors.some((a) => a.id === result.author!.id)) {
        await this.insert('signal_authors', [stripAudit(result.author)])
        working.authors.push(result.author)
      }
      await this.insert('signals', [stripAudit(result.signal)])
      await this.insert('signal_media', result.media.map(stripAudit))
      await this.insert('signal_location_matches', result.matches.map(stripAudit))
      await this.insert('signal_duplicates', result.duplicates.map(stripAudit))
      await this.insert('candidate_alerts', [flattenCandidate(result.candidate)])
      working.signals.push(result.signal)
    }

    this.emit({ type: 'candidates' })
    return results
  }

  private async loadCandidate(candidateId: string): Promise<CandidateAlert> {
    const db = await this.load()
    const candidate = db.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new WorkflowError('Candidate alert not found.')
    return candidate
  }

  async startReview(candidateId: string): Promise<void> {
    const actor = await this.requireActor()
    const result = startReview(await this.loadCandidate(candidateId), actor, this.ctx())
    await this.update('candidate_alerts', candidateId, {
      status: result.candidate.status,
      reviewStartedAt: result.candidate.reviewStartedAt,
      reviewStartedBy: result.candidate.reviewStartedBy,
    })
    await this.writeAudit(result.events)
    this.emit({ type: 'candidates' })
  }

  async editAssessment(candidateId: string, edit: AssessmentEdit): Promise<void> {
    const actor = await this.requireActor()
    const result = editAssessment(await this.loadCandidate(candidateId), edit, actor, this.ctx())
    await this.update('candidate_alerts', candidateId, {
      analystCategoryKey: result.candidate.analystCategoryKey,
      analystSeverity: result.candidate.analystSeverity,
      analystNotes: result.candidate.analystNotes,
      locationId: result.candidate.locationId,
      operationalAssignmentId: result.candidate.operationalAssignmentId,
      incidentLocationConfidence: result.candidate.incidentLocation.confidence,
      incidentLocationMethod: result.candidate.incidentLocation.method,
      incidentLocationEvidence: result.candidate.incidentLocation.evidence,
      incidentLocationAssessedBy: result.candidate.incidentLocation.assessedBy,
    })
    await this.writeAudit(result.events)
    this.emit({ type: 'candidates' })
  }

  async decideCandidate(
    candidateId: string,
    decision: 'rejected' | 'duplicate' | 'suppressed',
    reason: string,
    options: { duplicateOfCandidateId?: string } = {},
  ): Promise<void> {
    const actor = await this.requireActor()
    const result = decideCandidate(
      await this.loadCandidate(candidateId),
      decision,
      reason,
      actor,
      this.ctx(),
      options,
    )
    await this.update('candidate_alerts', candidateId, {
      status: result.candidate.status,
      decidedAt: result.candidate.decidedAt,
      decidedBy: result.candidate.decidedBy,
      decisionReason: result.candidate.decisionReason,
      duplicateOfCandidateId: result.candidate.duplicateOfCandidateId,
    })
    await this.writeAudit(result.events)
    this.emit({ type: 'candidates' })
  }

  async validateCandidate(
    candidateId: string,
    options: { note?: string } = {},
  ): Promise<{ alertId: string }> {
    const db = await this.load()
    const actor = await this.requireActor()
    const ctx = this.ctx()

    const candidate = await this.loadCandidate(candidateId)
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

    const result = validateCandidate(
      options.note ? { ...candidate, analystNotes: options.note } : candidate,
      signal,
      location,
      category?.label ?? categoryKey,
      actor,
      ctx,
    )

    await this.insert('alerts', [flattenAlert(result.alert)])
    await this.insert('alert_evidence', result.evidence.map(stripAudit))
    await this.update('candidate_alerts', candidateId, {
      status: 'validated',
      decidedAt: result.candidate.decidedAt,
      decidedBy: result.candidate.decidedBy,
      decisionReason: result.candidate.decisionReason,
      analystNotes: result.candidate.analystNotes,
      alertId: result.alert.id,
    })
    await this.writeAudit(result.events)

    const outcomes = await dispatchAlert({
      alert: result.alert,
      locationLabel: `${location.officialName} — ${location.city}, ${location.state}`,
      subscriptions: db.subscriptions,
      escalationRules: db.escalationRules,
    })

    if (outcomes.length > 0) {
      await this.insert(
        'notification_deliveries',
        outcomes.map((o) => ({
          organizationId: result.alert.organizationId,
          alertId: result.alert.id,
          subscriptionId: o.subscriptionId,
          userId: o.userId,
          channel: o.channel,
          status: o.result.status,
          providerId: o.result.providerId,
          providerMessageId: o.result.providerMessageId,
          pathStep: o.pathStep,
          attemptedAt: ctx.now,
          deliveredAt: o.result.deliveredAt,
          detail: o.result.detail,
          isSimulated: o.result.isSimulated,
        })),
      )
      await this.update('alerts', result.alert.id, { firstNotifiedAt: ctx.now })
    }

    this.emit({ type: 'candidates' }, { type: 'alerts' }, { type: 'notifications' })
    return { alertId: result.alert.id }
  }

  private async loadAlert(alertId: string): Promise<Alert> {
    const db = await this.load()
    const alert = db.alerts.find((a) => a.id === alertId)
    if (!alert) throw new WorkflowError('Alert not found.')
    return alert
  }

  async acknowledgeAlert(alertId: string, note: string | null): Promise<void> {
    const actor = await this.requireActor()
    const result = acknowledgeAlert(await this.loadAlert(alertId), note, actor, this.ctx())
    await this.insert('alert_acknowledgments', [
      {
        alertId,
        acknowledgedBy: result.acknowledgment.acknowledgedBy,
        channel: result.acknowledgment.channel,
        note: result.acknowledgment.note,
        responseSeconds: result.acknowledgment.responseSeconds,
      },
    ])
    await this.update('alerts', alertId, {
      status: result.alert.status,
      acknowledgedAt: result.alert.acknowledgedAt,
      acknowledgedBy: result.alert.acknowledgedBy,
    })
    await this.writeAudit(result.events)
    this.emit({ type: 'alerts' }, { type: 'notifications' })
  }

  async assignAlert(alertId: string, assigneeUserId: string, note: string | null): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    const assignee = db.profiles.find((p) => p.userId === assigneeUserId)
    const result = assignAlert(
      await this.loadAlert(alertId),
      assigneeUserId,
      assignee?.fullName ?? 'Unknown user',
      note,
      actor,
      this.ctx(),
    )
    await this.insert('alert_assignments', [
      { alertId, assignedTo: assigneeUserId, assignedBy: actor.userId, note },
    ])
    await this.update('alerts', alertId, {
      status: result.alert.status,
      assignedTo: result.alert.assignedTo,
      assignedAt: result.alert.assignedAt,
    })
    await this.writeAudit(result.events)
    this.emit({ type: 'alerts' })
  }

  async escalateAlert(alertId: string, input: EscalationInput): Promise<void> {
    const actor = await this.requireActor()
    const result = escalateAlert(await this.loadAlert(alertId), input, actor, this.ctx())
    await this.insert('alert_escalations', [
      {
        alertId,
        level: input.level,
        escalatedBy: actor.userId,
        reason: input.reason,
        notifiedParties: input.notifiedParties,
        storeManagerNotified: input.storeManagerNotified,
        regionalManagerNotified: input.regionalManagerNotified,
      },
    ])
    await this.update('alerts', alertId, {
      status: result.alert.status,
      escalatedAt: result.alert.escalatedAt,
    })
    await this.writeAudit(result.events)
    this.emit({ type: 'alerts' })
  }

  async changeAlertStatus(alertId: string, status: AlertStatus): Promise<void> {
    const actor = await this.requireActor()
    const result = changeAlertStatus(await this.loadAlert(alertId), status, actor, this.ctx())
    await this.update('alerts', alertId, {
      status: result.alert.status,
      resolvedAt: result.alert.resolvedAt,
      resolvedBy: result.alert.resolvedBy,
      closedAt: result.alert.closedAt,
    })
    await this.writeAudit(result.events)
    this.emit({ type: 'alerts' })
  }

  async setDisposition(
    alertId: string,
    disposition: Disposition,
    rationale: string,
  ): Promise<void> {
    const actor = await this.requireActor()
    const result = setDisposition(
      await this.loadAlert(alertId),
      disposition,
      rationale,
      actor,
      this.ctx(),
    )
    await this.insert('alert_dispositions', [
      {
        alertId,
        disposition,
        setBy: actor.userId,
        rationale,
        assessedBy: result.record.assessedBy,
      },
    ])
    await this.update('alerts', alertId, { disposition, dispositionNotes: rationale })
    await this.writeAudit(result.events)
    this.emit({ type: 'alerts' })
  }

  async addComment(
    alertId: string,
    body: string,
    kind: 'operational_note' | 'analyst_note',
  ): Promise<void> {
    const actor = await this.requireActor()
    const result = addComment(await this.loadAlert(alertId), body, kind, actor, this.ctx())
    await this.insert('alert_comments', [
      { alertId, authorUserId: actor.userId, body, kind },
    ])
    await this.writeAudit(result.events)
    this.emit({ type: 'alerts' })
  }

  async markNotificationRead(deliveryId: string): Promise<void> {
    await this.update('notification_deliveries', deliveryId, {
      readAt: new Date().toISOString(),
    })
    this.emit({ type: 'notifications' })
  }

  // -- Administration -------------------------------------------------------

  async setUserRole(userId: string, role: AppRole): Promise<void> {
    const actor = await this.requireActor()
    requireAdminister(actor, 'change user roles')
    if (role === 'super_admin' && actor.role !== 'super_admin') {
      throw new WorkflowError('Only a super administrator may grant the super administrator role.')
    }
    const { error } = await this.client
      .from('user_roles')
      .update({ role })
      .eq('user_id', userId)
      .eq('organization_id', actor.organizationId)
    if (error) throw new WorkflowError(error.message)

    await this.writeAudit([
      {
        id: crypto.randomUUID(),
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'user_role.changed',
        entityType: 'user_role',
        entityId: userId,
        detail: { userId, role },
        occurredAt: new Date().toISOString(),
      },
    ])
    this.emit({ type: 'reference' })
  }

  async setCategoryActive(categoryKey: string, isActive: boolean): Promise<void> {
    const actor = await this.requireActor()
    requireAdminister(actor, 'change threat categories')
    const { error } = await this.client
      .from('threat_categories')
      .update({ is_active: isActive })
      .eq('key', categoryKey)
      .eq('organization_id', actor.organizationId)
    if (error) throw new WorkflowError(error.message)
    this.emit({ type: 'reference' })
  }

  async updateThresholds(patch: Partial<ScoringThreshold>): Promise<void> {
    const db = await this.load()
    const actor = await this.requireActor()
    requireAdminister(actor, 'change scoring thresholds')
    const next = { ...db.thresholds, ...patch }
    if (!(next.criticalMin > next.highMin && next.highMin > next.moderateMin)) {
      throw new WorkflowError(
        'Thresholds must descend: critical minimum above high, high above moderate.',
      )
    }
    await this.update('scoring_thresholds', db.thresholds.id, patch as Record<string, unknown>)
    this.emit({ type: 'reference' })
  }

  async updateEscalationRule(ruleId: string, patch: Partial<EscalationRule>): Promise<void> {
    const actor = await this.requireActor()
    requireAdminister(actor, 'change escalation rules')
    await this.update('escalation_rules', ruleId, patch as Record<string, unknown>)
    this.emit({ type: 'reference' })
  }

  async upsertSubscription(
    subscription: Partial<NotificationSubscription> & { id?: string },
  ): Promise<void> {
    const actor = await this.requireActor()
    const targetUserId = subscription.userId ?? actor.userId
    if (targetUserId !== actor.userId) {
      requireAdminister(actor, "change another user's notification subscriptions")
    }

    const row = toSnake({
      ...subscription,
      userId: targetUserId,
      organizationId: actor.organizationId,
      channels: subscription.channels?.length ? subscription.channels : ['in_app'],
    })
    const { error } = await this.client.from('notification_subscriptions').upsert(row)
    if (error) throw new WorkflowError(error.message)
    this.emit({ type: 'reference' })
  }

  async deleteSubscription(subscriptionId: string): Promise<void> {
    const { error } = await this.client
      .from('notification_subscriptions')
      .delete()
      .eq('id', subscriptionId)
    if (error) throw new WorkflowError(error.message)
    this.emit({ type: 'reference' })
  }

  // -- Web push -------------------------------------------------------------

  async listPushSubscriptions(): Promise<PushSubscription[]> {
    const session = await this.getSession()
    if (!session) return []
    const { data, error } = await this.client
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', session.userId)
      .order('created_at', { ascending: false })
    if (error) throw new WorkflowError(error.message)
    return (data ?? []).map((row) => toCamel<PushSubscription>(row as Record<string, unknown>))
  }

  async registerPushSubscription(input: {
    providerSubscriptionId: string
    deviceLabel: string
  }): Promise<void> {
    const actor = await this.requireActor()
    // Upsert on the provider id: re-registering the same browser refreshes the
    // row rather than accumulating duplicates.
    const { error } = await this.client.from('push_subscriptions').upsert(
      toSnake({
        organizationId: actor.organizationId,
        userId: actor.userId,
        provider: 'onesignal',
        providerSubscriptionId: input.providerSubscriptionId,
        deviceLabel: input.deviceLabel,
        isEnabled: true,
        revokedAt: null,
        lastSeenAt: new Date().toISOString(),
      }),
      { onConflict: 'provider,provider_subscription_id' },
    )
    if (error) throw new WorkflowError(error.message)
    this.emit({ type: 'reference' })
  }

  async removePushSubscription(subscriptionId: string): Promise<void> {
    const { error } = await this.client
      .from('push_subscriptions')
      .delete()
      .eq('id', subscriptionId)
    if (error) throw new WorkflowError(error.message)
    this.emit({ type: 'reference' })
  }

  // -- Organization controls ------------------------------------------------

  async getSystemSettings(): Promise<SystemSettings> {
    const actor = await this.requireActor()
    const { data, error } = await this.client
      .from('system_settings')
      .select('*')
      .eq('organization_id', actor.organizationId)
      .maybeSingle()
    if (error) throw new WorkflowError(error.message)
    if (!data) {
      return {
        organizationId: actor.organizationId,
        outboundNotificationsEnabled: true,
        outboundDisabledReason: null,
        outboundDisabledAt: null,
        outboundDisabledBy: null,
        autoEscalationEnabled: true,
        environmentLabel: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }
    return toCamel<SystemSettings>(data as Record<string, unknown>)
  }

  async setOutboundNotificationsEnabled(enabled: boolean, reason: string | null): Promise<void> {
    const actor = await this.requireActor()
    requireAdminister(actor, 'change the outbound notification kill switch')
    const now = new Date().toISOString()

    const { error } = await this.client
      .from('system_settings')
      .update(
        toSnake({
          outboundNotificationsEnabled: enabled,
          outboundDisabledReason: enabled ? null : reason,
          outboundDisabledAt: enabled ? null : now,
          outboundDisabledBy: enabled ? null : actor.userId,
        }),
      )
      .eq('organization_id', actor.organizationId)
    if (error) throw new WorkflowError(error.message)

    await this.writeAudit([
      {
        id: crypto.randomUUID(),
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: enabled ? 'outbound_notifications.enabled' : 'outbound_notifications.disabled',
        entityType: 'system_settings',
        entityId: actor.organizationId,
        detail: { reason },
        occurredAt: now,
      },
    ])
    this.emit({ type: 'reference' })
  }

  async setAutoEscalationEnabled(enabled: boolean): Promise<void> {
    const actor = await this.requireActor()
    requireAdminister(actor, 'change automatic escalation')
    const { error } = await this.client
      .from('system_settings')
      .update({ auto_escalation_enabled: enabled })
      .eq('organization_id', actor.organizationId)
    if (error) throw new WorkflowError(error.message)
    this.emit({ type: 'reference' })
  }

  async setLocationActive(locationId: string, isActive: boolean): Promise<void> {
    const actor = await this.requireActor()
    requireAdminister(actor, 'change location monitoring status')
    await this.update('locations', locationId, { isActive })
    this.emit({ type: 'reference' })
  }
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------
// The database stores the incident-location and author-location assessments as
// flat columns (so they can be indexed and constrained); the application uses
// nested objects. These functions translate between the two.

function reshapeCandidate(row: unknown): CandidateAlert {
  const r = row as Record<string, unknown> & CandidateAlert
  return {
    ...r,
    automatedScore:
      typeof r.automatedScore === 'string'
        ? JSON.parse(r.automatedScore as unknown as string)
        : r.automatedScore,
    incidentLocation: {
      locationId: (r.locationId as string) ?? null,
      confidence: (r as never as { incidentLocationConfidence: number }).incidentLocationConfidence ?? 0,
      method: (r as never as { incidentLocationMethod: never }).incidentLocationMethod ?? null,
      evidence: (r as never as { incidentLocationEvidence: string[] }).incidentLocationEvidence ?? [],
      assessedBy:
        (r as never as { incidentLocationAssessedBy: never }).incidentLocationAssessedBy ??
        'automated',
    },
    authorLocation: {
      status: (r as never as { authorLocationStatus: never }).authorLocationStatus ?? 'unknown',
      statedLocation: (r as never as { authorLocationStated: string }).authorLocationStated ?? null,
      confidence: (r as never as { authorLocationConfidence: number }).authorLocationConfidence ?? 0,
      evidence: (r as never as { authorLocationEvidence: never[] }).authorLocationEvidence ?? [],
      assessedBy:
        (r as never as { authorLocationAssessedBy: never }).authorLocationAssessedBy ?? 'automated',
    },
  }
}

function reshapeAlert(row: unknown): Alert {
  const r = row as Record<string, unknown> & Alert
  return {
    ...r,
    incidentLocation: {
      locationId: (r.locationId as string) ?? null,
      confidence: (r as never as { incidentLocationConfidence: number }).incidentLocationConfidence ?? 0,
      method: (r as never as { incidentLocationMethod: never }).incidentLocationMethod ?? null,
      evidence: (r as never as { incidentLocationEvidence: string[] }).incidentLocationEvidence ?? [],
      assessedBy:
        (r as never as { incidentLocationAssessedBy: never }).incidentLocationAssessedBy ?? 'analyst',
    },
    authorLocation: {
      status: (r as never as { authorLocationStatus: never }).authorLocationStatus ?? 'unknown',
      statedLocation: (r as never as { authorLocationStated: string }).authorLocationStated ?? null,
      confidence: (r as never as { authorLocationConfidence: number }).authorLocationConfidence ?? 0,
      evidence: (r as never as { authorLocationEvidence: never[] }).authorLocationEvidence ?? [],
      assessedBy:
        (r as never as { authorLocationAssessedBy: never }).authorLocationAssessedBy ?? 'analyst',
    },
  }
}

/**
 * Drops client-side audit columns the database fills in itself.
 *
 * Accepts any record shape: domain types are interfaces without index
 * signatures, so the parameter is widened at the boundary rather than every
 * caller casting.
 */
function stripAudit(record: object): Record<string, unknown> {
  const { createdAt: _c, updatedAt: _u, createdBy: _cb, updatedBy: _ub, ...rest } =
    record as Record<string, unknown>
  return rest
}

function flattenCandidate(candidate: CandidateAlert): Record<string, unknown> {
  const { incidentLocation, authorLocation, automatedScore, ...rest } = candidate
  return {
    ...stripAudit(rest as Record<string, unknown>),
    automatedScore,
    automatedPriorityScore: automatedScore.priorityScore,
    automatedExplanation: automatedScore.explanation,
    scorerId: automatedScore.scorerId,
    incidentLocationConfidence: incidentLocation.confidence,
    incidentLocationMethod: incidentLocation.method,
    incidentLocationEvidence: incidentLocation.evidence,
    incidentLocationAssessedBy: incidentLocation.assessedBy,
    authorLocationStatus: authorLocation.status,
    authorLocationStated: authorLocation.statedLocation,
    authorLocationConfidence: authorLocation.confidence,
    authorLocationEvidence: authorLocation.evidence,
    authorLocationAssessedBy: authorLocation.assessedBy,
  }
}

function flattenAlert(alert: Alert): Record<string, unknown> {
  const { incidentLocation, authorLocation, ...rest } = alert
  return {
    ...stripAudit(rest as Record<string, unknown>),
    incidentLocationConfidence: incidentLocation.confidence,
    incidentLocationMethod: incidentLocation.method,
    incidentLocationEvidence: incidentLocation.evidence,
    incidentLocationAssessedBy: incidentLocation.assessedBy,
    authorLocationStatus: authorLocation.status,
    authorLocationStated: authorLocation.statedLocation,
    authorLocationConfidence: authorLocation.confidence,
    authorLocationEvidence: authorLocation.evidence,
    authorLocationAssessedBy: authorLocation.assessedBy,
  }
}
