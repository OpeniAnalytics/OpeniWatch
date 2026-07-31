# Security and privacy

## Tenant isolation

Row Level Security is enabled **and forced** on every table in `public`, from
migration `0007_row_level_security.sql`. Forcing it means even a table owner is
subject to policy.

A user reaches data only through their memberships:

- `organization_memberships` grants organization visibility;
- `program_memberships` grants program visibility, as does an organization-level
  `program_admin` or `soc_manager` role;
- locations, signals, candidates and alerts are visible only through
  `is_program_member(program_id)`;
- child tables (media, matches, acknowledgments, escalations…) inherit
  visibility from their parent row.

Authorization helpers are `SECURITY DEFINER` and read-only. They exist so a
policy on one table can ask "what roles does this user hold?" without recursing
into the policy on `user_roles`.

---

## Roles and privilege escalation

Roles live in `user_roles`, **separate from `profiles`**, so a privilege check
never depends on a row the user can write.

The `user_roles` policy allows writes only to super administrators and program
administrators, and its `WITH CHECK` clause additionally requires that only a
super administrator may mint another super administrator. A user cannot grant
themselves a role, because the check never consults the row being written for
the acting user's authority.

The same rule is mirrored in `canGrantRole()` for immediate feedback, and both
are covered by tests.

---

## Protection against unauthorized alert validation

Creating an alert *is* validation, so it is gated in three independent places:

1. `validateCandidate()` throws for any role that is not analyst, program
   administrator or super administrator.
2. The analyst queue is hidden from roles that cannot use it — including the
   overview tile that links to it.
3. **The RLS policy on `alerts` INSERT** requires `can_validate(organization_id)`
   *and* `validated_by = auth.uid()`, so an analyst cannot attribute a
   validation to someone else, and a SOC role cannot validate at all.

The `candidate_alerts` UPDATE policy is likewise restricted to `can_validate`,
so SOC operators, SOC managers and viewers have read-only access to the queue.

---

## Immutability

| What | How it is protected |
| --- | --- |
| Signals | No UPDATE policy exists for any application role. Original evidence cannot be edited. |
| The automated assessment | `candidate_alerts_protect_automated` trigger rejects any change to an `automated_*` column. |
| Alert provenance | `alerts_guard_lifecycle` rejects changes to candidate, signal, validator or validation time. |
| Audit events | `audit_events_immutable` trigger raises on UPDATE or DELETE, and no UPDATE or DELETE policy exists. |

---

## Lifecycle integrity

Enforced by database trigger, not just by the client:

- an alert cannot be resolved or closed without having been acknowledged;
- an alert cannot be closed without a final disposition.

These hold regardless of which client wrote the row, including the service role.

---

## Secrets

- The **service-role key** is used only by Supabase Edge Functions. It is never
  imported into `src/` and never appears in a browser bundle.
- Only `VITE_`-prefixed variables reach the client, and `src/lib/env.ts` is the
  single place that reads them. `src/vite-env.d.ts` types exactly which
  variables are browser-visible, so adding a secret to that list would be a
  visible, reviewable change.
- Provider credentials (OneSignal REST key, Twilio auth token) are read
  server-side only. The OneSignal browser adapter queues a delivery as `pending`
  rather than attempting a call it cannot make safely.
- `integrations.config` is documented and used for non-secret configuration
  only.
- Error responses from the ingest function never name which configuration value
  is missing; detail goes to the server log.
- `notification_deliveries.detail` carries operator-facing notes and never
  credentials or tokens.

---

## Ingestion

| Control | Implementation |
| --- | --- |
| Authentication | Shared secret in `x-openiwatch-secret`, compared in constant time after hashing so length cannot be probed by timing. |
| Rate limiting | `openiwatch.check_ingest_rate()`, fixed-window counters in the database — survives cold starts, applies across instances. Checked **before** parsing the body. |
| Payload validation | Every field validated against the shared schema before any write. |
| Batch cap | 50 signals per request; 512 KB body cap. |
| Idempotency | `(organization, platform, source_record_id)` unique. A retry writes nothing and returns 200. |
| Tenant safety | The target program comes from configuration, never from the payload. |
| Audit | One `audit_events` row per batch. |

---

## Input validation and output encoding

