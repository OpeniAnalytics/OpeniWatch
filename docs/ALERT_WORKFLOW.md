# Alert workflow

```
Detect → Locate → Classify → Validate → Alert → Acknowledge → Escalate → Resolve → Report
```

Each stage is described below with the record it produces, who may perform it,
and what is written to the audit trail.

---

## 1. Detect — a signal arrives

Three ingestion routes in Phase 1, all validated against the same schema
(`src/services/ingestion/schema.ts`):

| Route | Status | How |
| --- | --- | --- |
| Manual analyst submission | Implemented | The form on the Simulator screen. Analysts and administrators only. |
| Secure webhook | Implemented | `POST /functions/v1/ingest-signal` with a shared-secret header. |
| Development simulator | Implemented | Eight scenarios against the seeded pilot locations. |

A signal is created with its original text, source identifiers, published
timestamp, ingestion timestamp, provenance statement, content hash and raw
payload. **Signals are never edited afterwards** — there is no UPDATE policy on
the table for any application role.

**Idempotency.** `(organization, platform, source_record_id)` is unique. A
retried webhook delivery creates nothing new and still returns 200 with the
record counted as a duplicate.

---

## 2. Locate — which protected location?

`matchLocations()` compares the signal against every active location and returns
every match with its evidence, sorted by confidence.

| Method | Base confidence | Trigger |
| --- | --- | --- |
| `explicit_geotag` | 94 | Public geotag inside a geofence |
| `store_number_mention` | 88 | Warehouse number with store context or a `#` |
| `address_mention` | 84 | Street number and a distinctive street word |
| `coordinate_proximity` | 82 | Source coordinates inside a geofence, no geotag |
| `alias_mention` | 66 | A known alias, e.g. "Mt. Vernon" |
| `landmark_and_city` | 58 | A nearby landmark together with the city |
| `city_and_brand` | 46 | City plus a Costco reference |
| `analyst_assigned` | 100 | Assigned by an analyst during review |

Adjustments:

- A vicinity-only geofence hit loses 12 points.
- Corroborating methods add up to 8.
- Confidence is capped at **97**: an automated match is an assessment, never a
  certainty.
- If two locations match within 20 points of each other, the leader loses 15 and
  gains an evidence line saying why. Two warehouses in one metro area matching
  on "city + brand" is exactly what an analyst must adjudicate.

Every match carries plain-language evidence, shown verbatim to the analyst.

### Author current location — assessed separately

This is a different question with a much higher bar. It defaults to `unknown`
and only moves off it with one of:

- a public geotag,
- coordinates present in the source payload,
- an explicit contemporaneous statement by the author,
- verifiable visual evidence,
- another documented public source.

A profile city, biography, historical posts or account metadata **never**
establish current location. There is no code path that reads them for this
purpose. See [`SECURITY.md`](SECURITY.md).

---

## 3. Classify — which threat category?

`classifySignal()` applies keyword rules in priority order and returns the
category, the phrases that triggered it, a confidence, and the alternates that
also matched. A classification into a deactivated category falls back to
`other_operational_concern`.

The matched phrases are quoted back to the analyst exactly as the source wrote
them, so the classification can be checked rather than trusted.

---

## 4. Score

The deterministic scorer produces seven sub-scores and a 0–100 priority score,
with a human-readable explanation. Full rules in
[`SCORING_MODEL.md`](SCORING_MODEL.md).

The pipeline then decides:

| Condition | Outcome |
| --- | --- |
| Exact content-hash duplicate | Candidate created as `duplicate` |
| Score below `auto_suppress_below` | Candidate created as `suppressed` |
| Location confidence below `minimum_location_confidence` | Candidate created as `pending_review` with a note that analyst location assignment is required |
| Otherwise | Candidate created as `pending_review` |

A low-confidence or unmatched location still reaches the queue. The system does
not discard a possible threat because it could not place it — an analyst decides.

---

## 5. Validate — the analyst gate

**Who:** analysts and program administrators only. SOC managers, SOC operators
and viewers have read access to the queue and cannot decide anything. Enforced
in the workflow function, in navigation, and in the RLS policy on
`candidate_alerts` UPDATE and `alerts` INSERT.

On the review screen the analyst can:

- open the original source and review the original text and media;
- see the public author information;
- see the matched location and every piece of location evidence;
- review the threat category, severity and the full scoring explanation;
- see likely duplicates with their word-overlap percentage;
- edit the assessment — severity, category, location, assignment;
- add an analyst note;
- **validate**, **reject**, **mark duplicate**, **mark wrong location**, or
  **suppress as non-operational**.

Rejection, suppression, wrong-location and duplicate all require a reason, which
is written to the audit trail.

Analyst edits write only to the `analyst_*` columns. The automated assessment is
immutable — a database trigger rejects any attempt to change it — so both remain
visible and comparable.

**Validation cannot proceed without a confirmed location.** If the automated
match was weak or absent, the analyst assigns one first, which is recorded as an
`analyst_assigned` match with the analyst's own reasoning as evidence.

Validation writes two audit events: `candidate_alert.validated` (including
whether the analyst overrode the automated assessment) and `alert.created`.

---

## 6. Alert — creation and notification

