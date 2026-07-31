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
  SignalAuthor,
  SignalDuplicate,
  SignalLocationMatch,
  SignalMedia,
  PushSubscription,
  SystemSettings,
  ThreatCategory,
  UserRole,
} from '@/domain/types'

/**
 * The browser-local database.
 *
 * A plain object of arrays, persisted to localStorage. It mirrors the
 * PostgreSQL schema table for table so the same read and write code shapes
 * work against either backend.
 */
export interface WatchDatabase {
  /** Bumped whenever the seed shape changes, which forces a reseed. */
  version: number
  organization: Organization
  programs: Program[]
  profiles: Profile[]
  userRoles: UserRole[]
  locations: ProtectedLocation[]
  aliases: LocationAlias[]
  geofences: LocationGeofence[]
  contacts: LocationContact[]
  operationalAssignments: OperationalAssignment[]
  categories: ThreatCategory[]
  thresholds: ScoringThreshold
  escalationRules: EscalationRule[]
  integrations: Integration[]
  signals: Signal[]
  authors: SignalAuthor[]
  media: SignalMedia[]
  locationMatches: SignalLocationMatch[]
  signalDuplicates: SignalDuplicate[]
  candidates: CandidateAlert[]
  alerts: Alert[]
  alertEvidence: AlertEvidence[]
  alertAssignments: AlertAssignment[]
  acknowledgments: AlertAcknowledgment[]
  escalations: AlertEscalation[]
  dispositions: AlertDisposition[]
  comments: AlertComment[]
  subscriptions: NotificationSubscription[]
  deliveries: NotificationDelivery[]
  auditEvents: AuditEvent[]
  pushSubscriptions: PushSubscription[]
  systemSettings: SystemSettings
}

export const DATABASE_VERSION = 4
export const STORAGE_KEY = 'openiwatch.demo.database.v4'
export const SESSION_KEY = 'openiwatch.demo.session'
