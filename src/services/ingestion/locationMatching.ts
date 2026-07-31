import type { LocationMatchMethod } from '@/domain/enums'
import type { LocationAlias, LocationGeofence, ProtectedLocation } from '@/domain/types'
import { canonicalizeText } from './normalize'

/**
 * Deterministic incident-location matching.
 *
 * This answers exactly one question: which protected location is the reported
 * INCIDENT at? It says nothing about where the author is — that is a separate
 * assessment with its own evidence rules (see `authorLocation.ts`).
 *
 * Every match carries the evidence that produced it, in plain language, so an
 * analyst can verify the reasoning rather than trust a number.
 */

export interface LocationMatchTarget {
  location: ProtectedLocation
  aliases: LocationAlias[]
  geofences: LocationGeofence[]
}

export interface LocationMatchResult {
  locationId: string
  method: LocationMatchMethod
  /** 0-100. */
  confidence: number
  evidence: string[]
  distanceMeters: number | null
}

/** Great-circle distance in metres. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

/**
 * Base confidence per method.
 *
 * No single textual method reaches certainty: text can be wrong, stale or
 * about a different store in the same city. Only a geotag inside the property
 * geofence approaches it, and even that is capped below 100.
 */
const METHOD_CONFIDENCE: Record<LocationMatchMethod, number> = {
  explicit_geotag: 94,
  coordinate_proximity: 82,
  store_number_mention: 88,
  address_mention: 84,
  alias_mention: 66,
  landmark_and_city: 58,
  city_and_brand: 46,
  analyst_assigned: 100,
}

/** Brand tokens that make a city mention meaningful rather than incidental. */
const BRAND_TOKENS = ['costco', 'warehouse club', 'wholesale club']

