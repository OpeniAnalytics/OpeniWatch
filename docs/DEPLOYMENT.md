# Deployment

OpeniWatch is a static single-page application plus a Supabase backend. All
server-side work runs in Supabase Edge Functions, so the hosting platform never
holds a secret beyond the browser-safe `VITE_` values.

---

## 1. Supabase

### Create the project

Create a project at <https://supabase.com>. Note the project reference, the
anon key and the service-role key.

### Apply the migrations

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Or against a local stack:

```bash
supabase start
supabase db reset     # applies every migration in order
```

Migrations run in filename order (`0001` … `0009`) and are re-runnable: enum
creation is guarded, tables use `IF NOT EXISTS`, seeds use `ON CONFLICT`, and
policies are dropped before being recreated. Applying them twice is a no-op.

### Name the organization

The pilot organization name is configurable because the security-services
partner may be renamed. Either set it before applying migration 0008:

```sql
set openiwatch.org_name = 'Your Organization Name';
```

or rename the row afterwards:

```sql
update public.organizations
   set name = 'Your Organization Name'
 where slug = 'openi-security-services';
```

The id and slug stay stable, so seeded references survive a rename.

### Create users

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
OPENIWATCH_SEED_PASSWORD='<a strong development password>' \
node scripts/seed-users.mjs --allow-production
```

The script refuses to run against a non-local URL without `--allow-production`,
and refuses passwords shorter than 12 characters. **No password is stored in
this repository.** See [`PILOT_SETUP.md`](PILOT_SETUP.md).

### Deploy the ingest function

```bash
supabase secrets set OPENIWATCH_INGEST_SECRET="$(openssl rand -hex 32)"
supabase secrets set OPENIWATCH_INGEST_PROGRAM_SLUG="costco-pilot"
supabase functions deploy ingest-signal
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions by the
platform.

`supabase/config.toml` sets `verify_jwt = false` for this function: it
authenticates with its own shared secret rather than a Supabase JWT.

### Authentication settings

Signup is disabled (`enable_signup = false`). Accounts are created by an
administrator through the seed script or the Supabase dashboard — a public
signup form on a security operations product would be a liability.

Set the site URL and redirect URLs to your deployed origin.

---

## 2. Netlify

`netlify.toml` is committed and needs no dashboard configuration beyond
environment variables.

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Node version | 20 |

It also configures the SPA fallback (so `/alerts/<id>` serves `index.html`), a
Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, a referrer policy,
a permissions policy, immutable caching for hashed assets and no-cache for the
entry document.

### Environment variables

