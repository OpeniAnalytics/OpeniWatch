import { SEVERITY_RANK, type Severity } from '@/domain/enums'
import type { CandidateScore, ScoreBreakdown, ScoreFactor } from '@/domain/types'
import { SCORE_WEIGHTS, type CandidateScorer, type ScoringInput } from './types'

/**
 * `deterministic-v1` — the Phase 1 scoring service.
 *
 * Every number this produces is traceable to a named rule, and every rule
 * appends a factor explaining its contribution. There is no model, no network
 * call and no hidden state: given the same input it always returns the same
 * output, which is what makes the explanation defensible to a client.
 *
 * Seven sub-scores are calculated and retained separately, then combined with
 * fixed weights into a 0-100 priority score.
 */

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value))

/** Phrases that indicate the report describes something happening now. */
const IMMEDIACY_PATTERNS: Array<[RegExp, number, string]> = [
  [/\b(right now|happening now|in progress|as i (?:type|write|film))\b/i, 18, 'reports the event as in progress'],
  [/\bjust (?:saw|happened|witnessed|watched)\b/i, 12, 'reports a first-hand observation moments ago'],
  [/\b(?:currently|still)\b/i, 8, 'describes an ongoing condition'],
  [/\bcall(?:ing|ed)? (?:911|police|the cops)\b/i, 10, 'reports an emergency call being made'],
]

/** Phrases indicating the item is a repost or refers to a past event. */
const STALENESS_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:last (?:week|month|year)|years? ago|months? ago|back in \d{4})\b/i, 'refers to a past time period'],
  [/\b(?:throwback|repost(?:ing)?|resurfaced|old (?:video|clip|footage|photo))\b/i, 'is described as a repost or old footage'],
  [/\bthis (?:is|was) from\b/i, 'attributes the content to an earlier date'],
]

/** Site-specific detail raises specificity. */
const SPECIFICITY_PATTERNS: Array<[RegExp, number, string]> = [
  [/\b(parking lot|parking area|parking garage|lot)\b/i, 10, 'names the parking area'],
  [/\b(entrance|exit|front door|loading dock|receiving|garden center|tire center|food court|pharmacy|fuel|gas station|checkout|register|aisle)\b/i, 10, 'names a specific part of the site'],
  [/\b(?:wearing|dressed in|in a) (?:a )?[\w\s]{3,30}\b/i, 8, 'includes a description of the person involved'],
  [/\b(?:white|black|silver|red|blue|grey|gray) (?:truck|car|sedan|suv|van|pickup)\b/i, 8, 'describes a vehicle'],
  [/\b\d{1,2}:\d{2}\s?(?:am|pm)?\b/i, 6, 'includes a specific time'],
  [/\b(?:two|three|four|several|\d+)\s+(?:people|men|women|guys|individuals|subjects)\b/i, 6, 'gives a count of people involved'],
]

/** Content that is a customer-experience complaint rather than a security matter. */
const NON_OPERATIONAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:long|huge|insane) lines?\b/i, 'complains about queue length'],
  [/\bwait(?:ing|ed)? (?:forever|an hour|\d+ minutes)\b/i, 'complains about wait time'],
  [/\bout of stock\b/i, 'complains about stock availability'],
  [/\brude (?:cashier|staff|employee)\b/i, 'complains about staff conduct'],
  [/\bnever shopping here again\b/i, 'expresses dissatisfaction'],
  [/\bprices?\b/i, 'discusses pricing'],
  [/\bmembership (?:renewal|fee)\b/i, 'discusses membership terms'],
]

/** Language placing the event off the protected property. */
const OFF_PROPERTY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:near|nearby|next to|across (?:the street|from)|down the (?:street|road)|outside the)\b/i, 'places the event near, not on, the property'],
  [/\b(?:a few|several|\d+)\s+(?:blocks?|miles?|minutes?)\s+(?:from|away)\b/i, 'gives a distance from the location'],
]

function scoreThreatSeverity(input: ScoringInput, factors: ScoreFactor[]): number {
  let value = input.category.severityWeight
  factors.push({
    dimension: 'threatSeverity',
    delta: value,
    reason: `Threat category "${input.category.label}" carries a baseline severity weight of ${value}.`,
  })

  const text = input.signal.originalText

  // A weapon combined with an explicit threat is worse than either alone.
  if (/\b(gun|firearm|weapon|knife|rifle|pistol)\b/i.test(text) && /\b(threat|kill|shoot|hurt)\b/i.test(text)) {
    value += 6
    factors.push({
      dimension: 'threatSeverity',
      delta: 6,
      reason: 'Text combines a weapon reference with explicit threatening language.',
    })
  }

  if (/\b(?:injur(?:ed|y|ies)|bleeding|hurt|wounded|hospital)\b/i.test(text)) {
    value += 5
    factors.push({
      dimension: 'threatSeverity',
      delta: 5,
      reason: 'Text reports an injury.',
    })
  }

  if (/\b(?:child|kid|children|baby|elderly)\b/i.test(text)) {
    value += 3
    factors.push({
      dimension: 'threatSeverity',
      delta: 3,
      reason: 'Text indicates vulnerable people are involved.',
    })
  }

  return clamp(value)
}

