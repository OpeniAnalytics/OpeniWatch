# OpeniWatch

Location-based threat detection, validation, alerting, and reporting.

OpeniWatch converts publicly available reporting, social media posts, news,
emergency information, analyst submissions and third-party intelligence feeds
into actionable alerts tied to specific protected locations.

It is not a social listening dashboard. Its core operational workflow is:

```
Detect → Locate → Classify → Validate → Alert → Acknowledge → Escalate → Resolve → Report
```

The first deployment is an eight-assignment pilot supporting security
operations for Costco locations. The architecture is multi-tenant throughout
and supports future clients, programs, brands, facilities, executives, events
and geographic areas.

---

## Quick start

Requirements: **Node 20 or newer**. Nothing else.

```bash
git clone https://github.com/OpeniOracle/openiwatch.git
cd openiwatch
npm install
cp .env.example .env      # optional — the defaults work as-is
npm run dev
```

Open <http://localhost:5173>.

`npm run dev` runs OpeniWatch in **local demo mode**: a browser-local data
provider seeded with the pilot organization, the Costco Pilot program, seven
physical locations, eight operational assignments, a week of completed
operational history and a live analyst queue. The complete workflow — ingest,
score, validate, alert, notify, acknowledge, escalate, resolve, dispose, report
— works with no credentials at all.

Demo mode is **opt-in**, enabled for `npm run dev` by the committed
`.env.development`. It is never a fallback: a build with missing Supabase
variables shows a blocking configuration screen rather than quietly serving
browser-local data. A deployed application that looks functional while backed by
one browser's storage is the most dangerous failure this product has. See
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

Demo mode is labelled in the interface. It is never presented as a live backend.

### Try the demo workflow

1. Sign in as **Rowan Estrada (Analyst)**.
2. Go to **Simulator** and run *"1. Critical firearm report — Stafford parking lot"*.
3. Go to **Analyst queue**. The candidate is there, scored critical and matched
   to Costco #1487. Review the source, the location evidence and the scoring
   explanation, then **Validate and create alert**.
4. Sign out, sign in as **Kai Brennan (SOC manager)**, open the **Alert feed**.
   The alert is there with its notification deliveries recorded.
5. Acknowledge it, escalate it (recording store and regional manager
   notification), assign it, add an operational note, resolve it, set a final
   disposition and close it.
6. Check **Reporting** and the alert's **audit trail**.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 5173 |
| `npm run build` | Type-check and produce a production build in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | TypeScript check only (strict mode) |
| `npm run lint` | ESLint over the whole repository |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Critical-workflow and security tests (Playwright) |
| `npm run test:rls` | Apply the migrations to a throwaway PostgreSQL database and run the Row Level Security and retention scenario tests |
| `npm run seed:users` | Create the six development users in a Supabase project |
| `npm run generate:icons` | Regenerate the application icons in `public/icons/` |
| `npm run validate:staging` | Run the live-infrastructure acceptance suite against a deployed Supabase project |

`npm run test:e2e` builds the app and serves it automatically. On a machine
with a pre-installed Chromium at `/opt/pw-browsers/chromium`, that binary is
used; otherwise run `npx playwright install chromium` first.

---

## Running against Supabase

Local demo mode needs nothing. To run against a real Supabase project:

1. **Create a project** at <https://supabase.com>.

2. **Apply the migrations**, in order:

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   Or with a local stack:

   ```bash
   supabase start
   supabase db reset     # applies every migration in supabase/migrations
   ```

   Migrations are re-runnable — applying them twice is a no-op, not an error.

3. **Name the organization.** The pilot organization name is configurable
   because the security-services partner may be renamed. Either set it at apply
   time:

   ```sql
   set openiwatch.org_name = 'Your Organization Name';
   ```

   or rename the row afterwards. The slug and id stay stable, so nothing breaks.

