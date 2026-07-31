import { deterministicScorer } from './deterministic'
import type { CandidateScorer } from './types'

/**
 * Scorer registry.
 *
 * The pipeline never imports a scorer directly — it resolves one by the
 * `scorer_id` configured in `scoring_thresholds`. Adding a restricted
 * Openi-hosted language model later means registering a second implementation
 * here and changing that one configuration value; no other code moves.
 */

const registry = new Map<string, CandidateScorer>()

export function registerScorer(scorer: CandidateScorer): void {
  registry.set(scorer.id, scorer)
}

registerScorer(deterministicScorer)

export function getScorer(scorerId: string): CandidateScorer {
  const scorer = registry.get(scorerId)
  if (scorer) return scorer
  // Falling back keeps the pipeline running if a configuration references a
  // scorer that is not deployed, rather than dropping the candidate.
  return deterministicScorer
}

export function listScorers(): CandidateScorer[] {
  return [...registry.values()]
}

export { deterministicScorer }
export { bandForScore } from './deterministic'
export { classifySignal, FALLBACK_CATEGORY_KEY } from './classify'
export type { CandidateScorer, ScoringInput, ScoringCategory } from './types'
export { SCORE_WEIGHTS } from './types'
