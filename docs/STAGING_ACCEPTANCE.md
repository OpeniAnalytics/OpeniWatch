# Staging acceptance

The checklist that decides whether staging is fit for a controlled client
demonstration.

**Current status: not run.** No staging deployment exists. This environment has
no network route to Supabase, Netlify or OneSignal, and no credentials for any
of them — re-measured at the start of Phase 3, not assumed. See
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) for the evidence.

Every check below is either automated by `npm run validate:staging` or listed as
a manual browser step.

A small number of these checks now have **local** equivalents that do run. They
are marked *(locally covered)* below. That means the rendering and role logic
behind the check is exercised by Playwright against a production build in demo
mode — it does **not** mean the check has passed against a deployed site, and it
proves nothing about RLS, Auth, Realtime or the Netlify configuration. The box
stays unticked either way.

---

## Prerequisites

```bash
supabase link --project-ref <staging-ref>
supabase db push

SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role> \
OPENIWATCH_SEED_PASSWORD='<strong password>' \
npm run seed:users -- --allow-production

supabase secrets set OPENIWATCH_INGEST_SECRET="$(openssl rand -hex 32)"
supabase secrets set OPENIWATCH_APP_ORIGIN="https://<staging-site>"
supabase secrets set ONESIGNAL_APP_ID=<app-id>
supabase secrets set ONESIGNAL_REST_API_KEY=<rest-key>
supabase functions deploy ingest-signal
supabase functions deploy dispatch-notifications
supabase functions deploy escalate-unacknowledged
```

Netlify environment:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon>
VITE_ENVIRONMENT_LABEL=Staging
VITE_ENABLE_SIMULATOR=false
VITE_ONESIGNAL_APP_ID=<app-id>
VITE_DEFAULT_ORG_NAME=<organization name>
```

Supabase Auth → URL configuration: set the site URL and redirect URLs to the
staging Netlify domain. Confirm signup stays disabled.

**Rotate or disable any accounts seeded during Phase 1** before opening staging
to anyone outside the team.

---

## Automated

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
OPENIWATCH_INGEST_SECRET=... OPENIWATCH_SEED_PASSWORD=... \
NETLIFY_SITE_URL=https://<staging-site> \
npm run validate:staging
```

Covers: authentication for all six roles; every role restriction through
authenticated sessions; cross-tenant isolation including lookup by UUID;
ingestion rejection and acceptance cases including replay; the full lifecycle
with a timeline; Realtime; both Edge Functions including escalation idempotency;
and a scan of the deployed bundle for the service-role key.

Exits non-zero on any failure and prints each one.

- [ ] `validate:staging` passes with zero failures

---

## Manual browser checks

### Layout and theme

- [ ] Desktop 1440px — navigation rail visible, no horizontal scroll
- [ ] Tablet 1024px — layout reflows, all actions reachable
- [ ] Mobile 390px — drawer navigation, **no horizontal overflow on any screen**
- [ ] Light mode — severity colours legible, contrast adequate
- [ ] Dark mode — same
- [ ] Staging banner visible on every screen

### Session

- [ ] Sign in as each of the six accounts
- [ ] Reload mid-session — session restores without re-authenticating
- [ ] Sign out — returns to sign-in, back button does not restore the session
- [ ] Expired session (wait past token expiry, or clear it) — the app returns to
      sign-in rather than showing empty data
- [ ] Password reset from the Supabase-hosted flow succeeds

### Role restrictions through the deployed interface

- [ ] SOC manager: no analyst queue in navigation *(locally covered)*
- [ ] SOC manager: typing `/queue` shows the refusal panel, not the queue *(locally covered — `/simulator` and viewer `/queue` variants)*
- [ ] Viewer: alert detail has no action bar *(locally covered)*
- [ ] Viewer: administration is read-only with the reason stated *(locally covered)*
- [ ] Analyst: administration controls disabled
- [ ] Simulator absent for every role while `VITE_ENABLE_SIMULATOR=false`
- [ ] **The same denials hold at the database.** Hiding a control is not a
      result. `validate:staging` re-attempts each denied operation through an
      authenticated session and fails if the database permits it

### Workflow

- [ ] Submit the Stafford firearm signal through the ingest endpoint
- [ ] Candidate appears in the analyst queue, matched to Costco #1487, critical
- [ ] Analyst validates it
- [ ] **With a second browser signed in as the SOC manager, the alert appears in
      the feed without a refresh**
- [ ] SOC manager receives the in-app notification
- [ ] Acknowledge, assign, escalate (recording regional manager notification),
      resolve, set disposition, close
- [ ] Audit trail shows every action with actor and role
- [ ] Reporting shows the alert in daily and weekly views
- [ ] CSV export downloads and opens correctly in a spreadsheet

### Web push

- [ ] Opt in from the deployed site; the browser prompt appears only after
      pressing the button
- [ ] A row appears in `push_subscriptions`
- [ ] Validating an alert produces a `queued` web_push delivery
- [ ] Running the dispatcher produces a browser notification
- [ ] Tapping it opens the correct alert
- [ ] The delivery row reads `sent`, with a provider message id, and
      `delivered_at` is null
- [ ] Re-running the dispatcher sends nothing further
- [ ] Disabling push in the interface stops further notifications

### Escalation

- [ ] Validate a critical alert and leave it unacknowledged past 5 minutes
- [ ] The escalation function escalates it exactly once
- [ ] A second run escalates nothing
- [ ] The audit event records the rule id, threshold and elapsed time
- [ ] Turning off automatic escalation in Administration stops it

### Safety

- [ ] Bundle contains no service-role key (`validate:staging` checks this)
- [ ] Kill switch: turning off outbound notifications shows the banner, and new
      deliveries record `disabled`
- [ ] SMS records `disabled`, never `sent` or `simulated` *(locally covered)*
- [ ] External source links open with `noopener noreferrer nofollow` *(locally covered)*
- [ ] A signal containing `<script>alert(1)</script>` renders as text everywhere
      it appears — feed, detail, CSV export *(locally covered for the queue,
      detail and note views by `e2e/security.spec.ts`; the CSV path is unit
      tested for formula injection but not asserted end to end)*
- [ ] A signal with a `javascript:` source URL renders no link *(locally
      covered — note that the rejection comes from the shared schema, not from
      `type="url"`, which accepts `javascript:` because it has a scheme)*

---

## Screenshots

Capture for internal review: Operations Overview, Analyst Queue with the score
explanation open, Alert Detail with the delivery history, and the mobile
acknowledgment screen.

Do not capture the browser address bar if it contains a session token, and do
not capture real personal data. Do not commit screenshots to the repository.
