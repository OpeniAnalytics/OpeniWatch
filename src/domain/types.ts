import type {
  AlertStatus,
  AppRole,
  AssessmentSource,
  AuthorLocationEvidenceKind,
  AuthorLocationStatus,
  CandidateStatus,
  CollectionMethod,
  ConnectorKind,
  DeliveryChannel,
  DeliveryStatus,
  Disposition,
  EscalationLevel,
  IntegrationStatus,
  LocationMatchMethod,
  Severity,
} from './enums'

/** ISO-8601 timestamp string. */
export type Timestamp = string
export type Uuid = string

/** Fields every persisted record carries. */
export interface AuditedRecord {
  id: Uuid
  createdAt: Timestamp
  updatedAt: Timestamp
  createdBy: Uuid | null
  updatedBy: Uuid | null
}

// ---------------------------------------------------------------------------
// Organizations and access
// ---------------------------------------------------------------------------

export interface Organization extends AuditedRecord {
  name: string
  slug: string
  /** Free-form contact for the security-services partner. */
  contactEmail: string | null
  isActive: boolean
}

export interface Program extends AuditedRecord {
  organizationId: Uuid
  name: string
  slug: string
  clientName: string | null
  description: string | null
  isActive: boolean
  /** Retention window for signals under this program, in days. Null = program default. */
  signalRetentionDays: number | null
}

export interface Profile extends AuditedRecord {
  /** Matches `auth.users.id` when Supabase authentication is configured. */
  userId: Uuid
  email: string
  fullName: string
  title: string | null
  phone: string | null
  timeZone: string
  isActive: boolean
}

export interface OrganizationMembership extends AuditedRecord {
  organizationId: Uuid
  userId: Uuid
  isPrimary: boolean
}

export interface ProgramMembership extends AuditedRecord {
  programId: Uuid
  userId: Uuid
}

export interface UserRole extends AuditedRecord {
  userId: Uuid
  role: AppRole
  /** Null organization = platform-wide (super_admin only). */
  organizationId: Uuid | null
  programId: Uuid | null
}

// ---------------------------------------------------------------------------
// Protected locations
// ---------------------------------------------------------------------------

export interface ProtectedLocation extends AuditedRecord {
  organizationId: Uuid
  programId: Uuid
  /** Warehouse or facility number exactly as the client writes it (e.g. "01147"). */
  facilityNumber: string
  officialName: string
  addressLine1: string
  addressLine2: string | null
  city: string
  county: string | null
  state: string
  postalCode: string
  countryCode: string
  latitude: number | null
  longitude: number | null
  timeZone: string
  /** How the coordinates were obtained. Phase 1 uses `seeded_approximate`. */
  geocodeSource: 'seeded_approximate' | 'geocoding_service' | 'manual' | 'ungeocoded'
  geocodedAt: Timestamp | null
  /**
   * How much trust the coordinates carry. Defaults to `unverified`; nothing in
   * the application may present an unverified coordinate as confirmed.
   */
  coordinateVerificationStatus:
    | 'unverified'
    | 'geocoded'
    | 'manually_verified'
    | 'disputed'
    | 'ambiguous'
  coordinateVerificationMethod: string | null
  coordinateVerifiedAt: Timestamp | null
  coordinateVerifiedBy: Uuid | null
  /** Radius of uncertainty in metres. Null means not assessed, not zero. */
  coordinateUncertaintyMeters: number | null
  addressAmbiguityNotes: string | null
  nearbyLandmarks: string[]
  storeFeatures: string[]
  notes: string | null
  isActive: boolean
}

export interface LocationAlias extends AuditedRecord {
  locationId: Uuid
  alias: string
  /** Why this alias exists — local name, colloquial reference, misspelling. */
  aliasType: 'local_reference' | 'colloquial' | 'legacy_name' | 'misspelling' | 'other'
}