function containsToken(haystack: string, needle: string): boolean {
  const token = canonicalizeText(needle)
  if (!token) return false
  // Word-boundary match on the canonicalized text so "1487" does not match
  // inside "21487".
  return new RegExp(`(^| )${escapeRegExp(token)}( |$)`).test(haystack)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Facility numbers appear in the wild with and without leading zeros and with
 * or without a "#": "#01147", "1147", "Costco 01147". All forms are accepted,
 * but only when preceded by a store-context word or a "#" so that a bare
 * four-digit number in unrelated text does not match.
 */
function matchesFacilityNumber(originalText: string, facilityNumber: string): string | null {
  const trimmed = facilityNumber.replace(/^0+/, '')
  const variants = new Set([facilityNumber, trimmed, facilityNumber.padStart(5, '0')])
  const numberAlternatives = [...variants].filter(Boolean).map(escapeRegExp).join('|')

  const patterns: Array<{ regex: RegExp; label: string }> = [
    {
      regex: new RegExp(`#\\s?0*(${numberAlternatives})\\b`, 'i'),
      label: 'warehouse number written with a "#"',
    },
    {
      regex: new RegExp(
        `\\b(costco|store|warehouse|club|location)\\s*#?\\s*0*(${numberAlternatives})\\b`,
        'i',
      ),
      label: 'warehouse number next to a store reference',
    },
  ]

  for (const { regex, label } of patterns) {
    const found = originalText.match(regex)
    if (found) return `${label}: "${found[0].trim()}"`
  }
  return null
}

function matchesAddress(originalText: string, location: ProtectedLocation): string | null {
  const canonical = canonicalizeText(originalText)
  const streetNumber = location.addressLine1.match(/^\s*(\d+)/)?.[1]
  // Street name minus the leading number and the trailing suffix word.
  const streetWords = canonicalizeText(location.addressLine1.replace(/^\s*\d+\s*/, ''))
    .split(' ')
    .filter((w) => w.length > 2)

  if (!streetNumber || streetWords.length === 0) return null

  const hasNumber = containsToken(canonical, streetNumber)
  const distinctiveWord = streetWords.find((word) => containsToken(canonical, word))

  if (hasNumber && distinctiveWord) {
    return `street address referenced: "${streetNumber} ${streetWords.join(' ')}"`
  }
  return null
}

/**
 * Matches a normalized signal against every protected location.
 *
 * Returns results sorted by descending confidence. An empty array means no
 * location could be established — the candidate is then held for analyst
 * assignment rather than guessed at.
 */
export function matchLocations(
  signal: {
    originalText: string
    sourceLatitude: number | null
    sourceLongitude: number | null
    hasPublicGeotag: boolean
  },
  targets: readonly LocationMatchTarget[],
): LocationMatchResult[] {
  const canonical = canonicalizeText(signal.originalText)
  const results: LocationMatchResult[] = []

  for (const target of targets) {
    const { location, aliases, geofences } = target
    if (!location.isActive) continue

    const evidence: string[] = []
    let method: LocationMatchMethod | null = null
    let confidence = 0
    let distanceMeters: number | null = null

    // --- Coordinates -------------------------------------------------------
    if (signal.sourceLatitude != null && signal.sourceLongitude != null) {
      const anchorLat = location.latitude
      const anchorLon = location.longitude
      if (anchorLat != null && anchorLon != null) {
        distanceMeters = haversineMeters(
          signal.sourceLatitude,
          signal.sourceLongitude,
          anchorLat,
          anchorLon,
        )
        const enclosing = geofences
          .filter((fence) => {
            const d = haversineMeters(
              signal.sourceLatitude!,
              signal.sourceLongitude!,
              fence.centerLatitude,
              fence.centerLongitude,
            )
            return d <= fence.radiusMeters
          })
          .sort((a, b) => a.radiusMeters - b.radiusMeters)[0]

        if (enclosing) {
          method = signal.hasPublicGeotag ? 'explicit_geotag' : 'coordinate_proximity'
          confidence = METHOD_CONFIDENCE[method]
          evidence.push(
            signal.hasPublicGeotag
              ? `Source item carried a public geotag ${distanceMeters} m from the location, inside the "${enclosing.name}" zone.`
              : `Source-provided coordinates fall ${distanceMeters} m from the location, inside the "${enclosing.name}" zone.`,
          )
          // A vicinity-only hit is weaker than one on the property itself.
          if (enclosing.zone === 'vicinity') confidence -= 12
        }
      }
    }

    // --- Warehouse number --------------------------------------------------
    const facilityEvidence = matchesFacilityNumber(signal.originalText, location.facilityNumber)
    if (facilityEvidence) {
      if (METHOD_CONFIDENCE.store_number_mention > confidence) {
        method = 'store_number_mention'
        confidence = METHOD_CONFIDENCE.store_number_mention
      }
      evidence.push(`Text names Costco #${location.facilityNumber} — ${facilityEvidence}.`)
    }

    // --- Street address ----------------------------------------------------
    const addressEvidence = matchesAddress(signal.originalText, location)
    if (addressEvidence) {
      if (METHOD_CONFIDENCE.address_mention > confidence) {
        method = 'address_mention'
        confidence = METHOD_CONFIDENCE.address_mention
      }
      evidence.push(`Text references the location address — ${addressEvidence}.`)
    }

    // --- Aliases -----------------------------------------------------------
    const matchedAlias = aliases.find((alias) => containsToken(canonical, alias.alias))
    if (matchedAlias) {
      if (METHOD_CONFIDENCE.alias_mention > confidence) {
        method = 'alias_mention'
        confidence = METHOD_CONFIDENCE.alias_mention
      }
      evidence.push(`Text uses the known alias "${matchedAlias.alias}".`)
    }

    // --- Landmark + city ---------------------------------------------------
    const cityMentioned = containsToken(canonical, location.city)
    const brandMentioned = BRAND_TOKENS.some((brand) => canonical.includes(canonicalizeText(brand)))
    const matchedLandmark = location.nearbyLandmarks.find((landmark) =>
      canonical.includes(canonicalizeText(landmark)),
    )

    if (matchedLandmark && cityMentioned) {
      if (METHOD_CONFIDENCE.landmark_and_city > confidence) {
        method = 'landmark_and_city'
        confidence = METHOD_CONFIDENCE.landmark_and_city
      }
      evidence.push(`Text mentions the landmark "${matchedLandmark}" together with ${location.city}.`)
    }

    // --- City + brand ------------------------------------------------------
    if (cityMentioned && brandMentioned) {
      if (METHOD_CONFIDENCE.city_and_brand > confidence) {
        method = 'city_and_brand'
        confidence = METHOD_CONFIDENCE.city_and_brand
      }
      evidence.push(`Text mentions ${location.city} together with a Costco reference.`)
      if (containsToken(canonical, location.state)) {
        evidence.push(`Text also names the state ${location.state}.`)
        confidence += 4
      }
    }

    if (!method) continue

    // Corroboration across independent methods raises confidence, but the
    // result stays capped below certainty: this is an assessment, not a fact.
    if (evidence.length > 1) {
      confidence += Math.min(8, (evidence.length - 1) * 4)
    }

    results.push({
      locationId: location.id,
      method,
      confidence: Math.max(0, Math.min(97, Math.round(confidence))),
      evidence,
      distanceMeters,
    })
  }

  return results.sort((a, b) => b.confidence - a.confidence)
}

/**
 * When several locations match, ambiguity itself lowers confidence: two Costco
 * warehouses in the same metro area matching on "city + brand" is precisely the
 * case an analyst must adjudicate.
 */
export function applyAmbiguityPenalty(results: LocationMatchResult[]): LocationMatchResult[] {
  if (results.length < 2) return results
  const top = results[0]!
  const runnerUp = results[1]!
  if (top.confidence - runnerUp.confidence >= 20) return results

  return results.map((result, index) =>
    index === 0
      ? {
          ...result,
          confidence: Math.max(0, result.confidence - 15),
          evidence: [
            ...result.evidence,
            `Confidence reduced: ${results.length} monitored locations matched with similar strength.`,
          ],
        }
      : result,
  )
}
