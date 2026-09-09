# Pull request: OpeniWatch staging validation

**Branch:** `claude/openiwatch-staging`
**Base:** `main`
**Status:** draft. Do not merge — the release-blocking checks below have not
been run, and cannot be until credentials exist.

---

## Read this first

This phase was briefed on the basis that *"the external service credentials and
network access required for staging are now available."*

**They are not.** This was measured at the start of the phase rather than
assumed in either direction, and measured again before opening this pull
request:

```
# Environment variables — presence only; no value was read, logged or printed
SUPABASE_URL                 ABSENT      VITE_SUPABASE_URL        ABSENT
SUPABASE_SERVICE_ROLE_KEY    ABSENT      VITE_SUPABASE_ANON_KEY   ABSENT
SUPABASE_ACCESS_TOKEN        ABSENT      OPENIWATCH_INGEST_SECRET ABSENT
SUPABASE_DB_PASSWORD         ABSENT      OPENIWATCH_SEED_PASSWORD ABSENT
ONESIGNAL_APP_ID             ABSENT      ONESIGNAL_REST_API_KEY   ABSENT
NETLIFY_AUTH_TOKEN           ABSENT      NETLIFY_SITE_ID          ABSENT
GOOGLE_MAPS_API_KEY          ABSENT

# No .env, .env.local or .env.staging exists. Neither CLI is installed.

supabase.com  403 on CONNECT    netlify.com  403    onesignal.com  403
docker info   daemon not running (/var/run/docker.sock absent)
```

So: **no staging environment was deployed.** No Supabase project, no migration
push, no seeded user, no deployed Edge Function, no Netlify site, no OneSignal
application, no browser session against a deployed URL. `npm run
validate:staging` has never been executed.

Everything claimed below was executed locally and can be re-run from a clean
checkout. Nothing is marked verified on the strength of a previous summary.

---

## What this branch actually adds

Since deployment was impossible, the work was to take two things that existed
only as assertions in documentation and turn them into tests that run and can
fail.

### `e2e/security.spec.ts` — 7 tests, all passing

Signal text, author handles and operational notes are attacker-controlled:
anyone who can post publicly chooses what OpeniWatch collects. Previously
`SECURITY.md` asserted this content is rendered inertly; nothing checked it.

The headline test submits, through the **real manual-submission path** rather
than a fixture:

```
<script>window.__openiwatch_xss = true</script>
<img src=x onerror="window.__openiwatch_xss = true">
```

into the signal text, the public author handle and — after validation — an
operational note. At each place that content is rendered (analyst queue, alert
detail, note list) it asserts the marker global is never set, no `script`
element containing it exists, and no `img[onerror]` exists.

Also covered: external links carry `target="_blank"` with `noopener`,
`noreferrer` and `nofollow`; a SOC manager typing `/simulator` and a viewer
typing `/queue` both get the refusal panel with the protected region absent;
the sticky action bar does not overlap sign-out; the skip link is the first tab
stop.

**One finding worth the reviewer's attention.** The first version of the
`javascript:` URL test assumed `<input type="url">` would reject
`javascript:alert(1)`. It does not — the value has a scheme, so the browser
considers it valid and never marks the field invalid. The shared validation
schema is the actual gate. The test now exercises the schema's rejection and
carries a comment saying so, because the wrong assumption is the kind that gets
copied into the next form.

### `supabase/tests/retention_scenarios.sql` — 12 checks, all passing

Retention deletes operational evidence. Its value is in what it refuses to do,
and none of that was tested. These checks run against real PostgreSQL as part of
`npm run test:rls`:

the report is read-only and counts holds separately from eligible rows; a real
purge refuses while `retention_enabled` is false; a dry run is permitted with
the switch off and deletes nothing but is still recorded; a real purge removes
an eligible signal; a held signal survives it; audit events are never purged;
the purge writes an audit event; the run records what it held back.

`scripts/test-rls.sh` runs them alongside the 28 RLS scenarios.

---

## Verification performed on this branch

All from a clean checkout, all re-run for this pull request.

