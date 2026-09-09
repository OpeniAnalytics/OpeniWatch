# Production readiness

Status of every item that stands between this branch and a client
demonstration. Nothing here is marked complete on the strength of local demo
mode.

**Infrastructure now exists.** Earlier revisions of this document said no
OpeniWatch Supabase project existed. That was wrong, and the reason is worth
recording: the search behind it listed projects account-wide and concluded from
an incomplete result, rather than querying the known project reference
directly. The project sits in a different Supabase organization from the one
that listing covered.

Verified through the Supabase and Netlify management APIs:

```
Supabase project   dbbmlufrefctmxgitosx  "OpeniWatch"   ACTIVE_HEALTHY  us-west-2
  37 public tables, RLS enabled AND forced on all 37, 76 policies
  15 openiwatch.* functions, 17 enums
  Seed present: 1 org, 1 program, 7 locations, 8 assignments, 21 categories
  Plano: 2 assignments against 1 location
  Migrations 0001-0012 all applied (verified object by object, not by history:
  the project has no supabase_migrations table, so the schema was applied
  outside the CLI)
  auth.users: 0 - no operator has been provisioned yet
  Edge Functions deployed: none

Netlify site       openiwatch  d82e7dcd-8233-4085-b41d-a5f132c2e319
  Production branch main, context production, latest deploy ready
  Netlify secret scan: 160 files scanned, 0 matches
```

**What is still not verified is anything requiring a browser.** This
environment reaches Supabase and Netlify through their management APIs only; it
has no network route to `openiwatch.netlify.app`, to `api.supabase.com`, or to
Microsoft. No sign-in has been performed by anyone.

**Supabase Auth configuration is unreachable from here.** The Supabase MCP
control plane exposes the database, migrations, Edge Functions and API keys —
but not Auth settings. Site URL, redirect URLs, the Azure provider and SMTP are
dashboard-only, and this environment holds no `SUPABASE_ACCESS_TOKEN`. Those
remain manual actions.

---

## Integration status

Every integration carries exactly one label.

| Integration | Status | Notes |
| --- | --- | --- |
| Manual analyst submission | **Implemented and verified** | Covered by unit, integration and Playwright tests |
| Secure ingest webhook | **Implemented but not verified** | Code complete and unit-tested; never executed against a deployed function |
| Development simulator | **Simulated** | Eight scenarios; disabled unless `VITE_ENABLE_SIMULATOR=true` **and** the role may submit signals |
| In-app notifications | **Implemented and verified** | Verified against the local provider and through Playwright |
| Development notification provider | **Implemented and verified** | Records simulated deliveries |
| PostgreSQL schema and migrations | **Implemented and verified** | Applied twice against real PostgreSQL 16; see `npm run test:rls` |
| Row Level Security | **Implemented and verified (PostgreSQL), not verified (Supabase)** | 28 scenarios pass against real PostgreSQL under the `authenticated` role. Not yet run through Supabase Auth sessions |
| Supabase Auth | **Implemented but not verified** | Project reachable and migrated; Auth settings (Site URL, redirect URLs, Azure, SMTP) are dashboard-only and not yet configured |
| Supabase Realtime | **Implemented but not verified** | Subscription code written; never observed delivering |
| OneSignal web push | **Implemented but not verified** | Server-side dispatcher, opt-in registration, service worker and CSP all complete. Requires credentials |
| Twilio SMS | **Disabled** | No request is attempted. `disabled` is recorded with the reason. Asserted by Playwright |
| Automatic escalation | **Implemented but not verified** | Edge Function complete and idempotent by construction; never run on a schedule |
| Data retention | **Implemented and verified (PostgreSQL), not verified (Supabase)** | 12 scenarios execute the real report, dry run and purge against real PostgreSQL, including a real deletion, a refused purge and a surviving hold. Never run on a live project; scheduler disabled by default |
| Output encoding / stored XSS defence | **Implemented and verified** | 7 Playwright tests submit hostile markup through the real submission path and assert it never executes anywhere it is rendered |
| Email / Microsoft Teams / outbound webhook | **Stubbed** | Report themselves unavailable |
| RSS / news, public safety feed | **Requires credentials** | Normalizers ready |
| Zignal / Spyglass collection | **Requires vendor documentation** | Ten specific items listed in `INTEGRATIONS.md`. No endpoints fabricated |
| Netlify production deployment | **Implemented and verified** | `openiwatch.netlify.app` builds from `main`, latest deploy ready, Netlify secret scan clean |
| Supabase API key model | **Implemented and verified** | Publishable key in the browser, secret key server-side; 30 tests including a real build asserted free of secret material |

