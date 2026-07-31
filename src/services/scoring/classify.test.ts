import { describe, expect, it } from 'vitest'
import { FALLBACK_CATEGORY_KEY, classifySignal } from './classify'
import { THREAT_CATEGORY_KEYS } from '@/domain/taxonomy'

describe('classifySignal', () => {
  it('only ever returns keys that exist in the seeded taxonomy', () => {
    const samples = [
      'Active shooter at the warehouse',
      'Someone left an unattended backpack by the entrance',
      'Protesters are gathering in the parking lot',
      'The pizza at the food court was cold',
    ]
    for (const sample of samples) {
      expect(THREAT_CATEGORY_KEYS).toContain(classifySignal(sample).categoryKey)
    }
  })

  it('classifies a firearm report', () => {
    const result = classifySignal('Man just pulled a gun in the parking lot at Costco')
    expect(result.categoryKey).toBe('weapon_or_firearm')
    expect(result.matchedPhrases.join(' ')).toMatch(/gun/i)
  })

  it('prefers active violence over a plain weapon mention', () => {
    const result = classifySignal('Active shooter, shots fired, someone had a gun')
    expect(result.categoryKey).toBe('active_violence')
  })

  it('classifies a direct threat above a weapon mention', () => {
    const result = classifySignal('He said he is going to shoot up the store tomorrow')
    expect(result.categoryKey).toBe('direct_threat')
  })

  it('classifies a physical confrontation', () => {
    const result = classifySignal(
      'Huge fight broke out inside the warehouse by the registers, two guys throwing punches',
    )
    expect(result.categoryKey).toBe('assault_or_confrontation')
  })

  it('classifies protest organising', () => {
    const result = classifySignal(
      'We are organising a protest outside the Costco on Dublin St this Saturday, bring signs',
    )
    expect(result.categoryKey).toBe('protest_or_disruption')
  })

  it('classifies nearby police activity', () => {
    const result = classifySignal(
      'Police activity all over US-287 by the Costco, units everywhere and the road is blocked',
    )
    expect(result.categoryKey).toBe('nearby_police_activity')
  })

  it('classifies suspicious activity', () => {
    const result = classifySignal(
      'Someone acting strange in the Costco parking lot, looks like he is casing cars',
    )
    expect(result.categoryKey).toBe('suspicious_activity')
  })

  it('classifies a customer complaint as a customer-experience matter', () => {
    const result = classifySignal(
      'Waited 45 minutes in line, rude cashier, never shopping here again',
    )
    expect(result.categoryKey).toBe('customer_experience_disruption')
  })

  it('does not classify "shots fired" as a fire', () => {
    // "fire" appears in "fired", so the fire rule requires corroborating words.
    const result = classifySignal('Shots fired in the parking lot')
    expect(result.categoryKey).not.toBe('fire_or_evacuation')
  })

  it('does not classify an employee firing as a fire', () => {
    const result = classifySignal('My manager fired three people today at the warehouse')
    expect(result.categoryKey).not.toBe('fire_or_evacuation')
  })

  it('classifies a genuine fire when corroborating words are present', () => {
    const result = classifySignal('Smoke coming from the roof, fire alarm going off, they are evacuating')
    expect(result.categoryKey).toBe('fire_or_evacuation')
  })

  it('falls back when nothing matches', () => {
    const result = classifySignal('The parking lot was repainted over the weekend')
    expect(result.categoryKey).toBe(FALLBACK_CATEGORY_KEY)
    expect(result.matchedPhrases).toEqual([])
  })

  it('falls back to a generic category when the matched category is deactivated', () => {
    const result = classifySignal('Man with a gun in the lot', ['suspicious_activity'])
    expect(result.categoryKey).not.toBe('weapon_or_firearm')
  })

  it('records alternate classifications for analyst review', () => {
    const result = classifySignal(
      'A fight broke out and someone pulled a knife, police are responding',
    )
    expect(result.alternates.length).toBeGreaterThan(0)
    expect(result.alternates.map((a) => a.categoryKey)).not.toContain(result.categoryKey)
  })

  it('is deterministic', () => {
    const text = 'Man with a gun in the parking lot at Costco #1487'
    expect(classifySignal(text)).toEqual(classifySignal(text))
  })
})