4. **Create the development users:**

   ```bash
   SUPABASE_URL=http://127.0.0.1:54321 \
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
   OPENIWATCH_SEED_PASSWORD='choose-a-strong-development-password' \
   npm run seed:users
   ```

   No password is stored in this repository. See `docs/PILOT_SETUP.md`.

5. **Point the app at the project** in `.env`:

   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon-key>
   ```

6. **Deploy the ingest function** (optional, for webhook ingestion):

   ```bash
   supabase secrets set OPENIWATCH_INGEST_SECRET="$(openssl rand -hex 32)"
   supabase functions deploy ingest-signal
   ```

Restart `npm run dev`. The banner disappears and the app is running against
Supabase Auth, PostgreSQL, Realtime and Edge Functions.

> **Verification note.** The migrations, the Row Level Security policies and the
> retention functions are verified against a real PostgreSQL instance by
> `npm run test:rls`, which applies every migration twice (proving
> repeatability), checks the seeded pilot data, runs 28 role-based access
> scenarios and 12 retention scenarios — the latter including a real deletion, a
> purge correctly refused while retention is disabled, and a held record
> surviving.
>
> The Supabase **client** path — Auth, Realtime, Edge Functions, web push and
> the Netlify deployment — has **not** been exercised: the environment this was
> built in has no network route to Supabase, Netlify or OneSignal, and no
> credentials. Those integrations are labelled *implemented but not verified*.
> No staging deployment exists.
>
> `npm run validate:staging` performs every one of those checks against a
> deployed project and exits non-zero on failure. See
> [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md).

---

## Environment variables

Full annotated list in [`.env.example`](.env.example). Summary:

**Browser-safe (inlined into the bundle by Vite)**

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL. **Required** in any deployment. |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key. **Required** in any deployment. |
| `VITE_ENVIRONMENT_LABEL` | `Staging` / `Production` switch on fail-closed configuration. |
| `VITE_ENABLE_LOCAL_DEMO` | `true` permits browser-local demo data. Ignored in staging and production. |
| `VITE_DEFAULT_ORG_NAME` | Display name for the seeded organization. |
| `VITE_ENABLE_SIMULATOR` | `true` enables the simulator. Never honoured in production. |
| `VITE_SPYGLASS_BASE_URL` | Enables "View in Spyglass" deep links. |
| `VITE_ONESIGNAL_APP_ID` | OneSignal application id for web push. |

**Server-side only — never referenced from `src/`**

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Used by Edge Functions and the seed script. |
| `OPENIWATCH_INGEST_SECRET` | Shared secret required by the ingest endpoint. |
| `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` | Web push. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | SMS fallback (interface only in Phase 1). |
| `ZIGNAL_API_BASE_URL`, `ZIGNAL_API_KEY` | Zignal connector (requires vendor documentation). |
| `RSS_FEED_URLS`, `PUBLIC_SAFETY_FEED_URL`, `PUBLIC_SAFETY_FEED_KEY` | Additional connectors. |

The application works fully without OneSignal, Twilio or Zignal credentials.
Channels without credentials record a **simulated** delivery rather than
claiming to have sent one.

---

## Terminology

These are distinct records and are never used interchangeably:

| Term | Meaning |
| --- | --- |
| **Signal** | A raw collected item: post, article, video, report, emergency notice or analyst submission. |
| **Candidate alert** | A signal that may represent a threat or operational concern affecting a monitored location. |
| **Validated alert** | A candidate an analyst has reviewed and approved for operational distribution. |
| **Incident** | An alert the SOC has acknowledged, escalated, assigned or otherwise acted upon. |
| **Report item** | A signal, alert or incident included in recurring reporting. |

---

## Repository structure

```
openiwatch/
├── src/
│   ├── domain/            Enums, threat taxonomy, record types
│   ├── lib/               Utilities, SHA-256, date and time, env
│   ├── services/
│   │   ├── ingestion/     Schema, normalization, matching, duplicates, pipeline
│   │   ├── scoring/       Classifier and the deterministic scorer
│   │   ├── notifications/ Provider interface, providers, dispatch
│   │   ├── connectors/    Connector interface and Phase 1 connectors
│   │   └── reporting/     CSV export (PDF prepared, not implemented)
│   ├── data/
│   │   ├── workflow.ts    Alert lifecycle rules and role checks
│   │   ├── readModels.ts  Shared query logic for both providers
│   │   ├── local/         Browser-local demo provider
│   │   ├── supabase/      Supabase provider
│   │   └── seed/          Pilot locations, assignments, users
│   ├── components/        Interface primitives, badges, alert card, shell
│   ├── pages/             The seven screens plus sign-in and notifications
│   ├── simulator/         Eight development scenarios
│   └── app/               Data and theme context
├── supabase/
│   ├── migrations/        Twelve ordered, re-runnable SQL migrations
│   ├── functions/         ingest-signal, dispatch-notifications,
│   │                      escalate-unacknowledged, and shared modules
│   └── tests/             RLS and retention scenario tests (real PostgreSQL)
├── e2e/                   Playwright: workflow, security, mobile UI,
│                       configuration and PWA tests
├── scripts/               seed-users.mjs, test-rls.sh,
│                       validate-staging.mjs, perf-dataset.sql
└── docs/                  Architecture, data model, workflow, scoring,
                           integrations, security, deployment, pilot setup