function scoreLocationConfidence(input: ScoringInput, factors: ScoreFactor[]): number {
  if (!input.locationMatch) {
    factors.push({
      dimension: 'locationConfidence',
      delta: 0,
      reason: 'No monitored location could be matched from the source content.',
    })
    return 0
  }

  const value = input.locationMatch.confidence
  factors.push({
    dimension: 'locationConfidence',
    delta: value,
    reason: `Incident location matched at ${value}% confidence (${input.locationMatch.evidence.length} piece(s) of evidence).`,
  })
  return clamp(value)
}

function scoreImmediacy(input: ScoringInput, factors: ScoreFactor[]): number {
  const ageMinutes = Math.max(
    0,
    (Date.parse(input.now) - Date.parse(input.signal.publishedAt)) / 60_000,
  )

  // Decay by publication age: a report from 10 minutes ago is operationally
  // different from the same words posted three days ago.
  let value: number
  let ageReason: string
  if (ageMinutes <= 15) {
    value = 95
    ageReason = 'published within the last 15 minutes'
  } else if (ageMinutes <= 60) {
    value = 80
    ageReason = 'published within the last hour'
  } else if (ageMinutes <= 240) {
    value = 60
    ageReason = 'published within the last four hours'
  } else if (ageMinutes <= 1440) {
    value = 38
    ageReason = 'published within the last day'
  } else if (ageMinutes <= 4320) {
    value = 18
    ageReason = 'published within the last three days'
  } else {
    value = 5
    ageReason = `published ${Math.round(ageMinutes / 1440)} days ago`
  }

  factors.push({
    dimension: 'immediacy',
    delta: value,
    reason: `Source item was ${ageReason}.`,
  })

  for (const [pattern, delta, description] of IMMEDIACY_PATTERNS) {
    if (pattern.test(input.signal.originalText)) {
      value += delta
      factors.push({
        dimension: 'immediacy',
        delta,
        reason: `Text ${description}.`,
      })
    }
  }

  for (const [pattern, description] of STALENESS_PATTERNS) {
    if (pattern.test(input.signal.originalText)) {
      value -= 35
      factors.push({
        dimension: 'immediacy',
        delta: -35,
        reason: `Text ${description}, which suggests the item is not a live report.`,
      })
      break
    }
  }

  return clamp(value)
}

function scoreSourceCredibility(input: ScoringInput, factors: ScoreFactor[]): number {
  // Baseline by collection method. An analyst submission carries the analyst's
  // own accountability; an anonymous public post does not.
  const baseByMethod: Record<string, [number, string]> = {
    manual_submission: [72, 'submitted by an analyst, who is accountable for the submission'],
    webhook: [55, 'received through the authenticated ingest webhook'],
    connector_pull: [55, 'collected by a configured connector'],
    simulator: [50, 'generated by the development simulator'],
  }
  const [base, methodReason] = baseByMethod[input.signal.collectionMethod] ?? [45, 'collected by an unspecified method']
  let value = base
  factors.push({
    dimension: 'sourceCredibility',
    delta: base,
    reason: `Signal was ${methodReason}.`,
  })

  if (input.signal.sourceUrl) {
    value += 8
    factors.push({
      dimension: 'sourceCredibility',
      delta: 8,
      reason: 'A source URL is available, so the original item can be opened and verified.',
    })
  } else {
    factors.push({
      dimension: 'sourceCredibility',
      delta: 0,
      reason: 'No source URL was provided; the original item cannot be opened directly.',
    })
  }

  if (input.signal.author?.handle) {
    value += 5
    factors.push({
      dimension: 'sourceCredibility',
      delta: 5,
      reason: `Attributed to the public account ${input.signal.author.handle}.`,
    })
  }

  if (input.signal.media.length > 0) {
    value += 7
    factors.push({
      dimension: 'sourceCredibility',
      delta: 7,
      reason: `${input.signal.media.length} media item(s) accompany the report and can be reviewed.`,
    })
  }

  if (/\b(?:i heard|someone said|rumor|allegedly|supposedly|apparently)\b/i.test(input.signal.originalText)) {
    value -= 15
    factors.push({
      dimension: 'sourceCredibility',
      delta: -15,
      reason: 'Text is second-hand or hedged ("heard", "allegedly", "supposedly").',
    })
  }

  return clamp(value)
}

