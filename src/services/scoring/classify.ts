import { canonicalizeText } from '@/services/ingestion/normalize'

/**
 * Deterministic threat classification.
 *
 * Keyword rules, evaluated in priority order, with the matched phrases
 * returned as evidence. An analyst can see exactly which words drove the
 * classification and correct it — the automated result is never presented as
 * an authority.
 *
 * Category keys must exist in `threat_categories`. Administrators can
 * deactivate a category; the pipeline falls back to `other_operational_concern`
 * when a classified category is inactive.
 */

export interface ClassificationRule {
  categoryKey: string
  /** Higher wins when several rules match. */
  priority: number
  patterns: RegExp[]
  /** Requires at least one of these to also match. Used to reduce false hits. */
  requires?: RegExp[]
}

export interface ClassificationResult {
  categoryKey: string
  /** Phrases from the source text that triggered the classification. */
  matchedPhrases: string[]
  /** 0-100 confidence in the classification itself. */
  confidence: number
  /** Every rule that fired, for analyst review. */
  alternates: Array<{ categoryKey: string; matchedPhrases: string[] }>
}

const RULES: ClassificationRule[] = [
  {
    categoryKey: 'active_violence',
    priority: 100,
    patterns: [
      /\bactive shooter\b/i,
      /\bshots? (?:fired|being fired)\b/i,
      /\bshooting (?:in progress|happening|right now)\b/i,
      /\bstabbing\b/i,
      /\bopened fire\b/i,
    ],
  },
  {
    categoryKey: 'bomb_or_explosive_threat',
    priority: 96,
    patterns: [/\bbomb\b/i, /\bexplosive[s]?\b/i, /\bied\b/i, /\bblow (?:it|this place) up\b/i],
  },
  {
    categoryKey: 'direct_threat',
    priority: 94,
    patterns: [
      // First person: the author is the one making the threat.
      /\b(?:i(?:'m| am) going to|im going to|gonna)\s+(?:shoot|kill|hurt|attack)\b/i,
      // Third person: someone reporting a threat they heard or saw. This is
      // the far more common case in public reporting and must not be missed.
      /\b(?:he|she|they|someone|somebody|this (?:guy|man|woman|person)|the (?:guy|man|woman|person))\b[^.!?]{0,40}?\b(?:going to|gonna|threatened to|threatening to|said (?:he|she|they)(?:'d| would)? )\s*(?:shoot|kill|hurt|attack|blow)\b/i,
      /\bshoot(?:ing)? up (?:the|this|that)\b/i,
      /\bthreat(?:ened|ening)? to (?:shoot|kill|hurt|attack|bomb)\b/i,
      /\bmaking threats\b/i,
      /\bdeath threat[s]?\b/i,
    ],
  },
  {
    categoryKey: 'weapon_or_firearm',
    priority: 90,
    patterns: [
      /\bgun\b/i,
      /\bfirearm\b/i,
      /\bhandgun\b/i,
      /\bpistol\b/i,
      /\brifle\b/i,
      /\bar-?15\b/i,
      /\barmed\b/i,
      /\bbrandish(?:ing|ed)?\b/i,
      /\bwaving a (?:gun|weapon|knife)\b/i,
      /\bknife\b/i,
      /\bmachete\b/i,
    ],
  },
  {
    categoryKey: 'fire_or_evacuation',
    priority: 80,
    patterns: [
      /\bfire\b/i,
      /\bsmoke\b/i,
      /\bevacuat(?:e|ed|ing|ion)\b/i,
      /\bfire alarm\b/i,
      /\bsprinklers?\b/i,
    ],
    // "fire" alone is ambiguous ("fired an employee", "shots fired").
    requires: [/\b(?:fire alarm|smoke|evacuat|burning|flames|fire department|sprinkler)\b/i],
  },
  {
    categoryKey: 'dangerous_crowd_condition',
    priority: 74,
    patterns: [
      /\bstampede\b/i,
      /\bcrowd (?:surge|crush|out of control)\b/i,
      /\bpeople (?:pushing|trampl)/i,
      /\bmob\b/i,
    ],
  },
  {
    categoryKey: 'assault_or_confrontation',
    priority: 72,
    patterns: [
      /\bfight(?:ing)?\b/i,
      /\bbrawl\b/i,
      /\bassault(?:ed|ing)?\b/i,
      /\bpunch(?:ed|ing)?\b/i,
      /\battack(?:ed|ing)?\b/i,
      /\bshoving match\b/i,
      /\bphysical altercation\b/i,
      /\bconfrontation\b/i,
    ],
  },
  {
    categoryKey: 'organized_retail_crime',
    priority: 68,
    patterns: [
      /\bflash mob\b/i,
      /\bgroup (?:ran out|stole|grabbed)\b/i,
      /\borganized (?:retail )?(?:theft|crime)\b/i,
      /\bsmash and grab\b/i,
      /\bcrew (?:hit|robbed)\b/i,
    ],
  },
  {
    categoryKey: 'robbery_or_theft',
    priority: 66,
    patterns: [/\brobbery\b/i, /\brobbed\b/i, /\bshoplift(?:ing|er|ers)?\b/i, /\bstole\b/i, /\btheft\b/i],
  },
  {
    categoryKey: 'medical_emergency',
    priority: 64,
    patterns: [
      /\bambulance\b/i,
      /\bparamedics?\b/i,
      /\bcpr\b/i,
      /\bcollapsed\b/i,
      /\bmedical emergency\b/i,
      /\bunconscious\b/i,
    ],
  },
  {
    categoryKey: 'protest_or_disruption',
    priority: 60,
    patterns: [
      /\bprotest(?:ers|ing|s)?\b/i,
      /\bdemonstration\b/i,
      /\bpicket(?:ing|ers)?\b/i,
      /\bwalkout\b/i,
      /\bboycott\b/i,
      /\brally\b/i,
      /\bsit-?in\b/i,
    ],
  },
  {
    categoryKey: 'nearby_police_activity',
    priority: 58,
    patterns: [
      /\bpolice (?:activity|presence|everywhere|responding|swarming)\b/i,
      /\bcops? (?:everywhere|outside|responding)\b/i,
      /\bpolice (?:cars?|units?)\b/i,
      /\bsheriff\b/i,
      /\blaw enforcement\b/i,
      /\bmanhunt\b/i,
      /\bpolice tape\b/i,
    ],
  },
  {
    categoryKey: 'severe_weather',
    priority: 54,
    patterns: [
      /\btornado\b/i,
      /\bhurricane\b/i,
      /\bflash flood(?:ing)?\b/i,
      /\bhail(?:storm)?\b/i,
      /\bsevere (?:weather|storm)\b/i,
      /\bice storm\b/i,
    ],
  },
  {
    categoryKey: 'infrastructure_disruption',
    priority: 50,
    patterns: [
      /\bpower (?:outage|is out|went out)\b/i,
      /\bblackout\b/i,
      /\bwater main\b/i,
      /\bgas leak\b/i,
      /\bno (?:power|electricity)\b/i,
    ],
  },
  {
    categoryKey: 'transportation_disruption',
    priority: 48,
    patterns: [
      /\broad clos(?:ed|ure)\b/i,
      /\bhighway (?:shut|closed)\b/i,
      /\btraffic (?:accident|crash|blocked)\b/i,
      /\bentrance blocked\b/i,
      /\bcan'?t get (?:in|out of) the (?:lot|parking)\b/i,
    ],
  },
  {
    categoryKey: 'harassment',
    priority: 44,
    patterns: [
      /\bharass(?:ing|ed|ment)\b/i,
      /\bscreaming at (?:staff|employees?|workers?)\b/i,
      /\byelling (?:at|racial)\b/i,
      /\bslurs?\b/i,
    ],
  },
  {
    categoryKey: 'suspicious_activity',
    priority: 42,
    patterns: [
      /\bsuspicious\b/i,
      /\bacting (?:strange|weird|erratic)\b/i,
      /\bcasing\b/i,
      /\bloitering\b/i,
      /\bunattended (?:bag|package|backpack)\b/i,
      /\bfollowing (?:people|shoppers|customers)\b/i,
    ],
  },
  {
    categoryKey: 'customer_or_employee_safety',
    priority: 38,
    patterns: [
      /\bunsafe\b/i,
      /\bslip(?:ped)? and fell\b/i,
      /\bhazard\b/i,
      /\bsomeone got hurt\b/i,
      /\bsafety (?:concern|issue)\b/i,
    ],
  },
  {
    categoryKey: 'customer_experience_disruption',
    priority: 20,
    patterns: [
      /\b(?:long|huge|insane) lines?\b/i,
      /\bwait(?:ing|ed)? (?:forever|an hour|\d+ minutes)\b/i,
      /\bout of stock\b/i,
      /\bworst (?:experience|service|trip)\b/i,
      /\brude (?:cashier|staff|employee)\b/i,
      /\bnever shopping here again\b/i,
      /\bcustomer service\b/i,
      /\bprices? (?:went up|are ridiculous)\b/i,
      /\bself[- ]checkout\b/i,
    ],
  },
]

export const FALLBACK_CATEGORY_KEY = 'other_operational_concern'

/**
 * Classifies a signal's text.
 *
 * @param text Original source text. Matching runs against the original rather
 *   than the canonical form so that matched phrases can be quoted back to the
 *   analyst exactly as the source wrote them.
 * @param activeCategoryKeys Categories currently enabled for the organization.
 *   A classification into a deactivated category falls back to the generic one.
 */
export function classifySignal(
  text: string,
  activeCategoryKeys: readonly string[] = [],
): ClassificationResult {
  const matches: Array<{ rule: ClassificationRule; phrases: string[] }> = []

  for (const rule of RULES) {
    const phrases: string[] = []
    for (const pattern of rule.patterns) {
      const found = text.match(pattern)
      if (found?.[0]) phrases.push(found[0])
    }
    if (phrases.length === 0) continue
    if (rule.requires && !rule.requires.some((pattern) => pattern.test(text))) continue
    matches.push({ rule, phrases })
  }

  if (matches.length === 0) {
    return {
      categoryKey: FALLBACK_CATEGORY_KEY,
      matchedPhrases: [],
      confidence: 20,
      alternates: [],
    }
  }

  matches.sort((a, b) => b.rule.priority - a.rule.priority)
  const winner = matches[0]!

  const isActive = (key: string) =>
    activeCategoryKeys.length === 0 || activeCategoryKeys.includes(key)

  const selected = matches.find((m) => isActive(m.rule.categoryKey)) ?? winner
  const categoryKey = isActive(selected.rule.categoryKey)
    ? selected.rule.categoryKey
    : FALLBACK_CATEGORY_KEY

  // More distinct trigger phrases means a more confident classification, but
  // keyword matching never reaches certainty.
  const confidence = Math.min(88, 45 + selected.phrases.length * 12 + selected.rule.priority / 10)

  return {
    categoryKey,
    matchedPhrases: [...new Set(selected.phrases)],
    confidence: Math.round(confidence),
    alternates: matches
      .filter((m) => m.rule.categoryKey !== categoryKey)
      .slice(0, 3)
      .map((m) => ({ categoryKey: m.rule.categoryKey, matchedPhrases: [...new Set(m.phrases)] })),
  }
}
