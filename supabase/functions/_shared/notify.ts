// deno-lint-ignore-file no-explicit-any
/**
 * Server-side notification delivery.
 *
 * Every provider call that requires a secret happens here, in a Deno Edge
 * Function. `ONESIGNAL_REST_API_KEY` and `TWILIO_AUTH_TOKEN` are read from the
 * function environment and never leave it.
 *
 * Two rules govern everything below:
 *
 *   1. **Never claim delivery you cannot observe.** OneSignal's REST response
 *      tells you it accepted the notification and how many recipients it
 *      matched. That is `sent`, not `delivered`. `delivered` is reserved for a
 *      confirmed device receipt, which requires a callback OpeniWatch does not
 *      yet receive.
 *
 *   2. **Record every attempt, including the ones you did not make.** A channel
 *      that is disabled, unconfigured or killed by the switch produces a row
 *      saying so. Silence in the delivery history must always mean "nothing was
 *      attempted", never "something failed quietly".
 */

export type DeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'skipped'
  | 'simulated'
  | 'disabled'

export interface ProviderOutcome {
  status: DeliveryStatus
  providerId: string
  providerMessageId: string | null
  /** Operator-facing note. Never contains credentials. */
  detail: string
  /** Provider response, with authorization material stripped. */
  providerResponse: Record<string, unknown>
  isSimulated: boolean
}

export interface PushTarget {
  /** OneSignal subscription id. */
  providerSubscriptionId: string
  /** OpeniWatch push_subscriptions row id, for the delivery record. */
  subscriptionRowId: string
}

export interface PushMessage {
  title: string
  body: string
  /** Absolute URL the notification opens. */
  url: string
  alertId: string
  severity: string
}

const ONESIGNAL_ENDPOINT = 'https://api.onesignal.com/notifications'

/**
 * Sends a web push through OneSignal.
 *
 * Returns `skipped` rather than throwing when unconfigured, so a missing
 * credential produces an honest record instead of an exception that loses the
 * attempt entirely.
 */
