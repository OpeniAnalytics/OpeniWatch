import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from './types'
import { bandForScore, deterministicScorer } from './deterministic'
import {
  TEST_NOW,
  TEST_THRESHOLDS,
  buildMatch,
  buildScoringInput,
  buildSignal,
  categoryFor,
} from './testFixtures'

/**
 * These tests pin the operational behaviour the pilot depends on: a firearm
 * report at a monitored warehouse must reach critical, and a customer
 * complaint must never do so.
 */

describe('score weights', () => {
  it('describe a complete 0-100 scale', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 10)
  })
})

describe('bandForScore', () => {
  it('maps scores onto the configured severity bands', () => {
    expect(bandForScore(95, TEST_THRESHOLDS)).toBe('critical')
    expect(bandForScore(80, TEST_THRESHOLDS)).toBe('critical')
    expect(bandForScore(79, TEST_THRESHOLDS)).toBe('high')
    expect(bandForScore(60, TEST_THRESHOLDS)).toBe('high')
    expect(bandForScore(59, TEST_THRESHOLDS)).toBe('moderate')
    expect(bandForScore(35, TEST_THRESHOLDS)).toBe('moderate')
    expect(bandForScore(34, TEST_THRESHOLDS)).toBe('informational')
    expect(bandForScore(0, TEST_THRESHOLDS)).toBe('informational')
  })

  it('respects thresholds that an administrator has changed', () => {
    const strict = { criticalMin: 90, highMin: 75, moderateMin: 50 }
    expect(bandForScore(85, strict)).toBe('high')
    expect(bandForScore(60, strict)).toBe('moderate')
  })
})

