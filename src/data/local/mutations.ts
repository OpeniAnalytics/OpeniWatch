import type { Alert, NotificationDelivery } from '@/domain/types'
import type { PipelineResult } from '@/services/ingestion/pipeline'
import type { DispatchOutcome } from '@/services/notifications/dispatch'
import type { WatchDatabase } from './database'

/**
 * Write helpers shared by the seeder and the local provider.
 *
 * Kept separate so the seeding path and the runtime path insert records the
 * same way — a divergence there would make the demo behave unlike the app.
 */

/** Persists everything one pipeline run produced. */
export function applyPipelineResult(db: WatchDatabase, result: PipelineResult): void {
  // A rejected duplicate source record writes nothing: idempotency means the
  // second delivery of the same item leaves no trace beyond the first.
  if (!result.signal || !result.candidate) return

  if (result.author && !db.authors.some((a) => a.id === result.author!.id)) {
    db.authors.push(result.author)
  } else if (result.author) {
    db.authors = db.authors.map((a) => (a.id === result.author!.id ? result.author! : a))
  }

  db.signals.push(result.signal)
  db.media.push(...result.media)
  db.locationMatches.push(...result.matches)
  db.signalDuplicates.push(...result.duplicates)
  db.candidates.push(result.candidate)
}

/** Turns dispatch outcomes into delivery records and stamps first notification. */
export function recordDeliveries(
  db: WatchDatabase,
  alert: Alert,
  outcomes: readonly DispatchOutcome[],
  newId: () => string,
  now: string,
): NotificationDelivery[] {
  const deliveries: NotificationDelivery[] = outcomes.map((outcome) => ({
    id: newId(),
    organizationId: alert.organizationId,
    alertId: alert.id,
    subscriptionId: outcome.subscriptionId,
    userId: outcome.userId,
    channel: outcome.channel,
    status: outcome.result.status,
    providerId: outcome.result.providerId,
    providerMessageId: outcome.result.providerMessageId,
    pathStep: outcome.pathStep,
    attemptedAt: now,
    deliveredAt: outcome.result.deliveredAt,
    acknowledgedAt: null,
    detail: outcome.result.detail,
    isSimulated: outcome.result.isSimulated,
    readAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }))

  db.deliveries.push(...deliveries)

  if (deliveries.length > 0) {
    db.alerts = db.alerts.map((a) =>
      a.id === alert.id && !a.firstNotifiedAt ? { ...a, firstNotifiedAt: now } : a,
    )
  }

  return deliveries
}
