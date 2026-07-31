/**
 * Operational vocabulary for OpeniWatch.
 *
 * These values mirror the PostgreSQL enums declared in
 * `supabase/migrations/0001_core_schema.sql`. Keep the two in sync — the
 * migration is the source of truth for the database, this file is the source
 * of truth for the client.
 *
 * Record-type terminology is deliberate and NOT interchangeable:
 *   Signal          - a raw collected item.
 *   Candidate alert - a signal that may represent a threat to a location.
 *   Validated alert - a candidate approved by an analyst for distribution.
 *   Incident        - an alert acted upon by the SOC.
 *   Report item     - a signal/alert/incident included in recurring reporting.
 */

export const APP_ROLES = [
  'super_admin',
  'program_admin',
  'analyst',
  'soc_manager',
  'soc_operator',
  'viewer',
] as const
export type AppRole = (typeof APP_ROLES)[number]

export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: 'Super administrator',
  program_admin: 'Program administrator',
  analyst: 'Analyst',
  soc_manager: 'SOC manager',
  soc_operator: 'SOC operator',
  viewer: 'Viewer',
}

export const CANDIDATE_STATUSES = [
  'pending_review',
  'under_review',
  'validated',
  'rejected',
  'duplicate',
  'suppressed',
] as const
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  pending_review: 'Pending review',
  under_review: 'Under review',
  validated: 'Validated',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
  suppressed: 'Suppressed',
}

export const ALERT_STATUSES = [
  'open',
  'acknowledged',
  'assigned',
  'escalated',
  'monitoring',
  'resolved',
  'closed',
] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  escalated: 'Escalated',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  closed: 'Closed',
}

/** Statuses that mean the alert is still an active operational concern. */
export const ACTIVE_ALERT_STATUSES: readonly AlertStatus[] = [
  'open',
  'acknowledged',
  'assigned',
  'escalated',
  'monitoring',
]

export const SEVERITIES = ['critical', 'high', 'moderate', 'informational'] as const
export type Severity = (typeof SEVERITIES)[number]

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  informational: 'Informational',
}

/** Ascending order of operational urgency; used for sorting and comparisons. */
export const SEVERITY_RANK: Record<Severity, number> = {
  informational: 0,
  moderate: 1,
  high: 2,
  critical: 3,
}

export const DISPOSITIONS = [
  'confirmed',
  'credible_unconfirmed',
  'unconfirmed',
  'false_positive',
  'duplicate',
  'outdated',
  'wrong_location',
  'non_operational',
  'resolved',
] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  confirmed: 'Confirmed',
  credible_unconfirmed: 'Credible, unconfirmed',
  unconfirmed: 'Unconfirmed',
  false_positive: 'False positive',
  duplicate: 'Duplicate',
  outdated: 'Outdated',
  wrong_location: 'Wrong location',
  non_operational: 'Non-operational',
  resolved: 'Resolved',
}

/**
 * Author current location is a separate, deliberately conservative assessment.
 * It defaults to `unknown` and may only move off `unknown` when explicitly
 * supported by evidence recorded in `author_location_evidence`.
 */
export const AUTHOR_LOCATION_STATUSES = [
  'unknown',
  'unconfirmed',
  'reported_by_author',
  'geotagged',
  'visually_corroborated',
  'corroborated_by_source',
] as const
export type AuthorLocationStatus = (typeof AUTHOR_LOCATION_STATUSES)[number]

export const AUTHOR_LOCATION_STATUS_LABELS: Record<AuthorLocationStatus, string> = {
  unknown: 'Unknown',
  unconfirmed: 'Unconfirmed',
  reported_by_author: 'Stated by author',
  geotagged: 'Public geotag',
  visually_corroborated: 'Visually corroborated',
  corroborated_by_source: 'Corroborated by another public source',
}

/**
 * The only evidence kinds that may raise author current location off `unknown`.
 * Profile city, biography, historical posts and account metadata are explicitly
 * NOT on this list — see docs/SECURITY.md ("Privacy and intelligence standards").
 */