- One validation schema, shared by all ingestion routes
  (`src/services/ingestion/schema.ts`), mirrored for Deno in
  `supabase/functions/_shared/signal-schema.ts`. A parity test fails the build
  if they drift.
- **External URLs**: only `http:` and `https:` are accepted, at both the schema
  boundary and again at render time via `isSafeExternalUrl()`. A source item is
  attacker-controlled text, so a `javascript:` or `data:` URL must never reach
  an anchor's `href`.
- External links open with `rel="noopener noreferrer nofollow"`.
- Source text is rendered as React text nodes. `dangerouslySetInnerHTML` is not
  used anywhere in the codebase.
- **CSV injection**: a cell beginning `=`, `+`, `-`, `@`, tab or carriage return
  is prefixed with an apostrophe, so source text cannot become a formula when a
  client opens an export in Excel or Sheets.
- Media is referenced, never re-hosted or proxied. A media URL that fails the
  http(s) check renders as withheld text rather than as a link.
- The Netlify configuration sets a Content-Security-Policy restricting scripts
  to same-origin, plus `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff`, a referrer policy and a permissions policy denying geolocation,
  microphone, camera, payment and USB.

### How this is verified

`e2e/security.spec.ts` submits hostile content through the real manual
submission path — not through a fixture — and follows it across the analyst
queue, the alert detail view and an operational note. The payloads are

```
<script>window.__openiwatch_xss = true</script>
<img src=x onerror="window.__openiwatch_xss = true">
```

placed in the signal text, the public author handle and a note body. At each
stop the test asserts three things: `window.__openiwatch_xss` is never set, no
`script` element containing the marker exists in the document, and no
`img[onerror]` exists. It also asserts external source links carry
`noopener noreferrer nofollow` with `target="_blank"`.

**A finding worth stating plainly:** `<input type="url">` does **not** reject
`javascript:alert(1)`. The value has a scheme, so the browser considers it a
valid URL and the field is not marked invalid. The shared validation schema is
the real gate. The test was rewritten to assert the schema's rejection surfaces
an error and that no pipeline result is produced, rather than assuming the
input type protects anything. Anyone hardening a new form here should assume the
same: the input type is a keyboard hint, not a control.

Executed on this branch: 7 tests, all passing, against a production build.

---

## Privacy and intelligence standards

OpeniWatch processes publicly available information. These rules are structural,
not advisory.

### Three location facts, never merged

| Fact | Where it lives | Default |
| --- | --- | --- |
| **Incident location** — where the event is | `incident_location_*` | Unmatched |
| **Public author profile location** — a self-declared profile string | `signal_authors.profile_location_text` | Not recorded |
| **Author current location** — where the author actually is | `author_location_*` | **`unknown`** |

Author current location may only leave `unknown` when supported by:

- a public geotag,
- coordinates present in the source payload,
- an explicit contemporaneous statement by the author,
- verifiable visual evidence,
- another documented public source.

**A profile city, biography, historical posts or account metadata never
establish current location.** There is no code path in `authorLocation.ts` that
reads them for this purpose.

Enforced in three places: a CHECK constraint on both `candidate_alerts` and
`alerts`, a guard function, and a test suite that asserts specifically that a
profile location and a location named in the text both leave the status
`unknown`.

This rule caught a real defect during development: the phrase "right now" was
being read as evidence the author was present. It describes the event, not the
author, and no longer qualifies.

### Fact, inference and judgement stay separate

`assessment_source` — `automated`, `analyst`, `soc` — is recorded on every
location match, every alert assessment and every disposition, and is displayed
as a badge everywhere it appears. The automated assessment is immutable, so the
interface can always show both it and the analyst's alongside each other.

Every inferred assessment carries a confidence value and its supporting
evidence in plain language. No confidence reaches 100 except an explicit analyst
assignment.

The automated explanation ends by stating that it is produced by fixed rules and
is not an analyst judgement.

### Provenance and timestamps

Every signal preserves its source platform, source record id, source URL,
original text, published timestamp, collection timestamp, collection method, a
provenance statement and the raw payload. Published timestamps are never
adjusted. Collection time is recorded separately from publication time.

### Identity

- Author records hold only what the source published. Nothing is enriched or
  looked up.
- OpeniWatch does not claim an account owner has been conclusively identified.
- No automatic identification of private individuals beyond what the source
  itself presents.