```

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System shape, layering, and the decisions behind it |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Every table, relationship and enum |
| [`docs/ALERT_WORKFLOW.md`](docs/ALERT_WORKFLOW.md) | The operational lifecycle, state by state |
| [`docs/SCORING_MODEL.md`](docs/SCORING_MODEL.md) | The seven sub-scores and every rule |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | What is implemented, simulated, stubbed, or blocked |
| [`docs/SECURITY.md`](docs/SECURITY.md) | RLS, roles, privacy and intelligence standards |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Netlify and Supabase deployment |
| [`docs/PILOT_SETUP.md`](docs/PILOT_SETUP.md) | Pilot data, seed users and demo script |
| [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) | **Every integration's real status, and what is still blocked** |
| [`docs/STAGING_ACCEPTANCE.md`](docs/STAGING_ACCEPTANCE.md) | The staging acceptance checklist |
| [`docs/ROLE_TEST_MATRIX.md`](docs/ROLE_TEST_MATRIX.md) | What each role may do, and how it is verified |
| [`docs/ONESIGNAL_SETUP.md`](docs/ONESIGNAL_SETUP.md) | Web push setup and verification |
| [`docs/RETENTION.md`](docs/RETENTION.md) | Retention policy, holds, dry runs and purging |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | **Every browser variable, and why missing ones block startup** |
| [`docs/MOBILE.md`](docs/MOBILE.md) | Mobile interface, navigation drawer, typography and the PWA |
| [`docs/PR_PHASE_1.md`](docs/PR_PHASE_1.md) | Pull request description — Phase 1 |
| [`docs/PR_PHASE_2.md`](docs/PR_PHASE_2.md) | Pull request description — staging validation |

---

## What OpeniWatch does not do

Stated plainly, because these are deliberate limits rather than gaps:

- No facial recognition, private-data collection, IP tracking or hidden-location
  tracking.
- No automatic identification of private individuals beyond what the source
  itself publishes.
- No automatic contact with a reported subject.
- No automatic contact with law enforcement or emergency services.
- No inference of a person's current location from their profile city,
  biography, historical posts or account metadata.
- No unsupported scraping. Connectors read only sources an operator explicitly
  configures.

---

## Relationship to Spyglass

Spyglass remains the strategic brand-intelligence and monitoring layer.
OpeniWatch is the operational action layer. Alerts can carry a deep link back
to a corresponding Spyglass dashboard, query or source view
(`VITE_SPYGLASS_BASE_URL`), but OpeniWatch does not embed or duplicate the
Spyglass dashboard.