| Gate | Result |
| --- | --- |
| TypeScript (strict) | exit 0 |
| ESLint | exit 0 |
| Unit and integration tests | 166 passed |
| Playwright | 12 passed (4 workflow + 1 mobile + 7 security) |
| Production build | entry chunk 235.82 kB / 64.93 kB gzipped |
| Migrations applied twice | clean, no error on re-apply |
| RLS scenarios (real PostgreSQL 16) | 28 passed |
| Retention scenarios (real PostgreSQL 16) | 12 passed, 0 failed |
| Schema parity, browser vs Edge Function | 12 passed |
| Secret scan, full git history | all 165 blobs scanned for JWT, Supabase, Twilio, SendGrid and private-key shapes — 0 matches |
| `npm audit` | 2 high — one advisory, counted against both `react-router` and `react-router-dom`. See "Security" below: the fix now exists but requires a React 19 upgrade |

The secret scan's only matches are variable *names* in documentation and
operator-facing text, and the PostgreSQL role literally named `service_role`.
No secret value appears in the tree or its history.

---

## Not verified — release blocking

None of these can be closed without credentials. Each has an exact command in
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).

| # | Blocked | Needs |
| :-: | --- | --- |
| 1 | Supabase staging project, migrations pushed, users seeded, functions deployed | Supabase project ref, service-role key, access token, network route |
| 2 | Role restrictions through authenticated Supabase sessions | the above + seed password |
| 3 | **Cross-tenant isolation on a live project** | the above |
| 4 | Ingestion against a deployed Edge Function | the above + ingest secret |
| 5 | Full live workflow including Realtime delivery | the above |
| 6 | OneSignal web push | OneSignal app id + REST key + web-push config |
| 7 | Automatic escalation observed firing once | deployed functions + a scheduler |
| 8 | Netlify staging deployment | Netlify token and site id |
| 9 | Browser acceptance against the deployed site | the above |
| 10 | Realistic staging performance figures | the above |
| 11 | Coordinate verification | a geocoding API key |

Item 3 is the one that must not be waved through. RLS passing under the
`authenticated` PostgreSQL role is strong evidence, but it is not the same
execution path as a Supabase Auth session, and a tenant boundary that has never
been attacked has not been tested. `validate:staging` creates a second
organization, populates it, and attempts to read every row **by UUID** from a
Costco Pilot session — not merely checking absence from a list — then deletes
the fixtures.

On item 10: the local figures (10,000 signals, every paginated query
index-backed, under 0.12 ms) measure the query plan on local disk. They are not
staging performance and must not be presented as such, nor as evidence of
production-scale readiness.

On item 11: all seven pilot sites remain `unverified` with ±250 m recorded, and
geofences are widened to 450 m to compensate. A geocoder returning a result is
not verification; `verified` requires a recorded method and timestamp from a
human confirmation.

---

## Review focus

1. `e2e/security.spec.ts` — particularly the `type="url"` comment. Is the
   assertion set actually sufficient to catch a regression?
2. `supabase/tests/retention_scenarios.sql` — check 4 (refuses with the switch
   off) and check 10 (audit events survive) are the two that matter most.
3. `docs/PRODUCTION_READINESS.md` — the blocked list is the deliverable of this
   phase as much as the tests are. Confirm nothing there overstates.

## Scope

No live Zignal ingestion, no Twilio SMS, no unrelated product features — all
three were explicitly out of scope for this phase and none were added.

## Security

- No secrets in the tree or its history; no secret value appears in this
  document or in any diagnostic output produced by this phase
- The service-role key is never imported into `src/`
- No screenshots committed
- One residual dependency advisory (react-router RSC-mode CSRF). A fixed version
  **has now shipped** — 8.3.0 — and taking it was attempted in this phase and
  rejected: `react-router@8.3.0` requires React ≥ 19.2.7, so the fix pulls in a
  React 18 → 19 major upgrade across every Radix primitive and the whole render
  path. That belongs on its own branch, not in a staging-validation phase. The
  vulnerable RSC path is not reachable from a client-rendered `BrowserRouter`
  SPA, and the audit's own `--force` remediation (7.11.0) would reinstate an
  open redirect that *is* reachable. Full reasoning and the follow-up in
  `PRODUCTION_READINESS.md`
