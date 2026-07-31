import { describe, expect, it } from 'vitest'
import {
  LOCATION_IDS,
  seedGeofences,
  seedLocationAliases,
  seedLocations,
} from '@/data/seed/pilot'
import {
  applyAmbiguityPenalty,
  haversineMeters,
  matchLocations,
  type LocationMatchTarget,
} from './locationMatching'

const targets: LocationMatchTarget[] = seedLocations.map((location) => ({
  location,
  aliases: seedLocationAliases.filter((a) => a.locationId === location.id),
  geofences: seedGeofences.filter((g) => g.locationId === location.id),
}))

function match(text: string, coords?: { lat: number; lon: number; geotag?: boolean }) {
  return matchLocations(
    {
      originalText: text,
      sourceLatitude: coords?.lat ?? null,
      sourceLongitude: coords?.lon ?? null,
      hasPublicGeotag: coords?.geotag ?? false,
    },
    targets,
  )
}

describe('haversineMeters', () => {
  it('returns zero for the same point', () => {
    expect(haversineMeters(29.628, -95.556, 29.628, -95.556)).toBe(0)
  })

  it('measures a short distance plausibly', () => {
    // ~0.001 degrees of latitude is roughly 111 m.
    const d = haversineMeters(29.628, -95.556, 29.629, -95.556)
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(120)
  })
})

describe('matchLocations', () => {
  it('matches on an explicit warehouse number', () => {
    const results = match('Man with a gun in the parking lot at Costco #1487 in Stafford')
    expect(results[0]?.locationId).toBe(LOCATION_IDS.stafford)
    expect(results[0]?.method).toBe('store_number_mention')
    expect(results[0]!.confidence).toBeGreaterThan(80)
  })

  it('matches a warehouse number written with leading zeros', () => {
    const results = match('Protest being organised outside Costco #01147 on Dublin St')
    expect(results[0]?.locationId).toBe(LOCATION_IDS.newOrleans)
  })

  it('matches the same warehouse when the leading zero is dropped', () => {
    const results = match('Something going on at Costco 1147 in New Orleans')
    expect(results[0]?.locationId).toBe(LOCATION_IDS.newOrleans)
  })

  it('does not match a bare number without store context', () => {
    // "1487" appearing in unrelated text must not pull in the Stafford store.
    const results = match('The property sold for 1487 dollars per square metre')
    expect(results.find((r) => r.locationId === LOCATION_IDS.stafford)).toBeUndefined()
  })

  it('does not match a number embedded in a longer number', () => {
    const results = match('Reference code 21487 was issued at the Costco')
    const stafford = results.find((r) => r.locationId === LOCATION_IDS.stafford)
    expect(stafford?.method).not.toBe('store_number_mention')
  })

  it('matches the client local reference "Mt. Vernon"', () => {
    const results = match('Heavy police presence at the Mt. Vernon Costco this afternoon')
    expect(results[0]?.locationId).toBe(LOCATION_IDS.mtVernon)
    expect(results[0]?.evidence.join(' ')).toMatch(/alias/i)
  })

  it('matches on a street address', () => {
    const results = match('Fight in the lot at 791 N. Krocks Rd Costco')
    expect(results[0]?.locationId).toBe(LOCATION_IDS.allentown)
  })

  it('matches city plus brand at lower confidence than a warehouse number', () => {
    const byCity = match('Long lines at the Plano Costco today')
    const byNumber = match('Long lines at Costco #696 today')
    expect(byCity[0]?.locationId).toBe(LOCATION_IDS.plano)
    expect(byNumber[0]!.confidence).toBeGreaterThan(byCity[0]!.confidence)
  })

  it('uses a public geotag inside the property geofence as the strongest signal', () => {
    const results = match('Something is happening here', {
      lat: 29.6281,
      lon: -95.5561,
      geotag: true,
    })
    expect(results[0]?.locationId).toBe(LOCATION_IDS.stafford)
    expect(results[0]?.method).toBe('explicit_geotag')
    expect(results[0]!.confidence).toBeGreaterThanOrEqual(90)
  })

  it('treats coordinates without a geotag as weaker than a geotag', () => {
    const geotagged = match('Something here', { lat: 29.6281, lon: -95.5561, geotag: true })
    const plain = match('Something here', { lat: 29.6281, lon: -95.5561, geotag: false })
    expect(plain[0]!.confidence).toBeLessThan(geotagged[0]!.confidence)
    expect(plain[0]?.method).toBe('coordinate_proximity')
  })

  it('lowers confidence for a vicinity-only coordinate hit', () => {
    // ~1 km away: inside the vicinity ring, outside property and parking.
    const nearby = match('Something here', { lat: 29.637, lon: -95.556, geotag: true })
    const onSite = match('Something here', { lat: 29.6281, lon: -95.5561, geotag: true })
    expect(nearby[0]!.confidence).toBeLessThan(onSite[0]!.confidence)
    expect(nearby[0]?.evidence.join(' ')).toMatch(/vicinity/i)
  })

  it('returns nothing when no location can be established', () => {
    expect(match('The weather is nice today')).toEqual([])
  })

  it('never reports certainty', () => {
    const results = match('Costco #1487 at 12717 Network Drive in Stafford TX', {
      lat: 29.6281,
      lon: -95.5561,
      geotag: true,
    })
    expect(results[0]!.confidence).toBeLessThanOrEqual(97)
  })

  it('records evidence for every match', () => {
    const results = match('Man with a gun at Costco #1487 in Stafford')
    for (const result of results) {
      expect(result.evidence.length).toBeGreaterThan(0)
      for (const item of result.evidence) {
        expect(item.length).toBeGreaterThan(10)
      }
    }
  })

  it('raises confidence when independent methods corroborate', () => {
    const single = match('Trouble at Costco #1381')
    const multiple = match('Trouble at Costco #1381, 1500 US-287 in Mansfield TX')
    expect(multiple[0]!.confidence).toBeGreaterThan(single[0]!.confidence)
  })

  it('ignores inactive locations', () => {
    const deactivated = targets.map((t) =>
      t.location.id === LOCATION_IDS.stafford
        ? { ...t, location: { ...t.location, isActive: false } }
        : t,
    )
    const results = matchLocations(
      {
        originalText: 'Man with a gun at Costco #1487',
        sourceLatitude: null,
        sourceLongitude: null,
        hasPublicGeotag: false,
      },
      deactivated,
    )
    expect(results.find((r) => r.locationId === LOCATION_IDS.stafford)).toBeUndefined()
  })
})

describe('applyAmbiguityPenalty', () => {
  it('leaves a clear winner untouched', () => {
    const results = match('Man with a gun at Costco #1487 in Stafford')
    const adjusted = applyAmbiguityPenalty(results)
    expect(adjusted[0]!.confidence).toBe(results[0]!.confidence)
  })

  it('lowers confidence when several locations match with similar strength', () => {
    const ambiguous = [
      { locationId: 'a', method: 'city_and_brand' as const, confidence: 50, evidence: ['x'], distanceMeters: null },
      { locationId: 'b', method: 'city_and_brand' as const, confidence: 46, evidence: ['y'], distanceMeters: null },
    ]
    const adjusted = applyAmbiguityPenalty(ambiguous)
    expect(adjusted[0]!.confidence).toBe(35)
    expect(adjusted[0]!.evidence.join(' ')).toMatch(/reduced/i)
  })

  it('is a no-op for a single result', () => {
    const single = [
      { locationId: 'a', method: 'alias_mention' as const, confidence: 66, evidence: ['x'], distanceMeters: null },
    ]
    expect(applyAmbiguityPenalty(single)).toEqual(single)
  })
})