function scoreSpecificity(input: ScoringInput, factors: ScoreFactor[]): number {
  let value = 25
  factors.push({
    dimension: 'specificity',
    delta: 25,
    reason: 'Baseline for a report with no site-specific detail.',
  })

  for (const [pattern, delta, description] of SPECIFICITY_PATTERNS) {
    if (pattern.test(input.signal.originalText)) {
      value += delta
      factors.push({ dimension: 'specificity', delta, reason: `Text ${description}.` })
    }
  }

  // Very short reports rarely carry actionable detail.
  const words = input.signal.originalText.trim().split(/\s+/).length
  if (words < 8) {
    value -= 12
    factors.push({
      dimension: 'specificity',
      delta: -12,
      reason: `Report is only ${words} words long.`,
    })
  }

  return clamp(value)
}

function scoreCorroboration(input: ScoringInput, factors: ScoreFactor[]): number {
  const count = input.corroboratingReports
  // An uncorroborated report is neutral, not negative — most first reports of a
  // real incident arrive alone.
  const table: Array<[number, number, string]> = [
    [0, 20, 'No other independent report of this event has been collected yet.'],
    [1, 55, 'One other independent account reported the same event.'],
    [2, 75, 'Two other independent accounts reported the same event.'],
  ]
  const row = table.find(([threshold]) => count === threshold)
  const value = row ? row[1] : 90
  const reason = row
    ? row[2]
    : `${count} other independent accounts reported the same event.`

  factors.push({ dimension: 'corroboration', delta: value, reason })
  return value
}

function scoreOperationalRelevance(input: ScoringInput, factors: ScoreFactor[]): number {
  let value = 65
  factors.push({
    dimension: 'operationalRelevance',
    delta: 65,
    reason: 'Baseline relevance for a report matched to a monitored location.',
  })

  const text = input.signal.originalText

  // On-property language raises relevance.
  if (/\b(?:inside|in the (?:store|warehouse|parking lot|lot)|at the (?:store|warehouse|entrance)|on the property)\b/i.test(text)) {
    value += 22
    factors.push({
      dimension: 'operationalRelevance',
      delta: 22,
      reason: 'Text places the event on the protected property.',
    })
  }

  for (const [pattern, description] of OFF_PROPERTY_PATTERNS) {
    if (pattern.test(text)) {
      value -= 18
      factors.push({
        dimension: 'operationalRelevance',
        delta: -18,
        reason: `Text ${description}, so the operational impact is indirect.`,
      })
      break
    }
  }

  // Customer-experience complaints are collected for awareness but must not
  // compete with security matters for SOC attention.
  const complaint = NON_OPERATIONAL_PATTERNS.find(([pattern]) => pattern.test(text))
  if (complaint && SEVERITY_RANK[input.category.baselineSeverity] <= SEVERITY_RANK.moderate) {
    value = Math.min(value, 12)
    factors.push({
      dimension: 'operationalRelevance',
      delta: -1 * (65 - 12),
      reason: `Content ${complaint[1]}, which is a customer-experience matter rather than a security concern.`,
    })
  }

  if (!input.locationMatch) {
    value -= 30
    factors.push({
      dimension: 'operationalRelevance',
      delta: -30,
      reason: 'No monitored location was matched, so operational relevance cannot be established.',
    })
  }

  return clamp(value)
}

/** Maps a 0-100 priority score to a severity band using the org thresholds. */
export function bandForScore(
  score: number,
  thresholds: { criticalMin: number; highMin: number; moderateMin: number },
): Severity {
  if (score >= thresholds.criticalMin) return 'critical'
  if (score >= thresholds.highMin) return 'high'
  if (score >= thresholds.moderateMin) return 'moderate'
  return 'informational'
}

