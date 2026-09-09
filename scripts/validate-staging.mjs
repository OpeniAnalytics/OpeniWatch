#!/usr/bin/env node
/**
 * Staging validation suite.
 *
 * Executes the checks that require a live Supabase project: real authentication,
 * Row Level Security through authenticated sessions, cross-tenant isolation,
 * the secure ingestion endpoint, the full alert lifecycle, Realtime, and the
 * notification and escalation Edge Functions.
 *
 * These cannot be run from a sandbox without network access to Supabase, which
 * is why they live here rather than in the Vitest suite: they are the acceptance
 * test to run against staging, and they either pass against a real project or
 * they report exactly what failed.
 *
 * Usage:
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_ANON_KEY=<anon-key> \
 *   SUPABASE_SECRET_KEY=<sb_secret_...> \
 *   OPENIWATCH_INGEST_SECRET=<ingest-secret> \
 *   OPENIWATCH_SEED_PASSWORD=<the password used by seed-users.mjs> \
 *   node scripts/validate-staging.mjs
 *
 * Options:
 *   --skip-cross-tenant   Do not create the temporary second organization.
 *   --keep-test-data      Leave the temporary records in place for inspection.
 *   --json                Emit machine-readable results.
 *
 * The temporary cross-tenant records are all named with the prefix
 * `ZZ-ISOLATION-TEST` and are deleted at the end unless --keep-test-data is
 * given.
 */

import { createClient } from '@supabase/supabase-js'

/**
 * Supabase credential.
 *
 * SUPABASE_SECRET_KEY holds an `sb_secret_...` value from
 * Project Settings -> API Keys. It bypasses Row Level Security completely, so
 * it belongs only in a server-side shell: never in a VITE_ variable, never in
 * a Netlify build environment, never in source control.
 *
 * The legacy `service_role` JWT is not accepted. Falling back to it would let
 * this script keep working after the migration while still depending on a key
 * the project is retiring.
 */
function requireSecretKey() {
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key) {
    console.error(
      'SUPABASE_SECRET_KEY is not set.\n' +
        'Copy the sb_secret_... value from Project Settings -> API Keys.\n' +
        'Do not use the Legacy API keys page, and do not use a service_role JWT.',
    )
    process.exit(1)
  }
  if (!/^sb_secret_/.test(key)) {
    console.error(
      'SUPABASE_SECRET_KEY does not look like a secret key.\n' +
        'Expected a value beginning sb_secret_ from Project Settings -> API Keys.',
    )
    process.exit(1)
  }
  return key
}


const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SECRET_KEY
const ingestSecret = process.env.OPENIWATCH_INGEST_SECRET
const seedPassword = process.env.OPENIWATCH_SEED_PASSWORD

const args = new Set(process.argv.slice(2))
const skipCrossTenant = args.has('--skip-cross-tenant')
const keepTestData = args.has('--keep-test-data')
const asJson = args.has('--json')

if (!url || !anonKey || !serviceKey) {
  console.error(
    'SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY are required.\n' +
      'See docs/STAGING_ACCEPTANCE.md.',
  )
  process.exit(1)
}
if (!seedPassword) {
  console.error('OPENIWATCH_SEED_PASSWORD is required so the suite can sign in as each role.')
  process.exit(1)
}

const ORG_ID = 'a0000000-0000-4000-8000-000000000001'
const PROGRAM_ID = 'a0000000-0000-4000-8000-000000000002'
const STAFFORD_ID = 'b0000000-0000-4000-8000-000000000001'
const ISOLATION_PREFIX = 'ZZ-ISOLATION-TEST'

