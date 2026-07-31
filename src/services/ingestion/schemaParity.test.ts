import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLLECTION_METHODS } from '@/domain/enums'
import { MEDIA_TYPES, SIGNAL_INPUT_FIELDS, signalInputSchema } from './schema'

/**
 * Schema parity.
 *
 * The ingest Edge Function runs on Deno and cannot import the browser schema,
 * so it carries a hand-written mirror in
 * `supabase/functions/_shared/signal-schema.ts`. These tests fail if the two
 * drift — a field added on one side and forgotten on the other is exactly the
 * kind of gap that lets an unvalidated value reach the database.
 */

const EDGE_SCHEMA_PATH = resolve(
  __dirname,
  '../../../supabase/functions/_shared/signal-schema.ts',
)

function readEdgeSchema(): string {
  return readFileSync(EDGE_SCHEMA_PATH, 'utf8')
}

/** Pulls a `const NAME = [ ... ] as const` string array out of the source. */
function extractStringArray(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))
  if (!match?.[1]) throw new Error(`Could not find ${name} in the Edge Function schema`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('Edge Function schema parity', () => {
  const source = readEdgeSchema()

  it('accepts the same signal fields as the browser schema', () => {
    const edgeFields = extractStringArray(source, 'SIGNAL_INPUT_FIELDS').sort()
    expect(edgeFields).toEqual([...SIGNAL_INPUT_FIELDS].sort())
  })

  it('accepts the same collection methods', () => {
    const edgeMethods = extractStringArray(source, 'COLLECTION_METHODS').sort()
    expect(edgeMethods).toEqual([...COLLECTION_METHODS].sort())
  })

  it('accepts the same media types', () => {
    const edgeMediaTypes = extractStringArray(source, 'MEDIA_TYPES').sort()
    expect(edgeMediaTypes).toEqual([...MEDIA_TYPES].sort())
  })

  it('restricts URLs to http(s) on both sides', () => {
    // Browser side.
    expect(
      signalInputSchema.safeParse({
        sourcePlatform: 'Public web source',
        sourceRecordId: 'x',
        sourceUrl: 'javascript:alert(1)',
        originalText: 'text',
        publishedAt: new Date().toISOString(),
        collectionMethod: 'webhook',
        provenance: 'test',
      }).success,
    ).toBe(false)

    // Edge side: the guard exists and rejects non-http(s) protocols.
    expect(source).toMatch(/protocol !== 'http:' && .*protocol !== 'https:'/)
  })

  it('caps the batch size so one request cannot monopolise the endpoint', () => {
    expect(source).toMatch(/must contain at most 50 signals/)
  })

  it('never trusts a geotag claim without coordinates', () => {
    expect(source).toMatch(
      /hasPublicGeotag: input\.hasPublicGeotag === true && latitude !== null && longitude !== null/,
    )
  })
})

describe('ingest Edge Function', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../supabase/functions/ingest-signal/index.ts'),
    'utf8',
  )

  it('requires a shared secret and compares it in constant time', () => {
    expect(source).toContain('x-openiwatch-secret')
    expect(source).toMatch(/secretsMatch/)
    expect(source).toMatch(/diff \|= viewA\[i\]! \^ viewB\[i\]!/)
  })

  it('rate limits before parsing the body', () => {
    const rateIndex = source.indexOf('check_ingest_rate')
    const parseIndex = source.indexOf('JSON.parse(raw)')
    expect(rateIndex).toBeGreaterThan(-1)
    expect(rateIndex).toBeLessThan(parseIndex)
  })

  it('treats a unique violation as an idempotent duplicate rather than an error', () => {
    expect(source).toMatch(/'23505'/)
    expect(source).toMatch(/duplicates\.push/)
  })

  it('resolves the target program from configuration, not from the payload', () => {
    expect(source).toContain('OPENIWATCH_INGEST_PROGRAM_SLUG')
    // The payload must not be able to name its own organization or program.
    expect(source).not.toMatch(/payload\.(organizationId|programId)/)
  })

  it('does not leak configuration values in responses', () => {
    // Error responses are generic; details go to the server log only.
    expect(source).toContain("json({ error: 'The ingest endpoint is not configured.' }, 503)")
    expect(source).not.toMatch(/error:.*SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('writes an audit event for every batch', () => {
    expect(source).toContain('signal.ingested_via_webhook')
  })
})