function buildExplanation(
  input: ScoringInput,
  breakdown: ScoreBreakdown,
  priorityScore: number,
  severity: Severity,
  factors: ScoreFactor[],
  adjustments: string[],
): string {
  const locationPart = input.locationMatch
    ? `matched to a monitored location at ${input.locationMatch.confidence}% confidence`
    : 'not yet matched to a monitored location'

  const topFactors = factors
    .filter((f) => f.delta >= 5)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 4)
    .map((f) => `• ${f.reason}`)

  // Reductions are always listed in full. A rule that lowered the score is
  // exactly what an analyst needs to see in order to disagree with it.
  const reductions = factors
    .filter((f) => f.delta <= -5)
    .sort((a, b) => a.delta - b.delta)
    .map((f) => `• ${f.reason}`)

  const authorPart =
    input.authorLocation.status === 'unknown'
      ? "The author's current location is unknown; no qualifying public evidence was found in the source."
      : `The author's current location is assessed as "${input.authorLocation.status}" at ${input.authorLocation.confidence}% confidence, supported by ${input.authorLocation.evidence.length} piece(s) of public evidence.`

  const sections = [
    `Scored ${priorityScore}/100 (${severity}) by deterministic-v1.`,
    `Classified as "${input.category.label}" and ${locationPart}.`,
    '',
    'Sub-scores: ' +
      [
        `threat severity ${breakdown.threatSeverity}`,
        `location confidence ${breakdown.locationConfidence}`,
        `immediacy ${breakdown.immediacy}`,
        `source credibility ${breakdown.sourceCredibility}`,
        `specificity ${breakdown.specificity}`,
        `corroboration ${breakdown.corroboration}`,
        `operational relevance ${breakdown.operationalRelevance}`,
      ].join(', ') +
      '.',
    '',
    'Largest contributors:',
    ...topFactors,
  ]

  if (reductions.length > 0) {
    sections.push('', 'Reductions applied:', ...reductions)
  }

  // Severity caps override the band the score alone would produce, so they are
  // stated separately rather than buried among the weighted factors.
  if (adjustments.length > 0) {
    sections.push('', 'Severity adjustments:', ...adjustments.map((a) => `• ${a}`))
  }

  sections.push(
    '',
    authorPart,
    '',
    'This is an automated assessment produced by fixed rules. It is not an analyst judgement and has not been verified.',
  )

  return sections.join('\n')
}

export const deterministicScorer: CandidateScorer = {
  id: 'deterministic-v1',
  displayName: 'Deterministic rules (v1)',
  description:
    'Transparent rule-based scoring with no external dependency. Every sub-score is traceable to a named rule.',
  isDeterministic: true,

  score(input: ScoringInput): CandidateScore {
    const factors: ScoreFactor[] = []

    const breakdown: ScoreBreakdown = {
      threatSeverity: scoreThreatSeverity(input, factors),
      locationConfidence: scoreLocationConfidence(input, factors),
      immediacy: scoreImmediacy(input, factors),
      sourceCredibility: scoreSourceCredibility(input, factors),
      specificity: scoreSpecificity(input, factors),
      corroboration: scoreCorroboration(input, factors),
      operationalRelevance: scoreOperationalRelevance(input, factors),
    }

    const weighted =
      breakdown.threatSeverity * SCORE_WEIGHTS.threatSeverity +
      breakdown.locationConfidence * SCORE_WEIGHTS.locationConfidence +
      breakdown.immediacy * SCORE_WEIGHTS.immediacy +
      breakdown.sourceCredibility * SCORE_WEIGHTS.sourceCredibility +
      breakdown.specificity * SCORE_WEIGHTS.specificity +
      breakdown.corroboration * SCORE_WEIGHTS.corroboration +
      breakdown.operationalRelevance * SCORE_WEIGHTS.operationalRelevance

    const priorityScore = clamp(Math.round(weighted))
    let severity = bandForScore(priorityScore, input.thresholds)
    const adjustments: string[] = []

    // A category whose baseline is informational cannot produce an urgent
    // alert on wording alone. Customer-experience content is collected for
    // awareness; it must never compete with a security matter for attention.
    if (
      input.category.baselineSeverity === 'informational' &&
      SEVERITY_RANK[severity] > SEVERITY_RANK.informational
    ) {
      const reason = `Severity held at informational: the "${input.category.label}" category is not an operational security concern.`
      factors.push({ dimension: 'operationalRelevance', delta: 0, reason })
      adjustments.push(reason)
      severity = 'informational'
    }

    // Stale content is capped: an old repost may still be worth reviewing, but
    // it is not an urgent operational matter.
    const isStale = STALENESS_PATTERNS.some(([pattern]) => pattern.test(input.signal.originalText))
    if (isStale && SEVERITY_RANK[severity] > SEVERITY_RANK.moderate) {
      const reason =
        'Severity capped at moderate: the item appears to be a repost or to describe a past event.'
      factors.push({ dimension: 'immediacy', delta: 0, reason })
      adjustments.push(reason)
      severity = 'moderate'
    }

    return {
      priorityScore,
      severity,
      breakdown,
      factors,
      explanation: buildExplanation(
        input,
        breakdown,
        priorityScore,
        severity,
        factors,
        adjustments,
      ),
      scorerId: 'deterministic-v1',
      scoredAt: input.now,
    }
  },
}