describe('deterministicScorer', () => {
  it('is deterministic: identical input produces identical output', () => {
    const input = buildScoringInput({
      signal: buildSignal({ text: 'Man with a gun in the parking lot at Costco #1487 right now' }),
      category: categoryFor('weapon_or_firearm'),
      locationMatch: buildMatch(90),
    })

    const first = deterministicScorer.score(input)
    const second = deterministicScorer.score(input)

    expect(first.priorityScore).toBe(second.priorityScore)
    expect(first.explanation).toBe(second.explanation)
    expect(first.breakdown).toEqual(second.breakdown)
  })

  it('scores a firearm report at a matched location as critical', () => {
    const result = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({
          text: 'Guy just pulled out a gun in the parking lot at Costco #1487 in Stafford. He is wearing a red jacket and standing by a white truck. Police are being called right now.',
          publishedAt: '2026-03-14T18:39:00.000Z',
        }),
        category: categoryFor('weapon_or_firearm'),
        locationMatch: buildMatch(94),
      }),
    )

    expect(result.severity).toBe('critical')
    expect(result.priorityScore).toBeGreaterThanOrEqual(80)
    expect(result.scorerId).toBe('deterministic-v1')
  })

  it('does not raise an urgent alert for a customer-experience complaint', () => {
    const result = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({
          text: 'Waited 45 minutes in line at the Plano Costco today, only two registers open and the self-checkout was closed. Worst experience, prices keep going up too.',
        }),
        category: categoryFor('customer_experience_disruption'),
        locationMatch: buildMatch(66),
      }),
    )

    expect(result.severity).toBe('informational')
    expect(result.breakdown.operationalRelevance).toBeLessThanOrEqual(12)
    expect(result.explanation).toContain('informational')
  })

  it('holds informational categories at informational even with a high score', () => {
    // A complaint that scores well on every other dimension still must not
    // become an operational alert.
    const result = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({
          text: 'Long lines at the entrance right now at Costco #696, several people waiting by the registers at 2:15 pm. I am in the store currently.',
          publishedAt: TEST_NOW,
          mediaCount: 2,
        }),
        category: categoryFor('customer_experience_disruption'),
        locationMatch: buildMatch(95),
        corroboratingReports: 4,
      }),
    )

    expect(result.severity).toBe('informational')
  })

  it('caps a reposted or historical item at moderate', () => {
    const result = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({
          text: 'Reposting this old video of a fight that broke out at Costco #353 in Memphis. This is from last year but people should see it.',
          publishedAt: TEST_NOW,
        }),
        category: categoryFor('assault_or_confrontation'),
        locationMatch: buildMatch(88),
      }),
    )

    expect(result.severity).toBe('moderate')
    expect(result.explanation).toMatch(/repost|past event/i)
  })

  it('decays immediacy with publication age', () => {
    const base = {
      category: categoryFor('assault_or_confrontation'),
      locationMatch: buildMatch(85),
    }
    const fresh = deterministicScorer.score(
      buildScoringInput({
        ...base,
        signal: buildSignal({
          text: 'A fight broke out inside the warehouse near the entrance.',
          publishedAt: '2026-03-14T18:35:00.000Z',
        }),
      }),
    )
    const old = deterministicScorer.score(
      buildScoringInput({
        ...base,
        signal: buildSignal({
          text: 'A fight broke out inside the warehouse near the entrance.',
          publishedAt: '2026-03-12T18:35:00.000Z',
        }),
      }),
    )

    expect(fresh.breakdown.immediacy).toBeGreaterThan(old.breakdown.immediacy)
    expect(fresh.priorityScore).toBeGreaterThan(old.priorityScore)
  })

  it('raises the score as independent corroboration accumulates', () => {
    const signal = buildSignal({
      text: 'Someone is threatening people with a knife inside the store.',
    })
    const scores = [0, 1, 2, 5].map(
      (corroboratingReports) =>
        deterministicScorer.score(
          buildScoringInput({
            signal,
            category: categoryFor('weapon_or_firearm'),
            locationMatch: buildMatch(85),
            corroboratingReports,
          }),
        ).priorityScore,
    )

    expect(scores[0]!).toBeLessThan(scores[1]!)
    expect(scores[1]!).toBeLessThan(scores[2]!)
    expect(scores[2]!).toBeLessThan(scores[3]!)
  })

  it('penalises an unmatched location', () => {
    const text = 'Person with a gun in the parking lot.'
    const matched = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({ text }),
        category: categoryFor('weapon_or_firearm'),
        locationMatch: buildMatch(90),
      }),
    )
    const unmatched = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({ text }),
        category: categoryFor('weapon_or_firearm'),
        locationMatch: null,
      }),
    )

    expect(unmatched.breakdown.locationConfidence).toBe(0)
    expect(unmatched.breakdown.operationalRelevance).toBeLessThan(
      matched.breakdown.operationalRelevance,
    )
    expect(unmatched.priorityScore).toBeLessThan(matched.priorityScore)
  })

  it('reduces credibility for hedged, second-hand reports', () => {
    const firstHand = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({ text: 'I just saw a man with a gun in the parking lot at Costco.' }),
        category: categoryFor('weapon_or_firearm'),
      }),
    )
    const secondHand = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({
          text: 'I heard someone said there was allegedly a man with a gun in the parking lot at Costco.',
        }),
        category: categoryFor('weapon_or_firearm'),
      }),
    )

    expect(secondHand.breakdown.sourceCredibility).toBeLessThan(
      firstHand.breakdown.sourceCredibility,
    )
  })

  it('lowers operational relevance for an event placed near, not at, the property', () => {
    const onSite = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({ text: 'Police activity inside the store at Costco #1381.' }),
        category: categoryFor('nearby_police_activity'),
      }),
    )
    const nearby = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({
          text: 'Police activity two blocks away from the Costco #1381 on US-287.',
        }),
        category: categoryFor('nearby_police_activity'),
      }),
    )

    expect(nearby.breakdown.operationalRelevance).toBeLessThan(
      onSite.breakdown.operationalRelevance,
    )
  })

  it('retains all seven sub-scores and a readable explanation', () => {
    const result = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({ text: 'Man with a gun outside the entrance.' }),
        category: categoryFor('weapon_or_firearm'),
      }),
    )

    expect(Object.keys(result.breakdown).sort()).toEqual([
      'corroboration',
      'immediacy',
      'locationConfidence',
      'operationalRelevance',
      'sourceCredibility',
      'specificity',
      'threatSeverity',
    ])
    for (const value of Object.values(result.breakdown)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
    expect(result.factors.length).toBeGreaterThan(3)
    expect(result.explanation).toContain('Sub-scores:')
    // The explanation must state plainly that this is not an analyst judgement.
    expect(result.explanation).toMatch(/not an analyst judgement/i)
  })

  it('keeps the priority score within 0-100 for extreme inputs', () => {
    const extreme = deterministicScorer.score(
      buildScoringInput({
        signal: buildSignal({
          text: 'Active shooter, shots fired, people injured and bleeding, children inside, happening right now in the parking lot at the entrance. I am currently in the store at 2:15 pm and called 911.',
          mediaCount: 5,
        }),
        category: categoryFor('active_violence'),
        locationMatch: buildMatch(97),
        corroboratingReports: 12,
      }),
    )
    expect(extreme.priorityScore).toBeLessThanOrEqual(100)
    expect(extreme.priorityScore).toBeGreaterThanOrEqual(80)
    expect(extreme.severity).toBe('critical')
  })
})
