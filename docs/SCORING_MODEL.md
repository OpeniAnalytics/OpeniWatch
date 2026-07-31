# Scoring model

`deterministic-v1` is the Phase 1 scoring service. It has no model, no network
call and no hidden state: the same input always produces the same output, and
every number traces to a named rule.

That matters commercially as much as technically. When a client asks why an
alert was critical, the answer is a list of rules that fired — not "the model
said so".

---

## The contract

```ts
interface CandidateScorer {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly isDeterministic: boolean
  score(input: ScoringInput): CandidateScore
}
```

The pipeline never imports a scorer directly. It resolves one by the `scorer_id`
recorded in `scoring_thresholds`, and every candidate stores the id of the
scorer that produced its score.

**Adding a restricted Openi-hosted language model later** means registering a
second implementation in `src/services/scoring/index.ts` and changing that one
configuration value. Nothing outside `src/services/scoring/` moves. Historical
candidates keep their original `scorer_id`, so scores stay traceable across a
change.

---

## Sub-scores and weights

Seven sub-scores are calculated and retained separately, then combined:

| Sub-score | Weight | What it measures |
| --- | --: | --- |
| Threat severity | 0.30 | How dangerous the category is, plus signal-specific aggravators |
| Location confidence | 0.18 | How certain the incident-location match is |
| Immediacy | 0.14 | How current the report is |
| Source credibility | 0.10 | How verifiable and accountable the source is |
| Specificity | 0.10 | How much actionable detail it carries |
| Corroboration | 0.08 | How many independent accounts describe it |
| Operational relevance | 0.10 | How much it actually affects the protected location |

Weights sum to 1.0 — asserted by a unit test, so the scale can never silently
stop being 0–100.

---

## Threat severity

Starts at the category's `severity_weight` (from `threat_categories`), then:

| Modifier | Δ | Condition |
| --- | --: | --- |
| Weapon plus threatening language | +6 | Both a weapon reference and threat wording |
| Injury reported | +5 | injured, bleeding, hurt, wounded, hospital |
| Vulnerable people involved | +3 | child, kid, children, baby, elderly |

Category weights range from 98 (active violence) down to 18 (general
customer-experience disruption). Full taxonomy in `src/domain/taxonomy.ts`.

---

## Location confidence

