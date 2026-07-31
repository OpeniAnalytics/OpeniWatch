import type { AppRole, CandidateStatus, Disposition, Severity } from '@/domain/enums'
import type { AlertStatus, DeliveryChannel } from '@/domain/enums'
import type {
  Alert,
  AlertWithContext,
  AuditEvent,
  CandidateWithContext,
  EscalationRule,
  Integration,
  LocationAlias,
  LocationContact,
  LocationGeofence,
  NotificationDelivery,
  NotificationSubscription,
  OperationalAssignment,
  Organization,
  Profile,
  Program,
  ProtectedLocation,
  ScoringThreshold,
  Signal,
  ThreatCategory,
} from '@/domain/types'
import type { ParsedSignalInput } from '@/services/ingestion/schema'
import type { PipelineResult } from '@/services/ingestion/pipeline'
import type { Actor, AssessmentEdit, EscalationInput } from './workflow'

/**
 * The data access contract.
 *
 * Two implementations exist:
 *   - `local`    a browser-local provider seeded with the pilot data, used when
 *                no Supabase credentials are configured. It makes the full
 *                workflow demonstrable offline and is what the end-to-end tests
 *                run against.
 *   - `supabase` the deployed provider, using Supabase Auth, PostgreSQL,
 *                Realtime and Edge Functions.
 *
 * Both apply the same workflow rules from `workflow.ts`, so behaviour does not
 * diverge between a demo and a deployment.
 */

export interface SessionUser {
  userId: string
  email: string
  fullName: string
  role: AppRole
  organizationId: string
  programIds: string[]
  timeZone: string
}

export interface ReferenceData {
  organization: Organization
  programs: Program[]
  locations: ProtectedLocation[]
  aliases: LocationAlias[]
  geofences: LocationGeofence[]
  contacts: LocationContact[]
  assignments: OperationalAssignment[]
  categories: ThreatCategory[]
  thresholds: ScoringThreshold
  escalationRules: EscalationRule[]
  integrations: Integration[]
  profiles: Profile[]
  subscriptions: NotificationSubscription[]
}

export interface CandidateFilter {
  statuses?: CandidateStatus[]
  severities?: Severity[]
  locationIds?: string[]
  categoryKeys?: string[]
  search?: string
}

export interface AlertFilter {
  statuses?: AlertStatus[]
  severities?: Severity[]
  locationIds?: string[]
  assignmentIds?: string[]
  categoryKeys?: string[]
  /** 'acknowledged' | 'unacknowledged' | undefined for both. */
  acknowledgement?: 'acknowledged' | 'unacknowledged'
  from?: string
  to?: string
  search?: string
}

export interface OperationsSummary {
  openCritical: number
  openHigh: number
  unacknowledged: number
  awaitingReview: number
  activeByLocation: Array<{ location: ProtectedLocation; active: number; total: number }>
  recentActivity: AuditEvent[]
  /** Seconds from source publication to alert validation. */
  medianDetectionToAlertSeconds: number | null
  liveFeed: AlertWithContext[]
}

export interface ReportRange {
  from: string
  to: string
  label: string
}

export interface ReportSummary {
  range: ReportRange
  signalsCollected: number
  candidatesGenerated: number
  alertsValidated: number
  alertsBySeverity: Array<{ severity: Severity; count: number }>
  alertsByLocation: Array<{ locationId: string; locationName: string; count: number }>
  alertsByCategory: Array<{ categoryKey: string; label: string; count: number }>
  /** Share of decided candidates rejected or dispositioned as false positive. */
  falsePositiveRate: number
  averageValidationSeconds: number | null
  averageNotificationSeconds: number | null
  averageAcknowledgmentSeconds: number | null
  openIncidents: number
  escalatedIncidents: number
  /** Every alert in range, for CSV export. */
  items: AlertWithContext[]
}

