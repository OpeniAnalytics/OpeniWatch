import type { Severity } from './enums'

/**
 * Initial threat taxonomy.
 *
 * Seeded into `threat_categories`. Administrators may add categories or
 * deactivate them at runtime, so nothing in the application may treat this
 * list as closed — always read categories from the data provider. This module
 * exists to seed the database and to give the deterministic scoring service a
 * default weighting for each category.
 */
export interface ThreatCategorySeed {
  /** Stable machine key. Never renamed once shipped. */
  key: string
  label: string
  /** Grouping used for reporting rollups. */
  group: 'violence' | 'crime' | 'disruption' | 'safety' | 'environment' | 'other'
  /**
   * Baseline severity the scoring service starts from before signal-specific
   * modifiers are applied. Analysts may override the result.
   */
  baselineSeverity: Severity
  /** 0-100 contribution to the threat severity sub-score. */
  severityWeight: number
  /** Short operational description shown in administration. */
  description: string
}

export const THREAT_CATEGORY_SEEDS: readonly ThreatCategorySeed[] = [
  {
    key: 'direct_threat',
    label: 'Direct threat',
    group: 'violence',
    baselineSeverity: 'critical',
    severityWeight: 92,
    description: 'An explicit stated intent to harm a location, its staff, or its customers.',
  },
  {
    key: 'weapon_or_firearm',
    label: 'Weapon or firearm',
    group: 'violence',
    baselineSeverity: 'critical',
    severityWeight: 90,
    description: 'A weapon or firearm is reported as present, displayed, or brandished.',
  },
  {
    key: 'active_violence',
    label: 'Active violence',
    group: 'violence',
    baselineSeverity: 'critical',
    severityWeight: 98,
    description: 'Violence reported as in progress.',
  },
  {
    key: 'assault_or_confrontation',
    label: 'Assault or confrontation',
    group: 'violence',
    baselineSeverity: 'high',
    severityWeight: 70,
    description: 'Physical altercation or aggressive confrontation involving staff or customers.',
  },
  {
    key: 'bomb_or_explosive_threat',
    label: 'Bomb or explosive threat',
    group: 'violence',
    baselineSeverity: 'critical',
    severityWeight: 95,
    description: 'A threat referencing an explosive device.',
  },
  {
    key: 'fire_or_evacuation',
    label: 'Fire or evacuation',
    group: 'environment',
    baselineSeverity: 'high',
    severityWeight: 78,
    description: 'Fire, smoke, alarm activation, or an evacuation in progress.',
  },
  {
    key: 'suspicious_activity',
    label: 'Suspicious activity',
    group: 'safety',
    baselineSeverity: 'moderate',
    severityWeight: 48,
    description: 'Behavior reported as suspicious without a confirmed threat.',
  },
  {
    key: 'organized_retail_crime',
    label: 'Organized retail crime',
    group: 'crime',
    baselineSeverity: 'high',
    severityWeight: 66,
    description: 'Coordinated theft activity, flash-mob theft, or fencing operations.',
  },
  {
    key: 'robbery_or_theft',
    label: 'Robbery or theft',
    group: 'crime',
    baselineSeverity: 'high',
    severityWeight: 64,
    description: 'Robbery, shoplifting, or property theft affecting the location.',
  },
  {
    key: 'protest_or_disruption',
    label: 'Protest or organized disruption',
    group: 'disruption',
    baselineSeverity: 'moderate',
    severityWeight: 52,
    description: 'Planned or ongoing protest, walkout, or organized disruption.',
  },
  {
    key: 'dangerous_crowd_condition',
    label: 'Dangerous crowd condition',
    group: 'safety',
    baselineSeverity: 'high',
    severityWeight: 68,
    description: 'Crowd density, surge, or behavior that creates a safety risk.',
  },
  {
    key: 'harassment',
    label: 'Harassment',
    group: 'safety',
    baselineSeverity: 'moderate',
    severityWeight: 44,
    description: 'Harassment of staff or customers, including targeted verbal abuse.',
  },
  {
    key: 'customer_or_employee_safety',
    label: 'Customer or employee safety',
    group: 'safety',
    baselineSeverity: 'moderate',
    severityWeight: 46,
    description: 'A general safety concern affecting customers or employees.',
  },
  {
    key: 'medical_emergency',
    label: 'Medical emergency',
    group: 'safety',
    baselineSeverity: 'high',
    severityWeight: 62,
    description: 'A medical emergency reported at or immediately outside the location.',
  },
  {
    key: 'nearby_police_activity',
    label: 'Nearby police activity',
    group: 'disruption',
    baselineSeverity: 'moderate',
    severityWeight: 50,
    description: 'Law-enforcement activity near the location that may affect access.',
  },
  {
    key: 'nearby_external_incident',
    label: 'Nearby external incident',
    group: 'disruption',
    baselineSeverity: 'moderate',
    severityWeight: 45,
    description: 'An incident in the vicinity that is not on the protected property.',
  },
  {
    key: 'severe_weather',
    label: 'Severe weather',
    group: 'environment',
    baselineSeverity: 'moderate',
    severityWeight: 47,
    description: 'Severe weather affecting the location or its access routes.',
  },
  {
    key: 'infrastructure_disruption',
    label: 'Infrastructure or utility disruption',
    group: 'environment',
    baselineSeverity: 'moderate',
    severityWeight: 42,
    description: 'Power, water, network, or other utility disruption.',
  },
  {
    key: 'transportation_disruption',
    label: 'Transportation or access disruption',
    group: 'disruption',
    baselineSeverity: 'moderate',
    severityWeight: 40,
    description: 'Road closure, traffic incident, or transit disruption affecting access.',
  },
  {
    key: 'customer_experience_disruption',
    label: 'General customer-experience disruption',
    group: 'other',
    baselineSeverity: 'informational',
    severityWeight: 18,
    description:
      'Service complaints, wait times, product availability. Reported for awareness, not for urgent dispatch.',
  },
  {
    key: 'other_operational_concern',
    label: 'Other operational concern',
    group: 'other',
    baselineSeverity: 'informational',
    severityWeight: 25,
    description: 'An operational concern that does not fit an existing category.',
  },
]

export const THREAT_CATEGORY_KEYS = THREAT_CATEGORY_SEEDS.map((c) => c.key)

export function findCategorySeed(key: string): ThreatCategorySeed | undefined {
  return THREAT_CATEGORY_SEEDS.find((c) => c.key === key)
}
