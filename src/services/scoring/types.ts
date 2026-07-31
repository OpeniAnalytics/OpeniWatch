import type { Severity } from '@/domain/enums'
import type { CandidateScore, ScoringThreshold } from '@/domain/types'
import type { NormalizedSignal } from '@/services/ingestion/normalize'
import type { AuthorLocationAssessment } from '@/domain/types'
import type { LocationMatchResult } from '@/services/ingestion/locationMatching'

/**
 * The scoring contract.
 *
 * Phase 1 ships `deterministic-v1`, a transparent rule-based scorer with no
 * external dependency. A restricted Openi-hosted language model can be added
 * later as a second implementation of this same interface — the pipeline,
 * storage and interface all address the scorer through `CandidateScorer`, so
 * nothing outside `src/services/scoring/` changes.
 */
export interface CandidateScorer {
  /** Stored on every candidate so a score can always be traced to its scorer. */
  readonly id: string
  readonly displayName: string
  readonly description: string
  /** True when the scorer runs without any external service. */
  readonly isDeterministic: boolean
  score(input: ScoringInput): CandidateScore
}

export interface ScoringCategory {
  key: string
  label: string
  baselineSeverity: Severity
  severityWeight: number
}

export interface ScoringInput {
  signal: NormalizedSignal
  /** Category chosen by the classifier, or overridden by an analyst. */
  category: ScoringCategory
  /** Best incident-location match, or null when none could be established. */
  locationMatch: LocationMatchResult | null
  authorLocation: AuthorLocationAssessment
  /** Number of independent reports describing the same event. */
  corroboratingReports: number
  thresholds: ScoringThreshold
  /** Evaluation time. Injected so scoring is deterministic under test. */
  now: string
}

/** Relative contribution of each dimension to the final priority score. */
export const SCORE_WEIGHTS = {
  threatSeverity: 0.3,
  locationConfidence: 0.18,
  immediacy: 0.14,
  sourceCredibility: 0.1,
  specificity: 0.1,
  corroboration: 0.08,
  operationalRelevance: 0.1,
} as const

/** Guard: the weights must always describe a full 0-100 scale. */
export const SCORE_WEIGHT_TOTAL = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)