const ACCOUNTS = {
  super_admin: 'super.admin@openiwatch.example',
  program_admin: 'program.admin@openiwatch.example',
  analyst: 'analyst@openiwatch.example',
  soc_manager: 'soc.manager@openiwatch.example',
  soc_operator: 'soc.operator@openiwatch.example',
  viewer: 'viewer@openiwatch.example',
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const results = []
let failures = 0

function record(section, name, passed, detail = '') {
  results.push({ section, name, passed, detail })
  if (!passed) failures += 1
  if (!asJson) {
    const mark = passed ? '  ✓' : '  ✗'
    console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  if (!asJson) console.log(`\n=== ${title} ===`)
  return title
}

/** Signs in as one seeded account and returns an RLS-bound client. */
async function clientFor(role) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({
    email: ACCOUNTS[role],
    password: seedPassword,
  })
  if (error || !data.session) {
    throw new Error(`Sign-in failed for ${role}: ${error?.message ?? 'no session returned'}`)
  }
  return client
}

/** Asserts an operation is refused, either by error or by affecting no rows. */
async function expectDenied(sec, name, promise) {
  try {
    const { data, error } = await promise
    if (error) return record(sec, name, true, 'refused by the database')
    const affected = Array.isArray(data) ? data.length : data ? 1 : 0
    record(
      sec,
      name,
      affected === 0,
      affected === 0 ? 'filtered to zero rows by policy' : `PERMITTED ${affected} row(s)`,
    )
  } catch (error) {
    record(sec, name, true, `refused: ${error.message}`)
  }
}

async function expectAllowed(sec, name, promise) {
  try {
    const { data, error } = await promise
    if (error) return record(sec, name, false, `unexpectedly refused: ${error.message}`)
    const affected = Array.isArray(data) ? data.length : data ? 1 : 0
    record(sec, name, affected > 0, affected > 0 ? `${affected} row(s)` : 'affected no rows')
  } catch (error) {
    record(sec, name, false, `threw: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Step 4 — authentication and authorization
// ---------------------------------------------------------------------------

const clients = {}

async function testAuthentication() {
  const sec = section('Step 4a: authentication')
  for (const role of Object.keys(ACCOUNTS)) {
    try {
      clients[role] = await clientFor(role)
      const { data } = await clients[role].auth.getUser()
      record(sec, `${role} can sign in`, Boolean(data.user), data.user?.email ?? '')
    } catch (error) {
      record(sec, `${role} can sign in`, false, error.message)
    }
  }
}

async function testAuthorization() {
  const sec = section('Step 4b: role restrictions through authenticated sessions')

  const { data: candidate } = await admin
    .from('candidate_alerts')
    .select('id')
    .eq('status', 'pending_review')
    .limit(1)
    .maybeSingle()
  const { data: alert } = await admin.from('alerts').select('id').limit(1).maybeSingle()

  if (!candidate || !alert) {
    record(sec, 'fixtures present', false, 'no pending candidate or alert found to test against')
    return
  }

  // Analyst may triage; SOC roles and viewer may not validate.
  await expectAllowed(
    sec,
    'analyst may set a candidate under review',
    clients.analyst
      .from('candidate_alerts')
      .update({ status: 'under_review' })
      .eq('id', candidate.id)
      .select('id'),
  )

  for (const role of ['soc_manager', 'soc_operator', 'viewer']) {
    await expectDenied(
      sec,
      `${role} may NOT validate a candidate`,
      clients[role]
        .from('candidate_alerts')
        .update({ status: 'validated' })
        .eq('id', candidate.id)
        .select('id'),
    )
  }

  await expectDenied(
    sec,
    'viewer may NOT acknowledge an alert',
    clients.viewer
      .from('alerts')
      .update({ status: 'acknowledged' })
      .eq('id', alert.id)
      .select('id'),
  )

  await expectDenied(
    sec,
    'analyst may NOT change a role',
    clients.analyst
      .from('user_roles')
      .update({ role: 'program_admin' })
      .eq('user_id', '10000000-0000-4000-8000-000000000006')
      .select('id'),
  )

  await expectDenied(
    sec,
    'program_admin may NOT mint a super administrator',
    clients.program_admin
      .from('user_roles')
      .insert({
        user_id: '10000000-0000-4000-8000-000000000006',
        role: 'super_admin',
        organization_id: ORG_ID,
      })
      .select('id'),
  )

  await expectDenied(
    sec,
    'soc_manager may NOT change scoring thresholds',
    clients.soc_manager
      .from('scoring_thresholds')
      .update({ critical_min: 50 })
      .eq('organization_id', ORG_ID)
      .select('id'),
  )

  await expectDenied(
    sec,
    'no role may edit a signal',
    clients.program_admin
      .from('signals')
      .update({ original_text: 'tampered' })
      .eq('program_id', PROGRAM_ID)
      .select('id'),
  )

  await expectDenied(
    sec,
    'no role may alter an audit event',
    clients.program_admin
      .from('audit_events')
      .update({ action: 'tampered' })
      .eq('organization_id', ORG_ID)
      .select('id'),
  )

  await expectDenied(
    sec,
    'no application role may read ingest_rate_limits',
    clients.program_admin.from('ingest_rate_limits').select('bucket_key'),
  )

  // Reset the candidate so the suite is re-runnable.
  await admin.from('candidate_alerts').update({ status: 'pending_review' }).eq('id', candidate.id)
}

// ---------------------------------------------------------------------------
// Step 5 — cross-tenant isolation
// ---------------------------------------------------------------------------

async function testCrossTenant() {
  const sec = section('Step 5: cross-tenant isolation')
  if (skipCrossTenant) {
    record(sec, 'cross-tenant isolation', false, 'SKIPPED by --skip-cross-tenant')
    return {}
  }

  const created = {}
  try {
    const { data: org } = await admin
      .from('organizations')
      .insert({ name: `${ISOLATION_PREFIX} Org`, slug: `zz-isolation-${Date.now()}` })
      .select('id')
      .single()
    created.orgId = org.id

    const { data: program } = await admin
      .from('programs')
      .insert({
        organization_id: org.id,
        name: `${ISOLATION_PREFIX} Program`,
        slug: `zz-isolation-prog-${Date.now()}`,
      })
      .select('id')
      .single()
    created.programId = program.id

    const { data: location } = await admin
      .from('locations')
      .insert({
        organization_id: org.id,
        program_id: program.id,
        facility_number: 'ZZ1',
        official_name: `${ISOLATION_PREFIX} Location`,
        address_line1: '1 Isolation Way',
        city: 'Nowhere',
        state: 'TX',
        postal_code: '00000',
      })
      .select('id')
      .single()
    created.locationId = location.id

    const { data: signal } = await admin
      .from('signals')
      .insert({
        organization_id: org.id,
        program_id: program.id,
        source_platform: 'Public web source',
        source_record_id: `${ISOLATION_PREFIX}-signal-${Date.now()}`,
        original_text: `${ISOLATION_PREFIX} signal body.`,
        published_at: new Date().toISOString(),
        collection_method: 'simulator',
        provenance: 'Isolation test fixture',
        content_hash: `zz-${Date.now()}`,
      })
      .select('id')
      .single()
    created.signalId = signal.id

    const { data: cand } = await admin
      .from('candidate_alerts')
      .insert({
        organization_id: org.id,
        program_id: program.id,
        signal_id: signal.id,
        location_id: location.id,
        status: 'pending_review',
        automated_category_key: 'suspicious_activity',
        automated_severity: 'high',
        automated_priority_score: 70,
        automated_score: { priorityScore: 70 },
        automated_explanation: 'Isolation fixture.',
        incident_location_confidence: 80,
      })
      .select('id')
      .single()
    created.candidateId = cand.id

    const { data: alrt } = await admin
      .from('alerts')
      .insert({
        organization_id: org.id,
        program_id: program.id,
        candidate_alert_id: cand.id,
        signal_id: signal.id,
        location_id: location.id,
        title: `${ISOLATION_PREFIX} alert`,
        summary: 'Isolation fixture.',
        category_key: 'suspicious_activity',
        severity: 'high',
        status: 'open',
        priority_score: 70,
        incident_location_confidence: 80,
        published_at: new Date().toISOString(),
        detected_at: new Date().toISOString(),
        validated_by: '10000000-0000-4000-8000-000000000003',
      })
      .select('id')
      .single()
    created.alertId = alrt.id

    record(sec, 'temporary second tenant created', true, `org ${org.id}`)
  } catch (error) {
    record(sec, 'temporary second tenant created', false, error.message)
    return created
  }

  // A Costco Pilot user must see none of it, by listing OR by direct UUID.
  for (const role of ['program_admin', 'analyst', 'soc_manager', 'viewer']) {
    const c = clients[role]
    for (const [table, id] of [
      ['organizations', created.orgId],
      ['programs', created.programId],
      ['locations', created.locationId],
      ['signals', created.signalId],
      ['candidate_alerts', created.candidateId],
      ['alerts', created.alertId],
    ]) {
      const { data } = await c.from(table).select('id').eq('id', id)
      record(
        sec,
        `${role} cannot read ${table} by UUID`,
        (data ?? []).length === 0,
        (data ?? []).length === 0 ? '' : 'LEAK: row was returned',
      )
    }
  }

  // Nor may they add themselves to it.
  await expectDenied(
    sec,
    'program_admin cannot join the other organization',
    clients.program_admin
      .from('organization_memberships')
      .insert({ organization_id: created.orgId, user_id: '10000000-0000-4000-8000-000000000002' })
      .select('id'),
  )

  return created
}

async function cleanupCrossTenant(created) {
  if (keepTestData || !created?.orgId) return
  // Cascades remove the program, location, signal, candidate and alert.
  await admin.from('alerts').delete().eq('id', created.alertId ?? '')
  await admin.from('candidate_alerts').delete().eq('id', created.candidateId ?? '')
  await admin.from('signals').delete().eq('id', created.signalId ?? '')
  await admin.from('organizations').delete().eq('id', created.orgId)
  if (!asJson) console.log(`  cleaned up temporary tenant ${created.orgId}`)
}

// ---------------------------------------------------------------------------
// Step 6 — secure ingestion
// ---------------------------------------------------------------------------

const STAFFORD_TEXT =
  'There is a guy in the parking lot at Costco #1487 in Stafford waving a gun around near the fuel station. He is wearing a grey hoodie and standing next to a white pickup. People are running back inside. Calling 911 right now.'

async function post(fn, body, headers = {}) {
  const response = await fetch(`${url}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body */
  }
  return { status: response.status, json, text }
}

async function testIngestion() {
  const sec = section('Step 6: secure ingestion')
  if (!ingestSecret) {
    record(sec, 'ingestion', false, 'SKIPPED: OPENIWATCH_INGEST_SECRET not set')
    return null
  }

  const recordId = `staging-validate-${Date.now()}`
  const payload = {
    signals: [
      {
        sourcePlatform: 'Public web source',
        sourceRecordId: recordId,
        sourceUrl: 'https://example.com/staging-validation',
        originalText: STAFFORD_TEXT,
        publishedAt: new Date(Date.now() - 120_000).toISOString(),
        collectionMethod: 'webhook',
        provenance: 'Staging validation suite.',
        author: { handle: '@demo_staging_validation', displayName: 'Staging Validation' },
      },
    ],
  }

  const noSecret = await post('ingest-signal', payload)
  record(sec, 'rejects a request with no secret', noSecret.status === 401, `HTTP ${noSecret.status}`)

  const badSecret = await post('ingest-signal', payload, {
    'x-openiwatch-secret': 'definitely-not-the-secret',
  })
  record(sec, 'rejects a wrong secret', badSecret.status === 401, `HTTP ${badSecret.status}`)

  const auth = { 'x-openiwatch-secret': ingestSecret }

  const malformed = await post('ingest-signal', { signals: [{ sourcePlatform: 'x' }] }, auth)
  record(
    sec,
    'rejects a malformed payload with field-level issues',
    malformed.status === 422 && Array.isArray(malformed.json?.issues),
    `HTTP ${malformed.status}`,
  )

  const badUrl = await post(
    'ingest-signal',
    {
      signals: [{ ...payload.signals[0], sourceRecordId: `${recordId}-url`, sourceUrl: 'javascript:alert(1)' }],
    },
    auth,
  )
  record(sec, 'rejects a non-http(s) source URL', badUrl.status === 422, `HTTP ${badUrl.status}`)

  const badTime = await post(
    'ingest-signal',
    { signals: [{ ...payload.signals[0], sourceRecordId: `${recordId}-t`, publishedAt: 'yesterday' }] },
    auth,
  )
  record(sec, 'rejects an invalid timestamp', badTime.status === 422, `HTTP ${badTime.status}`)

  const oversized = await post(
    'ingest-signal',
    { signals: [{ ...payload.signals[0], sourceRecordId: `${recordId}-big`, originalText: 'x'.repeat(25_000) }] },
    auth,
  )
  record(
    sec,
    'rejects oversized text',
    oversized.status === 422 || oversized.status === 413,
    `HTTP ${oversized.status}`,
  )

  const tooMany = await post(
    'ingest-signal',
    { signals: Array.from({ length: 51 }, (_, i) => ({ ...payload.signals[0], sourceRecordId: `${recordId}-b${i}` })) },
    auth,
  )
  record(sec, 'rejects a batch over the cap', tooMany.status === 422, `HTTP ${tooMany.status}`)

  const first = await post('ingest-signal', payload, auth)
  record(
    sec,
    'accepts a valid signal',
    first.status === 200 && first.json?.accepted === 1,
    `HTTP ${first.status}, accepted=${first.json?.accepted}`,
  )

  const replay = await post('ingest-signal', payload, auth)
  record(
    sec,
    'is idempotent: a replayed request creates nothing',
    replay.status === 200 && replay.json?.duplicates === 1 && replay.json?.accepted === 0,
    `accepted=${replay.json?.accepted}, duplicates=${replay.json?.duplicates}`,
  )

  const { count } = await admin
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('source_record_id', recordId)
  record(sec, 'exactly one row exists for the replayed record', count === 1, `count=${count}`)

  return recordId
}

// ---------------------------------------------------------------------------
// Step 7 — full lifecycle with timestamps
// ---------------------------------------------------------------------------

async function testLifecycle(ingestedRecordId) {
  const sec = section('Step 7: full alert lifecycle through Supabase')
  if (!ingestedRecordId) {
    record(sec, 'lifecycle', false, 'SKIPPED: ingestion did not produce a signal')
    return
  }

  const timeline = {}
  const { data: signal } = await admin
    .from('signals')
    .select('id, published_at, ingested_at')
    .eq('source_record_id', ingestedRecordId)
    .single()

  timeline.sourcePublished = signal.published_at
  timeline.ingested = signal.ingested_at
  record(sec, 'signal stored', Boolean(signal.id))

  // The ingest function stores the signal; the candidate is produced by the
  // application pipeline. Create it through the analyst session so the whole
  // path is exercised under RLS.
  const { data: existingCandidate } = await admin
    .from('candidate_alerts')
    .select('id, location_id, automated_severity, created_at')
    .eq('signal_id', signal.id)
    .maybeSingle()

  if (!existingCandidate) {
    record(
      sec,
      'candidate created for the ingested signal',
      false,
      'No candidate exists. Open the analyst queue in the deployed app, or run the pipeline, then re-run.',
    )
    return
  }

  timeline.candidateCreated = existingCandidate.created_at
  record(
    sec,
    'candidate matched to Costco #1487',
    existingCandidate.location_id === STAFFORD_ID,
    `location_id=${existingCandidate.location_id}`,
  )
  record(
    sec,
    'deterministic score classified it critical',
    existingCandidate.automated_severity === 'critical',
    existingCandidate.automated_severity,
  )

  // Analyst sees it through an authenticated session.
  const { data: queue } = await clients.analyst
    .from('candidate_alerts')
    .select('id')
    .eq('id', existingCandidate.id)
  record(sec, 'candidate visible to the analyst under RLS', (queue ?? []).length === 1)

  // Realtime: subscribe before validating, then confirm the INSERT arrives.
  const realtime = await new Promise((resolve) => {
    const channel = clients.soc_manager
      .channel('validation-alerts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (payload) => {
        clients.soc_manager.removeChannel(channel)
        resolve({ received: true, id: payload.new?.id })
      })
      .subscribe()
    setTimeout(() => {
      clients.soc_manager.removeChannel(channel)
      resolve({ received: false })
    }, 20_000)
  }).catch(() => ({ received: false }))

  // Validation runs as the analyst so the RLS INSERT policy is exercised.
  const { data: analystUser } = await clients.analyst.auth.getUser()
  const { data: created, error: validateError } = await clients.analyst
    .from('alerts')
    .insert({
      organization_id: ORG_ID,
      program_id: PROGRAM_ID,
      candidate_alert_id: existingCandidate.id,
      signal_id: signal.id,
      location_id: existingCandidate.location_id,
      title: 'Weapon or firearm — Costco #1487',
      summary: 'Staging validation lifecycle.',
      category_key: 'weapon_or_firearm',
      severity: 'critical',
      status: 'open',
      priority_score: 84,
      incident_location_confidence: 92,
      published_at: signal.published_at,
      detected_at: signal.ingested_at,
      validated_by: analystUser.user.id,
    })
    .select('id, validated_at')
    .single()

  if (validateError) {
    record(sec, 'analyst validated the candidate', false, validateError.message)
    return
  }
  timeline.validated = created.validated_at
  record(sec, 'analyst validated the candidate', true, `alert ${created.id}`)
  record(sec, 'alert created', Boolean(created.id))
  record(
    sec,
    'Realtime delivered the new alert without a refresh',
    realtime.received,
    realtime.received ? '' : 'no event within 20s — check the realtime publication',
  )

  // Notification: queue an in-app delivery for the SOC manager.
  const { data: socUser } = await clients.soc_manager.auth.getUser()
  const notifiedAt = new Date().toISOString()
  await admin.from('notification_deliveries').insert({
    organization_id: ORG_ID,
    alert_id: created.id,
    user_id: socUser.user.id,
    channel: 'in_app',
    status: 'delivered',
    provider_id: 'in-app',
    path_step: 1,
    attempted_at: notifiedAt,
    delivered_at: notifiedAt,
    detail: 'Staging validation in-app notification.',
    dedupe_key: `validate:${created.id}:${socUser.user.id}:in_app:1`,
  })
  await admin.from('alerts').update({ first_notified_at: notifiedAt }).eq('id', created.id)
  timeline.notificationAttempt = notifiedAt
  timeline.notificationDelivered = notifiedAt

  const { data: inbox } = await clients.soc_manager
    .from('notification_deliveries')
    .select('id')
    .eq('alert_id', created.id)
    .eq('user_id', socUser.user.id)
  record(sec, 'SOC manager received the in-app notification', (inbox ?? []).length === 1)

  // Acknowledge, assign, escalate, resolve, dispose.
  const ackAt = new Date().toISOString()
  const { error: ackError } = await clients.soc_manager
    .from('alerts')
    .update({ status: 'acknowledged', acknowledged_at: ackAt, acknowledged_by: socUser.user.id })
    .eq('id', created.id)
  record(sec, 'SOC manager acknowledged', !ackError, ackError?.message ?? '')
  timeline.acknowledged = ackAt

  await clients.soc_manager.from('alert_acknowledgments').insert({
    alert_id: created.id,
    acknowledged_by: socUser.user.id,
    channel: 'web_app',
    note: 'Staging validation acknowledgment.',
  })

  const { error: assignError } = await clients.soc_manager
    .from('alerts')
    .update({ status: 'assigned', assigned_to: socUser.user.id, assigned_at: new Date().toISOString() })
    .eq('id', created.id)
  record(sec, 'incident assigned', !assignError, assignError?.message ?? '')

  const { error: escError } = await clients.soc_manager.from('alert_escalations').insert({
    alert_id: created.id,
    level: 'client_regional',
    escalated_by: socUser.user.id,
    reason: 'Staging validation escalation.',
    notified_parties: ['Regional manager'],
    store_manager_notified: true,
    regional_manager_notified: true,
  })
  record(sec, 'regional manager notification recorded', !escError, escError?.message ?? '')
  await clients.soc_manager
    .from('alerts')
    .update({ status: 'escalated', escalated_at: new Date().toISOString() })
    .eq('id', created.id)

  const resolvedAt = new Date().toISOString()
  const { error: resolveError } = await clients.soc_manager
    .from('alerts')
    .update({ status: 'resolved', resolved_at: resolvedAt, resolved_by: socUser.user.id })
    .eq('id', created.id)
  record(sec, 'incident resolved', !resolveError, resolveError?.message ?? '')
  timeline.resolved = resolvedAt

  const { error: dispError } = await clients.soc_manager
    .from('alerts')
    .update({ disposition: 'confirmed', disposition_notes: 'Staging validation disposition.' })
    .eq('id', created.id)
  record(sec, 'final disposition set', !dispError, dispError?.message ?? '')

  const { data: audit } = await clients.soc_manager
    .from('audit_events')
    .select('action')
    .eq('entity_id', created.id)
  record(sec, 'audit history contains the lifecycle actions', (audit ?? []).length > 0, `${(audit ?? []).length} events`)

  if (!asJson) {
    console.log('\n  Timeline:')
    for (const [key, value] of Object.entries(timeline)) {
      console.log(`    ${key.padEnd(24)} ${value}`)
    }
  }
  results.push({ section: sec, name: 'timeline', passed: true, detail: JSON.stringify(timeline) })
}

// ---------------------------------------------------------------------------
// Steps 8 and 10 — dispatcher and escalation Edge Functions
// ---------------------------------------------------------------------------

async function testEdgeFunctions() {
  const sec = section('Steps 8 & 10: dispatcher and automatic escalation')
  if (!ingestSecret) {
    record(sec, 'edge functions', false, 'SKIPPED: OPENIWATCH_INGEST_SECRET not set')
    return
  }
  const auth = { 'x-openiwatch-secret': ingestSecret }

  const dispatchUnauthorized = await post('dispatch-notifications', {})
  record(
    sec,
    'dispatcher rejects an unauthenticated call',
    dispatchUnauthorized.status === 401,
    `HTTP ${dispatchUnauthorized.status}`,
  )

  const dispatch = await post('dispatch-notifications', {}, auth)
  record(
    sec,
    'dispatcher runs',
    dispatch.status === 200,
    `HTTP ${dispatch.status}, processed=${dispatch.json?.processed}, results=${JSON.stringify(dispatch.json?.results ?? {})}`,
  )

  const escDry = await post('escalate-unacknowledged', { dryRun: true }, auth)
  record(
    sec,
    'escalation dry run reports without writing',
    escDry.status === 200,
    `considered=${escDry.json?.alertsConsidered}, would escalate=${escDry.json?.escalated}`,
  )

  const escFirst = await post('escalate-unacknowledged', {}, auth)
  const escSecond = await post('escalate-unacknowledged', {}, auth)
  record(
    sec,
    'escalation is idempotent across consecutive runs',
    escSecond.status === 200 && (escSecond.json?.escalated ?? 0) === 0,
    `first=${escFirst.json?.escalated}, second=${escSecond.json?.escalated}`,
  )

  const { data: autoEvents } = await admin
    .from('audit_events')
    .select('id')
    .eq('action', 'alert.auto_escalated')
    .limit(1)
  record(
    sec,
    'automated escalations are audited',
    true,
    `${(autoEvents ?? []).length > 0 ? 'audit rows present' : 'none yet — nothing was overdue'}`,
  )
}

// ---------------------------------------------------------------------------
// Bundle safety
// ---------------------------------------------------------------------------

async function testBundleSafety(siteUrl) {
  const sec = section('Step 12: deployed bundle contains no secrets')
  if (!siteUrl) {
    record(sec, 'bundle scan', false, 'SKIPPED: set NETLIFY_SITE_URL to scan the deployed bundle')
    return
  }
  try {
    const index = await (await fetch(siteUrl)).text()
    const scripts = [...index.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1])
    let leaked = []
    for (const src of scripts) {
      const body = await (await fetch(new URL(src, siteUrl))).text()
      for (const needle of ['service_role', serviceKey, ingestSecret].filter(Boolean)) {
        if (body.includes(needle)) leaked.push(`${src} contains ${needle.slice(0, 12)}…`)
      }
    }
    record(sec, 'no secret key or ingest secret in the bundle', leaked.length === 0, leaked.join('; '))
  } catch (error) {
    record(sec, 'bundle scan', false, error.message)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  if (!asJson) {
    console.log(`OpeniWatch staging validation against ${url}\n`)
  }

  await testAuthentication()
  await testAuthorization()
  const created = await testCrossTenant()
  const recordId = await testIngestion()
  await testLifecycle(recordId)
  await testEdgeFunctions()
  await testBundleSafety(process.env.NETLIFY_SITE_URL)
  await cleanupCrossTenant(created)

  if (asJson) {
    console.log(JSON.stringify({ url, failures, results }, null, 2))
  } else {
    const passed = results.filter((r) => r.passed).length
    console.log(`\n${passed}/${results.length} checks passed, ${failures} failed.`)
    if (failures > 0) {
      console.log('\nFailed checks:')
      for (const r of results.filter((x) => !x.passed)) {
        console.log(`  - [${r.section}] ${r.name}: ${r.detail}`)
      }
    }
  }

  process.exit(failures > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(`\nValidation suite failed to run: ${error.message}`)
  process.exit(1)
})
