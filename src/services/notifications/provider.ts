import type { DeliveryChannel, DeliveryStatus, Severity } from '@/domain/enums'

/**
 * Alert delivery provider interface.
 *
 * Every channel — in-app, web push, SMS, email, Teams, webhook — is reached
 * through this one interface, so adding a live provider later is a
 * registration change rather than a rewrite of the alerting path.
 *
 * Phase 1 status:
 *   in-app        fully implemented
 *   development   fully implemented (records simulated deliveries)
 *   OneSignal     adapter present, activates only when credentials are set
 *   Twilio        interface only; documented as unavailable without credentials
 *   email/Teams   stubs that report themselves unavailable
 */

export interface DeliveryRequest {
  alertId: string
  organizationId: string
  userId: string
  subscriptionId: string | null
  channel: DeliveryChannel
  /** Position in the configured critical path (1 = first attempt). */
  pathStep: number
  severity: Severity
  title: string
  body: string
  /** Relative application path the notification should open. */
  deepLink: string
}

export interface DeliveryResult {
  status: DeliveryStatus
  providerId: string
  providerMessageId: string | null
  /** Operator-facing note. Must never contain credentials or tokens. */
  detail: string | null
  /** True when nothing left the system and the delivery was only recorded. */
  isSimulated: boolean
  deliveredAt: string | null
}

export interface NotificationProvider {
  readonly id: string
  readonly displayName: string
  readonly channels: readonly DeliveryChannel[]
  /**
   * Whether this provider can actually deliver right now.
   *
   * A provider without credentials reports `false` with a reason, and the
   * dispatcher records a `skipped` delivery naming that reason. Nothing in the
   * interface pretends a message was sent when it was not.
   */
  availability(): { available: boolean; reason: string }
  send(request: DeliveryRequest): Promise<DeliveryResult>
}

/** Convenience for providers that cannot run without configuration. */
export function unavailableResult(
  providerId: string,
  reason: string,
): DeliveryResult {
  return {
    status: 'skipped',
    providerId,
    providerMessageId: null,
    detail: reason,
    isSimulated: false,
    deliveredAt: null,
  }
}
