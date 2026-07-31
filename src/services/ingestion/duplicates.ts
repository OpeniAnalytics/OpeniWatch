import type { Signal } from '@/domain/types'
import { textSimilarity } from './normalize'

/**
 * Duplicate detection.
 *
 * Two levels, both explainable to an analyst:
 *   1. Exact — identical content hash on the same platform.
 *   2. Near  — high token overlap within a recency window.
 *
 * Near-duplicates are surfaced, not auto-merged. Several accounts reporting the
 * same event is corroboration and is operationally meaningful; the analyst
 * decides whether that means "duplicate" or "corroborated".
 */

export interface DuplicateFinding {
  duplicateOfSignalId: string
  similarity: number
  method: 'content_hash' | 'near_duplicate_text' | 'shared_media'
  notes: string
}

export interface DuplicateOptions {
  /** Similarity at or above which two texts are treated as near-duplicates. */
  nearDuplicateThreshold?: number
  /** Only compare against signals published within this window. */
  windowHours?: number
}

const DEFAULTS: Required<DuplicateOptions> = {
  nearDuplicateThreshold: 72,
  windowHours: 48,
}

export function findDuplicates(
  candidate: { contentHash: string; originalText: string; publishedAt: string; sourcePlatform: string },
  existing: readonly Signal[],
  options: DuplicateOptions = {},
): DuplicateFinding[] {
  const { nearDuplicateThreshold, windowHours } = { ...DEFAULTS, ...options }
  const candidateTime = Date.parse(candidate.publishedAt)
  const windowMs = windowHours * 3600 * 1000
  const findings: DuplicateFinding[] = []

  for (const other of existing) {
    const otherTime = Date.parse(other.publishedAt)
    if (Number.isFinite(candidateTime) && Number.isFinite(otherTime)) {
      if (Math.abs(candidateTime - otherTime) > windowMs) continue
    }

    if (other.contentHash === candidate.contentHash) {
      findings.push({
        duplicateOfSignalId: other.id,
        similarity: 100,
        method: 'content_hash',
        notes: `Identical normalized content already collected from ${other.sourcePlatform}.`,
      })
      continue
    }

    const similarity = textSimilarity(candidate.originalText, other.originalText)
    if (similarity >= nearDuplicateThreshold) {
      findings.push({
        duplicateOfSignalId: other.id,
        similarity,
        method: 'near_duplicate_text',
        notes:
          other.sourcePlatform === candidate.sourcePlatform
            ? `${similarity}% word overlap with an earlier report on the same platform.`
            : `${similarity}% word overlap with a report collected from ${other.sourcePlatform}. Independent platforms reporting the same event may be corroboration rather than duplication.`,
      })
    }
  }

  return findings.sort((a, b) => b.similarity - a.similarity)
}

/**
 * Counts independent corroborating reports.
 *
 * Distinct authors describing the same event raise confidence; the same author
 * posting repeatedly does not. Only reports from different authors count.
 */
export function countCorroboration(
  findings: readonly DuplicateFinding[],
  signalsById: ReadonlyMap<string, Signal>,
  candidateAuthorId: string | null,
): number {
  const authors = new Set<string>()
  for (const finding of findings) {
    const signal = signalsById.get(finding.duplicateOfSignalId)
    if (!signal) continue
    const authorKey = signal.authorId ?? `anonymous:${signal.id}`
    if (candidateAuthorId && signal.authorId === candidateAuthorId) continue
    authors.add(authorKey)
  }
  return authors.size
}
