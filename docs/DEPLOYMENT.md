# Deployment

OpeniWatch is a static single-page application plus a Supabase backend. All
server-side work runs in Supabase Edge Functions, so the hosting platform never
holds a secret beyond the browser-safe `VITE_` values.

> **Partly a record now.** The Supabase project (`dbbmlufrefctmxgitosx`) and
> the Netlify site (`openiwatch.netlify.app`) both exist. The database is fully
> migrated and seeded, and the Netlify production environment variables are set.
>
> The three Edge Functions are deployed and ACTIVE, and their deployed source
> has been compared against this repository file by file.
>
> Still outstanding, and both dashboard-only:
>
> 1. Supabase **Auth** configuration — Site URL, redirect URLs, the Azure
>    provider, Resend SMTP. See [`AUTHENTICATION.md`](AUTHENTICATION.md).
> 2. Supabase **function secrets** — `OPENIWATCH_INGEST_SECRET` and the
>    OneSignal credentials. Until these are set, all three functions return 503.
>
> Neither can be reached from an automated control plane: the Supabase MCP
> surface exposes the database, migrations, Edge Functions and API keys, but not
> Auth settings and not function secrets.

---

## 1. Supabase

### Create the project

The OpeniWatch project is `dbbmlufrefctmxgitosx`. Take the publishable and
secret keys from **Project Settings -> API Keys**, not from the Legacy API keys
page.

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

Migrations run in filename order (`0001` … `0012`) and are re-runnable: enum
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

Use `provision-user.mjs`. It creates a **passwordless** account, which is the
only kind that can sign in: `signInWithPassword` has been removed from the
product, so a password is a credential OpeniWatch will never accept.

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SECRET_KEY=<sb_secret_...> \
node scripts/provision-user.mjs \
  --email person@company.com \
  --name "Casey Rivera" \
  --role soc_manager \
  --org openi-security-services \
  --program costco-pilot
```

`--dry-run` resolves and prints without writing. The script is all-or-nothing:
it unwinds every row it created if any step fails, because a half-provisioned
account looks granted in the dashboard and is refused at the door. Full
description in [`AUTHENTICATION.md`](AUTHENTICATION.md).

> `scripts/seed-users.mjs` is for a **local stack only**. It sets passwords, and
> those passwords cannot be used to sign in to this product. Do not point it at
> a deployed project. See [`PILOT_SETUP.md`](PILOT_SETUP.md).

### Deploy the Edge Functions

There are three, and all three are **deployed to `dbbmlufrefctmxgitosx`** and
ACTIVE:

| Function | Called by | Purpose |
| --- | --- | --- |
| `ingest-signal` | a collector | Accepts inbound signal batches |
| `dispatch-notifications` | a scheduler | Hands queued deliveries to OneSignal |
| `escalate-unacknowledged` | a scheduler | Raises escalations on overdue alerts |

```bash
supabase secrets set OPENIWATCH_INGEST_SECRET="$(openssl rand -hex 32)"
supabase secrets set OPENIWATCH_INGEST_PROGRAM_SLUG="costco-pilot"
supabase functions deploy ingest-signal
supabase functions deploy dispatch-notifications
supabase functions deploy escalate-unacknowledged
```

`SUPABASE_URL` and the `SUPABASE_SECRET_KEYS` dictionary are provided to
functions by the platform; `_shared/supabase-keys.ts` reads the named key out
of it. The legacy `SUPABASE_SERVICE_ROLE_KEY` is deliberately not consulted.

> **They are deployed but not yet configured, and that is safe.**
> `OPENIWATCH_INGEST_SECRET` has not been set on the project, so every one of
> the three returns **503** with a generic message and touches nothing. Each
> reads its whole environment up front and returns null if any part is missing:
>
> ```ts
> if (!supabaseUrl || !secretKey || !ingestSecret) return null
> ```
>
> Setting the secret is what turns them on. Until then they fail closed rather
> than running with a partial configuration.

`supabase/config.toml` sets `verify_jwt = false` for all three. Each
authenticates its own caller with a shared secret in the `x-openiwatch-secret`
header, compared in constant time, and returns 401 otherwise. None expects a
user JWT — the callers are a collector and a scheduler, not a browser — so
leaving JWT verification on would make Supabase reject them at the gateway
before the function ran.

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
VITE_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_...>
VITE_ENVIRONMENT_LABEL=Staging
VITE_ENABLE_SIMULATOR=false
VITE_ENABLE_LOCAL_DEMO=false
VITE_DEFAULT_ORG_NAME=Your Organization Name
```

Optionally add `VITE_SPYGLASS_BASE_URL` and `VITE_ONESIGNAL_APP_ID`.

> ### Saving the variables is not enough
>
> These are **build-time** values. Vite compiles them into the JavaScript
> bundle; nothing reads them when the page loads. A site whose variables look
> correct in the dashboard will keep serving the previous bundle, with the
> previous values, until it is rebuilt.
>
> After saving, **trigger a redeploy** — Deploys → Trigger deploy → *Clear cache
> and deploy site*.
>
> This is the single most likely reason a deployment still shows the
> configuration screen, or still showed demo mode before that screen existed.

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_PUBLISHABLE_KEY` is missing, OpeniWatch shows
a blocking configuration screen naming the missing variables and refuses to
start. It does not fall back to demo data. See
[`CONFIGURATION.md`](CONFIGURATION.md).

**Never set `SUPABASE_SECRET_KEY`, `ONESIGNAL_REST_API_KEY`,
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

- [ ] No configuration screen — confirms both Supabase variables reached the build.
- [ ] The demo-mode banner is **absent**.
- [ ] The environment badge reads `Staging`.
- [ ] `curl -s <site>/assets/*.js | grep -c 'service_role'` returns 0.
- [ ] The Simulator link is absent when `VITE_ENABLE_SIMULATOR=false`.

### Progressive web application

- [ ] `curl -sI <site>/manifest.webmanifest` returns 200.
- [ ] `curl -sI <site>/OneSignalSDKWorker.js` returns `Service-Worker-Allowed: /`.
- [ ] Chrome DevTools → Application → Manifest shows no errors.
- [ ] Exactly **one** service worker is registered at scope `/`.
- [ ] Installing from the browser produces a standalone window.
- [ ] On iOS, Share → Add to Home Screen launches full-screen with no address bar.
- [ ] Opting in to web push still works after installation — confirms the shared
      worker did not break OneSignal.

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
