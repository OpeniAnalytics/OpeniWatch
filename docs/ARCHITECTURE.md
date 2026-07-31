# Architecture

## Shape

OpeniWatch is a React single-page application over Supabase. Everything that
matters operationally — scoring, matching, workflow rules — lives in pure
TypeScript modules that the interface, the tests and (where applicable) the
Edge Functions all share.

```
                    ┌──────────────────────────────────────────┐
  Ingestion         │  Manual submission · Secure webhook ·     │
  routes            │  Connector pull · Development simulator   │
                    └────────────────────┬─────────────────────┘
                                         │  one shared schema
                                         ▼
                    ┌──────────────────────────────────────────┐
  Pipeline          │  normalize → locate → deduplicate →       │
  (pure)            │  classify → score → decide                │
                    └────────────────────┬─────────────────────┘
                                         ▼
                    ┌──────────────────────────────────────────┐
  Storage           │  DataProvider  ──┬── SupabaseDataProvider │
                    │                  └── LocalDataProvider    │
                    └────────────────────┬─────────────────────┘
                                         ▼
                    ┌──────────────────────────────────────────┐
  Workflow (pure)   │  review · validate · acknowledge ·        │
                    │  assign · escalate · resolve · dispose    │
                    └────────────────────┬─────────────────────┘
                                         ▼
                    ┌──────────────────────────────────────────┐
  Interface         │  Overview · Queue · Feed · Detail ·       │
                    │  Locations · Reporting · Administration   │
                    └──────────────────────────────────────────┘
```

## Layers

### Domain (`src/domain/`)

Enums, the threat taxonomy and the record types. `enums.ts` mirrors the
PostgreSQL enums declared in migration 0001; the migration is authoritative for
the database and this module is authoritative for the client.

The record-type vocabulary is enforced structurally, not just in naming: a
`Signal`, a `CandidateAlert` and an `Alert` are three different types with
different fields, so a signal cannot accidentally be treated as an alert.

### Services (`src/services/`)

Pure, dependency-light modules. None of them read from storage or the network.

- **`ingestion/`** — the shared validation schema, normalization and content
  hashing, incident-location matching, author current-location assessment,
  duplicate detection, and the pipeline that composes them.
- **`scoring/`** — the keyword classifier and the deterministic scorer, behind a
  `CandidateScorer` interface resolved through a registry.
- **`notifications/`** — the `NotificationProvider` interface, the Phase 1
  providers, and dispatch (subscription matching and channel-path resolution).
- **`connectors/`** — the `Connector` interface and the Phase 1 connectors.
- **`reporting/`** — CSV export.

Purity is what makes the operational logic testable without a database, and it
is why the same normalization runs in the browser and in an Edge Function and
produces an identical content hash.

### Data (`src/data/`)

- **`workflow.ts`** — the alert lifecycle as pure functions. Each takes the
  current record plus an actor and returns the next record and the audit events
  to write. Both providers apply the same functions, so a demo and a deployment
  behave identically.
- **`readModels.ts`** — the queue, feed, overview and report computations, as
  pure functions over a database snapshot. Shared by both providers.
- **`provider.ts`** — the `DataProvider` contract.
- **`local/`** — a browser-local provider backed by localStorage, seeded with
  the pilot data plus a week of operational history.
- **`supabase/`** — the deployed provider: Supabase Auth, PostgreSQL, Realtime.

### Interface (`src/pages/`, `src/components/`)

Screens address the data layer only through `DataProvider`. No screen knows
whether it is talking to PostgreSQL or to localStorage.

---

## Decisions worth explaining

### Two data providers

Requiring a Supabase project to see the product working would make the pilot
hard to demonstrate and the workflow hard to test. The local provider removes
that dependency: a fresh clone runs the entire Detect → Report workflow with no
credentials, and the Playwright suite exercises the real interface against a
real build.

The cost is a second implementation. That cost is contained by putting all the
rules in `workflow.ts` and all the queries in `readModels.ts` — the providers
differ only in how records are read and written, not in what the rules are.