### Retention

`programs.signal_retention_days` carries the program's policy and
`signals.is_retention_restricted` marks individual records held under a
restricted policy. A `program_admin` may delete signals; no other role can.

> A scheduled purge job is **not** implemented in Phase 1. The fields and the
> permission exist; the automation does not.

### Explicit exclusions

Not built, by design:

- facial recognition;
- private-data collection;
- IP tracking;
- hidden-location tracking;
- automatic contact with a reported subject;
- automatic contact with law enforcement or emergency services;
- unsupported scraping — connectors read only sources an operator explicitly
  configures.

---

## Automated coverage

`src/data/workflow.test.ts` and `src/data/local/provider.test.ts` cover the
role and workflow scenarios end to end:

- validation is restricted to analysts and administrators; a SOC manager and a
  viewer are both refused;
- a viewer cannot acknowledge;
- a SOC manager cannot change scoring thresholds;
- an analyst cannot change user roles;
- a program administrator cannot mint a super administrator;
- an alert cannot be resolved unacknowledged or closed without a disposition;
- analyst edits never overwrite the automated assessment;
- audit events record the acting user and role for every action.

`e2e/workflow.spec.ts` verifies the same boundaries through the real interface:
the analyst queue is absent for a SOC manager, a viewer gets no SOC actions, and
administration is read-only with the reason stated.

`schemaParity.test.ts` asserts the ingest function keeps its shared secret
check, its constant-time comparison, its rate limit ordering, its idempotency
handling, its configuration-derived program resolution, and that it leaks no
configuration values in responses.

### Row Level Security is tested against real PostgreSQL

`npm run test:rls` applies every migration to a throwaway PostgreSQL database
(twice, proving repeatability), verifies the seeded pilot data, and executes
**28 role-based access scenarios** as each seeded user under the `authenticated`
role, with `auth.uid()` driven the same way Supabase drives it.

The scenarios in `supabase/tests/rls_scenarios.sql` cover:

- an analyst may triage a candidate; SOC manager, SOC operator and viewer may
  not validate one;
- a SOC manager may acknowledge; a viewer may not, and may not insert an
  acknowledgment row;
- a SOC operator may not record an acknowledgment attributed to someone else;
- analysts and SOC managers may not change roles; a program administrator may,
  but may not mint a super administrator;
- a viewer may not grant themselves a role;
- a SOC manager may not change scoring thresholds; a program administrator may;
- an analyst may not deactivate a location;
- **no role may edit a signal** — collected evidence is immutable;
- **no role may update or delete an audit event**;
- a user with no membership sees zero alerts, signals, locations and candidates,
  and cannot insert a candidate;
- a program member does see the program's data (7 locations, the fixture alert)
  — so the negative results above are not passing merely because everything is
  denied;
- no application role can read `ingest_rate_limits`.

This testing surfaced a real gap: the migrations relied on Supabase's implicit
grants to `authenticated` rather than declaring their own. Migration
`0009_privileges.sql` now declares privileges explicitly and revokes the
operations that must never be possible — UPDATE on `signals`, UPDATE and DELETE
on `audit_events`, DELETE on alerts and their child records, and all access to
`ingest_rate_limits`. A policy has no effect if the underlying privilege is
missing, and relying on a platform default for that was fragile.

### Retention scenarios

`supabase/tests/retention_scenarios.sql` runs in the same harness and proves the
destructive path behaves as documented rather than as intended: the report is
read-only, holds are counted separately from eligible rows, a real purge refuses
while the master switch is off, a dry run is permitted with the switch off and
deletes nothing, an eligible signal is removed, a held signal survives, audit
events are never purged, and every run is recorded with what it held back.

Executed on this branch: 12 checks, all passing.

### What is still not covered

The Supabase **client** path — Auth sign-in, Realtime subscriptions and the
deployed Edge Function — requires a live project and has not been exercised end
to end. `docs/DEPLOYMENT.md` lists those checks.

Specifically **not** proven by any test in this repository: that RLS behaves the
same under a Supabase Auth session as it does under the `authenticated`
PostgreSQL role, and that one tenant cannot read another's rows on a live
project. Both are release-blocking and both are covered by
`npm run validate:staging`, which has never been executed. See
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).
