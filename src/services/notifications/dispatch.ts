import type { DeliveryChannel, Severity } from '@/domain/enums'
import type { Alert, EscalationRule, NotificationSubscription } from '@/domain/types'
import { ALL_PROVIDERS, developmentProvider } from './providers'
import type { DeliveryRequest, DeliveryResult, NotificationProvider } from './provider'

/**
 * Notification dispatch.
 *
 * Decides who is notified, on which channels, in which order — then records
 * exactly what happened for each attempt. Delivery records are written whether
 * the attempt succeeded, failed, was simulated or was skipped, because the
 * notification history is part of the operational record of an alert.
 */

/**
 * Does a subscription cover this alert?
 *
 * Scope narrows left to right: organization -> program -> location ->
 * assignment. A null at any level means "everything within the enclosing
 * scope", so a user subscribed at program level receives alerts for every
 * location in that program.
 */
export function subscriptionMatches(
  subscription: NotificationSubscription,
  alert: Pick<
    Alert,
    'organizationId' | 'programId' | 'locationId' | 'operationalAssignmentId' | 'severity' | 'categoryKey'
  >,
): boolean {
  if (!subscription.isActive) return false
  if (subscription.organizationId !== alert.organizationId) return false
  if (subscription.programId && subscription.programId !== alert.programId) return false
  if (subscription.locationId && subscription.locationId !== alert.locationId) return false
  if (
    subscription.operationalAssignmentId &&
    subscription.operationalAssignmentId !== alert.operationalAssignmentId
  ) {
    return false
  }
  // An empty list means "all".
  if (subscription.severities.length > 0 && !subscription.severities.includes(alert.severity)) {
    return false
  }
  if (
    subscription.categoryKeys.length > 0 &&
    !subscription.categoryKeys.includes(alert.categoryKey)
  ) {
    return false
  }
  return true
}

/**
 * Ordered channels to attempt for one subscription.
 *
 * The escalation rule for the severity defines the path (e.g. in-app -> web
 * push -> SMS for critical). The user's own channel selection filters it, with
 * one exception: in-app is always included so a critical alert can never be
 * configured into silence inside the application itself.
 */
export function resolveChannelPath(
  severity: Severity,
  subscription: NotificationSubscription,
  rules: readonly EscalationRule[],
  programId: string,
): DeliveryChannel[] {
  const rule =
    rules.find((r) => r.isActive && r.severity === severity && r.programId === programId) ??
    rules.find((r) => r.isActive && r.severity === severity && r.programId === null)

  const path = rule?.channelPath ?? ['in_app']
  const selected = path.filter((channel) => subscription.channels.includes(channel))

  if (!selected.includes('in_app')) selected.unshift('in_app')
  return selected
}

/** Picks the best available provider for a channel, falling back to the simulator. */
export function providerForChannel(
  channel: DeliveryChannel,
  providers: readonly NotificationProvider[] = ALL_PROVIDERS,
): NotificationProvider {
  const candidates = providers.filter((p) => p.channels.includes(channel) && p.id !== 'development')
  const live = candidates.find((p) => p.availability().available)
  if (live) return live
  // Nothing live for this channel: the development provider records the
  // attempt so the operational history stays complete and honest.
  return developmentProvider
}

export interface DispatchTarget {
  userId: string
  subscription: NotificationSubscription
}

export interface DispatchOutcome {
  userId: string
  subscriptionId: string | null
  channel: DeliveryChannel
  pathStep: number
  result: DeliveryResult
}

export interface DispatchInput {
  alert: Alert
  locationLabel: string
  subscriptions: readonly NotificationSubscription[]
  escalationRules: readonly EscalationRule[]
  providers?: readonly NotificationProvider[]
}

/** Short operational message body used across every channel. */
export function buildNotificationBody(alert: Alert, locationLabel: string): string {
  return [
    `${alert.severity.toUpperCase()} — ${locationLabel}`,
    alert.title,
    `Incident-location confidence ${alert.incidentLocation.confidence}%.`,
  ].join('\n')
}

/**
 * Runs delivery for one alert and returns an outcome per attempt.
 *
 * Callers persist these as `notification_deliveries` rows. Nothing is written
 * here so the function stays testable and provider-agnostic.
 */
export async function dispatchAlert(input: DispatchInput): Promise<DispatchOutcome[]> {
  const { alert, locationLabel, subscriptions, escalationRules, providers } = input
  const outcomes: DispatchOutcome[] = []
  const body = buildNotificationBody(alert, locationLabel)

  const matched = subscriptions.filter((s) => subscriptionMatches(s, alert))

  for (const subscription of matched) {
    const path = resolveChannelPath(alert.severity, subscription, escalationRules, alert.programId)

    for (const [index, channel] of path.entries()) {
      const provider = providerForChannel(channel, providers)
      const request: DeliveryRequest = {
        alertId: alert.id,
        organizationId: alert.organizationId,
        userId: subscription.userId,
        subscriptionId: subscription.id,
        channel,
        pathStep: index + 1,
        severity: alert.severity,
        title: `${alert.severity.toUpperCase()} alert — ${locationLabel}`,
        body,
        deepLink: `/alerts/${alert.id}`,
      }

      const result = await provider.send(request)
      outcomes.push({
        userId: subscription.userId,
        subscriptionId: subscription.id,
        channel,
        pathStep: index + 1,
        result,
      })
    }
  }

  return outcomes
}

/**
 * Alerts that are due for unacknowledged-escalation.
 *
 * Phase 1 evaluates this on demand when the operations screen loads rather
 * than from a scheduled job, so the SOC sees overdue alerts without requiring
 * a background worker. `docs/ALERT_WORKFLOW.md` records what a scheduled
 * evaluator would add.
 */
export function findOverdueAcknowledgment(
  alerts: readonly Alert[],
  rules: readonly EscalationRule[],
  now: string,
): Array<{ alert: Alert; overdueSeconds: number; rule: EscalationRule }> {
  const nowMs = Date.parse(now)
  const overdue: Array<{ alert: Alert; overdueSeconds: number; rule: EscalationRule }> = []

  for (const alert of alerts) {
    if (alert.acknowledgedAt) continue
    if (alert.status === 'resolved' || alert.status === 'closed') continue

    const rule =
      rules.find((r) => r.isActive && r.severity === alert.severity && r.programId === alert.programId) ??
      rules.find((r) => r.isActive && r.severity === alert.severity && r.programId === null)
    if (!rule) continue

    // Measured from first notification when one exists, otherwise from
    // validation: an alert nobody was notified about is still overdue.
    const since = Date.parse(alert.firstNotifiedAt ?? alert.validatedAt)
    if (!Number.isFinite(since)) continue

    const elapsed = (nowMs - since) / 1000
    if (elapsed > rule.unacknowledgedSeconds) {
      overdue.push({ alert, overdueSeconds: Math.round(elapsed - rule.unacknowledgedSeconds), rule })
    }
  }

  return overdue.sort((a, b) => b.overdueSeconds - a.overdueSeconds)
}
