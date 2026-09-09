// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import { dedupeKey } from '../_shared/notify.ts'

/**
 * Automatic escalation of unacknowledged alerts.
 *
 * Intended to run on a schedule (Supabase cron, every minute). Finds alerts
 * that are still unacknowledged past their configured window and raises one
 * escalation, notifying the roles the rule names.
 *
 * Deliberate limits:
 *   * It escalates INSIDE OpeniWatch only. It never contacts emergency
 *     services, law enforcement, or any reported subject.
 *   * It never infers that a response occurred. An automated escalation means
 *     "nobody has acknowledged this yet", nothing more.
 *   * It is idempotent. A unique index on (alert_id, triggered_by_rule_id)
 *     where is_automated means a re-run cannot stack escalations, however many
 *     times the schedule fires.
 *   * An administrator can switch it off per organization
 *     (system_settings.auto_escalation_enabled) or per severity
 *     (escalation_rules.auto_escalate).
 *
 * POST /functions/v1/escalate-unacknowledged
 *   Headers: x-openiwatch-secret: <OPENIWATCH_INGEST_SECRET>
 *   Body:    {} or { "dryRun": true }
 */

const SECRET_HEADER = 'x-openiwatch-secret'

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

interface Rule {
  id: string
  organization_id: string
  program_id: string | null
  severity: string
  unacknowledged_seconds: number
  escalate_to: string
  auto_escalate: boolean
  is_active: boolean
  notify_roles: string[]
}

/**
 * Recipients of an automated escalation: users holding one of the rule's roles
 * in the organization, who are also members of the alert's program.
 */
