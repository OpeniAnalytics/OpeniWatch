import type { AuthorLocationEvidenceKind, AuthorLocationStatus } from '@/domain/enums'
import type { AuthorLocationAssessment, AuthorLocationEvidenceRecord } from '@/domain/types'
import type { NormalizedSignal } from './normalize'

/**
 * Author current location assessment.
 *
 * OpeniWatch keeps three location facts strictly separate:
 *   1. Incident location            — where the reported event is happening.
 *   2. Public author profile location — the self-declared string on a profile.
 *   3. Author current location      — where the author actually is right now.
 *
 * This module produces only (3), and it is deliberately hard to satisfy. The
 * status defaults to `unknown` and may only move off it when supported by:
 *   - a public geotag,
 *   - coordinates in the source,
 *   - an explicit contemporaneous statement,
 *   - verifiable visual evidence, or
 *   - another documented public source.
 *
 * A profile city, biography, historical posts or account metadata NEVER
 * establish current location, and there is no code path here that reads them.
 */

/** Phrases in which an author places themselves at the scene as they write. */
const CONTEMPORANEOUS_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  {
    regex: /\b(i(?:'m| am)|we(?:'re| are))\s+(?:currently\s+)?(?:here|inside|outside|in|at|standing|sitting|parked|waiting)\b/i,
    description: 'author states they are present',
  },
  {
    regex: /\b(i(?:'m| am)|we(?:'re| are))\s+(?:still\s+)?(?:in|at)\s+the\s+(parking lot|store|warehouse|entrance|lot)\b/i,
    description: 'author places themselves at a specific part of the site',
  },
  {
    regex: /\bjust\s+(saw|watched|witnessed)\b/i,
    description: 'author reports first-hand observation as it happened',
  },
  {
    // First-person only. Phrases like "right now" or "happening now" describe
    // the EVENT, not the author, and must never be read as evidence of where
    // the author is.
    regex: /\bas i(?:'m| am)\s+(?:typing|writing|filming|recording|watching|standing)\b/i,
    description: 'author describes writing or filming from the scene',
  },
]

export const UNKNOWN_AUTHOR_LOCATION: AuthorLocationAssessment = {
  status: 'unknown',
  statedLocation: null,
  confidence: 0,
  evidence: [],
  assessedBy: 'automated',
}

/** Confidence ceiling per evidence kind. Nothing here reaches certainty. */
const EVIDENCE_CONFIDENCE: Record<AuthorLocationEvidenceKind, number> = {
  public_geotag: 80,
  coordinates_in_source: 72,
  contemporaneous_statement: 55,
  visual_evidence: 65,
  other_public_source: 60,
}

const EVIDENCE_STATUS: Record<AuthorLocationEvidenceKind, AuthorLocationStatus> = {
  public_geotag: 'geotagged',
  coordinates_in_source: 'geotagged',
  contemporaneous_statement: 'reported_by_author',
  visual_evidence: 'visually_corroborated',
  other_public_source: 'corroborated_by_source',
}

/**
 * Derives an author current-location assessment from the signal alone.
 *
 * Returns `unknown` unless qualifying evidence is present in the source item
 * itself. Analysts may later record additional evidence through the review
 * screen, which is the only other way this status changes.
 */
export function assessAuthorLocation(signal: NormalizedSignal): AuthorLocationAssessment {
  const evidence: AuthorLocationEvidenceRecord[] = []

  if (signal.hasPublicGeotag && signal.sourceLatitude != null && signal.sourceLongitude != null) {
    evidence.push({
      kind: 'public_geotag',
      detail: `The source item carries a public geotag at ${signal.sourceLatitude.toFixed(4)}, ${signal.sourceLongitude.toFixed(4)}.`,
      sourceUrl: signal.sourceUrl,
    })
  } else if (signal.sourceLatitude != null && signal.sourceLongitude != null) {
    evidence.push({
      kind: 'coordinates_in_source',
      detail: `The source payload includes coordinates at ${signal.sourceLatitude.toFixed(4)}, ${signal.sourceLongitude.toFixed(4)} without an explicit public geotag.`,
      sourceUrl: signal.sourceUrl,
    })
  }

  for (const pattern of CONTEMPORANEOUS_PATTERNS) {
    const found = signal.originalText.match(pattern.regex)
    if (found) {
      evidence.push({
        kind: 'contemporaneous_statement',
        detail: `Explicit statement in the source text — ${pattern.description}: "${found[0]}".`,
        sourceUrl: signal.sourceUrl,
      })
      break
    }
  }

  if (evidence.length === 0) {
    return { ...UNKNOWN_AUTHOR_LOCATION, evidence: [] }
  }

  // The strongest single piece of evidence sets the status; corroboration adds
  // a small, bounded increment.
  const strongest = evidence.reduce((best, item) =>
    EVIDENCE_CONFIDENCE[item.kind] > EVIDENCE_CONFIDENCE[best.kind] ? item : best,
  )
  const corroboration = Math.min(10, (evidence.length - 1) * 6)

  return {
    status: EVIDENCE_STATUS[strongest.kind],
    statedLocation: null,
    confidence: Math.min(90, EVIDENCE_CONFIDENCE[strongest.kind] + corroboration),
    evidence,
    assessedBy: 'automated',
  }
}

/**
 * Guard used before any write that sets an author location status.
 *
 * The database enforces the same rule with a CHECK constraint; this gives the
 * client a clear error before a round trip.
 */
export function assertAuthorLocationSupported(assessment: AuthorLocationAssessment): void {
  if (assessment.status !== 'unknown' && assessment.evidence.length === 0) {
    throw new Error(
      'Author current location may only leave "unknown" when supported by recorded public evidence.',
    )
  }
}