export interface OperationalAssignment extends AuditedRecord {
  organizationId: Uuid
  programId: Uuid
  locationId: Uuid
  /** Assignment label from the client spreadsheet. */
  name: string
  /** Sequence within the program, used for stable ordering. */
  assignmentNumber: number
  coverageNotes: string | null
  isActive: boolean
}

export interface LocationGeofence extends AuditedRecord {
  locationId: Uuid
  name: string
  /** Phase 1 supports circular geofences only; polygon support is additive. */
  shape: 'circle'
  centerLatitude: number
  centerLongitude: number
  radiusMeters: number
  /** Property boundary vs. surrounding area of interest. */
  zone: 'property' | 'parking' | 'vicinity'
}

export interface LocationContact extends AuditedRecord {
  locationId: Uuid
  fullName: string
  role: string
  email: string | null
  phone: string | null
  /** Order in which contacts are notified. Lower is earlier. */
  notifyOrder: number
  isActive: boolean
}

// ---------------------------------------------------------------------------
// Collection and signals
// ---------------------------------------------------------------------------

export interface Integration extends AuditedRecord {
  organizationId: Uuid
  kind: ConnectorKind
  name: string
  status: IntegrationStatus
  /** Non-secret configuration only. Credentials live in environment variables. */
  config: Record<string, unknown>
  lastHealthCheckAt: Timestamp | null
  lastHealthCheckOk: boolean | null
  lastHealthCheckMessage: string | null
  isEnabled: boolean
}

export interface CollectionSource extends AuditedRecord {
  organizationId: Uuid
  integrationId: Uuid | null
  /** Platform label shown to operators, e.g. "Public web source". */
  platform: string
  name: string
  /** Opaque connector cursor for incremental pulls. */
  cursor: string | null
  cursorUpdatedAt: Timestamp | null
  isEnabled: boolean
}

export interface SignalAuthor extends AuditedRecord {
  organizationId: Uuid
  platform: string
  /** Public handle exactly as presented by the source. */
  handle: string
  displayName: string | null
  /**
   * Profile location string as published by the source. This is NOT the
   * author's current location and must never be presented as one.
   */
  profileLocationText: string | null
  profileUrl: string | null
  profileDescription: string | null
  /** Follower counts etc. as provided by the source; never inferred. */
  sourceProfileMetadata: Record<string, unknown>
  firstSeenAt: Timestamp
  lastSeenAt: Timestamp
}

export interface Signal extends AuditedRecord {
  organizationId: Uuid
  programId: Uuid
  collectionSourceId: Uuid | null
  authorId: Uuid | null
  /** Platform the item came from, e.g. "Public web source", "RSS", "Analyst". */
  sourcePlatform: string
  /** Identifier assigned by the source system. Unique per platform. */
  sourceRecordId: string
  sourceUrl: string | null
  originalText: string
  /** Timestamp published by the source. Never overwritten. */
  publishedAt: Timestamp
  /** When OpeniWatch collected the item. */
  ingestedAt: Timestamp
  collectionMethod: CollectionMethod
  /** Free-text chain of custody: who collected it and how. */
  provenance: string
  /** SHA-256 of normalized text + platform, used for duplicate detection. */
  contentHash: string
  /** Verbatim source payload, retained for audit. */
  rawPayload: Record<string, unknown>
  /** Coordinates supplied by the source, if any. */
  sourceLatitude: number | null
  sourceLongitude: number | null
  /** True when the source item carried an explicit public geotag. */
  hasPublicGeotag: boolean
  language: string | null
  isRetentionRestricted: boolean
}

export interface SignalMedia extends AuditedRecord {
  signalId: Uuid
  mediaType: 'image' | 'video' | 'document' | 'audio'
  /** External URL as provided by the source. Never proxied or re-hosted in Phase 1. */
  url: string
  thumbnailUrl: string | null
  caption: string | null
  /** Source-declared capture time, when available. */
  capturedAt: Timestamp | null
}

