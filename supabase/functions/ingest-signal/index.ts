// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import { validateBatch, type ValidatedSignal } from '../_shared/signal-schema.ts'
import { getSecretKey } from '../_shared/supabase-keys.ts'

/**
 * Secure signal ingestion endpoint.
 *
 * POST /functions/v1/ingest-signal
 *   Headers: x-openiwatch-secret: <OPENIWATCH_INGEST_SECRET>
 *            content-type: application/json
 *   Body:    { "signals": [ ... ], "batchId": "optional" }
 *
 * Guarantees:
 *   - Authentication by shared secret, compared in constant time.
 *   - Rate limited per caller, counted in the database so the limit holds
 *     across cold starts and instances.
 *   - Every payload validated against the shared schema before any write.
 *   - Idempotent: (organization, platform, source record id) is unique, so a
 *     retried delivery creates nothing new and still returns 200.
 *   - Content-hashed for duplicate detection.
 *   - Writes an audit event per accepted batch.
 *
 * The service-role key is read from the environment here and never leaves the
 * server. Errors returned to callers never include configuration values.
 */

const SECRET_HEADER = 'x-openiwatch-secret'
const MAX_BODY_BYTES = 512 * 1024

interface IngestEnv {
  supabaseUrl: string
  secretKey: string
  ingestSecret: string
}

function readEnv(): IngestEnv | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  // Elevated project access, read from the SUPABASE_SECRET_KEYS dictionary
  // Supabase injects. Not a JWT — see _shared/supabase-keys.ts.
  const secretKey = getSecretKey()
  const ingestSecret = Deno.env.get('OPENIWATCH_INGEST_SECRET') ?? ''
  if (!supabaseUrl || !secretKey || !ingestSecret) return null
  return { supabaseUrl, secretKey, ingestSecret }
}

