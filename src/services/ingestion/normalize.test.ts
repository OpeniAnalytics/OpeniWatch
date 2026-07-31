import { describe, expect, it } from 'vitest'
import { canonicalizeText, computeContentHash, normalizeSignal, textSimilarity } from './normalize'
import { signalInputSchema } from './schema'

const baseInput = {
  sourcePlatform: 'Public web source',
  sourceRecordId: 'post-123',
  sourceUrl: 'https://example.com/post/123',
  originalText: '  Man with a GUN in the parking lot at Costco #1487!!  ',
  publishedAt: '2026-03-14T18:39:00.000Z',
  collectionMethod: 'webhook' as const,
  provenance: 'Ingest webhook, test',
}

describe('canonicalizeText', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(canonicalizeText('  Hello,   WORLD!! ')).toBe('hello world')
  })

  it('removes URLs and @mentions but keeps hashtag words and ordinary text', () => {
    expect(canonicalizeText('Look https://a.co/x @someone #Stafford now')).toBe(
      'look stafford now',
    )
  })

  it('preserves digits so warehouse numbers survive', () => {
    expect(canonicalizeText('Costco #1487 parking lot')).toContain('1487')
  })
})

describe('computeContentHash', () => {
  it('is stable across casing, punctuation and whitespace differences', () => {
    const a = computeContentHash('Public web source', 'Man with a gun in the lot!')
    const b = computeContentHash('Public web source', '  man with a GUN in the lot  ')
    expect(a).toBe(b)
  })

  it('separates identical text on different platforms', () => {
    // Cross-platform repetition is corroboration and must not be collapsed.
    const a = computeContentHash('Public web source', 'Man with a gun in the lot')
    const b = computeContentHash('RSS', 'Man with a gun in the lot')
    expect(a).not.toBe(b)
  })

  it('changes when the substance changes', () => {
    const a = computeContentHash('Public web source', 'Man with a gun in the lot')
    const b = computeContentHash('Public web source', 'Man with a knife in the lot')
    expect(a).not.toBe(b)
  })
})

describe('normalizeSignal', () => {
  it('preserves the original text, published timestamp and source identifiers', () => {
    const parsed = signalInputSchema.parse(baseInput)
    const normalized = normalizeSignal(parsed, { ingestedAt: '2026-03-14T18:41:00.000Z' })

    expect(normalized.originalText).toBe('Man with a GUN in the parking lot at Costco #1487!!')
    expect(normalized.publishedAt).toBe('2026-03-14T18:39:00.000Z')
    expect(normalized.sourceRecordId).toBe('post-123')
    expect(normalized.ingestedAt).toBe('2026-03-14T18:41:00.000Z')
    expect(normalized.provenance).toBe('Ingest webhook, test')
  })

  it('records ingestion time separately from publication time', () => {
    const parsed = signalInputSchema.parse(baseInput)
    const normalized = normalizeSignal(parsed, { ingestedAt: '2026-03-14T18:41:00.000Z' })
    expect(Date.parse(normalized.ingestedAt)).toBeGreaterThan(Date.parse(normalized.publishedAt))
  })

  it('does not claim a geotag without coordinates to support it', () => {
    const parsed = signalInputSchema.parse({ ...baseInput, hasPublicGeotag: true })
    expect(normalizeSignal(parsed).hasPublicGeotag).toBe(false)

    const withCoords = signalInputSchema.parse({
      ...baseInput,
      hasPublicGeotag: true,
      latitude: 29.628,
      longitude: -95.556,
    })
    expect(normalizeSignal(withCoords).hasPublicGeotag).toBe(true)
  })

  it('produces an identical content hash for the same payload on any runtime', () => {
    const parsed = signalInputSchema.parse(baseInput)
    const a = normalizeSignal(parsed, { ingestedAt: '2026-03-14T18:41:00.000Z' })
    const b = normalizeSignal(parsed, { ingestedAt: '2026-03-15T09:00:00.000Z' })
    // Ingestion time must not influence the hash.
    expect(a.contentHash).toBe(b.contentHash)
  })
})

describe('signalInputSchema', () => {
  it('rejects a non-http source URL', () => {
    const result = signalInputSchema.safeParse({
      ...baseInput,
      sourceUrl: 'javascript:alert(1)',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty original text', () => {
    expect(signalInputSchema.safeParse({ ...baseInput, originalText: '' }).success).toBe(false)
  })

  it('rejects an unparseable published timestamp', () => {
    expect(signalInputSchema.safeParse({ ...baseInput, publishedAt: 'yesterday' }).success).toBe(
      false,
    )
  })

  it('rejects an out-of-range latitude', () => {
    expect(signalInputSchema.safeParse({ ...baseInput, latitude: 120 }).success).toBe(false)
  })

  it('accepts a valid payload and applies defaults', () => {
    const parsed = signalInputSchema.parse(baseInput)
    expect(parsed.media).toEqual([])
    expect(parsed.rawPayload).toEqual({})
    expect(parsed.hasPublicGeotag).toBe(false)
  })
})

describe('textSimilarity', () => {
  it('returns 100 for identical text', () => {
    expect(textSimilarity('man with a gun', 'Man with a GUN!')).toBe(100)
  })

  it('is high for reworded reports of the same event', () => {
    const a = 'Man with a gun in the parking lot at the Stafford Costco'
    const b = 'Man with a gun in the parking lot at the Stafford Costco right now'
    expect(textSimilarity(a, b)).toBeGreaterThan(70)
  })

  it('is low for unrelated reports', () => {
    expect(
      textSimilarity('Man with a gun in the parking lot', 'The rotisserie chicken was sold out'),
    ).toBeLessThan(20)
  })

  it('handles empty input without dividing by zero', () => {
    expect(textSimilarity('', 'anything')).toBe(0)
    expect(textSimilarity('!!!', '???')).toBe(0)
  })
})
