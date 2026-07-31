import type { UserRole } from '@/domain/types'
import { signalInputSchema } from '@/services/ingestion/schema'
import { ingestSignal } from '@/services/ingestion/pipeline'
import { SIMULATION_SCENARIOS } from '@/simulator/scenarios'
import {
  ORG_ID,
  PROGRAM_ID,
  seedAssignments,
  seedEscalationRules,
  seedGeofences,
  seedLocationAliases,
  seedLocationContacts,
  seedLocations,
  seedOrganization,
  seedProgram,
  seedScoringThresholds,
  seedThreatCategories,
} from '@/data/seed/pilot'
import { SEED_USERS, seedProfiles, seedSubscriptions } from '@/data/seed/users'
import {
  acknowledgeAlert,
  addComment,
  assignAlert,
  changeAlertStatus,
  escalateAlert,
  setDisposition,
  validateCandidate,
  type Actor,
} from '@/data/workflow'
import { dispatchAlert } from '@/services/notifications/dispatch'
import { DATABASE_VERSION, type WatchDatabase } from './database'
import { applyPipelineResult, recordDeliveries } from './mutations'

/**
 * Builds the seeded demo database.
 *
 * Two kinds of content are seeded:
 *   1. A week of completed operational history so the reporting screens show
 *      real figures instead of placeholder metrics.
 *   2. Live candidates awaiting analyst review, so the queue is not empty.
 *
 * The Stafford firearm scenario is deliberately NOT seeded — it is the one an
 * operator runs from the simulator to walk the full workflow end to end.
 */

let idCounter = 0
function nextId(): string {
  idCounter += 1
  // Deterministic ids keep the seeded demo stable across reloads.
  return `seed-${idCounter.toString().padStart(6, '0')}`
}