---

## Blocked objectives

Phase 2 and Phase 3 numbered their steps differently. The mapping, so neither
brief has to be read against the other:

| Objective | Phase 2 step | Phase 3 step |
| --- | :-: | :-: |
| Live Supabase staging project | 3 | 5 |
| Authenticated role validation | 4 | 6 |
| Cross-tenant isolation | 5 | 7 |
| Ingestion against a deployed function | 6 | 8 |
| Full live workflow including Realtime | 7 | 9 |
| OneSignal web push | 8 | 10 |
| Automatic escalation | — | 11 |
| Netlify staging deployment | 16 | 12 |
| Browser acceptance against the deployed site | 17 | 13 |
| Realistic staging performance figures | — | 14 |
| Coordinate verification | — | 15 |

### Step 3 (Phase 3 step 5) — live Supabase staging project — BLOCKED

**Needs:** a Supabase account, a staging project, and its URL, anon key and
secret key. Network access to `*.supabase.co` and `api.supabase.com`.

**Then run:**

```bash
supabase link --project-ref <staging-ref>
supabase db push
SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
OPENIWATCH_SEED_PASSWORD='<strong password>' npm run seed:users -- --allow-production
supabase secrets set OPENIWATCH_INGEST_SECRET="$(openssl rand -hex 32)"
supabase secrets set OPENIWATCH_APP_ORIGIN="https://<staging-site>"
supabase functions deploy ingest-signal
supabase functions deploy dispatch-notifications
supabase functions deploy escalate-unacknowledged
```

### Steps 4, 5, 6, 7 — live authorization, isolation, ingestion, lifecycle — BLOCKED

**Needs:** Step 3 complete.