export async function sendOneSignalPush(
  targets: PushTarget[],
  message: PushMessage,
): Promise<ProviderOutcome> {
  const appId = Deno.env.get('ONESIGNAL_APP_ID') ?? ''
  const apiKey = Deno.env.get('ONESIGNAL_REST_API_KEY') ?? ''

  if (!appId || !apiKey) {
    return {
      status: 'skipped',
      providerId: 'onesignal',
      providerMessageId: null,
      detail:
        'OneSignal is not configured (ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY are required). No request was made.',
      providerResponse: {},
      isSimulated: false,
    }
  }

  if (targets.length === 0) {
    return {
      status: 'skipped',
      providerId: 'onesignal',
      providerMessageId: null,
      detail: 'No active web push registration for this recipient.',
      providerResponse: {},
      isSimulated: false,
    }
  }

  // The push preview is deliberately terse: severity and location only. It
  // appears on a lock screen, so it must not carry the source text, the public
  // author handle, or anything else identifying.
  const payload = {
    app_id: appId,
    include_subscription_ids: targets.map((t) => t.providerSubscriptionId),
    headings: { en: message.title },
    contents: { en: message.body },
    url: message.url,
    // Collapse on the alert id so a re-send replaces rather than stacks.
    web_push_topic: `openiwatch-alert-${message.alertId}`,
    data: { alertId: message.alertId, severity: message.severity },
    priority: message.severity === 'critical' ? 10 : 5,
  }

  try {
    const response = await fetch(ONESIGNAL_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Key ${apiKey}`,
      },
      body: JSON.stringify(payload),
    })

    const raw = await response.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { raw: raw.slice(0, 500) }
    }

    if (!response.ok) {
      return {
        status: 'failed',
        providerId: 'onesignal',
        providerMessageId: null,
        detail: `OneSignal rejected the notification (HTTP ${response.status}).`,
        providerResponse: sanitize(parsed),
        isSimulated: false,
      }
    }

    const recipients = Number(parsed.recipients ?? 0)
    if (recipients === 0) {
      // Accepted but matched nobody: the registration is probably stale.
      return {
        status: 'failed',
        providerId: 'onesignal',
        providerMessageId: (parsed.id as string) ?? null,
        detail:
          'OneSignal accepted the request but matched zero recipients. The registration may have been revoked in the browser.',
        providerResponse: sanitize(parsed),
        isSimulated: false,
      }
    }

    return {
      // `sent`, not `delivered`: OneSignal has accepted and queued it. Device
      // receipt is not observable without a delivery callback.
      status: 'sent',
      providerId: 'onesignal',
      providerMessageId: (parsed.id as string) ?? null,
      detail: `OneSignal accepted the notification for ${recipients} recipient(s). Acceptance is not proof of device delivery.`,
      providerResponse: sanitize(parsed),
      isSimulated: false,
    }
  } catch (error) {
    return {
      status: 'failed',
      providerId: 'onesignal',
      providerMessageId: null,
      detail: `Could not reach OneSignal: ${error instanceof Error ? error.name : 'network error'}.`,
      providerResponse: {},
      isSimulated: false,
    }
  }
}

/**
 * SMS is deliberately not sent in this phase.
 *
 * The interface and the environment variables exist, but no Twilio request is
 * made unless OPENIWATCH_ENABLE_SMS is exactly "true". A mis-fired SMS blast
 * during a pilot is worse than a missing one, and SMS additionally needs
 * consent handling and verified recipients that are not yet in place.
 */
export function sendSms(): ProviderOutcome {
  const enabled = Deno.env.get('OPENIWATCH_ENABLE_SMS') === 'true'

  if (!enabled) {
    return {
      status: 'disabled',
      providerId: 'twilio',
      providerMessageId: null,
      detail:
        'SMS is disabled (OPENIWATCH_ENABLE_SMS is not "true"). No Twilio request was attempted. See docs/INTEGRATIONS.md for the prerequisites for an SMS pilot.',
      providerResponse: {},
      isSimulated: false,
    }
  }

  // Even when the flag is on, Phase 2 does not send. Enabling the flag alone
  // must not start messaging real phones.
  return {
    status: 'skipped',
    providerId: 'twilio',
    providerMessageId: null,
    detail:
      'OPENIWATCH_ENABLE_SMS is set, but live SMS sending is not implemented in this phase. Consent capture, recipient verification and opt-out handling are prerequisites.',
    providerResponse: {},
    isSimulated: false,
  }
}

/** Records an attempt that was suppressed by the outbound kill switch. */
export function killSwitchOutcome(channel: string, reason: string | null): ProviderOutcome {
  return {
    status: 'disabled',
    providerId: 'kill-switch',
    providerMessageId: null,
    detail: `Outbound notifications are switched off for this organization${
      reason ? `: ${reason}` : '.'
    } No ${channel} request was attempted.`,
    providerResponse: {},
    isSimulated: false,
  }
}

/**
 * Removes anything that could carry credentials before a provider response is
 * written to the database.
 */
function sanitize(response: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    'authorization',
    'api_key',
    'app_key',
    'rest_api_key',
    'token',
    'auth',
    'password',
  ])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(response)) {
    if (blocked.has(key.toLowerCase())) continue
    // Keep the response shallow: OneSignal error bodies can be large and we
    // only need the identifiers and error strings.
    if (typeof value === 'object' && value !== null) {
      out[key] = JSON.stringify(value).slice(0, 1000)
    } else {
      out[key] = value
    }
  }
  return out
}

/** Stable key so a re-run cannot produce a second row for the same attempt. */
export function dedupeKey(
  alertId: string,
  userId: string,
  channel: string,
  pathStep: number,
  purpose = 'alert',
): string {
  return `${purpose}:${alertId}:${userId}:${channel}:${pathStep}`
}