export interface SignalLocationMatch extends AuditedRecord {
  signalId: Uuid
  locationId: Uuid
  method: LocationMatchMethod
  /** 0-100. */
  confidence: number
  /** Human-readable evidence for this match. Shown to analysts verbatim. */
  evidence: string[]
  distanceMeters: number | null
  isPrimary: boolean
  /** Set when an analyst overrides the automated match. */
  assessedBy: AssessmentSource
}

export interface SignalDuplicate extends AuditedRecord {
  signalId: Uuid
  duplicateOfSignalId: Uuid
  /** 0-100 similarity. */
  similarity: number
  method: 'content_hash' | 'near_duplicate_text' | 'shared_media' | 'analyst_marked'
  notes: string | null
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  threatSeverity: number
  locationConfidence: number
  immediacy: number
  sourceCredibility: number
  specificity: number
  corroboration: number
  operationalRelevance: number
}

export interface ScoreFactor {
  /** Which sub-score this factor contributed to. */
  dimension: keyof ScoreBreakdown
  /** Signed contribution, for transparency. */
  delta: number
  reason: string
}

export interface CandidateScore {
  /** 0-100 final priority. */
  priorityScore: number
  severity: Severity
  breakdown: ScoreBreakdown
  factors: ScoreFactor[]
  /** Human-readable paragraph explaining the score. Stored with the candidate. */
  explanation: string
  /** Identifier of the scoring implementation, e.g. "deterministic-v1". */
  scorerId: string
  scoredAt: Timestamp
}

// ---------------------------------------------------------------------------
// Alert operations
// ---------------------------------------------------------------------------

/** An assessment of where the incident itself is occurring. */
export interface IncidentLocationAssessment {
  locationId: Uuid | null
  confidence: number
  method: LocationMatchMethod | null
  evidence: string[]
  assessedBy: AssessmentSource
}

/** A deliberately conservative assessment of where the author currently is. */
export interface AuthorLocationAssessment {
  status: AuthorLocationStatus
  /** Only populated when status !== 'unknown'. */
  statedLocation: string | null
  confidence: number
  evidence: AuthorLocationEvidenceRecord[]
  assessedBy: AssessmentSource
}

export interface AuthorLocationEvidenceRecord {
  kind: AuthorLocationEvidenceKind
  detail: string
  sourceUrl: string | null
}

export interface CandidateAlert extends AuditedRecord {
  organizationId: Uuid
  programId: Uuid
  signalId: Uuid
  locationId: Uuid | null
  operationalAssignmentId: Uuid | null
  status: CandidateStatus
  /** Automated classification. Never overwritten by analyst edits. */
  automatedCategoryKey: string
  automatedSeverity: Severity
  automatedScore: CandidateScore
  /** Analyst overrides. Null until an analyst edits the assessment. */
  analystCategoryKey: string | null
  analystSeverity: Severity | null
  analystNotes: string | null
  incidentLocation: IncidentLocationAssessment
  authorLocation: AuthorLocationAssessment
  /** Set when the candidate is marked duplicate. */
  duplicateOfCandidateId: Uuid | null
  reviewStartedAt: Timestamp | null
  reviewStartedBy: Uuid | null
  decidedAt: Timestamp | null
  decidedBy: Uuid | null
  decisionReason: string | null
  /** Populated when validation produced an operational alert. */
  alertId: Uuid | null
}

