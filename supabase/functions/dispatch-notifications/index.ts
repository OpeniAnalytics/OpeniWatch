// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import {
  dedupeKey,
  killSwitchOutcome,
  sendOneSignalPush,
  sendSms,
  type ProviderOutcome,
  type PushTarget,
} from '../_shared/notify.ts'

/**
 * Notification dispatcher.
 *
 * Picks up `notification_deliveries` rows the application queued and hands them
 * to the provider that owns the channel. Runs server-side because the OneSignal
 * REST key is a secret.
 *
 * POST /functions/v1/dispatch-notifications
 *   Headers: x-openiwatch-secret: <OPENIWATCH_INGEST_SECRET>
 *   Body:    {}                       — drain every queued delivery
 *            { "alertId": "<uuid>" }  — drain one alert's queued deliveries
 *
 * Idempotency: a delivery is claimed by moving it out of `queued` before the
 * provider call, so two concurrent runs cannot send the same notification twice.
 * The `dedupe_key` unique index is the second line of defence.
 */

const SECRET_HEADER = 'x-openiwatch-secret'
const BATCH_LIMIT = 200

async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const viewA = new Uint8Array(a)
  const viewB = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < viewA.length; i += 1) diff |= viewA[i]! ^ viewB[i]!
  return diff === 0
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

interface QueuedDelivery {
  id: string
  organization_id: string
  alert_id: string
  user_id: string
  channel: string
  path_step: number
  dedupe_key: string | null
}

async function loadPushTargets(
  supabase: SupabaseClient,
  userId: string,
): Promise<PushTarget[]> {
  const { data } = await supabase
    .from('push_subscriptions')
    .select('id, provider_subscription_id')
    .eq('user_id', userId)
    .eq('provider', 'onesignal')
    .eq('is_enabled', true)
    .is('revoked_at', null)

  return (data ?? []).map((row: any) => ({
    providerSubscriptionId: row.provider_subscription_id,
    subscriptionRowId: row.id,
  }))
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed. Use POST.' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  // Elevated project access, read from the SUPABASE_SECRET_KEYS dictionary
  // Supabase injects. Not a JWT — see _shared/supabase-keys.ts.
  const secretKey = getSecretKey()
  const secret = Deno.env.get('OPENIWATCH_INGEST_SECRET') ?? ''

  if (!supabaseUrl || !secretKey || !secret) {
    console.error('dispatch-notifications: required environment configuration is missing')
    return json({ error: 'The dispatcher is not configured.' }, 503)
  }

  const provided = request.headers.get(SECRET_HEADER) ?? ''
  if (!provided || !(await secretsMatch(provided, secret))) {
    return json({ error: 'Unauthorized.' }, 401)
  }

  let alertId: string | null = null
  try {
    const body = await request.text()
    if (body.trim()) {
      const parsed = JSON.parse(body)
      if (typeof parsed?.alertId === 'string') alertId = parsed.alertId
    }
  } catch {
    return json({ error: 'Body must be valid JSON.' }, 400)
  }

  const supabase = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ---- Claim the queued deliveries ---------------------------------------
  // Moving them out of `queued` first means a concurrent invocation finds
  // nothing to do, rather than both calling the provider.
  let query = supabase
    .from('notification_deliveries')
    .select('id, organization_id, alert_id, user_id, channel, path_step, dedupe_key')
    .eq('status', 'queued')
    .limit(BATCH_LIMIT)

  if (alertId) query = query.eq('alert_id', alertId)

  const { data: queued, error: queueError } = await query
  if (queueError) {
    console.error('dispatch-notifications: could not read the queue', queueError.message)
    return json({ error: 'Unable to read the delivery queue.' }, 503)
  }

  const deliveries = (queued ?? []) as QueuedDelivery[]
  if (deliveries.length === 0) {
    return json({ processed: 0, results: {} }, 200)
  }

  const claimedIds = deliveries.map((d) => d.id)
  const { data: claimed } = await supabase
    .from('notification_deliveries')
    .update({ status: 'pending', attempted_at: new Date().toISOString() })
    .in('id', claimedIds)
    .eq('status', 'queued')
    .select('id')

  const claimedSet = new Set((claimed ?? []).map((row: any) => row.id))
  const toSend = deliveries.filter((d) => claimedSet.has(d.id))

  // ---- Kill switch --------------------------------------------------------
  const orgIds = [...new Set(toSend.map((d) => d.organization_id))]
  const { data: settingsRows } = await supabase
    .from('system_settings')
    .select('organization_id, outbound_notifications_enabled, outbound_disabled_reason')
    .in('organization_id', orgIds)

  const settings = new Map(
    (settingsRows ?? []).map((row: any) => [row.organization_id, row]),
  )

  const tally: Record<string, number> = {}
  const record = (status: string) => {
    tally[status] = (tally[status] ?? 0) + 1
  }

  for (const delivery of toSend) {
    const setting = settings.get(delivery.organization_id)
    const outboundEnabled = setting?.outbound_notifications_enabled !== false

    let outcome: ProviderOutcome

    if (!outboundEnabled) {
      outcome = killSwitchOutcome(delivery.channel, setting?.outbound_disabled_reason ?? null)
    } else if (delivery.channel === 'web_push') {
      const { data: alert } = await supabase
        .from('alerts')
        .select('id, severity, title, location_id, locations(official_name, city, state)')
        .eq('id', delivery.alert_id)
        .maybeSingle()

      const location = (alert as any)?.locations
      const label = location
        ? `${location.official_name} — ${location.city}, ${location.state}`
        : 'a monitored location'

      const targets = await loadPushTargets(supabase, delivery.user_id)
      const appOrigin = Deno.env.get('OPENIWATCH_APP_ORIGIN') ?? ''

      outcome = await sendOneSignalPush(targets, {
        // Deliberately minimal: severity and site only. This text can appear on
        // a lock screen, so it carries no source content and no author handle.
        title: `${String((alert as any)?.severity ?? 'alert').toUpperCase()} alert`,
        body: label,
        url: appOrigin ? `${appOrigin.replace(/\/$/, '')}/alerts/${delivery.alert_id}` : '',
        alertId: delivery.alert_id,
        severity: String((alert as any)?.severity ?? 'informational'),
      })

      if (targets[0]) {
        await supabase
          .from('notification_deliveries')
          .update({ push_subscription_id: targets[0].subscriptionRowId })
          .eq('id', delivery.id)
      }
    } else if (delivery.channel === 'sms') {
      outcome = sendSms()
    } else {
      outcome = {
        status: 'skipped',
        providerId: 'none',
        providerMessageId: null,
        detail: `No server-side provider is implemented for the ${delivery.channel} channel.`,
        providerResponse: {},
        isSimulated: false,
      }
    }

    await supabase
      .from('notification_deliveries')
      .update({
        status: outcome.status,
        provider_id: outcome.providerId,
        provider_message_id: outcome.providerMessageId,
        detail: outcome.detail,
        provider_response: outcome.providerResponse,
        is_simulated: outcome.isSimulated,
        // Only a confirmed device receipt sets delivered_at. Provider
        // acceptance does not.
        delivered_at: outcome.status === 'delivered' ? new Date().toISOString() : null,
        dedupe_key:
          delivery.dedupe_key ??
          dedupeKey(delivery.alert_id, delivery.user_id, delivery.channel, delivery.path_step),
      })
      .eq('id', delivery.id)

    record(outcome.status)
  }

  return json({ processed: toSend.length, results: tally }, 200)
})