Set in **Site configuration → Environment variables**:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_DEFAULT_ORG_NAME=Your Organization Name
VITE_ENABLE_SIMULATOR=false
```

Set `VITE_ENABLE_SIMULATOR=false` for any production deployment. Optionally add
`VITE_SPYGLASS_BASE_URL` and `VITE_ONESIGNAL_APP_ID`.

**Never set `SUPABASE_SERVICE_ROLE_KEY`, `ONESIGNAL_REST_API_KEY`,
`TWILIO_AUTH_TOKEN` or `OPENIWATCH_INGEST_SECRET` in Netlify.** They belong to
Supabase function secrets. Only `VITE_`-prefixed values are needed here, and
only those reach the browser.

### Other static hosts

Any static host works. The requirements are: build with `npm run build`, serve
`dist/`, and rewrite unknown paths to `/index.html`.

---

## 3. Post-deployment verification

Run these after the first deployment. The Supabase path has not been exercised
against a live database in this repository's test environment, so this list is
the acceptance check rather than a formality.

### Configuration

- [ ] The demo-mode banner is **absent** — confirms Supabase credentials loaded.
- [ ] `curl -s <site>/assets/*.js | grep -c 'service_role'` returns 0.
- [ ] The Simulator link is absent when `VITE_ENABLE_SIMULATOR=false`.

### Seed data

- [ ] Locations shows **7** physical locations.
- [ ] Administration → Locations and assignments shows **8** assignments.
- [ ] Both Plano assignments reference the same physical Costco #696.
- [ ] Administration → Threat categories lists **21** categories.

### Workflow

- [ ] Sign in as the analyst; the analyst queue is reachable.
- [ ] Submit a signal manually; it appears as a candidate with a score and an
      explanation.
- [ ] Validate it; an alert is created and notification deliveries are recorded.
- [ ] The alert appears for a second signed-in user without a page refresh
      (confirms Realtime).
- [ ] Acknowledge, escalate, assign, resolve, set a disposition, close.
- [ ] Reporting shows the alert in both the daily and weekly views.
- [ ] CSV export downloads and opens correctly.
- [ ] The audit trail lists every action with the acting user and role.

### Row Level Security

The policies are already verified against real PostgreSQL by `npm run test:rls`,
which runs 28 scenarios as each role. Re-run the equivalent checks against the
deployed project to confirm the platform's own grants and the `auth` schema
behave as expected. Run them in the SQL editor **as each seeded user**, not as
the service role (the service role bypasses RLS, so testing with it proves
nothing):

- [ ] A viewer's `update public.alerts set status = 'acknowledged'` is refused.
- [ ] A SOC manager's `insert into public.alerts (...)` is refused.
- [ ] A SOC manager's `update public.candidate_alerts set status = 'validated'`
      is refused.
- [ ] An analyst's `update public.user_roles set role = 'program_admin'` is
      refused.
- [ ] A program administrator's `insert into public.user_roles (role) values
      ('super_admin')` is refused.
- [ ] `update public.audit_events set action = 'x'` is refused for every role.
- [ ] `update public.signals set original_text = 'x'` is refused for every role.
- [ ] A user with no membership in the organization sees zero rows in
      `public.alerts`.

### Ingestion

- [ ] A POST with no secret returns 401.
- [ ] A POST with a wrong secret returns 401.
- [ ] A valid POST returns 200 and creates a signal.
- [ ] The **same** POST repeated returns 200 with `duplicates: 1` and creates
      nothing new.
- [ ] A malformed payload returns 422 with field-level issues.
- [ ] Exceeding 120 requests in a minute returns 429.

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/ingest-signal" \
  -H "x-openiwatch-secret: $OPENIWATCH_INGEST_SECRET" \
  -H "content-type: application/json" \
  -d '{"signals":[{
        "sourcePlatform":"Public web source",
        "sourceRecordId":"deploy-check-1",
        "originalText":"Deployment verification signal. Costco #1487 Stafford.",
        "publishedAt":"2026-01-01T00:00:00Z",
        "collectionMethod":"webhook",
        "provenance":"Deployment verification"
      }]}'
```

---

## 4. Continuous integration

```yaml
- run: npm ci
- run: npm run typecheck
- run: npm run lint
- run: npm test
- run: npm run test:rls
- run: npm run build
- run: npx playwright install --with-deps chromium
- run: npm run test:e2e
```

The Playwright suite runs in local demo mode with no credentials, so CI needs no
secrets. Set `PLAYWRIGHT_CHROMIUM_PATH` if the runner has a pre-installed
Chromium whose build differs from the one Playwright expects.

---

## 5. Operational notes

**Backups.** Supabase provides automated backups on paid plans. `audit_events`
and `signals` are the records that matter for evidentiary purposes — confirm the
retention period meets the client's requirements before the pilot goes live.

**Realtime quotas.** The client is configured for 5 events per second. A
high-volume program may need this raised.

**Scaling reads.** The Supabase provider loads the program's working set into
memory. This suits the pilot (one program, eight assignments). Before a much
larger deployment, move the read paths to server-side views or RPCs — the
interface talks only to `DataProvider`, so no screen would change.

**Monitoring.** Watch the `ingest-signal` function logs for `storage_error`
entries, and `ingest_rate_limits` row growth as a proxy for ingest volume.