export interface Alert extends AuditedRecord {
  organizationId: Uuid
  programId: Uuid
  candidateAlertId: Uuid
  signalId: Uuid
  locationId: Uuid
  operationalAssignmentId: Uuid | null
  /** Short operational headline, e.g. "Firearm displayed in parking area". */
  title: string
  summary: string
  categoryKey: string
  severity: Severity
  status: AlertStatus
  priorityScore: number
  incidentLocation: IncidentLocationAssessment
  authorLocation: AuthorLocationAssessment
  /** Source item timestamps, carried forward for detection-latency reporting. */
  publishedAt: Timestamp
  detectedAt: Timestamp
  validatedAt: Timestamp
  validatedBy: Uuid
  firstNotifiedAt: Timestamp | null
  acknowledgedAt: Timestamp | null
  acknowledgedBy: Uuid | null
  assignedTo: Uuid | null
  assignedAt: Timestamp | null
  escalatedAt: Timestamp | null
  resolvedAt: Timestamp | null
  resolvedBy: Uuid | null
  closedAt: Timestamp | null
  disposition: Disposition | null
  dispositionNotes: string | null
  /** Optional deep link into the Spyglass strategic monitoring layer. */
  spyglassReference: string | null
}

export interface AlertEvidence extends AuditedRecord {
  alertId: Uuid
  signalId: Uuid | null
  kind: 'source_item' | 'media' | 'corroborating_signal' | 'analyst_attachment' | 'external_link'
  label: string
  url: string | null
  detail: string | null
}

export interface AlertAssignment extends AuditedRecord {
  alertId: Uuid
  assignedTo: Uuid
  assignedBy: Uuid
  note: string | null
  unassignedAt: Timestamp | null
}

export interface AlertAcknowledgment extends AuditedRecord {
  alertId: Uuid
  acknowledgedBy: Uuid
  channel: DeliveryChannel | 'web_app'
  note: string | null
  /** Seconds between first notification and this acknowledgment. */
  responseSeconds: number | null
}

export interface AlertEscalation extends AuditedRecord {
  alertId: Uuid
  level: EscalationLevel
  escalatedBy: Uuid
  reason: string
  /** Who was contacted, recorded by the SOC. Free text by design. */
  notifiedParties: string[]
  /** Explicitly records store / regional manager notification. */
  storeManagerNotified: boolean
  regionalManagerNotified: boolean
  resolvedAt: Timestamp | null
}

export interface AlertDisposition extends AuditedRecord {
  alertId: Uuid
  disposition: Disposition
  setBy: Uuid
  rationale: string
  /** Distinguishes an analyst assessment from an operational SOC decision. */
  assessedBy: AssessmentSource
}

export interface AlertComment extends AuditedRecord {
  alertId: Uuid
  authorUserId: Uuid
  body: string
  /** Operational notes are distinct from analyst assessment notes. */
  kind: 'operational_note' | 'analyst_note' | 'system'
}

export interface NotificationSubscription extends AuditedRecord {
  organizationId: Uuid
  userId: Uuid
  /** Any combination may be null, meaning "all within the broader scope". */
  programId: Uuid | null
  locationId: Uuid | null
  operationalAssignmentId: Uuid | null
  /** Empty array means all severities. */
  severities: Severity[]
  /** Empty array means all categories. */
  categoryKeys: string[]
  channels: DeliveryChannel[]
  /** Quiet hours are advisory in Phase 1; critical alerts always deliver. */
  quietHoursStart: string | null
  quietHoursEnd: string | null
  isActive: boolean
}

export interface NotificationDelivery extends AuditedRecord {
  organizationId: Uuid
  alertId: Uuid
  subscriptionId: Uuid | null
  userId: Uuid
  channel: DeliveryChannel
  status: DeliveryStatus
  /** Which provider handled it, e.g. "in-app", "development", "onesignal". */
  providerId: string
  providerMessageId: string | null
  /** Ordinal in the critical delivery path (1 = in-app, 2 = push, 3 = SMS). */
  pathStep: number
  attemptedAt: Timestamp
  deliveredAt: Timestamp | null
  acknowledgedAt: Timestamp | null
  /** Failure reason or simulation note. Never contains credentials. */
  detail: string | null
  /** True when no live provider credentials were configured. */
  isSimulated: boolean
  /** Marks in-app deliveries the user has seen. */
  readAt: Timestamp | null
}