Validation creates the `alerts` row, carrying forward `published_at` and
`detected_at` from the signal so detection latency stays measurable.

Dispatch then runs:

1. **Match subscriptions.** Scope narrows organization → program → location →
   assignment; a null at any level means "everything within". Empty severity or
   category lists mean "all".
2. **Resolve the channel path** from the escalation rule for that severity —
   critical is in-app → web push → SMS. The user's own channel selection filters
   it, except that **in-app is always included**, so a critical alert cannot be
   configured into silence inside the application.
3. **Attempt each channel in order.** Each provider reports its own
   availability; one without credentials produces a `skipped` record naming what
   is missing, and the development provider records a `simulated` delivery.

Every attempt is stored, whatever the outcome. The first attempt stamps
`first_notified_at`, which starts the acknowledgment clock.

---

## 7. Acknowledge

**Who:** SOC manager, SOC operator, analyst, program administrator. Viewers
cannot.

Records who acknowledged, on which channel, an optional note, and
`response_seconds` measured from the first notification. Acknowledging does not
undo an escalation.

An alert can be acknowledged once. A second attempt is refused.

---

## 8. Assign, note, escalate

**Assign** records assignee, assigner and note. It does not downgrade an alert
that is already escalated or monitoring.

**Operational notes** are distinct from analyst notes and are labelled as such.

**Escalate** requires a reason and records:

- the escalation level — SOC supervisor, program manager, client regional,
  client executive;
- `notified_parties[]`, free text by design: the SOC records people, not system
  accounts;
- `store_manager_notified` and `regional_manager_notified` as explicit flags.

> OpeniWatch never contacts a reported subject, law enforcement or emergency
> services automatically. Escalation records calls your team made.

**Unacknowledged escalation.** `findOverdueAcknowledgment()` computes which
alerts have passed their configured window (critical 5 minutes, high 15,
moderate 60, informational 24 hours by default). Phase 1 evaluates this on
demand; a scheduled worker would make it automatic.

---

## 9. Resolve, dispose, close

Enforced in both the workflow layer and a database trigger:

- **resolved** or **closed** requires the alert to have been acknowledged;
- **closed** requires a final disposition.

A disposition requires a rationale and records `assessed_by`: an analyst
recording one is an analyst assessment, anyone else in the SOC is recording an
operational decision.

Once closed, no further operational action is accepted.

---

## 10. Report

Daily and weekly summaries are computed from the records, never from stored
counters:

| Metric | Derivation |
| --- | --- |
| Signals collected | `signals` with `ingested_at` in range |
| Candidate alerts generated | `candidate_alerts` created in range |
| Alerts validated | `alerts` with `validated_at` in range |
| Alerts by severity / location / category | Grouped counts |
| False positive rate | (rejected candidates + false-positive dispositions) ÷ decided candidates |
| Average validation time | `detected_at` → `validated_at` |
| Average notification time | `validated_at` → `first_notified_at` |
| Average acknowledgment time | `first_notified_at` → `acknowledged_at` |
| Open incidents | Alerts in range still in an active status |
| Escalated incidents | Alerts in range with `escalated_at` set |

CSV export covers both the summary figures and one row per alert. PDF and
executive-report generation are prepared for but not implemented in Phase 1;
`generatePdfReport()` throws rather than producing a blank document.

---

## Audit trail

Every material action writes an append-only `audit_events` row with the acting
user, their role, the action, the entity and a detail snapshot.

| Action | Written when |
| --- | --- |
| `signal.ingested_via_webhook` | A webhook batch is accepted |
| `candidate_alert.review_started` | An analyst opens a candidate |
| `candidate_alert.assessment_edited` | An analyst edits severity, category or location |
| `candidate_alert.validated` | A candidate becomes an alert |
| `candidate_alert.rejected` / `.duplicate` / `.suppressed` | A candidate is decided |
| `alert.created` | An alert is created |
| `alert.acknowledged` | With the response time |
| `alert.assigned` | With assignee |
| `alert.escalated` | With level, parties notified and the manager flags |
| `alert.note_added` | With an excerpt |
| `alert.status_changed` | With from and to |
| `alert.disposition_set` | With disposition, rationale and who assessed it |
| `user_role.changed` | An administrator changes a role |
| `threat_category.activated` / `.deactivated` | Taxonomy change |
| `scoring_thresholds.updated`, `escalation_rule.updated` | Configuration change |
| `location.monitoring_enabled` / `_disabled` | Monitoring status change |

The alert detail view shows the alert's own events **and** its candidate's, so
validation appears in the alert's history rather than only on a screen the SOC
never opens.

---

## Roles

| Action | super_admin | program_admin | analyst | soc_manager | soc_operator | viewer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| View alerts and reporting | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit a signal manually | ✓ | ✓ | ✓ | — | — | — |
| Review and decide candidates | ✓ | ✓ | ✓ | — | — | — |
| **Validate — create an alert** | ✓ | ✓ | ✓ | — | — | — |
| Acknowledge, assign, escalate | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Resolve, close, set disposition | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Administration settings | ✓ | ✓ | — | — | — | — |
| Grant the super admin role | ✓ | — | — | — | — | — |

Enforced in `src/data/workflow.ts` for immediate feedback, and in Row Level
Security for actual protection.
