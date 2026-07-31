import { describe, expect, it } from 'vitest'
import { buildSignal } from '@/services/scoring/testFixtures'
import { assertAuthorLocationSupported, assessAuthorLocation } from './authorLocation'

/**
 * These tests exist to hold a privacy line, not just a code path: OpeniWatch
 * must never infer where a person is from their profile, biography or posting
 * history.
 */

describe('assessAuthorLocation', () => {
  it('defaults to unknown with no evidence', () => {
    const result = assessAuthorLocation(
      buildSignal({ text: 'There was a fight at the Costco in Plano yesterday.' }),
    )
    expect(result.status).toBe('unknown')
    expect(result.confidence).toBe(0)
    expect(result.evidence).toEqual([])
  })

  it('does not infer current location from a profile location', () => {
    // buildSignal attaches a profile location of "Houston, TX".
    const result = assessAuthorLocation(
      buildSignal({ text: 'Saw a report about the Stafford Costco.' }),
    )
    expect(result.status).toBe('unknown')
  })

  it('does not infer current location from a location mentioned in the text', () => {
    const result = assessAuthorLocation(
      buildSignal({ text: 'Something happened at Costco #1487 in Stafford, Texas.' }),
    )
    expect(result.status).toBe('unknown')
  })

  it('accepts a public geotag as evidence', () => {
    const result = assessAuthorLocation(
      buildSignal({
        text: 'Something is going on out here.',
        latitude: 29.6281,
        longitude: -95.5561,
        hasPublicGeotag: true,
      }),
    )
    expect(result.status).toBe('geotagged')
    expect(result.evidence[0]?.kind).toBe('public_geotag')
    expect(result.confidence).toBeGreaterThan(70)
  })

  it('distinguishes coordinates in the payload from an explicit public geotag', () => {
    const result = assessAuthorLocation(
      buildSignal({
        text: 'Something is going on out here.',
        latitude: 29.6281,
        longitude: -95.5561,
        hasPublicGeotag: false,
      }),
    )
    expect(result.evidence[0]?.kind).toBe('coordinates_in_source')
    expect(result.evidence[0]?.detail).toMatch(/without an explicit public geotag/i)
  })

  it('accepts an explicit contemporaneous statement', () => {
    const result = assessAuthorLocation(
      buildSignal({ text: 'I am in the parking lot right now and there is a man with a gun.' }),
    )
    expect(result.status).toBe('reported_by_author')
    expect(result.evidence[0]?.kind).toBe('contemporaneous_statement')
    expect(result.evidence[0]?.detail).toContain('"')
  })

  it('treats "just saw" as a first-hand contemporaneous report', () => {
    const result = assessAuthorLocation(
      buildSignal({ text: 'Just saw someone pull a gun outside the entrance.' }),
    )
    expect(result.status).toBe('reported_by_author')
  })

  it('raises confidence when several kinds of evidence agree, but never to certainty', () => {
    const single = assessAuthorLocation(
      buildSignal({
        text: 'Something is happening.',
        latitude: 29.6281,
        longitude: -95.5561,
        hasPublicGeotag: true,
      }),
    )
    const corroborated = assessAuthorLocation(
      buildSignal({
        text: 'I am standing in the parking lot right now watching this.',
        latitude: 29.6281,
        longitude: -95.5561,
        hasPublicGeotag: true,
      }),
    )
    expect(corroborated.confidence).toBeGreaterThan(single.confidence)
    expect(corroborated.confidence).toBeLessThanOrEqual(90)
  })

  it('always attributes the automated assessment to the automated source', () => {
    const result = assessAuthorLocation(
      buildSignal({ text: 'I am here right now.', latitude: 1, longitude: 1 }),
    )
    expect(result.assessedBy).toBe('automated')
  })
})

describe('assertAuthorLocationSupported', () => {
  it('allows unknown with no evidence', () => {
    expect(() =>
      assertAuthorLocationSupported({
        status: 'unknown',
        statedLocation: null,
        confidence: 0,
        evidence: [],
        assessedBy: 'analyst',
      }),
    ).not.toThrow()
  })

  it('rejects a populated status with no evidence', () => {
    expect(() =>
      assertAuthorLocationSupported({
        status: 'geotagged',
        statedLocation: 'Stafford, TX',
        confidence: 80,
        evidence: [],
        assessedBy: 'analyst',
      }),
    ).toThrow(/evidence/i)
  })

  it('allows a populated status backed by evidence', () => {
    expect(() =>
      assertAuthorLocationSupported({
        status: 'visually_corroborated',
        statedLocation: 'Stafford, TX',
        confidence: 65,
        evidence: [
          {
            kind: 'visual_evidence',
            detail: 'Storefront signage visible in the attached photo.',
            sourceUrl: null,
          },
        ],
        assessedBy: 'analyst',
      }),
    ).not.toThrow()
  })
})