export type ChangeEvent =
  | { type: 'candidates' }
  | { type: 'alerts' }
  | { type: 'notifications' }
  | { type: 'reference' }

export interface DataProvider {
  readonly mode: 'supabase' | 'local-demo'

  // -- Session --------------------------------------------------------------
  getSession(): Promise<SessionUser | null>
  /** Local demo: selects a seeded role. Supabase: email + password sign-in. */
  signIn(input: { email: string; password?: string }): Promise<SessionUser>
  signOut(): Promise<void>
  /** Local demo only: the seeded accounts offered on the sign-in screen. */
  listSignInOptions(): Array<{ email: string; fullName: string; role: AppRole; purpose: string }>

  // -- Reference ------------------------------------------------------------
  getReferenceData(): Promise<ReferenceData>

  // -- Read -----------------------------------------------------------------
  listCandidates(filter?: CandidateFilter): Promise<CandidateWithContext[]>
  listAlerts(filter?: AlertFilter): Promise<AlertWithContext[]>
  getAlert(alertId: string): Promise<AlertWithContext | null>
  getOperationsSummary(): Promise<OperationsSummary>
  getReport(range: ReportRange): Promise<ReportSummary>
  listSignals(limit?: number): Promise<Signal[]>
  listMyNotifications(): Promise<NotificationDelivery[]>
  listAuditEvents(limit?: number): Promise<AuditEvent[]>

  // -- Ingestion ------------------------------------------------------------
  ingestSignals(inputs: ParsedSignalInput[]): Promise<PipelineResult[]>

  // -- Analyst actions ------------------------------------------------------
  startReview(candidateId: string): Promise<void>
  editAssessment(candidateId: string, edit: AssessmentEdit): Promise<void>
  validateCandidate(candidateId: string, options?: { note?: string }): Promise<{ alertId: string }>
  decideCandidate(
    candidateId: string,
    decision: 'rejected' | 'duplicate' | 'suppressed',
    reason: string,
    options?: { duplicateOfCandidateId?: string },
  ): Promise<void>

  // -- SOC actions ----------------------------------------------------------
  acknowledgeAlert(alertId: string, note: string | null): Promise<void>
  assignAlert(alertId: string, assigneeUserId: string, note: string | null): Promise<void>
  escalateAlert(alertId: string, input: EscalationInput): Promise<void>
  changeAlertStatus(alertId: string, status: AlertStatus): Promise<void>
  setDisposition(alertId: string, disposition: Disposition, rationale: string): Promise<void>
  addComment(alertId: string, body: string, kind: 'operational_note' | 'analyst_note'): Promise<void>
  markNotificationRead(deliveryId: string): Promise<void>

  // -- Administration -------------------------------------------------------
  setUserRole(userId: string, role: AppRole): Promise<void>
  setCategoryActive(categoryKey: string, isActive: boolean): Promise<void>
  updateThresholds(patch: Partial<ScoringThreshold>): Promise<void>
  updateEscalationRule(ruleId: string, patch: Partial<EscalationRule>): Promise<void>
  upsertSubscription(subscription: Partial<NotificationSubscription> & { id?: string }): Promise<void>
  deleteSubscription(subscriptionId: string): Promise<void>
  setLocationActive(locationId: string, isActive: boolean): Promise<void>

  // -- Realtime -------------------------------------------------------------
  subscribe(listener: (event: ChangeEvent) => void): () => void

  // -- Demo utilities -------------------------------------------------------
  /** Local demo only: clears local state and reseeds. */
  resetDemoData?(): Promise<void>
}

/** Channels a user may realistically receive in Phase 1. */
export const SELECTABLE_CHANNELS: readonly DeliveryChannel[] = [
  'in_app',
  'web_push',
  'sms',
  'email',
  'microsoft_teams',
  'webhook',
]

export type { Actor, AssessmentEdit, EscalationInput }
export type { Alert, AlertWithContext, CandidateWithContext }
