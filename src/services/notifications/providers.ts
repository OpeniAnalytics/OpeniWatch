import { env } from '@/lib/env'
import type { DeliveryRequest, DeliveryResult, NotificationProvider } from './provider'
import { unavailableResult } from './provider'

/**
 * Phase 1 notification providers.
 *
 * Each provider states its own availability. The dispatcher never assumes a
 * channel works: an unavailable provider produces a `skipped` delivery record
 * that names the missing configuration, so the notification history is an
 * honest account of what actually happened.
 */

/**
 * In-app notifications. Fully implemented.
 *
 * The delivery row IS the notification: the application reads
 * `notification_deliveries` for the signed-in user, and Supabase Realtime
 * pushes new rows to open sessions.
 */
export const inAppProvider: NotificationProvider = {
  id: 'in-app',
  displayName: 'In-app notification',
  channels: ['in_app'],
  availability: () => ({ available: true, reason: 'In-app delivery is always available.' }),
  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    const now = new Date().toISOString()
    return {
      status: 'delivered',
      providerId: 'in-app',
      providerMessageId: `in-app:${request.alertId}:${request.userId}`,
      detail: 'Delivered to the in-app alert inbox.',
      isSimulated: false,
      deliveredAt: now,
    }
  },
}

/**
 * Development provider. Records a simulated delivery for any channel.
 *
 * This is what makes the full workflow demonstrable without OneSignal, Twilio
 * or an email service. Deliveries it produces are flagged `isSimulated` and
 * are labelled as simulated everywhere they appear.
 */
export const developmentProvider: NotificationProvider = {
  id: 'development',
  displayName: 'Development provider (records simulated deliveries)',
  channels: ['in_app', 'web_push', 'sms', 'email', 'microsoft_teams', 'webhook'],
  availability: () => ({
    available: true,
    reason: 'Records simulated deliveries. No message leaves the system.',
  }),
  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    const now = new Date().toISOString()
    return {
      status: 'simulated',
      providerId: 'development',
      providerMessageId: `sim:${request.channel}:${request.alertId}:${request.userId}`,
      detail: `Simulated ${request.channel} delivery (step ${request.pathStep}). No live provider is configured for this channel.`,
      isSimulated: true,
      deliveredAt: now,
    }
  },
}

/**
 * OneSignal web push adapter.
 *
 * Behind environment variables and inert without them. The REST call itself
 * must run server-side: ONESIGNAL_REST_API_KEY is a secret and is never
 * present in the browser bundle, so this browser-side adapter reports the
 * delivery as requiring the server-side dispatcher.
 */
export const oneSignalProvider: NotificationProvider = {
  id: 'onesignal',
  displayName: 'OneSignal web push',
  channels: ['web_push'],
  availability() {
    if (!env.oneSignalAppId) {
      return {
        available: false,
        reason:
          'OneSignal is not configured. Set ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY and VITE_ONESIGNAL_APP_ID to enable web push.',
      }
    }
    return {
      available: true,
      reason: 'OneSignal application id is configured; sending is performed server-side.',
    }
  },
  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    const { available, reason } = this.availability()
    if (!available) return unavailableResult('onesignal', reason)

    // The REST API key must never reach the browser. The Edge Function
    // `dispatch-notifications` performs the call and updates this row with the
    // real provider outcome. From the client it is only ever `queued`.
    return {
      status: 'queued',
      providerId: 'onesignal',
      providerMessageId: null,
      detail: `Queued for server-side delivery via OneSignal (step ${request.pathStep}). The dispatcher records the provider response.`,
      isSimulated: false,
      deliveredAt: null,
    }
  },
}

/**
 * Twilio SMS adapter — interface only in Phase 1.
 *
 * SMS is the critical-path fallback. It is deliberately not wired to a live
 * send: a mis-fired SMS blast during a pilot is worse than a missing one, so
 * this stays a documented stub until the pilot explicitly enables it.
 */
export const twilioProvider: NotificationProvider = {
  id: 'twilio',
  displayName: 'Twilio SMS (critical fallback)',
  channels: ['sms'],
  availability: () => ({
    available: false,
    reason: env.enableSms
      ? 'OPENIWATCH_ENABLE_SMS is set, but live SMS sending is not implemented in this phase. Consent capture, recipient verification and opt-out handling are prerequisites. No Twilio request is attempted.'
      : 'SMS is disabled. Set OPENIWATCH_ENABLE_SMS=true and complete the prerequisites in docs/INTEGRATIONS.md before enabling. No Twilio request is attempted.',
  }),
  async send(): Promise<DeliveryResult> {
    // `disabled`, not `simulated`: nothing was sent and nothing pretended to be.
    return {
      status: 'disabled',
      providerId: 'twilio',
      providerMessageId: null,
      detail: this.availability().reason,
      isSimulated: false,
      deliveredAt: null,
    }
  },
}

/** Email delivery — not implemented in Phase 1. */
export const emailProvider: NotificationProvider = {
  id: 'email',
  displayName: 'Email',
  channels: ['email'],
  availability: () => ({
    available: false,
    reason: 'Email delivery is not implemented in Phase 1. Requires an email service and OPENIWATCH_EMAIL_FROM.',
  }),
  async send(): Promise<DeliveryResult> {
    return unavailableResult('email', this.availability().reason)
  },
}

/** Microsoft Teams delivery — not implemented in Phase 1. */
export const teamsProvider: NotificationProvider = {
  id: 'microsoft-teams',
  displayName: 'Microsoft Teams',
  channels: ['microsoft_teams'],
  availability: () => ({
    available: false,
    reason:
      'Microsoft Teams delivery is not implemented in Phase 1. Requires MICROSOFT_TEAMS_WEBHOOK_URL and the server-side dispatcher.',
  }),
  async send(): Promise<DeliveryResult> {
    return unavailableResult('microsoft-teams', this.availability().reason)
  },
}

/** Outbound webhook delivery — not implemented in Phase 1. */
export const outboundWebhookProvider: NotificationProvider = {
  id: 'outbound-webhook',
  displayName: 'Outbound webhook',
  channels: ['webhook'],
  availability: () => ({
    available: false,
    reason:
      'Outbound webhook delivery is not implemented in Phase 1. Requires OPENIWATCH_OUTBOUND_WEBHOOK_URL and a signing secret.',
  }),
  async send(): Promise<DeliveryResult> {
    return unavailableResult('outbound-webhook', this.availability().reason)
  },
}

export const ALL_PROVIDERS: readonly NotificationProvider[] = [
  inAppProvider,
  developmentProvider,
  oneSignalProvider,
  twilioProvider,
  emailProvider,
  teamsProvider,
  outboundWebhookProvider,
]