/** Length-independent comparison so the secret cannot be probed by timing. */
async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  // Hashing first normalises length, which keeps the comparison constant time
  // regardless of how long the supplied value is.
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
    headers: {
      'content-type': 'application/json',
      // This endpoint is machine-to-machine; no browser should embed it.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Canonical form used for hashing. Mirrors canonicalizeText in the client. */
function canonicalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@](\w+)/g, ' ')
    .replace(/[#](\w+)/g, ' $1 ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function contentHash(sourcePlatform: string, originalText: string): Promise<string> {
  const canonical = `${sourcePlatform.trim().toLowerCase()} ${canonicalizeText(originalText)}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Identifier used for rate limiting.
 *
 * Prefers the forwarded client address; falls back to a fixed bucket so an
 * unattributable caller is still limited rather than unlimited.
 */
function rateLimitKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? ''
  const ip = forwarded.split(',')[0]?.trim()
  return `ingest:${ip || 'unattributed'}`
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed. Use POST.' }, 405)
  }

  const env = readEnv()
  if (!env) {
    // Do not name which variable is missing: this response is public.
    console.error('ingest-signal: required environment configuration is missing')
    return json({ error: 'The ingest endpoint is not configured.' }, 503)
  }

  const provided = request.headers.get(SECRET_HEADER) ?? ''
  if (!provided || !(await secretsMatch(provided, env.ingestSecret))) {
    return json({ error: 'Unauthorized.' }, 401)
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'Payload too large.' }, 413)
  }

  const supabase = createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Rate limit before parsing: an over-limit caller should cost as little as
  // possible.
  const { data: withinLimit, error: rateError } = await supabase.rpc('check_ingest_rate', {
    p_bucket_key: rateLimitKey(request),
    p_limit: 120,
    p_window_seconds: 60,
  })
  if (rateError) {
    console.error('ingest-signal: rate limit check failed', rateError.message)
    return json({ error: 'Unable to process the request.' }, 503)
  }
  if (withinLimit === false) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded.' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    })
  }

  let payload: unknown
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'Payload too large.' }, 413)
    payload = JSON.parse(raw)
  } catch {
    return json({ error: 'Body must be valid JSON.' }, 400)
  }

  const { signals, issues, batchId } = validateBatch(payload)
  if (issues.length > 0) {
    return json({ error: 'Validation failed.', issues }, 422)
  }

  // The target program is resolved from configuration rather than the payload,
  // so a caller cannot write into a program it was not issued a secret for.
  const programSlug = Deno.env.get('OPENIWATCH_INGEST_PROGRAM_SLUG') ?? 'costco-pilot'
  const { data: program, error: programError } = await supabase
    .from('programs')
    .select('id, organization_id')
    .eq('slug', programSlug)
    .maybeSingle()

  if (programError || !program) {
    console.error('ingest-signal: target program could not be resolved', programError?.message)
    return json({ error: 'The ingest endpoint is not configured.' }, 503)
  }

  const organizationId = (program as any).organization_id as string
  const programId = (program as any).id as string

  const accepted: Array<{ sourceRecordId: string; signalId: string }> = []
  const duplicates: string[] = []
  const failed: Array<{ sourceRecordId: string; reason: string }> = []

  for (const signal of signals as ValidatedSignal[]) {
    try {
      let authorId: string | null = null

      if (signal.author) {
        // Author records hold only what the source published.
        const { data: author, error: authorError } = await supabase
          .from('signal_authors')
          .upsert(
            {
              organization_id: organizationId,
              platform: signal.sourcePlatform,
              handle: signal.author.handle,
              display_name: signal.author.displayName,
              profile_location_text: signal.author.profileLocationText,
              profile_url: signal.author.profileUrl,
              profile_description: signal.author.profileDescription,
              source_profile_metadata: signal.author.sourceProfileMetadata,
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: 'organization_id,platform,handle' },
          )
          .select('id')
          .single()

        if (authorError) throw new Error(authorError.message)
        authorId = (author as any).id
      }

      const hash = await contentHash(signal.sourcePlatform, signal.originalText)

      const { data: inserted, error: signalError } = await supabase
        .from('signals')
        .insert({
          organization_id: organizationId,
          program_id: programId,
          author_id: authorId,
          source_platform: signal.sourcePlatform,
          source_record_id: signal.sourceRecordId,
          source_url: signal.sourceUrl,
          original_text: signal.originalText,
          published_at: signal.publishedAt,
          collection_method: signal.collectionMethod,
          provenance: signal.provenance,
          content_hash: hash,
          raw_payload: signal.rawPayload,
          source_latitude: signal.latitude,
          source_longitude: signal.longitude,
          has_public_geotag: signal.hasPublicGeotag,
          language: signal.language,
        })
        .select('id')
        .single()

      if (signalError) {
        // 23505 is unique_violation: the same source record already exists.
        // That is the idempotency guarantee working, not a failure.
        if ((signalError as any).code === '23505') {
          duplicates.push(signal.sourceRecordId)
          continue
        }
        throw new Error(signalError.message)
      }

      const signalId = (inserted as any).id as string

      if (signal.media.length > 0) {
        const { error: mediaError } = await supabase.from('signal_media').insert(
          signal.media.map((item) => ({
            signal_id: signalId,
            media_type: item.mediaType,
            url: item.url,
            thumbnail_url: item.thumbnailUrl,
            caption: item.caption,
            captured_at: item.capturedAt,
          })),
        )
        if (mediaError) throw new Error(mediaError.message)
      }

      accepted.push({ sourceRecordId: signal.sourceRecordId, signalId })
    } catch (error) {
      // Log server-side with detail; return only a generic reason to the caller.
      console.error('ingest-signal: failed to store signal', signal.sourceRecordId, error)
      failed.push({ sourceRecordId: signal.sourceRecordId, reason: 'storage_error' })
    }
  }

  // A single audit event per batch keeps the trail readable while still
  // recording every ingestion.
  await supabase.from('audit_events').insert({
    organization_id: organizationId,
    actor_user_id: null,
    actor_role: 'system',
    action: 'signal.ingested_via_webhook',
    entity_type: 'program',
    entity_id: programId,
    detail: {
      batchId,
      accepted: accepted.length,
      duplicates: duplicates.length,
      failed: failed.length,
    },
  })

  return json(
    {
      accepted: accepted.length,
      duplicates: duplicates.length,
      failed: failed.length,
      batchId,
      // Returned so a caller can reconcile which records landed.
      acceptedRecords: accepted,
      duplicateRecords: duplicates,
      failedRecords: failed,
    },
    failed.length > 0 && accepted.length === 0 ? 502 : 200,
  )
})