const integrationSeeds: WatchDatabase['integrations'] = [
  {
    id: 'd0000000-0000-4000-8000-000000000001',
    organizationId: ORG_ID,
    kind: 'manual',
    name: 'Manual analyst submission',
    status: 'implemented',
    config: {},
    lastHealthCheckAt: null,
    lastHealthCheckOk: null,
    lastHealthCheckMessage: null,
    isEnabled: true,
    createdAt: '2026-01-06T09:00:00.000Z',
    updatedAt: '2026-01-06T09:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  },
  {
    id: 'd0000000-0000-4000-8000-000000000002',
    organizationId: ORG_ID,
    kind: 'generic_webhook',
    name: 'Secure ingest webhook',
    status: 'implemented',
    config: { endpoint: '/functions/v1/ingest-signal', auth: 'shared secret header' },
    lastHealthCheckAt: null,
    lastHealthCheckOk: null,
    lastHealthCheckMessage: null,
    isEnabled: true,
    createdAt: '2026-01-06T09:00:00.000Z',
    updatedAt: '2026-01-06T09:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  },
  {
    id: 'd0000000-0000-4000-8000-000000000003',
    organizationId: ORG_ID,
    kind: 'simulator',
    name: 'Development signal simulator',
    status: 'simulated',
    config: { scenarios: SIMULATION_SCENARIOS.length },
    lastHealthCheckAt: null,
    lastHealthCheckOk: null,
    lastHealthCheckMessage: null,
    isEnabled: true,
    createdAt: '2026-01-06T09:00:00.000Z',
    updatedAt: '2026-01-06T09:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  },
  {
    id: 'd0000000-0000-4000-8000-000000000004',
    organizationId: ORG_ID,
    kind: 'zignal',
    name: 'Zignal / Spyglass',
    status: 'requires_vendor_documentation',
    config: {
      note: 'Endpoint paths, auth scheme and payload shape must come from vendor documentation. No endpoints are fabricated in this codebase.',
    },
    lastHealthCheckAt: null,
    lastHealthCheckOk: null,
    lastHealthCheckMessage: null,
    isEnabled: false,
    createdAt: '2026-01-06T09:00:00.000Z',
    updatedAt: '2026-01-06T09:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  },
  {
    id: 'd0000000-0000-4000-8000-000000000005',
    organizationId: ORG_ID,
    kind: 'rss',
    name: 'RSS / news feeds',
    status: 'requires_credentials',
    config: { note: 'Set RSS_FEED_URLS to activate.' },
    lastHealthCheckAt: null,
    lastHealthCheckOk: null,
    lastHealthCheckMessage: null,
    isEnabled: false,
    createdAt: '2026-01-06T09:00:00.000Z',
    updatedAt: '2026-01-06T09:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  },
  {
    id: 'd0000000-0000-4000-8000-000000000006',
    organizationId: ORG_ID,
    kind: 'public_safety',
    name: 'Public safety feed',
    status: 'requires_credentials',
    config: { note: 'Requires an agency-provided endpoint and key.' },
    lastHealthCheckAt: null,
    lastHealthCheckOk: null,
    lastHealthCheckMessage: null,
    isEnabled: false,
    createdAt: '2026-01-06T09:00:00.000Z',
    updatedAt: '2026-01-06T09:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  },
]

function emptyDatabase(): WatchDatabase {
  const userRoles: UserRole[] = SEED_USERS.map((user, index) => ({
    id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    userId: user.userId,
    role: user.role,
    // The super administrator is platform-wide; everyone else is scoped.
    organizationId: user.role === 'super_admin' ? null : ORG_ID,
    programId: null,
    createdAt: '2026-01-06T09:00:00.000Z',
    updatedAt: '2026-01-06T09:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  }))

  return {
    version: DATABASE_VERSION,
    organization: seedOrganization,
    programs: [seedProgram],
    profiles: [...seedProfiles],
    userRoles,
    locations: [...seedLocations],
    aliases: [...seedLocationAliases],
    geofences: [...seedGeofences],
    contacts: [...seedLocationContacts],
    operationalAssignments: [...seedAssignments],
    categories: [...seedThreatCategories],
    thresholds: seedScoringThresholds,
    escalationRules: [...seedEscalationRules],
    integrations: integrationSeeds,
    signals: [],
    authors: [],
    media: [],
    locationMatches: [],
    signalDuplicates: [],
    candidates: [],
    alerts: [],
    alertEvidence: [],
    alertAssignments: [],
    acknowledgments: [],
    escalations: [],
    dispositions: [],
    comments: [],
    subscriptions: [...seedSubscriptions],
    deliveries: [],
    auditEvents: [],
    pushSubscriptions: [],
    systemSettings: {
      organizationId: ORG_ID,
      outboundNotificationsEnabled: true,
      outboundDisabledReason: null,
      outboundDisabledAt: null,
      outboundDisabledBy: null,
      autoEscalationEnabled: true,
      environmentLabel: null,
      createdAt: '2026-01-06T09:00:00.000Z',
      updatedAt: '2026-01-06T09:00:00.000Z',
    },
  }
}

function actorFor(role: Actor['role']): Actor {
  const user = SEED_USERS.find((u) => u.role === role)
  if (!user) throw new Error(`No seed user for role ${role}`)
  return {
    userId: user.userId,
    role: user.role,
    fullName: user.fullName,
    organizationId: ORG_ID,
  }
}

function referenceFrom(db: WatchDatabase) {
  return {
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
  }
}

const iso = (base: Date, offsetMinutes: number): string =>
  new Date(base.getTime() + offsetMinutes * 60_000).toISOString()

/**
 * Historical incidents used to populate reporting.
 *
 * Each is walked through the complete lifecycle at plausible intervals so that
 * validation, notification and acknowledgment latencies are real measurements
 * rather than invented numbers.
 */
interface HistorySpec {
  scenarioId: string
  daysAgo: number
  disposition: Parameters<typeof setDisposition>[1]
  dispositionRationale: string
  escalate: boolean
  close: boolean
  /**
   * When false the alert is left open and unacknowledged. At least one seeded
   * alert stays in that state so the unacknowledged count and the overdue
   * escalation view are exercised by real data rather than a placeholder.
   */
  acknowledge: boolean
}

const HISTORY: HistorySpec[] = [
  {
    scenarioId: 'plano-confrontation',
    daysAgo: 1,
    disposition: 'confirmed',
    dispositionRationale:
      'Store security confirmed an altercation between two members. Both parties left before police arrived.',
    escalate: true,
    close: true,
    acknowledge: true,
  },
  {
    scenarioId: 'mansfield-police',
    daysAgo: 3,
    disposition: 'credible_unconfirmed',
    dispositionRationale:
      'Police activity confirmed on the highway. No impact on the warehouse itself; access restored within the hour.',
    escalate: false,
    close: true,
    acknowledge: true,
  },
  {
    scenarioId: 'memphis-old-repost',
    daysAgo: 5,
    disposition: 'outdated',
    dispositionRationale:
      'Video is a repost of an incident from the previous year. No current operational impact.',
    escalate: false,
    close: true,
    acknowledge: true,
  },
  {
    scenarioId: 'allentown-suspicious',
    daysAgo: 6,
    disposition: 'unconfirmed',
    dispositionRationale:
      'Second-hand report could not be corroborated. Store security completed a lot check and found nothing.',
    escalate: false,
    close: false,
    acknowledge: true,
  },
  {
    // Left open and unacknowledged: a validated alert nobody has picked up yet.
    scenarioId: 'new-orleans-protest',
    daysAgo: 0,
    disposition: 'unconfirmed',
    dispositionRationale: '',
    escalate: false,
    close: false,
    acknowledge: false,
  },
]

/** Live candidates left waiting in the analyst queue. */
const LIVE_SCENARIOS = ['new-orleans-protest', 'plano-complaint', 'allentown-suspicious']

async function seedHistory(db: WatchDatabase, now: Date): Promise<void> {
  const analyst = actorFor('analyst')
  const socManager = actorFor('soc_manager')
  const socOperator = actorFor('soc_operator')

  for (const spec of HISTORY) {
    const scenario = SIMULATION_SCENARIOS.find((s) => s.id === spec.scenarioId)
    if (!scenario) continue

    const eventTime = new Date(now.getTime() - spec.daysAgo * 86_400_000)
    const inputs = scenario.build(eventTime)
    const first = inputs[0]
    if (!first) continue

    const parsed = signalInputSchema.parse({
      ...first,
      // Unique per seeded history entry so re-running the simulator later does
      // not collide with seeded records.
      sourceRecordId: `seed-${scenario.id}-${spec.daysAgo}d`,
    })

    const detectedAt = iso(eventTime, 2)
    const result = ingestSignal(parsed, referenceFrom(db), {
      now: detectedAt,
      newId: nextId,
      collectionSourceId: null,
    })
    applyPipelineResult(db, result)

    const candidate = result.candidate
    if (!candidate || candidate.status !== 'pending_review' || !candidate.locationId) continue

    const location = db.locations.find((l) => l.id === candidate.locationId)
    const signal = result.signal
    if (!location || !signal) continue
    const category = db.categories.find((c) => c.key === candidate.automatedCategoryKey)

    // Validate roughly four minutes after detection.
    const validatedAt = iso(eventTime, 6)
    const validation = validateCandidate(
      candidate,
      signal,
      location,
      category?.label ?? candidate.automatedCategoryKey,
      analyst,
      { now: validatedAt, newId: nextId },
    )
    db.candidates = db.candidates.map((c) => (c.id === candidate.id ? validation.candidate : c))
    db.alerts.push(validation.alert)
    db.alertEvidence.push(...validation.evidence)
    db.auditEvents.push(...validation.events)

    // Notify subscribers.
    const outcomes = await dispatchAlert({
      alert: validation.alert,
      locationLabel: `${location.officialName} — ${location.city}, ${location.state}`,
      subscriptions: db.subscriptions,
      escalationRules: db.escalationRules,
    })
    recordDeliveries(db, validation.alert, outcomes, nextId, iso(eventTime, 6))

    let alert = db.alerts.find((a) => a.id === validation.alert.id)!
    alert = { ...alert, firstNotifiedAt: iso(eventTime, 6) }

    if (!spec.acknowledge) {
      // Stop here: the alert stays open and unacknowledged.
      db.alerts = db.alerts.map((a) => (a.id === alert.id ? alert : a))
      continue
    }

    // Acknowledge a couple of minutes later.
    const ack = acknowledgeAlert(alert, 'SOC has the alert.', socManager, {
      now: iso(eventTime, 8),
      newId: nextId,
    })
    alert = ack.alert
    db.acknowledgments.push(ack.acknowledgment)
    db.auditEvents.push(...ack.events)

    const assigned = assignAlert(
      alert,
      socOperator.userId,
      socOperator.fullName,
      'Working the incident.',
      socManager,
      { now: iso(eventTime, 9), newId: nextId },
    )
    alert = assigned.alert
    db.alertAssignments.push(assigned.assignment)
    db.auditEvents.push(...assigned.events)

    if (spec.escalate) {
      const escalated = escalateAlert(
        alert,
        {
          level: 'client_regional',
          reason: 'Client notification required for an on-property incident.',
          notifiedParties: ['Store manager on duty', 'Regional loss prevention'],
          storeManagerNotified: true,
          regionalManagerNotified: true,
        },
        socManager,
        { now: iso(eventTime, 14), newId: nextId },
      )
      alert = escalated.alert
      db.escalations.push(escalated.escalation)
      db.auditEvents.push(...escalated.events)
    }

    const note = addComment(
      alert,
      'Store security contacted by phone and confirmed the situation on site.',
      'operational_note',
      socOperator,
      { now: iso(eventTime, 18), newId: nextId },
    )
    db.comments.push(note.comment)
    db.auditEvents.push(...note.events)

    const resolved = changeAlertStatus(alert, 'resolved', socManager, {
      now: iso(eventTime, 45),
      newId: nextId,
    })
    alert = resolved.alert
    db.auditEvents.push(...resolved.events)

    const disposed = setDisposition(alert, spec.disposition, spec.dispositionRationale, socManager, {
      now: iso(eventTime, 47),
      newId: nextId,
    })
    alert = disposed.alert
    db.dispositions.push(disposed.record)
    db.auditEvents.push(...disposed.events)

    if (spec.close) {
      const closed = changeAlertStatus(alert, 'closed', socManager, {
        now: iso(eventTime, 50),
        newId: nextId,
      })
      alert = closed.alert
      db.auditEvents.push(...closed.events)
    }

    db.alerts = db.alerts.map((a) => (a.id === alert.id ? alert : a))
  }
}

function seedLiveQueue(db: WatchDatabase, now: Date): void {
  for (const scenarioId of LIVE_SCENARIOS) {
    const scenario = SIMULATION_SCENARIOS.find((s) => s.id === scenarioId)
    if (!scenario) continue

    for (const input of scenario.build(now)) {
      const parsed = signalInputSchema.parse({
        ...input,
        sourceRecordId: `seed-live-${scenario.id}-${input.sourceRecordId.slice(-6)}`,
      })
      const result = ingestSignal(parsed, referenceFrom(db), {
        now: new Date(now.getTime() - 60_000).toISOString(),
        newId: nextId,
      })
      applyPipelineResult(db, result)
    }
  }
}

export async function buildSeededDatabase(now = new Date()): Promise<WatchDatabase> {
  idCounter = 0
  const db = emptyDatabase()
  await seedHistory(db, now)
  seedLiveQueue(db, now)
  return db
}