**Then run — this is the single command that covers all four:**

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_PUBLISHABLE_KEY=<sb_publishable_...> \
SUPABASE_SECRET_KEY=<sb_secret_...> \
OPENIWATCH_INGEST_SECRET=<secret> \
OPENIWATCH_SEED_PASSWORD=<password> \
npm run validate:staging
```

`scripts/validate-staging.mjs` signs in as each of the six roles through real
Supabase Auth and then asserts, through those authenticated sessions:

- every role restriction, by attempting the operation rather than by reading a
  policy;
- cross-tenant isolation, by creating a temporary second organization with its
  own location, signal, candidate and alert, then confirming a Costco Pilot
  user cannot read any of them **by UUID** — not merely that they are absent
  from a list — and cannot add themselves to it. The temporary records are
  prefixed `ZZ-ISOLATION-TEST` and deleted afterwards unless `--keep-test-data`;
- the ingest endpoint: no secret, wrong secret, malformed payload, non-http(s)
  URL, invalid timestamp, oversized text, oversized batch, valid request, and a
  replayed request proving idempotency;
- the full lifecycle with a recorded timeline, including a live Realtime
  subscription that must receive the new alert within 20 seconds;
- both Edge Functions, including that a second escalation run escalates nothing.

It exits non-zero if any check fails and prints every failure.

### Step 8 — OneSignal web push — BLOCKED for verification only

The implementation is complete. **Needs:** a OneSignal app, its App ID and REST
API key, and a web-push configuration for the staging domain.

**Then:**

```bash
supabase secrets set ONESIGNAL_APP_ID=<app-id>
supabase secrets set ONESIGNAL_REST_API_KEY=<rest-key>
# Netlify: VITE_ONESIGNAL_APP_ID=<app-id>
```

Then opt in from the deployed site, validate an alert, and check
`notification_deliveries` for a `sent` row carrying the OneSignal message id.
See `ONESIGNAL_SETUP.md`.

### Steps 16, 17 — Netlify staging and browser acceptance — BLOCKED

**Needs:** a Netlify account and site, plus network access.

`netlify.toml` is complete: build command, publish directory, SPA fallback,
security headers, CSP for Supabase and OneSignal, service-worker headers and
cache policy. The acceptance checklist is `STAGING_ACCEPTANCE.md`.

### Phase 3 step 14 — realistic staging performance — BLOCKED

What exists is genuine but is not a staging figure: `scripts/perf-dataset.sql`
loads 10,000 signals, 1,000 candidates, 250 alerts, 50 locations and 502
profiles into local PostgreSQL, and `EXPLAIN ANALYZE` shows every paginated
query index-backed and under 0.12 ms. That measures the **query plan**, on
local disk, with no network, no PostgREST, no RLS-under-Auth overhead and no
concurrency.

A staging number needs the round trip an operator actually experiences. It is
not derivable from the local figure and is not claimed here. Once staging
exists, load the dataset and record wall-clock time for: sign-in, first paint of
the alert feed, feed pagination, alert detail, and analyst-queue load — each
from a browser against the deployed site, not from psql.

**Do not present the sub-millisecond local figures as staging performance, and
do not present either as production-scale readiness.** The dataset is a pilot
approximation, not a production load test.

### Phase 3 step 15 — coordinate verification — BLOCKED

All seven pilot sites are `unverified` with a recorded ±250 m accuracy, and
migration `0011` widens property and parking geofences to 450 m to compensate.
That is the honest state, not a placeholder to be quietly flipped.

**Needs:** a geocoding API key. `maps.googleapis.com` is the one host reachable
from this environment (302), but it returns `REQUEST_DENIED` without a key. No
`GOOGLE_MAPS_API_KEY` is present.

**When run:** a geocoding result alone must not set a status of `verified`.
Migration `0011` enforces that a verified status carries both a method and a
timestamp; the operational rule is that `verified` means a person confirmed the
point against the site, and a geocoder result is recorded as
`provider_geocoded`. Widened geofences stay until that confirmation happens.

---

## Completed in Phase 3, verified locally

Phase 3 could not deploy anything, so the work done was to convert claims that
existed only in documentation into tests that execute. Two did.

| Item | Evidence |
| --- | --- |
| Stored content cannot execute | `e2e/security.spec.ts` — hostile `<script>` and `<img onerror>` payloads submitted through the real manual-submission path in the signal text, the public author handle and an operational note; asserted inert in the analyst queue, the alert detail view and the note list. 7 tests, all passing |
| `type="url"` is not a security control | Same file. `javascript:alert(1)` is *accepted* by the input element; the shared schema is what rejects it. The test asserts the schema's refusal surfaces and no pipeline result is produced |
| External link hardening | Same file — `target="_blank"` with `rel` containing `noopener`, `noreferrer` and `nofollow` |
| Route refusal on direct URL entry | Same file — a SOC manager typing `/simulator` and a viewer typing `/queue` both get the refusal panel, with the protected region absent from the DOM |
| Retention behaves as documented | `supabase/tests/retention_scenarios.sql` — 12 checks against real PostgreSQL, including a real deletion, a refused purge with the switch off, a surviving hold, and audit events outliving the purge that wrote them. All passing |
| Baseline re-verified from a clean checkout | typecheck exit 0; lint exit 0; 166 unit tests passed; production build clean (entry chunk 235.82 kB / 64.93 kB gzipped); migrations applied twice cleanly; 28 RLS checks passed; 12 retention checks passed; 12 Playwright tests passed (4 workflow + 1 mobile + 7 security); 12 schema-parity tests passed |
| Secret scan of full git history | all 165 blobs scanned for JWT, Supabase (`sbp_`), Twilio (`AC…`), OpenAI, SendGrid and private-key shapes — 0 matches. A broader keyword sweep matches only variable *names* in documentation and operator-facing text, plus the PostgreSQL role literally named `service_role` |

Phase 3 did **not** add live Zignal ingestion, Twilio SMS, or any unrelated
product feature.

---

## Completed in Phase 2, verified locally

| Item | Evidence |
| --- | --- |
| Migrations 0010–0012 apply and re-apply cleanly | `npm run test:rls` |
| RLS still passes with the new tables | 28/28 scenarios |
| Explicit table privileges | Migration 0009, verified by the RLS suite |
| Server-side paging and filtering | `MAX_PAGE_SIZE` enforced in both providers |
| Query performance at target volume | 10,000 signals / 1,000 candidates / 250 alerts / 50 locations / 502 profiles; every paginated query index-backed, all under 0.12 ms |
| Bundle reduction | Entry chunk 744 kB → 236 kB (210 kB → 65 kB gzipped) |
| Route-level role enforcement on direct URL entry | `RequireRole` in `App.tsx` |
| Simulator gated on flag **and** role | `App.tsx`, `AppShell.tsx` |
| Staging and kill-switch banners | `AppShell.tsx` |
| Honest delivery vocabulary | `queued`/`sent`/`delivered`/`disabled` distinguished; provider acceptance never recorded as delivery |
| SMS cannot fire | `disabled` outcome, no Twilio request in any code path |
| Coordinates not falsely marked verified | Migration 0011; all seven pilot sites `unverified` with ±250 m recorded |
| Secret scan of full git history | 122 blobs at the time; hits were documentation placeholders or the `service_role` PostgreSQL role name. Re-run in Phase 3 across all 165 blobs in history with the same result |
| Dependency advisories | See below |

---

## Known residual issues

### react-router advisory GHSA (RSC-mode CSRF), severity high

`npm audit` reports one high advisory against `react-router`, counted twice
because `react-router-dom` depends on it. The affected range is now
**7.12.0–8.2.0**, and **8.3.0 has shipped and is fixed** — the version this
document previously said to wait for.

Taking it was attempted in Phase 3 and rejected on evidence, not on preference:

- `react-router-dom` does not exist above 7.18.2. v8 folded it into
  `react-router`, so the upgrade means swapping the dependency and rewriting
  ten import statements. That part is mechanical and fine.
- `react-router@8.3.0` declares `peer react@">=19.2.7"`. OpeniWatch is on React
  18.3.1, so taking the fix means a **React 18 → 19 major upgrade**, which pulls
  in every Radix UI primitive, the testing library and the whole render path.

That is a substantial migration with its own regression surface, and it is not
staging-validation work. It should be planned and tested on its own branch.

The interim decision remains 7.18.2, on the same reasoning as before:

- the RSC CSRF path requires React Server Components or a react-router server
  runtime. OpeniWatch is a client-rendered SPA using `BrowserRouter`, so the
  vulnerable code is neither shipped nor reachable;
- 7.18.2 fixes the open redirect and the SSR hydration issue, which were the
  advisories with any conceivable applicability here;
- the audit's own `--force` remediation is 7.11.0, which *reinstates* that open
  redirect in `<Link>`/`useNavigate`. Applying it would make the application
  less safe, not more.

**Next step:** schedule the React 19 upgrade as its own piece of work, then take
react-router 8.3.0 with it. `npm audit` will keep reporting 2 high until then —
expected, and now with a concrete blocker rather than "no fix exists".

### Not resolved in this phase

| Limitation | Impact | Next step |
| --- | --- | --- |
| Reference data is still snapshot-loaded | The Supabase provider fetches locations, categories, profiles and subscriptions in full on load. At pilot scale (50 locations, ~500 profiles) this is a few hundred KB | Move to targeted queries if a program exceeds ~2,000 profiles |
| Alert search is title/summary only | Searching source text server-side needs a full-text index | Add a `tsvector` column and GIN index on `signals.original_text` |
| Realtime subscriptions are not program-filtered | Every subscriber receives change notifications for rows RLS lets them read, then refetches | Add a filter on `program_id` to the channel when programs multiply |
| Reporting loads every alert in range | A year-long report at high volume would be large | Move aggregation into a database function |
| No delivery receipts | `sent` can never become `delivered` for web push | Implement the OneSignal delivery callback |
| Retention purge is manual | `run_retention()` exists; nothing calls it on a schedule | Enable a cron trigger once a program opts in |
| Coordinates unverified | Geofences widened to 450 m to compensate | Run an authoritative geocoding pass — see `PILOT_SETUP.md` |
| Error monitoring not wired | No Sentry or equivalent | Add one configured to scrub source text and secrets |
| Password reset flow untested | Supabase provides it; the UI does not expose a "forgot password" link | Add the link and verify against staging |

---

## Release-blocking requirements not yet met

These must pass before any client demonstration:

1. Cross-tenant isolation proven against live Supabase (`validate:staging`).
2. RLS proven through authenticated Supabase sessions, not only PostgreSQL
   roles.
3. The deployed bundle scanned and confirmed free of the secret key.
4. OneSignal verified to send, with the delivery recorded as `sent` and not
   claimed as `delivered`.
5. Automatic escalation observed to escalate once and only once.
6. Coordinates verified, or the demonstration explicitly framed around
   vicinity-level matching.