Local demo mode is labelled with a persistent banner. It is a demonstration
affordance, not a pretend backend.

### The Supabase provider loads a snapshot

`SupabaseDataProvider.load()` selects the program's working set into memory and
serves every screen from the shared read models. This suits the pilot's scale —
one program, eight assignments, thousands of signals — and keeps the read logic
identical across both providers.

It will not suit a much larger deployment. The migration path is to move the
read paths to server-side views or RPCs; because screens only ever call
`DataProvider` methods, the interface would not change.

### The scorer is a replaceable service

`CandidateScorer` has one Phase 1 implementation, `deterministic-v1`. The
pipeline never imports it directly — it resolves a scorer by the `scorer_id`
recorded in `scoring_thresholds`. Every candidate stores the id of the scorer
that produced its score, so a score can always be traced to the logic that made
it, including after a swap.

Adding a restricted Openi-hosted language model later means registering a second
implementation and changing one configuration value. Nothing outside
`src/services/scoring/` moves. See [`SCORING_MODEL.md`](SCORING_MODEL.md).

### The automated assessment is immutable

`candidate_alerts` carries `automated_*` columns and `analyst_*` columns.
Analyst edits only ever write to the latter, and a database trigger rejects any
update that changes an `automated_*` value.

This is what lets the interface always show both, labelled, and lets reporting
measure how often the automated assessment was wrong. If analyst edits
overwrote the automated result, that measurement would be impossible and the
"automated vs analyst vs SOC" distinction the product depends on would collapse.

### Three location facts, kept apart

Incident location, public author profile location and author current location
are separate fields with separate confidence values and separate evidence.

Author current location defaults to `unknown` and can only move off it with
recorded qualifying evidence — enforced by a CHECK constraint in the database,
a guard in `authorLocation.ts` and a test suite that specifically asserts a
profile city never establishes where someone is. See
[`SECURITY.md`](SECURITY.md).

### Validation is the security boundary

Creating an alert *is* validation. It is restricted to analysts and program
administrators in three independent places: the workflow function, the
navigation, and — decisively — the RLS policy on `alerts` INSERT, which also
requires `validated_by = auth.uid()` so a validation cannot be attributed to
someone else.

### Notification providers declare their own availability

Every provider answers `availability()` with a boolean and a reason. The
dispatcher never assumes a channel works: an unconfigured provider produces a
`skipped` delivery record naming the missing configuration, and the development
provider records a `simulated` delivery for channels with no live provider.

The result is that the notification history on an alert is an honest account of
what actually happened, which matters when a client asks whether the SOC was
paged.

### Edge Function schema is a deliberate duplicate

The ingest function runs on Deno and cannot import the browser schema, and
fetching zod over the network on a security boundary at every cold start is a
poor trade. So `supabase/functions/_shared/signal-schema.ts` re-expresses the
same rules in dependency-free TypeScript.

Duplication invites drift, so `schemaParity.test.ts` fails the build if the
field lists, collection methods or media types diverge.

---

## Planned but not built in Phase 1

Stated so nothing here reads as an oversight:

- **PDF and executive report generation.** `ReportSummary` already carries every
  figure and every alert a formatted report needs. `generatePdfReport()` throws
  a clear error rather than existing as a button that quietly does nothing.
- **Scheduled escalation evaluation.** `findOverdueAcknowledgment()` computes
  which alerts have passed their unacknowledged window; Phase 1 evaluates it on
  demand rather than from a background job. A scheduled worker would add
  automatic escalation without an operator refreshing a screen.
- **Server-side notification dispatch.** OneSignal and Twilio sends must happen
  server-side because their keys are secrets. The adapters and the delivery
  records exist; the dispatcher Edge Function does not.
- **Polygon geofences.** `location_geofences.shape` is constrained to `circle`.
  Adding polygons is additive.
- **Vector similarity for duplicates.** Current detection is content hashing plus
  Jaccard token overlap — deliberately explainable to an analyst. An embedding
  comparison can replace `textSimilarity` behind the same signature.
