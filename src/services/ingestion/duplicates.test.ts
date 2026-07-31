import { describe, expect, it } from 'vitest'
import type { Signal } from '@/domain/types'
import { ORG_ID, PROGRAM_ID } from '@/data/seed/pilot'
import { computeContentHash } from './normalize'
import { countCorroboration, findDuplicates } from './duplicates'

const BASE_TIME = '2026-03-14T18:30:00.000Z'

function makeSignal(overrides: Partial<Signal> & { id: string; originalText: string }): Signal {
  return {
    organizationId: ORG_ID,
    programId: PROGRAM_ID,
    collectionSourceId: null,
    authorId: null,
    sourcePlatform: 'Public web source',
    sourceRecordId: overrides.id,
    sourceUrl: null,
    publishedAt: BASE_TIME,
    ingestedAt: BASE_TIME,
    collectionMethod: 'webhook',
    provenance: 'test',
    contentHash: computeContentHash(
      overrides.sourcePlatform ?? 'Public web source',
      overrides.originalText,
    ),
    rawPayload: {},
    sourceLatitude: null,
    sourceLongitude: null,
    hasPublicGeotag: false,
    language: 'en',
    isRetentionRestricted: false,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    createdBy: null,
    updatedBy: null,
    ...overrides,
  }
}

const original = makeSignal({
  id: 'signal-1',
  originalText: 'Man with a gun in the parking lot at Costco #1487 in Stafford right now',
  authorId: 'author-1',
})

describe('findDuplicates', () => {
  it('detects an exact duplicate by content hash', () => {
    const findings = findDuplicates(
      {
        contentHash: original.contentHash,
        originalText: original.originalText,
        publishedAt: BASE_TIME,
        sourcePlatform: 'Public web source',
      },
      [original],
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.method).toBe('content_hash')
    expect(findings[0]?.similarity).toBe(100)
  })

  it('detects a near duplicate with reworded text', () => {
    const reworded =
      'Man with a gun in the parking lot at Costco #1487 in Stafford right now, everyone is running'
    const findings = findDuplicates(
      {
        contentHash: computeContentHash('Public web source', reworded),
        originalText: reworded,
        publishedAt: BASE_TIME,
        sourcePlatform: 'Public web source',
      },
      [original],
    )
    expect(findings[0]?.method).toBe('near_duplicate_text')
    expect(findings[0]!.similarity).toBeGreaterThanOrEqual(72)
  })

  it('does not flag unrelated reports', () => {
    const other = 'The rotisserie chicken was sold out again at the Plano store'
    const findings = findDuplicates(
      {
        contentHash: computeContentHash('Public web source', other),
        originalText: other,
        publishedAt: BASE_TIME,
        sourcePlatform: 'Public web source',
      },
      [original],
    )
    expect(findings).toEqual([])
  })

  it('ignores signals outside the comparison window', () => {
    const old = makeSignal({
      id: 'signal-old',
      originalText: original.originalText,
      publishedAt: '2026-03-01T18:30:00.000Z',
    })
    const findings = findDuplicates(
      {
        contentHash: original.contentHash,
        originalText: original.originalText,
        publishedAt: BASE_TIME,
        sourcePlatform: 'Public web source',
      },
      [old],
    )
    expect(findings).toEqual([])
  })

  it('notes when a near duplicate came from a different platform', () => {
    const crossPlatform = makeSignal({
      id: 'signal-rss',
      originalText: original.originalText,
      sourcePlatform: 'RSS',
    })
    const findings = findDuplicates(
      {
        contentHash: original.contentHash,
        originalText: original.originalText,
        publishedAt: BASE_TIME,
        sourcePlatform: 'Public web source',
      },
      [crossPlatform],
    )
    // Different platform means a different hash, so this is a text match, and
    // the note must flag it as potential corroboration rather than duplication.
    expect(findings[0]?.method).toBe('near_duplicate_text')
    expect(findings[0]?.notes).toMatch(/corroboration/i)
  })

  it('sorts the strongest match first', () => {
    const weaker = makeSignal({
      id: 'signal-2',
      originalText: 'Man with a gun in the parking lot at Costco in Stafford, police on the way now',
      authorId: 'author-2',
    })
    const findings = findDuplicates(
      {
        contentHash: original.contentHash,
        originalText: original.originalText,
        publishedAt: BASE_TIME,
        sourcePlatform: 'Public web source',
      },
      [weaker, original],
    )
    expect(findings[0]?.similarity).toBe(100)
  })
})

describe('countCorroboration', () => {
  const second = makeSignal({
    id: 'signal-2',
    originalText: original.originalText,
    authorId: 'author-2',
  })
  const third = makeSignal({
    id: 'signal-3',
    originalText: original.originalText,
    authorId: 'author-3',
  })
  const sameAuthorAgain = makeSignal({
    id: 'signal-4',
    originalText: original.originalText,
    authorId: 'author-1',
  })

  const index = new Map([second, third, sameAuthorAgain].map((s) => [s.id, s]))

  it('counts distinct independent authors', () => {
    const findings = [
      { duplicateOfSignalId: 'signal-2', similarity: 95, method: 'near_duplicate_text' as const, notes: '' },
      { duplicateOfSignalId: 'signal-3', similarity: 92, method: 'near_duplicate_text' as const, notes: '' },
    ]
    expect(countCorroboration(findings, index, 'author-1')).toBe(2)
  })

  it('does not count the same author posting repeatedly as corroboration', () => {
    const findings = [
      { duplicateOfSignalId: 'signal-4', similarity: 100, method: 'content_hash' as const, notes: '' },
    ]
    expect(countCorroboration(findings, index, 'author-1')).toBe(0)
  })

  it('returns zero when there are no findings', () => {
    expect(countCorroboration([], index, 'author-1')).toBe(0)
  })
})