export interface AuditEvent {
  id: Uuid
  organizationId: Uuid
  /** Never null in practice; null only for system-originated events. */
  actorUserId: Uuid | null
  actorRole: AppRole | 'system'
  /** e.g. "candidate_alert.validated", "alert.acknowledged". */
  action: string
  entityType: string
  entityId: Uuid
  /** Immutable snapshot of what changed. */
  detail: Record<string, unknown>
  occurredAt: Timestamp
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

export interface ThreatCategory extends AuditedRecord {
  organizationId: Uuid
  key: string
  label: string
  group: string
  baselineSeverity: Severity
  severityWeight: number
  description: string
  isActive: boolean
}

export interface ScoringThreshold extends AuditedRecord {
  organizationId: Uuid
  /** Minimum priority score for each severity band. */
  criticalMin: number
  highMin: number
  moderateMin: number
  /** Candidates below this score are auto-suppressed as non-operational. */
  autoSuppressBelow: number
  /** Minimum location confidence before a candidate may be auto-created. */
  minimumLocationConfidence: number
  scorerId: string
}

export interface EscalationRule extends AuditedRecord {
  organizationId: Uuid
  programId: Uuid | null
  severity: Severity
  /** Escalate if unacknowledged for this many seconds. */
  unacknowledgedSeconds: number
  escalateTo: EscalationLevel
  /** Ordered channel path attempted for this severity. */
  channelPath: DeliveryChannel[]
  isActive: boolean
}

// ---------------------------------------------------------------------------
// Composed read models used by the interface
// ---------------------------------------------------------------------------

export interface SignalWithContext {
  signal: Signal
  author: SignalAuthor | null
  media: SignalMedia[]
  matches: SignalLocationMatch[]
  duplicates: SignalDuplicate[]
}

export interface CandidateWithContext {
  candidate: CandidateAlert
  signal: Signal
  author: SignalAuthor | null
  media: SignalMedia[]
  location: ProtectedLocation | null
  assignment: OperationalAssignment | null
  category: ThreatCategory | null
  likelyDuplicates: Array<{ candidate: CandidateAlert; signal: Signal; similarity: number }>
}

export interface AlertWithContext {
  alert: Alert
  signal: Signal
  author: SignalAuthor | null
  media: SignalMedia[]
  location: ProtectedLocation
  assignment: OperationalAssignment | null
  category: ThreatCategory | null
  candidate: CandidateAlert
  evidence: AlertEvidence[]
  assignments: AlertAssignment[]
  acknowledgments: AlertAcknowledgment[]
  escalations: AlertEscalation[]
  dispositions: AlertDisposition[]
  comments: AlertComment[]
  deliveries: NotificationDelivery[]
  relatedSignals: Array<{ signal: Signal; similarity: number; method: string }>
  auditTrail: AuditEvent[]
}

// ---------------------------------------------------------------------------
// Web push and organization controls
// ---------------------------------------------------------------------------

/**
 * An opt-in web push registration.
 *
 * Holds only the provider's opaque subscription identifier plus a coarse device
 * label the operator can recognise. No fingerprint, no location, no advertising
 * identifier.
 */
export interface PushSubscription extends AuditedRecord {
  organizationId: Uuid
  userId: Uuid
  provider: 'onesignal'
  providerSubscriptionId: string
  deviceLabel: string | null
  isEnabled: boolean
  /** Set when the provider reports the registration is gone. */
  revokedAt: Timestamp | null
  lastSeenAt: Timestamp
}

/** Organization-level operational controls. */
export interface SystemSettings {
  organizationId: Uuid
  /**
   * Emergency stop for every outbound channel. In-app delivery continues:
   * silencing the application itself would hide alerts from the operators
   * looking straight at it.
   */
  outboundNotificationsEnabled: boolean
  outboundDisabledReason: string | null
  outboundDisabledAt: Timestamp | null
  outboundDisabledBy: Uuid | null
  autoEscalationEnabled: boolean
  /** Banner label, e.g. "Staging". Empty or null hides the banner. */
  environmentLabel: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}