The confidence of the best incident-location match, or 0 if none. See
[`ALERT_WORKFLOW.md`](ALERT_WORKFLOW.md#2-locate--which-protected-location) for
how it is derived.

---

## Immediacy

Publication age sets the base:

| Age | Base |
| --- | --: |
| ≤ 15 minutes | 95 |
| ≤ 1 hour | 80 |
| ≤ 4 hours | 60 |
| ≤ 1 day | 38 |
| ≤ 3 days | 18 |
| Older | 5 |

Then:

| Modifier | Δ | Trigger |
| --- | --: | --- |
| Reported as in progress | +18 | "right now", "happening now", "in progress" |
| First-hand moments ago | +12 | "just saw / happened / witnessed" |
| Ongoing condition | +8 | "currently", "still" |
| Emergency call reported | +10 | "calling 911", "called the police" |
| **Stale content** | **−35** | "last week", "years ago", "throwback", "repost", "old video", "this is from" |

---

## Source credibility

Base by collection method:

| Method | Base | Why |
| --- | --: | --- |
| Manual analyst submission | 72 | An analyst is accountable for the submission |
| Secure webhook | 55 | Authenticated but unattributed |
| Connector pull | 55 | Collected by a configured connector |
| Simulator | 50 | Generated, and labelled as such |

Then:

| Modifier | Δ | Condition |
| --- | --: | --- |
| Source URL available | +8 | The original can be opened and checked |
| Attributed to a public account | +5 | A handle is recorded |
| Media accompanies the report | +7 | Reviewable evidence |
| **Second-hand or hedged** | **−15** | "I heard", "someone said", "allegedly", "supposedly", "apparently" |

---

## Specificity

Baseline 25, then:

| Modifier | Δ | Trigger |
| --- | --: | --- |
| Names the parking area | +10 | parking lot, parking area, lot |
| Names a specific part of the site | +10 | entrance, exit, loading dock, tire center, pharmacy, checkout, aisle, fuel |
| Describes the person involved | +8 | "wearing…", "dressed in…" |
| Describes a vehicle | +8 | colour plus vehicle type |
| Gives a specific time | +6 | e.g. "2:15 pm" |
| Gives a count of people | +6 | "two men", "several individuals" |
| **Very short report** | **−12** | Fewer than 8 words |

---

## Corroboration

Counts **distinct independent authors** reporting the same event. The same
account posting repeatedly does not count.

| Independent reports | Score |
| --: | --: |
| 0 | 20 |
| 1 | 55 |
| 2 | 75 |
| 3+ | 90 |

Zero is 20, not 0: most first reports of a real incident arrive alone, and
treating that as evidence against the report would be wrong.

---

## Operational relevance

Baseline 65, then:

| Modifier | Δ | Trigger |
| --- | --: | --- |
| On the protected property | +22 | "inside", "in the store/warehouse/parking lot", "at the entrance" |
| **Off-property, distance stated** | **−18** | "two blocks away", "across the street", "next door" |
| **Off-property, vague** | **−18** | "near the Costco" — applied only when no on-property language is present |
| **Customer-experience complaint** | **→ 12** | Queue length, wait times, stock, staff conduct, pricing — for categories whose baseline is moderate or below |
| **No location matched** | **−30** | Relevance cannot be established |

The two-tier off-property rule exists because a bare "near" appears constantly
inside genuinely on-site reports — "in the parking lot near the fuel station" is
on the property. A stated distance is decisive; vague proximity is not.

---

## Final score and severity band

```
priority = Σ (sub-score × weight)        rounded, clamped to 0–100
```

The band comes from `scoring_thresholds` (defaults: critical ≥ 80, high ≥ 60,
moderate ≥ 35, otherwise informational), then two caps apply:

1. **Informational categories stay informational.** A category whose baseline
   severity is informational cannot produce an urgent alert on wording alone.
   This is what stops complaint volume competing with security matters for SOC
   attention.

2. **Stale content is capped at moderate.** An item that identifies itself as a
   repost or describes a past event may still be worth reviewing, but it is not
   an urgent operational matter.

Both caps are stated explicitly in the explanation under "Severity adjustments"
rather than being buried in the weighted factors.

---

## The explanation

Every candidate stores a human-readable explanation containing:

- the final score, band and scorer id;
- the category and location-match confidence;
- all seven sub-scores;
- the largest positive contributors;
- **every reduction applied**, in full — a rule that lowered the score is
  exactly what an analyst needs in order to disagree with it;
- any severity adjustment;
- the author current-location assessment and its evidence;
- a closing statement that this is an automated assessment, produced by fixed
  rules, and is not an analyst judgement.

The structured `factors[]` array is retained alongside the prose, so the
reasoning stays machine-readable for future analysis.

---

## Configuration

| Setting | Default | Effect |
| --- | --: | --- |
| `critical_min` | 80 | Minimum score for critical |
| `high_min` | 60 | Minimum score for high |
| `moderate_min` | 35 | Minimum score for moderate |
| `auto_suppress_below` | 10 | Candidates below this are auto-suppressed as non-operational |
| `minimum_location_confidence` | 25 | Below this, the candidate is flagged for analyst location assignment |
| `scorer_id` | `deterministic-v1` | Which scoring implementation runs |

Editable by program administrators on the Administration screen. The thresholds
must descend, enforced in both the database and the application.

---

## Tests

`src/services/scoring/deterministic.test.ts` pins the behaviour the pilot
depends on:

- weights sum to 1.0;
- identical input produces identical output;
- a firearm report at a matched location reaches critical;
- a customer complaint stays informational, even when it scores well on every
  other dimension;
- a repost is capped at moderate;
- immediacy decays with publication age;
- corroboration raises the score monotonically;
- an unmatched location lowers both location confidence and operational
  relevance;
- hedged, second-hand reports lose credibility;
- an event placed near, not at, the property loses operational relevance;
- all seven sub-scores stay within 0–100 for extreme inputs.

`classify.test.ts` covers the classifier, including the cases that used to be
wrong: "shots fired" is not a fire, "my manager fired three people" is not a
fire, and a threat reported in the third person ("he said he's going to shoot up
the store") is still a direct threat.