export const AUTHOR_LOCATION_EVIDENCE_KINDS = [
  'public_geotag',
  'coordinates_in_source',
  'contemporaneous_statement',
  'visual_evidence',
  'other_public_source',
] as const
export type AuthorLocationEvidenceKind = (typeof AUTHOR_LOCATION_EVIDENCE_KINDS)[number]

export const AUTHOR_LOCATION_EVIDENCE_LABELS: Record<AuthorLocationEvidenceKind, string> = {
  public_geotag: 'Public geotag on the source item',
  coordinates_in_source: 'Coordinates present in the source payload',
  contemporaneous_statement: 'Explicit contemporaneous statement by the author',
  visual_evidence: 'Verifiable visual evidence',
  other_public_source: 'Another documented public source',
}

/** How a location match was established, in descending order of strength. */
export const LOCATION_MATCH_METHODS = [
  'explicit_geotag',
  'coordinate_proximity',
  'store_number_mention',
  'address_mention',
  'alias_mention',
  'landmark_and_city',
  'city_and_brand',
  'analyst_assigned',
] as const
export type LocationMatchMethod = (typeof LOCATION_MATCH_METHODS)[number]

export const LOCATION_MATCH_METHOD_LABELS: Record<LocationMatchMethod, string> = {
  explicit_geotag: 'Explicit geotag',
  coordinate_proximity: 'Coordinate proximity',
  store_number_mention: 'Warehouse number mentioned',
  address_mention: 'Street address mentioned',
  alias_mention: 'Known alias mentioned',
  landmark_and_city: 'Landmark and city mentioned',
  city_and_brand: 'City and brand mentioned',
  analyst_assigned: 'Assigned by analyst',
}

export const COLLECTION_METHODS = [
  'manual_submission',
  'webhook',
  'connector_pull',
  'simulator',
] as const
export type CollectionMethod = (typeof COLLECTION_METHODS)[number]

export const COLLECTION_METHOD_LABELS: Record<CollectionMethod, string> = {
  manual_submission: 'Manual analyst submission',
  webhook: 'Secure webhook',
  connector_pull: 'Connector pull',
  simulator: 'Development simulator',
}

export const DELIVERY_CHANNELS = [
  'in_app',
  'web_push',
  'sms',
  'email',
  'microsoft_teams',
  'webhook',
] as const
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number]

export const DELIVERY_CHANNEL_LABELS: Record<DeliveryChannel, string> = {
  in_app: 'In-app notification',
  web_push: 'Web push',
  sms: 'SMS',
  email: 'Email',
  microsoft_teams: 'Microsoft Teams',
  webhook: 'Webhook',
}

export const DELIVERY_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'failed',
  'skipped',
  'simulated',
] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: 'Pending',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  skipped: 'Skipped',
  simulated: 'Simulated',
}

export const ESCALATION_LEVELS = [
  'soc_supervisor',
  'program_manager',
  'client_regional',
  'client_executive',
] as const
export type EscalationLevel = (typeof ESCALATION_LEVELS)[number]

export const ESCALATION_LEVEL_LABELS: Record<EscalationLevel, string> = {
  soc_supervisor: 'SOC supervisor',
  program_manager: 'Program manager',
  client_regional: 'Client regional management',
  client_executive: 'Client executive',
}

/** Who or what produced an assessment. Never blend these in the UI. */
export const ASSESSMENT_SOURCES = ['automated', 'analyst', 'soc'] as const
export type AssessmentSource = (typeof ASSESSMENT_SOURCES)[number]

export const ASSESSMENT_SOURCE_LABELS: Record<AssessmentSource, string> = {
  automated: 'Automated assessment',
  analyst: 'Analyst assessment',
  soc: 'SOC disposition',
}

export const CONNECTOR_KINDS = [
  'zignal',
  'rss',
  'public_safety',
  'manual',
  'generic_webhook',
  'simulator',
] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

export const INTEGRATION_STATUSES = [
  'implemented',
  'simulated',
  'stubbed',
  'requires_credentials',
  'requires_vendor_documentation',
] as const
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number]

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  implemented: 'Implemented',
  simulated: 'Simulated',
  stubbed: 'Stubbed',
  requires_credentials: 'Requires credentials',
  requires_vendor_documentation: 'Requires vendor documentation',
}
