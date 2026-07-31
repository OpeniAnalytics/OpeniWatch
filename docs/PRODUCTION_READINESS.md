# Production readiness

Status of every item that stands between this branch and a client
demonstration. Nothing here is marked complete on the strength of local demo
mode.

**Phase 2 could not be completed as specified.** The environment running this
work has no network route to Supabase, Netlify or OneSignal (the proxy returns
403 on CONNECT for all three), no Docker daemon to run a local Supabase stack,
and no credentials for any of the three services. Every objective that needs
live infrastructure is therefore marked **BLOCKED**, with the exact credential
or action required and the exact command to run afterwards.

Verified at the time of writing:

```
supabase.com        -> connection refused by network policy (403 on CONNECT)
api.supabase.com    -> connection refused
netlify.com         -> connection refused
api.netlify.com     -> connection refused
onesignal.com       -> connection refused
api.onesignal.com   -> connection refused
docker info         -> daemon not running (/var/run/docker.sock absent)
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN,
NETLIFY_AUTH_TOKEN, ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY,
OPENIWATCH_INGEST_SECRET -> all absent
```

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
| Supabase Auth | **Implemented but not verified** | No live project reachable |
| Supabase Realtime | **Implemented but not verified** | Subscription code written; never observed delivering |
| OneSignal web push | **Implemented but not verified** | Server-side dispatcher, opt-in registration, service worker and CSP all complete. Requires credentials |
| Twilio SMS | **Disabled** | No request is attempted. `disabled` is recorded with the reason |
| Automatic escalation | **Implemented but not verified** | Edge Function complete and idempotent by construction; never run on a schedule |
| Data retention | **Implemented but not verified** | Report, purge, holds and audit complete; scheduler disabled by default |
| Email / Microsoft Teams / outbound webhook | **Stubbed** | Report themselves unavailable |
| RSS / news, public safety feed | **Requires credentials** | Normalizers ready |
| Zignal / Spyglass collection | **Requires vendor documentation** | Ten specific items listed in `INTEGRATIONS.md`. No endpoints fabricated |
| Netlify staging deployment | **BLOCKED** | No network route, no token |

---

## Blocked objectives

### Step 3 — live Supabase staging project — BLOCKED

**Needs:** a Supabase account, a staging project, and its URL, anon key and
service-role key. Network access to `*.supabase.co` and `api.supabase.com`.

**Then run:**

```bash
supabase link --project-ref <staging-ref>
supabase db push
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
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
SUPABASE_ANON_KEY=<anon> \
SUPABASE_SERVICE_ROLE_KEY=<service-role> \
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

---

## Completed in this phase, verified locally

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
| Secret scan of full git history | 122 blobs; 7 hits, all documentation placeholders or the `service_role` PostgreSQL role name |
| Dependency advisories | See below |

---

## Known residual issues

### react-router advisory GHSA (RSC-mode CSRF), severity high

`npm audit` reports one high advisory against `react-router` 7.12.0–8.3.0. **No
fixed version exists** — 8.3.0 is unreleased, and the advisory's suggested
remediation is 7.11.0, which reinstates two moderate advisories including an
open redirect in `<Link>`/`useNavigate` that is genuinely reachable from a
client-rendered SPA.

The decision is to stay on 7.18.2:

- the RSC CSRF path requires React Server Components or a react-router server
  runtime. OpeniWatch is a client-rendered SPA using `BrowserRouter`, so the
  vulnerable code is neither shipped nor reachable;
- 7.18.2 fixes the open redirect and the SSR hydration issue, which were the
  advisories with any conceivable applicability here.

**Re-check when 8.3.0 ships** and upgrade. `npm audit` will continue to report
this until then; that is expected, not neglected.

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
3. The deployed bundle scanned and confirmed free of the service-role key.
4. OneSignal verified to send, with the delivery recorded as `sent` and not
   claimed as `delivered`.
5. Automatic escalation observed to escalate once and only once.
6. Coordinates verified, or the demonstration explicitly framed around
   vicinity-level matching.