async function resolveRecipients(
  supabase: SupabaseClient,
  organizationId: string,
  programId: string,
  roles: string[],
): Promise<string[]> {
  const { data: roleRows } = await supabase
    .from('user_roles')
    .select('user_id, role')
    .eq('organization_id', organizationId)
    .in('role', roles)

  const candidates = [...new Set((roleRows ?? []).map((r: any) => r.user_id as string))]
  if (candidates.length === 0) return []

  const { data: memberships } = await supabase
    .from('program_memberships')
    .select('user_id')
    .eq('program_id', programId)
    .in('user_id', candidates)

  return [...new Set((memberships ?? []).map((m: any) => m.user_id as string))]
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed. Use POST.' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  // Elevated project access, read from the SUPABASE_SECRET_KEYS dictionary
  // Supabase injects. Not a JWT — see _shared/supabase-keys.ts.
  const secretKey = getSecretKey()
  const secret = Deno.env.get('OPENIWATCH_INGEST_SECRET') ?? ''

  if (!supabaseUrl || !secretKey || !secret) {
    console.error('escalate-unacknowledged: required environment configuration is missing')
    return json({ error: 'The escalator is not configured.' }, 503)
  }

  const provided = request.headers.get(SECRET_HEADER) ?? ''
  if (!provided || !(await secretsMatch(provided, secret))) {
    return json({ error: 'Unauthorized.' }, 401)
  }

  let dryRun = false
  try {
    const body = await request.text()
    if (body.trim()) dryRun = JSON.parse(body)?.dryRun === true
  } catch {
    return json({ error: 'Body must be valid JSON.' }, 400)
  }

  const supabase = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const now = new Date()

  // Organizations with automatic escalation switched on.
  const { data: settingsRows } = await supabase
    .from('system_settings')
    .select('organization_id, auto_escalation_enabled, outbound_notifications_enabled')
  const enabledOrgs = new Set(
    (settingsRows ?? [])
      .filter((s: any) => s.auto_escalation_enabled !== false)
      .map((s: any) => s.organization_id as string),
  )

  const { data: ruleRows, error: ruleError } = await supabase
    .from('escalation_rules')
    .select(
      'id, organization_id, program_id, severity, unacknowledged_seconds, escalate_to, auto_escalate, is_active, notify_roles',
    )
    .eq('auto_escalate', true)
    .eq('is_active', true)

  if (ruleError) {
    console.error('escalate-unacknowledged: could not read rules', ruleError.message)
    return json({ error: 'Unable to read escalation rules.' }, 503)
  }

  const rules = (ruleRows ?? []).filter((r: Rule) => enabledOrgs.has(r.organization_id)) as Rule[]

  const escalated: Array<{ alertId: string; ruleId: string; overdueSeconds: number }> = []
  let considered = 0
  let alreadyEscalated = 0

  for (const rule of rules) {
    const cutoff = new Date(now.getTime() - rule.unacknowledged_seconds * 1000).toISOString()

    // Unacknowledged, still active, past the window. The clock starts at first
    // notification when there was one, and at validation otherwise — an alert
    // nobody was notified about is still overdue.
    let query = supabase
      .from('alerts')
      .select('id, program_id, organization_id, severity, first_notified_at, validated_at, title')
      .eq('organization_id', rule.organization_id)
      .eq('severity', rule.severity)
      .is('acknowledged_at', null)
      .not('status', 'in', '("resolved","closed")')
      .limit(200)

    if (rule.program_id) query = query.eq('program_id', rule.program_id)

    const { data: alerts } = await query
    for (const alert of (alerts ?? []) as any[]) {
      const since = alert.first_notified_at ?? alert.validated_at
      if (!since) continue
      const elapsed = Math.round((now.getTime() - Date.parse(since)) / 1000)
      if (elapsed < rule.unacknowledged_seconds) continue
      if (Date.parse(since) > Date.parse(cutoff)) continue

      considered += 1
      if (dryRun) {
        escalated.push({ alertId: alert.id, ruleId: rule.id, overdueSeconds: elapsed })
        continue
      }

      // The unique index makes this the real idempotency guard: a duplicate
      // insert is rejected, and we treat that as "already handled".
      const { error: insertError } = await supabase.from('alert_escalations').insert({
        alert_id: alert.id,
        level: rule.escalate_to,
        escalated_by: null,
        is_automated: true,
        triggered_by_rule_id: rule.id,
        unacknowledged_seconds: elapsed,
        reason: `Automatically escalated: no acknowledgment ${elapsed}s after notification, exceeding the ${rule.unacknowledged_seconds}s threshold configured for ${rule.severity} severity.`,
        notified_parties: [],
        store_manager_notified: false,
        regional_manager_notified: false,
      })

      if (insertError) {
        // 23505 unique_violation: this alert was already escalated by this rule.
        if ((insertError as any).code === '23505') {
          alreadyEscalated += 1
          continue
        }
        console.error('escalate-unacknowledged: insert failed', alert.id, insertError.message)
        continue
      }

      await supabase
        .from('alerts')
        .update({ status: 'escalated', escalated_at: now.toISOString() })
        .eq('id', alert.id)
        .is('acknowledged_at', null)

      // Notify the roles the rule names, in-app plus web push. Queued rather
      // than sent here: dispatch-notifications owns the provider calls.
      const recipients = await resolveRecipients(
        supabase,
        rule.organization_id,
        alert.program_id,
        rule.notify_roles ?? ['soc_manager'],
      )

      if (recipients.length > 0) {
        const rows = recipients.flatMap((userId) =>
          (['in_app', 'web_push'] as const).map((channel, index) => ({
            organization_id: rule.organization_id,
            alert_id: alert.id,
            user_id: userId,
            channel,
            // Step 4 marks these as escalation notifications, distinct from the
            // original alert delivery path.
            path_step: 4,
            status: channel === 'in_app' ? 'delivered' : 'queued',
            provider_id: channel === 'in_app' ? 'in-app' : 'onesignal',
            attempted_at: now.toISOString(),
            delivered_at: channel === 'in_app' ? now.toISOString() : null,
            detail:
              channel === 'in_app'
                ? 'Automatic escalation: this alert has not been acknowledged.'
                : 'Queued for web push following automatic escalation.',
            is_simulated: false,
            dedupe_key: dedupeKey(alert.id, userId, channel, 4 + index, 'escalation'),
          })),
        )
        // Ignore conflicts: the dedupe index means a repeat run adds nothing.
        await supabase.from('notification_deliveries').upsert(rows, {
          onConflict: 'dedupe_key',
          ignoreDuplicates: true,
        })
      }

      await supabase.from('audit_events').insert({
        organization_id: rule.organization_id,
        actor_user_id: null,
        actor_role: 'system',
        action: 'alert.auto_escalated',
        entity_type: 'alert',
        entity_id: alert.id,
        detail: {
          ruleId: rule.id,
          severity: rule.severity,
          thresholdSeconds: rule.unacknowledged_seconds,
          elapsedSeconds: elapsed,
          escalatedTo: rule.escalate_to,
          notifiedUserCount: recipients.length,
          // Stated explicitly so nobody reading the trail later infers more
          // than happened.
          note: 'Automated escalation inside OpeniWatch. No external emergency service was contacted.',
        },
      })

      escalated.push({ alertId: alert.id, ruleId: rule.id, overdueSeconds: elapsed })
    }
  }

  return json(
    {
      dryRun,
      rulesEvaluated: rules.length,
      alertsConsidered: considered,
      escalated: escalated.length,
      alreadyEscalated,
      details: escalated,
    },
    200,
  )
})
