import type { ScoringThreshold } from '@/domain/types'
import type { NormalizedSignal } from '@/services/ingestion/normalize'
import { normalizeSignal } from '@/services/ingestion/normalize'
import { signalInputSchema } from '@/services/ingestion/schema'
import { UNKNOWN_AUTHOR_LOCATION } from '@/services/ingestion/authorLocation'
import type { LocationMatchResult } from '@/services/ingestion/locationMatching'
import { findCategorySeed } from '@/domain/taxonomy'
import type { ScoringCategory, ScoringInput } from './types'

/** Shared fixtures for scoring, classification and matching tests. */

export const TEST_NOW = '2026-03-14T18:41:00.000Z'

export const TEST_THRESHOLDS: ScoringThreshold = {
  id: 'threshold-test',
  organizationId: 'org-test',
  criticalMin: 80,
  highMin: 60,
  moderateMin: 35,
  autoSuppressBelow: 10,
  minimumLocationConfidence: 25,
  scorerId: 'deterministic-v1',
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
  createdBy: null,
  updatedBy: null,
}

export function categoryFor(key: string): ScoringCategory {
  const seed = findCategorySeed(key)
  if (!seed) throw new Error(`Unknown category seed: ${key}`)
  return {
    key: seed.key,
    label: seed.label,
    baselineSeverity: seed.baselineSeverity,
    severityWeight: seed.severityWeight,
  }
}

export function buildSignal(overrides: {
  text: string
  publishedAt?: string
  sourcePlatform?: string
  sourceUrl?: string | null
  collectionMethod?: 'manual_submission' | 'webhook' | 'connector_pull' | 'simulator'
  handle?: string | null
  latitude?: number | null
  longitude?: number | null
  hasPublicGeotag?: boolean
  mediaCount?: number
}): NormalizedSignal {
  const parsed = signalInputSchema.parse({
    sourcePlatform: overrides.sourcePlatform ?? 'Public web source',
    sourceRecordId: `test-${overrides.text.length}-${overrides.publishedAt ?? TEST_NOW}`,
    sourceUrl: overrides.sourceUrl === undefined ? 'https://example.com/post/1' : overrides.sourceUrl,
    originalText: overrides.text,
    publishedAt: overrides.publishedAt ?? TEST_NOW,
    collectionMethod: overrides.collectionMethod ?? 'webhook',
    provenance: 'Test fixture',
    author:
      overrides.handle === null
        ? null
        : {
            handle: overrides.handle ?? '@example',
            displayName: 'Example Account',
            profileLocationText: 'Houston, TX',
            sourceProfileMetadata: {},
          },
    media: Array.from({ length: overrides.mediaCount ?? 0 }, (_, i) => ({
      mediaType: 'image' as const,
      url: `https://example.com/media/${i}.jpg`,
    })),
    latitude: overrides.latitude ?? null,
    longitude: overrides.longitude ?? null,
    hasPublicGeotag: overrides.hasPublicGeotag ?? false,
    rawPayload: {},
  })
  return normalizeSignal(parsed, { ingestedAt: TEST_NOW })
}

export function buildMatch(confidence: number): LocationMatchResult {
  return {
    locationId: 'location-test',
    method: 'store_number_mention',
    confidence,
    evidence: ['Text names the warehouse number.'],
    distanceMeters: null,
  }
}

export function buildScoringInput(overrides: Partial<ScoringInput> & { signal: NormalizedSignal }): ScoringInput {
  return {
    category: categoryFor('other_operational_concern'),
    locationMatch: buildMatch(85),
    authorLocation: UNKNOWN_AUTHOR_LOCATION,
    corroboratingReports: 0,
    thresholds: TEST_THRESHOLDS,
    now: TEST_NOW,
    ...overrides,
  }
}
